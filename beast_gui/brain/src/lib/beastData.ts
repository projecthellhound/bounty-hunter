import fs from "node:fs";
import path from "node:path";
import type { Graph, GraphClass, GraphWeakness, GraphProgram, GraphYear, GraphSurface, Leaf, ReportRow } from "./db";

// The brain app runs with its cwd at <repo>/beast_gui/brain, so the skills
// directory is two levels up — resolved from the repo, never a hardcoded home
// path, so a fresh clone works anywhere.
const SKILLS_DIR = process.env.BEAST_SKILLS_DIR || path.resolve(process.cwd(), "..", "..", "hellhound", "skills");
const TARGETS_DIR = path.join(process.env.HOME || "/home/joe", ".beast", "targets");
const LESSONS_PATH = path.join(process.env.HOME || "/home/joe", ".beast", "lessons.json");
// Written by the GUI backend on launch (beast_gui/backend/server.py::_dump_tools_feed)
// from the live TOOL_REGISTRY — the real tools the agent can call.
const TOOLS_PATH = path.join(process.env.HOME || "/home/joe", ".beast", "tools.json");

// Tool families — the ~100 real tools grouped by function so they render as
// their own hubs in the brain, alongside (but distinct from) the skill
// categories. First family whose keyword matches the tool name wins; order is
// most-specific first. Keyed on the tool name only (stable, unlike prose).
const TOOL_FAMILIES: { id: string; name: string; kw: string[] }[] = [
  {
    id: "TOOLS_AUTH",
    name: "Auth & Sessions [Tools]",
    kw: ["auth", "cookie", "jwt", "cred", "hydra", "identity", "swap_session", "session", "login", "oauth", "saml", "password"],
  },
  {
    id: "TOOLS_ANALYSIS",
    name: "Analysis & Decoding [Tools]",
    kw: ["js_", "jsluice", "static", "trufflehog", "secret", "decode", "encode", "punycode", "homoglyph", "response_diff", "diff"],
  },
  {
    id: "TOOLS_EXPLOIT",
    name: "HTTP & Exploitation [Tools]",
    kw: ["curl", "sqlmap", "dalfox", "wpscan", "xss", "sqli", "ssrf", "ssti", "lfi", "inject", "fuzz", "payload", "waf", "bypass", "cors", "idor", "mass_assign", "race", "graphql", "host_header", "schema_fuzz", "replay_request", "run_terminal", "listener", "stealth", "browser"],
  },
  {
    id: "TOOLS_RECON",
    name: "Recon & Mapping [Tools]",
    kw: ["recon", "subdomain", "subfinder", "subzy", "port", "nmap", "httpx", "nuclei", "katana", "spider", "dns", "dig", "asn", "wayback", "waymore", "gau", "dork", "gowitness", "cloudscout", "company_intel", "otx", "urlscan", "virustotal", "favicon", "tls", "transport", "takeover", "surface", "map_surface", "resolve", "permute", "vhost", "well_known", "content_discovery", "param", "service_probe", "gf_patterns", "probe_urls", "hackerone", "crtsh"],
  },
  {
    id: "TOOLS_MEMORY",
    name: "Reporting & Memory [Tools]",
    kw: ["finding", "report", "artifact", "skill", "playbook", "lesson", "remember", "recall", "hypothes", "plan", "memory", "task", "delegate", "parallel", "profile", "self_audit", "set_target", "manage", "scope", "save_file", "delete_file", "export", "dismiss", "reverify", "verify"],
  },
  { id: "TOOLS_MISC", name: "Arsenal & Misc [Tools]", kw: [] },
];

function toolFamilyOf(name: string): string {
  const n = name.toLowerCase();
  for (const fam of TOOL_FAMILIES) {
    if (fam.kw.some((k) => n.includes(k))) return fam.id;
  }
  return "TOOLS_MISC";
}

interface Lesson {
  id: string;
  technique: string;
  outcome: string;
  note: string;
  tech_signature: string[];
  targets: string[];
  seen_count: number;
  first_seen: string;
  last_seen: string;
}

// Confidence band for the "Lessons" dial (band 0 = top/most-validated).
// Mirrors the HUD labels: 0 "validated", 1 "high confidence", 2 "exploratory".
function lessonBand(l: Lesson): number {
  if (l.outcome === "failed") return 4; // bottom band — a technique that did not pan out
  const seen = l.seen_count || 1;
  if (seen >= 3) return 0; // confirmed repeatedly
  if (seen === 2) return 1;
  return 2; // worked once so far
}

