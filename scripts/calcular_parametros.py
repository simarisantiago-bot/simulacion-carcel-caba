"""
Calcula los parámetros base de la simulación a partir de los datos crudos:

    data/raw/delitos_caba_2023.xlsx   (Mapa del Delito CABA)
    data/raw/SNEEP.csv                (SNEEP Justicia Nacional 2023:
                                        cond + proc + inimp = 5.276 internos)

y los serializa a:

    public/data/parametros.json

Decisiones de diseño (ver CLAUDE.md):
  · Universo SNEEP = todos los internos a disposición de Justicia Nacional
    (5.276 = 3.021 condenados + 2.252 procesados + 3 inimputables).
    Modelamos cond y proc por separado para reflejar sus dinámicas
    distintas (condena cumplida vs tiempo de proceso preventivo).
  · 7 categorías: Vialidad se separa en "fatal" (homicidios culposos ↔
    muertes por siniestros viales) y "lesivo" (lesiones culposas ↔
    lesiones por siniestros viales).
  · Tasa de flujo = ingresos anuales / delitos. La tasa empírica
    (stock/delitos) queda sólo como dato informativo.
"""

from __future__ import annotations

import csv
import json
import statistics
import sys
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path

import openpyxl

if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")

ROOT = Path(__file__).resolve().parents[1]
CSV_SNEEP = ROOT / "data" / "raw" / "SNEEP.csv"
XLSX_CABA = ROOT / "data" / "raw" / "delitos_caba_2023.xlsx"
OUT_JSON  = ROOT / "public" / "data" / "parametros.json"

FACTOR_CUMPLIMIENTO_DEFAULT = 0.67
FECHA_CORTE_SNEEP = datetime(2023, 12, 31)

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


# ─── Mapa del Delito CABA ────────────────────────────────────────────
def contar_delitos_caba() -> tuple[int, dict[tuple[str, str], int]]:
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


def delitos_de_categoria(entry: dict,
                         conteo_caba: dict[tuple[str, str], int]) -> int:
    tipo = entry["mapa_tipo"]
    subtipos = entry["mapa_subtipos"]
    if subtipos is None:
        return sum(v for (t, _s), v in conteo_caba.items() if t == tipo)
    subtipos_set = set(subtipos)
    return sum(v for (t, s), v in conteo_caba.items()
               if t == tipo and s in subtipos_set)


# ─── SNEEP ──────────────────────────────────────────────────────────
def parse_fecha(s: str | None) -> datetime | None:
    if not s or not s.strip():
        return None
    try:
        return datetime.strptime(s.split(" ")[0], "%d/%m/%Y")
    except ValueError:
        return None


def leer_sneep() -> list[dict]:
    with CSV_SNEEP.open(encoding="latin-1") as f:
        return list(csv.DictReader(f, delimiter=";"))


