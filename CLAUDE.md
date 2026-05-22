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
condena_efectiva(c)  = condena_media(c) × factor_cumplimiento
delitos(c, t)        = delitos_2023(c) × (1 + crecimiento_c)^(t−2023)
ingresos(c, t)       = delitos(c, t) × tasa_captura(c)
salidas(c, t)        = ingresos(c, t − condena_efectiva(c))
stock(c, t)          = stock(c, t−1) + ingresos(c, t) − salidas(c, t)
plazas(t)            = Σ_c stock(c, t)
```

`factor_cumplimiento` (default 0.67) refleja que la mayoría de los presos sale antes del cumplimiento total por libertad condicional o asistida (~2/3 de la pena).

Tres escenarios pre-armados: optimista (−2% / año), base (0%), pesimista (+3% / año). Todos los parámetros son editables en la UI.

## Mapeo de categorías (7)

Vialidad se separa en "fatal" y "lesivo" porque mezclar 159 homicidios culposos
con 13 lesiones culposas en una sola categoría confundía el análisis.

| Categoría (modelo)   | Mapa del Delito CABA (tipo · subtipo)                | SNEEP Delito1Descripcion              |
|----------------------|-------------------------------------------------------|----------------------------------------|
| Robo                 | Robo (todos)                                          | Robo y/o tentativa de robo             |
| Hurto                | Hurto (todos)                                         | Hurto y/o tentativa de hurto           |
| Homicidios dolosos   | Homicidios (todos)                                    | Homicidios dolosos (+ tent.)           |
| Lesiones dolosas     | Lesiones (todos)                                      | Lesiones Dolosas                       |
| Amenazas             | Amenazas (todos)                                      | Amenazas                               |
| Vialidad fatal       | Vialidad · Muertes por siniestros viales              | Homicidios Culposos                    |
| Vialidad lesivo      | Vialidad · Lesiones por siniestros viales             | Lesiones Culposas                      |

Definido en `scripts/calcular_parametros.py` (constante `MAPEO`).

## Tasa de captura: dos versiones

- **Tasa empírica** = `presos_2023 / delitos_2023`. Mezcla stock con flujo;
  da valores >100% en categorías de condenas largas. Sólo informativa.
- **Tasa de flujo** = `(presos_2023 / (condena_media · 0,67)) / delitos_2023`.
  Es el ingreso anual estimado dividido por el delito. Es la que arranca
  el simulador. Siempre menor a 100% y mantiene coherencia con el stock
  observado.

## Limitaciones (importantes para interpretar resultados)

1. **El SNEEP usado es Justicia Nacional** (3.021 condenados). Históricamente
   cubre el grueso de causas de CABA, pero no incluye SPB ni alcaidías
   porteñas. De los 3.021, sólo 1.497 (49,5%) residían en CABA — el resto
   son mayormente del AMBA (Buenos Aires provincia).
2. **753 internos (25%) quedan fuera del modelo** porque cometieron delitos
   no cubiertos por el Mapa CABA: narcotráfico (140), violaciones (249),
   privación ilegítima de la libertad, delitos c/ la administración pública,
   etc. Se reporta el total como KPI de transparencia.
3. **El mapa del delito subregistra denuncias**. Cifra negra alta en hurto
   y amenazas. El delito real es mayor al denunciado.

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
