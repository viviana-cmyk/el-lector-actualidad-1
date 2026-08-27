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

// Descarta títulos que son fechas, referencias de calendario o demasiado cortos.
const DATE_ONLY_RE = new RegExp([
  // Fechas en español: "24 de agosto del 2026"
  /^\d{1,2}\s+de\s+\w+(\s+del?\s+\d{4})?$/,
  // Fechas en inglés: "August 24, 2026" / "August 24 2026"
  /^\w+\s+\d{1,2},?\s+\d{4}$/,
  // Numérico: 24/08/2026
  /^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}$/,
  // Patrón ICG: "Bahrain 29 July 2026 #1" (ciudad + fecha + número de serie)
  /^[A-Z][a-zA-Z\s,]+\d{1,2}\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}(\s+#\d+)?$/,
].map(r => r.source).join("|"), "i");

// Frases de relleno de feeds (páginas de autores, secciones genéricas, etc.)
const BOILERPLATE_RE = /^colaboradores?\s+de\s+(la\s+)?agenda$/i;

function looksLikeDate(title) {
  if (DATE_ONLY_RE.test(title) || BOILERPLATE_RE.test(title) || title.length < 20) return true;
  // Algunas fuentes RSS incluyen el nombre del medio: "25 de agosto del 2026 - La Razón"
  // El regex anterior falla porque espera $ tras la fecha. Probamos sin el sufijo.
  const sinFuente = title.replace(/\s*[-–]\s*[^-–\n]{1,80}$/, "").trim();
  return sinFuente !== title && DATE_ONLY_RE.test(sinFuente);
}

// Descarta ítems donde el título es el nombre genérico del sitio web (ej: "La Tercera - Noticias de Chile y el Mundo")
function looksLikeSiteTitle(title, outletName) {
  const base = outletName.replace(/\s*\(.*\)$/, "").trim();
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped}\\s*[-–|]`, "i").test(title);
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
    // Momentos / reacciones de entretenimiento
    "divertido momento", "tierno momento", "emotivo momento",
    "reacci[oó]n de ", "as[íi] reaccion[oó]", "as[íi] fue el momento",
    "cambi[aoó].*\\blook\\b", "\\blook\\b.*(impacto|sorprend|llam[oó] la atenci[oó]n)",
    "\\bde buen humor\\b", "se puso de buen humor",
    // Lifestyle / bienestar sin valor informativo
    "gozan de ", "se ponen de ", "priorizarse", "autorregulaci[oó]n emocional",
    "cambio de look", "nuevo look",
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
        if (looksLikeDate(title)) continue;
        if (looksLikeSiteTitle(title, outlet.name)) continue;
        if (feed.type === "google" && looksLikeAuthorName(title)) continue;
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
        // Re-aplicar filtros: el JSON del día anterior puede tener títulos malos
        // guardados antes de que los filtros existieran o se corrigieran.
        items = prev.items
          .filter(item => !looksLikeDate(item.title) && !looksLikeSiteTitle(item.title, outlet.name))
          .slice(0, limit);
        if (items.length > 0) {
          console.log(`  - ${outlet.name}: feed vacío, conservando día anterior (${items.length})`);
        } else {
          console.log(`  - ${outlet.name}: sin noticias disponibles`);
        }
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
      if (t.title) {
        items[i].title_en = items[i].title; // conservar título original en inglés
        items[i].title = t.title;           // reemplazar con traducción al español
      }
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
    { city: "Bogotá",       city_en: "Bogotá",        lat: 4.711,   lon: -74.0721 },
    { city: "Medellín",     city_en: "Medellín",       lat: 6.2442,  lon: -75.5812 },
    { city: "Cali",         city_en: "Cali",           lat: 3.4516,  lon: -76.532  },
    { city: "Cartagena",    city_en: "Cartagena",      lat: 10.391,  lon: -75.4794 },
    { city: "Barranquilla", city_en: "Barranquilla",   lat: 10.9685, lon: -74.7813 },
  ],
  mundo: [
    { city: "Nueva York",       city_en: "New York",    lat: 40.7128, lon: -74.006  },
    { city: "Londres",          city_en: "London",      lat: 51.5074, lon: -0.1278  },
    { city: "Madrid",           city_en: "Madrid",      lat: 40.4168, lon: -3.7038  },
    { city: "Tokio",            city_en: "Tokyo",       lat: 35.6762, lon: 139.6503 },
    { city: "Ciudad de México", city_en: "Mexico City", lat: 19.4326, lon: -99.1332 },
  ],
};

// Codigos de tiempo WMO -> { descripcion, icono }
// https://open-meteo.com/en/docs (campo weathercode)
function describeWeatherCode(code) {
  // [es, icon, en]
  const table = {
    0:  ["Despejado",                  "☀️",  "Clear sky"],
    1:  ["Mayormente despejado",       "🌤️",  "Mostly clear"],
    2:  ["Parcialmente nublado",       "⛅",  "Partly cloudy"],
    3:  ["Nublado",                    "☁️",  "Overcast"],
    45: ["Niebla",                     "🌫️",  "Foggy"],
    48: ["Niebla helada",              "🌫️",  "Icy fog"],
    51: ["Llovizna ligera",            "🌦️",  "Light drizzle"],
    53: ["Llovizna",                   "🌦️",  "Drizzle"],
    55: ["Llovizna intensa",           "🌦️",  "Heavy drizzle"],
    56: ["Llovizna helada",            "🌦️",  "Freezing drizzle"],
    57: ["Llovizna helada intensa",    "🌦️",  "Heavy freezing drizzle"],
    61: ["Lluvia ligera",              "🌧️",  "Light rain"],
    63: ["Lluvia",                     "🌧️",  "Rain"],
    65: ["Lluvia intensa",             "🌧️",  "Heavy rain"],
    66: ["Lluvia helada",              "🌧️",  "Freezing rain"],
    67: ["Lluvia helada intensa",      "🌧️",  "Heavy freezing rain"],
    71: ["Nevada ligera",              "❄️",  "Light snow"],
    73: ["Nevada",                     "❄️",  "Snow"],
    75: ["Nevada intensa",             "❄️",  "Heavy snow"],
    77: ["Granizo fino",               "❄️",  "Ice pellets"],
    80: ["Lluvias dispersas",          "🌦️",  "Scattered showers"],
    81: ["Lluvias",                    "🌦️",  "Showers"],
    82: ["Lluvias intensas",           "🌧️",  "Heavy showers"],
    85: ["Nevadas dispersas",          "🌨️",  "Scattered snow showers"],
    86: ["Nevadas intensas",           "🌨️",  "Heavy snow showers"],
    95: ["Tormenta",                   "⛈️",  "Thunderstorm"],
    96: ["Tormenta con granizo",       "⛈️",  "Thunderstorm with hail"],
    99: ["Tormenta con granizo fuerte","⛈️",  "Thunderstorm, heavy hail"],
  };
  return table[code] || ["Sin datos", "🌡️", "No data"];
}

async function fetchCityWeather({ city, city_en, lat, lon }) {
  const res = await fetch(
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true`,
    { signal: AbortSignal.timeout(15000) },
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const current = json.current_weather;
  if (!current) throw new Error("sin datos actuales");
  const [description, icon, description_en] = describeWeatherCode(current.weathercode);
  return { city, city_en: city_en ?? city, temp: Math.round(current.temperature), description, description_en, icon };
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

