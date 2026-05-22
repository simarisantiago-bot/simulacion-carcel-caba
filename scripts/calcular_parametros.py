"""
Calcula los parámetros base de la simulación a partir de los datos crudos:

    data/raw/delitos_caba_2023.xlsx   (Mapa del Delito CABA)
    data/raw/sneep_2023_nacional.csv  (SNEEP nacional)

y los serializa a:

    public/data/parametros.json

El frontend (public/app.js) consume ese JSON y corre la simulación en vivo.
Sólo hay que volver a correr este script cuando cambien los datos crudos.

Decisiones de diseño (ver CLAUDE.md):
  · Universo SNEEP = todos los condenados de Justicia Nacional (3.021 internos).
    No se filtra por residencia — perdería los bonaerenses del AMBA que
    delinquieron en CABA.
  · 7 categorías (no 6): Vialidad se separa en fatal (homicidios culposos
    ↔ muertes por siniestros viales) y lesivo (lesiones culposas ↔
    lesiones por siniestros viales) para no mezclar fenómenos distintos.
  · Tasa de captura empírica conserva el cálculo viejo (presos/delitos)
    SÓLO para transparencia. La tasa USADA por el simulador es
    "tasa_flujo": ingresos anuales estimados / delitos, asumiendo
    factor de cumplimiento default = 0.67.
"""

from __future__ import annotations

import csv
import json
import statistics
import sys
from collections import Counter, defaultdict
from pathlib import Path

import openpyxl

if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")

ROOT = Path(__file__).resolve().parents[1]
CSV_SNEEP = ROOT / "data" / "raw" / "sneep_2023_nacional.csv"
XLSX_CABA = ROOT / "data" / "raw" / "delitos_caba_2023.xlsx"
OUT_JSON  = ROOT / "public" / "data" / "parametros.json"

# Asunción usada para convertir stock observado en flujo anual.
# Debe coincidir con el default del slider de cumplimiento en el frontend.
FACTOR_CUMPLIMIENTO_DEFAULT = 0.67

# ─── Mapeo de categorías ────────────────────────────────────────────
# Cada categoría tiene:
#   - sneep_categorias: lista de descripciones del Delito1 SNEEP
#   - mapa_tipo:        valor de columna "tipo" en el Mapa CABA
#   - mapa_subtipos:    si es None, toma todo el tipo;
#                       si es lista, suma sólo esos subtipos.
MAPEO: dict[str, dict] = {
    "Robo": {
        "sneep_categorias": ["Robo y/o tentativa de robo"],
        "mapa_tipo":        "Robo",
        "mapa_subtipos":    None,
    },
    "Hurto": {
        "sneep_categorias": ["Hurto y/o tentativa de hurto"],
        "mapa_tipo":        "Hurto",
        "mapa_subtipos":    None,
    },
    "Homicidios dolosos": {
        "sneep_categorias": ["Homicidios dolosos", "Homicidios dolosos (tent.)"],
        "mapa_tipo":        "Homicidios",
        "mapa_subtipos":    None,
    },
    "Lesiones dolosas": {
        "sneep_categorias": ["Lesiones Dolosas"],
        "mapa_tipo":        "Lesiones",
        "mapa_subtipos":    None,
    },
    "Amenazas": {
        "sneep_categorias": ["Amenazas"],
        "mapa_tipo":        "Amenazas",
        "mapa_subtipos":    None,
    },
    "Vialidad fatal": {
        "sneep_categorias": ["Homicidios Culposos"],
        "mapa_tipo":        "Vialidad",
        "mapa_subtipos":    ["Muertes por siniestros viales"],
    },
    "Vialidad lesivo": {
        "sneep_categorias": ["Lesiones Culposas"],
        "mapa_tipo":        "Vialidad",
        "mapa_subtipos":    ["Lesiones por siniestros viales"],
    },
}