function lessonPct(l: Lesson): number {
  if (l.outcome === "failed") return 30;
  return Math.min(98, 60 + (l.seen_count || 1) * 8);
}

export const BEAST_CATEGORIES = [
  {
    id: "RECON",
    name: "Recon & Surface Mapping",
    skills: ["web2-recon", "exposed-source-recon", "bb-methodology", "argus", "triage-validation"],
  },
  {
    id: "AUTH",
    name: "Authentication & Credentials",
    skills: ["authentication", "auth-bypass", "403-bypass", "credential-attack"],
  },
  {
    id: "ACCESS",
    name: "Access Control & IDOR",
    skills: ["access-control", "idor", "cors-misconfig", "prototype-pollution-mass-assignment"],
  },
  {
    id: "INJECT",
    name: "Injection & Server Exploitation",
    skills: ["xss", "ssti", "ssrf", "insecure-deserialization", "server-side-parameter-pollution"],
  },
  {
    id: "API",
    name: "API & Logic Attacks",
    skills: ["graphql-audit", "race-condition", "client-reverse", "cicd-security"],
  },
  {
    id: "EMERGING",
    name: "Web3, Mobile & AI Security",
    skills: ["web3-audit", "meme-coin-audit", "mobile-pentest", "llm-prompt-injection"],
  },
  {
    id: "ARSENAL",
    name: "Arsenal, Tools & Playbooks",
    skills: ["security-arsenal", "bug-bounty", "report-writing", "web2-vuln-classes"],
  },
];

export const BEAST_CHAIN_LINKS: [string, string, number][] = [
  ["RECON", "API", 8],
  ["API", "AUTH", 12],
  ["AUTH", "ACCESS", 15],
  ["ACCESS", "INJECT", 9],
  ["RECON", "AUTH", 7],
  ["RECON", "ACCESS", 6],
  ["INJECT", "AUTH", 10],
  ["AUTH", "API", 8],
  ["API", "ACCESS", 11],
  ["EMERGING", "AUTH", 5],
  ["ARSENAL", "INJECT", 14],
  ["ARSENAL", "AUTH", 12],
  ["ARSENAL", "RECON", 16],
];

interface StoredItem {
  id: string | number;
  title: string;
  category: string;
  weakness: string;
  severity: string;
  sevIndex: number;
  program: string;
  summary: string;
  body: string;
  endpoint?: string;
  hosts?: string[];
  bounty?: number;
}

export type BeastGraph = {
  stamp: number;
  classes: GraphClass[];
  links: [string, string, number][];
  programs: GraphProgram[];
  cveYears: GraphYear[];
  cveRing: { id: string; name: string }[];
  surfaces: GraphSurface[];
  total: number;
  weaknessCount: number;
  totalBounty: number;
};

class BeastStore {
  private itemsById = new Map<string | number, StoredItem>();
  private itemsByWeakness = new Map<string, StoredItem[]>();
  private itemsByProgramClass = new Map<string, StoredItem[]>();
  private toolsByFamily = new Map<string, StoredItem[]>();
  private lessons: Lesson[] = [];
  private lessonsById = new Map<string, Lesson>();
  private graphCache: BeastGraph | null = null;
  private idCounter = 1000;
  private sig = ""; // fingerprint of the source files, for live auto-reload

  constructor() {
    this.maybeReload();
  }

  /** A cheap fingerprint of every source the brain reads: lessons, the tools
   * snapshot, and each target's task.json. When the beast runs and any of
   * these change (e.g. lessons.json grows), the fingerprint changes and the
   * brain re-reads automatically — no restart, no manual rebuild. */
  private dataSignature(): string {
    const parts: string[] = [];
    for (const p of [LESSONS_PATH, TOOLS_PATH]) {
      try {
        parts.push(`${p}:${fs.statSync(p).mtimeMs}`);
      } catch {
        parts.push(`${p}:0`);
      }
    }
    try {
      for (const d of fs.readdirSync(TARGETS_DIR).sort()) {
        const tp = path.join(TARGETS_DIR, d, "task.json");
        try {
          parts.push(`${tp}:${fs.statSync(tp).mtimeMs}`);
        } catch {
          /* no task.json for this dir */
        }
      }
    } catch {
      /* targets dir missing */
    }
    return parts.join("|");
  }

