import { exec } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const DEFAULTS = {
  catalogs: [
    "public/catalogo-finalistas.json",
    "public/catalogo-runtime.json",
    "public/herramientas-bogota-kevin-aceptados 4.json",
    "public/reciclaje-productos.json",
    "public/productos-imagenes-unicas.json",
    "public/productos-imagenes-repetidas.json",
  ],
  minScore: 70,
  limit: 20,
  remote: true,
  remoteLimit: 20,
  timeoutMs: 15000,
};

const args = parseArgs(process.argv.slice(2));
const imageUrl = (args.image || args.url || "").trim();

if (!imageUrl) {
  console.error("Uso: npm run image:source -- --image \"https://...\"");
  process.exit(1);
}

const minScore = clampInt(args.minScore, DEFAULTS.minScore, 0, 100);
const limit = clampInt(args.limit, DEFAULTS.limit, 1, 500);
const remoteLimit = clampInt(args.remoteLimit, DEFAULTS.remoteLimit, 1, 100);
const timeoutMs = clampInt(args.timeout, DEFAULTS.timeoutMs, 2000, 120000);
const remoteEnabled = parseBool(args.remote, DEFAULTS.remote);
const openBest = parseBool(args.open, false);
const outputPath = args.out ? path.resolve(process.cwd(), args.out) : "";
const outputTxtPath = args.txt ? path.resolve(process.cwd(), args.txt) : "";

await main();

async function main() {
  const catalogs = await loadCatalogs(args.catalogs || DEFAULTS.catalogs);
  const siteGuess = detectSiteByHost(imageUrl);
  const localMatches = findLocalMatches(imageUrl, catalogs).filter((entry) => entry.score >= minScore);

  let webCandidates = [];
  if (remoteEnabled) {
    webCandidates = await findWebCandidates(imageUrl, siteGuess, { timeoutMs, limit: remoteLimit });
  }

  const reverseSearch = buildReverseSearchLinks(imageUrl);
  const bestGuess = chooseBestGuess(localMatches, webCandidates);

  const result = {
    input: imageUrl,
    site_guess: siteGuess,
    scanned_products: catalogs.length,
    min_score: minScore,
    local_matches: localMatches.slice(0, limit),
    web_candidates: webCandidates.slice(0, remoteLimit),
    best_guess: bestGuess,
    reverse_search: reverseSearch,
  };

  printSummary(result);

  if (outputPath) {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    console.log("");
    console.log(`JSON guardado en: ${outputPath}`);
  }

  if (outputTxtPath) {
    const lines = buildTxtReport(result);
    await fs.mkdir(path.dirname(outputTxtPath), { recursive: true });
    await fs.writeFile(outputTxtPath, `${lines.join("\n")}\n`, "utf8");
    console.log(`TXT guardado en: ${outputTxtPath}`);
  }

  if (openBest && bestGuess?.url) {
    openUrl(bestGuess.url);
    console.log(`Abriendo en navegador: ${bestGuess.url}`);
  } else if (openBest && reverseSearch.length) {
    openUrl(reverseSearch[0].url);
    console.log(`Abriendo busqueda inversa: ${reverseSearch[0].url}`);
  }
}

function printSummary(result) {
  console.log(`URL: ${result.input}`);
  console.log(`Sitio probable: ${result.site_guess.site}`);
  if (result.site_guess.domain) console.log(`Dominio: ${result.site_guess.domain}`);
  console.log(`Productos escaneados: ${result.scanned_products}`);
  console.log(`Coincidencias locales (score >= ${result.min_score}): ${result.local_matches.length}`);
  console.log(`Candidatos web: ${result.web_candidates.length}`);

  if (result.best_guess?.url) {
    console.log(`Mejor origen probable: ${result.best_guess.url}`);
    console.log(`Confianza: ${result.best_guess.confidence}`);
    console.log(`Metodo: ${result.best_guess.method}`);
  } else {
    console.log("No pude inferir un origen exacto. Revisa las busquedas inversas.");
  }

  if (result.local_matches.length) {
    console.log("");
    console.log("Top local:");
    result.local_matches.slice(0, 5).forEach((entry, index) => {
      console.log(`${index + 1}. score=${entry.score} | ${entry.url_producto || "-"}`);
    });
  }

  if (result.web_candidates.length) {
    console.log("");
    console.log("Top web:");
    result.web_candidates.slice(0, 5).forEach((entry, index) => {
      console.log(`${index + 1}. score=${entry.score} | ${entry.url}`);
    });
  }

  console.log("");
  console.log("Busquedas inversas:");
  result.reverse_search.forEach((entry) => {
    console.log(`- ${entry.name}: ${entry.url}`);
  });
}

