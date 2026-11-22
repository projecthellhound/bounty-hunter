import { useCallback, useEffect, useRef, useState } from "react";
import { marked } from "marked";
import logo from "./logo.png";
import "./App.css";

const WS_URL = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
const API = "";

const PROVIDERS = ["ollama", "nvidia", "openai", "anthropic", "gemini"] as const;

type LogKind = "info" | "warn" | "success" | "error" | "finding" | "banner" | "section";

interface LogLine {
  kind: "log";
  logKind: LogKind;
  text: string;
}
interface ToolCard {
  kind: "tool";
  cardId: string | null;
  tool: string;
  args: Record<string, unknown>;
  result?: unknown;
  done: boolean;
}
type Entry = LogLine | ToolCard;

interface Finding {
  id: number;
  severity: string;
  kind: string;
  title: string;
  endpoint: string;
  note: string;
  affected_hosts: string[];
  report: string | null;
}

interface Config {
  orchestrator_provider: string;
  orchestrator_model: string;
  synthesizer_provider: string;
  synthesizer_model: string;
  researcher_handle: string;
  auto_install_missing_tools: boolean;
  show_recaps: boolean;
  fuzz_rate_limit: number;
  max_agent_iterations: number;
  configured_providers: string[];
}

const SEV_ORDER: Record<string, number> = {
  critical: 0, high: 1, medium: 2, low: 3, info: 4, informational: 4,
};

marked.setOptions({ breaks: true, gfm: true });

function prettyArgs(args: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    if (v == null || v === "") continue;
    let s = typeof v === "string" ? v : JSON.stringify(v);
    if (s.length > 80) s = s.slice(0, 77) + "…";
    parts.push(`${k}=${s}`);
  }
  return parts.join("  ");
}

function resultPreview(result: unknown): string {
  if (result == null) return "";
  if (typeof result === "string") return result;
  try { return JSON.stringify(result, null, 2); } catch { return String(result); }
}

function renderMd(text: string): { __html: string } {
  try { return { __html: marked.parse(text) as string }; }
  catch { return { __html: text }; }
}

