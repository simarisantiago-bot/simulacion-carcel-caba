"""
Calcula los parámetros base de la simulación a partir de los datos crudos:

    data/raw/delitos_caba_2023.xlsx   (mapa del delito CABA)
    data/raw/sneep_2023_nacional.csv  (SNEEP nacional)

y los serializa a:

    public/data/parametros.json

El frontend (public/app.js) consume ese JSON y corre la simulación en vivo.
Sólo hay que volver a correr este script cuando cambien los datos crudos.
"""

from __future__ import annotations

import csv
import json
import statistics
import sys
from collections import Counter, defaultdict
from pathlib import Path

import openpyxl

# Windows + cp1252 no soporta utf-8 por defecto en stdout
if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")


# Mapeo entre categorías del mapa del delito (CABA) y categorías de Delito1
# del SNEEP. Una categoría CABA puede recibir varias del SNEEP (lista).
MAPEO: dict[str, list[str]] = {
    "Robo":       ["Robo y/o tentativa de robo"],
    "Hurto":      ["Hurto y/o tentativa de hurto"],
    "Homicidios": ["Homicidios dolosos", "Homicidios dolosos (tent.)"],
    "Lesiones":   ["Lesiones Dolosas"],
    "Amenazas":   ["Amenazas"],
    "Vialidad":   ["Homicidios Culposos", "Lesiones Culposas"],
}

ROOT = Path(__file__).resolve().parents[1]
CSV_SNEEP = ROOT / "data" / "raw" / "sneep_2023_nacional.csv"
XLSX_CABA = ROOT / "data" / "raw" / "delitos_caba_2023.xlsx"
OUT_JSON  = ROOT / "public" / "data" / "parametros.json"


def contar_delitos_caba() -> tuple[int, dict[str, int]]:
    """Devuelve (total, conteo por tipo) del mapa del delito CABA 2023."""
    wb = openpyxl.load_workbook(XLSX_CABA, read_only=True, data_only=True)
    ws = wb["delitos_2023"]
    conteo: Counter[str] = Counter()
    total = 0
    for row in ws.iter_rows(min_row=2, values_only=True):
        tipo = row[6]
        cantidad = row[14] or 1
        conteo[tipo] += cantidad
        total += cantidad
    wb.close()
    return total, dict(conteo)


def leer_sneep() -> list[dict]:
    """Carga el SNEEP en memoria (3k filas, liviano)."""
    with CSV_SNEEP.open(encoding="latin-1") as f:
        return list(csv.DictReader(f, delimiter=";"))


def parametros_por_categoria(sneep: list[dict]) -> dict[str, dict]:
    """Para cada categoría CABA, cuenta presos y promedia condena."""
    # Invertir el MAPEO: SNEEP delito1 -> categoría CABA
    sneep_a_caba: dict[str, str] = {}
    for caba_cat, sneep_cats in MAPEO.items():
        for s in sneep_cats:
            sneep_a_caba[s] = caba_cat

    presos_por_cat: Counter[str] = Counter()
    condenas: dict[str, list[float]] = defaultdict(list)

    for r in sneep:
        delito1 = r["Delito1Descripcion"].strip()
        cat = sneep_a_caba.get(delito1)
        if cat is None:
            continue
        presos_por_cat[cat] += 1
        # Condena en años (si está)
        try:
            anos  = int(r["DuracionCondenaAnos"] or 0)
            meses = int(r["DuracionCondenaMeses"] or 0)
        except ValueError:
            continue
        if anos == 0 and meses == 0:
            continue  # procesados sin condena firme
        condenas[cat].append(anos + meses / 12.0)

    out: dict[str, dict] = {}
    for cat in MAPEO:
        cs = condenas.get(cat, [])
        out[cat] = {
            "presos_sneep": presos_por_cat.get(cat, 0),
            "condena_media_anos": round(statistics.mean(cs), 2) if cs else None,
            "condena_mediana_anos": round(statistics.median(cs), 2) if cs else None,
            "n_condenas": len(cs),
        }
    return out


def main() -> None:
    print("→ Leyendo mapa del delito CABA …")
    total_caba, conteo_caba = contar_delitos_caba()
    print(f"   {total_caba:,} incidentes en {len(conteo_caba)} categorías")

    print("→ Leyendo SNEEP …")
    sneep = leer_sneep()
    print(f"   {len(sneep):,} internos")

    print("→ Cruzando categorías …")
    params_cat = parametros_por_categoria(sneep)

    categorias = []
    for cat, sneep_cats in MAPEO.items():
        delitos_2023 = conteo_caba.get(cat, 0)
        p = params_cat[cat]
        tasa_empirica = (
            p["presos_sneep"] / delitos_2023 if delitos_2023 else 0.0
        )
        categorias.append({
            "nombre": cat,
            "sneep_categorias": sneep_cats,
            "delitos_2023": delitos_2023,
            "presos_sneep_2023": p["presos_sneep"],
            "tasa_empirica": round(tasa_empirica, 6),
            "condena_media_anos": p["condena_media_anos"],
            "condena_mediana_anos": p["condena_mediana_anos"],
            "n_condenas_observadas": p["n_condenas"],
        })

    salida = {
        "meta": {
            "anio_base": 2023,
            "horizonte_anos": 10,
            "total_delitos_caba_2023": total_caba,
            "total_presos_sneep_2023": len(sneep),
            "fuente_delitos": "Mapa del Delito CABA 2023",
            "fuente_presos": "SNEEP nacional 2023 (SPF) – Delito1Descripcion",
        },
        "escenarios_default": {
            "optimista": -0.02,
            "base":       0.00,
            "pesimista":  0.03,
        },
        "categorias": categorias,
    }

    OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    OUT_JSON.write_text(json.dumps(salida, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"→ Escrito {OUT_JSON.relative_to(ROOT)}")
    print()
    for c in categorias:
        print(
            f"   {c['nombre']:<11} "
            f"delitos={c['delitos_2023']:>6,}  "
            f"presos={c['presos_sneep_2023']:>5}  "
            f"tasa={c['tasa_empirica']*100:>6.2f}%  "
            f"condena_media={c['condena_media_anos']} años "
            f"(n={c['n_condenas_observadas']})"
        )


if __name__ == "__main__":
    main()
