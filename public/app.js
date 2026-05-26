/*  Simulación de capacidad carcelaria – CABA
 *  Toda la lógica del modelo corre en el navegador.
 *  Lee parámetros base de data/parametros.json (lo genera scripts/calcular_parametros.py).
 */

// Paleta derivada del manual de marca GCBA (azul / cyan / amarillo / gris)
const COLOR = {
  'Robo':               '#153244',  // azul oscuro
  'Hurto':              '#2C6E8C',  // azul medio (derivado)
  'Homicidios dolosos': '#FFCC00',  // amarillo institucional
  'Lesiones dolosas':   '#8DE2D6',  // cyan
  'Amenazas':           '#B49B00',  // amarillo oscuro (derivado)
  'Vialidad fatal':     '#3C3C3B',  // gris oscuro
  'Vialidad lesivo':    '#A7A7A6',  // gris medio

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

/** Tiempo medio de permanencia en cárcel para una categoría, ponderando
 *  condenados (con su condena efectiva) y procesados (con su tiempo de
 *  proceso). Inimputables se asimilan a procesados. */
function tiempoPermanenciaAnos(cat, factorCumplimiento) {
  const nCond = cat.presos_condenados || 0;
  const nProc = (cat.presos_procesados || 0) + (cat.presos_inimputables || 0);
  const n = nCond + nProc;
  if (n === 0) return 1;
  const tCond = (cat.condena_media_anos || 0) * factorCumplimiento;
  const tProc = cat.tiempo_proceso_anos || 0;
  return Math.max(0.5, (nCond * tCond + nProc * tProc) / n);
}

/** Stock anual de presos de una categoría:
 *
 *    permanencia      = wmean(condena_media · factor, tiempo_proceso)
 *    stock(2023)      = presos_2023                                  (observado)
 *    stock(t)         = stock(t−1) + ingresos(t) − salidas(t)
 *    ingresos(t)      = delitos_2023 · (1+g)^(t−2023) · tasa_captura
 *    salidas(t)       = ingresos(t − permanencia)
 *                       Cohortes pre-2024 se asumen estacionarias:
 *                       stock_2023 / permanencia.
 */
function simularCategoria(cat, crecimiento, horizonteAnos, factorCumplimiento = 1.0) {
  const permanencia = tiempoPermanenciaAnos(cat, factorCumplimiento);
  const periodo = Math.max(1, Math.round(permanencia));
  const stock2023 = cat.presos_2023 || 0;
  const ingresoEstacionario = stock2023 / Math.max(0.5, permanencia);

  const ingresos = [];
  for (let i = 1; i <= horizonteAnos; i++) {
    const delitos = cat.delitos_2023 * Math.pow(1 + crecimiento, i);
    ingresos.push(delitos * cat.tasa_captura);
  }

  const stock = [];
  let s = stock2023;
  for (let i = 0; i < horizonteAnos; i++) {
    const ing = ingresos[i];
    const j = i - periodo;
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
  const factor = state.factorCumplimiento;
  for (const [escName, g] of Object.entries(state.crecimientos)) {
    const byCat = {};
    const total = new Array(horizonte).fill(0);
    for (const cat of state.categorias) {
      const stock = simularCategoria(cat, g, horizonte, factor);
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
  document.getElementById('kpi-delitos').textContent = fmtInt.format(m.total_delitos_caba_2023);
  document.getElementById('kpi-presos').textContent  = fmtInt.format(m.presos_modelables);
  const kpiOff = document.getElementById('kpi-fuera');
  if (kpiOff) kpiOff.textContent = fmtInt.format(m.presos_no_modelables);
}

function renderTablaParametros() {
  const tbody = document.querySelector('#tabla-parametros tbody');
  tbody.innerHTML = '';
  for (const c of PARAMS.categorias) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><span class="dot" style="background:${COLOR[c.nombre]}"></span>${c.nombre}</td>
      <td class="num">${fmtInt.format(c.delitos_2023)}</td>
      <td class="num"><strong>${fmtInt.format(c.presos_2023)}</strong></td>
      <td class="num muted-num">${fmtInt.format(c.presos_condenados)}</td>
      <td class="num muted-num">${fmtInt.format(c.presos_procesados)}</td>
      <td class="num">${fmtPct(c.pct_residencia_caba, 0)}</td>
      <td class="num"><strong>${fmtPct(c.tasa_flujo)}</strong></td>
      <td class="num">${c.condena_media_anos ?? '—'}</td>
      <td class="num">${c.tiempo_proceso_anos ?? '—'}</td>
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

  // Factor de cumplimiento (libertad condicional / asistida)
  const fcInput = document.getElementById('factor-cumplimiento');
  const fcVal   = document.getElementById('factor-cumplimiento-val');
  fcInput.value = Math.round(STATE.factorCumplimiento * 100);
  fcVal.textContent = `${Math.round(STATE.factorCumplimiento * 100)}%`;
  fcInput.addEventListener('input', () => {
    STATE.factorCumplimiento = (+fcInput.value) / 100;
    fcVal.textContent = `${Math.round(STATE.factorCumplimiento * 100)}%`;
    rerun();
  });

  // Capacidad de referencia
  const capInput = document.getElementById('capacidad');
  capInput.value = STATE.capacidadReferencia;
  capInput.addEventListener('input', () => {
    const v = Math.max(0, parseInt(capInput.value, 10) || 0);
    STATE.capacidadReferencia = v;
    rerun();
  });

  // Traspaso Cafiero: toggles por categoría
  const traspGrid = document.getElementById('traspaso-grid');
  if (traspGrid) {
    traspGrid.innerHTML = '';
    STATE.categorias.forEach((c, idx) => {
      const id = `trasp-${idx}`;
      const row = document.createElement('label');
      row.className = 'trasp-row';
      row.innerHTML = `
        <input type="checkbox" id="${id}" ${c.asumeCaba ? 'checked' : ''}>
        <span class="trasp-dot" style="background:${COLOR[c.nombre]}"></span>
        <span class="trasp-name">${c.nombre}</span>
        <span class="trasp-state"></span>
      `;
      const cb    = row.querySelector('input');
      const state = row.querySelector('.trasp-state');
      const sync  = () => state.textContent = cb.checked ? 'CABA' : 'Nacional';
      sync();
      cb.addEventListener('change', () => {
        STATE.categorias[idx].asumeCaba = cb.checked;
        sync();
        rerun();
      });
      traspGrid.appendChild(row);
    });

    // Preset buttons
    const setAll = (val) => {
      STATE.categorias.forEach((c, idx) => {
        c.asumeCaba = val;
        const cb = document.getElementById(`trasp-${idx}`);
        if (cb) cb.checked = val;
        const lbl = cb?.parentElement.querySelector('.trasp-state');
        if (lbl) lbl.textContent = val ? 'CABA' : 'Nacional';
      });
      rerun();
    };
    document.getElementById('preset-pleno')?.addEventListener('click', () => setAll(true));
    document.getElementById('preset-hoy')?.addEventListener('click',   () => setAll(false));
  }

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
  const n   = sim.base.anios.length;
  const cap = STATE.capacidadReferencia;
  const capLine = new Array(n).fill(cap);
  const data = {
    labels: sim.base.anios,
    datasets: [
      { label: `Capacidad de referencia (${fmtInt.format(cap)})`,
        data: capLine,
        borderColor: COLOR.Homicidios,    // amarillo institucional
        backgroundColor: 'transparent',
        borderDash: [6, 4],
        borderWidth: 2,
        pointRadius: 0,
        tension: 0,
        order: 0,
      },
      { label: 'Optimista (crecimiento bajo)',  data: sim.optimista.total, borderColor: COLOR.optimista, backgroundColor: COLOR.optimista+'22', tension: 0.25, order: 1 },
      { label: 'Base',                          data: sim.base.total,      borderColor: COLOR.base,      backgroundColor: COLOR.base+'22',      tension: 0.25, order: 1 },
      { label: 'Pesimista (crecimiento alto)',  data: sim.pesimista.total, borderColor: COLOR.pesimista, backgroundColor: COLOR.pesimista+'22', tension: 0.25, order: 1 },
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
  const stockTotal2023 = PARAMS.categorias.reduce(
    (s, c) => s + (c.presos_2023 || 0), 0,
  );
  return {
    horizonte: PARAMS.meta.horizonte_anos,
    crecimientos: { ...PARAMS.escenarios_default },
    factorCumplimiento: PARAMS.supuestos_default?.factor_cumplimiento ?? 0.67,
    capacidadReferencia: stockTotal2023,    // default: stock observado 2023
    stockTotal2023,
    categorias: PARAMS.categorias.map(c => ({
      nombre: c.nombre,
      delitos_2023: c.delitos_2023,
      presos_2023: c.presos_2023,
      presos_condenados:   c.presos_condenados,
      presos_procesados:   c.presos_procesados,
      presos_inimputables: c.presos_inimputables,
      tasa_captura: c.tasa_flujo,           // default = flujo (no empírica)
      condena_media_anos:  c.condena_media_anos ?? 4,
      tiempo_proceso_anos: c.tiempo_proceso_anos ?? 1,
      // Si la categoría se traspasa a CABA bajo el régimen Cafiero (default sí).
      // Las no marcadas se quedan como causas federales en SPF.
      asumeCaba: true,
    })),
  };
}

function rerun() {
  const sim = simular(STATE);
  renderChartTotal(sim);
  renderChartCategorias(sim);
  renderTablaPlazas(sim);
  renderBalance(sim);
  renderReparto(sim);
}

/** Reparto jurisdiccional al año final del horizonte:
 *  cuántas plazas van a CABA (categorías traspasadas) y cuántas a Nacional
 *  (categorías que quedan en SPF), por escenario. */
function renderReparto(sim) {
  const out = document.getElementById('reparto');
  if (!out) return;
  const horiz = STATE.horizonte;
  const anioFinal = 2023 + horiz;

  // Set de categorías que van a CABA
  const setCaba = new Set(
    STATE.categorias.filter(c => c.asumeCaba).map(c => c.nombre)
  );

  function split(byCat) {
    let caba = 0, nac = 0;
    for (const [nombre, serie] of Object.entries(byCat)) {
      const val = serie[horiz - 1] || 0;
      if (setCaba.has(nombre)) caba += val; else nac += val;
    }
    return { caba: Math.round(caba), nac: Math.round(nac) };
  }

  const data = {
    optimista: split(sim.optimista.byCat),
    base:      split(sim.base.byCat),
    pesimista: split(sim.pesimista.byCat),
  };

  const cards = Object.entries(data).map(([esc, { caba, nac }]) => `
    <div class="reparto-card">
      <div class="reparto-esc">${esc[0].toUpperCase()+esc.slice(1)}</div>
      <div class="reparto-row">
        <span class="reparto-jur caba">CABA</span>
        <span class="reparto-val">${fmtInt.format(caba)}</span>
      </div>
      <div class="reparto-row">
        <span class="reparto-jur nac">Nacional</span>
        <span class="reparto-val">${fmtInt.format(nac)}</span>
      </div>
      <div class="reparto-total">Total ${fmtInt.format(caba + nac)}</div>
    </div>
  `).join('');

  out.innerHTML = `
    <div class="balance-hd">Reparto jurisdiccional al ${anioFinal} <small>(según traspaso Cafiero seleccionado)</small></div>
    <div class="reparto-grid">${cards}</div>
  `;
}

/** Balance final del horizonte: déficit o superávit contra la capacidad. */
function renderBalance(sim) {
  const out = document.getElementById('balance');
  if (!out) return;
  const cap = STATE.capacidadReferencia;
  const horiz = STATE.horizonte;
  const anioFinal = 2023 + horiz;

  const valores = {
    optimista: Math.round(sim.optimista.total[horiz - 1]),
    base:      Math.round(sim.base.total[horiz - 1]),
    pesimista: Math.round(sim.pesimista.total[horiz - 1]),
  };

  const rows = [];
  for (const [esc, val] of Object.entries(valores)) {
    const delta = val - cap;
    const sign  = delta >= 0 ? '+' : '−';
    const abs   = Math.abs(delta);
    const tag   = delta > 0 ? 'def' : delta < 0 ? 'sup' : 'eq';
    const label = delta > 0 ? 'Déficit' : delta < 0 ? 'Superávit' : 'Calzado';
    rows.push(`
      <div class="balance-card ${tag}">
        <div class="balance-esc">${esc[0].toUpperCase()+esc.slice(1)}</div>
        <div class="balance-val">${fmtInt.format(val)}</div>
        <div class="balance-delta">${label} ${sign}${fmtInt.format(abs)}</div>
      </div>`);
  }

  out.innerHTML = `
    <div class="balance-hd">Balance al ${anioFinal} <small>(stock proyectado vs capacidad de referencia: ${fmtInt.format(cap)})</small></div>
    <div class="balance-grid">${rows.join('')}</div>
  `;
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