// Traduce al inglés los titulares que aún no tienen title_en usando DeepL.
// Si no hay clave o falla, los artículos simplemente no tendrán versión EN
// y el sitio seguirá mostrando el contenido en español en ese campo.
async function translateOutletsToEN(deepLKey, outlets) {
  if (!deepLKey) return;

  const toTranslate = [];
  const refs = [];
  for (const outlet of outlets) {
    for (const item of outlet.items) {
      if (!item.title_en) {
        toTranslate.push(item.title);
        refs.push(item);
      }
    }
  }
  if (toTranslate.length === 0) return;

  // Las claves gratuitas de DeepL terminan en :fx y usan api-free
  const baseUrl = deepLKey.endsWith(":fx")
    ? "https://api-free.deepl.com"
    : "https://api.deepl.com";

  try {
    const res = await fetch(`${baseUrl}/v2/translate`, {
      method: "POST",
      headers: {
        "Authorization": `DeepL-Auth-Key ${deepLKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: toTranslate, source_lang: "ES", target_lang: "EN-US" }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    const json = await res.json();
    json.translations.forEach((t, i) => { refs[i].title_en = t.text; });
    console.log(`  - DeepL ES→EN: ${json.translations.length} titulares traducidos`);
  } catch (err) {
    console.warn(`  [aviso] DeepL: ${err.message}`);
  }
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

  console.log("Traduciendo titulares al inglés (DeepL)...");
  const deepLKey = process.env.DEEPL_API_KEY;
  await translateOutletsToEN(deepLKey, colombia);
  await translateOutletsToEN(deepLKey, mundo);   // los medios EN ya tienen title_en; solo traduce los ES
  await translateOutletsToEN(deepLKey, latam);
  await translateOutletsToEN(deepLKey, recomendados);

  // Propagar title_en a las noticias destacadas (son copias del item original)
  function enrichFeatured(feat, outlets) {
    if (!feat) return feat;
    const all = outlets.flatMap(o => o.items || []);
    const src = all.find(i => i.link === feat.link);
    return src?.title_en ? { ...feat, title_en: src.title_en } : feat;
  }
  featuredColombia = enrichFeatured(featuredColombia, colombia);
  featuredMundo    = enrichFeatured(featuredMundo,    mundo);

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

  // Traducir día internacional al inglés con DeepL si dia_en es null
  if (deepLKey) {
    try {
      const dailyRaw = JSON.parse(await readFile(path.join(DATA_DIR, "dailyinfo.json"), "utf-8"));
      if (dailyRaw.dia && !dailyRaw.dia_en) {
        const baseUrl = deepLKey.endsWith(":fx") ? "https://api-free.deepl.com" : "https://api.deepl.com";
        const res = await fetch(`${baseUrl}/v2/translate`, {
          method: "POST",
          headers: { "Authorization": `DeepL-Auth-Key ${deepLKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ text: [dailyRaw.dia.nombre, dailyRaw.dia.descripcion], source_lang: "ES", target_lang: "EN-US" }),
          signal: AbortSignal.timeout(15000),
        });
        if (res.ok) {
          const json = await res.json();
          dailyRaw.dia_en = { nombre: json.translations[0].text, descripcion: json.translations[1].text };
          await writeFile(path.join(DATA_DIR, "dailyinfo.json"), JSON.stringify(dailyRaw, null, 2) + "\n");
          console.log(`  - DeepL: día internacional traducido al inglés`);
        }
      }
    } catch (err) {
      console.warn(`  [aviso] DeepL día internacional: ${err.message}`);
    }
  }

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