  /** Reload only when a source file actually changed. Called at the entry of
   * every public query, so the data a request sees is always current. */
  private maybeReload() {
    const sig = this.dataSignature();
    if (sig !== this.sig) {
      this.sig = sig;
      this.reload();
    }
  }

  public reload() {
    this.itemsById.clear();
    this.itemsByWeakness.clear();
    this.itemsByProgramClass.clear();
    this.toolsByFamily.clear();
    this.lessons = [];
    this.lessonsById.clear();
    this.idCounter = 1000;

    // 1. Load Skills
    this.loadSkills();

    // 2. Load Targets & Findings
    this.loadTargets();

    // 3. Load Tools (the real agent TOOL_REGISTRY snapshot)
    this.loadTools();

    // 4. Load Lessons (self-learned techniques → the "Lessons" dial)
    this.loadLessons();

    // 5. Invalidate cache
    this.graphCache = null;
  }

  private loadTools() {
    if (!fs.existsSync(TOOLS_PATH)) return;
    let tools: { name: string; description: string }[] = [];
    try {
      tools = JSON.parse(fs.readFileSync(TOOLS_PATH, "utf8"));
    } catch {
      return;
    }
    if (!Array.isArray(tools)) return;

    for (const t of tools) {
      if (!t || typeof t.name !== "string") continue;
      const famId = toolFamilyOf(t.name);
      const desc = String(t.description || "");
      const id = ++this.idCounter;
      const item: StoredItem = {
        id,
        title: t.name,
        category: famId,
        weakness: t.name, // each tool is its own leaf, keyed by its unique name
        severity: "info",
        sevIndex: 2,
        program: "Beast Arsenal",
        summary: desc.slice(0, 300),
        body: `# ${t.name}\n\n_Tool the beast can call directly._\n\n${desc}`,
        bounty: 0,
      };
      this.itemsById.set(id, item);
      this.addItemToWeakness(t.name, item);
      let list = this.toolsByFamily.get(famId);
      if (!list) {
        list = [];
        this.toolsByFamily.set(famId, list);
      }
      list.push(item);
    }
  }

  private loadLessons() {
    if (!fs.existsSync(LESSONS_PATH)) return;
    let raw: unknown[] = [];
    try {
      raw = JSON.parse(fs.readFileSync(LESSONS_PATH, "utf8"));
    } catch {
      return;
    }
    if (!Array.isArray(raw)) return;

    raw.forEach((r, i) => {
      if (!r || typeof r !== "object") return;
      const o = r as Record<string, unknown>;
      const lesson: Lesson = {
        id: `L${i}`,
        technique: String(o.technique || ""),
        outcome: String(o.outcome || "worked"),
        note: String(o.note || ""),
        tech_signature: Array.isArray(o.tech_signature) ? (o.tech_signature as string[]) : [],
        targets: Array.isArray(o.targets) ? (o.targets as string[]) : [],
        seen_count: Number(o.seen_count || 1) || 1,
        first_seen: String(o.first_seen || ""),
        last_seen: String(o.last_seen || ""),
      };
      if (!lesson.technique) return;
      this.lessons.push(lesson);
      this.lessonsById.set(lesson.id, lesson);
    });
  }

