import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildDrilldown, buildOverview, GraphData, GraphLayout, PlacedFinding, subgraph } from "./layout";
import "./KnowledgeGraph.css";

const SEV_COLOR: Record<string, string> = {
  critical: "#e5484d",
  high: "#e5484d",
  medium: "#d0a060",
  low: "#8a8a8a",
  info: "#5e5e5e",
  informational: "#5e5e5e",
};

interface Props {
  activeTarget?: string;
  apiBase: string;
  onViewReport: (title: string, file: string, target: string) => void;
}

type Cam = { x: number; y: number; scale: number };
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const camDist = (a: Cam, b: Cam) => Math.hypot(a.x - b.x, a.y - b.y) + Math.abs(a.scale - b.scale) * 400;

export default function KnowledgeGraph({ activeTarget, apiBase, onViewReport }: Props) {
  // This is the whole-Beast knowledge graph, not a view of whatever target
  // happens to be active in the sidebar — fetched once, filtered and
  // drilled into entirely client-side.
  const [data, setData] = useState<GraphData | null>(null);
  const [filterTarget, setFilterTarget] = useState<string>("");
  const [filterOpen, setFilterOpen] = useState(false);
  const [drillHub, setDrillHub] = useState<string | null>(null);
  const [cam, setCam] = useState<Cam>({ x: 0, y: 0, scale: 1 });
  const [hover, setHover] = useState<string | null>(null);
  const [selected, setSelected] = useState<PlacedFinding | null>(null);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const dragging = useRef(false);
  const dragStart = useRef({ x: 0, y: 0, camX: 0, camY: 0 });
  const didDrag = useRef(false);

  // Smooth-motion state lives in refs, read fresh every animation frame —
  // decoupled from React's render cycle so the canvas stays at 60fps
  // regardless of how often the surrounding UI re-renders.
  const camRef = useRef(cam);
  const camTarget = useRef(cam);
  const hoverEase = useRef(0);
  const pulsePhase = useRef(0);
  const layoutRef = useRef<GraphLayout | null>(null);
  const hoverRef = useRef<string | null>(null);
  const selectedRef = useRef<PlacedFinding | null>(null);

  useEffect(() => {
    fetch(`${apiBase}/api/graph`).then((r) => r.json()).then(setData).catch(() => setData(null));
  }, [apiBase]);

  const filteredData = useMemo(() => (data ? subgraph(data, filterTarget || null) : null), [data, filterTarget]);
  const layout: GraphLayout | null = useMemo(() => {
    if (!filteredData) return null;
    if (drillHub) return buildDrilldown(filteredData, drillHub);
    return buildOverview(filteredData);
  }, [filteredData, drillHub]);
  useEffect(() => { layoutRef.current = layout; }, [layout]);
  useEffect(() => { hoverRef.current = hover; }, [hover]);
  useEffect(() => { selectedRef.current = selected; }, [selected]);

  const fitCam = useCallback((worldRadius: number): Cam => {
    const wrap = wrapRef.current;
    if (!wrap) return { x: 0, y: 0, scale: 1 };
    const { width, height } = wrap.getBoundingClientRect();
    const scale = Math.max(0.06, Math.min(width, height) / (worldRadius * 2.3));
    return { x: width / 2, y: height / 2, scale };
  }, []);

  // Re-fit (eased) whenever the layout changes — including the overview <->
  // drilldown transition, so clicking a hub reads as "zooming into it".
  useEffect(() => {
    if (!layout) return;
    camTarget.current = fitCam(layout.worldRadius);
    setSelected(null);
    setHover(null);
  }, [layout, fitCam]);

  const toScreen = useCallback((x: number, y: number) => [x * cam.scale + cam.x, y * cam.scale + cam.y], [cam]);
  const toWorld = useCallback((sx: number, sy: number, c: Cam) => [(sx - c.x) / c.scale, (sy - c.y) / c.scale], []);

  // ── one continuous render loop ───────────────────────────────────────────
  useEffect(() => {
    let raf = 0, last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(48, now - last);
      last = now;
      if (camDist(camRef.current, camTarget.current) > 0.02) {
        camRef.current = {
          x: lerp(camRef.current.x, camTarget.current.x, 0.15),
          y: lerp(camRef.current.y, camTarget.current.y, 0.15),
          scale: lerp(camRef.current.scale, camTarget.current.scale, 0.15),
        };
        setCam(camRef.current);
      }
      hoverEase.current = lerp(hoverEase.current, hoverRef.current || selectedRef.current ? 1 : 0, 0.22);
      pulsePhase.current += dt * 0.0022;
      draw();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const draw = useCallback(() => {
    const canvas = canvasRef.current, wrap = wrapRef.current, l = layoutRef.current;
    if (!canvas || !wrap) return;
    const dpr = window.devicePixelRatio || 1;
    const { width, height } = wrap.getBoundingClientRect();
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx || !l) return;
    const c = camRef.current;
    const pulse = 1 + Math.sin(pulsePhase.current) * 0.08;
    const activeId = selectedRef.current?.id || hoverRef.current || undefined;
    const ease = hoverEase.current;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.save();
    ctx.translate(c.x, c.y);
    ctx.scale(c.scale, c.scale);

    // Outer bezel — a quiet ring framing the dial, like a dashboard face.
    ctx.beginPath();
    ctx.strokeStyle = "#242424";
    ctx.lineWidth = 1 / c.scale;
    ctx.arc(0, 0, l.worldRadius - 10, 0, Math.PI * 2);
    ctx.stroke();

    if (l.kind === "overview") {
      for (const link of l.links) {
        const touches = activeId && (link.a === activeId || link.b === activeId);
        ctx.beginPath();
        ctx.strokeStyle = touches ? "#e5484d" : link.tone === "cross" ? "#8a8a8a" : "#3a3a3a";
        ctx.globalAlpha = touches ? 0.6 + 0.3 * ease : link.tone === "cross" ? 0.22 : 0.18;
        ctx.lineWidth = (touches ? lerp(0.8, 1.8, ease) : link.tone === "cross" ? 0.9 : 0.7) / c.scale;
        const [x0, y0, x1, y1, x2, y2] = link.p;
        ctx.moveTo(x0, y0);
        ctx.quadraticCurveTo(x1, y1, x2, y2);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;

      for (const t of l.targets) {
        const isCurrent = activeTarget && t.label === activeTarget;
        ctx.save();
        ctx.shadowColor = "#e5484d";
        ctx.shadowBlur = (isCurrent ? 18 : 9) * pulse;
        ctx.beginPath();
        ctx.fillStyle = "#f5f5f5";
        ctx.arc(t.x, t.y, 7, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
        ctx.beginPath();
        ctx.strokeStyle = "#e5484d";
        ctx.lineWidth = (isCurrent ? 2 : 1.2) / c.scale;
        ctx.arc(t.x, t.y, 11 * pulse, 0, Math.PI * 2);
        ctx.stroke();
      }

      for (const h of l.hubs) {
        const isHover = h.id === activeId;
        ctx.save();
        ctx.shadowColor = "#ffffff";
        ctx.shadowBlur = isHover ? lerp(0, 14, ease) : 0;
        ctx.beginPath();
        ctx.fillStyle = "#181818";
        ctx.strokeStyle = isHover ? "#ffffff" : "#d4d4d4";
        ctx.lineWidth = (isHover ? lerp(1.1, 2, ease) : 1.1) / c.scale;
        ctx.arc(h.x, h.y, h.r * (isHover ? lerp(1, 1.12, ease) : 1), 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.restore();
        ctx.beginPath();
        ctx.fillStyle = "#555555";
        ctx.arc(h.x, h.y, Math.max(1.6, h.r * 0.24), 0, Math.PI * 2);
        ctx.fill();
      }
    } else {
      // Drilldown: leader lines first (dotted, quiet), then cross-links,
      // then satellites, then the findings themselves, biggest/brightest on top.
      ctx.save();
      ctx.setLineDash([1.2 / c.scale, 3 / c.scale]);
      ctx.strokeStyle = "#4a4a4a";
      ctx.globalAlpha = 0.55;
      ctx.lineWidth = 0.8 / c.scale;
      for (const lab of l.labels) {
        ctx.beginPath();
        ctx.moveTo(lab.anchorX, lab.anchorY);
        ctx.lineTo(lab.x, lab.y);
        ctx.stroke();
      }
      ctx.restore();

      for (const link of l.links) {
        const touches = activeId && (link.a === activeId || link.b === activeId);
        ctx.beginPath();
        ctx.strokeStyle = touches ? "#e5484d" : "#8a8a8a";
        ctx.globalAlpha = touches ? 0.6 + 0.3 * ease : 0.18;
        ctx.lineWidth = (touches ? lerp(0.8, 1.8, ease) : 0.8) / c.scale;
        const [x0, y0, x1, y1, x2, y2] = link.p;
        ctx.moveTo(x0, y0);
        ctx.quadraticCurveTo(x1, y1, x2, y2);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;

      for (const s of l.satellites) {
        ctx.beginPath();
        ctx.fillStyle = s.kind === "host" ? "#949494" : "#5e5e5e";
        ctx.arc(s.x, s.y, 3, 0, Math.PI * 2);
        ctx.fill();
      }

      // Hub caption, re-centered — the thing this whole view opened from.
      ctx.save();
      ctx.shadowColor = "#e5484d";
      ctx.shadowBlur = 14 * pulse;
      ctx.beginPath();
      ctx.fillStyle = "#f5f5f5";
      ctx.arc(0, 0, 9, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      ctx.beginPath();
      ctx.strokeStyle = "#e5484d";
      ctx.lineWidth = 1.4 / c.scale;
      ctx.arc(0, 0, 14 * pulse, 0, Math.PI * 2);
      ctx.stroke();

      for (const f of l.findings) {
        const isActive = f.id === activeId;
        const grow = isActive ? lerp(1, 1.7, ease) : 1;
        ctx.beginPath();
        ctx.fillStyle = SEV_COLOR[f.severity] || "#949494";
        ctx.globalAlpha = isActive ? lerp(0.85, 1, ease) : 0.9;
        ctx.arc(f.x, f.y, f.r * grow, 0, Math.PI * 2);
        ctx.fill();
        if (isActive && ease > 0.02) {
          ctx.beginPath();
          ctx.globalAlpha = ease;
          ctx.strokeStyle = "#ffffff";
          ctx.lineWidth = 1.2 / c.scale;
          ctx.arc(f.x, f.y, f.r * grow + 2.5, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }, [activeTarget]);

  // ── interaction ──────────────────────────────────────────────────────────
  const hitTest = useCallback((sx: number, sy: number): { id: string; finding?: PlacedFinding } | null => {
    const l = layoutRef.current;
    if (!l) return null;
    const [wx, wy] = toWorld(sx, sy, camRef.current);
    const tol = 14 / camRef.current.scale;
    if (l.kind === "overview") {
      for (const h of l.hubs) {
        if (Math.hypot(h.x - wx, h.y - wy) < Math.max(h.r, tol)) return { id: h.id };
      }
      return null;
    }
    let best: PlacedFinding | null = null, bestD = tol;
    for (const f of l.findings) {
      const d = Math.hypot(f.x - wx, f.y - wy);
      if (d < bestD) { bestD = d; best = f; }
    }
    return best ? { id: best.id, finding: best } : null;
  }, [toWorld]);

  const onMouseDown = (e: React.MouseEvent) => {
    dragging.current = true;
    didDrag.current = false;
    dragStart.current = { x: e.clientX, y: e.clientY, camX: camRef.current.x, camY: camRef.current.y };
  };
  const onMouseMove = (e: React.MouseEvent) => {
    if (dragging.current) {
      const dx = e.clientX - dragStart.current.x, dy = e.clientY - dragStart.current.y;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) didDrag.current = true;
      const next = { ...camRef.current, x: dragStart.current.camX + dx, y: dragStart.current.camY + dy };
      camRef.current = next;
      camTarget.current = next;
      setCam(next);
      return;
    }
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect) return;
    const hit = hitTest(e.clientX - rect.left, e.clientY - rect.top);
    setHover(hit?.id || null);
    if (wrapRef.current) wrapRef.current.style.cursor = hit ? "pointer" : "grab";
  };
  const onMouseUp = () => { dragging.current = false; };
  const onClick = (e: React.MouseEvent) => {
    if (didDrag.current) return;
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect) return;
    const hit = hitTest(e.clientX - rect.left, e.clientY - rect.top);
    if (!hit) { setSelected(null); return; }
    if (layoutRef.current?.kind === "overview") { setDrillHub(hit.id); return; }
    setSelected(hit.finding || null);
  };
  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const factor = e.deltaY > 0 ? 0.9 : 1.11;
    const base = camTarget.current;
    const newScale = Math.max(0.05, Math.min(6, base.scale * factor));
    const rect = wrapRef.current?.getBoundingClientRect();
    const mx = rect ? e.clientX - rect.left : base.x, my = rect ? e.clientY - rect.top : base.y;
    camTarget.current = {
      scale: newScale,
      x: mx - (mx - base.x) * (newScale / base.scale),
      y: my - (my - base.y) * (newScale / base.scale),
    };
  };
  const refit = () => { if (layout) camTarget.current = fitCam(layout.worldRadius); };

  const overviewLabels = layout?.kind === "overview" ? layout.hubs.map((h) => {
    const [sx, sy] = toScreen(h.x, h.y);
    const rightSide = Math.cos(h.angle) >= 0;
    return { id: h.id, label: h.label, count: h.count, x: sx, y: sy, align: rightSide ? "left" : "right" as const };
  }) : [];
  const drillLabels = layout?.kind === "drilldown" ? layout.labels.map((lab) => {
    const [sx, sy] = toScreen(lab.x, lab.y);
    const f = layout.findings.find((ff) => ff.id === lab.findingId)!;
    return { ...lab, sx, sy, f };
  }) : [];
  const drillCaption = layout?.kind === "drilldown" ? (() => {
    const [sx, sy] = toScreen(0, 0);
    return { x: sx, y: sy - 34, label: layout.hub.label, count: layout.hub.count };
  })() : null;

  const targetOptions = useMemo(
    () => [...(data?.targets || [])].sort((a, b) => a.label.localeCompare(b.label)),
    [data]
  );
  const filterLabel = filterTarget
    ? targetOptions.find((t) => t.id === filterTarget)?.label || filterTarget
    : `All of Beast (${data?.targets.length ?? 0} targets)`;

  return (
    <div className="kg-root">
      <div
        className="kg-canvas-wrap"
        ref={wrapRef}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseUp}
        onClick={onClick}
        onWheel={onWheel}
      >
        <canvas ref={canvasRef} className="kg-canvas" />
        <div className="kg-labels">
          {overviewLabels.map((l) => (
            <div
              key={l.id}
              className={`kg-hub-label align-${l.align} ${hover === l.id ? "hot" : ""}`}
              style={{ left: l.x, top: l.y }}
              onClick={(e) => { e.stopPropagation(); setDrillHub(l.id); }}
            >
              <span className="kg-hub-name">{l.label}</span>
              <span className="kg-hub-count">{l.count} finding{l.count === 1 ? "" : "s"}</span>
            </div>
          ))}
          {drillLabels.map((lab) => (
            <div
              key={lab.findingId}
              className={`kg-drill-label side-${lab.side} ${(selected?.id || hover) === lab.findingId ? "hot" : ""}`}
              style={{ left: lab.sx, top: lab.sy }}
              onClick={(e) => { e.stopPropagation(); setSelected(lab.f); }}
            >
              <span className={`kg-drill-sev sev-${lab.f.severity}`} />
              <span className="kg-drill-text">{lab.f.label || lab.f.hub}</span>
            </div>
          ))}
          {drillCaption && (
            <div className="kg-drill-caption" style={{ left: drillCaption.x, top: drillCaption.y }}>
              <div className="kg-drill-caption-name">{drillCaption.label}</div>
              <div className="kg-drill-caption-count">{drillCaption.count} finding{drillCaption.count === 1 ? "" : "s"}</div>
            </div>
          )}
        </div>

        <div className="kg-toolbar" onClick={(e) => e.stopPropagation()}>
          {drillHub && (
            <button className="kg-back" onClick={() => setDrillHub(null)}>← all categories</button>
          )}
          <div className="kg-filter">
            <button className="kg-filter-btn" onClick={() => setFilterOpen((v) => !v)}>
              {filterLabel} <span className="kg-filter-caret">▾</span>
            </button>
            {filterOpen && (
              <div className="kg-filter-menu" onMouseLeave={() => setFilterOpen(false)}>
                <button
                  className={!filterTarget ? "active" : ""}
                  onClick={() => { setFilterTarget(""); setFilterOpen(false); }}
                >
                  All of Beast ({data?.targets.length ?? 0} targets)
                </button>
                {targetOptions.map((t) => (
                  <button
                    key={t.id}
                    className={filterTarget === t.id ? "active" : ""}
                    onClick={() => { setFilterTarget(t.id); setFilterOpen(false); }}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {!data && <div className="kg-empty">loading knowledge graph…</div>}
        {data && layout?.kind === "overview" && layout.hubs.length === 0 && (
          <div className="kg-empty">
            {filterTarget ? "No recorded findings yet for this target." : "No findings recorded anywhere yet — the graph fills in as Beast records them."}
          </div>
        )}
        <button className="kg-refit" onClick={(e) => { e.stopPropagation(); refit(); }} title="Fit to view">⤢</button>
      </div>

      {selected && (
        <div className="kg-detail">
          <div className="kg-detail-head">
            <span className={`kg-detail-sev sev-${selected.severity}`}>{selected.severity}</span>
            <button className="kg-detail-close" onClick={() => setSelected(null)}>✕</button>
          </div>
          <div className="kg-detail-title">{selected.label || selected.hub}</div>
          {selected.target && <div className="kg-detail-row">target: {selected.target.replace(/^target:/, "")}</div>}
          {selected.endpoint && <div className="kg-detail-row">{selected.endpoint}</div>}
          {selected.note && <div className="kg-detail-note">{selected.note}</div>}
          {selected.hosts.length > 0 && (
            <div className="kg-detail-row">hosts: {selected.hosts.map((h) => h.replace(/^host:/, "")).join(", ")}</div>
          )}
          {selected.report && (
            <button
              className="kg-detail-report"
              onClick={() => onViewReport(selected.label || "report", selected.report!, selected.report_target)}
            >
              view report
            </button>
          )}
        </div>
      )}
    </div>
  );
}
