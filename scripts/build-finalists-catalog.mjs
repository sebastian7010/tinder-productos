import fs from "node:fs/promises";
import path from "node:path";

const DEFAULTS = {
  input: "public/herramientas-bogota-kevin-aceptados 4 (1).json",
  urls: "urls.txt",
  out: "public/catalogo-finalistas.json",
};

const args = parseArgs(process.argv.slice(2));
const inputPath = path.resolve(process.cwd(), args.input || DEFAULTS.input);
const urlsPath = path.resolve(process.cwd(), args.urls || DEFAULTS.urls);
const outPath = path.resolve(process.cwd(), args.out || DEFAULTS.out);

await main();

async function main() {
  const products = await readJsonArray(inputPath);
  const urls = await readUrls(urlsPath);
  const extras = buildProductsFromUrls(urls);
  const finalCatalog = [...products, ...extras];

  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, `${JSON.stringify(finalCatalog, null, 2)}\n`, "utf8");

  console.log(`Productos: ${products.length}`);
  console.log(`URLs validas: ${urls.length}`);
  console.log(`Agregados desde urls.txt: ${extras.length}`);
  console.log(`Total final: ${finalCatalog.length}`);
  console.log(`Salida: ${outPath}`);
}

async function readJsonArray(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  const parsed = JSON.parse(raw.replace(/^\uFEFF/, ""));
  if (!Array.isArray(parsed)) {
    throw new Error(`JSON invalido (no es arreglo): ${filePath}`);
  }
  return parsed;
}

async function readUrls(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  return raw
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean)
    .map(normalizeUrl)
    .filter((line) => /^https?:\/\//i.test(line));
}

function normalizeUrl(value) {
  return value.replace(/^http:\/\/http2\.mlstatic\.com/i, "https://http2.mlstatic.com");
}

function buildProductsFromUrls(urls) {
  return urls.map((imageUrl, index) => ({
    id: `urltxt_${String(index + 1).padStart(4, "0")}`,
    referencia: `URL TXT ${index + 1}`,
    fuente: "urls_txt",
    url: imageUrl,
    url_producto: imageUrl,
    url_imagen_origen: imageUrl,
    nombre: `Imagen URL ${index + 1}`,
    descripcion: `Extra desde urls.txt #${index + 1}`,
    imagenes: [imageUrl],
    imagenes_origen: [imageUrl],
    meta: {
      image_source: "urls_txt_only",
      remote_image: imageUrl,
      fetched_url: imageUrl,
      blocked: false,
      status: "direct",
    },
  }));
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;

    const [rawKey, rawValue] = token.slice(2).split("=", 2);
    const key = rawKey.trim();
    const next = argv[i + 1];
    const value = rawValue ?? (next && !next.startsWith("--") ? next : "true");

    if (rawValue == null && next && !next.startsWith("--")) i += 1;
    out[key] = value;
  }
  return out;
}
