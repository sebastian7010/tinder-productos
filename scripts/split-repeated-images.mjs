import fs from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const inputPath = path.join(root, "public", "reciclaje-productos.json");
const repeatedPath = path.join(root, "public", "productos-imagenes-repetidas.json");
const uniquePath = path.join(root, "public", "productos-imagenes-unicas.json");

const raw = await fs.readFile(inputPath, "utf8");
const items = JSON.parse(raw);

if (!Array.isArray(items)) {
  throw new Error("El archivo de catalogo debe ser un arreglo JSON.");
}

const imageCounts = new Map();

for (const item of items) {
  const key = getImageKey(item);
  if (!key) continue;
  imageCounts.set(key, (imageCounts.get(key) || 0) + 1);
}

const repeated = [];
const unique = [];
const withoutImageKey = [];

for (const item of items) {
  const key = getImageKey(item);
  if (!key) {
    withoutImageKey.push(item);
    unique.push(item);
    continue;
  }

  if ((imageCounts.get(key) || 0) > 1) repeated.push(item);
  else unique.push(item);
}

await fs.writeFile(repeatedPath, `${JSON.stringify(repeated, null, 2)}\n`, "utf8");
await fs.writeFile(uniquePath, `${JSON.stringify(unique, null, 2)}\n`, "utf8");

const duplicatedImageUrls = [...imageCounts.values()].filter((count) => count > 1).length;

console.log(
  JSON.stringify(
    {
      total: items.length,
      repeatedProducts: repeated.length,
      uniqueProducts: unique.length,
      duplicatedImageUrls,
      withoutImageKey: withoutImageKey.length,
      repeatedFile: relativeToRoot(repeatedPath),
      uniqueFile: relativeToRoot(uniquePath),
    },
    null,
    2,
  ),
);

function getImageKey(item) {
  const firstImage = Array.isArray(item?.imagenes) ? item.imagenes.find(isNonEmptyString) : "";
  if (firstImage) return normalizeUrl(firstImage);

  const imageOrigin = isNonEmptyString(item?.url_imagen_origen) ? item.url_imagen_origen : "";
  if (imageOrigin) return normalizeUrl(imageOrigin);

  return "";
}

function normalizeUrl(value) {
  try {
    const url = new URL(value, "https://placeholder.local");
    url.hash = "";
    return url.toString();
  } catch {
    return `${value}`.trim();
  }
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function relativeToRoot(filePath) {
  return path.relative(root, filePath).replaceAll("\\", "/");
}
