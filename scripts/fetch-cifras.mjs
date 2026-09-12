#!/usr/bin/env node
// Pipeline de datos — "Datos y Cifras"
// Fuente única: Policía Nacional (SIEDCO via datos.gov.co)
// 6 delitos de impacto · 38 municipios · ene-abr 2025 vs. ene-abr 2026

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

// ── IDs verificados en vivo el 2026-07-14 ───────────────────────────────────
const DATASETS = {
  homicidio:         { id: 'm8fd-ahd9', nombre: 'HOMICIDIO — Policía Nacional (SIEDCO)' },
  hurto_personas:    { id: '4rxi-8m8d', nombre: 'HURTO A PERSONAS — Policía Nacional (SIEDCO)' },
  extorsion:         { id: 'q2ib-t9am', nombre: 'EXTORSIÓN — Policía Nacional (SIEDCO)' },
  hurto_residencias: { id: '7mn7-vzqp', nombre: 'HURTO A RESIDENCIAS — Policía Nacional (SIEDCO)' },
  violencia_intra:   { id: 'gepp-dxcs', nombre: 'VIOLENCIA INTRAFAMILIAR — Policía Nacional (SIEDCO)' },
  hurto_automotores: {
    id: 'csb4-y6v2',
    nombre: 'HURTO A AUTOMOTORES — Policía Nacional (SIEDCO)',
    filtroExtra: "tipo_delito='ARTICULO 239. HURTO AUTOMOTORES'",
  },
};
const SODA_BASE   = 'https://www.datos.gov.co/resource';
const DESDE_ANIO  = 2019;   // quiebre metodológico SIEDCO-SPOA 2016-2018
const BASE_MINIMA = 20;     // menos de este nº de casos → variación % suprimida

// Población nacional Colombia (DANE — Proyecciones Municipales 2018-2042, CNPV 2018)
const POB_NACIONAL_2025 = 52_215_503;
const POB_NACIONAL_2026 = 52_531_626;

// Período dinámico: SIEDCO publica el día 16 con datos del mes anterior
const _MESES_NOMBRES = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
const _ahora       = new Date();
const _dia         = _ahora.getDate();
const _mesActual   = _ahora.getMonth() + 1; // 1-12
// Si ya pasó el día 16, disponemos del mes anterior; si no, del mes antes de ese
const MESES_DISP        = Math.max(1, _dia >= 16 ? _mesActual - 1 : _mesActual - 2);
const MESES_COMPARACION = Array.from({ length: MESES_DISP }, (_, i) => i + 1);
const LABEL_PERIODO     = MESES_DISP === 1 ? 'ene' : `ene-${_MESES_NOMBRES[MESES_DISP - 1]}`;
const FACTOR_PROYECCION = Math.round((12 / MESES_DISP) * 100) / 100; // ej. 2 para 6 meses
// MESES_DISP is 1-indexed (e.g. 7 = July); new Date(y, MESES_DISP, 0) = last day of that month
const _corteDate    = new Date(_ahora.getFullYear(), MESES_DISP, 0);
const CORTE_POLICIA = _corteDate.toISOString().slice(0, 10);

// ── Cargar población DANE ────────────────────────────────────────────────────
const poblacionData = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'poblacion.dane.json'), 'utf-8')
);
const allCodes = poblacionData.municipios.map(m => m.divipola);

// ── Fetch con reintentos (datos.gov.co puede ser inestable) ─────────────────
async function fetchConReintentos(url, intentos = 4, espera = 8000) {
  for (let i = 1; i <= intentos; i++) {
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(60000) });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
      }
      return res.json();
    } catch (err) {
      if (i === intentos) throw err;
      console.log(`  ⚠ Intento ${i}/${intentos} fallido (${err.message}) — reintentando en ${espera/1000}s...`);
      await new Promise(r => setTimeout(r, espera));
      espera *= 2; // backoff exponencial
    }
  }
}

