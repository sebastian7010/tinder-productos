import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const DEFAULTS = {
  input: "productos12k.json",
  output: "public/reciclaje-productos.json",
  cache: "jsons/product-image-cache.json",
  imageDir: "public/product-images",
  concurrency: 6,
  timeoutMs: 15000,
  limit: 0,
};

const STOPWORDS = new Set([
  "para", "con", "sin", "por", "del", "los", "las", "the", "and", "for", "from", "una", "uno", "que",
  "this", "that", "tool", "tools", "producto", "product", "home", "hogar", "amazon", "com", "sale",
]);

const args = parseArgs(process.argv.slice(2));
const options = {
  input: path.resolve(process.cwd(), args.input || DEFAULTS.input),
  output: path.resolve(process.cwd(), args.output || DEFAULTS.output),
  cache: path.resolve(process.cwd(), args.cache || DEFAULTS.cache),
  imageDir: path.resolve(process.cwd(), args.imageDir || DEFAULTS.imageDir),
  concurrency: clampNumber(args.concurrency, DEFAULTS.concurrency, 1, 32),
  timeoutMs: clampNumber(args.timeout, DEFAULTS.timeoutMs, 1000, 120000),
  limit: clampNumber(args.limit, DEFAULTS.limit, 0, Number.MAX_SAFE_INTEGER),
};

await main();

async function main() {
  const rawInput = JSON.parse(await fs.readFile(options.input, "utf8"));
  const flatItems = flattenInput(rawInput);
  const selectedItems = options.limit > 0 ? flatItems.slice(0, options.limit) : flatItems;
  const cache = await readCache(options.cache);
  const referenceFallbackCache = getReferenceFallbackCache(cache);
  const downloadCache = getDownloadCache(cache);

  console.log(`Entradas: ${flatItems.length}`);
  console.log(`Procesando: ${selectedItems.length}`);
  console.log(`Concurrencia: ${options.concurrency}`);

  let processed = 0;
  let withImages = 0;

  const catalog = await mapWithConcurrency(selectedItems, options.concurrency, async (item) => {
    const resolved = await resolveItem(item, cache);
    processed += 1;
    if (resolved.imagenes.length) withImages += 1;

    if (processed === 1 || processed % 25 === 0 || processed === selectedItems.length) {
      console.log(`[${processed}/${selectedItems.length}] ${withImages} con imagen`);
    }

    return {
      id: makeId(item),
      referencia: item.reference,
      fuente: item.source,
      url: item.url,
      url_producto: item.url,
      url_imagen_origen: resolved.imagenes[0] || "",
      nombre: resolved.title || item.reference,
      descripcion: `${item.reference} | ${item.source}`,
      imagenes: resolved.imagenes,
      imagenes_origen: [...resolved.imagenes],
      meta: {
        status: resolved.status,
        blocked: resolved.blocked,
        fetched_url: resolved.finalUrl,
        image_source: resolved.imagenes.length ? "self" : "none",
      },
    };
  });

  const fallbackStats = await applyReferenceFallbacks(catalog, referenceFallbackCache);
  const mirrorStats = await mirrorPrimaryImages(catalog, downloadCache);

  await fs.mkdir(path.dirname(options.output), { recursive: true });
  await fs.writeFile(options.output, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");

  await fs.mkdir(path.dirname(options.cache), { recursive: true });
  await fs.writeFile(options.cache, `${JSON.stringify(cache, null, 2)}\n`, "utf8");

  console.log(`Listo: ${withImages}/${catalog.length} con imagen`);
  console.log(`Fallback por referencia: ${fallbackStats.reference}`);
  console.log(`Fallback por busqueda: ${fallbackStats.search}`);
  console.log(`Imagen local: ${mirrorStats.local}`);
  console.log(`Siguen remotas: ${mirrorStats.remote}`);
  console.log(`Salida: ${options.output}`);
  console.log(`Cache: ${options.cache}`);
}

function parseArgs(argv) {
  const parsed = {};

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;

    const [rawKey, rawValue] = token.slice(2).split("=", 2);
    const key = rawKey.trim();
    const value = rawValue ?? argv[i + 1];

    if (rawValue == null && argv[i + 1] && !argv[i + 1].startsWith("--")) {
      i += 1;
    }

    parsed[key] = value ?? "true";
  }

  return parsed;
}

