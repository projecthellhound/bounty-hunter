// Geometry for the Knowledge Graph. Pure functions: given the raw graph data
// from /api/graph, compute a fixed "world space" position for every node.
// The renderer only ever rotates/scales/pans this — it never recomputes it.
//
// Two states, matching how HexBrain's own map works: a clean OVERVIEW (a
// ring of category hubs and how they relate — no individual report visible
// yet) and a DRILLDOWN you zoom into by clicking a hub, where that
// category's members fan out into a starburst with their own labels. The
// mistake in the first pass here was skipping straight to "always
// exploded" because Beast's per-target counts are tiny — which just made
// the overview look cluttered instead of clean. HexBrain stays clean at
// the overview level NOT because it has less data (it has 15,000+ reports)
// but because it defers the detail to a second, deliberate zoom-in step.

export const TAU = Math.PI * 2;
// The golden angle — the angle that, repeated, packs points as evenly as a
// sunflower's seeds (used across nature wherever things grow from a single
// point one at a time). A universal constant, not any one project's IP.
const GOLDEN = Math.PI * (3 - Math.sqrt(5));

const R_TARGET_RING = 70; // radius targets sit at, when there's more than one
const R_HUB = 230; // radius of the ring of category hubs
const MIN_HUB_SPAN = 0.12; // radians — a 1-finding hub still gets a visible wedge
const DRILL_DOT_SPACING = 17; // golden-angle disc spacing inside a drilldown
const LABEL_ROW = 22; // vertical spacing between stacked side-labels, world units
const LABEL_GAP = 64; // how far past the dot cluster a label column sits

export interface GraphData {
  center: string;
  targets: { id: string; label: string }[];
  hubs: { id: string; label: string; count: number }[];
  findings: {
    id: string; hub: string; target: string; severity: string; label: string;
    endpoint: string; note: string; hosts: string[]; report: string | null; report_target: string;
  }[];
  hosts: { id: string; label: string }[];
  artifacts: { id: string; target: string; label: string }[];
}

export type PlacedNode = { id: string; x: number; y: number; angle: number };
export type PlacedHub = PlacedNode & { label: string; count: number; r: number };
export type PlacedFinding = PlacedNode & GraphData["findings"][number] & { r: number };
export type PlacedSatellite = PlacedNode & { label: string; kind: "host" | "artifact" };
export type PlacedTarget = PlacedNode & { label: string };

export type CurveLink = { a: string; b: string; p: [number, number, number, number, number, number]; tone: "thread" | "cross" };
export type DrillLabel = { findingId: string; side: "left" | "right"; x: number; y: number; anchorX: number; anchorY: number };

export interface OverviewLayout {
  kind: "overview";
  targets: PlacedTarget[];
  hubs: PlacedHub[];
  links: CurveLink[];
  worldRadius: number;
}
export interface DrilldownLayout {
  kind: "drilldown";
  hub: { id: string; label: string; count: number };
  findings: PlacedFinding[];
  satellites: PlacedSatellite[];
  links: CurveLink[];
  labels: DrillLabel[];
  worldRadius: number;
}
export type GraphLayout = OverviewLayout | DrilldownLayout;

const pol = (r: number, a: number): [number, number] => [Math.cos(a) * r, Math.sin(a) * r];

function angDiff(a: number, b: number): number {
  let d = (a - b) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return Math.abs(d);
}

/** One golden-angle sunflower step: point j of n, roughly unit-spaced. */
function sunflower(j: number, spacing: number): [number, number] {
  const r = spacing * Math.sqrt(j + 0.5);
  const a = j * GOLDEN;
  return [Math.cos(a) * r, Math.sin(a) * r];
}

/** A gentle quadratic bezier between two points, control point pulled toward the
 * center by `pull` (0 = straight line, 1 = control point AT the center). */
function curve(ax: number, ay: number, bx: number, by: number, pull: number): [number, number, number, number, number, number] {
  return [ax, ay, ((ax + bx) / 2) * (1 - pull), ((ay + by) / 2) * (1 - pull), bx, by];
}

