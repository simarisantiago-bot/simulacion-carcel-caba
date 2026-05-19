/*  Simulación de capacidad carcelaria – CABA
 *  Toda la lógica del modelo corre en el navegador.
 *  Lee parámetros base de data/parametros.json (lo genera scripts/calcular_parametros.py).
 */

// Paleta derivada del manual de marca GCBA (azul / cyan / amarillo / gris)
const COLOR = {
  Robo:       '#153244',  // azul oscuro
  Hurto:      '#2C6E8C',  // azul medio (derivado)
  Homicidios: '#FFCC00',  // amarillo institucional
  Lesiones:   '#8DE2D6',  // cyan
  Amenazas:   '#B49B00',  // amarillo oscuro (derivado)
  Vialidad:   '#3C3C3B',  // gris

  optimista: '#2C6E8C',
  base:      '#153244',
  pesimista: '#B49B00',
};

const fmtInt = new Intl.NumberFormat('es-AR', { maximumFractionDigits: 0 });
const fmtPct = (x, d = 2) => `${(x * 100).toFixed(d)}%`;

let PARAMS = null;         // datos del JSON
let STATE  = null;         // estado actual editable por sliders
let chartTotal = null;
let chartCat   = null;


/* ─────────────────────────────────────────────────────────
 *  Modelo
 * ───────────────────────────────────────────────────────── */

/** Stock anual de presos de una categoría, a partir de:
 *  - cat: { delitos_2023, presos_sneep_2023, tasa_captura, condena_media_anos }
 *  - crecimiento: tasa anual decimal (0.03 = +3%/año)
 *  - horizonteAnos: cantidad de años a simular (a partir de 2024)
 *
 *  Modelo:
 *    stock(2023) = presos_sneep_2023                              (observado)
 *    stock(t)    = stock(t−1) + ingresos(t) − salidas(t)
 *    ingresos(t) = delitos_2023 · (1+g)^(t−2023) · tasa_captura
 *    salidas(t)  = ingresos(t − condena_media)
 *                  Si t − condena_media < 2024, asumimos salidas
 *                  iguales a la cohorte estacionaria pre-modelo:
 *                  presos_sneep_2023 / condena_media.
 */
function simularCategoria(cat, crecimiento, horizonteAnos) {
  const condena = Math.max(1, Math.round(cat.condena_media_anos || 1));
  const ingresoEstacionario = cat.presos_sneep_2023 / condena;

  const ingresos = [];
  for (let i = 1; i <= horizonteAnos; i++) {
    const delitos = cat.delitos_2023 * Math.pow(1 + crecimiento, i);
    ingresos.push(delitos * cat.tasa_captura);
  }

  const stock = [];
  let s = cat.presos_sneep_2023;
  for (let i = 0; i < horizonteAnos; i++) {
    const ing = ingresos[i];
    const j = i - condena;
    const salida = j >= 0 ? ingresos[j] : ingresoEstacionario;
    s = Math.max(0, s + ing - salida);
    stock.push(s);
  }
  return stock;
}

/** Corre la simulación completa: devuelve, por escenario,
 *  totales anuales y desagregación por categoría. */
function simular(state) {
  const horizonte = state.horizonte;
  const aniosBase = 2023;
  const anios = Array.from({ length: horizonte }, (_, i) => aniosBase + 1 + i);

  const out = {};
  for (const [escName, g] of Object.entries(state.crecimientos)) {
    const byCat = {};
    const total = new Array(horizonte).fill(0);
    for (const cat of state.categorias) {
      const stock = simularCategoria(cat, g, horizonte);
      byCat[cat.nombre] = stock;
      for (let i = 0; i < horizonte; i++) total[i] += stock[i];
    }
    out[escName] = { anios, byCat, total };
  }
  return out;
}


/* ─────────────────────────────────────────────────────────
 *  Render
 * ───────────────────────────────────────────────────────── */

function renderKpis() {
  const m = PARAMS.meta;
  const tasa = m.total_presos_sneep_2023 / m.total_delitos_caba_2023;
  document.getElementById('kpi-delitos').textContent = fmtInt.format(m.total_delitos_caba_2023);
  document.getElementById('kpi-presos').textContent  = fmtInt.format(m.total_presos_sneep_2023);
  document.getElementById('kpi-tasa').textContent    = fmtPct(tasa);
}