function clampNumber(value, fallback, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, numeric));
}

function flattenInput(rawInput) {
  const groups = Array.isArray(rawInput)
    ? rawInput
    : Array.isArray(rawInput?.productos)
      ? rawInput.productos
      : [];

  const seen = new Set();
  const items = [];

  groups.forEach((group, groupIndex) => {
    const reference = normalizeText(group?.referencia) || `Referencia ${groupIndex + 1}`;

    for (const [source, entries] of Object.entries(group || {})) {
      if (source === "referencia" || !Array.isArray(entries)) continue;

      entries.forEach((entry) => {
        const url = normalizeUrlValue(entry);
        if (!url) return;

        const dedupeKey = `${reference}|${source}|${url}`;
        if (seen.has(dedupeKey)) return;

        seen.add(dedupeKey);
        items.push({ reference, source, url });
      });
    }
  });

  return items;
}

function normalizeUrlValue(entry) {
  if (typeof entry === "string") {
    const trimmed = entry.trim();
    return trimmed || "";
  }

  if (entry && typeof entry === "object") {
    const raw = typeof entry.url === "string" ? entry.url : typeof entry.link === "string" ? entry.link : "";
    return raw.trim();
  }

  return "";
}

function normalizeText(value) {
  if (typeof value !== "string") return "";
  return decodeHtmlEntities(value).replace(/\s+/g, " ").trim();
}

function getReferenceFallbackCache(cache) {
  if (!cache.__reference_fallback__ || typeof cache.__reference_fallback__ !== "object") {
    cache.__reference_fallback__ = {};
  }

  return cache.__reference_fallback__;
}

function getDownloadCache(cache) {
  if (!cache.__download_cache__ || typeof cache.__download_cache__ !== "object") {
    cache.__download_cache__ = {};
  }

  return cache.__download_cache__;
}

function makeId(item) {
  const digest = createHash("sha1").update(`${item.reference}|${item.source}|${item.url}`).digest("hex");
  return `p_${digest.slice(0, 16)}`;
}

async function applyReferenceFallbacks(catalog, referenceFallbackCache) {
  const byReference = new Map();

  catalog.forEach((item) => {
    const bucket = byReference.get(item.referencia) || [];
    bucket.push(item);
    byReference.set(item.referencia, bucket);
  });

  let referenceFallbacks = 0;
  let searchFallbacks = 0;

  for (const [reference, items] of byReference.entries()) {
    const trustedSeedImages = uniqueUrls(
      items
        .filter((item) => canSeedReferencePool(item, reference))
        .flatMap((item) => item.imagenes),
    );
    const anySeedImages = uniqueUrls(
      items
        .filter((item) => item.imagenes.length)
        .flatMap((item) => item.imagenes),
    );

    let fallbackImages = trustedSeedImages.length ? trustedSeedImages : anySeedImages;
    let fallbackType = trustedSeedImages.length ? "reference" : anySeedImages.length ? "reference_any" : "reference";

    if (!fallbackImages.length) {
      fallbackImages = await resolveReferenceFallback(reference, referenceFallbackCache);
      fallbackType = fallbackImages.length ? "search" : "none";
    }

    if (!fallbackImages.length) continue;

    items.forEach((item, idx) => {
      const shouldReplace = !item.imagenes.length || shouldReplaceWithReference(item, reference, trustedSeedImages.length > 0);
      if (!shouldReplace) return;

      const selected = selectReferenceImage(fallbackImages, idx);
      if (!selected) return;

      item.imagenes = [selected];
      item.imagenes_origen = [selected];
      item.url_imagen_origen = selected;
      item.meta.image_source = fallbackType === "search" ? "search_fallback" : "reference_fallback";

      if (fallbackType === "search") searchFallbacks += 1;
      else referenceFallbacks += 1;
    });
  }

  return { reference: referenceFallbacks, search: searchFallbacks };
}

async function resolveReferenceFallback(reference, referenceFallbackCache) {
  if (Array.isArray(referenceFallbackCache[reference])) {
    return referenceFallbackCache[reference];
  }

  const images = await searchFallbackImages(reference);
  referenceFallbackCache[reference] = images;
  return images;
}