def stats_sneep(sneep: list[dict]) -> dict:
    """Recorre el SNEEP y separa condenados/procesados/inimputables por
    categoría, computando condenas y tiempos de proceso."""
    sneep2cat: dict[str, str] = {}
    for cat, entry in MAPEO.items():
        for s in entry["sneep_categorias"]:
            sneep2cat[s] = cat

    por_cat = defaultdict(lambda: {
        "n_cond": 0, "n_proc": 0, "n_inimp": 0,
        "n_caba": 0,
        "condenas":             [],  # años (sólo condenados)
        "tiempo_proceso_cond":  [],  # FechaCondenado − FechaDetencion (cond.)
        "tiempo_actual_proc":   [],  # FECHA_CORTE − FechaDetencion (proc.)
    })
    n_no_mapeable_cond = 0
    n_no_mapeable_proc = 0
    no_mapeable_top: Counter[str] = Counter()

    for r in sneep:
        delito = r["Delito1Descripcion"].strip()
        cat = sneep2cat.get(delito)
        sit = r["SituacionLegalDescripcion"].strip()
        es_cond = sit.startswith("Condenado")
        es_proc = sit.startswith("Procesado")
        es_inimp = sit.startswith("Inimputable")
        if cat is None:
            if es_cond:  n_no_mapeable_cond += 1
            if es_proc:  n_no_mapeable_proc += 1
            no_mapeable_top[delito] += 1
            continue
        rec = por_cat[cat]
        if es_cond:    rec["n_cond"]  += 1
        elif es_proc:  rec["n_proc"]  += 1
        elif es_inimp: rec["n_inimp"] += 1

        if r["UltimaProvinciaResidenciaDescripcion"].strip() == "Ciudad de Buenos Aires":
            rec["n_caba"] += 1

        fd = parse_fecha(r["FechaDetencion"])
        fc = parse_fecha(r["FechaCondenado"])

        if es_cond:
            try:
                anos  = int(r["DuracionCondenaAnos"]  or 0)
                meses = int(r["DuracionCondenaMeses"] or 0)
                if anos > 0 or meses > 0:
                    rec["condenas"].append(anos + meses / 12)
            except ValueError:
                pass
            if fd and fc and fc > fd:
                rec["tiempo_proceso_cond"].append((fc - fd).days / 365.25)
        elif es_proc:
            if fd and fd < FECHA_CORTE_SNEEP:
                rec["tiempo_actual_proc"].append(
                    (FECHA_CORTE_SNEEP - fd).days / 365.25
                )

    return {
        "por_cat":              dict(por_cat),
        "n_no_mapeable_cond":   n_no_mapeable_cond,
        "n_no_mapeable_proc":   n_no_mapeable_proc,
        "no_mapeable_top":      no_mapeable_top.most_common(8),
    }


def media_o_none(xs: list[float], digits=2) -> float | None:
    return round(statistics.mean(xs), digits) if xs else None


