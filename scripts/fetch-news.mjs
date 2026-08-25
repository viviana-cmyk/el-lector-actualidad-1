// Descarga titulares (RSS) de cada medio configurado en src/data/feeds.config.json
// y los indicadores economicos (TRM, dolar, euro), y escribe los JSON que
// consumen las paginas de Astro. Pensado para correr a diario desde
// GitHub Actions (ver .github/workflows/daily-update.yml).

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Parser from "rss-parser";
import Anthropic from "@anthropic-ai/sdk";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "src", "data");
const TRANSLATE_MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001";

const parser = new Parser({
  timeout: 15000,
  maxRedirects: 5,
  headers: {
    "User-Agent":
      "Mozilla/5.0 (compatible; ElGatoLectorBot/1.0; +https://github.com/) RSS reader",
  },
});

const LOCALES = {
  es: { hl: "es-419", gl: "CO", ceid: "CO:es-419" },
  en: { hl: "en-US", gl: "US", ceid: "US:en" },
};

function buildGoogleNewsUrl(query, locale = "es", when = "7d") {
  const params = new URLSearchParams({ q: `${query} when:${when}`, ...LOCALES[locale] });
  return `https://news.google.com/rss/search?${params.toString()}`;
}

// Google Noticias entrega titulos como "Titular - Nombre del medio"
function cleanGoogleTitle(title) {
  return title.replace(/\s+-\s+[^-]+$/, "").trim();
}