async function mirrorPrimaryImages(catalog, downloadCache) {
  await fs.mkdir(options.imageDir, { recursive: true });

  await mapWithConcurrency(catalog, options.concurrency, async (item) => {
    const localPath = await ensureLocalImage(item.imagenes, downloadCache);

    if (localPath) {
      applyLocalImage(item, localPath);
    }

    return null;
  });

  const localByReference = new Map();
  catalog.forEach((item) => {
    if (!item.meta?.local_image) return;
    const bucket = localByReference.get(item.referencia) || [];
    if (!bucket.includes(item.meta.local_image)) bucket.push(item.meta.local_image);
    localByReference.set(item.referencia, bucket);
  });

  catalog.forEach((item, idx) => {
    if (item.meta?.local_image) return;
    const fallbackLocal = selectReferenceImage(localByReference.get(item.referencia) || [], idx);
    if (!fallbackLocal) return;

    item.meta.image_origin = item.meta.image_source;
    item.meta.image_source = "local_reference_fallback";
    item.meta.local_image = fallbackLocal;
    item.meta.remote_image = item.url_imagen_origen || item.imagenes_origen?.[0] || "";
    item.imagenes = [fallbackLocal];
  });

  let local = 0;
  let remote = 0;

  catalog.forEach((item) => {
    if (item.meta?.local_image) local += 1;
    else remote += 1;
  });

  return { local, remote };
}

async function ensureLocalImage(candidates, downloadCache) {
  if (!Array.isArray(candidates) || !candidates.length) return null;

  for (const candidate of candidates) {
    const cached = await readDownloadedPath(candidate, downloadCache);
    if (cached) return cached;

    const downloaded = await downloadImageToLocal(candidate);
    if (downloaded) {
      downloadCache[candidate] = downloaded;
      return downloaded;
    }
  }

  return null;
}

async function readDownloadedPath(candidate, downloadCache) {
  const cached = downloadCache[candidate];
  if (!cached || typeof cached !== "string") return null;

  const filePath = path.join(options.imageDir, path.basename(cached));

  try {
    await fs.access(filePath);
    return cached;
  } catch {
    return null;
  }
}

function applyLocalImage(item, localPath) {
  item.meta.image_origin = item.meta.image_source;
  item.meta.local_image = localPath;
  item.meta.remote_image = item.url_imagen_origen || item.imagenes_origen?.[0] || "";
  item.meta.image_source = "local_mirror";
  item.imagenes = [localPath];
}

function canSeedReferencePool(item, reference) {
  if (!Array.isArray(item.imagenes) || !item.imagenes.length) return false;
  if (isInvalidLikeTitle(item.nombre)) return false;
  if (isLowConfidenceSource(item.fuente)) return false;
  return semanticMatchScore(reference, item.nombre) >= 0.6;
}

function shouldReplaceWithReference(item, reference, hasTrustedPool) {
  if (!Array.isArray(item.imagenes) || !item.imagenes.length) return true;
  if (isInvalidLikeTitle(item.nombre)) return true;

  const weakMatch = semanticMatchScore(reference, item.nombre) < 0.6;
  if (!hasTrustedPool) return false;

  return isLowConfidenceSource(item.fuente) || weakMatch;
}

function isLowConfidenceSource(source) {
  return /^(google|google_imagenes|google_shopping)$/i.test(`${source || ""}`);
}

function isInvalidLikeTitle(value) {
  return /^(error|not found|page not found|product not available|access denied|forbidden|bad request)$/i.test(
    `${value || ""}`.trim(),
  );
}

function semanticMatchScore(reference, title) {
  const referenceTokens = tokenizeForMatch(reference);
  if (!referenceTokens.length) return 1;

  const titleSet = new Set(tokenizeForMatch(title));
  if (!titleSet.size) return 0;

  let matches = 0;
  referenceTokens.forEach((token) => {
    if (titleSet.has(token)) matches += 1;
  });

  return matches / referenceTokens.length;
}