function renderTablaParametros() {
  const tbody = document.querySelector('#tabla-parametros tbody');
  tbody.innerHTML = '';
  for (const c of PARAMS.categorias) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><span class="dot" style="background:${COLOR[c.nombre]}"></span>${c.nombre}</td>
      <td class="num">${fmtInt.format(c.delitos_2023)}</td>
      <td class="num">${fmtInt.format(c.presos_sneep_2023)}</td>
      <td class="num">${fmtPct(c.tasa_empirica)}</td>
      <td class="num">${c.condena_media_anos ?? '—'} años</td>
      <td class="num">${c.condena_mediana_anos ?? '—'} años</td>
    `;
    tbody.appendChild(tr);
  }
}

function renderSliders() {
  // Tasa de captura por categoría
  const gridTasa = document.getElementById('sliders-tasa');
  gridTasa.innerHTML = '';
  STATE.categorias.forEach((c, idx) => {
    const row = document.createElement('div');
    row.className = 'slider-row';
    const maxPct = Math.max(5, Math.ceil(c.tasa_captura * 100 * 1.5));  // máx dinámico
    row.innerHTML = `
      <label style="color:${COLOR[c.nombre]};font-weight:600">${c.nombre}</label>
      <input type="range" min="0" max="${maxPct * 100}" step="1" value="${Math.round(c.tasa_captura * 10000)}" data-cat="${idx}">
      <span class="val">${(c.tasa_captura * 100).toFixed(2)}%</span>
    `;
    const input = row.querySelector('input');
    const val   = row.querySelector('.val');
    input.addEventListener('input', () => {
      STATE.categorias[idx].tasa_captura = (+input.value) / 10000;
      val.textContent = (STATE.categorias[idx].tasa_captura * 100).toFixed(2) + '%';
      rerun();
    });
    gridTasa.appendChild(row);
  });

  // Crecimiento por escenario
  const gridG = document.getElementById('sliders-crecimiento');
  gridG.innerHTML = '';
  for (const esc of ['optimista', 'base', 'pesimista']) {
    const row = document.createElement('div');
    row.className = `slider-row ${esc === 'optimista' ? 'opt' : esc === 'base' ? 'base' : 'pes'}`;
    const g = STATE.crecimientos[esc];
    row.innerHTML = `
      <label>${esc[0].toUpperCase()+esc.slice(1)}</label>
      <input type="range" min="-10" max="15" step="0.5" value="${(g*100).toFixed(1)}" data-esc="${esc}">
      <span class="val">${g >= 0 ? '+' : ''}${(g*100).toFixed(1)}%</span>
    `;
    const input = row.querySelector('input');
    const val   = row.querySelector('.val');
    input.addEventListener('input', () => {
      STATE.crecimientos[esc] = (+input.value) / 100;
      val.textContent = (STATE.crecimientos[esc] >= 0 ? '+' : '') + (STATE.crecimientos[esc]*100).toFixed(1) + '%';
      rerun();
    });
    gridG.appendChild(row);
  }

  // Horizonte
  const hzInput = document.getElementById('horizonte');
  hzInput.value = STATE.horizonte;
  hzInput.addEventListener('input', () => {
    const h = Math.min(20, Math.max(3, +hzInput.value || 10));
    STATE.horizonte = h;
    rerun();
  });

  // Reset
  document.getElementById('reset').addEventListener('click', () => {
    STATE = freshState();
    renderSliders();
    rerun();
  });
}

function renderTablaPlazas(sim) {
  const base = sim.base;
  const thead = document.querySelector('#tabla-plazas thead');
  const tbody = document.querySelector('#tabla-plazas tbody');

  thead.innerHTML = '<tr><th>Categoría</th>' +
    base.anios.map(a => `<th class="num">${a}</th>`).join('') +
    '</tr>';

  tbody.innerHTML = '';
  for (const cat of STATE.categorias) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td><span class="dot" style="background:${COLOR[cat.nombre]}"></span>${cat.nombre}</td>` +
      base.byCat[cat.nombre].map(v => `<td class="num">${fmtInt.format(Math.round(v))}</td>`).join('');
    tbody.appendChild(tr);
  }
  // Fila total
  const trTot = document.createElement('tr');
  trTot.className = 'total-row';
  trTot.innerHTML = '<td>Total</td>' +
    base.total.map(v => `<td class="num">${fmtInt.format(Math.round(v))}</td>`).join('');
  tbody.appendChild(trTot);
}


