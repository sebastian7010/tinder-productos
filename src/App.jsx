import { useEffect, useMemo, useRef, useState } from "react";
import { motion, useMotionValue, useTransform } from "framer-motion";
import { supabase } from "./supabase";

function qparam(name) {
  const u = new URL(window.location.href);
  return u.searchParams.get(name) || "";
}

function makeReviewerId() {
  const k = "reviewer_id_v1";
  let v = localStorage.getItem(k);
  if (!v) {
    v = "r_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem(k, v);
  }
  return v;
}

function normalizeItem(raw, idx) {
  const imgsRaw = raw.imagenes ?? raw.images ?? [];
  const images = (Array.isArray(imgsRaw) ? imgsRaw : [])
    .map((x) => {
      if (!x) return null;
      if (typeof x === "string") return x;
      if (typeof x === "object" && x.url) return x.url;
      if (typeof x === "object" && x.archivo) return x.archivo;
      return null;
    })
    .filter(Boolean);

  return {
    id: String(raw.id ?? raw.itemId ?? raw.url ?? `idx_${idx}`),
    session_id: String(raw.session_id ?? ""),
    url: raw.url || raw.link || "",
    nombre: raw.nombre || raw.titulo || raw.title || "",
    precio: raw.precio || raw.price || "",
    descripcion: raw.descripcion || raw.description || "",
    imagenes: images,
  };
}