// ── Consulta SODA nacional (sin filtro de municipio) ────────────────────────
async function fetchNacionalMensual(datasetId, filtroExtra = '') {
  let where = `fecha_hecho >= '${DESDE_ANIO}-01-01T00:00:00'`;
  if (filtroExtra) where += ` AND ${filtroExtra}`;
  const params = new URLSearchParams({
    '$select': 'date_trunc_ym(fecha_hecho) as anio_mes,sum(cantidad) as total',
    '$where':  where,
    '$group':  'anio_mes',
    '$order':  'anio_mes',
    '$limit':  '1000',
  });
  return fetchConReintentos(`${SODA_BASE}/${datasetId}.json?${params}`);
}

// ── Indexar mensual nacional: { "2025-01" → nº } ────────────────────────────
function indexarNacional(rows) {
  const idx = {};
  for (const row of rows) {
    const ym = row.anio_mes.slice(0, 7);
    idx[ym] = (idx[ym] ?? 0) + parseInt(row.total, 10);
  }
  return idx;
}

function sumarNacional(idx, anio, meses) {
  return meses.reduce((s, n) => s + (idx[`${anio}-${String(n).padStart(2, '0')}`] ?? 0), 0);
}

// ── Calcular campos nacionales de un delito ───────────────────────────────────
function calcDelitoNacional(idx, pobNac25, pobNac26) {
  const c25ea = sumarNacional(idx, 2025, MESES_COMPARACION);
  const c26ea = sumarNacional(idx, 2026, MESES_COMPARACION);
  const vari  = variacion(c25ea, c26ea);
  return {
    casos_2025_ene_abr:    c25ea || null,
    casos_2026_ene_abr:    c26ea || null,
    variacion_pct_ene_abr: vari.valor,
    base_pequena:          vari.base_pequena,
    tasa_2025_ene_abr:     tasa(c25ea, pobNac25),
    tasa_2026_ene_abr:     tasa(c26ea, pobNac26),
    tasa_2026_proyectada:  c26ea && pobNac26
      ? Math.round((c26ea * FACTOR_PROYECCION / pobNac26) * 100000 * 10) / 10
      : null,
  };
}

// ── Consulta SODA con agregación mensual (server-side) ──────────────────────
async function fetchMensual(datasetId, codes, filtroExtra = '') {
  const codesStr = codes.map(c => `'${c}'`).join(',');
  let where = `cod_muni IN (${codesStr}) AND fecha_hecho >= '${DESDE_ANIO}-01-01T00:00:00'`;
  if (filtroExtra) where += ` AND ${filtroExtra}`;
  const params = new URLSearchParams({
    '$select': 'cod_muni,municipio,date_trunc_ym(fecha_hecho) as anio_mes,sum(cantidad) as total',
    '$where':  where,
    '$group':  'cod_muni,municipio,anio_mes',
    '$order':  'cod_muni,anio_mes',
    '$limit':  '50000',
  });
  const url = `${SODA_BASE}/${datasetId}.json?${params}`;
  return fetchConReintentos(url);
}

// ── Índice mensual por municipio: { cod_muni → { "2025-01" → nº } } ─────────
function indexarMensual(rows) {
  const idx = {};
  for (const row of rows) {
    const cod = row.cod_muni;
    if (!idx[cod]) idx[cod] = {};
    const ym = row.anio_mes.slice(0, 7); // "2026-01-01T..." → "2026-01"
    idx[cod][ym] = (idx[cod][ym] ?? 0) + parseInt(row.total, 10);
  }
  return idx;
}

// ── Sumar casos en un rango de meses de un año ──────────────────────────────
function sumar(idx, cod, anio, meses) {
  const m = idx[cod] ?? {};
  return meses.reduce((s, n) => s + (m[`${anio}-${String(n).padStart(2, '0')}`] ?? 0), 0);
}

// ── Tasa x100k (1 decimal) ───────────────────────────────────────────────────
function tasa(casos, pob) {
  if (!pob || !casos) return null;
  return Math.round((casos / pob) * 100000 * 10) / 10;
}

// ── Variación porcentual con control de base pequeña ────────────────────────
function variacion(anterior, actual) {
  if (!anterior || anterior === 0) return { valor: null, base_pequena: false };
  if (anterior < BASE_MINIMA)     return { valor: null, base_pequena: true  };
  return {
    valor: Math.round(((actual - anterior) / anterior) * 1000) / 10,
    base_pequena: false,
  };
}

