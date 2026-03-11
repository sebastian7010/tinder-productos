import { startTransition, useCallback, useEffect, useMemo, useState } from "react";
import { AnimatePresence, animate, motion, useMotionValue, useTransform } from "framer-motion";

const PRIMARY_CATALOG_PATH = "/catalogo-finalistas.json";
const CATALOG_CANDIDATES = [
  PRIMARY_CATALOG_PATH,
  "/catalogo-runtime.json",
  "/herramientas-bogota-kevin-aceptados%204.json",
  "/productos-imagenes-unicas.json",
  "/reciclaje-productos.json",
];

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

function resolveReviewerId() {
  const fromQuery = qparam("reviewer").trim();
  if (fromQuery) return fromQuery;
  return makeReviewerId();
}

function isInvalidTitle(value) {
  const text = `${value || ""}`.replace(/\s+/g, " ").trim();
  if (!text) return true;

  return /^(error|not found|page not found|product not available|access denied|forbidden|bad request)$/i.test(text);
}

function getReferenceLabel(raw) {
  if (typeof raw?.referencia === "string" && raw.referencia.trim()) {
    return raw.referencia.trim();
  }

  if (typeof raw?.descripcion === "string" && raw.descripcion.includes("|")) {
    const [reference] = raw.descripcion.split("|");
    return reference.trim();
  }

  return "";
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

  const referencia = getReferenceLabel(raw);
  const rawName = raw.nombre || raw.titulo || raw.title || "";
  const nombre = isInvalidTitle(rawName) ? referencia : rawName;

  return {
    id: String(raw.id ?? raw.itemId ?? raw.url ?? `idx_${idx}`),
    session_id: String(raw.session_id ?? ""),
    url: raw.url_producto || raw.url || raw.link || "",
    image_original_url: raw.url_imagen_origen || raw.meta?.remote_image || "",
    nombre,
    precio: raw.precio || raw.price || "",
    descripcion: raw.descripcion || raw.description || "",
    imagenes: images,
    referencia,
    fuente: raw.fuente || raw.source || "",
  };
}

function normalizeCatalog(sourceData) {
  const source = Array.isArray(sourceData)
    ? sourceData
    : Array.isArray(sourceData?.productos)
      ? sourceData.productos
      : [];

  const seen = new Set();
  const items = [];

  source.forEach((raw, idx) => {
    const normalized = normalizeItem(raw, idx);
    if (!normalized.id || seen.has(normalized.id)) return;

    seen.add(normalized.id);
    items.push({
      id: normalized.id,
      url: normalized.url,
      nombre: normalized.nombre,
      referencia: normalized.referencia,
      fuente: normalized.fuente,
      precio: normalized.precio,
      descripcion: normalized.descripcion,
      images: normalized.imagenes,
      imageOriginalUrl: normalized.image_original_url,
      raw: normalized,
    });
  });

  return items;
}

async function fetchLocalCatalog() {
  for (const candidate of CATALOG_CANDIDATES) {
    try {
      const response = await fetch(candidate, { cache: "no-store" });
      if (!response.ok) continue;

      const data = await response.json();
      const normalized = normalizeCatalog(data);
      if (normalized.length) return normalized;
    } catch {
      // Probamos el siguiente candidato.
    }
  }

  throw new Error(`No se pudo leer el catalogo local (${CATALOG_CANDIDATES.join(", ")})`);
}

function decisionStorageKey(sessionId, reviewerId) {
  return `decisions_local_v1:${sessionId}:${reviewerId}`;
}

function readStoredDecisions(sessionId, reviewerId) {
  try {
    const raw = localStorage.getItem(decisionStorageKey(sessionId, reviewerId));
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeStoredDecisions(sessionId, reviewerId, decisions) {
  localStorage.setItem(decisionStorageKey(sessionId, reviewerId), JSON.stringify(decisions));
}

async function readRemoteDecisions(sessionId, reviewerId) {
  const response = await fetch(
    `/api/session-state?session=${encodeURIComponent(sessionId)}&reviewer=${encodeURIComponent(reviewerId)}`,
    { cache: "no-store" },
  );

  if (!response.ok) {
    throw new Error(`API ${response.status}`);
  }

  const payload = await response.json();
  return payload && typeof payload.decisions === "object" ? payload.decisions : {};
}

async function syncRemoteDecisions(sessionId, reviewerId, decisions) {
  const response = await fetch("/api/session-state", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId,
      reviewerId,
      decisions,
    }),
  });

  if (!response.ok) {
    throw new Error(`API ${response.status}`);
  }
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

