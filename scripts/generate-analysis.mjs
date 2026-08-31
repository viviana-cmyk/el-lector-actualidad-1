// Genera la seccion "Analisis" (Colombia / Mundo) usando la API de Anthropic,
// a partir de los titulares ya descargados por fetch-news.mjs. Si no hay
// ANTHROPIC_API_KEY configurada, o la llamada falla, se conserva el archivo
// anterior (o se escribe un texto de aviso si nunca se ha generado nada).

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "src", "data");
const MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001";

const SECTIONS = {
  colombia: {
    file: "news-colombia.json",
    intro: "Lectura cruzada desde lo político, social, económico y cultural.",
    intro_en: "Cross-reading from political, social, economic and cultural angles.",
    categories: ["Política", "Económica", "Social", "Cultural"],
    categories_en: ["Politics", "Economics", "Social", "Culture"],
    label: "Colombia",
    label_en: "Colombia",
  },
  mundo: {
    file: "news-mundo.json",
    intro: "Geopolítica, economía global, sociedad y tecnología en diálogo.",
    intro_en: "Geopolitics, global economy, society and technology in dialogue.",
    categories: ["Geopolítica", "Económica", "Tecnológica", "Social"],
    categories_en: ["Geopolitics", "Economics", "Technology", "Social"],
    label: "el resto del mundo",
    label_en: "the rest of the world",
  },
  seguridad: {
    file: "news-colombia.json",
    extraFile: "news-mundo.json",
    intro: "Crimen, conflicto y seguridad: análisis transversal Colombia–mundo.",
    intro_en: "Crime, conflict and security: cross-analysis Colombia–world.",
    categories: ["Crimen organizado", "Conflictos y violencia", "Justicia y Estado", "Amenazas globales"],
    categories_en: ["Organized Crime", "Conflicts & Violence", "Justice & State", "Global Threats"],
    label: "la seguridad en Colombia y el mundo",
    label_en: "security in Colombia and the world",
  },
};

function placeholderItems(categories, message) {
  return categories.map((category) => ({ category, text: message }));
}

async function readJson(file) {
  return JSON.parse(await readFile(path.join(DATA_DIR, file), "utf-8"));
}

function buildHeadlinesList(outlets, limit = 6) {
  const lines = [];
  for (const outlet of outlets) {
    for (const item of outlet.items.slice(0, limit)) {
      lines.push(`- (${outlet.name}) ${item.title}`);
    }
  }
  return lines.join("\n");
}

function extractJson(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("la respuesta no contiene JSON");
  return JSON.parse(match[0]);
}

async function generateSection(client, key) {
  const { file, extraFile, intro, categories, label } = SECTIONS[key];
  const news = await readJson(file);
  let headlines = buildHeadlinesList(news.outlets);
  if (extraFile) {
    const extra = await readJson(extraFile);
    headlines += "\n" + buildHeadlinesList(extra.outlets);
  }

  const categoryList = categories.map((c) => `"${c}"`).join(", ");
  const prompt = `Eres un analista experto que escribe para "El LECTOR", un boletín de noticias sin ánimo de lucro sobre seguridad, justicia y paz.

A partir de los titulares recientes sobre ${label}, escribe un análisis cruzado organizado en estas categorías exactas: ${categoryList}.

Titulares:
${headlines}

Instrucciones de fondo y estilo:
- Postura estrictamente neutral y objetiva. No emitas juicios de valor, opiniones personales ni conclusiones subjetivas. Cíñete a hechos observables, evidencia disponible en los titulares y análisis técnico.
- Escritura natural y fluida, al estilo de un analista humano experto. Evita estructuras repetitivas, frases genéricas o lenguaje que suene a texto generado por IA ("es importante destacar", "en este contexto", "cabe señalar", "sin lugar a dudas", "en definitiva", etc.). No uses el guión largo (—) en ninguna parte del texto.
- Para cada categoría: 2 a 4 oraciones en español, conectando los titulares relevantes con su contexto o posibles implicaciones sin ir más allá de lo que los datos permiten inferir.
- Si una categoría no tiene titulares directamente relacionados, ofrece una observación breve y factual sobre esa dimensión en el panorama actual.
- No inventes datos, cifras ni fuentes que no estén en los titulares.
- Excluye completamente estos tipos de contenido aunque aparezcan en los titulares: rumores o especulaciones sin verificación, vida privada de celebridades o influencers (relaciones, familia, hábitos personales), apariencia o cambios físicos de personas públicas, conflictos personales entre famosos, "drama" o "beef" en redes sociales, información de fuentes anónimas, historias de infidelidades o romances.

Responde ÚNICAMENTE con un objeto JSON con esta forma exacta, sin texto adicional ni bloques de código:
{"items": [{"category": "<categoría>", "text": "<análisis>"}, ...]}`;

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    messages: [{ role: "user", content: prompt }],
  });

  const text = response.content.find((block) => block.type === "text")?.text || "";
  const parsed = extractJson(text);
  if (!Array.isArray(parsed.items) || parsed.items.length === 0) {
    throw new Error("respuesta sin 'items'");
  }
  return { intro, items: parsed.items };
}