async function loadCatalogs(input) {
  const files = normalizeCatalogList(input);
  const loaded = [];
  const seen = new Set();

  for (const file of files) {
    const absolute = path.resolve(process.cwd(), file);
    try {
      const raw = await fs.readFile(absolute, "utf8");
      const parsed = JSON.parse(raw);
      const items = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.productos) ? parsed.productos : [];

      items.forEach((item) => {
        if (!item || typeof item !== "object") return;
        const key = [
          item.id || "no-id",
          item.url_producto || item.url || "no-url",
          item.url_imagen_origen || "",
          Array.isArray(item.imagenes) ? item.imagenes[0] || "" : "",
        ].join("|");
        if (seen.has(key)) return;
        seen.add(key);
        loaded.push({ ...item, __catalog_file: file });
      });
    } catch {
      // No detener por archivos faltantes o JSON invalido.
    }
  }

  return loaded;
}

function normalizeCatalogList(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return value.split(",").map((entry) => entry.trim()).filter(Boolean);
  return [...DEFAULTS.catalogs];
}

function findLocalMatches(inputUrl, products) {
  const matches = [];

  products.forEach((product) => {
    const candidates = collectProductImages(product);
    if (!candidates.length) return;

    let best = null;

    candidates.forEach((candidate) => {
      const scored = scoreImageMatch(inputUrl, candidate);
      if (!best || scored.score > best.score) {
        best = scored;
      }
    });

    if (!best || best.score <= 0) return;

    matches.push({
      score: best.score,
      match_reason: best.reason,
      match_image: best.candidate,
      id: stringOrEmpty(product.id),
      referencia: stringOrEmpty(product.referencia),
      nombre: stringOrEmpty(product.nombre),
      fuente: stringOrEmpty(product.fuente),
      url_producto: stringOrEmpty(product.url_producto || product.url),
      url_imagen_origen: stringOrEmpty(product.url_imagen_origen),
      catalog_file: stringOrEmpty(product.__catalog_file),
    });
  });

  return matches.sort((a, b) => b.score - a.score);
}

function collectProductImages(product) {
  const values = [];

  addIfString(values, product.url_imagen_origen);
  addIfString(values, product.meta?.remote_image);

  if (Array.isArray(product.imagenes)) {
    product.imagenes.forEach((url) => addIfString(values, url));
  }
  if (Array.isArray(product.imagenes_origen)) {
    product.imagenes_origen.forEach((url) => addIfString(values, url));
  }

  return unique(values);
}

