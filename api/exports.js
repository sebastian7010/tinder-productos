import { getSupabaseAdmin } from "./_lib/supabase-admin.js";
import { buildExportFilename, getRequestOrigin, sanitizeDecisions, sendJson } from "./_lib/common.js";

const TABLE = "review_states";
let catalogCache = null;

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return sendJson(res, 405, { error: "Metodo no soportado." });
  }

  try {
    const url = new URL(req.url, "http://localhost");
    const sessionId = `${url.searchParams.get("session") || ""}`.trim();
    const reviewerId = `${url.searchParams.get("reviewer") || ""}`.trim();
    const type = `${url.searchParams.get("type") || "both"}`.trim().toLowerCase();
    const shouldDownload = `${url.searchParams.get("download") || "0"}` === "1";

    if (!sessionId || !reviewerId) {
      return sendJson(res, 400, { error: "session y reviewer son obligatorios." });
    }

    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from(TABLE)
      .select("decisions, updated_at")
      .eq("session_id", sessionId)
      .eq("reviewer_id", reviewerId)
      .maybeSingle();

    if (error) {
      return sendJson(res, 500, { error: "No pude leer decisiones remotas." });
    }

    const decisions = sanitizeDecisions(data?.decisions);
    const catalog = await loadCatalog(req);
    const { accepted, rejected } = buildDecisionLists(decisions, catalog);

    if (shouldDownload && (type === "keep" || type === "drop")) {
      const filePayload = type === "keep" ? accepted : rejected;
      const filename = buildExportFilename(sessionId, reviewerId, type);
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.end(JSON.stringify(filePayload, null, 2));
      return;
    }

    if (type === "keep") {
      return sendJson(res, 200, { sessionId, reviewerId, accepted, count: accepted.length, updatedAt: data?.updated_at || null });
    }

    if (type === "drop") {
      return sendJson(res, 200, { sessionId, reviewerId, rejected, count: rejected.length, updatedAt: data?.updated_at || null });
    }

    return sendJson(res, 200, {
      sessionId,
      reviewerId,
      accepted,
      rejected,
      counts: { accepted: accepted.length, rejected: rejected.length },
      updatedAt: data?.updated_at || null,
    });
  } catch (error) {
    return sendJson(res, 500, {
      error: error instanceof Error ? error.message : "Error interno.",
    });
  }
}

function buildDecisionLists(decisions, catalogMap) {
  const accepted = [];
  const rejected = [];

  Object.entries(decisions).forEach(([productId, decision]) => {
    const item = catalogMap.get(productId);
    if (!item) return;

    if (decision === "keep") accepted.push(item);
    if (decision === "drop") rejected.push(item);
  });

  return { accepted, rejected };
}

async function loadCatalog(req) {
  if (catalogCache) return catalogCache;

  const origin = getRequestOrigin(req);
  const candidates = [
    `${origin}/catalogo-finalistas.json`,
    `${origin}/catalogo-runtime.json`,
    `${origin}/herramientas-bogota-kevin-aceptados%204.json`,
    `${origin}/productos-imagenes-unicas.json`,
    `${origin}/reciclaje-productos.json`,
  ];

  let catalogArray = null;

  for (const candidate of candidates) {
    try {
      const response = await fetch(candidate, { cache: "no-store" });
      if (!response.ok) continue;
      const payload = await response.json();
      if (Array.isArray(payload)) {
        catalogArray = payload;
        break;
      }
    } catch {
      // Probamos el siguiente candidate.
    }
  }

  if (!catalogArray) {
    throw new Error("No pude cargar el catalogo para exportar.");
  }

  const map = new Map();
  catalogArray.forEach((item) => {
    if (!item?.id) return;
    map.set(String(item.id), item);
  });

  catalogCache = map;
  return map;
}