// Algunos sitios (p.ej. weforum.org) son indexados por Google Noticias sobre todo
// a traves de paginas de perfil de autor, cuyo "titular" es solo un nombre propio
// (2 a 4 palabras, todas con mayuscula inicial, sin conectores en minuscula).
// Esos resultados se descartan porque no son noticias.
const AUTHOR_NAME_RE = /^([A-ZÁÉÍÓÚÑ][a-zA-ZÁÉÍÓÚÑáéíóúñ'-]*\s*){2,4}$/;
function looksLikeAuthorName(title) {
  return AUTHOR_NAME_RE.test(title);
}

// Descarta títulos que son solo una fecha (ej: "24 de agosto del 2026") o muy cortos.
const DATE_ONLY_RE = /^\d{1,2}\s+de\s+\w+(\s+del?\s+\d{4})?$|^\w+\s+\d{1,2},?\s+\d{4}$|^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}$/i;
function looksLikeDate(title) {
  return DATE_ONLY_RE.test(title) || title.length < 18;
}

// POLÍTICA EDITORIAL PERMANENTE: El LECTOR excluye farándula y derivados.
// No modificar ni debilitar este filtro sin instrucción explícita.
// Categorías excluidas: astrología/esotérico, vida privada de celebridades,
// rumores sin verificar, apariencia física, drama en redes, fuentes anónimas,
// infidelidades/romances, noticias que identifican personas por vínculo con famosos.
const LOW_QUALITY_RE = new RegExp(
  [
    // Esotérico / pseudociencia
    "hor[oó]scopos?", "astrolog[ií]a", "zodiac[ao]l?", "tarot",
    "ni[ñn]o prodigio", "carta astral", "numerolog[ií]a", "esot[eé]ric[ao]",
    "feng shui", "chakras?", "or[aá]culo", "rituales? de",
    "predicciones? del ni[ñn]o",
    // Farándula / vida privada de celebridades
    "farand[uú]la", "c[íi]rculo [íi]ntimo", "vida amorosa",
    "romance (secreto|de |entre )", "spice girl",
    "conquist[oó] (el )?coraz[oó]n", "novio? (secreto?|de )",
    "vida sentimental", "escand[aá]lo amoroso", "beso rob[aá]do",
    "infidelidad", "separaci[oó]n amorosa",
    "esposo de ", "esposa de ", "pareja de ",
    "ex (esposo|esposa|novi[ao]) de ",
    "de RBD", "de Rebelde",
    "actor (vinculado|acusado|detenido)",
    "actriz (vinculada|acusada|detenida)",
    "cantante (vinculad|acusad)",
    // Apariencia física / moda
    "look del d[íi]a", "outfit", "mejor vestida", "peor vestida",
    "secreto de belleza", "dieta (milagro|de )",
    "antes y despu[eé]s", "irreconocible",
    "subi[oó] de peso", "baj[oó] de peso", "cirugía est[eé]tica",
    // Rumores / fuentes no verificadas
    "se rumorea", "rumores? (de |sobre )", "especulaci[oó]n",
    "fuentes (cercanas|an[oó]nimas)", "seg[uú]n fuentes",
    // Conflictos en redes / drama
    "\\bdrama\\b", "\\bbeef\\b", "indirecta (a |para )",
    "influencers? (se |en )", "pelea entre",
    "conflicto (personal|entre celebr)",
    // Entretenimiento / reality / TV
    "reality show", "\\breality\\b", "programa de (tv|televisión)",
    "eliminado de ", "capítulo de ", "novela (colombiana|mexicana|turca)",
    "\\btelenovela\\b", "streaming (estrena|lanza)",
    // Vida privada de figuras públicas
    "divorcio de ", "hijos de ", "boda de ", "matrimonio de ",
    "nació el (bebé|hijo|hija) de", "embarazo de ",
    "vida personal de ", "familia de (el presidente|el ministro)",
    // Accidentes menores / curiosidades sin impacto
    "curioso(a)? viral", "video viral", "\\bviral\\b.*tierno",
    "\\btierno\\b", "\\badorable\\b", "\\bcute\\b",
    "accidente de tr[aá]nsito$", "choque (de autos?|de carros?|de motos?)",
    // Moda / vestuario / belleza / cuidado personal
    "vestido (de |que )", "cr[ií]tica (al|de) vestuario",
    "qué llevó", "cómo fue el look",
    "diseños? de (uñas|cabello|maquillaje|peinados?)",
    "colores? de (labiales?|sombras|esmaltes?)",
    "labiales? (para|de |en )", "esmaltes? para",
    "maquillaje (de |para |en )", "skincare", "rutina de belleza",
    // Listicles de lifestyle / consejos sin valor informativo
    "\\d+ (planes?|tips?|ideas?|maneras?|formas?|razones?) para",
    "planes? para festejar", "planes? para celebrar",
    "cómo celebrar", "qué hacer (este|en) ",
    // Loterías y juegos de azar
    "loter[ií]a de ", "resultados (de la )?loter[ií]a",
    "n[uú]meros? ganadores?", "premio mayor de",
    "chance del d[ií]a", "baloto", "super astro",
    // Celebraciones personales de celebridades
    "celebra el aniversario", "fotos in[eé]ditas de",
    "aniversario de (su |el |la )", "cumplea[ñn]os de ",
    "karol g ", "maluma ", "j balvin ", "shakira (celebra|comparte|publica)",
  ].map(p => `(${p})`).join("|"),
  "i"
);
function isLowQualityContent(title) {
  return LOW_QUALITY_RE.test(title);
}

// Recorta un resumen a una longitud razonable para tarjetas destacadas.
function truncateSnippet(text, maxLength = 280) {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= maxLength) return clean;
  return `${clean.slice(0, maxLength).trim()}…`;
}