function slugify(value) {
  return `${value || ""}`
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "session";
}

function createExportFilename(sessionId, reviewerId, decisionKind) {
  const sessionSlug = slugify(sessionId);
  const suffix = decisionKind === "keep" ? "aceptados" : "rechazados";
  return `${sessionSlug}-${reviewerId}-${suffix}.json`;
}

function getActionTarget(action) {
  if (action === "accept") return Math.max(window.innerWidth * 0.9, 380);
  return -Math.max(window.innerWidth * 0.9, 380);
}

export default function App() {
  const [sessionId, setSessionId] = useState(() => qparam("session") || "finalistas-bogota");
  const reviewerId = useMemo(() => resolveReviewerId(), []);

  const [items, setItems] = useState([]);
  const [index, setIndex] = useState(0);
  const [imageIndex, setImageIndex] = useState(0);
  const [accepted, setAccepted] = useState(() => new Set());
  const [rejected, setRejected] = useState(() => new Set());
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(false);
  const [showPanel, setShowPanel] = useState(false);
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [persistenceMode, setPersistenceMode] = useState("local");

  const x = useMotionValue(0);
  const rotate = useTransform(x, [-280, 0, 280], [-12, 0, 12]);
  const opacity = useTransform(x, [-280, 0, 280], [0.8, 1, 0.8]);
  const MotionDiv = motion.div;

  const current = items[index] || null;
  const currentTitle = current?.referencia || current?.nombre || "(sin nombre)";
  const remaining = useMemo(() => Math.max(0, items.length - index), [items.length, index]);
  const progress = useMemo(() => {
    if (!items.length) return 0;
    return Math.round(((items.length - remaining) / items.length) * 100);
  }, [items.length, remaining]);
  const currentImage = current?.images?.[imageIndex] || null;
  const currentImageOpenUrl = current?.imageOriginalUrl || currentImage || current?.url || "";
  const shareUrl = `${window.location.origin}${window.location.pathname}?session=${encodeURIComponent(sessionId)}&reviewer=${encodeURIComponent(reviewerId)}`;
  const isLocalOnlyHost = /^(localhost|127\.0\.0\.1)$/i.test(window.location.hostname);

  const loadProducts = useCallback(async () => {
    setLoading(true);
    try {
      const catalog = await fetchLocalCatalog();
      let stored = {};
      let mode = "local";

      try {
        stored = await readRemoteDecisions(sessionId, reviewerId);
        writeStoredDecisions(sessionId, reviewerId, stored);
        mode = "server";
      } catch {
        stored = readStoredDecisions(sessionId, reviewerId);
      }

      const acceptedIds = Object.keys(stored).filter((id) => stored[id] === "keep");
      const rejectedIds = Object.keys(stored).filter((id) => stored[id] === "drop");
      const firstPendingIndex = catalog.findIndex((item) => !stored[item.id]);

      startTransition(() => {
        setItems(catalog);
        setIndex(firstPendingIndex === -1 ? catalog.length : firstPendingIndex);
        setAccepted(new Set(acceptedIds));
        setRejected(new Set(rejectedIds));
        setHistory([]);
        setImageIndex(0);
        setPersistenceMode(mode);
      });
      x.set(0);
    } catch (e) {
      alert("No pude cargar los productos locales.");
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [reviewerId, sessionId, x]);

  useEffect(() => {
    loadProducts();
  }, [loadProducts]);

  useEffect(() => {
    setImageIndex(0);
    x.set(0);
  }, [current?.id, x]);

  function saveDecision(productId, decision) {
    const stored = readStoredDecisions(sessionId, reviewerId);
    stored[productId] = decision;
    writeStoredDecisions(sessionId, reviewerId, stored);
    syncRemoteDecisions(sessionId, reviewerId, stored)
      .then(() => setPersistenceMode("server"))
      .catch(() => setPersistenceMode("local"));
  }

  function removeStoredDecision(productId) {
    const stored = readStoredDecisions(sessionId, reviewerId);
    delete stored[productId];
    writeStoredDecisions(sessionId, reviewerId, stored);
    syncRemoteDecisions(sessionId, reviewerId, stored)
      .then(() => setPersistenceMode("server"))
      .catch(() => setPersistenceMode("local"));
  }

  function resetLocal() {
    if (!confirm("Restablecer solo en este dispositivo?")) return;
    localStorage.removeItem(decisionStorageKey(sessionId, reviewerId));
    syncRemoteDecisions(sessionId, reviewerId, {})
      .then(() => setPersistenceMode("server"))
      .catch(() => setPersistenceMode("local"));
    setIndex(0);
    setAccepted(new Set());
    setRejected(new Set());
    setHistory([]);
    setImageIndex(0);
    x.set(0);
  }

  function getDecisionItems(decisionKind) {
    const selected = decisionKind === "keep" ? accepted : rejected;
    return items.filter((it) => selected.has(it.id)).map((it) => it.raw);
  }

  async function fetchRemoteDecisionItems(decisionKind) {
    const endpoint = `/api/exports?session=${encodeURIComponent(sessionId)}&reviewer=${encodeURIComponent(reviewerId)}&type=${decisionKind}`;
    const response = await fetch(endpoint, { cache: "no-store" });
    if (!response.ok) throw new Error(`API ${response.status}`);

    const payload = await response.json();
    if (decisionKind === "keep") return Array.isArray(payload.accepted) ? payload.accepted : [];
    return Array.isArray(payload.rejected) ? payload.rejected : [];
  }

  async function exportDecisions(decisionKind) {
    try {
      const remoteItems = await fetchRemoteDecisionItems(decisionKind);
      downloadJson(createExportFilename(sessionId, reviewerId, decisionKind), remoteItems);
      setPersistenceMode("server");
      return;
    } catch {
      // Si no hay backend remoto disponible, exportamos local.
    }

    const localItems = getDecisionItems(decisionKind);
    downloadJson(createExportFilename(sessionId, reviewerId, decisionKind), localItems);
  }

  async function exportAllDecisions() {
    await exportDecisions("keep");
    await exportDecisions("drop");
  }

  function applyDecisionState(id, action) {
    setHistory((prev) => [...prev, { id, action }]);

    if (action === "accept") {
      setAccepted((prev) => new Set([...prev, id]));
      setRejected((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      return;
    }

    setRejected((prev) => new Set([...prev, id]));
    setAccepted((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }

  async function shareSession() {
    if (isLocalOnlyHost) {
      alert("El link actual usa localhost y solo funciona en este dispositivo. Para que tu amigo entre desde Bogota, debes publicar la web en un dominio real o usar un tunel.");
      return;
    }

    if (navigator.share) {
      try {
        await navigator.share({
          title: "Tinder de productos",
          text: `Revisa esta sesion: ${sessionId}`,
          url: shareUrl,
        });
        return;
      } catch {
        // Si el usuario cancela, caemos al portapapeles.
      }
    }

    try {
      await navigator.clipboard.writeText(shareUrl);
      alert("Link copiado al portapapeles.");
    } catch {
      alert(`Comparte este link:\n${shareUrl}`);
    }
  }

  async function doAction(action) {
    if (!current || isTransitioning) return;

    const id = current.id;
    const direction = action === "accept" ? "keep" : "drop";

    setIsTransitioning(true);

    try {
      await animate(x, getActionTarget(action), {
        type: "spring",
        stiffness: 480,
        damping: 34,
        mass: 0.55,
      }).finished;
    } catch {
      // Si la animacion se interrumpe, igual avanzamos.
    }

    startTransition(() => {
      applyDecisionState(id, action);
      setIndex((prev) => Math.min(items.length, prev + 1));
      setImageIndex(0);
    });

    saveDecision(id, direction);
    x.set(0);
    setIsTransitioning(false);
  }

  function undo() {
    if (isTransitioning) return;

    setHistory((prev) => {
      if (!prev.length) return prev;
      const last = prev[prev.length - 1];

      if (last.action === "accept") {
        setAccepted((setValue) => {
          const next = new Set(setValue);
          next.delete(last.id);
          return next;
        });
      } else {
        setRejected((setValue) => {
          const next = new Set(setValue);
          next.delete(last.id);
          return next;
        });
      }

      removeStoredDecision(last.id);
      setIndex((prevIndex) => Math.max(0, prevIndex - 1));
      setImageIndex(0);
      x.set(0);

      return prev.slice(0, -1);
    });
  }

  function onDragEnd(_, info) {
    if (isTransitioning) return;

    const dx = info.offset.x;
    if (dx > 120) doAction("accept");
    else if (dx < -120) doAction("reject");
    else {
      animate(x, 0, { type: "spring", stiffness: 520, damping: 36, mass: 0.5 });
    }
  }

  function handleImageError() {
    if (!current?.images?.length) return;

    setImageIndex((prev) => {
      const nextIndex = prev + 1;
      return nextIndex < current.images.length ? nextIndex : current.images.length;
    });
  }

  return (
    <div style={styles.page}>
      <div style={styles.heroGlow} />

      <div style={styles.topBar}>
        <div style={styles.topStats}>
          <span style={styles.statPill}>Restantes: {remaining}</span>
          <span style={styles.statPill}>Progreso: {progress}%</span>
          <span style={styles.statPill}>Guardado: {persistenceMode === "server" ? "archivo" : "local"}</span>
        </div>
        <button style={styles.panelToggle} onClick={() => setShowPanel(true)}>Panel</button>
      </div>

      <AnimatePresence>
        {showPanel ? (
          <MotionDiv
            style={styles.panelOverlay}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setShowPanel(false)}
          >
            <MotionDiv
              style={styles.panelCard}
              initial={{ y: 24, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: 16, opacity: 0 }}
              transition={{ duration: 0.18, ease: "easeOut" }}
              onClick={(e) => e.stopPropagation()}
            >
              <div style={styles.panelHeader}>
                <div>
                  <div style={styles.panelTitle}>Panel de control</div>
                  <div style={styles.panelSub}>Solo para compartir, exportar y reiniciar.</div>
                </div>
                <button style={styles.panelClose} onClick={() => setShowPanel(false)}>Cerrar</button>
              </div>

              <div style={styles.panelGrid}>
                <div style={styles.panelRow}>
                  <span style={styles.miniBadge}>Session</span>
                  <input
                    value={sessionId}
                    onChange={(e) => setSessionId(e.target.value.trim() || "herramientas-bogota")}
                    style={styles.input}
                    title="Esto separa las decisiones locales por session"
                  />
                </div>

                <div style={styles.panelStats}>
                  <span style={styles.badge}>Keep: {accepted.size}</span>
                  <span style={styles.badge}>Drop: {rejected.size}</span>
                  <span style={styles.badge}>Restantes: {remaining}</span>
                  <span style={styles.badge}>Reviewer: {reviewerId}</span>
                  <span style={styles.badge}>Guardado: {persistenceMode === "server" ? "archivo" : "local"}</span>
                </div>

                <div style={styles.panelActions}>
                  <button style={styles.btn} onClick={shareSession}>Compartir link</button>
                  <button style={styles.btn} onClick={exportAllDecisions}>Exportar ambos</button>
                  <button style={styles.btn} onClick={() => exportDecisions("keep")}>Solo aceptados</button>
                  <button style={styles.btn} onClick={() => exportDecisions("drop")}>Solo rechazados</button>
                  <button style={styles.btn} onClick={loadProducts}>Recargar</button>
                  <button style={styles.btn} onClick={resetLocal}>Restablecer</button>
                </div>

                {isLocalOnlyHost ? (
                  <div style={styles.localWarning}>
                    Ese link usa `localhost`. Fuera de tu equipo no abre. En tu red local usa la IP LAN. Para Bogota, necesitas un dominio real o un tunel.
                  </div>
                ) : (
                  <div style={styles.shareBox}>
                    <div style={styles.shareLabel}>Link para compartir</div>
                    <div style={styles.shareUrl}>{shareUrl}</div>
                  </div>
                )}
              </div>
            </MotionDiv>
          </MotionDiv>
        ) : null}
      </AnimatePresence>

      <main style={styles.main}>
        {loading ? (
          <div style={styles.empty}>
            <h3 style={{ marginTop: 0 }}>Cargando...</h3>
          </div>
        ) : !items.length ? (
          <div style={styles.empty}>
            <h3 style={{ marginTop: 0 }}>No hay productos en el JSON local.</h3>
            <p>Revisa `public/catalogo-finalistas.json`.</p>
            <p>Comando: <code>npm run catalog:finalistas</code></p>
            {isLocalOnlyHost ? <p><b>Ojo:</b> `localhost` no le abre a otra persona fuera de tu equipo.</p> : null}
          </div>
        ) : !current ? (
          <div style={styles.empty}>
            <h3 style={{ marginTop: 0 }}>Revision terminada</h3>
            <p>Ya no hay mas productos pendientes.</p>
            <div style={styles.finishActions}>
              <button style={styles.btnPrimary} onClick={exportAllDecisions}>Descargar ambos JSONs</button>
              <button style={styles.btn} onClick={() => exportDecisions("keep")}>Solo aceptados</button>
              <button style={styles.btn} onClick={() => exportDecisions("drop")}>Solo rechazados</button>
            </div>
          </div>
        ) : (
          <div style={styles.stage}>
            <div style={styles.deck}>
              <div style={styles.ghostCard} />

              <MotionDiv
                key={current.id}
                drag="x"
                dragElastic={0.12}
                dragMomentum={false}
                dragTransition={{ bounceStiffness: 650, bounceDamping: 30, power: 0.2 }}
                dragConstraints={{ left: 0, right: 0 }}
                style={{ ...styles.card, x, rotate, opacity }}
                onDragEnd={onDragEnd}
                whileTap={{ scale: 0.995 }}
              >
                <div style={styles.imageArea}>
                  {currentImage ? (
                    currentImageOpenUrl ? (
                      <a
                        href={currentImageOpenUrl}
                        target="_blank"
                        rel="noreferrer"
                        style={styles.imageLink}
                        title="Abrir imagen en una pestana nueva"
                      >
                        <img
                          src={currentImage}
                          alt={currentTitle}
                          style={styles.imgMain}
                          onError={handleImageError}
                          referrerPolicy="no-referrer"
                          loading="eager"
                          decoding="async"
                        />
                      </a>
                    ) : (
                      <img
                        src={currentImage}
                        alt={currentTitle}
                        style={styles.imgMain}
                        onError={handleImageError}
                        referrerPolicy="no-referrer"
                        loading="eager"
                        decoding="async"
                      />
                    )
                  ) : (
                    <div style={styles.noImg}>
                      <div>Sin imagen disponible</div>
                      {current.url ? (
                        <a href={current.url} target="_blank" rel="noreferrer" style={styles.noImgLink}>
                          Abrir producto
                        </a>
                      ) : null}
                    </div>
                  )}
                </div>

                <div style={styles.content}>
                  <div style={styles.contentTop}>
                    <div>
                      <div style={styles.title}>{currentTitle}</div>
                      {current.precio ? <div style={styles.metaRow}><span style={styles.price}>{current.precio}</span></div> : null}
                    </div>
                    <div style={styles.linkRow}>
                      {currentImageOpenUrl ? (
                        <a href={currentImageOpenUrl} target="_blank" rel="noreferrer" style={styles.link}>Imagen</a>
                      ) : null}
                      {current.url ? (
                        <a href={current.url} target="_blank" rel="noreferrer" style={styles.link}>Abrir</a>
                      ) : null}
                    </div>
                  </div>
                </div>
              </MotionDiv>
            </div>

            <div style={styles.actionDock}>
              <button
                onClick={() => doAction("reject")}
                disabled={isTransitioning}
                style={{ ...styles.actionCircle, ...styles.rejectBtn, opacity: isTransitioning ? 0.55 : 1 }}
                aria-label="No lo tiene"
              >
                X
              </button>

              <button
                onClick={undo}
                disabled={!history.length || isTransitioning}
                style={{ ...styles.actionCircle, ...styles.undoBtn, opacity: !history.length || isTransitioning ? 0.45 : 1 }}
                aria-label="Rebobinar"
              >
                UNDO
              </button>

              <button
                onClick={() => doAction("accept")}
                disabled={isTransitioning}
                style={{ ...styles.actionCircle, ...styles.acceptBtn, opacity: isTransitioning ? 0.55 : 1 }}
                aria-label="Si lo tiene"
              >
                OK
              </button>
            </div>

            <div style={styles.actionLabels}>
              <span>No lo tiene</span>
              <span>Rebobinar</span>
              <span>Si lo tiene</span>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

const styles = {
  page: {
    minHeight: "100vh",
    fontFamily: "\"Segoe UI\", Tahoma, sans-serif",
    background: "linear-gradient(180deg, #eef3f8 0%, #f7f2e9 100%)",
    color: "#111",
    position: "relative",
    overflow: "hidden",
  },
  heroGlow: {
    position: "absolute",
    inset: "auto -10% 65% auto",
    width: 320,
    height: 320,
    borderRadius: 999,
    background: "radial-gradient(circle, rgba(31,125,95,0.18) 0%, rgba(31,125,95,0) 70%)",
    pointerEvents: "none",
  },
  topBar: {
    position: "sticky",
    top: 0,
    zIndex: 20,
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "14px 16px 8px",
    backdropFilter: "blur(8px)",
  },
  topStats: { display: "flex", gap: 8, flexWrap: "wrap" },
  statPill: {
    fontSize: 12,
    padding: "8px 12px",
    borderRadius: 999,
    background: "rgba(255,255,255,0.76)",
    border: "1px solid rgba(17,17,17,0.08)",
    boxShadow: "0 8px 20px rgba(17,17,17,0.04)",
  },
  panelToggle: {
    padding: "10px 14px",
    borderRadius: 999,
    border: "1px solid rgba(17,17,17,0.08)",
    background: "#111",
    color: "#fff",
    cursor: "pointer",
    fontWeight: 700,
  },
  panelOverlay: {
    position: "fixed",
    inset: 0,
    zIndex: 40,
    background: "rgba(17,17,17,0.36)",
    display: "flex",
    alignItems: "flex-end",
    justifyContent: "center",
    padding: 12,
  },
  panelCard: {
    width: "min(760px, 100%)",
    borderRadius: 24,
    background: "#fff",
    border: "1px solid rgba(17,17,17,0.08)",
    boxShadow: "0 24px 60px rgba(17,17,17,0.18)",
    padding: 18,
  },
  panelHeader: {
    display: "flex",
    justifyContent: "space-between",
    gap: 12,
    alignItems: "flex-start",
  },
  panelTitle: { fontSize: 20, fontWeight: 800 },
  panelSub: { marginTop: 4, fontSize: 13, color: "#666" },
  panelClose: {
    padding: "8px 12px",
    borderRadius: 999,
    border: "1px solid #ddd",
    background: "#fff",
    cursor: "pointer",
  },
  panelGrid: { marginTop: 16, display: "grid", gap: 14 },
  panelRow: { display: "grid", gap: 8 },
  miniBadge: { fontSize: 12, fontWeight: 700, color: "#444" },
  panelStats: { display: "flex", gap: 8, flexWrap: "wrap" },
  panelActions: { display: "flex", gap: 10, flexWrap: "wrap" },
  badge: { fontSize: 12, padding: "7px 11px", borderRadius: 999, background: "#f1f3f5" },
  btn: {
    padding: "10px 14px",
    borderRadius: 12,
    border: "1px solid #ddd",
    background: "#fff",
    cursor: "pointer",
  },
  btnPrimary: {
    padding: "11px 16px",
    borderRadius: 12,
    border: "1px solid #111",
    background: "#111",
    color: "#fff",
    cursor: "pointer",
    fontWeight: 700,
  },
  input: {
    padding: "10px 12px",
    borderRadius: 12,
    border: "1px solid #ddd",
    minWidth: 220,
  },
  shareBox: {
    padding: 12,
    borderRadius: 16,
    background: "#f7faf8",
    border: "1px solid #dfe9e4",
  },
  shareLabel: { fontSize: 12, fontWeight: 700, color: "#3b5647" },
  shareUrl: {
    marginTop: 6,
    fontSize: 12,
    lineHeight: 1.5,
    color: "#314338",
    wordBreak: "break-all",
  },
  localWarning: {
    padding: 12,
    borderRadius: 16,
    background: "#fff7e8",
    border: "1px solid #f0d89a",
    fontSize: 12,
    lineHeight: 1.5,
    color: "#6a4b00",
  },
  main: {
    minHeight: "calc(100vh - 60px)",
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
    padding: "8px 14px 28px",
  },
  empty: {
    width: "min(560px, 100%)",
    padding: 24,
    borderRadius: 24,
    background: "rgba(255,255,255,0.92)",
    border: "1px solid rgba(17,17,17,0.08)",
    boxShadow: "0 20px 50px rgba(17,17,17,0.08)",
  },
  finishActions: { marginTop: 14, display: "flex", gap: 10, flexWrap: "wrap" },
  stage: {
    width: "min(540px, 100%)",
    display: "grid",
    gap: 16,
    alignItems: "center",
  },
  deck: {
    position: "relative",
    width: "100%",
    minHeight: 0,
    paddingTop: 12,
  },
  ghostCard: {
    position: "absolute",
    inset: "22px 18px -10px 18px",
    borderRadius: 28,
    background: "rgba(255,255,255,0.42)",
    border: "1px solid rgba(17,17,17,0.05)",
    transform: "scale(0.98)",
  },
  card: {
    position: "relative",
    background: "rgba(255,255,255,0.96)",
    borderRadius: 28,
    border: "1px solid rgba(17,17,17,0.08)",
    overflow: "hidden",
    boxShadow: "0 22px 55px rgba(17,17,17,0.12)",
    cursor: "grab",
    userSelect: "none",
    touchAction: "pan-y",
    willChange: "transform",
  },
  imageArea: {
    aspectRatio: "1 / 1",
    maxHeight: "58vh",
    background: "linear-gradient(180deg, #101515 0%, #1e2424 100%)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  imgMain: {
    width: "100%",
    height: "100%",
    objectFit: "contain",
    display: "block",
    background: "#f6f6f6",
  },
  imageLink: {
    display: "block",
    width: "100%",
    height: "100%",
  },
  noImg: {
    color: "#fff",
    opacity: 0.86,
    display: "flex",
    flexDirection: "column",
    gap: 10,
    alignItems: "center",
  },
  noImgLink: { color: "#fff", textDecoration: "underline", fontSize: 13 },
  content: { padding: 16 },
  contentTop: { display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start" },
  linkRow: { display: "flex", gap: 8, alignItems: "center" },
  title: { fontSize: 24, fontWeight: 800, lineHeight: 1.1, letterSpacing: "-0.02em" },
  metaRow: { marginTop: 10, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" },
  sourceChip: {
    fontSize: 12,
    padding: "6px 10px",
    borderRadius: 999,
    background: "#eef4ff",
    color: "#21406f",
    textTransform: "capitalize",
  },
  price: {
    fontSize: 13,
    fontWeight: 700,
    padding: "6px 10px",
    borderRadius: 999,
    background: "#eef9f0",
    color: "#1b5c32",
  },
  referenceLine: { marginTop: 10, fontSize: 13, color: "#555", lineHeight: 1.4 },
  link: {
    alignSelf: "flex-start",
    textDecoration: "none",
    fontSize: 13,
    padding: "10px 12px",
    borderRadius: 12,
    border: "1px solid #ddd",
    color: "#111",
    background: "#fff",
    whiteSpace: "nowrap",
  },
  actionDock: {
    display: "grid",
    gridTemplateColumns: "1fr auto 1fr",
    gap: 14,
    alignItems: "center",
    width: "100%",
  },
  actionCircle: {
    width: "100%",
    minHeight: 68,
    borderRadius: 999,
    border: "none",
    cursor: "pointer",
    fontSize: 24,
    fontWeight: 800,
    boxShadow: "0 14px 30px rgba(17,17,17,0.10)",
  },
  rejectBtn: {
    background: "linear-gradient(180deg, #fff1f1 0%, #ffd8d8 100%)",
    color: "#a32929",
  },
  undoBtn: {
    width: 84,
    minWidth: 84,
    background: "linear-gradient(180deg, #ffffff 0%, #eef1f4 100%)",
    color: "#25313b",
    border: "1px solid rgba(17,17,17,0.08)",
    fontSize: 12,
    letterSpacing: "0.08em",
  },
  acceptBtn: {
    background: "linear-gradient(180deg, #f0fff3 0%, #c8f2d1 100%)",
    color: "#15703f",
  },
  actionLabels: {
    display: "grid",
    gridTemplateColumns: "1fr auto 1fr",
    gap: 14,
    fontSize: 12,
    color: "#5f6871",
    textAlign: "center",
  },
};
