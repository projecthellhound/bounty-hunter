import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildLayout, GraphData, Layout, PlacedFinding } from "./layout";
import "./KnowledgeGraph.css";

type Scope = { kind: "target"; name: string } | { kind: "program"; name: string };

const SEV_COLOR: Record<string, string> = {
  critical: "#e5484d",
  high: "#e5484d",
  medium: "#d0a060",
  low: "#8a8a8a",
  info: "#5e5e5e",
  informational: "#5e5e5e",
};

interface Props {
  scope: Scope;
  apiBase: string;
  onViewReport: (title: string, file: string, target: string) => void;
}

export default function KnowledgeGraph({ scope, apiBase, onViewReport }: Props) {
  const [data, setData] = useState<GraphData | null>(null);
  const [cam, setCam] = useState({ x: 0, y: 0, scale: 1 });
  const [hover, setHover] = useState<PlacedFinding | null>(null);
  const [selected, setSelected] = useState<PlacedFinding | null>(null);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const dragging = useRef(false);
  const dragStart = useRef({ x: 0, y: 0, camX: 0, camY: 0 });
  const didDrag = useRef(false);

  useEffect(() => {
    const qs = scope.kind === "program" ? `program=${encodeURIComponent(scope.name)}` : `target=${encodeURIComponent(scope.name)}`;
    fetch(`${apiBase}/api/graph?${qs}`).then((r) => r.json()).then(setData).catch(() => setData(null));
    setSelected(null);
    setHover(null);
  }, [scope, apiBase]);

  const layout: Layout | null = useMemo(() => (data ? buildLayout(data) : null), [data]);

  // Fit the whole graph in view the moment its size is known.
  useEffect(() => {
    if (!layout || !wrapRef.current) return;
    const { width, height } = wrapRef.current.getBoundingClientRect();
    const scale = Math.max(0.12, Math.min(width, height) / (layout.worldRadius * 2.3));
    setCam({ x: width / 2, y: height / 2, scale });
  }, [layout]);

  const toScreen = useCallback((x: number, y: number) => [x * cam.scale + cam.x, y * cam.scale + cam.y], [cam]);
  const toWorld = useCallback((x: number, y: number) => [(x - cam.x) / cam.scale, (y - cam.y) / cam.scale], [cam]);

  // ── drawing ──────────────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current, wrap = wrapRef.current;
    if (!canvas || !wrap || !layout) return;
    const dpr = window.devicePixelRatio || 1;
    const { width, height } = wrap.getBoundingClientRect();
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.save();
    ctx.translate(cam.x, cam.y);
    ctx.scale(cam.scale, cam.scale);

    const activeId = (hover || selected)?.id;

    // Links
    for (const link of layout.links) {
      const touchesActive = activeId && (link.a === activeId || link.b === activeId);
      ctx.beginPath();
      ctx.strokeStyle = touchesActive ? "#e5484d" : link.tone === "cross" ? "#8a8a8a" : "#3a3a3a";
      ctx.globalAlpha = touchesActive ? 0.85 : link.tone === "cross" ? 0.16 : 0.22;
      ctx.lineWidth = (touchesActive ? 1.6 : 0.7) / cam.scale;
      const [x0, y0, x1, y1, x2, y2] = link.p;
      ctx.moveTo(x0, y0);
      ctx.quadraticCurveTo(x1, y1, x2, y2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // Satellites (hosts/artifacts)
    for (const s of layout.satellites) {
      ctx.beginPath();
      ctx.fillStyle = s.kind === "host" ? "#949494" : "#5e5e5e";
      ctx.arc(s.x, s.y, 3, 0, Math.PI * 2);
      ctx.fill();
    }

    // Targets
    for (const t of layout.targets) {
      ctx.beginPath();
      ctx.fillStyle = "#f5f5f5";
      ctx.arc(t.x, t.y, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.strokeStyle = "#e5484d";
      ctx.lineWidth = 1.2 / cam.scale;
      ctx.arc(t.x, t.y, 11, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Hubs (category ring)
    for (const h of layout.hubs) {
      ctx.beginPath();
      ctx.fillStyle = "#181818";
      ctx.strokeStyle = "#d4d4d4";
      ctx.lineWidth = 1.1 / cam.scale;
      ctx.arc(h.x, h.y, h.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    // Findings (dots, colored by severity)
    for (const f of layout.findings) {
      const isActive = f.id === activeId;
      ctx.beginPath();
      ctx.fillStyle = SEV_COLOR[f.severity] || "#949494";
      ctx.globalAlpha = isActive ? 1 : 0.85;
      ctx.arc(f.x, f.y, isActive ? f.r * 1.7 : f.r, 0, Math.PI * 2);
      ctx.fill();
      if (isActive) {
        ctx.beginPath();
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 1.2 / cam.scale;
        ctx.arc(f.x, f.y, f.r * 1.7 + 2.5, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }, [layout, cam, hover, selected]);

  // ── interaction ──────────────────────────────────────────────────────────
  const findingAt = useCallback((sx: number, sy: number): PlacedFinding | null => {
    if (!layout) return null;
    const [wx, wy] = toWorld(sx, sy);
    let best: PlacedFinding | null = null, bestD = 14 / cam.scale;
    for (const f of layout.findings) {
      const d = Math.hypot(f.x - wx, f.y - wy);
      if (d < bestD) { bestD = d; best = f; }
    }
    return best;
  }, [layout, toWorld, cam.scale]);

  const onMouseDown = (e: React.MouseEvent) => {
    dragging.current = true;
    didDrag.current = false;
    dragStart.current = { x: e.clientX, y: e.clientY, camX: cam.x, camY: cam.y };
  };
  const onMouseMove = (e: React.MouseEvent) => {
    if (dragging.current) {
      const dx = e.clientX - dragStart.current.x, dy = e.clientY - dragStart.current.y;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) didDrag.current = true;
      setCam((c) => ({ ...c, x: dragStart.current.camX + dx, y: dragStart.current.camY + dy }));
      return;
    }
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect) return;
    setHover(findingAt(e.clientX - rect.left, e.clientY - rect.top));
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
    const newScale = Math.max(0.08, Math.min(5, cam.scale * factor));
    const rect = wrapRef.current?.getBoundingClientRect();
    const mx = rect ? e.clientX - rect.left : cam.x, my = rect ? e.clientY - rect.top : cam.y;
    setCam((c) => ({
      scale: newScale,
      x: mx - (mx - c.x) * (newScale / c.scale),
      y: my - (my - c.y) * (newScale / c.scale),
    }));
  };

  const refit = () => {
    if (!layout || !wrapRef.current) return;
    const { width, height } = wrapRef.current.getBoundingClientRect();
    const scale = Math.max(0.12, Math.min(width, height) / (layout.worldRadius * 2.3));
    setCam({ x: width / 2, y: height / 2, scale });
  };

  const hubLabels = layout?.hubs.map((h) => {
    const [sx, sy] = toScreen(h.x, h.y);
    const rightSide = Math.cos(h.angle) >= 0;
    return { id: h.id, label: h.label, count: h.count, x: sx, y: sy, align: rightSide ? "left" : "right" as const };
  }) || [];

  const activeFinding = selected || hover;

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
        {!data && <div className="kg-empty">loading knowledge graph…</div>}
        {data && layout && layout.findings.length === 0 && (
          <div className="kg-empty">No recorded findings yet for this {scope.kind} — the graph fills in as Beast records them.</div>
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
