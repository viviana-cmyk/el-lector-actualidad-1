/**
 * parse-mindefensa.mjs
 * Lee mindefensa/latest.xlsx y genera src/data/mindefensa.nacional.json
 * Ejecutar: node scripts/parse-mindefensa.mjs
 */
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const XLSX    = require('xlsx');

const __dir   = dirname(fileURLToPath(import.meta.url));
const ROOT    = join(__dir, '..');
const ENTRADA = join(ROOT, 'mindefensa', 'latest.xlsx');
const SALIDA  = join(ROOT, 'src', 'data', 'mindefensa.nacional.json');

// Indicadores que queremos extraer y su fila-etiqueta exacta en el Excel
const INDICADORES = {
  masacres_casos:          'Masacres (casos)',
  masacres_victimas:       'Masacres (víctimas)',
  secuestro_casos:         'Secuestro total (casos)',
  secuestro_victimas:      'Secuestro total (víctimas)',
  fp_asesinados:           'Asesinados Fuerza Pública',
  fp_asesinados_ff_mm:     'Asesinados Fuerzas Militares',
  fp_asesinados_policia:   'Asesinados Policía Nacional',
  fp_heridos:              'Heridos Fuerza Pública',
  fp_heridos_ff_mm:        'Heridos Fuerzas Militares',
  fp_heridos_policia:      'Heridos Policía Nacional',
};

function parsear() {
  const wb   = XLSX.readFile(ENTRADA);
  const ws   = wb.Sheets['Año corrido'];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });

  // Encuentra la fila de encabezados (contiene "Ene - Jul")
  const headerIdx = rows.findIndex(r => r.some(v => typeof v === 'string' && v.startsWith('Ene - Jul')));
  if (headerIdx < 0) throw new Error('No se encontró fila de encabezados en Año corrido');

  const header = rows[headerIdx];

  // Columnas de los últimos dos años
  // Los encabezados son "Ene - Jul 2026", "Ene - Jul 2025", etc.
  const yearCols = header
    .map((v, i) => ({ i, v }))
    .filter(({ v }) => typeof v === 'string' && v.startsWith('Ene - Jul'))
    .map(({ i, v }) => ({ i, year: parseInt(v.replace('Ene - Jul ', ''), 10) }))
    .sort((a, b) => b.year - a.year);

  if (yearCols.length < 2) throw new Error('No se encontraron suficientes columnas de año');

  const [col26, col25] = [yearCols[0], yearCols[1]];
  const periodo = `Ene - Jul ${col26.year}`;

  console.log(`Período más reciente: ${periodo} (col ${col26.i})`);
  console.log(`Período anterior:     Ene - Jul ${col25.year} (col ${col25.i})`);

  // Normalizar etiquetas para búsqueda
  const normalize = s => s.trim().toLowerCase().replace(/\s+/g, ' ');

  // Construir mapa label → fila
  const labelMap = new Map();
  rows.forEach((r, i) => {
    const label = r[1];
    if (typeof label === 'string' && label.trim()) {
      labelMap.set(normalize(label), i);
    }
  });

  const resultado = {};
  for (const [key, label] of Object.entries(INDICADORES)) {
    const rowIdx = labelMap.get(normalize(label));
    if (rowIdx == null) {
      console.warn(`  ⚠ No encontrado: "${label}"`);
      resultado[key] = { [`casos_${col25.year}`]: null, [`casos_${col26.year}`]: null };
      continue;
    }
    const row = rows[rowIdx];
    const v25 = row[col25.i];
    const v26 = row[col26.i];
    resultado[key] = {
      [`casos_${col25.year}`]: typeof v25 === 'number' ? v25 : null,
      [`casos_${col26.year}`]: typeof v26 === 'number' ? v26 : null,
    };
    console.log(`  ✓ ${label}: ${v25} → ${v26}`);
  }

  const salida = {
    fuente:    'Ministerio de Defensa Nacional — Observatorio de Derechos Humanos y Defensa Nacional',
    documento: `Seguimiento a Indicadores de Seguridad y Resultados Operacionales — ${col26.year}`,
    periodo:   `Ene-Jul ${col26.year}`,
    generado:  new Date().toISOString().slice(0, 10),
    ...resultado,
  };

  writeFileSync(SALIDA, JSON.stringify(salida, null, 2));
  console.log(`\nJSON guardado en ${SALIDA}`);
}

parsear();
