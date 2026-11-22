// Geometry for the Knowledge Graph. Pure functions: given the raw graph data
// from /api/graph, compute a fixed "world space" position for every node.
// The renderer only ever rotates/scales/pans this — it never recomputes it.
//
// The idea (not the code) is borrowed from HexBrain's vulnerability map: a
// ring of category hubs, each one's members opened into a golden-angle
// "sunflower" disc hanging off it, with cross-links pulled toward the
// center in proportion to how far apart their two ends sit on the ring.
// HexBrain visualizes 15,000+ reports across multiple nested indices; a
// single Beast target has a handful of findings, so this stays to one ring
// — no nested drill-down dials needed at this scale.

export const TAU = Math.PI * 2;
// The golden angle — the angle that, repeated, packs points as evenly as a
// sunflower's seeds (used across nature wherever things grow from a single
// point one at a time). A universal constant, not any one project's IP.
const GOLDEN = Math.PI * (3 - Math.sqrt(5));

const R_TARGET_RING = 70; // radius targets sit at, when there's more than one (program view)
const R_HUB = 210; // radius of the ring of category hubs
const DISC_OFFSET = 46; // how far beyond a hub its findings' disc starts
const R_SATELLITE = R_HUB + DISC_OFFSET + 150; // radius hosts/artifacts orbit at
const MIN_HUB_SPAN = 0.12; // radians — a 1-finding hub still gets a visible wedge

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

export interface Layout {
  targets: PlacedTarget[];
  hubs: PlacedHub[];
  findings: PlacedFinding[];
  satellites: PlacedSatellite[];
  links: CurveLink[];
  worldRadius: number; // for the initial fit-to-view zoom
}

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

/** Rotate a local (x, y) offset by `angle`, so a disc "grows" outward from the ring. */
function rot(x: number, y: number, angle: number): [number, number] {
  const c = Math.cos(angle), s = Math.sin(angle);
  return [x * c - y * s, x * s + y * c];
}

/** A gentle quadratic bezier between two points, control point pulled toward the
 * center by `pull` (0 = straight line, 1 = control point AT the center). */
function curve(ax: number, ay: number, bx: number, by: number, pull: number): [number, number, number, number, number, number] {
  return [ax, ay, ((ax + bx) / 2) * (1 - pull), ((ay + by) / 2) * (1 - pull), bx, by];
}

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

