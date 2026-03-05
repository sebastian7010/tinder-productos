import { getSupabaseAdmin } from "./_lib/supabase-admin.js";
import { sendJson } from "./_lib/common.js";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return sendJson(res, 405, { error: "Metodo no soportado." });
  }

  try {
    const supabase = getSupabaseAdmin();
    const { error } = await supabase.from("review_states").select("session_id").limit(1);

    if (error) {
      return sendJson(res, 500, { ok: false, persistence: "supabase", error: "No pude validar la base de datos." });
    }

    return sendJson(res, 200, { ok: true, persistence: "supabase" });
  } catch (error) {
    return sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : "Error interno." });
  }
}
