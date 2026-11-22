import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildLayout, GraphData, Layout, PlacedFinding, subgraph } from "./layout";
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
  // happens to be active in the sidebar — it fetches everything once and
  // filters client-side, so switching targets elsewhere in the app never
  // empties it out.
  const [data, setData] = useState<GraphData | null>(null);
  const [filterTarget, setFilterTarget] = useState<string>("");
  const [cam, setCam] = useState<Cam>({ x: 0, y: 0, scale: 1 });
  const [hover, setHover] = useState<PlacedFinding | null>(null);
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
  const hoverEase = useRef(0); // 0..1, eased toward "something is hovered/selected"
  const pulsePhase = useRef(0);
  const layoutRef = useRef<Layout | null>(null);
  const hoverRef = useRef<PlacedFinding | null>(null);
  const selectedRef = useRef<PlacedFinding | null>(null);

  useEffect(() => {
    fetch(`${apiBase}/api/graph`).then((r) => r.json()).then(setData).catch(() => setData(null));
  }, [apiBase]);

  const filteredData = useMemo(() => (data ? subgraph(data, filterTarget || null) : null), [data, filterTarget]);
  const layout: Layout | null = useMemo(() => (filteredData ? buildLayout(filteredData) : null), [filteredData]);
  useEffect(() => { layoutRef.current = layout; }, [layout]);
  useEffect(() => { hoverRef.current = hover; }, [hover]);
  useEffect(() => { selectedRef.current = selected; }, [selected]);

  const fitCam = useCallback((l: Layout): Cam => {
    const wrap = wrapRef.current;
    if (!wrap) return { x: 0, y: 0, scale: 1 };
    const { width, height } = wrap.getBoundingClientRect();
    const scale = Math.max(0.08, Math.min(width, height) / (l.worldRadius * 2.3));
    return { x: width / 2, y: height / 2, scale };
  }, []);

  // Fit the graph in view the moment its size is known, or whenever the
  // in-view filter changes what's being shown. Eased by the animation loop
  // below rather than snapped, for the "zooms smoothly into place" feel.
  useEffect(() => {
    if (!layout) return;
    camTarget.current = fitCam(layout);
    setSelected(null);
    setHover(null);
  }, [layout, fitCam]);

  const toScreen = useCallback((x: number, y: number) => [x * cam.scale + cam.x, y * cam.scale + cam.y], [cam]);
  const toWorld = useCallback((sx: number, sy: number, c: Cam) => [(sx - c.x) / c.scale, (sy - c.y) / c.scale], []);

  // ── one continuous render loop: eases the camera toward its target,
  // eases the hover highlight in/out, advances a slow idle pulse on the
  // center node(s), and redraws every frame — this is what makes zoom/fit/
  // hover feel like motion instead of a snap. ─────────────────────────────
  useEffect(() => {
    let raf = 0, last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(48, now - last);
      last = now;

      if (camDist(camRef.current, camTarget.current) > 0.02) {
        camRef.current = {
          x: lerp(camRef.current.x, camTarget.current.x, 0.16),
          y: lerp(camRef.current.y, camTarget.current.y, 0.16),
          scale: lerp(camRef.current.scale, camTarget.current.scale, 0.16),
        };
        setCam(camRef.current);
      }
      const hoverGoal = hoverRef.current || selectedRef.current ? 1 : 0;
      hoverEase.current = lerp(hoverEase.current, hoverGoal, 0.22);
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
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.save();
    ctx.translate(c.x, c.y);
    ctx.scale(c.scale, c.scale);

    const active = selectedRef.current || hoverRef.current;
    const activeId = active?.id;
    const ease = hoverEase.current;

    // Outer bezel — a quiet ring framing the whole dial, like a dashboard face.
    if (l.hubs.length) {
      ctx.beginPath();
      ctx.strokeStyle = "#242424";
      ctx.lineWidth = 1 / c.scale;
      ctx.arc(0, 0, 210 + 46 + 56, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Links
    for (const link of l.links) {
      const touchesActive = activeId && (link.a === activeId || link.b === activeId);
      ctx.beginPath();
      ctx.strokeStyle = touchesActive ? "#e5484d" : link.tone === "cross" ? "#8a8a8a" : "#3a3a3a";
      ctx.globalAlpha = touchesActive ? 0.55 + 0.35 * ease : link.tone === "cross" ? 0.16 : 0.22;
      ctx.lineWidth = (touchesActive ? lerp(0.7, 1.7, ease) : 0.7) / c.scale;
      const [x0, y0, x1, y1, x2, y2] = link.p;
      ctx.moveTo(x0, y0);
      ctx.quadraticCurveTo(x1, y1, x2, y2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // Satellites (hosts/artifacts)
    for (const s of l.satellites) {
      ctx.beginPath();
      ctx.fillStyle = s.kind === "host" ? "#949494" : "#5e5e5e";
      ctx.arc(s.x, s.y, 3, 0, Math.PI * 2);
      ctx.fill();
    }

    // Targets — a slow breathing glow so the center never looks static.
    const pulse = 1 + Math.sin(pulsePhase.current) * 0.08;
    for (const t of l.targets) {
      const isCurrent = activeTarget && t.label === activeTarget;
      ctx.save();
      ctx.shadowColor = "#e5484d";
      ctx.shadowBlur = (isCurrent ? 16 : 8) * pulse;
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

    // Hubs (category ring) — a bullseye so each reads as a hub, not a hole.
    for (const h of l.hubs) {
      ctx.beginPath();
      ctx.fillStyle = "#181818";
      ctx.strokeStyle = "#d4d4d4";
      ctx.lineWidth = 1.1 / c.scale;
      ctx.arc(h.x, h.y, h.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.fillStyle = "#4a4a4a";
      ctx.arc(h.x, h.y, Math.max(1.4, h.r * 0.22), 0, Math.PI * 2);
      ctx.fill();
    }

    // Findings (dots, colored by severity) — active one eases larger, not snaps.
    for (const f of l.findings) {
      const isActive = f.id === activeId;
      const grow = isActive ? lerp(1, 1.7, ease) : 1;
      ctx.beginPath();
      ctx.fillStyle = SEV_COLOR[f.severity] || "#949494";
      ctx.globalAlpha = isActive ? lerp(0.85, 1, ease) : 0.85;
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
    ctx.restore();
  }, [activeTarget]);

  // ── interaction ──────────────────────────────────────────────────────────
  const findingAt = useCallback((sx: number, sy: number): PlacedFinding | null => {
    const l = layoutRef.current;
    if (!l) return null;
    const [wx, wy] = toWorld(sx, sy, camRef.current);
    let best: PlacedFinding | null = null, bestD = 14 / camRef.current.scale;
    for (const f of l.findings) {
      const d = Math.hypot(f.x - wx, f.y - wy);
      if (d < bestD) { bestD = d; best = f; }
    }
    return best;
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
      camTarget.current = next; // dragging is 1:1, no easing lag
      setCam(next);
      return;
    }
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect) return;
    const f = findingAt(e.clientX - rect.left, e.clientY - rect.top);
    setHover(f);
    if (wrapRef.current) wrapRef.current.style.cursor = f ? "pointer" : dragging.current ? "grabbing" : "grab";
  };
  const onMouseUp = () => { dragging.current = false; };
  const onClick = (e: React.MouseEvent) => {
    if (didDrag.current) return;
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect) return;
    setSelected(findingAt(e.clientX - rect.left, e.clientY - rect.top));
  };
  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const factor = e.deltaY > 0 ? 0.9 : 1.11;
    const base = camTarget.current;
    const newScale = Math.max(0.08, Math.min(5, base.scale * factor));
    const rect = wrapRef.current?.getBoundingClientRect();
    const mx = rect ? e.clientX - rect.left : base.x, my = rect ? e.clientY - rect.top : base.y;
    camTarget.current = {
      scale: newScale,
      x: mx - (mx - base.x) * (newScale / base.scale),
      y: my - (my - base.y) * (newScale / base.scale),
    };
  };

  const refit = () => { if (layout) camTarget.current = fitCam(layout); };

  const hubLabels = layout?.hubs.map((h) => {
    const [sx, sy] = toScreen(h.x, h.y);
    const rightSide = Math.cos(h.angle) >= 0;
    return { id: h.id, label: h.label, count: h.count, x: sx, y: sy, align: rightSide ? "left" : "right" as const };
  }) || [];

  const activeFinding = selected || hover;
  const targetOptions = useMemo(
    () => [...(data?.targets || [])].sort((a, b) => a.label.localeCompare(b.label)),
    [data]
  );

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
          {hubLabels.map((l) => (
            <div key={l.id} className={`kg-hub-label align-${l.align}`} style={{ left: l.x, top: l.y }}>
              <span className="kg-hub-name">{l.label}</span>
              <span className="kg-hub-count">{l.count} finding{l.count === 1 ? "" : "s"}</span>
            </div>
          ))}
        </div>
        <div className="kg-filter">
          <select value={filterTarget} onChange={(e) => setFilterTarget(e.target.value)}>
            <option value="">All of Beast ({data?.targets.length ?? 0} targets)</option>
            {targetOptions.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
          </select>
        </div>
        {!data && <div className="kg-empty">loading knowledge graph…</div>}
        {data && layout && layout.findings.length === 0 && (
          <div className="kg-empty">
            {filterTarget ? "No recorded findings yet for this target." : "No findings recorded anywhere yet — the graph fills in as Beast records them."}
          </div>
        )}
        <button className="kg-refit" onClick={refit} title="Fit to view">⤢</button>
      </div>

      {activeFinding && (
        <div className="kg-detail">
          <div className="kg-detail-head">
            <span className={`kg-detail-sev sev-${activeFinding.severity}`}>{activeFinding.severity}</span>
            <button className="kg-detail-close" onClick={() => setSelected(null)}>✕</button>
          </div>
          <div className="kg-detail-title">{activeFinding.label || activeFinding.hub}</div>
          {activeFinding.target && <div className="kg-detail-row">target: {activeFinding.target.replace(/^target:/, "")}</div>}
          {activeFinding.endpoint && <div className="kg-detail-row">{activeFinding.endpoint}</div>}
          {activeFinding.note && <div className="kg-detail-note">{activeFinding.note}</div>}
          {activeFinding.hosts.length > 0 && (
            <div className="kg-detail-row">hosts: {activeFinding.hosts.map((h) => h.replace(/^host:/, "")).join(", ")}</div>
          )}
          {activeFinding.report && (
            <button
              className="kg-detail-report"
              onClick={() => onViewReport(activeFinding.label || "report", activeFinding.report!, activeFinding.report_target)}
            >
              view report
            </button>
          )}
        </div>
      )}
    </div>
  );
}