def main() -> None:
    print("→ Mapa del Delito …", flush=True)
    total_caba, conteo_caba = contar_delitos_caba()
    print(f"   {total_caba:,} incidentes")

    print("→ SNEEP …", flush=True)
    sneep = leer_sneep()
    n_cond_total = sum(1 for r in sneep if r["SituacionLegalDescripcion"].strip().startswith("Condenado"))
    n_proc_total = sum(1 for r in sneep if r["SituacionLegalDescripcion"].strip().startswith("Procesado"))
    n_inimp_total = sum(1 for r in sneep if r["SituacionLegalDescripcion"].strip().startswith("Inimputable"))
    print(f"   {len(sneep):,} internos  ({n_cond_total} cond + {n_proc_total} proc + {n_inimp_total} inimp)")

    print("→ Cruzando …", flush=True)
    s = stats_sneep(sneep)

    categorias = []
    for cat, entry in MAPEO.items():
        delitos = delitos_de_categoria(entry, conteo_caba)
        rec = s["por_cat"].get(cat, {
            "n_cond": 0, "n_proc": 0, "n_inimp": 0, "n_caba": 0,
            "condenas": [], "tiempo_proceso_cond": [], "tiempo_actual_proc": [],
        })
        n_total = rec["n_cond"] + rec["n_proc"] + rec["n_inimp"]

        condena_media       = media_o_none(rec["condenas"])
        condena_mediana     = round(statistics.median(rec["condenas"]), 2) if rec["condenas"] else None
        tiempo_proceso      = media_o_none(rec["tiempo_proceso_cond"])
        tiempo_actual_proc  = media_o_none(rec["tiempo_actual_proc"])

        # Tiempo medio ponderado en cárcel (con factor default 0.67):
        # - condenados están condena_media × factor años
        # - procesados están tiempo_proceso años (proxy via condenados)
        # - inimputables se asimilan a procesados
        T_cond = (condena_media or 0) * FACTOR_CUMPLIMIENTO_DEFAULT
        T_proc = tiempo_proceso or 0
        n_proc_inimp = rec["n_proc"] + rec["n_inimp"]
        if n_total > 0 and (T_cond > 0 or T_proc > 0):
            T_pond = (rec["n_cond"] * T_cond + n_proc_inimp * T_proc) / n_total
        else:
            T_pond = 0

        tasa_empirica = n_total / delitos if delitos else 0.0
        tasa_flujo    = (n_total / T_pond / delitos) if (delitos and T_pond > 0) else 0.0
        pct_caba      = rec["n_caba"] / n_total if n_total else 0.0
        pct_proc      = rec["n_proc"] / n_total if n_total else 0.0

        categorias.append({
            "nombre":                  cat,
            "sneep_categorias":        entry["sneep_categorias"],
            "mapa_tipo":               entry["mapa_tipo"],
            "mapa_subtipos":           entry["mapa_subtipos"],
            "delitos_2023":            delitos,
            "presos_2023":             n_total,
            "presos_condenados":       rec["n_cond"],
            "presos_procesados":       rec["n_proc"],
            "presos_inimputables":     rec["n_inimp"],
            "pct_procesados":          round(pct_proc, 3),
            "presos_residencia_caba":  rec["n_caba"],
            "pct_residencia_caba":     round(pct_caba, 3),
            "tasa_empirica":           round(tasa_empirica, 6),
            "tasa_flujo":              round(tasa_flujo, 6),
            "condena_media_anos":      condena_media,
            "condena_mediana_anos":    condena_mediana,
            "tiempo_proceso_anos":     tiempo_proceso,
            "tiempo_actual_proc_anos": tiempo_actual_proc,
            "n_condenas_observadas":   len(rec["condenas"]),
            "n_proc_con_fecha":        len(rec["tiempo_actual_proc"]),
        })

    presos_modelables = sum(c["presos_2023"] for c in categorias)
    presos_no_modelables = len(sneep) - presos_modelables

    salida = {
        "meta": {
            "anio_base":                   2023,
            "horizonte_anos":              10,
            "total_delitos_caba_2023":     total_caba,
            "total_presos_sneep_2023":     len(sneep),
            "total_condenados":            n_cond_total,
            "total_procesados":            n_proc_total,
            "total_inimputables":          n_inimp_total,
            "presos_modelables":           presos_modelables,
            "presos_no_modelables":        presos_no_modelables,
            "categorias_no_mapeadas":      [
                {"delito": k, "n": v} for k, v in s["no_mapeable_top"]
            ],
            "fuente_delitos":              "Mapa del Delito CABA 2023",
            "fuente_presos":               "SNEEP Justicia Nacional 2023 · Delito1Descripcion",
            "nota_universo":               (
                "El universo incluye los 5.276 internos a disposición de Justicia "
                "Nacional en 2023: 3.021 condenados, 2.252 procesados y 3 "
                "inimputables. No incluye SPB ni alcaidías porteñas. Cond y proc "
                "se modelan con permanencias medias distintas: condena efectiva "
                "(condena_media × factor_cumplimiento) para condenados, tiempo "
                "de proceso para procesados (medido como FechaCondenado − "
                "FechaDetencion en los condenados, como proxy del ciclo completo)."
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
    print(f"   Stock modelable:    {presos_modelables:>5}  ({n_cond_total} cond + {n_proc_total} proc + {n_inimp_total} inimp menos lo no mapeado)")
    print(f"   Stock NO modelable: {presos_no_modelables:>5}")
    print()
    print(f"   {'Categoría':<22} {'Delit':>7}  {'Cond':>5} {'Proc':>5}  {'Cond_m':>6}  {'T_proc':>6}  {'T_pond':>6}  {'Flujo%':>7}  {'%CABA':>5}")
    print("   " + "─" * 88)
    for c in categorias:
        T_cond = (c['condena_media_anos'] or 0) * FACTOR_CUMPLIMIENTO_DEFAULT
        T_proc = c['tiempo_proceso_anos'] or 0
        n = c['presos_2023']
        T_pond = ((c['presos_condenados']*T_cond + (c['presos_procesados']+c['presos_inimputables'])*T_proc) / n) if n else 0
        print(
            f"   {c['nombre']:<22} "
            f"{c['delitos_2023']:>7,}  "
            f"{c['presos_condenados']:>5} {c['presos_procesados']:>5}  "
            f"{(c['condena_media_anos'] or 0):>5.2f}a  "
            f"{T_proc:>5.2f}a  "
            f"{T_pond:>5.2f}a  "
            f"{c['tasa_flujo']*100:>6.2f}%  "
            f"{c['pct_residencia_caba']*100:>4.0f}%"
        )


if __name__ == "__main__":
    main()