export function buildLayout(data: GraphData): Layout {
  // 1. Targets: one at the very center, or — in a program view — several on
  // a small inner ring, so chat's "which target" and the graph's "whole
  // program" both stay visible at once.
  const targets: PlacedTarget[] = data.targets.map((t, i) => {
    if (data.targets.length <= 1) return { ...t, x: 0, y: 0, angle: -Math.PI / 2 };
    const angle = -Math.PI / 2 + (i / data.targets.length) * TAU;
    const [x, y] = pol(R_TARGET_RING, angle);
    return { ...t, x, y, angle };
  });
  const targetById = new Map(targets.map((t) => [t.id, t]));

  // 2. Hubs round the main ring. Angular width per hub grows with sqrt(count)
  // (so a hub with 4x the findings gets ~2x the room, not 4x), floored so a
  // lone finding still reads as its own wedge. Biggest hub leads at the top.
  const weights = data.hubs.map((h) => Math.max(MIN_HUB_SPAN, Math.sqrt(h.count)));
  const totalWeight = weights.reduce((s, w) => s + w, 0) || 1;
  let cursor = -Math.PI / 2;
  const hubs: PlacedHub[] = data.hubs.map((h, i) => {
    const span = (weights[i] / totalWeight) * TAU;
    const angle = cursor + span / 2;
    cursor += span;
    const [x, y] = pol(R_HUB, angle);
    return { ...h, x, y, angle, r: 9 + Math.sqrt(h.count) * 4.5 };
  });
  const hubById = new Map(hubs.map((h) => [h.id, h]));

  // 3. Every finding opens straight into its hub's disc — at Beast's scale
  // (single digits to a few dozen per hub) there's no value in a
  // collapsed "strip" state the user has to click open first.
  const findingsByHub = new Map<string, number>();
  const findings: PlacedFinding[] = data.findings.map((f) => {
    const hub = hubById.get(f.hub);
    const j = findingsByHub.get(f.hub) ?? 0;
    findingsByHub.set(f.hub, j + 1);
    if (!hub) return { ...f, x: 0, y: 0, angle: 0, r: 5 };
    const [lx, ly] = sunflower(j, 13);
    const [rx, ry] = rot(lx, ly, hub.angle);
    const [ox, oy] = pol(R_HUB + DISC_OFFSET, hub.angle);
    return { ...f, x: ox + rx, y: oy + ry, angle: hub.angle, r: f.severity === "critical" ? 5.5 : 4.5 };
  });

  // 4. Hosts/artifacts orbit further out, each at the circular mean angle of
  // the findings that actually reference it — so a host shared by findings
  // in two different categories settles visually between them, not at an
  // arbitrary fixed slot.
  const meanAngle = (angles: number[], fallback: number): number => {
    if (!angles.length) return fallback;
    const sx = angles.reduce((s, a) => s + Math.cos(a), 0);
    const sy = angles.reduce((s, a) => s + Math.sin(a), 0);
    return Math.atan2(sy, sx);
  };
  const hostAngles = new Map<string, number[]>();
  for (const f of findings) {
    for (const hid of f.hosts) hostAngles.set(hid, [...(hostAngles.get(hid) || []), f.angle]);
  }
  const satellites: PlacedSatellite[] = [];
  data.hosts.forEach((h, i) => {
    const angle = meanAngle(hostAngles.get(h.id) || [], (i / Math.max(1, data.hosts.length)) * TAU);
    const [x, y] = pol(R_SATELLITE, angle);
    satellites.push({ ...h, x, y, angle, kind: "host" });
  });
  // Artifacts belong to a target, not a category — scatter them in a small
  // sunflower just outside that target's position instead of the far ring.
  const artifactsByTarget = new Map<string, number>();
  data.artifacts.forEach((a) => {
    const t = targetById.get(a.target);
    const j = artifactsByTarget.get(a.target) ?? 0;
    artifactsByTarget.set(a.target, j + 1);
    const [lx, ly] = sunflower(j, 9);
    const baseX = t ? t.x : 0, baseY = t ? t.y : 0;
    satellites.push({ ...a, x: baseX + lx + 24, y: baseY + ly, angle: 0, kind: "artifact" });
  });

  // 5. Links: a faint thread from every finding back to its target, and a
  // brighter cross-link from every finding to each host it touches — pulled
  // toward the center in proportion to the angular distance between the two
  // ends, so links within one category stay near the rim and links that
  // span opposite sides of the ring dive through the middle.
  const links: CurveLink[] = [];
  for (const f of findings) {
    const t = targetById.get(f.target);
    if (t) links.push({ a: t.id, b: f.id, p: curve(t.x, t.y, f.x, f.y, 0.22), tone: "thread" });
    for (const hid of f.hosts) {
      const host = satellites.find((s) => s.id === hid);
      if (!host) continue;
      const pull = 0.25 + 0.55 * (angDiff(f.angle, host.angle) / Math.PI);
      links.push({ a: f.id, b: hid, p: curve(f.x, f.y, host.x, host.y, pull), tone: "cross" });
    }
  }
  for (const a of data.artifacts) {
    const t = targetById.get(a.target);
    const art = satellites.find((s) => s.id === a.id);
    if (t && art) links.push({ a: t.id, b: a.id, p: curve(t.x, t.y, art.x, art.y, 0.1), tone: "thread" });
  }

  const allX = [...hubs, ...findings, ...satellites, ...targets].map((n) => Math.abs(n.x));
  const allY = [...hubs, ...findings, ...satellites, ...targets].map((n) => Math.abs(n.y));
  const worldRadius = Math.max(200, ...allX, ...allY) + 40;

  return { targets, hubs, findings, satellites, links, worldRadius };
}