# ─── Lectura del Mapa del Delito ────────────────────────────────────
def contar_delitos_caba() -> tuple[int, dict[tuple[str, str], int]]:
    """Devuelve (total, conteo[(tipo, subtipo)]). Se preserva subtipo
    para poder filtrar categorías que sólo cubren un subtipo del Mapa."""
    wb = openpyxl.load_workbook(XLSX_CABA, read_only=True, data_only=True)
    ws = wb["delitos_2023"]
    conteo: Counter[tuple[str, str]] = Counter()
    total = 0
    for row in ws.iter_rows(min_row=2, values_only=True):
        tipo, subtipo = row[6], row[7]
        cantidad = row[14] or 1
        conteo[(tipo, subtipo)] += cantidad
        total += cantidad
    wb.close()
    return total, dict(conteo)


def delitos_de_categoria(mapeo_entry: dict,
                         conteo_caba: dict[tuple[str, str], int]) -> int:
    """Cuenta los hechos del Mapa que corresponden a una categoría
    (todo el tipo o solo subtipos específicos)."""
    tipo = mapeo_entry["mapa_tipo"]
    subtipos = mapeo_entry["mapa_subtipos"]
    if subtipos is None:
        return sum(v for (t, _s), v in conteo_caba.items() if t == tipo)
    subtipos_set = set(subtipos)
    return sum(v for (t, s), v in conteo_caba.items()
               if t == tipo and s in subtipos_set)


# ─── Lectura del SNEEP ──────────────────────────────────────────────
def leer_sneep() -> list[dict]:
    """Carga el SNEEP en memoria (3k filas, liviano)."""
    with CSV_SNEEP.open(encoding="latin-1") as f:
        return list(csv.DictReader(f, delimiter=";"))


def stats_sneep(sneep: list[dict]) -> dict:
    """Para cada categoría: conteo, condena media/mediana, % residencia CABA."""
    sneep2cat: dict[str, str] = {}
    for cat, entry in MAPEO.items():
        for s in entry["sneep_categorias"]:
            sneep2cat[s] = cat

    por_cat = defaultdict(lambda: {
        "n": 0,
        "n_caba": 0,
        "condenas": [],  # años (decimal)
    })
    n_no_mapeable = 0
    no_mapeable_top: Counter[str] = Counter()

    for r in sneep:
        delito = r["Delito1Descripcion"].strip()
        cat = sneep2cat.get(delito)
        if cat is None:
            n_no_mapeable += 1
            no_mapeable_top[delito] += 1
            continue
        rec = por_cat[cat]
        rec["n"] += 1
        if r["UltimaProvinciaResidenciaDescripcion"].strip() == "Ciudad de Buenos Aires":
            rec["n_caba"] += 1
        try:
            anos  = int(r["DuracionCondenaAnos"]  or 0)
            meses = int(r["DuracionCondenaMeses"] or 0)
        except ValueError:
            continue
        if anos == 0 and meses == 0:
            continue
        rec["condenas"].append(anos + meses / 12)

    return {
        "por_cat":         dict(por_cat),
        "n_no_mapeable":   n_no_mapeable,
        "no_mapeable_top": no_mapeable_top.most_common(8),
    }