function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(a.href);
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export default function App() {
  // session para compartir con tu amigo:
  // https://tuweb.com/?session=herramientas-bogota
  const [sessionId, setSessionId] = useState(() => qparam("session") || "herramientas-bogota");

  const reviewerId = useMemo(() => makeReviewerId(), []);

  const [authUser, setAuthUser] = useState(null);
  const [email, setEmail] = useState("");
  const [pass, setPass] = useState("");

  const [items, setItems] = useState([]);
  const [index, setIndex] = useState(0);

  const [accepted, setAccepted] = useState(() => new Set());
  const [rejected, setRejected] = useState(() => new Set());
  const [history, setHistory] = useState([]);

  const [loading, setLoading] = useState(false);
  const fileRef = useRef(null);

  // Swipe motion
  const x = useMotionValue(0);
  const rotate = useTransform(x, [-250, 0, 250], [-10, 0, 10]);
  const opacity = useTransform(x, [-250, 0, 250], [0.85, 1, 0.85]);

  const current = items[index] || null;
  const remaining = useMemo(() => Math.max(0, items.length - index), [items.length, index]);

  // Auth state
  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setAuthUser(data?.user ?? null));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => {
      setAuthUser(s?.user ?? null);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  // Load products for session
  async function loadProducts() {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from("products")
        .select("id, url, nombre, precio, descripcion, imagenes")
        .eq("session_id", sessionId)
        .order("created_at", { ascending: true })
        .limit(5000);

      if (error) throw error;

      const arr = (data || []).map((r, idx) => ({
        id: r.id,
        url: r.url || "",
        nombre: r.nombre || "",
        precio: r.precio || "",
        descripcion: r.descripcion || "",
        images: Array.isArray(r.imagenes) ? r.imagenes : [],
        raw: r,
      }));

      setItems(arr);
      setIndex(0);
      setAccepted(new Set());
      setRejected(new Set());
      setHistory([]);
    } catch (e) {
      alert("No pude cargar productos de Supabase para session=" + sessionId);
      console.error(e);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadProducts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // --- decisiones a Supabase (upsert)
  async function saveDecision(productId, decision) {
    const payload = {
      session_id: sessionId,
      product_id: productId,
      reviewer_id: reviewerId,
      decision,
      updated_at: new Date().toISOString(),
    };

    // returning: minimal para no requerir SELECT
    const { error } = await supabase.from("decisions").upsert(payload, {
      onConflict: "session_id,product_id,reviewer_id",
      returning: "minimal",
    });

    if (error) console.error("saveDecision error:", error);
  }

  function next() {
    setIndex((i) => Math.min(items.length, i + 1));
    x.set(0);
  }

  async function doAction(action) {
    if (!current) return;
    const id = current.id;

    setHistory((h) => [...h, { id, action }]);

    if (action === "accept") {
      setAccepted((s) => new Set([...s, id]));
      setRejected((s) => {
        const ns = new Set(s);
        ns.delete(id);
        return ns;
      });
      saveDecision(id, "keep");
    } else {
      setRejected((s) => new Set([...s, id]));
      setAccepted((s) => {
        const ns = new Set(s);
        ns.delete(id);
        return ns;
      });
      saveDecision(id, "drop");
    }

    next();
  }

  function undo() {
    setHistory((h) => {
      if (!h.length) return h;
      const last = h[h.length - 1];
      setIndex((i) => Math.max(0, i - 1));

      if (last.action === "accept") {
        setAccepted((s) => {
          const ns = new Set(s);
          ns.delete(last.id);
          return ns;
        });
      } else {
        setRejected((s) => {
          const ns = new Set(s);
          ns.delete(last.id);
          return ns;
        });
      }
      // Nota: NO revertimos en DB (simple). Si quieres, lo hacemos.
      return h.slice(0, -1);
    });
  }

  function resetLocal() {
    if (!confirm("¿Restablecer solo en este dispositivo? (no borra Supabase)")) return;
    setIndex(0);
    setAccepted(new Set());
    setRejected(new Set());
    setHistory([]);
  }

  // Upload JSON (ADMIN)
  async function uploadJsonToSupabase(file) {
    if (!authUser) {
      alert("Debes iniciar sesión como admin para subir el JSON.");
      return;
    }
    setLoading(true);
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed)) {
        alert("El JSON debe ser un array [ {...}, {...} ]");
        return;
      }

      // Normaliza + asigna session_id
      const normalized = parsed.map((p, idx) => {
        const n = normalizeItem(p, idx);
        return {
          ...n,
          session_id: sessionId,
        };
      });

      // Dedup por id (primero gana)
      const seen = new Set();
      const dedup = [];
      for (const it of normalized) {
        if (!it.id) continue;
        if (seen.has(it.id)) continue;
        seen.add(it.id);
        dedup.push(it);
      }

      // Insert por chunks
      const chunkSize = 500;
      for (let i = 0; i < dedup.length; i += chunkSize) {
        const chunk = dedup.slice(i, i + chunkSize).map((it) => ({
          id: it.id,
          session_id: it.session_id,
          url: it.url,
          nombre: it.nombre,
          precio: it.precio,
          descripcion: it.descripcion,
          imagenes: it.imagenes,
        }));

        const { error } = await supabase.from("products").insert(chunk);
        if (error) throw error;

        await sleep(250);
      }

      alert(`Listo: subidos ${dedup.length} productos a session=${sessionId}`);
      await loadProducts();
    } catch (e) {
      console.error(e);
      alert("Error subiendo JSON. Mira consola.");
    } finally {
      setLoading(false);
    }
  }

  // Export (ADMIN): toma TODAS las decisiones de TODOS los reviewers
  async function exportDecisions(decisionKind) {
    if (!authUser) {
      alert("Solo admin puede exportar.");
      return;
    }
    setLoading(true);
    try {
      const { data: decs, error } = await supabase
        .from("decisions")
        .select("product_id, decision, reviewer_id, updated_at")
        .eq("session_id", sessionId);

      if (error) throw error;

      // Estrategia: si ANY reviewer marcó keep -> keep. Si no, drop.
      const map = new Map(); // product_id -> {keepCount, dropCount}
      for (const d of decs || []) {
        const entry = map.get(d.product_id) || { keep: 0, drop: 0 };
        if (d.decision === "keep") entry.keep++;
        else entry.drop++;
        map.set(d.product_id, entry);
      }

      const out = [];
      for (const it of items) {
        const stat = map.get(it.id) || { keep: 0, drop: 0 };
        const final = stat.keep > 0 ? "keep" : stat.drop > 0 ? "drop" : "none";
        if (decisionKind === "keep" && final === "keep") out.push(it.raw);
        if (decisionKind === "drop" && final === "drop") out.push(it.raw);
      }

      downloadJson(decisionKind === "keep" ? "aceptados.json" : "rechazados.json", out);
    } catch (e) {
      console.error(e);
      alert("Error exportando. Mira consola.");
    } finally {
      setLoading(false);
    }
  }

  function onDragEnd(_, info) {
    const dx = info.offset.x;
    if (dx > 140) doAction("accept");
    else if (dx < -140) doAction("reject");
    else x.set(0);
  }

  async function adminLogin() {
    const { error } = await supabase.auth.signInWithPassword({ email, password: pass });
    if (error) alert("Login error: " + error.message);
  }

  async function adminLogout() {
    await supabase.auth.signOut();
  }

  return (
    <div style={styles.page}>
      <header style={styles.header}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
          <h2 style={{ margin: 0 }}>Tinder de productos (online)</h2>
          <span style={styles.badge}>session: <b>{sessionId}</b></span>
          <span style={styles.badge}>Restantes: {remaining}</span>
          <span style={styles.badge}>Keep(local): {accepted.size}</span>
          <span style={styles.badge}>Drop(local): {rejected.size}</span>
          <span style={styles.badge}>Touch ✅</span>
        </div>

        <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
          <input
            value={sessionId}
            onChange={(e) => setSessionId(e.target.value.trim() || "herramientas-bogota")}
            style={styles.input}
            title="Esto define el link para tu amigo: ?session=..."
          />

          {authUser ? (
            <>
              <button style={styles.btn} onClick={() => fileRef.current?.click()}>Subir JSON (admin)</button>
              <input
                ref={fileRef}
                type="file"
                accept="application/json"
                style={{ display: "none" }}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) uploadJsonToSupabase(f);
                  e.target.value = "";
                }}
              />
              <button style={styles.btn} onClick={() => exportDecisions("keep")}>Exportar aceptados</button>
              <button style={styles.btn} onClick={() => exportDecisions("drop")}>Exportar rechazados</button>
              <button style={{ ...styles.btn, background: "#2b2b2b", color: "#fff" }} onClick={adminLogout}>Salir admin</button>
            </>
          ) : (
            <>
              <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="email admin" style={styles.input} />
              <input value={pass} onChange={(e) => setPass(e.target.value)} placeholder="password" type="password" style={styles.input} />
              <button style={styles.btn} onClick={adminLogin}>Login admin</button>
            </>
          )}

          <button style={styles.btn} onClick={undo} disabled={!history.length}>Deshacer</button>
          <button style={styles.btn} onClick={resetLocal}>Restablecer (local)</button>
          <button style={styles.btn} onClick={loadProducts}>Recargar</button>
        </div>
      </header>

      <main style={styles.main}>
        {loading ? (
          <div style={styles.empty}><h3>Cargando…</h3></div>
        ) : !items.length ? (
          <div style={styles.empty}>
            <h3>No hay productos en Supabase para esta session</h3>
            <p>Si eres admin: inicia sesión y sube el productos.json.</p>
            <p>Si eres tu amigo: revisa que el link tenga el session correcto.</p>
            <p><b>Ejemplo link:</b> <code>?session=herramientas-bogota</code></p>
          </div>
        ) : !current ? (
          <div style={styles.empty}><h3>Listo ✅</h3><p>No hay más productos.</p></div>
        ) : (
          <div style={styles.cardWrap}>
            <motion.div
              drag="x"
              dragConstraints={{ left: 0, right: 0 }}
              style={{ ...styles.card, x, rotate, opacity }}
              onDragEnd={onDragEnd}
            >
              <div style={styles.imageArea}>
                {current.images?.[0] ? (
                  <img src={current.images[0]} alt="principal" style={styles.imgMain} />
                ) : (
                  <div style={styles.noImg}>Sin imagen</div>
                )}
              </div>

              <div style={styles.content}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                  <div style={{ flex: 1 }}>
                    <div style={styles.title}>{current.nombre || "(sin nombre)"}</div>
                    <div style={styles.price}>{current.precio || ""}</div>
                  </div>
                  {current.url ? (
                    <a href={current.url} target="_blank" rel="noreferrer" style={styles.link}>Abrir ↗</a>
                  ) : null}
                </div>

                {current.descripcion ? <div style={styles.desc}>{current.descripcion}</div> : null}

                {current.images?.length > 1 ? (
                  <div style={styles.thumbs}>
                    {current.images.slice(0, 10).map((u, i) => (
                      <img key={i} src={u} alt={`thumb-${i}`} style={styles.thumb} />
                    ))}
                    {current.images.length > 10 ? <span style={styles.more}>+{current.images.length - 10}</span> : null}
                  </div>
                ) : null}
              </div>

              <div style={styles.hint}>
                <span>⬅ Descarta</span>
                <span>Swipe (touch)</span>
                <span>Guarda ➡</span>
              </div>
            </motion.div>

            <div style={styles.actions}>
              <button onClick={() => doAction("reject")} style={{ ...styles.actionBtn, background: "#ffefef" }}>
                ⬅ No
              </button>
              <button onClick={() => doAction("accept")} style={{ ...styles.actionBtn, background: "#effff1" }}>
                Sí ➡
              </button>
            </div>

            <div style={{ marginTop: 10, fontSize: 12, color: "#666" }}>
              Link para tu amigo: <b>{window.location.origin}{window.location.pathname}?session={encodeURIComponent(sessionId)}</b>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

const styles = {
  page: { minHeight: "100vh", fontFamily: "system-ui, Segoe UI, Roboto, Arial", background: "#f6f6f6", color: "#111" },
  header: { padding: 14, display: "flex", flexDirection: "column", gap: 10,
    borderBottom: "1px solid #e5e5e5", background: "#fff", position: "sticky", top: 0, zIndex: 10 },
  badge: { fontSize: 12, padding: "6px 10px", borderRadius: 999, background: "#f1f1f1" },
  btn: { padding: "8px 10px", borderRadius: 10, border: "1px solid #ddd", background: "#fff", cursor: "pointer" },
  input: { padding: "8px 10px", borderRadius: 10, border: "1px solid #ddd", minWidth: 220 },
  main: { padding: 22, display: "flex", justifyContent: "center" },
  empty: { maxWidth: 700, padding: 24, borderRadius: 16, background: "#fff", border: "1px solid #e7e7e7" },
  cardWrap: { width: 520, maxWidth: "95vw" },
  card: { background: "#fff", borderRadius: 22, border: "1px solid #e7e7e7", overflow: "hidden",
    boxShadow: "0 10px 30px rgba(0,0,0,0.06)", cursor: "grab", userSelect: "none" },
  imageArea: { height: 360, background: "#111", display: "flex", alignItems: "center", justifyContent: "center" },
  imgMain: { width: "100%", height: "100%", objectFit: "cover", display: "block" },
  noImg: { color: "#fff", opacity: 0.8 },
  content: { padding: 14 },
  title: { fontSize: 18, fontWeight: 700, lineHeight: 1.2 },
  price: { marginTop: 6, fontSize: 16, fontWeight: 650 },
  link: { alignSelf: "flex-start", textDecoration: "none", fontSize: 13, padding: "8px 10px",
    borderRadius: 10, border: "1px solid #ddd", color: "#111", background: "#fff", whiteSpace: "nowrap" },
  desc: { marginTop: 10, fontSize: 13, lineHeight: 1.35, color: "#333", maxHeight: 90, overflow: "auto", paddingRight: 6 },
  thumbs: { marginTop: 12, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" },
  thumb: { width: 54, height: 54, objectFit: "cover", borderRadius: 12, border: "1px solid #eee" },
  more: { fontSize: 12, padding: "6px 10px", borderRadius: 999, background: "#f1f1f1" },
  hint: { display: "flex", justifyContent: "space-between", padding: "10px 14px", fontSize: 12, color: "#666",
    borderTop: "1px solid #f0f0f0", background: "#fafafa" },
  actions: { marginTop: 12, display: "flex", gap: 12, justifyContent: "space-between" },
  actionBtn: { flex: 1, padding: "12px 14px", borderRadius: 16, border: "1px solid #e7e7e7", cursor: "pointer", fontWeight: 700 },
};