  private loadSkills() {
    if (!fs.existsSync(SKILLS_DIR)) return;

    for (const cat of BEAST_CATEGORIES) {
      for (const skillId of cat.skills) {
        const skillPath = path.join(SKILLS_DIR, skillId, "SKILL.md");
        if (!fs.existsSync(skillPath)) continue;

        const content = fs.readFileSync(skillPath, "utf8");
        const nameMatch = content.match(/^name:\s*(.+)$/m);
        const descMatch = content.match(/^description:\s*(.+)$/m);
        const skillName = nameMatch ? nameMatch[1].trim() : skillId;
        const skillDesc = descMatch ? descMatch[1].trim() : "";

        // Extract subheadings as techniques
        const headings = content.match(/^##\s+(?:[\d.]+\s+)?(.+)$/gm) || [];
        const techniques = headings
          .map((h) => h.replace(/^##\s+(?:[\d.]+\s+)?/, "").trim())
          .filter((h) => h && !h.startsWith("Tools"))
          .slice(0, 10);

        if (techniques.length === 0) {
          techniques.push("Core Methodology & Execution Strategy", "Tool Selection & Verification");
        }

        // Add parent skill as a stored item
        const parentId = ++this.idCounter;
        const parentItem: StoredItem = {
          id: parentId,
          title: `${skillName} [Skill]`,
          category: cat.id,
          weakness: skillName,
          severity: "high",
          sevIndex: 1,
          program: "Beast Skills",
          summary: skillDesc,
          body: content,
          bounty: 0,
        };
        this.itemsById.set(parentId, parentItem);
        this.addItemToWeakness(skillName, parentItem);

        // Add each technique as a leaf dot in the strip
        techniques.forEach((tech, tIdx) => {
          const techId = ++this.idCounter;
          const sevIdx = tIdx === 0 ? 0 : tIdx < 3 ? 1 : 2;
          const item: StoredItem = {
            id: techId,
            title: tech,
            category: cat.id,
            weakness: skillName,
            severity: sevIdx === 0 ? "critical" : sevIdx === 1 ? "high" : "medium",
            sevIndex: sevIdx,
            program: "Beast Skills",
            summary: `Technique ${tIdx + 1} from ${skillName}: ${tech}`,
            body: `## ${tech}\n\nFrom skill **${skillName}** (${cat.name}):\n\n${skillDesc}\n\n---\n\n### Full Methodology Guide\n\n${content}`,
            bounty: 0,
          };
          this.itemsById.set(techId, item);
          this.addItemToWeakness(skillName, item);
        });
      }
    }
  }

  private loadTargets() {
    if (!fs.existsSync(TARGETS_DIR)) return;

    let targetDirs: string[] = [];
    try {
      targetDirs = fs.readdirSync(TARGETS_DIR).filter((f) => {
        const full = path.join(TARGETS_DIR, f);
        return fs.statSync(full).isDirectory() && f !== "default";
      });
    } catch {
      return;
    }

    for (const tname of targetDirs) {
      const taskPath = path.join(TARGETS_DIR, tname, "task.json");
      if (!fs.existsSync(taskPath)) continue;

      try {
        const task = JSON.parse(fs.readFileSync(taskPath, "utf8"));
        const findings = task.findings || [];

        findings.forEach((f: any, idx: number) => {
          if (!f || typeof f !== "object") return;
          const fid = ++this.idCounter;
          const kind = (f.kind || "Vulnerability").replace(/_/g, " ").toUpperCase();
          const sevStr = String(f.severity || "medium").toLowerCase();
          const sevIdx = sevStr === "critical" ? 0 : sevStr === "high" ? 1 : sevStr === "medium" ? 2 : 3;

          // Format raw evidence if present
          let evidenceBody = "";
          if (Array.isArray(f.raw_evidence) && f.raw_evidence.length > 0) {
            evidenceBody = "\n\n### Raw Evidence & Curl Commands\n\n```http\n" + f.raw_evidence.join("\n\n") + "\n```";
          }

          const fullBody = `# ${f.type || "Finding"}\n\n**Target**: \`${tname}\`\n**Endpoint**: \`${f.target || "N/A"}\`\n**Severity**: **${sevStr.toUpperCase()}**\n\n## Verification Note\n${f.verification_note || f.note || "No note recorded."}${evidenceBody}`;

          const item: StoredItem = {
            id: fid,
            title: f.type || `${kind} finding`,
            category: this.mapKindToCategory(f.kind || ""),
            weakness: kind,
            severity: sevStr,
            sevIndex: sevIdx,
            program: tname,
            summary: f.note ? f.note.slice(0, 300) : `Verified finding on ${tname}`,
            body: fullBody,
            endpoint: f.target,
            hosts: f.affected_hosts || [],
            // No fabricated dollar bounty. The real severity-weighted "impact
            // score" is summed in getGraph() from finding severities; per-item
            // bounty stays 0 so no fake "$" ever shows on a dot.
            bounty: 0,
          };

          this.itemsById.set(fid, item);
          this.addItemToWeakness(kind, item);
          this.addItemToProgramClass(tname, item.category, item);
        });
      } catch (e) {
        console.error(`Failed to parse target ${tname}`, e);
      }
    }
  }

  private mapKindToCategory(kind: string): string {
    const k = kind.toLowerCase();
    if (k.includes("auth") || k.includes("token") || k.includes("credential") || k.includes("jwt")) return "AUTH";
    if (k.includes("idor") || k.includes("access") || k.includes("cors")) return "ACCESS";
    if (k.includes("xss") || k.includes("injection") || k.includes("ssti") || k.includes("ssrf")) return "INJECT";
    if (k.includes("database") || k.includes("sql") || k.includes("leak") || k.includes("debug")) return "API";
    return "RECON";
  }

  private addItemToWeakness(weakness: string, item: StoredItem) {
    let list = this.itemsByWeakness.get(weakness);
    if (!list) {
      list = [];
      this.itemsByWeakness.set(weakness, list);
    }
    list.push(item);
  }

  private addItemToProgramClass(program: string, cls: string, item: StoredItem) {
    const key = `${program}|${cls}`;
    let list = this.itemsByProgramClass.get(key);
    if (!list) {
      list = [];
      this.itemsByProgramClass.set(key, list);
    }
    list.push(item);
  }

  public getGraph(): BeastGraph {
    this.maybeReload();
    if (this.graphCache) return this.graphCache;

    // 1. Build Classes from BEAST_CATEGORIES
    const classes: GraphClass[] = [];
    let totalItems = 0;
    let totalWeaknessCount = 0;
    let totalBounty = 0;

    for (const cat of BEAST_CATEGORIES) {
      const weaks: GraphWeakness[] = [];
      let catCount = 0;
      let catBounty = 0;

      for (const skillId of cat.skills) {
        const skillPath = path.join(SKILLS_DIR, skillId, "SKILL.md");
        let skillName = skillId;
        if (fs.existsSync(skillPath)) {
          const content = fs.readFileSync(skillPath, "utf8");
          const m = content.match(/^name:\s*(.+)$/m);
          if (m) skillName = m[1].trim();
        }

        const items = this.itemsByWeakness.get(skillName) || [];
        const count = items.length;
        // sev string: string of severity indices (e.g. "011222")
        const sevStr = items.map((it) => it.sevIndex).sort((a, b) => a - b).join("");

        weaks.push({
          name: skillName,
          count: Math.max(1, count),
          bounty: 0, // no fabricated value; node size is driven by count
          sev: sevStr || "1",
        });

        catCount += count;
        totalItems += count;
        totalWeaknessCount++;
      }

      classes.push({
        id: cat.id,
        name: cat.name,
        count: Math.max(1, catCount),
        bounty: 0,
        weaknesses: weaks.sort((a, b) => b.count - a.count),
      });
    }

    // 1b. Tool families — the real TOOL_REGISTRY, grouped by function, as their
    // own hubs alongside the skill categories. Each tool is a single-leaf
    // weakness keyed by its name (loadTools registered it in itemsByWeakness).
    for (const fam of TOOL_FAMILIES) {
      const famItems = this.toolsByFamily.get(fam.id) || [];
      if (famItems.length === 0) continue;
      const weaks: GraphWeakness[] = famItems
        .map((it) => ({ name: it.weakness, count: 1, bounty: 0, sev: String(it.sevIndex) }))
        .sort((a, b) => a.name.localeCompare(b.name));
      classes.push({
        id: fam.id,
        name: fam.name,
        count: famItems.length,
        bounty: 0,
        weaknesses: weaks,
      });
    }

    // 2. Build Programs (Saved Target Engagements)
    const programs: GraphProgram[] = [];
    const surfaces: GraphSurface[] = [];

    if (fs.existsSync(TARGETS_DIR)) {
      try {
        const tnames = fs.readdirSync(TARGETS_DIR).filter((f) => {
          const full = path.join(TARGETS_DIR, f);
          return fs.statSync(full).isDirectory() && f !== "default";
        });

        for (const tname of tnames) {
          const taskPath = path.join(TARGETS_DIR, tname, "task.json");
          let findingsCount = 0;
          let progImpact = 0;
          let subdomains: string[] = [];
          const classCounts = new Map<string, number>();
          const classSevs = new Map<string, string>();

          if (fs.existsSync(taskPath)) {
            try {
              const task = JSON.parse(fs.readFileSync(taskPath, "utf8"));
              const findings = task.findings || [];
              findingsCount = findings.length;
              subdomains = task.state?.subdomains || [];

              findings.forEach((f: any) => {
                const c = this.mapKindToCategory(f.kind || "");
                classCounts.set(c, (classCounts.get(c) || 0) + 1);
                const sev = String(f.severity || "medium").toLowerCase();
                const sIdx = sev === "critical" ? "0" : sev === "high" ? "1" : sev === "medium" ? "2" : "3";
                classSevs.set(c, (classSevs.get(c) || "") + sIdx);
                // Real severity-weighted impact — the honest replacement for the
                // old flat "$3000 per finding" fabrication.
                progImpact += sev === "critical" ? 40 : sev === "high" ? 20 : sev === "medium" ? 10 : 5;
              });
            } catch {}
          }

          // The real severity-weighted impact feeds only the single HUD
          // "IMPACT SCORE" card (rendered with num(), not money()). Per-node
          // bounty stays 0 so money() renders nothing — no "$" anywhere on the
          // map, since the beast earns no dollar bounties.
          totalBounty += progImpact;

          programs.push({
            name: tname,
            count: findingsCount,
            bounty: 0,
            logo: null,
            classes: [...classCounts.entries()].sort((a, b) => b[1] - a[1]),
            byClass: [...classSevs.entries()].sort((a, b) => b[1].length - a[1].length),
          });

          // Attack Surface Branches
          if (subdomains.length > 0) {
            const branches: [string, string, number][] = subdomains.slice(0, 15).map((sub) => [
              sub.split(".")[0] || sub,
              sub,
              1,
            ]);
            surfaces.push({
              program: tname,
              total: subdomains.length,
              branches,
            });
          }
        }
      } catch {}
    }

    // Sort programs by finding count desc
    programs.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

    // 3. Lessons Learned → the "Lessons" dial, built from the real
    // ~/.beast/lessons.json. Grouped by the month a technique was first seen;
    // each month holds 5 confidence bands (band 0 = most-validated). An empty
    // dial is honest: it just means no runs have taught the beast anything yet.
    const byYear = new Map<number, number[][]>();
    for (const l of this.lessons) {
      const year = Number(l.first_seen.slice(0, 4));
      if (!year) continue;
      let month = Number(l.first_seen.slice(5, 7));
      if (!(month >= 1 && month <= 12)) month = 0; // index 0 = "No date"
      if (!byYear.has(year)) byYear.set(year, Array.from({ length: 13 }, () => [0, 0, 0, 0, 0]));
      byYear.get(year)![month][lessonBand(l)] += 1;
    }
    const cveYears: GraphYear[] = [...byYear.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([year, months]) => ({ year, months }));

    // The ring circling the dial: the most-repeated real lessons first.
    const cveRing = [...this.lessons]
      .filter((l) => l.outcome !== "failed")
      .sort((a, b) => b.seen_count - a.seen_count)
      .slice(0, 10)
      .map((l) => ({ id: l.id, name: l.technique.length > 90 ? l.technique.slice(0, 89) + "…" : l.technique }));

    this.graphCache = {
      stamp: Date.now(),
      classes,
      links: BEAST_CHAIN_LINKS,
      programs,
      cveYears,
      cveRing,
      surfaces,
      total: totalItems,
      weaknessCount: totalWeaknessCount,
      totalBounty,
    };

    return this.graphCache;
  }

  public getLeaves(weaknessNames: string[]): Leaf[] {
    this.maybeReload();
    const out: Leaf[] = [];
    for (const w of weaknessNames) {
      const items = this.itemsByWeakness.get(w) || [];
      for (const it of items) {
        // [id, title, sevIndex, bounty(0 → no "$"), votes(0 → hidden), program]
        out.push([it.id, it.title, it.sevIndex, 0, 0, it.program]);
      }
    }
    return out;
  }

  public getProgramLeaves(programName: string, classId: string): Leaf[] {
    this.maybeReload();
    const key = `${programName}|${classId}`;
    const items = this.itemsByProgramClass.get(key) || [];
    return items.map((it) => [it.id, it.title, it.sevIndex, 0, 0, it.program]);
  }

  public getReport(id: number | string): ReportRow | null {
    this.maybeReload();
    // A lesson (ring node / dial dot) carries a string id like "L42".
    const lesson = typeof id === "string" ? this.lessonsById.get(id) : undefined;
    if (lesson) {
      const sev = lesson.outcome === "failed" ? "low" : lesson.seen_count >= 3 ? "high" : "medium";
      const body = `# ${lesson.technique}\n\n**Outcome**: ${lesson.outcome} · **Seen** ${lesson.seen_count}×\n` +
        (lesson.targets.length ? `**Targets**: ${lesson.targets.join(", ")}\n` : "") +
        `\n## Note\n${lesson.note || "No note recorded."}\n` +
        (lesson.tech_signature.length ? `\n## Signature\n${lesson.tech_signature.join(", ")}` : "");
      return {
        id: id as unknown as number,
        title: lesson.technique,
        program: lesson.targets[0] || "Beast Lessons",
        program_name: lesson.targets[0] || "Beast Lessons",
        severity: sev,
        weakness: "Lesson Learned",
        cve_ids: JSON.stringify([]),
        bounty: 0,
        votes: lesson.seen_count,
        reporter: "Beast",
        substate: "resolved",
        asset_type: "URL",
        asset: lesson.targets[0] || null,
        disclosed_at: lesson.last_seen || null,
        submitted_at: lesson.first_seen || null,
        summary: lesson.note.slice(0, 300),
        body,
        detail_at: lesson.last_seen || null,
        weakness_guess: null,
        logo: null,
      };
    }

    const item = this.itemsById.get(Number(id) || id);
    if (!item) return null;

    return {
      id: item.id as number,
      title: item.title,
      program: item.program,
      program_name: item.program,
      severity: item.severity,
      weakness: item.weakness,
      cve_ids: JSON.stringify([]),
      bounty: 0, // the beast earns no dollar bounties — no fabricated figure
      votes: 0,
      reporter: "Beast",
      substate: "resolved",
      asset_type: "URL",
      asset: item.endpoint || item.program,
      disclosed_at: null,
      submitted_at: null,
      summary: item.summary,
      body: item.body,
      detail_at: null,
      weakness_guess: null,
      logo: null,
    };
  }

  // ── Lessons queries (feed the repurposed "cve" dial via lib/cves.ts) ──────

  /** The real lessons in one band of one month: [id, technique, tone, 0, confidence%, ""]. */
  public getLessonBand(
    year: number,
    month: number,
    band: number,
    o: { q?: string; offset?: number; limit?: number } = {}
  ): { total: number; rows: [string, string, number, number, number, string][] } {
    this.maybeReload();
    const q = (o.q || "").toLowerCase();
    const matches = this.lessons.filter((l) => {
      const y = Number(l.first_seen.slice(0, 4));
      let m = Number(l.first_seen.slice(5, 7));
      if (!(m >= 1 && m <= 12)) m = 0;
      if (y !== year || m !== month || lessonBand(l) !== band) return false;
      if (q && !l.technique.toLowerCase().includes(q)) return false;
      return true;
    });
    const offset = o.offset || 0;
    const limit = o.limit || 60;
    const rows = matches
      .slice(offset, offset + limit)
      .map((l): [string, string, number, number, number, string] => [l.id, l.technique, 4 - band, 0, lessonPct(l), ""]);
    return { total: matches.length, rows };
  }

  /** Top validated lessons for the index core: [id, technique, year, month, confirmed(1/0), confidence%]. */
  public getLessonCore(): [string, string, number, number, number, number][] {
    this.maybeReload();
    return [...this.lessons]
      .filter((l) => l.outcome !== "failed")
      .sort((a, b) => b.seen_count - a.seen_count)
      .slice(0, 60)
      .map((l): [string, string, number, number, number, number] => {
        const y = Number(l.first_seen.slice(0, 4)) || 0;
        let m = Number(l.first_seen.slice(5, 7));
        if (!(m >= 1 && m <= 12)) m = 1;
        return [l.id, l.technique.length > 70 ? l.technique.slice(0, 69) + "…" : l.technique, y, m, l.seen_count >= 2 ? 1 : 0, lessonPct(l)];
      });
  }

  public lessonStats() {
    this.maybeReload();
    const worked = this.lessons.filter((l) => l.outcome !== "failed");
    const confirmed = worked.filter((l) => l.seen_count >= 2);
    return {
      total: this.lessons.length,
      with_check: confirmed.length,
      exploited: worked.length,
      exploited_with_check: confirmed.length,
      registered: this.lessons.length,
    };
  }

  public lessonIds(): string[] {
    this.maybeReload();
    return this.lessons.map((l) => l.id);
  }
}

export const beastStore = new BeastStore();