/* ─────────────────────────────────────────────────────────
 *  Charts
 * ───────────────────────────────────────────────────────── */

function renderChartTotal(sim) {
  const ctx = document.getElementById('chart-total');
  const data = {
    labels: sim.base.anios,
    datasets: [
      { label: 'Optimista (crecimiento bajo)',  data: sim.optimista.total, borderColor: COLOR.optimista, backgroundColor: COLOR.optimista+'22', tension: 0.25 },
      { label: 'Base',                          data: sim.base.total,      borderColor: COLOR.base,      backgroundColor: COLOR.base+'22',      tension: 0.25 },
      { label: 'Pesimista (crecimiento alto)',  data: sim.pesimista.total, borderColor: COLOR.pesimista, backgroundColor: COLOR.pesimista+'22', tension: 0.25 },
    ],
  };
  const opts = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { position: 'bottom' },
      tooltip: { callbacks: { label: c => `${c.dataset.label}: ${fmtInt.format(Math.round(c.parsed.y))} plazas` } },
    },
    scales: {
      y: { title: { display: true, text: 'Plazas necesarias' }, ticks: { callback: v => fmtInt.format(v) } },
      x: { title: { display: true, text: 'Año' } },
    },
  };
  if (chartTotal) {
    chartTotal.data = data;
    chartTotal.update();
  } else {
    chartTotal = new Chart(ctx, { type: 'line', data, options: opts });
  }
}

function renderChartCategorias(sim) {
  const ctx = document.getElementById('chart-cat');
  const base = sim.base;
  const datasets = STATE.categorias.map(c => ({
    label: c.nombre,
    data: base.byCat[c.nombre],
    backgroundColor: COLOR[c.nombre],
    borderWidth: 0,
  }));
  const data = { labels: base.anios, datasets };
  const opts = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { position: 'bottom' },
      tooltip: { callbacks: { label: c => `${c.dataset.label}: ${fmtInt.format(Math.round(c.parsed.y))}` } },
    },
    scales: {
      x: { stacked: true, title: { display: true, text: 'Año' } },
      y: { stacked: true, title: { display: true, text: 'Plazas (stock)' }, ticks: { callback: v => fmtInt.format(v) } },
    },
  };
  if (chartCat) {
    chartCat.data = data;
    chartCat.update();
  } else {
    chartCat = new Chart(ctx, { type: 'bar', data, options: opts });
  }
}


/* ─────────────────────────────────────────────────────────
 *  Estado / orquestación
 * ───────────────────────────────────────────────────────── */

function freshState() {
  return {
    horizonte: PARAMS.meta.horizonte_anos,
    crecimientos: { ...PARAMS.escenarios_default },
    categorias: PARAMS.categorias.map(c => ({
      nombre: c.nombre,
      delitos_2023: c.delitos_2023,
      presos_sneep_2023: c.presos_sneep_2023,
      tasa_captura: c.tasa_empirica,
      condena_media_anos: c.condena_media_anos ?? 4,
    })),
  };
}

function rerun() {
  const sim = simular(STATE);
  renderChartTotal(sim);
  renderChartCategorias(sim);
  renderTablaPlazas(sim);
}

async function main() {
  const r = await fetch('data/parametros.json');
  PARAMS = await r.json();
  STATE = freshState();
  renderKpis();
  renderTablaParametros();
  renderSliders();
  rerun();
}

main().catch(err => {
  console.error(err);
  document.body.innerHTML = `<div style="padding:32px;font-family:sans-serif">
    <h1>Error cargando datos</h1>
    <pre>${err}</pre>
    <p>Si abriste el archivo con doble click, no va a andar (fetch no funciona con <code>file://</code>).
    Levantá el servidor con <code>python -m http.server 8080 --directory public</code> y abrí <code>http://localhost:8080</code>.</p>
  </div>`;
});