const meanAngle = (angles: number[], fallback: number): number => {
  if (!angles.length) return fallback;
  const sx = angles.reduce((s, a) => s + Math.cos(a), 0);
  const sy = angles.reduce((s, a) => s + Math.sin(a), 0);
  return Math.atan2(sy, sx);
};

/** Narrows the whole-Beast graph down to one target's own slice — a view
 * filter the Knowledge Graph applies client-side, entirely independent of
 * whatever the sidebar happens to have active. Hub counts are recomputed
 * from the filtered findings, not copied from the global totals. */
export function subgraph(data: GraphData, targetId: string | null): GraphData {
  if (!targetId) return data;
  const findings = data.findings.filter((f) => f.target === targetId);
  const hostIds = new Set(findings.flatMap((f) => f.hosts));
  const counts = new Map<string, number>();
  for (const f of findings) counts.set(f.hub, (counts.get(f.hub) || 0) + 1);
  return {
    center: data.targets.find((t) => t.id === targetId)?.label || data.center,
    targets: data.targets.filter((t) => t.id === targetId),
    hubs: data.hubs.filter((h) => counts.has(h.id)).map((h) => ({ ...h, count: counts.get(h.id)! })),
    findings,
    hosts: data.hosts.filter((h) => hostIds.has(h.id)),
    artifacts: data.artifacts.filter((a) => a.target === targetId),
  };
}

/** The clean overview: hubs on a ring, related to each other (sharing a
 * host) and to the targets they came from — but no individual finding is
 * drawn yet. That detail lives behind a click, in buildDrilldown. */
export function buildOverview(data: GraphData): OverviewLayout {
  const targets: PlacedTarget[] = data.targets.map((t, i) => {
    if (data.targets.length <= 1) return { ...t, x: 0, y: 0, angle: -Math.PI / 2 };
    const angle = -Math.PI / 2 + (i / data.targets.length) * TAU;
    const [x, y] = pol(R_TARGET_RING, angle);
    return { ...t, x, y, angle };
  });

  // Angular width per hub grows with sqrt(count) (so 4x the findings gets
  // ~2x the room, not 4x), floored so a lone finding still reads as its own
  // wedge. Biggest hub leads at the top.
  const weights = data.hubs.map((h) => Math.max(MIN_HUB_SPAN, Math.sqrt(h.count)));
  const totalWeight = weights.reduce((s, w) => s + w, 0) || 1;
  let cursor = -Math.PI / 2;
  const hubs: PlacedHub[] = data.hubs.map((h, i) => {
    const span = (weights[i] / totalWeight) * TAU;
    const angle = cursor + span / 2;
    cursor += span;
    const [x, y] = pol(R_HUB, angle);
    return { ...h, x, y, angle, r: 10 + Math.sqrt(h.count) * 5 };
  });

  // target -> hub threads (which categories a target actually contributed to)
  const links: CurveLink[] = [];
  const seenPair = new Set<string>();
  const targetById = new Map(targets.map((t) => [t.id, t]));
  const hubById = new Map(hubs.map((h) => [h.id, h]));
  for (const f of data.findings) {
    const key = f.target + "|" + f.hub;
    if (seenPair.has(key)) continue;
    seenPair.add(key);
    const t = targetById.get(f.target), h = hubById.get(f.hub);
    if (t && h) links.push({ a: t.id, b: h.id, p: curve(t.x, t.y, h.x, h.y, 0.2), tone: "thread" });
  }

  // hub -> hub cross-links where two categories share at least one host —
  // the real "these are connected" signal, pulled toward the center the
  // further apart the two hubs sit, same as HexBrain's class links.
  const hostsByHub = new Map<string, Set<string>>();
  for (const f of data.findings) {
    const set = hostsByHub.get(f.hub) ?? new Set<string>();
    for (const h of f.hosts) set.add(h);
    hostsByHub.set(f.hub, set);
  }
  const hubIds = [...hostsByHub.keys()];
  for (let i = 0; i < hubIds.length; i++) {
    for (let j = i + 1; j < hubIds.length; j++) {
      const a = hubById.get(hubIds[i]), b = hubById.get(hubIds[j]);
      if (!a || !b) continue;
      const shared = [...hostsByHub.get(hubIds[i])!].some((h) => hostsByHub.get(hubIds[j])!.has(h));
      if (!shared) continue;
      const pull = 0.35 + 0.5 * (angDiff(a.angle, b.angle) / Math.PI);
      links.push({ a: a.id, b: b.id, p: curve(a.x, a.y, b.x, b.y, pull), tone: "cross" });
    }
  }

  const worldRadius = R_HUB + 90;
  return { kind: "overview", targets, hubs, links, worldRadius };
}

