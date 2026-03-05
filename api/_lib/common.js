import { Buffer } from "node:buffer";

export function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(payload));
}

export async function readJsonBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string" && req.body.trim()) {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }

  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};

  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export function sanitizeDecisions(input) {
  const out = {};
  if (!input || typeof input !== "object") return out;

  Object.entries(input).forEach(([productId, decision]) => {
    if (!productId) return;
    if (decision === "keep" || decision === "drop") {
      out[String(productId)] = decision;
    }
  });

  return out;
}

export function slugify(value) {
  return `${value || ""}`
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "session";
}

export function getRequestOrigin(req) {
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${proto}://${host}`;
}

export function buildExportFilename(sessionId, reviewerId, type) {
  const session = slugify(sessionId);
  const reviewer = slugify(reviewerId);
  const suffix = type === "drop" ? "no-los-tiene" : "jsonkevinsilostiene";
  return `${session}-${reviewer}-${suffix}.json`;
}