async function fetchOutletItems(outlet) {
  const items = [];

  for (const feed of outlet.feeds) {
    const url =
      feed.type === "google" ? buildGoogleNewsUrl(feed.query, feed.locale, feed.when) : feed.url;
    try {
      const parsed = await parser.parseURL(url);
      for (const item of parsed.items || []) {
        if (!item.link) continue;
        const rawTitle = (item.title || "").trim();
        const title = feed.type === "google" ? cleanGoogleTitle(rawTitle) : rawTitle;
        if (!title) continue;
        if (feed.type === "google" && looksLikeAuthorName(title)) continue;
        if (feed.type === "google" && looksLikeDate(title)) continue;
        if (isLowQualityContent(title)) continue;
        // Los resultados de Google Noticias no traen un resumen util (solo
        // enlaces relacionados), asi que el snippet solo se usa para RSS directo.
        const rawSnippet = feed.type === "rss" ? item.contentSnippet || item.summary : null;
        const snippet = rawSnippet ? truncateSnippet(rawSnippet) : null;
        items.push({
          title,
          link: item.link,
          pubDate: item.isoDate || item.pubDate || null,
          snippet,
        });
      }
    } catch (err) {
      console.warn(`  [aviso] ${outlet.name}: fallo al leer ${url} -> ${err.message}`);
    }
  }

  // quitar duplicados, ordenar por fecha desc
  const seen = new Set();
  const deduped = [];
  for (const item of items) {
    if (seen.has(item.link)) continue;
    seen.add(item.link);
    deduped.push(item);
  }
  deduped.sort((a, b) => new Date(b.pubDate || 0) - new Date(a.pubDate || 0));
  return deduped;
}

// Siempre trae los artículos más recientes del feed sin filtro de fecha.
// Pasa hasta 3× el límite a la IA para que priorice por importancia temática.
// Si el feed está vacío, usa el JSON del día anterior como respaldo.
async function buildSection(outlets, prevOutlets = []) {
  const result = [];
  for (const outlet of outlets) {
    const all = await fetchOutletItems(outlet);
    const limit = outlet.limit || 6;
    let items = all.slice(0, limit * 3);

    if (items.length === 0 && prevOutlets.length > 0) {
      const prev = prevOutlets.find(o => o.name === outlet.name);
      if (prev?.items?.length > 0) {
        items = prev.items.slice(0, limit);
        console.log(`  - ${outlet.name}: feed vacío, conservando día anterior (${items.length})`);
      } else {
        console.log(`  - ${outlet.name}: sin noticias disponibles`);
      }
    } else {
      console.log(`  - ${outlet.name}: ${items.length} titular(es)`);
    }

    // _all se usa en enforceRange para garantizar el mínimo; se elimina antes de escribir JSON
    result.push({ name: outlet.name, color: outlet.color, items, _all: all });
  }
  return result;
}

// Garantiza mínimo 3 y máximo 6 artículos por medio.
// Si la IA dejó menos de 3 (por excluir contenido), rellena con los más
// recientes del feed original que aún no estén en la lista.
function enforceRange(builtOutlets, configOutlets, min = 3, max = 6) {
  return builtOutlets.map((outlet, i) => {
    const limit = configOutlets[i]?.limit || max;
    const cap = Math.min(limit, max);
    let items = outlet.items.slice(0, cap);

    if (items.length < min && outlet._all?.length > 0) {
      const seen = new Set(items.map(it => it.link));
      for (const item of outlet._all) {
        if (items.length >= min) break;
        if (!seen.has(item.link)) { items.push(item); seen.add(item.link); }
      }
    }

    const { _all, ...rest } = outlet;
    return { ...rest, items };
  });
}


