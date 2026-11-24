// Geometry for the Brain view — the same ring/disc/bezier-pull dial
// technique as layout.ts (adapted from HexBrain's vulnerability map), but
// for Beast's OWN knowledge instead of a target's findings: three fixed
// hubs — Lessons Learned, Skills, Tools — each opening into a starburst of
// its real items. No per-target data belongs here at all.

export const TAU = Math.PI * 2;
const GOLDEN = Math.PI * (3 - Math.sqrt(5));

const R_HUB = 190;
const DRILL_DOT_SPACING = 30;
const LABEL_ROW = 30;

export interface BrainData {
  hubs: { id: string; label: string; count: number }[];
  items: { id: string; hub: string; label: string; detail: string; meta: string; tags: string[] }[];
}

export type PlacedHub = { id: string; label: string; count: number; x: number; y: number; angle: number; span: number; r: number };
export type PlacedItem = BrainData["items"][number] & { x: number; y: number; angle: number; r: number };
export type CurveLink = { a: string; b: string; p: [number, number, number, number, number, number]; tone: "cross" };
export type BrainLabel = { itemId: string; side: "left" | "right"; x: number; y: number; anchorX: number; anchorY: number; title: string; meta: string };

export interface BrainOverview {
  kind: "overview";
  hubs: PlacedHub[];
  worldRadius: number;
}
export interface BrainDrilldown {
  kind: "drilldown";
  hub: { id: string; label: string; count: number };
  items: PlacedItem[];
  links: CurveLink[];
  labels: BrainLabel[];
  worldRadius: number;
}
export type BrainLayout = BrainOverview | BrainDrilldown;

const pol = (r: number, a: number): [number, number] => [Math.cos(a) * r, Math.sin(a) * r];

function angDiff(a: number, b: number): number {
  let d = (a - b) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return Math.abs(d);
}

function sunflower(j: number, n: number, spacing: number): [number, number] {
  const floor = 55 + Math.sqrt(n) * 14;
  const r = Math.max(floor, spacing * Math.sqrt(j + 0.5) + floor * 0.4);
  const a = j * GOLDEN;
  return [Math.cos(a) * r, Math.sin(a) * r];
}

function curve(ax: number, ay: number, bx: number, by: number, pull: number): [number, number, number, number, number, number] {
  return [ax, ay, ((ax + bx) / 2) * (1 - pull), ((ay + by) / 2) * (1 - pull), bx, by];
}

/** Fixed three-hub ring: always Lessons / Skills / Tools, in that order,
 * sized by how much is actually in each — never filtered, never a target. */
export function buildBrainOverview(data: BrainData): BrainOverview {
  const total = data.hubs.reduce((s, h) => s + Math.max(1, h.count), 0) || 1;
  let cursor = -Math.PI / 2;
  const hubs: PlacedHub[] = data.hubs.map((h) => {
    const weight = Math.max(1, h.count) / total;
    const span = weight * TAU;
    const angle = cursor + span / 2;
    cursor += span;
    const [x, y] = pol(R_HUB, angle);
    return { ...h, x, y, angle, span, r: 16 + Math.sqrt(Math.max(1, h.count)) * 5 };
  });
  return { kind: "overview", hubs, worldRadius: R_HUB + 90 };
}

/** Zoomed into one hub: its items as a golden-angle starburst with tag
 * cross-links (two lessons/skills sharing a tag get pulled toward each
 * other) and two-column labels, same grammar as the per-target dial. */
export function buildBrainDrilldown(data: BrainData, hubId: string): BrainDrilldown {
  const hubMeta = data.hubs.find((h) => h.id === hubId) || { id: hubId, label: hubId, count: 0 };
  const mine = data.items.filter((it) => it.hub === hubId);

  const items: PlacedItem[] = mine.map((it, j) => {
    const [x, y] = sunflower(j, mine.length, DRILL_DOT_SPACING);
    return { ...it, x, y, angle: Math.atan2(y, x), r: 5 };
  });

  // Cross-links between items that share a tag (lessons only carry tags
  // today; harmless no-op for skills/tools, which don't).
  const links: CurveLink[] = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i], b = items[j];
      if (!a.tags.length || !b.tags.length) continue;
      const shared = a.tags.some((t) => b.tags.includes(t));
      if (!shared) continue;
      const pull = 0.3 + 0.5 * (angDiff(a.angle, b.angle) / Math.PI);
      links.push({ a: a.id, b: b.id, p: curve(a.x, a.y, b.x, b.y, pull), tone: "cross" });
    }
  }

  const dotReach = Math.max(40, ...items.map((it) => Math.hypot(it.x, it.y)), 1);
  const left = items.filter((it) => it.x < 0).sort((a, b) => a.y - b.y);
  const right = items.filter((it) => it.x >= 0).sort((a, b) => a.y - b.y);
  const labelGap = Math.max(110, dotReach * 0.85);
  const labelX = dotReach + labelGap;
  const stack = (list: PlacedItem[], side: "left" | "right"): BrainLabel[] => {
    const topY = -((list.length - 1) * LABEL_ROW) / 2;
    return list.map((it, i) => ({
      itemId: it.id, side,
      x: side === "left" ? -labelX : labelX,
      y: topY + i * LABEL_ROW,
      anchorX: it.x, anchorY: it.y,
      title: it.label, meta: it.meta,
    }));
  };
  const labels = [...stack(left, "left"), ...stack(right, "right")];

  const worldRadius = Math.max(160, dotReach + 70) + labelGap + 160;
  return { kind: "drilldown", hub: hubMeta, items, links, labels, worldRadius };
}