# ─── Build ──────────────────────────────────────────────────────────
def main() -> None:
    print("→ Leyendo Mapa del Delito CABA …")
    total_caba, conteo_caba = contar_delitos_caba()
    print(f"   {total_caba:,} incidentes")

    print("→ Leyendo SNEEP …")
    sneep = leer_sneep()
    print(f"   {len(sneep):,} internos (todos condenados, Justicia Nacional)")

    print("→ Cruzando …")
    s = stats_sneep(sneep)

    categorias = []
    for cat, entry in MAPEO.items():
        delitos = delitos_de_categoria(entry, conteo_caba)
        rec = s["por_cat"].get(cat, {"n": 0, "n_caba": 0, "condenas": []})
        n = rec["n"]
        condenas = rec["condenas"]

        condena_media   = round(statistics.mean(condenas),    2) if condenas else None
        condena_mediana = round(statistics.median(condenas),  2) if condenas else None
        condena_p10     = round(statistics.quantiles(condenas, n=10)[0], 2) if len(condenas) >= 10 else None
        condena_p90     = round(statistics.quantiles(condenas, n=10)[-1], 2) if len(condenas) >= 10 else None

        tasa_empirica = n / delitos if delitos else 0.0

        # Tasa "de flujo": ingresos anuales / delitos. Asumiendo factor=0.67,
        # ingresos_anuales ≈ stock / (condena_media · 0.67). Es la tasa que
        # mantiene coherente la dinámica con el stock observado.
        if delitos and condena_media:
            condena_efectiva_default = condena_media * FACTOR_CUMPLIMIENTO_DEFAULT
            ingreso_estimado = n / condena_efectiva_default
            tasa_flujo = ingreso_estimado / delitos
        else:
            tasa_flujo = 0.0

        pct_caba = rec["n_caba"] / n if n else 0.0

        categorias.append({
            "nombre":                 cat,
            "sneep_categorias":       entry["sneep_categorias"],
            "mapa_tipo":              entry["mapa_tipo"],
            "mapa_subtipos":          entry["mapa_subtipos"],
            "delitos_2023":           delitos,
            "presos_sneep_2023":      n,
            "presos_residencia_caba": rec["n_caba"],
            "pct_residencia_caba":    round(pct_caba, 3),
            "tasa_empirica":          round(tasa_empirica, 6),
            "tasa_flujo":             round(tasa_flujo, 6),
            "condena_media_anos":     condena_media,
            "condena_mediana_anos":   condena_mediana,
            "condena_p10_anos":       condena_p10,
            "condena_p90_anos":       condena_p90,
            "n_condenas_observadas":  len(condenas),
        })

    salida = {
        "meta": {
            "anio_base":                2023,
            "horizonte_anos":           10,
            "total_delitos_caba_2023":  total_caba,
            "total_presos_sneep_2023":  len(sneep),
            "presos_modelables":        sum(c["presos_sneep_2023"] for c in categorias),
            "presos_no_modelables":     s["n_no_mapeable"],
            "categorias_no_mapeadas":   [
                {"delito": k, "n": v} for k, v in s["no_mapeable_top"]
            ],
            "fuente_delitos":           "Mapa del Delito CABA 2023",
            "fuente_presos":            "SNEEP nacional 2023 (SPF) · Delito1Descripcion",
            "nota_universo":            (
                "El SNEEP nacional incluye sólo internos con causa en Justicia "
                "Nacional (3.021 condenados). No incluye SPB ni alcaidías porteñas. "
                "Del total, 1.497 (49,5%) tenían residencia en CABA y 1.307 en "
                "Buenos Aires provincia (mayoría AMBA)."
            ),
            "factor_cumplimiento_default_calibracion": FACTOR_CUMPLIMIENTO_DEFAULT,
        },
        "escenarios_default": {
            "optimista": -0.02,
            "base":       0.00,
            "pesimista":  0.03,
        },
        "supuestos_default": {
            "factor_cumplimiento": FACTOR_CUMPLIMIENTO_DEFAULT,
        },
        "categorias": categorias,
    }

    OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    OUT_JSON.write_text(json.dumps(salida, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"→ Escrito {OUT_JSON.relative_to(ROOT)}")
    print()
    print(f"   Stock modelable:    {salida['meta']['presos_modelables']:>5}")
    print(f"   Stock NO modelable: {salida['meta']['presos_no_modelables']:>5}")
    print()
    print(f"   {'Categoría':<22} {'Delitos':>9}  {'Presos':>6}  {'Emp%':>6}  {'Flujo%':>7}  {'Cond':>6}  {'%CABA':>6}")
    for c in categorias:
        print(
            f"   {c['nombre']:<22} "
            f"{c['delitos_2023']:>9,}  "
            f"{c['presos_sneep_2023']:>6}  "
            f"{c['tasa_empirica']*100:>5.2f}%  "
            f"{c['tasa_flujo']*100:>6.2f}%  "
            f"{(c['condena_media_anos'] or 0):>5.2f}a  "
            f"{c['pct_residencia_caba']*100:>5.0f}%"
        )


if __name__ == "__main__":
    main()
