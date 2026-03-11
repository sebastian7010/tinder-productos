import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const distDir = path.join(rootDir, "dist");
const fallbackPublicDir = path.join(rootDir, "public");
const dataDir = path.join(rootDir, "storage");
const reviewsDir = path.join(dataDir, "reviews");
const exportsDir = path.join(dataDir, "exports");
const acceptedRemoteFile = "jsonkevinsilostiene.json";
const rejectedRemoteFile = "no los tiene.json";
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || "0.0.0.0";

await ensureDir(reviewsDir);
await ensureDir(exportsDir);

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (url.pathname === "/api/health") {
      return sendJson(res, 200, { ok: true, persistence: "file" });
    }

    if (url.pathname === "/api/session-state") {
      if (req.method === "GET") {
        const sessionId = url.searchParams.get("session") || "";
        const reviewerId = url.searchParams.get("reviewer") || "";
        return sendJson(res, 200, await readState(sessionId, reviewerId));
      }

      if (req.method === "PUT") {
        const body = await readJsonBody(req);
        const sessionId = String(body?.sessionId || "");
        const reviewerId = String(body?.reviewerId || "");
        const decisions = sanitizeDecisions(body?.decisions);

        if (!sessionId || !reviewerId) {
          return sendJson(res, 400, { error: "sessionId y reviewerId son obligatorios" });
        }

        const state = await writeState(sessionId, reviewerId, decisions);
        await writeExportsForState(state);
        return sendJson(res, 200, { ok: true, saved: true });
      }
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      return sendJson(res, 405, { error: "Metodo no soportado" });
    }

    await serveStatic(req, res, url.pathname);
  } catch (error) {
    console.error(error);
    if (!res.headersSent) {
      sendJson(res, 500, { error: "Server error" });
    } else {
      res.end();
    }
  }
});

server.listen(port, host, () => {
  console.log(`Remote review server listo en http://${host}:${port}`);
  console.log(`Archivos de salida: ${exportsDir}`);
});

async function serveStatic(req, res, pathname) {
  const publicRoot = (await exists(distDir)) ? distDir : fallbackPublicDir;
  let relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  let filePath = safeJoin(publicRoot, relativePath);

  if (!filePath) {
    res.writeHead(400);
    res.end("Bad request");
    return;
  }

  if (!(await exists(filePath))) {
    const spaPath = path.join(publicRoot, "index.html");
    if (await exists(spaPath)) {
      filePath = spaPath;
    } else {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
  }

  const content = await fs.readFile(filePath);
  res.writeHead(200, {
    "Content-Type": getContentType(filePath),
    "Cache-Control": /index\.html$/i.test(filePath) ? "no-store" : "public, max-age=300",
  });

  if (req.method === "HEAD") {
    res.end();
    return;
  }

  res.end(content);
}

async function readState(sessionId, reviewerId) {
  if (!sessionId || !reviewerId) {
    return { sessionId, reviewerId, decisions: {} };
  }

  const filePath = getReviewFilePath(sessionId, reviewerId);
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return {
      sessionId,
      reviewerId,
      decisions: sanitizeDecisions(parsed?.decisions),
    };
  } catch {
    return { sessionId, reviewerId, decisions: {} };
  }
}

async function writeState(sessionId, reviewerId, decisions) {
  const sessionDir = path.join(reviewsDir, slugify(sessionId));
  await ensureDir(sessionDir);

  const state = {
    sessionId,
    reviewerId,
    updatedAt: new Date().toISOString(),
    decisions,
  };

  await fs.writeFile(getReviewFilePath(sessionId, reviewerId), `${JSON.stringify(state, null, 2)}\n`, "utf8");
  return state;
}

async function writeExportsForState(state) {
  const sessionDir = path.join(exportsDir, slugify(state.sessionId));
  await ensureDir(sessionDir);

  const catalog = await loadCatalog();
  const accepted = [];
  const rejected = [];

  Object.entries(state.decisions).forEach(([productId, decision]) => {
    const item = catalog.get(productId);
    if (!item) return;

    if (decision === "keep") accepted.push(item);
    if (decision === "drop") rejected.push(item);
  });

  await fs.writeFile(
    path.join(sessionDir, `${state.reviewerId}-aceptados.json`),
    `${JSON.stringify(accepted, null, 2)}\n`,
    "utf8",
  );
  await fs.writeFile(
    path.join(sessionDir, `${state.reviewerId}-rechazados.json`),
    `${JSON.stringify(rejected, null, 2)}\n`,
    "utf8",
  );

  await fs.writeFile(path.join(exportsDir, acceptedRemoteFile), `${JSON.stringify(accepted, null, 2)}\n`, "utf8");
  await fs.writeFile(path.join(exportsDir, rejectedRemoteFile), `${JSON.stringify(rejected, null, 2)}\n`, "utf8");
}

async function loadCatalog() {
  const filePath = await findCatalogFile();

  const raw = await fs.readFile(filePath, "utf8");
  const parsed = JSON.parse(raw);
  const map = new Map();

  (Array.isArray(parsed) ? parsed : []).forEach((item) => {
    if (!item?.id) return;
    map.set(String(item.id), item);
  });

  return map;
}

async function findCatalogFile() {
  const candidates = [
    path.join(distDir, "catalogo-finalistas.json"),
    path.join(fallbackPublicDir, "catalogo-finalistas.json"),
    path.join(distDir, "catalogo-runtime.json"),
    path.join(fallbackPublicDir, "catalogo-runtime.json"),
    path.join(distDir, "herramientas-bogota-kevin-aceptados 4.json"),
    path.join(fallbackPublicDir, "herramientas-bogota-kevin-aceptados 4.json"),
    path.join(distDir, "productos-imagenes-unicas.json"),
    path.join(fallbackPublicDir, "productos-imagenes-unicas.json"),
    path.join(distDir, "reciclaje-productos.json"),
    path.join(fallbackPublicDir, "reciclaje-productos.json"),
  ];

  for (const filePath of candidates) {
    if (await exists(filePath)) return filePath;
  }

  throw new Error("No encontre un catalogo JSON para exportar decisiones.");
}

function sanitizeDecisions(input) {
  const out = {};
  if (!input || typeof input !== "object") return out;

  Object.entries(input).forEach(([key, value]) => {
    if (!key) return;
    if (value === "keep" || value === "drop") out[key] = value;
  });

  return out;
}

function getReviewFilePath(sessionId, reviewerId) {
  return path.join(reviewsDir, slugify(sessionId), `${reviewerId}.json`);
}

function slugify(value) {
  return `${value || ""}`
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "session";
}

async function readJsonBody(req) {
  const chunks = [];

  for await (const chunk of req) {
    chunks.push(chunk);
  }

  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function safeJoin(root, relativePath) {
  const resolved = path.resolve(root, relativePath);
  if (!resolved.startsWith(root)) return null;
  return resolved;
}

function getContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const byExt = {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
  };

  return byExt[ext] || "application/octet-stream";
}