/** Zoomed into one hub: its findings as a golden-angle starburst, the hosts
 * they touch as satellites, and labels sorted into two side columns (by
 * which side of center the dot fell on) with a leader line back to the
 * real dot — the HexBrain "opened strip" look, sized to however many
 * findings Beast actually recorded instead of hundreds. */
export function buildDrilldown(data: GraphData, hubId: string): DrilldownLayout {
  const hubMeta = data.hubs.find((h) => h.id === hubId) || { id: hubId, label: hubId, count: 0 };
  const mine = data.findings.filter((f) => f.hub === hubId);

  const findings: PlacedFinding[] = mine.map((f, j) => {
    const [x, y] = sunflower(j, DRILL_DOT_SPACING);
    return { ...f, x, y, angle: Math.atan2(y, x), r: f.severity === "critical" ? 7 : 5.5 };
  });

  const hostAngles = new Map<string, number[]>();
  for (const f of findings) for (const hid of f.hosts) hostAngles.set(hid, [...(hostAngles.get(hid) || []), f.angle]);
  const dotReach = Math.max(40, ...findings.map((f) => Math.hypot(f.x, f.y)));
  const satellites: PlacedSatellite[] = [];
  const hostIds = [...hostAngles.keys()];
  hostIds.forEach((hid, i) => {
    const meta = data.hosts.find((h) => h.id === hid);
    if (!meta) return;
    const angle = meanAngle(hostAngles.get(hid) || [], (i / Math.max(1, hostIds.length)) * TAU);
    const [x, y] = pol(dotReach + 70, angle);
    satellites.push({ ...meta, x, y, angle, kind: "host" });
  });

  const links: CurveLink[] = [];
  for (const f of findings) {
    for (const hid of f.hosts) {
      const host = satellites.find((s) => s.id === hid);
      if (!host) continue;
      const pull = 0.25 + 0.55 * (angDiff(f.angle, host.angle) / Math.PI);
      links.push({ a: f.id, b: hid, p: curve(f.x, f.y, host.x, host.y, pull), tone: "cross" });
    }
  }

  // Side columns: left (x < 0) vs right (x >= 0), each stacked top-to-bottom
  // in dot order so labels never collide, regardless of how tight the
  // sunflower packed the actual dots.
  const left = findings.filter((f) => f.x < 0).sort((a, b) => a.y - b.y);
  const right = findings.filter((f) => f.x >= 0).sort((a, b) => a.y - b.y);
  const labelX = dotReach + LABEL_GAP;
  const stack = (list: PlacedFinding[], side: "left" | "right"): DrillLabel[] => {
    const topY = -((list.length - 1) * LABEL_ROW) / 2;
    return list.map((f, i) => ({
      findingId: f.id, side,
      x: side === "left" ? -labelX : labelX,
      y: topY + i * LABEL_ROW,
      anchorX: f.x, anchorY: f.y,
    }));
  };
  const labels = [...stack(left, "left"), ...stack(right, "right")];

  const worldRadius = Math.max(160, dotReach + 70) + LABEL_GAP + 140;
  return { kind: "drilldown", hub: hubMeta, findings, satellites, links, labels, worldRadius };
}