async function generateSectionEN(client, key) {
  const { file, extraFile, intro_en, categories_en, label_en } = SECTIONS[key];
  const news = await readJson(file);
  let headlines = buildHeadlinesList(news.outlets);
  if (extraFile) {
    const extra = await readJson(extraFile);
    headlines += "\n" + buildHeadlinesList(extra.outlets);
  }

  const categoryList = categories_en.map((c) => `"${c}"`).join(", ");
  const prompt = `You are an expert analyst writing for "El LECTOR", a non-profit news bulletin on security, justice and peace.

Based on the following recent headlines about ${label_en}, write a cross-cutting analysis in English organized in these exact categories: ${categoryList}.

Headlines (from Spanish and international media):
${headlines}

Style guidelines:
- Strictly neutral and objective. No value judgments or subjective conclusions.
- Natural, fluent writing. Avoid repetitive structures or AI-sounding phrases ("it is worth noting", "in this context", "without a doubt", etc.). Do not use em dashes.
- For each category: 2 to 4 sentences in English connecting relevant headlines with context or possible implications.
- If a category has no directly related headlines, offer a brief factual observation.
- Do not invent data, figures or sources not present in the headlines.

Respond ONLY with a JSON object in this exact form, no additional text or code blocks:
{"items": [{"category": "<category>", "text": "<analysis>"}, ...]}`;

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    messages: [{ role: "user", content: prompt }],
  });

  const text = response.content.find((block) => block.type === "text")?.text || "";
  const parsed = extractJson(text);
  if (!Array.isArray(parsed.items) || parsed.items.length === 0) {
    throw new Error("response without 'items'");
  }
  return { intro: intro_en, items: parsed.items };
}

async function generateTrends(client, headlinesColombia, headlinesMundo) {
  const prompt = `Eres el editor de El LECTOR, boletín de noticias sobre política, seguridad, justicia y economía.

A partir de estos titulares priorizados del día, genera el Top 5 de tendencias para X (Twitter) y TikTok en Colombia y en el Mundo. Las tendencias deben:
- Estar directamente relacionadas con los temas ALTA (política, seguridad, economía, geopolítica, ciencia, crisis)
- Ser hashtags concisos y reales (sin inventar eventos que no aparezcan en los titulares)
- Reflejar el estilo de cada red: X más informativo/analítico, TikTok más directo y viral

Titulares Colombia:
${headlinesColombia}

Titulares Mundo:
${headlinesMundo}

Responde ÚNICAMENTE con este JSON exacto, sin texto adicional:
{
  "x": {
    "colombia": ["#Tag1","#Tag2","#Tag3","#Tag4","#Tag5"],
    "mundo": ["#Tag1","#Tag2","#Tag3","#Tag4","#Tag5"]
  },
  "tiktok": {
    "colombia": ["#Tag1","#Tag2","#Tag3","#Tag4","#Tag5"],
    "mundo": ["#Tag1","#Tag2","#Tag3","#Tag4","#Tag5"]
  }
}`;

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 512,
    messages: [{ role: "user", content: prompt }],
  });
  const text = response.content.find(b => b.type === "text")?.text || "";
  return extractJson(text);
}

