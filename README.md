# Simulación de capacidad carcelaria – CABA

Dashboard interactivo que proyecta la capacidad carcelaria necesaria en CABA (2024–2033) cruzando el **mapa del delito 2023** con el **SNEEP nacional 2023**.

Movés perillas (tasa de captura por delito, % de crecimiento anual del delito) y el gráfico se recalcula al instante en el navegador.

## Estructura

```
.
├── data/raw/                      # XLSX/CSV originales (no se versionan)
├── scripts/
│   └── calcular_parametros.py     # genera public/data/parametros.json
└── public/                        # sitio estático que Vercel sirve
    ├── index.html
    ├── style.css
    ├── app.js
    └── data/parametros.json
```

## Cómo correrlo localmente

```powershell
# 1) (opcional) regenerar parametros.json desde los datos crudos
python scripts/calcular_parametros.py

# 2) servir el sitio
python -m http.server 8080 --directory public
# abrir http://localhost:8080
```

## Deploy a GitHub + Vercel

**Una sola vez:**

```powershell
git init
git add .
git commit -m "init: simulación carcelaria CABA"

# crear el repo en github.com y después:
git remote add origin https://github.com/<tu-usuario>/simulacion_carcel_caba.git
git branch -M main
git push -u origin main
```

En Vercel: **New Project → Import desde GitHub** → seleccionar el repo. El `vercel.json` ya está configurado (`outputDirectory: "public"`). Listo.

**Cada vez que cambies algo:**

```powershell
git add . && git commit -m "..." && git push
# Vercel redeploya solo
```

## Limitaciones que tenés que tener en mente

1. **SNEEP es solo cárceles federales (SPF)**. La mayoría de los presos por delitos callejeros de CABA están en SPB, no en SPF. La simulación subestima fuerte la demanda real de plazas.
2. **El mapa del delito subregistra denuncias** (cifra negra alta, sobre todo en hurto y amenazas).
3. **Las 6 categorías del mapa no cubren** narcotráfico, abuso sexual ni delitos contra la administración pública.

Mirá `CLAUDE.md` para el detalle del modelo.