function scoreImageMatch(rawInput, rawCandidate) {
  const input = normalizeUrl(rawInput);
  const candidate = normalizeUrl(rawCandidate);

  if (!input || !candidate) return { score: 0, reason: "invalid", candidate: rawCandidate };

  if (input.full === candidate.full) {
    return { score: 100, reason: "exact_url", candidate: rawCandidate };
  }

  if (input.noQuery === candidate.noQuery) {
    return { score: 96, reason: "same_path_without_query", candidate: rawCandidate };
  }

  if (input.host === candidate.host && input.path === candidate.path) {
    return { score: 93, reason: "same_host_and_path", candidate: rawCandidate };
  }

  const inputMlId = extractMlId(rawInput);
  const candidateMlId = extractMlId(rawCandidate);
  if (inputMlId && candidateMlId && inputMlId === candidateMlId) {
    return { score: 90, reason: "same_ml_id", candidate: rawCandidate };
  }

  const inputAliToken = extractAliToken(rawInput);
  const candidateAliToken = extractAliToken(rawCandidate);
  if (inputAliToken && candidateAliToken && inputAliToken === candidateAliToken) {
    return { score: 88, reason: "same_alibaba_token", candidate: rawCandidate };
  }

  if (input.fileName && candidate.fileName && input.fileName === candidate.fileName) {
    return { score: 82, reason: "same_filename", candidate: rawCandidate };
  }

  if (input.host === candidate.host && input.fileName && input.fileName === candidate.fileName) {
    return { score: 86, reason: "same_host_and_filename", candidate: rawCandidate };
  }

  return { score: 0, reason: "no_match", candidate: rawCandidate };
}

async function findWebCandidates(inputUrl, siteGuess, { timeoutMs, limit }) {
  const queries = buildWebQueries(inputUrl, siteGuess).slice(0, 8);
  const candidates = [];

  for (const query of queries) {
    const urls = await searchWithBrave(query.query, timeoutMs);
    urls.forEach((url) => {
      if (!isLikelyProductUrl(url)) return;
      const scored = scoreWebCandidate(url, siteGuess, query);
      if (scored.score <= 0) return;
      candidates.push(scored);
    });
  }

  const deduped = dedupeWebCandidates(candidates);
  return deduped.sort((a, b) => b.score - a.score).slice(0, limit);
}

function buildWebQueries(inputUrl, siteGuess) {
  const normalized = normalizeUrl(inputUrl);
  const fingerprint = extractFingerprint(inputUrl);
  const queries = [];

  if (normalized?.fileName) {
    queries.push({ source: "filename", boost: 8, query: `"${normalized.fileName}"` });
  }

  queries.push({ source: "exact_image_url", boost: 10, query: `"${inputUrl}"` });

  if (fingerprint.stem) {
    queries.push({ source: "stem", boost: 12, query: `"${fingerprint.stem}"` });
  }

  if (fingerprint.mlId) {
    queries.push({ source: "ml_id", boost: 25, query: `${fingerprint.mlId} site:mercadolibre` });
  }

  if (fingerprint.aliToken) {
    queries.push({ source: "ali_token", boost: 24, query: `${fingerprint.aliToken} site:alibaba.com/product-detail` });
  }

  if (fingerprint.asin) {
    queries.push({ source: "asin", boost: 24, query: `${fingerprint.asin} site:amazon.` });
  }

  if (siteGuess.site === "Mercado Libre" && (fingerprint.mlId || fingerprint.stem)) {
    queries.push({
      source: "ml_site",
      boost: 20,
      query: `"${fingerprint.mlId || fingerprint.stem}" "mercadolibre"`,
    });
  }

  if (siteGuess.site === "Alibaba" && (fingerprint.aliToken || fingerprint.stem)) {
    queries.push({
      source: "ali_site",
      boost: 20,
      query: `"${fingerprint.aliToken || fingerprint.stem}" "alibaba" "product-detail"`,
    });
  }

  if (siteGuess.site === "Amazon" && (fingerprint.asin || fingerprint.stem)) {
    queries.push({
      source: "amazon_site",
      boost: 20,
      query: `"${fingerprint.asin || fingerprint.stem}" "amazon" "dp"`,
    });
  }

  return uniqueBy(queries, (item) => item.query.toLowerCase());
}

async function searchWithBrave(query, timeoutMs) {
  const url = `https://search.brave.com/search?q=${encodeURIComponent(query)}`;
  const html = await fetchText(url, timeoutMs);
  if (!html) return [];

  const links = [];
  const regex = /href="(https?:\/\/[^"#]+)"/gi;
  for (const match of html.matchAll(regex)) {
    const decoded = decodeHtmlEntities(match[1]);
    const safe = sanitizeFoundUrl(decoded);
    if (!safe) continue;
    links.push(safe);
  }

  return unique(links);
}