async function generateDailyInfo(client, dateStr) {
  const prompt = `Hoy es ${dateStr}. Busca UNA conmemoración relevante para esta fecha exacta, en este orden de preferencia:

1. Día internacional oficial de la ONU, UNESCO, OMS u organismo internacional (fecha fija o regla exacta como "primer sábado de julio").
2. Efeméride histórica importante (aniversario de un evento mundial o latinoamericano relevante).
3. Día nacional significativo de algún país (independencia, fundación, etc.).
4. Conmemoración cultural, científica o social de relevancia global.

Reglas:
- La fecha debe coincidir EXACTAMENTE con hoy. No aproximes.
- No inventes datos. Si no encuentras nada verificable para esta fecha, responde null.
- Prefiere conmemoraciones con impacto en Colombia o Latinoamérica cuando haya opciones.

Responde con este JSON exacto (sin texto adicional):
{"nombre":"<nombre completo en español>","descripcion":"<1 oración en español, máximo 180 caracteres, explicando qué se conmemora y por qué importa>"}

Si no hay nada verificable para esta fecha exacta, responde: null`;

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 256,
    messages: [{ role: "user", content: prompt }],
  });
  const text = (response.content.find(b => b.type === "text")?.text || "").trim();
  if (text === "null" || text === "") return null;
  try {
    const match = text.match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : null;
  } catch { return null; }
}