// Traduce al espanol los titulares/resumenes de los medios marcados con
// "language": "en" en feeds.config.json, usando la API de Anthropic. Si no hay
// clave configurada, o la traduccion falla, se dejan los textos originales en
// ingles (el sitio sigue funcionando, solo sin traduccion ese dia).
async function translateEnglishOutlets(apiKey, outletConfigs, builtOutlets) {
  if (!apiKey) return;

  const items = [];
  outletConfigs.forEach((config, i) => {
    if (config.language && config.language !== "es") items.push(...builtOutlets[i].items);
  });
  if (items.length === 0) return;

  const payload = items.map((item) => ({ title: item.title, snippet: item.snippet }));
  const prompt = `Traduce al español estos titulares y resúmenes de noticias (estan en formato JSON). Conserva nombres propios, lugares, organizaciones, cifras y el significado exacto; no agregues comentarios ni texto adicional.

${JSON.stringify(payload)}

Responde ÚNICAMENTE con un array JSON del mismo tamaño y en el mismo orden, con el formato {"title": "<titulo traducido>", "snippet": "<resumen traducido>" o null}, sin texto adicional ni bloques de código.`;

  try {
    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: TRANSLATE_MODEL,
      max_tokens: 4096,
      messages: [{ role: "user", content: prompt }],
    });
    const text = response.content.find((block) => block.type === "text")?.text || "";
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) throw new Error("la respuesta no contiene un array JSON");
    const translated = JSON.parse(match[0]);
    if (!Array.isArray(translated) || translated.length !== items.length) {
      throw new Error("la traduccion no coincide con la cantidad de titulares");
    }
    translated.forEach((t, i) => {
      if (t.title) items[i].title = t.title;
      if (items[i].snippet) items[i].snippet = t.snippet ?? items[i].snippet;
    });
    console.log(`  - Traducidos ${items.length} titular(es) del inglés`);
  } catch (err) {
    console.warn(`  [aviso] traduccion: ${err.message}`);
  }
}

// Reordena los titulares de cada medio por prioridad temática:
// ALTA (política, economía, seguridad, ciencia, crisis) primero;
// DEPORTES solo si son de relevancia nacional, siempre al final.
// Los ítems excluidos (farándula, vida privada, entretenimiento, etc.) se eliminan.
// Retorna { outlets, topItem } donde topItem es el #1 global (para noticia del día).
async function prioritizeSection(apiKey, builtOutlets) {
  if (!apiKey || builtOutlets.every(o => o.items.length === 0)) {
    return { outlets: builtOutlets, topItem: null };
  }

  const indexed = [];
  builtOutlets.forEach((outlet, oi) => {
    outlet.items.forEach((item, ii) => indexed.push({ oi, ii, title: item.title }));
  });
  if (indexed.length === 0) return { outlets: builtOutlets, topItem: null };

  const prompt = `Eres el editor de El LECTOR, boletín de noticias enfocado en política, seguridad, justicia y paz.

Clasifica cada titular con UNA de estas etiquetas:
- ALTA: política, geopolítica, seguridad, economía, regulación, decisiones públicas, tecnología/ciencia con impacto social, crisis o emergencias, temas de importancia nacional
- DEPORTES: solo si tiene relevancia nacional (Mundial, Copa América, logros históricos). Siempre va al final, nunca abre el ranking.
- EXCLUIR: farándula, vida privada de figuras públicas (divorcios, hijos, relaciones), entretenimiento, reality shows, moda, vestuarios, accidentes menores, curiosidades virales, chismes políticos sin impacto en gobernanza, escándalos de celebridades, historias emotivas sin relevancia pública.

Titulares (formato JSON con índice):
${JSON.stringify(indexed.map(({ oi, ii, title }) => ({ oi, ii, title })))}

Responde ÚNICAMENTE con un array JSON ordenado así: primero los ALTA de mayor a menor importancia (el más relevante e impactante primero), luego los DEPORTES, omite los EXCLUIR. Formato: [{"oi":0,"ii":0,"label":"ALTA"}, ...]`;

  try {
    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: TRANSLATE_MODEL,
      max_tokens: 4096,
      messages: [{ role: "user", content: prompt }],
    });
    const text = response.content.find(b => b.type === "text")?.text || "";
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) throw new Error("respuesta sin array JSON");
    const ranked = JSON.parse(match[0]);

    // Recopilar links de ítems excluidos para limpiar _all (evita que enforceRange los reintroduzca)
    const excludedLinks = new Set();
    for (const { oi, ii, label } of ranked) {
      if (label === "EXCLUIR") {
        const link = builtOutlets[oi]?.items[ii]?.link;
        if (link) excludedLinks.add(link);
      }
    }

    // Reconstruir outlets: ítems en orden global, _all filtrado de excluidos
    const result = builtOutlets.map(o => ({
      ...o,
      items: [],
      _all: (o._all || []).filter(item => !excludedLinks.has(item.link)),
    }));

    for (const { oi, ii, label } of ranked) {
      if (label === "EXCLUIR") continue;
      const item = builtOutlets[oi]?.items[ii];
      if (item) {
        item._priority = label;
        result[oi].items.push(item);
      }
    }

    // Noticia del día: el primer ALTA del ranking global (orden ya es de mayor a menor importancia)
    const firstAlta = ranked.find(r => r.label === "ALTA");
    let topItem = null;
    if (firstAlta) {
      const src = builtOutlets[firstAlta.oi];
      const item = src?.items[firstAlta.ii];
      if (item && src) topItem = { ...item, source: src.name };
    }

    console.log(`  - Priorización: ${ranked.filter(r => r.label !== "EXCLUIR").length} titulares ordenados, excluidos: ${excludedLinks.size}`);
    return { outlets: result, topItem };
  } catch (err) {
    console.warn(`  [aviso] priorización: ${err.message}`);
    return { outlets: builtOutlets, topItem: null };
  }
}