// ── Calcular campos estándar de un delito para un municipio ─────────────────
function calcDelito(idx, cod, pob) {
  const AÑO_COMPLETO = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  const c25    = sumar(idx, cod, 2025, AÑO_COMPLETO);
  const c25ea  = sumar(idx, cod, 2025, MESES_COMPARACION);
  const c26ea  = sumar(idx, cod, 2026, MESES_COMPARACION);
  const vari   = variacion(c25ea, c26ea);
  return {
    casos_2025_completo:   c25   || null,
    casos_2025_ene_abr:    c25ea || null,
    casos_2026_ene_abr:    c26ea || null,
    variacion_pct_ene_abr: vari.valor,
    base_pequena:          vari.base_pequena,
    tasa_2025:             tasa(c25,  pob.poblacion_2025),
    tasa_2025_ene_abr:     tasa(c25ea, pob.poblacion_2025),
    tasa_2026_ene_abr:     tasa(c26ea, pob.poblacion_2026),
    tasa_2026_proyectada:  c26ea && pob.poblacion_2026
      ? Math.round((c26ea * FACTOR_PROYECCION / pob.poblacion_2026) * 100000 * 10) / 10
      : null,
  };
}

// ── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('▶  Datos y Cifras — descargando SIEDCO (12 datasets en paralelo: 6 municipal + 6 nacional)...\n');

  const [
    rowsHom, rowsHur, rowsExt, rowsRes, rowsVif, rowsAut,
    nacHom, nacHur, nacExt, nacRes, nacVif, nacAut,
  ] = await Promise.all([
    fetchMensual(DATASETS.homicidio.id,         allCodes),
    fetchMensual(DATASETS.hurto_personas.id,    allCodes),
    fetchMensual(DATASETS.extorsion.id,         allCodes),
    fetchMensual(DATASETS.hurto_residencias.id, allCodes),
    fetchMensual(DATASETS.violencia_intra.id,   allCodes),
    fetchMensual(DATASETS.hurto_automotores.id, allCodes, DATASETS.hurto_automotores.filtroExtra),
    // Totales nacionales (sin filtro de municipio)
    fetchNacionalMensual(DATASETS.homicidio.id),
    fetchNacionalMensual(DATASETS.hurto_personas.id),
    fetchNacionalMensual(DATASETS.extorsion.id),
    fetchNacionalMensual(DATASETS.hurto_residencias.id),
    fetchNacionalMensual(DATASETS.violencia_intra.id),
    fetchNacionalMensual(DATASETS.hurto_automotores.id, DATASETS.hurto_automotores.filtroExtra),
  ]);

  console.log(`  Homicidio:               ${rowsHom.length.toLocaleString()} filas (38 muns)`);
  console.log(`  Hurto a personas:        ${rowsHur.length.toLocaleString()} filas (38 muns)`);
  console.log(`  Extorsión:               ${rowsExt.length.toLocaleString()} filas (38 muns)`);
  console.log(`  Hurto a residencias:     ${rowsRes.length.toLocaleString()} filas (38 muns)`);
  console.log(`  Violencia intrafamiliar: ${rowsVif.length.toLocaleString()} filas (38 muns)`);
  console.log(`  Hurto automotores:       ${rowsAut.length.toLocaleString()} filas (38 muns)`);
  console.log(`  Nacional: ${nacHom.length}+${nacHur.length}+${nacExt.length}+${nacRes.length}+${nacVif.length}+${nacAut.length} filas mensuales`);
  console.log('');

  const homIdx = indexarMensual(rowsHom);
  const hurIdx = indexarMensual(rowsHur);
  const extIdx = indexarMensual(rowsExt);
  const resIdx = indexarMensual(rowsRes);
  const vifIdx = indexarMensual(rowsVif);
  const autIdx = indexarMensual(rowsAut);

  // ── Indexar totales nacionales ───────────────────────────────────────────
  const nacHomIdx = indexarNacional(nacHom);
  const nacHurIdx = indexarNacional(nacHur);
  const nacExtIdx = indexarNacional(nacExt);
  const nacResIdx = indexarNacional(nacRes);
  const nacVifIdx = indexarNacional(nacVif);
  const nacAutIdx = indexarNacional(nacAut);

  const nacional = {
    pob_2025: POB_NACIONAL_2025,
    pob_2026: POB_NACIONAL_2026,
    nota: 'Colombia total — DANE proyecciones 2018-2042',
    homicidio:         calcDelitoNacional(nacHomIdx, POB_NACIONAL_2025, POB_NACIONAL_2026),
    hurto_personas:    calcDelitoNacional(nacHurIdx, POB_NACIONAL_2025, POB_NACIONAL_2026),
    extorsion:         calcDelitoNacional(nacExtIdx, POB_NACIONAL_2025, POB_NACIONAL_2026),
    hurto_residencias: calcDelitoNacional(nacResIdx, POB_NACIONAL_2025, POB_NACIONAL_2026),
    violencia_intra:   calcDelitoNacional(nacVifIdx, POB_NACIONAL_2025, POB_NACIONAL_2026),
    hurto_automotores: calcDelitoNacional(nacAutIdx, POB_NACIONAL_2025, POB_NACIONAL_2026),
  };

  // ── Construir resultado por municipio ───────────────────────────────────
  const municipiosResult = [];
  const sinDatoHom = [];

  for (const pob of poblacionData.municipios) {
    const cod = pob.divipola;
    const hom = calcDelito(homIdx, cod, pob);
    if (!hom.casos_2025_completo && !hom.casos_2025_ene_abr && !hom.casos_2026_ene_abr) {
      sinDatoHom.push(pob.municipio);
    }
    municipiosResult.push({
      municipio:      pob.municipio,
      divipola:       cod,
      poblacion_2025: pob.poblacion_2025,
      poblacion_2026: pob.poblacion_2026,
      homicidio:         hom,
      hurto_personas:    calcDelito(hurIdx, cod, pob),
      extorsion:         calcDelito(extIdx, cod, pob),
      hurto_residencias: calcDelito(resIdx, cod, pob),
      violencia_intra:   calcDelito(vifIdx, cod, pob),
      hurto_automotores: calcDelito(autIdx, cod, pob),
    });
  }

  // ── Resumen de validación ────────────────────────────────────────────────
  const conDato  = campo => municipiosResult.filter(m => m[campo].casos_2025_completo).length;
  const total26  = campo => municipiosResult.reduce((s, m) => s + (m[campo].casos_2026_ene_abr ?? 0), 0);

  console.log('── RESUMEN DE VALIDACIÓN ─────────────────────────────────────');
  console.log(`  Municipios en output:              ${municipiosResult.length} / 38`);
  console.log(`  Con datos homicidio 2025:          ${conDato('homicidio')} / ${municipiosResult.length}`);
  console.log(`  Con datos hurto personas 2025:     ${conDato('hurto_personas')} / ${municipiosResult.length}`);
  console.log(`  Con datos extorsión 2025:          ${conDato('extorsion')} / ${municipiosResult.length}`);
  console.log(`  Con datos hurto residencias 2025:  ${conDato('hurto_residencias')} / ${municipiosResult.length}`);
  console.log(`  Con datos violencia intra 2025:    ${conDato('violencia_intra')} / ${municipiosResult.length}`);
  console.log(`  Con datos hurto automotores 2025:  ${conDato('hurto_automotores')} / ${municipiosResult.length}`);
  console.log('');
  console.log(`  Período comparado: ${LABEL_PERIODO} 2026 vs ${LABEL_PERIODO} 2025 (${MESES_DISP} meses · factor ×${FACTOR_PROYECCION})`);
  console.log(`  Homicidios ${LABEL_PERIODO} 2026 (38 mun.):   ${total26('homicidio').toLocaleString()}`);
  console.log(`  Hurto personas ${LABEL_PERIODO} 2026:          ${total26('hurto_personas').toLocaleString()}`);
  console.log(`  Extorsión ${LABEL_PERIODO} 2026:               ${total26('extorsion').toLocaleString()}`);
  console.log(`  Hurto residencias ${LABEL_PERIODO} 2026:       ${total26('hurto_residencias').toLocaleString()}`);
  console.log(`  Violencia intrafamiliar ${LABEL_PERIODO} 2026: ${total26('violencia_intra').toLocaleString()}`);
  console.log(`  Hurto automotores ${LABEL_PERIODO} 2026:       ${total26('hurto_automotores').toLocaleString()}`);
  console.log('');

  if (sinDatoHom.length) {
    console.log(`⚠  Sin datos homicidio Policía (aparecerán como "sin dato"):`);
    sinDatoHom.forEach(m => console.log(`     - ${m}`));
    console.log('');
  }

  // ── Armar JSON de salida ─────────────────────────────────────────────────
  const output = {
    meta: {
      generatedAt:   new Date().toISOString(),
      corte_policia:      CORTE_POLICIA,
      label_periodo:      LABEL_PERIODO,
      meses_disponibles:  MESES_DISP,
      factor_proyeccion:  FACTOR_PROYECCION,
      fuentes: {
        homicidio:         `${SODA_BASE}/${DATASETS.homicidio.id}.json`,
        hurto_personas:    `${SODA_BASE}/${DATASETS.hurto_personas.id}.json`,
        extorsion:         `${SODA_BASE}/${DATASETS.extorsion.id}.json`,
        hurto_residencias: `${SODA_BASE}/${DATASETS.hurto_residencias.id}.json`,
        violencia_intra:   `${SODA_BASE}/${DATASETS.violencia_intra.id}.json`,
        hurto_automotores: `${SODA_BASE}/${DATASETS.hurto_automotores.id}.json`,
        poblacion:         'DANE — Proyecciones Municipales 2018-2042 (CNPV 2018)',
      },
      advertencias: [
        `Cifras Policía Nacional: sujetas a variación posterior. Corte: ${CORTE_POLICIA}.`,
        'Series comparables desde 2019; quiebre SIEDCO-SPOA en 2016-2018.',
        'Variación % suprimida cuando base < 20 casos (campo base_pequena: true).',
        `Tasa proyectada = casos ${LABEL_PERIODO} × ${FACTOR_PROYECCION}; ETIQUETADA como proyección anual.`,
        `tasa_2025_ene_abr = casos_2025_ene_abr / poblacion_2025 × 100.000; misma ventana que 2026 para comparación homogénea.`,
        'Rankings y mapa: siempre por tasa x100k, nunca por absoluto.',
        'Hurto automotores: dataset csb4-y6v2 filtrado por tipo_delito=ARTICULO 239. HURTO AUTOMOTORES.',
      ],
      ids_verificados: Object.fromEntries(
        Object.entries(DATASETS).map(([k, v]) => [k, v.id])
      ),
    },
    nacional,
    municipios: municipiosResult,
  };

  // ── Escribir archivos de salida ──────────────────────────────────────────
  const outData = path.join(ROOT, 'src', 'data', 'cifras.data.json');
  fs.writeFileSync(outData, JSON.stringify(output, null, 2));
  console.log(`✓ src/data/cifras.data.json  (${municipiosResult.length} municipios)`);

  const outConfig = path.join(ROOT, 'fuentes.config.json');
  fs.writeFileSync(outConfig, JSON.stringify({
    generado:     new Date().toISOString(),
    nota:         'IDs SIEDCO verificados en vivo el 2026-07-14. Reverificar mensualmente con ?$limit=3.',
    corte_actual: CORTE_POLICIA,
    datasets:     Object.fromEntries(
      Object.entries(DATASETS).map(([k, v]) => [k, {
        id:     v.id,
        url:    `${SODA_BASE}/${v.id}.json`,
        nombre: v.nombre,
        ...(v.filtroExtra ? { filtro: v.filtroExtra } : {}),
      }])
    ),
  }, null, 2));
  console.log('✓ fuentes.config.json');
  console.log('─────────────────────────────────────────────────────────────\n');
}

main().catch(err => {
  console.error('✗ Error:', err.message);
  process.exit(1);
});
