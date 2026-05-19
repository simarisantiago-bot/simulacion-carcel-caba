# Simulación de capacidad carcelaria – CABA

Proyecto de simulación que cruza dos datasets oficiales 2023 para proyectar la capacidad carcelaria necesaria en CABA a 10 años (2024–2033):

- **`data/raw/delitos_caba_2023.xlsx`** – Mapa del delito de CABA, 155.898 incidentes callejeros (6 categorías: Robo, Hurto, Vialidad, Lesiones, Amenazas, Homicidios).
- **`data/raw/sneep_2023_nacional.csv`** – SNEEP nacional 2023, 3.021 internos del SPF con Delito1..Delito5, condena, residencia, etc.

## Arquitectura

```
scripts/calcular_parametros.py   →   public/data/parametros.json   →   public/index.html (Chart.js)
```

- **Python corre una sola vez** (offline) y deja en `public/data/parametros.json` los números base: delitos 2023 por categoría, condena media SNEEP, tasa empírica delito→cárcel.
- **El navegador hace la simulación en vivo**: stock-flujo por cohortes anuales, parametrizado por sliders (tasa de captura por delito, % de crecimiento del delito por escenario).
- **Sin backend**. Vercel sirve `public/` como sitio estático.

## Modelo

Para cada año `t` ∈ [2024, 2033] y cada una de las 6 categorías `c`:

```
delitos(c, t)   = delitos_2023(c) × (1 + crecimiento_c)^(t−2023)
ingresos(c, t)  = delitos(c, t) × tasa_captura(c)
stock(c, t)     = Σ ingresos(c, t−k) para k = 0..condena_media(c)−1
plazas(t)       = Σ_c stock(c, t)
```

Tres escenarios pre-armados: optimista (−2% / año), base (0%), pesimista (+3% / año). Todos los parámetros son editables en la UI.

## Mapeo de categorías

| Mapa del delito CABA | SNEEP Delito1Descripcion |
|---|---|
| Robo | Robo y/o tentativa de robo |
| Hurto | Hurto y/o tentativa de hurto |
| Homicidios | Homicidios dolosos (+ tentativa) |
| Lesiones | Lesiones Dolosas |
| Amenazas | Amenazas |
| Vialidad | Homicidios Culposos + Lesiones Culposas |

Definido en `scripts/calcular_parametros.py` (constante `MAPEO`).

## Limitaciones (importantes para interpretar resultados)

1. **SNEEP es solo cárceles federales (SPF)**. La mayoría de los presos por delitos callejeros de CABA están en SPB o alcaidías porteñas, no en SPF → la tasa empírica subestima fuerte la demanda real.
2. **El mapa del delito subregistra denuncias**. Cifra negra alta en hurtos y amenazas.
3. **Las 6 categorías CABA no cubren** narcotráfico, abuso sexual, delitos contra la administración pública, etc. (que sí están en el SNEEP).

## Comandos

```powershell
# 1) recalcular parametros.json desde los datos crudos
python scripts/calcular_parametros.py

# 2) servir el frontend en local
python -m http.server 8080 --directory public
# abrir http://localhost:8080
```

## Deploy

GitHub + Vercel. `vercel.json` ya apunta `outputDirectory` a `public/`. Cada push a `main` redeploya. Ver README.md.
