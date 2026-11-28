import type { DatabaseSync } from "node:sqlite";
import { beastStore, BEAST_CATEGORIES } from "./beastData";
import { classOf, guessWeakness, sevIndex, STATUSES } from "./taxonomy";

export type ReportRow = {
  id: number;
  title: string;
  program: string | null;
  program_name: string | null;
  severity: string | null;
  weakness: string | null;
  cve_ids: string | null;
  bounty: number | null;
  votes: number;
  reporter: string | null;
  substate: string | null;
  asset_type: string | null;
  asset: string | null;
  disclosed_at: string | null;
  submitted_at: string | null;
  summary: string | null;
  body: string | null;
  detail_at: string | null;
  weakness_guess: string | null;
  logo?: string | null;
};

export type Leaf = [number | string, string, number, number, number, string];

export type GraphWeakness = { name: string; count: number; bounty: number; sev: string };
export type GraphClass = { id: string; name: string; count: number; bounty: number; weaknesses: GraphWeakness[] };
export type GraphProgram = {
  name: string;
  count: number;
  bounty: number;
  logo: string | null;
  classes: [string, number][];
  byClass: [cls: string, sev: string][];
};

export type GraphYear = { year: number; months: number[][] };

export type GraphSurface = {
  program: string;
  total: number;
  branches: [name: string, domain: string, count: number][];
};

export type Graph = {
  stamp: number;
  cveYears: GraphYear[];
  cveRing: { id: string; name: string }[];
  surfaces: GraphSurface[];
  total: number;
  withBody: number;
  programs: number;
  weaknessCount: number;
  totalBounty: number;
  classes: GraphClass[];
  links: [string, string, number][];
  topPrograms: GraphProgram[];
};

export function db(): DatabaseSync {
  // Mock / dummy handle for backward compatibility
  return {} as DatabaseSync;
}

export function getGraph(): Graph {
  const g = beastStore.getGraph();
  return {
    ...g,
    topPrograms: g.programs,
    programs: g.programs.length,
    withBody: g.total,
  };
}

export function getLeaves(names: string[]): Leaf[] {
  return beastStore.getLeaves(names);
}

export function getProgramLeaves(program: string, cls: string): Leaf[] {
  return beastStore.getProgramLeaves(program, cls);
}

export function getProgramDots(program: string): Record<string, number[]> {
  const g = getGraph();
  const prog = g.topPrograms.find((p) => p.name === program);
  if (!prog) return {};

  const out: Record<string, number[]> = {};
  for (const [cls, sevStr] of prog.byClass) {
    const list = getProgramLeaves(program, cls);
    out[cls] = list.map((_, i) => i);
  }
  return out;
}

export async function getReport(id: number | string): Promise<ReportRow | undefined> {
  const r = beastStore.getReport(id);
  return r || undefined;
}

export type ListQuery = {
  q?: string;
  weakness?: string;
  cls?: string;
  program?: string;
  status?: string;
  sort?: string;
  offset?: number;
  limit?: number;
};

export function listReports(o: ListQuery) {
  const allLeaves = beastStore.getLeaves(
    o.weakness ? o.weakness.split("|") : BEAST_CATEGORIES.flatMap((c) => c.skills)
  );

  let filtered = allLeaves;
  if (o.q) {
    const qLower = o.q.toLowerCase();
    filtered = filtered.filter((l) => String(l[1]).toLowerCase().includes(qLower));
  }
  if (o.program) {
    filtered = filtered.filter((l) => l[5] === o.program);
  }

  const offset = o.offset || 0;
  const limit = o.limit || 30;
  const paged = filtered.slice(offset, offset + limit);

  return {
    total: filtered.length,
    rows: paged.map((l) => ({
      id: l[0] as number,
      title: l[1],
      program: l[5],
      severity: l[2] === 0 ? "critical" : l[2] === 1 ? "high" : "medium",
      weakness: o.weakness || "Methodology",
      bounty: l[3],
      votes: l[4],
      reporter: "Beast",
      disclosed_at: "2026-11-20T00:00:00Z",
      substate: "resolved",
    })),
  };
}

export function getSurfaces(): GraphSurface[] {
  return beastStore.getGraph().surfaces;
}

export function defenceCounts(): Record<string, number> {
  return {
    "WAF Bypass": 8,
    "403 Bypass": 12,
    "JWT Signature Manipulation": 14,
    "GraphQL Batching": 6,
    "CORS Credential Exfiltration": 5,
    "IDOR Sequence Enumeration": 9,
  };
}

export function reportsByDefence(tag: string, limit = 100) {
  const g = getGraph();
  return listReports({ limit }).rows;
}

export function relatedReports(r: ReportRow, n = 6) {
  const list = beastStore.getLeaves([r.weakness || "Methodology"]);
  return list
    .filter((l) => l[0] !== r.id)
    .slice(0, n)
    .map((l) => ({
      id: l[0] as number,
      title: l[1],
      program: l[5],
      severity: l[2] === 0 ? "critical" : l[2] === 1 ? "high" : "medium",
      bounty: l[3],
      votes: l[4],
    }));
}

export const PROGRAM_SQL = "program";
export const WEAK_SQL = "weakness";