function tokenizeForMatch(text) {
  return normalizeText(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((token) => token.length >= 3 && !STOPWORDS.has(token));
}

function selectReferenceImage(images, indexSeed) {
  if (!Array.isArray(images) || !images.length) return null;
  return images[indexSeed % images.length];
}

async function readCache(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function resolveItem(item, cache) {
  if (cache[item.url]) {
    return cache[item.url];
  }

  const directImage = extractImageFromUrl(item.url);
  if (directImage) {
    const cached = {
      title: item.reference,
      imagenes: [directImage],
      status: "direct",
      blocked: false,
      finalUrl: item.url,
    };
    cache[item.url] = cached;
    return cached;
  }

  const result = await fetchAndExtract(item);
  cache[item.url] = result;
  return result;
}

async function fetchAndExtract(item) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);

  try {
    const response = await fetch(item.url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        "accept-language": "es-CO,es;q=0.9,en;q=0.8",
      },
    });

    const finalUrl = response.url || item.url;
    const contentType = `${response.headers.get("content-type") || ""}`.toLowerCase();

    if (contentType.startsWith("image/")) {
      return {
        title: item.reference,
        imagenes: [finalUrl],
        status: `image:${response.status}`,
        blocked: false,
        finalUrl,
      };
    }

    const html = await response.text();
    const title = extractTitle(html) || item.reference;
    const imagenes = isInvalidLikeTitle(title) ? [] : extractImageCandidates(html, finalUrl);
    const blocked = /requires javascript to work|access denied|captcha|forbidden/i.test(html);

    return {
      title,
      imagenes,
      status: `html:${response.status}`,
      blocked,
      finalUrl,
    };
  } catch (error) {
    return {
      title: item.reference,
      imagenes: [],
      status: error?.name === "AbortError" ? "timeout" : "error",
      blocked: false,
      finalUrl: item.url,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function extractTitle(html) {
  const metaTitle = firstMatch(
    html,
    /<meta[^>]+(?:property|name)=["']og:title["'][^>]+content=["']([^"']+)["'][^>]*>/i,
  ) || firstMatch(
    html,
    /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']og:title["'][^>]*>/i,
  );

  const pageTitle = metaTitle || firstMatch(html, /<title[^>]*>([\s\S]*?)<\/title>/i);
  return normalizeText(pageTitle || "");
}

function extractImageCandidates(html, baseUrl) {
  const candidates = [];

  pushMatches(candidates, html, /data-old-hires=["']([^"']+)["']/gi, baseUrl);
  pushMatches(candidates, html, /data-a-dynamic-image=["']\{\\?"([^"\\]+)\\?":/gi, baseUrl);
  pushMatches(candidates, html, /<meta[^>]+(?:property|name|itemprop)=["']og:image(?::url)?["'][^>]+content=["']([^"']+)["'][^>]*>/gi, baseUrl);
  pushMatches(candidates, html, /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name|itemprop)=["']og:image(?::url)?["'][^>]*>/gi, baseUrl);
  pushMatches(candidates, html, /<meta[^>]+(?:property|name)=["']twitter:image(?::src)?["'][^>]+content=["']([^"']+)["'][^>]*>/gi, baseUrl);
  pushMatches(candidates, html, /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']twitter:image(?::src)?["'][^>]*>/gi, baseUrl);
  pushMatches(candidates, html, /<link[^>]+rel=["']image_src["'][^>]+href=["']([^"']+)["'][^>]*>/gi, baseUrl);
  pushMatches(candidates, html, /<link[^>]+href=["']([^"']+)["'][^>]+rel=["']image_src["'][^>]*>/gi, baseUrl);

  const jsonLdBlocks = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  jsonLdBlocks.forEach((match) => {
    const payload = match[1]?.trim();
    if (!payload) return;

    try {
      const parsed = JSON.parse(payload);
      const jsonImages = [];
      collectImagesFromJson(parsed, jsonImages);
      jsonImages.forEach((imageUrl) => {
        const normalized = toAbsoluteUrl(imageUrl, baseUrl);
        if (normalized) candidates.push(normalized);
      });
    } catch {
      // Algunos sitios insertan JSON invalido; seguimos con otras estrategias.
    }
  });

  pushMatches(candidates, html, /"(?:image|imageUrl|contentUrl|thumbnailUrl)"\s*:\s*"([^"]+)"/gi, baseUrl);
  pushMatches(candidates, html, /<img[^>]+(?:src|data-src|data-zoom-image|data-lazy-src)=["']([^"']+)["'][^>]*>/gi, baseUrl);

  return prioritizeImageUrls(uniqueUrls(candidates).filter(isUsableImageUrl)).slice(0, 4);
}

function collectImagesFromJson(value, output) {
  if (!value) return;

  if (typeof value === "string") {
    output.push(value);
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((entry) => collectImagesFromJson(entry, output));
    return;
  }

  if (typeof value === "object") {
    if ("image" in value) collectImagesFromJson(value.image, output);
    if ("imageUrl" in value) collectImagesFromJson(value.imageUrl, output);
    if ("contentUrl" in value) collectImagesFromJson(value.contentUrl, output);
    if ("thumbnailUrl" in value) collectImagesFromJson(value.thumbnailUrl, output);
  }
}

function extractImageFromUrl(rawUrl) {
  const absolute = toAbsoluteUrl(rawUrl, rawUrl);
  if (!absolute) return null;

  if (looksLikeImageAsset(absolute)) {
    return absolute;
  }

  try {
    const url = new URL(absolute);
    const queryKeys = ["imgurl", "mediaurl", "image_url", "image", "img"];
    for (const key of queryKeys) {
      const candidate = url.searchParams.get(key);
      const normalized = toAbsoluteUrl(candidate, absolute);
      if (normalized && isUsableImageUrl(normalized, true)) {
        return normalized;
      }
    }
  } catch {
    return null;
  }

  return null;
}

function looksLikeImageAsset(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return /\.(avif|gif|jpe?g|png|svg|webp)(?:$|[?#])/i.test(url.pathname);
  } catch {
    return false;
  }
}

function isUsableImageUrl(rawUrl, allowExtensionless = false) {
  if (!rawUrl || rawUrl.startsWith("data:")) return false;
  if (/logo|sprite|icon|avatar|placeholder|favicon/i.test(rawUrl)) return false;

  try {
    const url = new URL(rawUrl);
    if (!/^https?:$/i.test(url.protocol)) return false;
    if (/\.(mp4|webm|mov|avi|m3u8)(?:$|[?#])/i.test(url.pathname)) return false;
    if (/\.svg(?:$|[?#])/i.test(url.pathname)) return false;
    if (allowExtensionless) return true;
    if (/\.(avif|gif|jpe?g|png|webp)(?:$|[?#])/i.test(url.pathname)) return true;
    return !/\.[a-z0-9]{2,6}$/i.test(url.pathname) && /image|img|photo|gallery|media/i.test(rawUrl);
  } catch {
    return false;
  }
}

function prioritizeImageUrls(urls) {
  return [...urls].sort((a, b) => scoreImageUrl(b) - scoreImageUrl(a));
}

function scoreImageUrl(rawUrl) {
  let score = 0;

  if (/\.(jpe?g|png|webp|avif)(?:$|[?#])/i.test(rawUrl)) score += 8;
  if (/_960x960|_720x720|_1080x1080|\/kf\//i.test(rawUrl)) score += 4;
  if (/m\.media-amazon\.com\/images\/I\//i.test(rawUrl)) score += 12;
  if (/alicdn\.com\/kf\//i.test(rawUrl)) score += 10;
  if (/og:image|zoom|gallery|product|item/i.test(rawUrl)) score += 2;

  if (/_80x80|_120x120|tps-\d+-\d+/i.test(rawUrl)) score -= 4;
  if (/images(-na)?\.ssl-images-amazon\.com\/images\/G\//i.test(rawUrl)) score -= 18;
  if (/omaha|nav-sprite|prime\/piv|snake|transparent-pixel|grey-pixel|amazon-avatars-global/i.test(rawUrl)) score -= 18;
  if (/alicdn\.com\/@img\/imgextra|flags\/1\.0\.0|favicon/i.test(rawUrl)) score -= 16;
  if (/flag|logo|icon|sprite|avatar|placeholder|favicon/i.test(rawUrl)) score -= 8;
  if (/\.svg(?:$|[?#])|video|play\.video/i.test(rawUrl)) score -= 10;

  return score;
}

async function searchFallbackImages(reference) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);

  try {
    const query = encodeURIComponent(`${reference} herramienta producto`);
    const response = await fetch(`https://www.bing.com/images/search?q=${query}&form=HDRSC3`, {
      signal: controller.signal,
      headers: {
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        "accept-language": "es-CO,es;q=0.9,en;q=0.8",
      },
    });

    const html = await response.text();
    const candidates = [];

    for (const match of html.matchAll(/murl&quot;:&quot;([^&]+?)&quot;/gi)) {
      const normalized = toAbsoluteUrl(match[1], "https://www.bing.com/");
      if (normalized) candidates.push(normalized);
    }

    return prioritizeImageUrls(uniqueUrls(candidates).filter(isUsableImageUrl)).slice(0, 10);
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

async function downloadImageToLocal(candidateUrl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);

  try {
    const response = await fetch(candidateUrl, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        "accept-language": "es-CO,es;q=0.9,en;q=0.8",
      },
    });

    if (!response.ok) return null;

    const contentType = `${response.headers.get("content-type") || ""}`.toLowerCase();
    if (!contentType.startsWith("image/")) return null;

    const ext = getImageExtension(response.url || candidateUrl, contentType);
    const digest = createHash("sha1").update(candidateUrl).digest("hex");
    const fileName = `${digest}.${ext}`;
    const filePath = path.join(options.imageDir, fileName);
    const publicPath = `/product-images/${fileName}`;

    const bytes = Buffer.from(await response.arrayBuffer());
    await fs.writeFile(filePath, bytes);

    return publicPath;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function getImageExtension(rawUrl, contentType) {
  const byType = {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/avif": "avif",
  };

  for (const [type, ext] of Object.entries(byType)) {
    if (contentType.startsWith(type)) return ext;
  }

  try {
    const url = new URL(rawUrl);
    const match = url.pathname.match(/\.([a-z0-9]{2,5})$/i);
    if (match) return match[1].toLowerCase();
  } catch {
    // Ignorado.
  }

  return "jpg";
}

function pushMatches(output, html, regex, baseUrl) {
  for (const match of html.matchAll(regex)) {
    const normalized = toAbsoluteUrl(match[1], baseUrl);
    if (normalized) output.push(normalized);
  }
}

function firstMatch(text, regex) {
  const match = text.match(regex);
  return match?.[1] || "";
}

function toAbsoluteUrl(value, baseUrl) {
  if (!value || typeof value !== "string") return null;

  const trimmed = decodeHtmlEntities(value).trim();
  if (!trimmed || trimmed.startsWith("data:")) return null;

  try {
    if (trimmed.startsWith("//")) {
      const base = new URL(baseUrl);
      return `${base.protocol}${trimmed}`;
    }

    return new URL(trimmed, baseUrl).toString();
  } catch {
    return null;
  }
}

function uniqueUrls(urls) {
  const seen = new Set();
  const output = [];

  urls.forEach((url) => {
    if (!url || seen.has(url)) return;
    seen.add(url);
    output.push(url);
  });

  return output;
}

function decodeHtmlEntities(value) {
  return `${value || ""}`
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&aacute;/gi, "a")
    .replace(/&eacute;/gi, "e")
    .replace(/&iacute;/gi, "i")
    .replace(/&oacute;/gi, "o")
    .replace(/&uacute;/gi, "u")
    .replace(/&agrave;/gi, "a")
    .replace(/&egrave;/gi, "e")
    .replace(/&igrave;/gi, "i")
    .replace(/&ograve;/gi, "o")
    .replace(/&ugrave;/gi, "u")
    .replace(/&acirc;/gi, "a")
    .replace(/&ecirc;/gi, "e")
    .replace(/&icirc;/gi, "i")
    .replace(/&ocirc;/gi, "o")
    .replace(/&ucirc;/gi, "u")
    .replace(/&atilde;/gi, "a")
    .replace(/&otilde;/gi, "o")
    .replace(/&auml;/gi, "a")
    .replace(/&euml;/gi, "e")
    .replace(/&iuml;/gi, "i")
    .replace(/&ouml;/gi, "o")
    .replace(/&uuml;/gi, "u")
    .replace(/&ntilde;/gi, "n")
    .replace(/&ccedil;/gi, "c")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)));
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function consume() {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;

      if (currentIndex >= items.length) return;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length || 1) }, consume));
  return results;
}
