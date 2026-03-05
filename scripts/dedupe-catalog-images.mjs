import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const catalogPath = path.join(rootDir, "public", "reciclaje-productos.json");

const raw = await fs.readFile(catalogPath, "utf8");
const catalog = JSON.parse(raw);

if (!Array.isArray(catalog)) {
  throw new Error("El catalogo debe ser un arreglo de productos.");
}

const imageGroups = new Map();

for (const item of catalog) {
  const imageList = normalizeImages(item.imagenes);
  item.imagenes = imageList;

  for (const imageUrl of imageList) {
    if (!imageGroups.has(imageUrl)) {
      imageGroups.set(imageUrl, []);
    }

    imageGroups.get(imageUrl).push(item);
  }
}

let duplicateUrls = 0;
let productsCleared = 0;

for (const [imageUrl, items] of imageGroups.entries()) {
  if (items.length <= 1) continue;

  duplicateUrls += 1;
  const keeper = pickBestItem(items);

  for (const item of items) {
    if (item === keeper) continue;

    const before = item.imagenes.length;
    item.imagenes = item.imagenes.filter((candidate) => candidate !== imageUrl);

    if (item.meta && item.meta.local_image === imageUrl) {
      delete item.meta.local_image;
    }

    if (item.meta) {
      item.meta.duplicate_image_removed = true;
    }

    if (before > 0 && item.imagenes.length === 0) {
      productsCleared += 1;
    }
  }
}

await fs.writeFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");

const remainingWithImage = catalog.filter((item) => item.imagenes.length > 0).length;
const withoutImage = catalog.length - remainingWithImage;

console.log(
  JSON.stringify(
    {
      totalProducts: catalog.length,
      duplicateUrlsRemoved: duplicateUrls,
      productsWithoutImage: withoutImage,
      productsWithImage: remainingWithImage,
      productsCleared,
    },
    null,
    2,
  ),
);

function normalizeImages(images) {
  const seen = new Set();
  const normalized = [];

  for (const imageUrl of Array.isArray(images) ? images : []) {
    if (typeof imageUrl !== "string") continue;

    const clean = imageUrl.trim();
    if (!clean || seen.has(clean)) continue;

    seen.add(clean);
    normalized.push(clean);
  }

  return normalized;
}

function pickBestItem(items) {
  return [...items].sort(compareItems)[0];
}

function compareItems(a, b) {
  const scoreA = scoreItem(a);
  const scoreB = scoreItem(b);

  if (scoreA !== scoreB) {
    return scoreB - scoreA;
  }

  const rankA = stableRank(a);
  const rankB = stableRank(b);
  return rankA.localeCompare(rankB);
}

function scoreItem(item) {
  const meta = item?.meta || {};
  let score = 0;

  if (meta.image_origin === "self") score += 100;
  else if (meta.image_origin === "reference_fallback") score += 40;
  else if (meta.image_origin === "search_fallback") score += 10;

  if (meta.image_source === "local_mirror") score += 20;
  if (meta.blocked === false) score += 5;

  const title = `${item?.nombre || ""}`.trim();
  if (title && !/^error$/i.test(title) && !/^product not available$/i.test(title)) {
    score += 5;
  }

  return score;
}

function stableRank(item) {
  return [
    `${item?.referencia || ""}`,
    `${item?.fuente || ""}`,
    `${item?.url || ""}`,
    `${item?.id || ""}`,
  ].join("::");
}
