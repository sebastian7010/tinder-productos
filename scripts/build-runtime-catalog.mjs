import fs from "node:fs/promises";
import path from "node:path";

const DEFAULTS = {
  base: "public/productos-imagenes-unicas.json",
  overrides: "public/herramientas-bogota-kevin-aceptados 4.json",
  out: "public/catalogo-runtime.json",
};

const args = parseArgs(process.argv.slice(2));
const basePath = path.resolve(process.cwd(), args.base || DEFAULTS.base);
const overridesPath = path.resolve(process.cwd(), args.overrides || DEFAULTS.overrides);
const outPath = path.resolve(process.cwd(), args.out || DEFAULTS.out);

await main();

async function main() {
  const base = await readArray(basePath);
  const overrides = await readArray(overridesPath);

  const byId = new Map();
  overrides.forEach((item) => {
    if (!item?.id) return;
    byId.set(String(item.id), item);
  });

  let replaced = 0;
  const merged = base.map((item) => {
    const override = byId.get(String(item?.id || ""));
    if (!override) return item;
    replaced += 1;
    return mergeProduct(item, override);
  });

  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, `${JSON.stringify(merged, null, 2)}\n`, "utf8");

  console.log(`Base: ${base.length}`);
  console.log(`Overrides: ${overrides.length}`);
  console.log(`Reemplazados: ${replaced}`);
  console.log(`Salida: ${outPath}`);
}

function mergeProduct(base, override) {
  const imageUrl = firstString(
    override.url_imagen_origen,
    override.meta?.remote_image,
    Array.isArray(override.imagenes_origen) ? override.imagenes_origen[0] : "",
    Array.isArray(override.imagenes) ? override.imagenes[0] : "",
  );

  const merged = {
    ...base,
    ...override,
  };

  if (imageUrl) {
    merged.url_imagen_origen = imageUrl;
    merged.imagenes_origen = [imageUrl];
    merged.imagenes = [imageUrl];
    merged.meta = {
      ...(base.meta && typeof base.meta === "object" ? base.meta : {}),
      ...(override.meta && typeof override.meta === "object" ? override.meta : {}),
      image_source: "runtime_override",
      remote_image: imageUrl,
    };
    if ("local_image" in merged.meta) delete merged.meta.local_image;
  }

  return merged;
}

async function readArray(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  const parsed = JSON.parse(raw.replace(/^\uFEFF/, ""));
  if (!Array.isArray(parsed)) {
    throw new Error(`El archivo no es un arreglo JSON: ${filePath}`);
  }
  return parsed;
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
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
