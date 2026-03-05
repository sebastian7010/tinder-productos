import { getSupabaseAdmin } from "./_lib/supabase-admin.js";
import { readJsonBody, sanitizeDecisions, sendJson } from "./_lib/common.js";

const TABLE = "review_states";

export default async function handler(req, res) {
  try {
    const supabase = getSupabaseAdmin();

    if (req.method === "GET") {
      const url = new URL(req.url, "http://localhost");
      const sessionId = `${url.searchParams.get("session") || ""}`.trim();
      const reviewerId = `${url.searchParams.get("reviewer") || ""}`.trim();

      if (!sessionId || !reviewerId) {
        return sendJson(res, 200, { sessionId, reviewerId, decisions: {} });
      }

      const { data, error } = await supabase
        .from(TABLE)
        .select("decisions")
        .eq("session_id", sessionId)
        .eq("reviewer_id", reviewerId)
        .maybeSingle();

      if (error) {
        return sendJson(res, 500, { error: "No pude leer el estado remoto." });
      }

      return sendJson(res, 200, {
        sessionId,
        reviewerId,
        decisions: sanitizeDecisions(data?.decisions),
      });
    }

    if (req.method === "PUT") {
      const body = await readJsonBody(req);
      const sessionId = `${body?.sessionId || ""}`.trim();
      const reviewerId = `${body?.reviewerId || ""}`.trim();
      const decisions = sanitizeDecisions(body?.decisions);

      if (!sessionId || !reviewerId) {
        return sendJson(res, 400, { error: "sessionId y reviewerId son obligatorios." });
      }

      const { error } = await supabase.from(TABLE).upsert(
        {
          session_id: sessionId,
          reviewer_id: reviewerId,
          decisions,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "session_id,reviewer_id" },
      );

      if (error) {
        return sendJson(res, 500, { error: "No pude guardar el estado remoto." });
      }

      return sendJson(res, 200, { ok: true, saved: true, remote: true });
    }

    return sendJson(res, 405, { error: "Metodo no soportado." });
  } catch (error) {
    return sendJson(res, 500, {
      error: error instanceof Error ? error.message : "Error interno.",
    });
  }
}
