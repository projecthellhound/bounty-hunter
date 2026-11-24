import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildBrainDrilldown, buildBrainOverview, BrainData, BrainLayout, PlacedItem } from "./brainLayout";
import "./KnowledgeGraph.css";

interface Props {
  apiBase: string;
}

type Cam = { x: number; y: number; scale: number };
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const camDist = (a: Cam, b: Cam) => Math.hypot(a.x - b.x, a.y - b.y) + Math.abs(a.scale - b.scale) * 400;
const hash01 = (i: number) => { const v = Math.sin(i * 127.1 + 311.7) * 43758.5453; return v - Math.floor(v); };

/** The only place Beast's own brain is shown — lessons it's learned, the
 * methodology skills it can draw on, and the tools it can call. No target
 * ever appears here and there is no toggle to make one appear; a target's
 * own findings are a separate view, in the chat's right-hand dock. */
export default function Brain({ apiBase }: Props) {
  const [data, setData] = useState<BrainData | null>(null);
  const [drillHub, setDrillHub] = useState<string | null>(null);
  const [cam, setCam] = useState<Cam>({ x: 0, y: 0, scale: 1 });
  const [hover, setHover] = useState<string | null>(null);
  const [selected, setSelected] = useState<PlacedItem | null>(null);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const dragging = useRef(false);
  const dragStart = useRef({ x: 0, y: 0, camX: 0, camY: 0 });
  const didDrag = useRef(false);

  const camRef = useRef(cam);
  const camTarget = useRef(cam);
  const hoverEase = useRef(0);
  const pulsePhase = useRef(0);
  const layoutRef = useRef<BrainLayout | null>(null);
  const hoverRef = useRef<string | null>(null);
  const selectedRef = useRef<PlacedItem | null>(null);

  useEffect(() => {
    fetch(`${apiBase}/api/brain`).then((r) => r.json()).then(setData).catch(() => setData(null));
  }, [apiBase]);

  const layout: BrainLayout | null = useMemo(() => {
    if (!data) return null;
    if (drillHub) return buildBrainDrilldown(data, drillHub);
    return buildBrainOverview(data);
  }, [data, drillHub]);
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

  useEffect(() => {
    if (!layout) return;
    camTarget.current = fitCam(layout.worldRadius);
    setSelected(null);
    setHover(null);
  }, [layout, fitCam]);

  const toScreen = useCallback((x: number, y: number) => [x * cam.scale + cam.x, y * cam.scale + cam.y], [cam]);
  const toWorld = useCallback((sx: number, sy: number, c: Cam) => [(sx - c.x) / c.scale, (sy - c.y) / c.scale], []);

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

    const bezelR = l.worldRadius - 10;
    ctx.beginPath();
    ctx.strokeStyle = "#242424";
    ctx.lineWidth = 1 / c.scale;
    ctx.arc(0, 0, bezelR, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = "#333333";
    const tickCount = 72;
    for (let i = 0; i < tickCount; i++) {
      const a = (i / tickCount) * Math.PI * 2;
      const long = i % 6 === 0;
      const r0 = bezelR - (long ? 10 : 5), r1 = bezelR;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * r0, Math.sin(a) * r0);
      ctx.lineTo(Math.cos(a) * r1, Math.sin(a) * r1);
      ctx.stroke();
    }

    if (l.kind === "overview") {
      // The brain's heart — a soft glow at the center, standing in for
      // Beast itself (no single target node makes sense here).
      ctx.save();
      ctx.shadowColor = "#e5484d";
      ctx.shadowBlur = 20 * pulse;
      ctx.beginPath();
      ctx.fillStyle = "#f5f5f5";
      ctx.arc(0, 0, 8, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      ctx.beginPath();
      ctx.strokeStyle = "#e5484d";
      ctx.lineWidth = 1.4 / c.scale;
      ctx.arc(0, 0, 13 * pulse, 0, Math.PI * 2);
      ctx.stroke();

      for (const h of l.hubs) {
        const isHover = h.id === activeId;
        ctx.beginPath();
        ctx.strokeStyle = "#3a3a3a";
        ctx.globalAlpha = 0.3;
        ctx.lineWidth = 0.8 / c.scale;
        ctx.moveTo(0, 0);
        ctx.lineTo(h.x, h.y);
        ctx.stroke();
        ctx.globalAlpha = 1;

        const nbars = Math.max(4, Math.min(14, Math.round(Math.sqrt(h.count) * 2)));
        const hubDist = Math.hypot(h.x, h.y);
        for (let i = 0; i < nbars; i++) {
          const seed = h.id.length * 97 + i;
          const a = h.angle - h.span / 2 + ((i + 0.5) / nbars) * h.span;
          const barLen = 10 + hash01(seed) * 34;
          const r0 = hubDist + h.r + 7, r1 = r0 + barLen;
          ctx.beginPath();
          ctx.strokeStyle = "#3a3a3a";
          ctx.globalAlpha = 0.5 + hash01(seed + 50) * 0.3;
          ctx.lineWidth = Math.max(1.4, Math.min(4.5, h.r * 0.14)) / c.scale;
          ctx.moveTo(Math.cos(a) * r0, Math.sin(a) * r0);
          ctx.lineTo(Math.cos(a) * r1, Math.sin(a) * r1);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;

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
        ctx.arc(h.x, h.y, Math.max(1.6, h.r * 0.22), 0, Math.PI * 2);
        ctx.fill();
      }
    } else {
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
        ctx.globalAlpha = touches ? 0.6 + 0.3 * ease : 0.16;
        ctx.lineWidth = (touches ? lerp(0.8, 1.8, ease) : 0.7) / c.scale;
        const [x0, y0, x1, y1, x2, y2] = link.p;
        ctx.moveTo(x0, y0);
        ctx.quadraticCurveTo(x1, y1, x2, y2);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;

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

      for (const it of l.items) {
        const isActive = it.id === activeId;
        const grow = isActive ? lerp(1, 1.7, ease) : 1;
        ctx.beginPath();
        ctx.fillStyle = isActive ? "#ffffff" : "#b5b5b5";
        ctx.globalAlpha = isActive ? 1 : 0.85;
        ctx.arc(it.x, it.y, it.r * grow, 0, Math.PI * 2);
        ctx.fill();
        if (isActive && ease > 0.02) {
          ctx.beginPath();
          ctx.globalAlpha = ease;
          ctx.strokeStyle = "#e5484d";
          ctx.lineWidth = 1.2 / c.scale;
          ctx.arc(it.x, it.y, it.r * grow + 2.5, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }, []);

  const hitTest = useCallback((sx: number, sy: number): { id: string; item?: PlacedItem } | null => {
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
    let best: PlacedItem | null = null, bestD = tol;
    for (const it of l.items) {
      const d = Math.hypot(it.x - wx, it.y - wy);
      if (d < bestD) { bestD = d; best = it; }
    }
    return best ? { id: best.id, item: best } : null;
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
    setSelected(hit.item || null);
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
    const it = layout.items.find((ii) => ii.id === lab.itemId)!;
    return { ...lab, sx, sy, it };
  }) : [];
  const drillCaption = layout?.kind === "drilldown" ? (() => {
    const [sx, sy] = toScreen(0, 0);
    return { x: sx, y: sy - 34, label: layout.hub.label, count: layout.hub.count };
  })() : null;

  const totalKnown = (data?.hubs || []).reduce((s, h) => s + h.count, 0);
  const activeItem = selected;

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
              <span className="kg-hub-count">{l.count}</span>
            </div>
          ))}
          {drillLabels.map((lab) => (
            <div
              key={lab.itemId}
              className={`kg-drill-label side-${lab.side} ${(selected?.id || hover) === lab.itemId ? "hot" : ""}`}
              style={{ left: lab.sx, top: lab.sy }}
              onClick={(e) => { e.stopPropagation(); setSelected(lab.it); }}
            >
              <span className="kg-drill-sev" />
              <span className="kg-drill-text-col">
                <span className="kg-drill-meta">{lab.meta}</span>
                <span className="kg-drill-text">{lab.title}</span>
              </span>
            </div>
          ))}
          {drillCaption && (
            <div className="kg-drill-caption" style={{ left: drillCaption.x, top: drillCaption.y }}>
              <div className="kg-drill-caption-name">{drillCaption.label}</div>
              <div className="kg-drill-caption-count">{drillCaption.count}</div>
            </div>
          )}
        </div>

        <div className="kg-toolbar" onClick={(e) => e.stopPropagation()}>
          {drillHub && (
            <button className="kg-back" onClick={() => setDrillHub(null)}>← brain</button>
          )}
        </div>

        {!data && <div className="kg-empty">loading what Beast has learned…</div>}
        {data && totalKnown === 0 && (
          <div className="kg-empty">
            Nothing learned yet — no hunts recorded. Run Beast against a target and this fills in: lessons from
            what worked and failed, the skills it draws on, and the tools it has available.
          </div>
        )}
        <button className="kg-refit" onClick={(e) => { e.stopPropagation(); refit(); }} title="Fit to view">⤢</button>
      </div>

      {activeItem && (
        <div className="kg-detail">
          <div className="kg-detail-head">
            <span className="kg-lesson-outcome">{activeItem.hub}</span>
            <button className="kg-detail-close" onClick={() => setSelected(null)}>✕</button>
          </div>
          <div className="kg-detail-title">{activeItem.label}</div>
          {activeItem.meta && <div className="kg-detail-row">{activeItem.meta}</div>}
          {activeItem.detail && <div className="kg-detail-note">{activeItem.detail}</div>}
          {activeItem.tags.length > 0 && (
            <div className="kg-lesson-tags">
              {activeItem.tags.map((t) => <span key={t} className="kg-lesson-tag">{t}</span>)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