async function fetchText(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        "accept-language": "es-CO,es;q=0.9,en;q=0.8",
      },
    });
    if (!response.ok) return "";
    return await response.text();
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}

function sanitizeFoundUrl(raw) {
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    if (!/^https?:$/.test(url.protocol)) return "";
    if (host.includes("search.brave.com")) return "";
    if (host.includes("cdn.search.brave.com")) return "";
    if (host.includes("imgs.search.brave.com")) return "";
    if (host.includes("tiles.search.brave.com")) return "";
    return url.toString();
  } catch {
    return "";
  }
}

function isLikelyProductUrl(raw) {
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    const pathname = url.pathname.toLowerCase();
    if (pathname === "/" && !url.search) return false;

    if (/alibaba\.com/.test(host)) {
      return /\/product-detail\//.test(pathname);
    }

    if (/amazon\./.test(host)) {
      return /\/dp\/[a-z0-9]{10}/i.test(pathname) || /\/gp\/product\/[a-z0-9]{10}/i.test(pathname);
    }

    if (/mercadolibre\./.test(host)) {
      if (/\/p\/[a-z0-9]/i.test(pathname)) return true;
      if (/\/ml[a-z]-\d+/i.test(pathname)) return true;
      if (/\/articulo\//i.test(pathname)) return true;
      if (/\/sec\//i.test(pathname)) return false;
      if (/\/supermercado\//i.test(pathname)) return false;
      return false;
    }

    if (/facebook\.com/.test(host)) {
      return /\/marketplace\/item\//.test(pathname);
    }

    if (/aliexpress\./.test(host)) {
      return /\/item\//.test(pathname);
    }

    if (/ebay\./.test(host)) {
      return /\/itm\//.test(pathname);
    }

    if (/walmart\.|falabella\.|linio\.|coppel\./.test(host)) {
      return /product|producto|item|p\//.test(pathname);
    }

    return false;
  } catch {
    return false;
  }
}

function scoreWebCandidate(rawUrl, siteGuess, query) {
  let score = 30 + (query?.boost || 0);
  const info = normalizeUrl(rawUrl);
  if (!info) return { score: 0, url: rawUrl, reason: "invalid", query: query?.query || "" };

  const marketplace = detectSiteByHost(rawUrl);
  if (marketplace.site !== "desconocido") score += 12;
  if (marketplace.site === siteGuess.site) score += 18;

  if (/\/product-detail\//.test(info.path)) score += 28;
  if (/\/dp\/[a-z0-9]{10}/i.test(info.path)) score += 28;
  if (/\/gp\/product\/[a-z0-9]{10}/i.test(info.path)) score += 26;
  if (/\/marketplace\/item\//.test(info.path)) score += 24;
  if (/\/articulo\./.test(info.full) || /\/ml[a-z0-9-]+/i.test(info.path)) score += 24;

  const fp = extractFingerprint(rawUrl);
  if (fp.mlId && query?.query?.includes(fp.mlId)) score += 10;
  if (fp.aliToken && query?.query?.includes(fp.aliToken)) score += 10;
  if (fp.asin && query?.query?.toUpperCase()?.includes(fp.asin)) score += 10;

  if (/search|listado|category|help|support/.test(info.path)) score -= 25;

  score = Math.max(1, Math.min(99, score));
  return {
    score,
    url: rawUrl,
    site: marketplace.site,
    domain: marketplace.domain,
    reason: query?.source || "web_search",
    query: query?.query || "",
  };
}

function dedupeWebCandidates(entries) {
  const byUrl = new Map();

  entries.forEach((entry) => {
    const key = canonicalizeUrl(entry.url);
    const prev = byUrl.get(key);
    if (!prev || entry.score > prev.score) {
      byUrl.set(key, entry);
    }
  });

  return [...byUrl.values()];
}

function canonicalizeUrl(raw) {
  try {
    const url = new URL(raw);
    url.hash = "";
    return `${url.origin}${url.pathname}${url.search}`;
  } catch {
    return raw;
  }
}

function extractFingerprint(raw) {
  const normalized = normalizeUrl(raw);
  const stem = normalized?.fileName?.replace(/\.[a-z0-9]{2,5}$/i, "") || "";
  const mlId = extractMlId(raw);
  const aliToken = extractAliToken(raw);
  const asin = extractAsin(raw);
  return { stem, mlId, aliToken, asin };
}

function chooseBestGuess(localMatches, webCandidates) {
  if (localMatches.length) {
    const top = localMatches[0];
    if (top.url_producto) {
      return {
        method: "local_catalog",
        confidence: top.score >= 95 ? "alta" : "media",
        score: top.score,
        url: top.url_producto,
        details: {
          referencia: top.referencia,
          fuente: top.fuente,
          match_image: top.match_image,
          reason: top.match_reason,
        },
      };
    }
  }

  if (webCandidates.length) {
    const top = webCandidates[0];
    return {
      method: "web_search",
      confidence: top.score >= 80 ? "media" : "baja",
      score: top.score,
      url: top.url,
      details: {
        site: top.site,
        reason: top.reason,
        query: top.query,
      },
    };
  }

  return null;
}

function buildReverseSearchLinks(image) {
  const encoded = encodeURIComponent(image);
  return [
    { name: "Google Lens", url: `https://lens.google.com/uploadbyurl?url=${encoded}` },
    { name: "Bing Visual", url: `https://www.bing.com/images/search?q=imgurl:${encoded}&view=detailv2&iss=sbi` },
    { name: "Yandex Images", url: `https://yandex.com/images/search?rpt=imageview&url=${encoded}` },
    { name: "Brave Search", url: `https://search.brave.com/search?q=%22${encoded}%22` },
  ];
}

function normalizeUrl(raw) {
  try {
    const url = new URL(String(raw).trim());
    const host = url.hostname.toLowerCase();
    const pathName = url.pathname.replace(/\/+$/, "");
    const fileName = pathName.split("/").filter(Boolean).pop() || "";
    return {
      full: `${url.origin}${url.pathname}${url.search}`,
      noQuery: `${url.origin}${url.pathname}`,
      host,
      path: pathName.toLowerCase(),
      fileName: fileName.toLowerCase(),
    };
  } catch {
    return null;
  }
}

function extractMlId(raw) {
  const text = String(raw || "");
  const match = text.match(/ML[A-Z]?\d{8,14}/i);
  return match ? match[0].toUpperCase() : "";
}

function extractAliToken(raw) {
  const text = String(raw || "");
  const match = text.match(/\/([A-Za-z0-9]{24,})\.(?:png|jpe?g|webp|avif)/i);
  return match ? match[1].toLowerCase() : "";
}

function extractAsin(raw) {
  const text = String(raw || "");
  const direct = text.match(/(?:\/dp\/|\/gp\/product\/)([A-Z0-9]{10})/i);
  if (direct) return direct[1].toUpperCase();

  const fromFile = text.match(/([A-Z0-9]{10})(?:\.[a-z]{2,5})(?:$|[?#])/i);
  return fromFile ? fromFile[1].toUpperCase() : "";
}

function detectSiteByHost(rawUrl) {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    const map = [
      [/mlstatic\.com$/, "Mercado Libre"],
      [/mercadolibre\./, "Mercado Libre"],
      [/alicdn\.com$/, "Alibaba"],
      [/alibaba\./, "Alibaba"],
      [/amazon\./, "Amazon"],
      [/fbcdn\.net$/, "Facebook Marketplace"],
      [/facebook\.com$/, "Facebook Marketplace"],
      [/googleusercontent\.com$/, "Google"],
      [/gstatic\.com$/, "Google"],
      [/aliexpress\./, "AliExpress"],
      [/shopee\./, "Shopee"],
      [/ebay\./, "eBay"],
      [/walmart\./, "Walmart"],
      [/falabella\./, "Falabella"],
      [/linio\./, "Linio"],
      [/coppel\./, "Coppel"],
    ];

    const found = map.find(([regex]) => regex.test(host));
    return {
      domain: host,
      site: found ? found[1] : "desconocido",
    };
  } catch {
    return { domain: "", site: "desconocido" };
  }
}

function buildTxtReport(result) {
  const lines = [];
  lines.push(`URL: ${result.input}`);
  lines.push(`Sitio probable: ${result.site_guess.site}`);
  if (result.site_guess.domain) lines.push(`Dominio: ${result.site_guess.domain}`);
  lines.push(`Productos escaneados: ${result.scanned_products}`);
  lines.push(`Coincidencias locales (score >= ${result.min_score}): ${result.local_matches.length}`);
  lines.push(`Candidatos web: ${result.web_candidates.length}`);
  lines.push("");

  if (result.best_guess?.url) {
    lines.push(`MEJOR_ORIGEN: ${result.best_guess.url}`);
    lines.push(`CONFIANZA: ${result.best_guess.confidence}`);
    lines.push(`METODO: ${result.best_guess.method}`);
  } else {
    lines.push("MEJOR_ORIGEN: no encontrado");
  }

  lines.push("");
  lines.push("== Coincidencias Locales ==");
  lines.push("Formato: score | id | referencia | fuente | url_producto | match_image");
  result.local_matches.forEach((entry) => {
    lines.push(
      `${entry.score} | ${entry.id} | ${entry.referencia} | ${entry.fuente} | ${entry.url_producto || "-"} | ${entry.match_image}`,
    );
  });
  if (!result.local_matches.length) lines.push("Sin coincidencias locales.");

  lines.push("");
  lines.push("== Candidatos Web ==");
  lines.push("Formato: score | sitio | url | query");
  result.web_candidates.forEach((entry) => {
    lines.push(`${entry.score} | ${entry.site} | ${entry.url} | ${entry.query}`);
  });
  if (!result.web_candidates.length) lines.push("Sin candidatos web.");

  lines.push("");
  lines.push("== Busquedas Inversas ==");
  result.reverse_search.forEach((entry) => {
    lines.push(`${entry.name}: ${entry.url}`);
  });

  return lines;
}

function openUrl(url) {
  const target = String(url || "").trim();
  if (!target) return;

  const escaped = target.replace(/"/g, '\\"');

  if (process.platform === "win32") {
    exec(`start "" "${escaped}"`);
    return;
  }

  if (process.platform === "darwin") {
    exec(`open "${escaped}"`);
    return;
  }

  exec(`xdg-open "${escaped}"`);
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;

    const [rawKey, rawValue] = token.slice(2).split("=", 2);
    const key = rawKey.trim();
    const next = argv[i + 1];
    const value = rawValue ?? (next && !next.startsWith("--") ? next : "true");

    if (rawValue == null && next && !next.startsWith("--")) i += 1;
    parsed[key] = value;
  }
  return parsed;
}

function clampInt(value, fallback, min, max) {
  const num = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, num));
}

function parseBool(value, fallback) {
  if (value == null) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "si", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function addIfString(target, value) {
  if (typeof value !== "string") return;
  const trimmed = value.trim();
  if (!trimmed) return;
  target.push(trimmed);
}

function unique(values) {
  const seen = new Set();
  const out = [];
  values.forEach((value) => {
    if (seen.has(value)) return;
    seen.add(value);
    out.push(value);
  });
  return out;
}

function uniqueBy(values, getKey) {
  const seen = new Set();
  const out = [];
  values.forEach((value) => {
    const key = getKey(value);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(value);
  });
  return out;
}

function stringOrEmpty(value) {
  return typeof value === "string" ? value : "";
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}