/** True if the beast emitted a multi-sentence prose response (not a terse status line) */
function isAssistantProse(text: string): boolean {
  if (/^\[[\+\*!\-#]\]/.test(text)) return false;          // [+] status prefixes
  if (/^(Found|Running|Scanning|Starting|No |Done|Error)/.test(text)) return false;
  if (!text.includes("\n") && text.length < 60) return false; // short single-liners
  if (/\*\*|##|`[^`]|\|---|^- /m.test(text)) return true;   // has markdown markers
  return text.includes("\n") && text.length > 120;            // multi-line long text
}

export default function App() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [targets, setTargets] = useState<string[]>([]);
  const [activeTarget, setActiveTarget] = useState<string>("default");
  const [findings, setFindings] = useState<Finding[]>([]);
  const [input, setInput] = useState("");
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [statusLabel, setStatusLabel] = useState("");
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [report, setReport] = useState<{ title: string; file: string } | null>(null);
  const [userScrolled, setUserScrolled] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);

  const pushEntry = useCallback((e: Entry) => setEntries((prev) => [...prev, e]), []);

  useEffect(() => {
    let closed = false;
    function connect() {
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;
      ws.onopen = () => setConnected(true);
      ws.onclose = () => { setConnected(false); if (!closed) setTimeout(connect, 1500); };
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        switch (msg.type) {
          case "targets": setTargets(msg.list || []); break;
          case "findings":
            if (msg.target) setActiveTarget(msg.target);
            setFindings(msg.list || []);
            break;
          case "log": pushEntry({ kind: "log", logKind: msg.kind, text: msg.text }); break;
          case "status_label": setStatusLabel(msg.text || ""); break;
          case "tool_start":
            pushEntry({ kind: "tool", cardId: msg.card_id ?? null, tool: msg.tool, args: msg.args || {}, done: false });
            break;
          case "tool_result":
            setEntries((prev) => {
              for (let i = prev.length - 1; i >= 0; i--) {
                const e = prev[i];
                if (e.kind === "tool" && !e.done && e.cardId === msg.card_id) {
                  const next = prev.slice();
                  next[i] = { ...e, result: msg.result, done: true };
                  return next;
                }
              }
              return prev;
            });
            break;
          case "turn_status": setStatusLabel(msg.text || ""); break;
          case "turn_end":
            setStatusLabel("");
            if (msg.text) pushEntry({ kind: "log", logKind: "success", text: msg.text });
            if (!msg.auto_continue) setBusy(false);
            break;
          case "error":
            pushEntry({ kind: "log", logKind: "error", text: msg.text });
            setBusy(false); setStatusLabel("");
            break;
        }
      };
    }
    connect();
    return () => { closed = true; wsRef.current?.close(); };
  }, [pushEntry]);

  // Detect user scrolling up so we don't auto-snap back on them
  const handleLogScroll = useCallback(() => {
    const el = logRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    setUserScrolled(!atBottom);
  }, []);

  // Smooth-scroll to bottom unless the user has scrolled up
  useEffect(() => {
    if (userScrolled) return;
    const el = logRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [entries, statusLabel, userScrolled]);

  const send = useCallback(() => {
    const text = input.trim();
    if (!text || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    pushEntry({ kind: "log", logKind: "banner", text: `❯ ${text}` });
    wsRef.current.send(JSON.stringify({ type: "message", text }));
    setInput("");
    setBusy(true);
    setUserScrolled(false); // snap back to bottom when user sends a message
  }, [input, pushEntry]);

  const switchTarget = useCallback((name: string) => {
    wsRef.current?.send(JSON.stringify({ type: "switch_target", target: name }));
    setEntries([]);
    setUserScrolled(false);
  }, []);

  const sortedFindings = [...findings].sort(
    (a, b) => (SEV_ORDER[a.severity] ?? 5) - (SEV_ORDER[b.severity] ?? 5) || a.id - b.id
  );
  const actions = entries.filter((e): e is ToolCard => e.kind === "tool");
  const runningCount = actions.filter((a) => !a.done).length;

  return (
    <div className={`app ${leftCollapsed ? "l-col" : ""} ${rightCollapsed ? "r-col" : ""}`}>

      {/* ── LEFT RAIL ─── */}
      <aside className="rail left">
        <div className="brand">
          <img className="brand-logo" src={logo} alt="" />
          {!leftCollapsed && <span className="brand-name">BEAST</span>}
          <button className="rail-toggle" title={leftCollapsed ? "Expand" : "Collapse"}
            onClick={() => setLeftCollapsed((v) => !v)}>
            {leftCollapsed ? "»" : "«"}
          </button>
        </div>
        {!leftCollapsed && (
          <>
            <nav className="nav">
              <div className="nav-item active">Findings</div>
              <div className="nav-item">Automations</div>
              <div className="nav-item">Skills</div>
            </nav>
            <div className="rail-section-title">TARGETS</div>
            <div className="target-list">
              {targets.map((t) => (
                <button key={t} className={`target ${t === activeTarget ? "active" : ""}`}
                  onClick={() => switchTarget(t)}>{t}</button>
              ))}
              {targets.length === 0 && <div className="empty">no targets yet</div>}
            </div>
            <button className="settings-btn" onClick={() => setSettingsOpen(true)}>⚙ Settings</button>
          </>
        )}
      </aside>

      {/* ── CENTER ─── */}
      <main className="center">
        <header className="topbar">
          <div className="tb-target">{activeTarget}</div>
          <div className={`tb-status ${connected ? "ok" : "err"}`}>
            {connected ? "● connected" : "○ reconnecting"}
          </div>
        </header>

        <div className="log" ref={logRef} onScroll={handleLogScroll}>
          {entries.length === 0 && (
            <div className="log-hint">
              Ask the beast to hunt. e.g. <code>recon example.com and look for IDORs</code>
            </div>
          )}
          {entries.map((e, i) =>
            e.kind === "log" ? <LogLineView key={i} entry={e} /> : <ToolCardView key={i} card={e} />
          )}
          {statusLabel && (
            <div className="line status"><span className="spinner" /> {statusLabel}</div>
          )}
        </div>

        <div className="composer">
          <textarea
            value={input}
            placeholder={busy ? "working… (you can still type)" : "Message BEAST…"}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
            rows={1}
          />
          <button className="send" onClick={send} disabled={!connected}>
            {busy ? "…" : "Send"}
          </button>
        </div>
      </main>

      {/* ── RIGHT RAIL ─── */}
      <aside className="rail right">
        <button className="rail-toggle solo"
          title={rightCollapsed ? "Show findings & actions" : "Hide panel"}
          onClick={() => setRightCollapsed((v) => !v)}>
          {rightCollapsed ? "«" : "»"}
        </button>
        {!rightCollapsed && (
          <>
            <div className="rail-section-title">
              ACTIONS <span className="count">{runningCount > 0 ? `${runningCount} running` : actions.length}</span>
            </div>
            <div className="action-list">
              {actions.slice(-14).reverse().map((a, i) => (
                <div key={i} className={`action ${a.done ? "done" : "running"}`}>
                  <span className="action-dot" />
                  <span className="action-name">{a.tool}</span>
                  <span className="action-args">{prettyArgs(a.args)}</span>
                </div>
              ))}
              {actions.length === 0 && <div className="empty">no actions yet</div>}
            </div>
            <div className="rail-section-title">
              FINDINGS <span className="count">{findings.length}</span>
            </div>
            <div className="finding-list">
              {sortedFindings.map((f) => (
                <div key={f.id} className="finding">
                  <div className="finding-head">
                    <span className={`sev sev-${f.severity}`}>{f.severity}</span>
                    <span className="finding-title">{f.title || f.kind || "finding"}</span>
                  </div>
                  {f.endpoint && <div className="finding-ep">{f.endpoint}</div>}
                  {f.report && (
                    <button className="view-report"
                      onClick={() => setReport({ title: f.title || "report", file: f.report! })}>
                      view report
                    </button>
                  )}
                </div>
              ))}
              {findings.length === 0 && <div className="empty">no findings yet</div>}
            </div>
          </>
        )}
      </aside>

      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
      {report && (
        <ReportModal
          title={report.title}
          src={`${API}/api/report?target=${encodeURIComponent(activeTarget)}&file=${encodeURIComponent(report.file)}`}
          onClose={() => setReport(null)}
        />
      )}
    </div>
  );
}

function LogLineView({ entry }: { entry: LogLine }) {
  const { logKind, text } = entry;

  // User message → right-aligned bubble (Claude Code style human turn)
  if (logKind === "banner") {
    const clean = text.startsWith("❯ ") ? text.slice(2) : text;
    return (
      <div className="msg user">
        <div className="msg-bubble">{clean}</div>
      </div>
    );
  }

  if (logKind === "finding") return <div className="line finding">{text}</div>;
  if (logKind === "section") return <div className="line section">{text}</div>;

  // Assistant prose → left-aligned bubble with markdown rendering
  if ((logKind === "success" || logKind === "info") && isAssistantProse(text)) {
    return (
      <div className="msg assistant">
        <div className="msg-bubble md" dangerouslySetInnerHTML={renderMd(text)} />
      </div>
    );
  }

  return <div className={`line ${logKind}`}>{text}</div>;
}

function ToolCardView({ card }: { card: ToolCard }) {
  const [open, setOpen] = useState(false);
  const preview = card.done ? resultPreview(card.result) : "";
  return (
    <div className={`tool-card ${card.done ? "done" : "running"}`}>
      <button className="tool-head" onClick={() => setOpen((v) => !v)}>
        <span className="tool-dot" />
        <span className="tool-name">{card.tool}</span>
        <span className="tool-args">{prettyArgs(card.args)}</span>
        <span className="tool-caret">{open ? "▾" : "▸"}</span>
      </button>
      {open && card.done && <pre className="tool-result">{preview.slice(0, 20000)}</pre>}
    </div>
  );
}

function ReportModal({ title, src, onClose }: { title: string; src: string; onClose: () => void }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal report-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head"><span>{title}</span><button onClick={onClose}>✕</button></div>
        <iframe className="report-frame" src={src} title={title} />
      </div>
    </div>
  );
}

function SettingsModal({ onClose }: { onClose: () => void }) {
  const [cfg, setCfg] = useState<Config | null>(null);
  const [tab, setTab] = useState<"models" | "keys" | "behavior">("models");
  const [keyProvider, setKeyProvider] = useState<string>("nvidia");
  const [keyValue, setKeyValue] = useState("");
  const [saved, setSaved] = useState("");

  useEffect(() => {
    fetch(`${API}/api/config`).then((r) => r.json()).then(setCfg).catch(() => setCfg(null));
  }, []);

  const patch = (p: Partial<Config>) => setCfg((c) => (c ? { ...c, ...p } : c));

  const saveConfig = async () => {
    if (!cfg) return;
    const r = await fetch(`${API}/api/config`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(cfg),
    });
    setCfg(await r.json()); setSaved("saved ✓"); setTimeout(() => setSaved(""), 1500);
  };

  const saveKey = async () => {
    if (!keyValue.trim()) return;
    await fetch(`${API}/api/apikey`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: keyProvider, key: keyValue }),
    });
    setKeyValue(""); setSaved(`${keyProvider} key saved ✓`);
    const r = await fetch(`${API}/api/config`); setCfg(await r.json());
    setTimeout(() => setSaved(""), 1500);
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head"><span>Settings</span><button onClick={onClose}>✕</button></div>
        <div className="modal-tabs">
          {(["models", "keys", "behavior"] as const).map((t) => (
            <button key={t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>
              {t === "models" ? "Models" : t === "keys" ? "API Keys" : "Behavior"}
            </button>
          ))}
        </div>
        <div className="modal-body">
          {!cfg && <div className="empty">loading…</div>}
          {cfg && tab === "models" && (
            <>
              <Field label="Orchestrator provider"><ProviderSelect value={cfg.orchestrator_provider} configured={cfg.configured_providers} onChange={(v) => patch({ orchestrator_provider: v })} /></Field>
              <Field label="Orchestrator model"><input value={cfg.orchestrator_model} onChange={(e) => patch({ orchestrator_model: e.target.value })} /></Field>
              <Field label="Synthesizer provider"><ProviderSelect value={cfg.synthesizer_provider} configured={cfg.configured_providers} onChange={(v) => patch({ synthesizer_provider: v })} /></Field>
              <Field label="Synthesizer model"><input value={cfg.synthesizer_model} onChange={(e) => patch({ synthesizer_model: e.target.value })} /></Field>
            </>
          )}
          {cfg && tab === "keys" && (
            <>
              <div className="key-status">
                {PROVIDERS.filter((p) => p !== "ollama").map((p) => (
                  <span key={p} className={`chip ${cfg.configured_providers.includes(p) ? "on" : ""}`}>
                    {p}{cfg.configured_providers.includes(p) ? " ✓" : ""}
                  </span>
                ))}
              </div>
              <Field label="Provider">
                <select value={keyProvider} onChange={(e) => setKeyProvider(e.target.value)}>
                  {PROVIDERS.filter((p) => p !== "ollama").map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
              </Field>
              <Field label="API key">
                <input type="password" value={keyValue} placeholder="paste key — stored in ~/.beast/config.json" onChange={(e) => setKeyValue(e.target.value)} />
              </Field>
              <button className="primary" onClick={saveKey}>Save key</button>
            </>
          )}
          {cfg && tab === "behavior" && (
            <>
              <Field label="Researcher handle"><input value={cfg.researcher_handle} onChange={(e) => patch({ researcher_handle: e.target.value })} /></Field>
              <Field label="Fuzz rate limit (req/s)"><input type="number" value={cfg.fuzz_rate_limit} onChange={(e) => patch({ fuzz_rate_limit: Number(e.target.value) })} /></Field>
              <Field label="Max agent iterations"><input type="number" value={cfg.max_agent_iterations} onChange={(e) => patch({ max_agent_iterations: Number(e.target.value) })} /></Field>
              <label className="check"><input type="checkbox" checked={cfg.auto_install_missing_tools} onChange={(e) => patch({ auto_install_missing_tools: e.target.checked })} /> Auto-install missing tools</label>
              <label className="check"><input type="checkbox" checked={cfg.show_recaps} onChange={(e) => patch({ show_recaps: e.target.checked })} /> Show recaps</label>
            </>
          )}
        </div>
        <div className="modal-foot">
          <span className="saved">{saved}</span>
          {tab !== "keys" && <button className="primary" onClick={saveConfig} disabled={!cfg}>Save</button>}
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="field"><span>{label}</span>{children}</label>;
}

function ProviderSelect({ value, configured, onChange }: { value: string; configured: string[]; onChange: (v: string) => void }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      {PROVIDERS.map((p) => <option key={p} value={p}>{p}{p !== "ollama" && !configured.includes(p) ? " (no key)" : ""}</option>)}
    </select>
  );
}