// Fallback para noticia del día cuando la IA no devuelve topItem.
// Usa el primer ítem ALTA sin exigir snippet (snippet es opcional en la UI).
function pickFeaturedStory(outlets) {
  for (const outlet of outlets) {
    for (const item of outlet.items) {
      if (item._priority === "ALTA") {
        const best = { ...item, source: outlet.name };
        delete best._priority;
        return best;
      }
    }
  }
  // Último recurso: primer ítem disponible
  for (const outlet of outlets) {
    if (outlet.items.length > 0) {
      const best = { ...outlet.items[0], source: outlet.name };
      delete best._priority;
      return best;
    }
  }
  return null;
}

async function fetchTRM() {
  const res = await fetch(
    "https://www.datos.gov.co/resource/mcec-87by.json?$order=vigenciadesde%20DESC&$limit=1",
    { signal: AbortSignal.timeout(15000) },
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  return Number(json[0]?.valor);
}

async function fetchFx() {
  const res = await fetch("https://open.er-api.com/v6/latest/USD", {
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (json.result !== "success") throw new Error("respuesta sin exito");
  return { dolar: json.rates.COP, euro: json.rates.COP / json.rates.EUR };
}

// Precio de un futuro/commodity desde Yahoo Finance (API publica, sin clave).
async function fetchYahooQuote(symbol) {
  const res = await fetch(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`,
    { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(15000) },
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const price = json?.chart?.result?.[0]?.meta?.regularMarketPrice;
  if (typeof price !== "number") throw new Error("sin precio");
  return price;
}

async function fetchCommodities() {
  const result = { brent: null, cafe: null };
  try {
    // Brent crude oil (USD por barril)
    result.brent = await fetchYahooQuote("BZ=F");
  } catch (err) {
    console.warn(`  [aviso] Brent: ${err.message}`);
  }
  try {
    // Cafe arabica ICE, cotiza en centavos de USD por libra -> USD/libra
    const centavos = await fetchYahooQuote("KC=F");
    result.cafe = centavos / 100;
  } catch (err) {
    console.warn(`  [aviso] Cafe: ${err.message}`);
  }
  return result;
}

// Ciudades para la seccion de clima (Open-Meteo, API publica sin clave).
const WEATHER_CITIES = {
  colombia: [
    { city: "Bogotá", lat: 4.711, lon: -74.0721 },
    { city: "Medellín", lat: 6.2442, lon: -75.5812 },
    { city: "Cali", lat: 3.4516, lon: -76.532 },
    { city: "Cartagena", lat: 10.391, lon: -75.4794 },
    { city: "Barranquilla", lat: 10.9685, lon: -74.7813 },
  ],
  mundo: [
    { city: "Nueva York", lat: 40.7128, lon: -74.006 },
    { city: "Londres", lat: 51.5074, lon: -0.1278 },
    { city: "Madrid", lat: 40.4168, lon: -3.7038 },
    { city: "Tokio", lat: 35.6762, lon: 139.6503 },
    { city: "Ciudad de México", lat: 19.4326, lon: -99.1332 },
  ],
};

// Codigos de tiempo WMO -> { descripcion, icono }
// https://open-meteo.com/en/docs (campo weathercode)
function describeWeatherCode(code) {
  const table = {
    0: ["Despejado", "☀️"],
    1: ["Mayormente despejado", "🌤️"],
    2: ["Parcialmente nublado", "⛅"],
    3: ["Nublado", "☁️"],
    45: ["Niebla", "🌫️"],
    48: ["Niebla helada", "🌫️"],
    51: ["Llovizna ligera", "🌦️"],
    53: ["Llovizna", "🌦️"],
    55: ["Llovizna intensa", "🌦️"],
    56: ["Llovizna helada", "🌦️"],
    57: ["Llovizna helada intensa", "🌦️"],
    61: ["Lluvia ligera", "🌧️"],
    63: ["Lluvia", "🌧️"],
    65: ["Lluvia intensa", "🌧️"],
    66: ["Lluvia helada", "🌧️"],
    67: ["Lluvia helada intensa", "🌧️"],
    71: ["Nevada ligera", "❄️"],
    73: ["Nevada", "❄️"],
    75: ["Nevada intensa", "❄️"],
    77: ["Granizo fino", "❄️"],
    80: ["Lluvias dispersas", "🌦️"],
    81: ["Lluvias", "🌦️"],
    82: ["Lluvias intensas", "🌧️"],
    85: ["Nevadas dispersas", "🌨️"],
    86: ["Nevadas intensas", "🌨️"],
    95: ["Tormenta", "⛈️"],
    96: ["Tormenta con granizo", "⛈️"],
    99: ["Tormenta con granizo fuerte", "⛈️"],
  };
  return table[code] || ["Sin datos", "🌡️"];
}

async function fetchCityWeather({ city, lat, lon }) {
  const res = await fetch(
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true`,
    { signal: AbortSignal.timeout(15000) },
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const current = json.current_weather;
  if (!current) throw new Error("sin datos actuales");
  const [description, icon] = describeWeatherCode(current.weathercode);
  return { city, temp: Math.round(current.temperature), description, icon };
}

// Obtiene los temas del momento de Google Trends (RSS público, sin clave).
// Devuelve un array de hasta `limit` strings con los términos trending.
async function fetchGoogleTrends(geo = "CO", limit = 5) {
  const url = `https://trends.google.com/trending/rss?geo=${geo}`;
  try {
    const parsed = await parser.parseURL(url);
    return (parsed.items || [])
      .slice(0, limit)
      .map(item => {
        const title = (item.title || "").trim();
        return title.startsWith("#") ? title : `#${title.replace(/\s+/g, "")}`;
      });
  } catch (err) {
    console.warn(`  [aviso] Google Trends (${geo}): ${err.message}`);
    return [];
  }
}

async function fetchApplePodcasts(country, limit = 5) {
  const res = await fetch(
    `https://rss.applemarketingtools.com/api/v2/${country}/podcasts/top/${limit}/podcasts.json`,
    { signal: AbortSignal.timeout(15000) },
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  return (json?.feed?.results || []).map((p) => ({ title: p.name, host: p.artistName, url: p.url }));
}

async function fetchWeather() {
  const result = { colombia: [], mundo: [] };
  for (const region of ["colombia", "mundo"]) {
    for (const place of WEATHER_CITIES[region]) {
      try {
        result[region].push(await fetchCityWeather(place));
      } catch (err) {
        console.warn(`  [aviso] clima ${place.city}: ${err.message}`);
      }
    }
  }
  return result;
}

async function fetchIndicators() {
  let previous = null;
  try {
    previous = JSON.parse(await readFile(path.join(DATA_DIR, "indicators.json"), "utf-8"));
  } catch {
    // primera ejecucion: no hay datos previos
  }

  const current = { trm: null, dolar: null, euro: null, brent: null, cafe: null };

  try {
    current.trm = await fetchTRM();
  } catch (err) {
    console.warn(`  [aviso] TRM: ${err.message}`);
  }

  try {
    const fx = await fetchFx();
    current.dolar = fx.dolar;
    current.euro = fx.euro;
  } catch (err) {
    console.warn(`  [aviso] tasas de cambio: ${err.message}`);
  }

  const commodities = await fetchCommodities();
  current.brent = commodities.brent;
  current.cafe = commodities.cafe;

  const result = { updatedAt: new Date().toISOString() };
  for (const key of ["trm", "dolar", "euro", "brent", "cafe"]) {
    const value = current[key] ?? previous?.[key] ?? null;
    const previousValue = previous?.[key] ?? null;
    let trend = "flat";
    if (typeof value === "number" && typeof previousValue === "number") {
      if (value > previousValue) trend = "up";
      else if (value < previousValue) trend = "down";
    }
    result[key] = value;
    result[`${key}Trend`] = trend;
  }

  return result;
}

async function main() {
  await mkdir(DATA_DIR, { recursive: true });
  const config = JSON.parse(
    await readFile(path.join(DATA_DIR, "feeds.config.json"), "utf-8"),
  );

  // Cargar noticias del día anterior como respaldo por si un medio no publicó
  let prevColombia = [], prevMundo = [], prevLatam = [];
  try {
    const prev = JSON.parse(await readFile(path.join(DATA_DIR, "news-colombia.json"), "utf-8"));
    prevColombia = prev.outlets || [];
  } catch { /* primera ejecución */ }
  try {
    const prev = JSON.parse(await readFile(path.join(DATA_DIR, "news-mundo.json"), "utf-8"));
    prevMundo = prev.outlets || [];
  } catch { /* primera ejecución */ }
  try {
    const prev = JSON.parse(await readFile(path.join(DATA_DIR, "news-latam.json"), "utf-8"));
    prevLatam = prev.outlets || [];
  } catch { /* primera ejecución */ }

  console.log("Obteniendo noticias de Colombia...");
  let colombia = await buildSection(config.colombia, prevColombia);

  console.log("Obteniendo noticias del mundo...");
  let mundo = await buildSection(config.mundo, prevMundo);

  console.log("Traduciendo medios en inglés...");
  await translateEnglishOutlets(process.env.ANTHROPIC_API_KEY, config.mundo, mundo);

  console.log("Priorizando titulares por relevancia temática...");
  { const r = await prioritizeSection(process.env.ANTHROPIC_API_KEY, colombia);
    colombia = r.outlets;
    console.log("Eligiendo la noticia del dia (Colombia)...");
    var featuredColombia = r.topItem ?? pickFeaturedStory(colombia); }
  colombia = enforceRange(colombia, config.colombia);

  { const r = await prioritizeSection(process.env.ANTHROPIC_API_KEY, mundo);
    mundo = r.outlets;
    console.log("Eligiendo la noticia del dia (Mundo)...");
    var featuredMundo = r.topItem ?? pickFeaturedStory(mundo); }
  mundo = enforceRange(mundo, config.mundo);

  console.log("Obteniendo noticias de Latinoamérica...");
  let latam = await buildSection(config.latam, prevLatam);
  await translateEnglishOutlets(process.env.ANTHROPIC_API_KEY, config.latam, latam);
  { const r = await prioritizeSection(process.env.ANTHROPIC_API_KEY, latam);
    latam = r.outlets; }
  latam = enforceRange(latam, config.latam);

  console.log("Obteniendo investigaciones recomendadas...");
  const recomendados = enforceRange(await buildSection(config.recomendados), config.recomendados);

  const generatedAt = new Date().toISOString();
  await writeFile(
    path.join(DATA_DIR, "news-colombia.json"),
    JSON.stringify({ generatedAt, outlets: colombia }, null, 2) + "\n",
  );
  await writeFile(
    path.join(DATA_DIR, "news-mundo.json"),
    JSON.stringify({ generatedAt, outlets: mundo }, null, 2) + "\n",
  );
  await writeFile(
    path.join(DATA_DIR, "news-latam.json"),
    JSON.stringify({ generatedAt, outlets: latam }, null, 2) + "\n",
  );
  await writeFile(
    path.join(DATA_DIR, "news-recomendados.json"),
    JSON.stringify({ generatedAt, outlets: recomendados }, null, 2) + "\n",
  );
  await writeFile(
    path.join(DATA_DIR, "featured.json"),
    JSON.stringify({ generatedAt, colombia: featuredColombia, mundo: featuredMundo }, null, 2) + "\n",
  );

  console.log("Obteniendo indicadores economicos...");
  const indicators = await fetchIndicators();
  await writeFile(
    path.join(DATA_DIR, "indicators.json"),
    JSON.stringify(indicators, null, 2) + "\n",
  );

  console.log("Obteniendo el clima de las ciudades...");
  const weather = await fetchWeather();
  await writeFile(
    path.join(DATA_DIR, "weather.json"),
    JSON.stringify({ generatedAt, ...weather }, null, 2) + "\n",
  );

  console.log("Obteniendo ranking de podcasts de Apple Podcasts...");
  let prevPodcasts = { colombia: [], mundo: [] };
  try {
    prevPodcasts = JSON.parse(await readFile(path.join(DATA_DIR, "podcasts.json"), "utf-8"));
  } catch { /* primera ejecución */ }
  const podcasts = { colombia: prevPodcasts.colombia || [], mundo: prevPodcasts.mundo || [] };
  try {
    const co = await fetchApplePodcasts("co");
    if (co.length > 0) { podcasts.colombia = co; console.log(`  - Apple Podcasts Colombia: ${co.length} podcasts`); }
  } catch (err) { console.warn(`  [aviso] Apple Podcasts Colombia: ${err.message}`); }
  try {
    const us = await fetchApplePodcasts("us");
    if (us.length > 0) { podcasts.mundo = us; console.log(`  - Apple Podcasts Mundo: ${us.length} podcasts`); }
  } catch (err) { console.warn(`  [aviso] Apple Podcasts Mundo: ${err.message}`); }
  await writeFile(
    path.join(DATA_DIR, "podcasts.json"),
    JSON.stringify({ generatedAt, ...podcasts }, null, 2) + "\n",
  );

  console.log("Obteniendo tendencias de Google Trends...");
  let prevTrends = null;
  try {
    prevTrends = JSON.parse(await readFile(path.join(DATA_DIR, "trends.json"), "utf-8"));
  } catch { /* primera ejecución */ }

  const trendsCO  = await fetchGoogleTrends("CO", 5);
  const trendsUS  = await fetchGoogleTrends("US", 5);
  const trendsES  = await fetchGoogleTrends("ES", 5);

  const trends = {
    generatedAt,
    colombia: trendsCO.length  ? trendsCO  : prevTrends?.colombia  ?? [],
    mundo:    (trendsUS.length || trendsES.length)
                ? [...new Set([...trendsUS, ...trendsES])].slice(0, 5)
                : prevTrends?.mundo ?? [],
  };
  console.log(`  - Tendencias Colombia: ${trends.colombia.length} | Mundo: ${trends.mundo.length}`);
  await writeFile(
    path.join(DATA_DIR, "trends.json"),
    JSON.stringify(trends, null, 2) + "\n",
  );

  console.log("Listo.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