async function generateDailyInfoEN(client, diaES) {
  if (!diaES) return null;
  const prompt = `Translate ONLY the values (not the keys) of this JSON from Spanish to English.
Return ONLY valid JSON with exactly these two keys: "nombre" and "descripcion".

Input: ${JSON.stringify(diaES)}

Output (keys must be "nombre" and "descripcion", values in English):`;

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 256,
    messages: [{ role: "user", content: prompt }],
  });
  const text = (response.content.find(b => b.type === "text")?.text || "").trim();
  if (!text) return null;
  try {
    const match = text.match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : null;
  } catch { return null; }
}

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const generatedAt = new Date().toISOString();

  let previous = null;
  try {
    previous = await readJson("analisis.json");
  } catch {
    // primera ejecucion: no hay datos previos
  }

  const result = { generatedAt, colombia: null, mundo: null, seguridad: null };

  if (!apiKey) {
    console.warn(
      "  [aviso] ANTHROPIC_API_KEY no configurada: se omite la generación de Análisis.",
    );
  }

  for (const key of Object.keys(SECTIONS)) {
    const { intro, intro_en, categories, categories_en } = SECTIONS[key];
    if (!apiKey) {
      result[key] = previous?.[key] || {
        intro,
        items: placeholderItems(categories, "Análisis pendiente: configura ANTHROPIC_API_KEY."),
      };
      result[`${key}_en`] = previous?.[`${key}_en`] || {
        intro: intro_en,
        items: placeholderItems(categories_en, "Analysis pending: configure ANTHROPIC_API_KEY."),
      };
      continue;
    }

    try {
      const client = new Anthropic({ apiKey });
      result[key] = await generateSection(client, key);
      console.log(`  - Análisis ${key}: generado`);
    } catch (err) {
      console.warn(`  [aviso] Análisis ${key}: ${err.message}`);
      result[key] = previous?.[key] || {
        intro,
        items: placeholderItems(categories, "No se pudo generar el análisis de hoy."),
      };
    }

    try {
      const client = new Anthropic({ apiKey });
      result[`${key}_en`] = await generateSectionEN(client, key);
      console.log(`  - Analysis EN ${key}: generated`);
    } catch (err) {
      console.warn(`  [warning] Analysis EN ${key}: ${err.message}`);
      result[`${key}_en`] = previous?.[`${key}_en`] || {
        intro: intro_en,
        items: placeholderItems(categories_en, "Could not generate today's analysis."),
      };
    }
  }

  await writeFile(
    path.join(DATA_DIR, "analisis.json"),
    JSON.stringify(result, null, 2) + "\n",
  );

  // Día internacional del día
  if (apiKey) {
    try {
      const client = new Anthropic({ apiKey });
      const dateStr = new Date().toLocaleDateString("es-CO", { day:"numeric", month:"long", year:"numeric", timeZone:"America/Bogota" });
      const diaInfo = await generateDailyInfo(client, dateStr);
      const diaInfoEN = await generateDailyInfoEN(client, diaInfo);
      await writeFile(
        path.join(DATA_DIR, "dailyinfo.json"),
        JSON.stringify({ generatedAt, dia: diaInfo, dia_en: diaInfoEN }, null, 2) + "\n",
      );
      console.log(`  - Día internacional: ${diaInfo ? diaInfo.nombre : "ninguno hoy"}`);
    } catch (err) {
      console.warn(`  [aviso] Día internacional: ${err.message}`);
    }
  }

  // Generar TOP 3 Tensiones Globales
  if (apiKey) {
    let prevTensiones = null;
    try { prevTensiones = await readJson("tensiones.json"); } catch { /* ok */ }
    try {
      const newsMU = await readJson("news-mundo.json");
      // Máximo 30 titulares para mantener el prompt conciso y confiable
      const lineas = [];
      for (const o of newsMU.outlets) {
        for (const item of (o.items || []).slice(0, 4)) {
          lineas.push(`[${o.name}] ${item.title} >>> ${item.link}`);
          if (lineas.length >= 30) break;
        }
        if (lineas.length >= 30) break;
      }
      const lista = lineas.join("\n");
      const client = new Anthropic({ apiKey });
      const prompt = `Eres analista geopolítico de "El LECTOR". A partir de estos titulares de hoy identifica el TOP 3 de tensiones o conflictos globales más relevantes.

Titulares (formato [Fuente] Titular >>> URL):
${lista}

Para cada tensión:
1. Nombre preciso del conflicto o tensión (en español e inglés).
2. Región geográfica.
3. El titular de la lista más relacionado (si hay uno; si no, pon "noticia": null).
4. Análisis en español: 2 oraciones. Contexto actual + posibles implicaciones geopolíticas. Neutro, sin lenguaje genérico de IA.
5. Analysis in English: same content translated to English (2 sentences, same neutral tone).

Responde SOLO con este JSON (sin texto extra, sin bloques de código):
{"tensiones":[{"rank":1,"titulo":"...","titulo_en":"...","region":"...","noticia":{"titulo":"...","link":"...","fuente":"..."},"analisis":"...","analisis_en":"..."},{"rank":2,...},{"rank":3,...}]}`;

      const res = await client.messages.create({
        model: MODEL, max_tokens: 1200,
        messages: [{ role: "user", content: prompt }],
      });
      const txt = res.content.find(b => b.type === "text")?.text || "";
      const match = txt.match(/\{[\s\S]*\}/);
      if (!match) throw new Error("respuesta sin JSON");
      const parsed = JSON.parse(match[0]);
      if (!Array.isArray(parsed.tensiones) || parsed.tensiones.length === 0) throw new Error("tensiones vacías");
      await writeFile(
        path.join(DATA_DIR, "tensiones.json"),
        JSON.stringify({ generatedAt, tensiones: parsed.tensiones }, null, 2) + "\n",
      );
      console.log("  - Tensiones globales: generadas");
    } catch (err) {
      console.warn(`  [aviso] Tensiones: ${err.message}`);
      if (prevTensiones) {
        await writeFile(path.join(DATA_DIR, "tensiones.json"), JSON.stringify(prevTensiones, null, 2) + "\n");
      }
    }
  }

  // Generar tendencias de X y TikTok con IA
  let prevTrends = null;
  try { prevTrends = await readJson("trends.json"); } catch { /* ok */ }

  if (apiKey) {
    try {
      const newsCO = await readJson("news-colombia.json");
      const newsMU = await readJson("news-mundo.json");
      const hCO = buildHeadlinesList(newsCO.outlets, 4);
      const hMU = buildHeadlinesList(newsMU.outlets, 4);
      const client = new Anthropic({ apiKey });
      const trends = await generateTrends(client, hCO, hMU);
      trends.generatedAt = generatedAt;
      await writeFile(
        path.join(DATA_DIR, "trends.json"),
        JSON.stringify(trends, null, 2) + "\n",
      );
      console.log("  - Tendencias X y TikTok: generadas");
    } catch (err) {
      console.warn(`  [aviso] Tendencias: ${err.message}`);
      if (prevTrends) await writeFile(path.join(DATA_DIR, "trends.json"), JSON.stringify(prevTrends, null, 2) + "\n");
    }
  }


  console.log("Listo.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
