import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Marked } from "marked";
import { markedHighlight } from "marked-highlight";
import hljs from "highlight.js/lib/common";
import "highlight.js/styles/github-dark.css";
import logo from "./logo.png";
import Brain from "./graph/Brain";
import "./App.css";

// marked + syntax highlighting for fenced code blocks (payloads, requests, JSON).
const marked = new Marked(
  markedHighlight({
    emptyLangClass: "hljs",
    langPrefix: "hljs language-",
    highlight(code, lang) {
      const language = lang && hljs.getLanguage(lang) ? lang : "";
      try {
        return language
          ? hljs.highlight(code, { language }).value
          : hljs.highlightAuto(code).value;
      } catch {
        return code;
      }
    },
  })
);

const WS_URL = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
const API = "";

const PROVIDERS = ["ollama", "nvidia", "openai", "anthropic", "gemini"] as const;

type LogKind = "info" | "warn" | "success" | "error" | "finding" | "banner" | "section";

interface UserMsg {
  kind: "user";
  text: string;
}

interface AssistantMsg {
  kind: "assistant";
  text: string;
  streaming?: boolean;
  startedAt?: number;   // ms epoch when the bubble began streaming
  at?: number;          // ms epoch when the turn finished
  elapsedMs?: number;   // generation duration
}

interface StatusLine {
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

type Entry = UserMsg | AssistantMsg | StatusLine | ToolCard;

interface Finding {
  id: number;
  severity: string;
  kind: string;
  title: string;
  endpoint: string;
  note: string;
  affected_hosts: string[];
  report: string | null;
  target?: string;
}

interface ProgramMeta {
  name: string;
  display_name: string;
  targets: string[];
}

type Scope = { kind: "target"; name: string } | { kind: "program"; name: string };

interface CommandMeta {
  name: string;
  aliases: string[];
  description: string;
  usage: string;
  category: string;
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
  try {
    let html = marked.parse(text) as string;
    // Wrap every code block with a Copy button (handled via delegation below).
    html = html
      .replace(/<pre>/g, '<div class="code-block-wrap"><button class="code-copy" type="button">Copy</button><pre>')
      .replace(/<\/pre>/g, "</pre></div>");
    return { __html: html };
  } catch { return { __html: text }; }
}

// Delegated copy for code blocks: clicking a .code-copy copies its <pre> text.
function handleCodeCopy(e: React.MouseEvent) {
  const btn = (e.target as HTMLElement).closest(".code-copy") as HTMLElement | null;
  if (!btn) return;
  const pre = btn.parentElement?.querySelector("pre");
  if (!pre) return;
  navigator.clipboard?.writeText(pre.textContent || "").then(() => {
    const orig = btn.textContent;
    btn.textContent = "Copied";
    btn.classList.add("copied");
    setTimeout(() => { btn.textContent = orig; btn.classList.remove("copied"); }, 1300);
  }).catch(() => {});
}

// The registrable ("apex") domain of a host, so subdomains of one site group
// together like a sitemap: content-service.bugbountymasterclass.com and
// bugbountymasterclass.com both resolve to "bugbountymasterclass.com". IPs and
// localhost are left as-is. A small set of two-part public suffixes is handled.
const _TWO_PART_TLDS = new Set([
  "co.uk", "org.uk", "gov.uk", "ac.uk", "co.jp", "co.in", "com.br", "com.au",
  "net.au", "com.mx", "co.za", "com.sg", "co.kr", "com.tr",
]);
function apexDomain(host: string): string {
  const h = (host || "").trim().toLowerCase().replace(/:\d+$/, "");
  if (!h || h === "localhost" || /^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return h;
  const parts = h.split(".");
  if (parts.length <= 2) return h;
  const last2 = parts.slice(-2).join(".");
  return _TWO_PART_TLDS.has(last2) ? parts.slice(-3).join(".") : last2;
}
// The label shown for a host inside its apex group — just the subdomain part
// (api.google.com under google.com reads as "api"), or the full host if bare.
function subLabel(host: string, apex: string): string {
  const h = host.replace(/:\d+$/, "");
  return h === apex ? h : (h.endsWith("." + apex) ? h.slice(0, -(apex.length + 1)) : h);
}
// "4s" / "1m 20s" — how long the reply took to generate.
function fmtDuration(ms?: number): string {
  if (!ms || ms < 0) return "";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60), r = s % 60;
  return r ? `${m}m ${r}s` : `${m}m`;
}
// Clock time the reply landed, e.g. "2:45 PM".
function fmtClock(at?: number): string {
  if (!at) return "";
  try { return new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); }
  catch { return ""; }
}

/** Normalize raw saved entries from JSON into strongly-typed Entry objects */
function normalizeEntry(item: any): Entry {
  if (!item || typeof item !== "object") {
    return { kind: "log", logKind: "info", text: String(item) };
  }
  if (item.kind === "user" || item.kind === "assistant") {
    return item as Entry;
  }
  if (item.kind === "tool") {
    return {
      kind: "tool",
      cardId: item.cardId ?? null,
      tool: item.tool || "",
      args: item.args || {},
      result: item.result,
      done: Boolean(item.done),
    };
  }
  if (item.kind === "log") {
    // The server's own echo of what the user typed — distinct from a
    // command's real banner output (e.g. /skills' library header), which
    // must stay a log line, not masquerade as something the user said.
    if (item.logKind === "user_echo") {
      return { kind: "user", text: item.text || "" };
    }
    // If it's a turn end success message, convert to assistant message
    if (item.logKind === "success" && (item.text.length > 80 || item.text.includes("\n") || /\*\*|`/.test(item.text))) {
      return { kind: "assistant", text: item.text };
    }
    return { kind: "log", logKind: item.logKind || "info", text: item.text || "" };
  }
  return { kind: "log", logKind: "info", text: JSON.stringify(item) };
}

export default function App() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [targets, setTargets] = useState<string[]>([]);
  const [activeTarget, setActiveTarget] = useState<string>("default");
  const [findings, setFindings] = useState<Finding[]>([]);
  const [programs, setPrograms] = useState<ProgramMeta[]>([]);
  const [collapsedPrograms, setCollapsedPrograms] = useState<Set<string>>(new Set());
  const [sessions, setSessions] = useState<{ id: string; title: string; target: string; updated: number }[]>([]);
  const [activeSession, setActiveSession] = useState<string>("");
  const [chatSearch, setChatSearch] = useState("");
  const [searchResults, setSearchResults] = useState<{ id: string; title: string; target: string; snippet?: string }[] | null>(null);
  const [renamingId, setRenamingId] = useState("");
  const [renameDraft, setRenameDraft] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [dragOverProg, setDragOverProg] = useState("");
  const [pendingAttach, setPendingAttach] = useState<{ id: string; target: string; program: string; label: string } | null>(null);
  const [addingProgram, setAddingProgram] = useState<string>(""); // program name whose "+ asset" input is open
  const [addAsset, setAddAsset] = useState<string>("");
  const [attachOpen, setAttachOpen] = useState<boolean>(false); // "attach this chat to a program" panel
  const [attachProgram, setAttachProgram] = useState<string>("");
  const [attachTarget, setAttachTarget] = useState<string>("");
  const [scope, setScope] = useState<Scope>({ kind: "target", name: "default" });
  const [navView, setNavView] = useState<"chat" | "graph">(() => (localStorage.getItem("beast.navView") === "graph" ? "graph" : "chat"));
  const [input, setInput] = useState("");
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [statusLabel, setStatusLabel] = useState("");
  // Remembered layout — panel open/closed state persists across restarts.
  const [leftCollapsed, setLeftCollapsed] = useState(() => localStorage.getItem("beast.leftCollapsed") === "1");
  const [rightCollapsed, setRightCollapsed] = useState(() => localStorage.getItem("beast.rightCollapsed") !== "0");
  // UI zoom (Ctrl +/-/0) — whole-app scale, remembered across restarts.
  const [uiScale, setUiScale] = useState<number>(() => { const v = Number(localStorage.getItem("beast.uiScale")); return v >= 0.7 && v <= 1.6 ? v : 1; });
  // Resizable side panels — widths persist across restarts.
  const [leftW, setLeftW] = useState<number>(() => { const v = Number(localStorage.getItem("beast.leftW")); return v >= 180 && v <= 460 ? v : 248; });
  const [rightW, setRightW] = useState<number>(() => { const v = Number(localStorage.getItem("beast.rightW")); return v >= 240 && v <= 560 ? v : 324; });
  const [resizing, setResizing] = useState<null | "left" | "right">(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [report, setReport] = useState<{ title: string; file: string; target: string } | null>(null);
  const [userScrolled, setUserScrolled] = useState(false);
  const [commands, setCommands] = useState<CommandMeta[]>([]);
  const [cmdHighlight, setCmdHighlight] = useState(0);
  // Command palette (Ctrl/Cmd+K): jump to any chat, target, or command by click.
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [paletteIdx, setPaletteIdx] = useState(0);

  const wsRef = useRef<WebSocket | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const scopeRef = useRef<Scope>(scope);
  useEffect(() => { scopeRef.current = scope; }, [scope]);

  useEffect(() => {
    if (scope.kind === "program") {
      fetch(`${API}/api/findings?program=${encodeURIComponent(scope.name)}`)
        .then((r) => r.json()).then((d) => setFindings(d.findings || [])).catch(() => {});
    }
  }, [scope]);

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
          case "sessions": {
            setSessions(msg.list || []);
            if (msg.active) {
              setActiveSession(msg.active);
              // Keep the active target in step with the active chat's target,
              // so a blank chat reads as scope-free (not the previous target).
              const act = (msg.list || []).find((s: { id: string; target: string }) => s.id === msg.active);
              if (act) { const t = act.target || "default"; setActiveTarget(t); setScope({ kind: "target", name: t }); }
            }
            break;
          }
          case "findings":
            if (msg.target) setActiveTarget(msg.target);
            // A program-wide view aggregates findings across every target in
            // it (fetched separately, below) — a per-target push here would
            // clobber that aggregate with just the one target's findings.
            if (scopeRef.current.kind === "target") setFindings(msg.list || []);
            break;
          case "chat_history":
            // A blank session reports target "" → the chat is scope-free.
            setActiveTarget(msg.target || "default");
            if (msg.session) setActiveSession(msg.session);
            if (Array.isArray(msg.entries)) {
              setEntries(msg.entries.map(normalizeEntry));
            }
            break;
          case "log":
            // The user's own message is already shown optimistically by
            // send() below — the server's user_echo exists only so history
            // replay (chat_history) can reconstruct it later, never live.
            if (msg.kind !== "user_echo") {
              pushEntry({ kind: "log", logKind: msg.kind, text: msg.text });
            }
            break;
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
          case "token":
            // Grow a live assistant bubble as tokens arrive (real-time stream).
            setEntries((prev) => {
              const last = prev[prev.length - 1];
              if (last && last.kind === "assistant" && last.streaming) {
                const next = prev.slice();
                next[next.length - 1] = { ...last, text: last.text + (msg.text || "") };
                return next;
              }
              return [...prev, { kind: "assistant", text: msg.text || "", streaming: true, startedAt: Date.now() }];
            });
            break;
          case "turn_status": setStatusLabel(msg.text || ""); break;
          case "turn_end":
            setStatusLabel("");
            // Finalize the streamed bubble (or create one if nothing streamed).
            setEntries((prev) => {
              const last = prev[prev.length - 1];
              const now = Date.now();
              if (last && last.kind === "assistant" && last.streaming) {
                const next = prev.slice();
                next[next.length - 1] = {
                  kind: "assistant", text: msg.text || last.text, at: now,
                  elapsedMs: last.startedAt ? now - last.startedAt : undefined,
                };
                return next;
              }
              return msg.text ? [...prev, { kind: "assistant", text: msg.text, at: now }] : prev;
            });
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

  useEffect(() => {
    fetch(`${API}/api/commands`).then((r) => r.json()).then((d) => setCommands(d.commands || [])).catch(() => {});
  }, []);

  // Program membership (which targets live under which program) only
  // changes via /program commands, which also push a fresh "targets" list —
  // piggyback on that same signal instead of polling.
  useEffect(() => {
    fetch(`${API}/api/programs`).then((r) => r.json()).then((d) => setPrograms(d.programs || [])).catch(() => {});
  }, [targets]);

  // Slash-command picker: live while the user is still typing the command
  // token itself ("/" with no space yet) — same idea as the TARGETS list,
  // but for the ~45 commands commands.py registers, so nobody has to
  // memorize /recon, /scope, /program, /loot, /mcp... to use them.
  const slashToken = /^\/(\S*)$/.exec(input.split(" ")[0] ?? "");
  const slashActive = input.startsWith("/") && !input.includes(" ");
  const slashFiltered = slashActive
    ? commands.filter((c) => {
        const q = (slashToken?.[1] || "").toLowerCase();
        return !q || c.name.toLowerCase().includes(q) || c.aliases.some((a) => a.toLowerCase().includes(q));
      }).slice(0, 8)
    : [];

  useEffect(() => { setCmdHighlight(0); }, [input]);

  // "default" is the real bucket name the backend uses before any target has
  // been picked — a storage detail, not something to show as if it were an
  // actual engagement.
  const hasTarget = !!activeTarget && activeTarget !== "default";

  const pickCommand = useCallback((c: CommandMeta) => {
    setInput(c.name + " ");
    inputRef.current?.focus();
  }, []);

  // Detect user scrolling up so we don't snap back on them
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
    pushEntry({ kind: "user", text });
    wsRef.current.send(JSON.stringify({ type: "message", text }));
    setInput("");
    setBusy(true);
    setUserScrolled(false);
  }, [input, pushEntry]);

  // Stop the in-flight turn (agent bails at the next tool boundary).
  const stopTurn = useCallback(() => {
    wsRef.current?.send(JSON.stringify({ type: "stop_turn" }));
  }, []);

  // Regenerate the last reply: keep the last user message, drop the reply (and
  // its tool cards), ask the backend to rewind + re-run. Optimistic client view.
  const regenerate = useCallback(() => {
    if (busy || !wsRef.current) return;
    setEntries((prev) => {
      const next = prev.slice();
      while (next.length && next[next.length - 1].kind !== "user") next.pop();
      return next;
    });
    wsRef.current.send(JSON.stringify({ type: "regenerate" }));
    setBusy(true);
    setUserScrolled(false);
  }, [busy]);

  // Edit the k-th user message and resend — fork the chat from that point.
  const editResend = useCallback((userIndex: number, text: string) => {
    const t = text.trim();
    if (!t || !wsRef.current) return;
    setEntries((prev) => {
      let count = -1, cut = prev.length;
      for (let i = 0; i < prev.length; i++) {
        if (prev[i].kind === "user") { count++; if (count === userIndex) { cut = i; break; } }
      }
      return [...prev.slice(0, cut), { kind: "user", text: t } as Entry];
    });
    wsRef.current.send(JSON.stringify({ type: "edit_resend", user_index: userIndex, text: t }));
    setBusy(true);
    setUserScrolled(false);
  }, []);

  const scrollToBottom = useCallback(() => {
    const el = logRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    setUserScrolled(false);
  }, []);

  const switchTarget = useCallback((name: string) => {
    wsRef.current?.send(JSON.stringify({ type: "switch_target", target: name }));
    setScope({ kind: "target", name });
    setUserScrolled(false);
  }, []);

  // Clicking a program (rather than one of its targets) broadens the
  // Findings/Knowledge-Graph view to the whole engagement, while chat still
  // necessarily talks to one concrete target's Agent — there's no merged
  // multi-target chat session — so it auto-picks one to land on: whichever
  // of the program's targets is already active, else its first.
  const selectProgram = useCallback((program: ProgramMeta) => {
    setScope({ kind: "program", name: program.name });
    const land = program.targets.includes(activeTarget) ? activeTarget : program.targets[0];
    if (land && land !== activeTarget) {
      wsRef.current?.send(JSON.stringify({ type: "switch_target", target: land }));
    }
    setUserScrolled(false);
  }, [activeTarget]);

  const toggleProgram = useCallback((name: string) => {
    setCollapsedPrograms((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  }, []);

  const clearChat = useCallback(() => {
    // No browser confirm() dialog (it renders as an ugly native popup). With
    // sessions this is low-stakes — start a New chat to keep history instead.
    wsRef.current?.send(JSON.stringify({ type: "clear_history" }));
    setEntries([]);
  }, []);

  // ── chat sessions ──────────────────────────────────────────────────────
  // Any chat action yanks you into the chat view — so New chat / opening a chat
  // works even while you're looking at the Brain panel (was stuck before).
  const newChat = useCallback(() => {
    setNavView("chat");
    wsRef.current?.send(JSON.stringify({ type: "new_session" }));
  }, []);
  const switchSession = useCallback((id: string) => {
    setNavView("chat");
    if (id && id !== activeSession) wsRef.current?.send(JSON.stringify({ type: "switch_session", id }));
  }, [activeSession]);
  const deleteSession = useCallback((id: string) => {
    const wasActive = id === activeSession;
    fetch(`${API}/api/sessions/delete`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) })
      .then((r) => r.json())
      .then((d) => {
        setSessions(d.sessions || []);
        // If we deleted the open chat, land on the newest remaining one (or a fresh blank).
        if (wasActive) {
          const next = (d.sessions || [])[0];
          if (next) switchSession(next.id); else newChat();
        }
      })
      .catch(() => {});
  }, [activeSession, switchSession, newChat]);
  const renameSession = useCallback((id: string, title: string) => {
    const t = title.trim();
    setRenamingId("");
    if (!t) return;
    fetch(`${API}/api/sessions/rename`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, title: t }) })
      .then((r) => r.json()).then((d) => setSessions(d.sessions || [])).catch(() => {});
  }, []);
  const exportChat = useCallback((id: string) => {
    window.open(`${API}/api/sessions/export?id=${encodeURIComponent(id)}`, "_blank");
  }, []);

  // Debounced full-text search across all conversations.
  useEffect(() => {
    const q = chatSearch.trim();
    if (!q) { setSearchResults(null); return; }
    const h = setTimeout(() => {
      fetch(`${API}/api/sessions/search?q=${encodeURIComponent(q)}`)
        .then((r) => r.json()).then((d) => setSearchResults(d.results || [])).catch(() => setSearchResults([]));
    }, 220);
    return () => clearTimeout(h);
  }, [chatSearch]);

  // ── Per-chat draft persistence ─────────────────────────────────────────
  // Each conversation remembers its own unsent composer text. Previously a
  // typed draft bled across chats (input was never reset on switch); now it's
  // keyed by session in localStorage — saved as you type, restored on switch,
  // and cleared on send (send() empties input, which this persists as "").
  const draftSessionRef = useRef(activeSession);
  // Save on keystroke, but ONLY for the session the text currently belongs to,
  // so the switch-commit (activeSession already changed, input not yet swapped)
  // can't clobber the other chat's saved draft. Defined before the load effect
  // so on a switch it runs first and no-ops on the mismatch.
  useEffect(() => {
    if (activeSession && activeSession === draftSessionRef.current) {
      try { localStorage.setItem(`beast.draft.${activeSession}`, input); } catch {}
    }
  }, [input, activeSession]);
  // Load on switch: persist the outgoing chat's text, then swap in the incoming
  // chat's saved draft. `input` here is still the OLD chat's text (not yet reset).
  useEffect(() => {
    if (activeSession === draftSessionRef.current) return;
    try { if (draftSessionRef.current) localStorage.setItem(`beast.draft.${draftSessionRef.current}`, input); } catch {}
    draftSessionRef.current = activeSession;
    try { setInput(localStorage.getItem(`beast.draft.${activeSession}`) || ""); } catch { setInput(""); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSession]);

  // ── Global keyboard shortcuts (chat-app ergonomics) ─────────────────────
  // Ctrl/Cmd+N new chat · Ctrl/Cmd+F search · Ctrl/Cmd+B toggle sidebar ·
  // Esc stops a running turn, else closes whatever overlay is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (paletteOpen) { setPaletteOpen(false); return; }
        if (busy) { stopTurn(); return; }
        if (settingsOpen) { setSettingsOpen(false); return; }
        if (report) { setReport(null); return; }
        if (attachOpen) { setAttachOpen(false); return; }
        if (searchOpen) { setSearchOpen(false); setChatSearch(""); return; }
        return;
      }
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "k") { e.preventDefault(); setPaletteQuery(""); setPaletteIdx(0); setPaletteOpen((v) => !v); }
      else if (k === "n") { e.preventDefault(); newChat(); }
      else if (k === "f") { e.preventDefault(); setSearchOpen(true); }
      else if (k === "b") { e.preventDefault(); setLeftCollapsed((v) => !v); }
      else if (k === "=" || k === "+") { e.preventDefault(); setUiScale((s) => Math.min(1.6, Math.round((s + 0.1) * 10) / 10)); }
      else if (k === "-" || k === "_") { e.preventDefault(); setUiScale((s) => Math.max(0.7, Math.round((s - 0.1) * 10) / 10)); }
      else if (k === "0") { e.preventDefault(); setUiScale(1); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, settingsOpen, report, attachOpen, searchOpen, paletteOpen, stopTurn, newChat]);

  // Apply + persist UI zoom (whole-app scale) and the remembered layout.
  useEffect(() => {
    (document.documentElement.style as any).zoom = String(uiScale);
    localStorage.setItem("beast.uiScale", String(uiScale));
  }, [uiScale]);
  useEffect(() => { localStorage.setItem("beast.leftCollapsed", leftCollapsed ? "1" : "0"); }, [leftCollapsed]);
  useEffect(() => { localStorage.setItem("beast.rightCollapsed", rightCollapsed ? "1" : "0"); }, [rightCollapsed]);
  useEffect(() => { localStorage.setItem("beast.navView", navView); }, [navView]);

  // Add a new asset under a program and open a chat scoped to it.
  const addToProgram = useCallback((program: string) => {
    const asset = addAsset.trim();
    if (asset) {
      wsRef.current?.send(JSON.stringify({ type: "new_session_for_program", target: asset, program }));
    }
    setAddingProgram("");
    setAddAsset("");
  }, [addAsset]);

  // Attach the CURRENT chat to a chosen program + asset — works from the empty
  // state AND the always-available topbar button (even mid-conversation).
  const attachCurrentToProgram = useCallback(() => {
    const asset = attachTarget.trim();
    if (asset) {
      setNavView("chat");
      wsRef.current?.send(JSON.stringify({ type: "attach_current_to_program", target: asset, program: attachProgram }));
    }
    setAttachOpen(false);
    setAttachTarget("");
    setAttachProgram("");
  }, [attachTarget, attachProgram]);

  // Open the attach popover, prefilling the program + the chat's current target.
  const openAttach = useCallback(() => {
    setAttachProgram(programs[0]?.name || "");
    setAttachTarget(hasTarget ? activeTarget : "");
    setAttachOpen(true);
  }, [programs, hasTarget, activeTarget]);

  // Drag a chat onto a program → attach it (confirm first). A chat that already
  // has a target joins the program directly; a scope-free one opens the popover.
  const dropChatOnProgram = useCallback((sessionId: string, sessionTarget: string, programName: string, programLabel: string) => {
    setDragOverProg("");
    const tgt = (sessionTarget || "").trim();
    if (tgt) {
      // Inline confirm (no native dialog) — rendered as a banner.
      setPendingAttach({ id: sessionId, target: tgt, program: programName, label: programLabel });
    } else {
      // No target on that chat — open it and prompt for the asset to attach.
      switchSession(sessionId);
      setAttachProgram(programName);
      setAttachTarget("");
      setAttachOpen(true);
    }
  }, [switchSession]);

  const confirmPendingAttach = useCallback(() => {
    if (pendingAttach) {
      wsRef.current?.send(JSON.stringify({ type: "attach_session_to_program", id: pendingAttach.id, program: pendingAttach.program }));
    }
    setPendingAttach(null);
  }, [pendingAttach]);

  // Panel resize drag — track the mouse while a divider is held.
  useEffect(() => {
    if (!resizing) return;
    const onMove = (e: MouseEvent) => {
      if (resizing === "left") setLeftW(Math.min(460, Math.max(180, e.clientX)));
      else setRightW(Math.min(560, Math.max(240, window.innerWidth - e.clientX)));
    };
    const onUp = () => setResizing(null);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
  }, [resizing]);
  useEffect(() => { localStorage.setItem("beast.leftW", String(leftW)); }, [leftW]);
  useEffect(() => { localStorage.setItem("beast.rightW", String(rightW)); }, [rightW]);

  const sortedFindings = [...findings].sort(
    (a, b) => (SEV_ORDER[a.severity] ?? 5) - (SEV_ORDER[b.severity] ?? 5) || a.id - b.id
  );

  // Command-palette items: quick actions + every chat, target, and slash
  // command, each with a click action. Reuses the existing handlers so the
  // palette is pure navigation sugar, not a second code path.
  type PItem = { group: string; label: string; hint?: string; run: () => void };
  const paletteItems = useMemo<PItem[]>(() => {
    const items: PItem[] = [
      { group: "Actions", label: "New chat", hint: "Ctrl+N", run: () => newChat() },
      { group: "Actions", label: "Search chats", hint: "Ctrl+F", run: () => setSearchOpen(true) },
      { group: "Actions", label: "Findings workspace", run: () => setNavView("chat") },
      { group: "Actions", label: "Brain (knowledge graph)", run: () => setNavView("graph") },
      { group: "Actions", label: "Settings", run: () => setSettingsOpen(true) },
    ];
    for (const s of sessions) items.push({ group: "Chats", label: s.title || "New chat", hint: s.target || "scope-free", run: () => switchSession(s.id) });
    for (const t of targets) items.push({ group: "Targets", label: t, run: () => switchTarget(t) });
    for (const c of commands) items.push({ group: "Commands", label: c.name, hint: c.description, run: () => pickCommand(c) });
    return items;
  }, [sessions, targets, commands, newChat, switchSession, switchTarget, pickCommand]);

  const paletteFiltered = useMemo(() => {
    const q = paletteQuery.trim().toLowerCase();
    if (!q) return paletteItems;
    return paletteItems.filter((it) => (it.label + " " + (it.hint || "") + " " + it.group).toLowerCase().includes(q));
  }, [paletteItems, paletteQuery]);

  const runPalette = useCallback((it?: PItem) => {
    setPaletteOpen(false);
    setPaletteQuery("");
    it?.run();
  }, []);
  const actions = entries.filter((e): e is ToolCard => e.kind === "tool");
  const runningCount = actions.filter((a) => !a.done).length;

  return (
    <div className={`app ${leftCollapsed ? "l-col" : ""} ${rightCollapsed ? "r-col" : ""} ${resizing ? "resizing" : ""}`}
      style={{ ["--left-w" as any]: `${leftW}px`, ["--right-w" as any]: `${rightW}px` }}>
      {!leftCollapsed && (
        <div className={`resize-handle ${resizing === "left" ? "dragging" : ""}`} title="Drag to resize"
          style={{ left: `${leftW}px` }} onMouseDown={(e) => { e.preventDefault(); setResizing("left"); }} />
      )}
      {!rightCollapsed && (
        <div className={`resize-handle ${resizing === "right" ? "dragging" : ""}`} title="Drag to resize"
          style={{ left: `calc(100% - ${rightW}px)` }} onMouseDown={(e) => { e.preventDefault(); setResizing("right"); }} />
      )}

      {/* ── LEFT RAIL ─── */}
      <aside className={`rail left ${leftCollapsed ? "collapsed" : ""}`}>
        <div className="brand">
          <img className="brand-logo" src={logo} alt="Beast" />
          {!leftCollapsed && <span className="brand-name">BEAST</span>}
          <button
            className="rail-toggle"
            title={leftCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            onClick={() => setLeftCollapsed((v) => !v)}
          >
            {leftCollapsed ? "»" : "«"}
          </button>
        </div>

        {leftCollapsed ? (
          <div className="rail-collapsed-actions">
            <button
              className="collapsed-icon-btn"
              title="Expand sidebar"
              onClick={() => setLeftCollapsed(false)}
            >
              ☰
            </button>
            <button
              className="collapsed-icon-btn"
              title="Settings"
              onClick={() => setSettingsOpen(true)}
            >
              ⚙
            </button>
          </div>
        ) : (
          <>
            <nav className="nav">
              <button className="nav-item" onClick={newChat} title="Start a new chat">
                <svg className="nav-ic" viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" d="M12 5v14M5 12h14"/></svg>
                <span>New</span>
              </button>
              <button className={`nav-item ${searchOpen ? "active" : ""}`} title="Search your chats"
                onClick={() => { setSearchOpen((v) => { const nv = !v; if (!nv) setChatSearch(""); return nv; }); }}>
                <svg className="nav-ic" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" strokeWidth="2"/><path stroke="currentColor" strokeWidth="2" strokeLinecap="round" d="M21 21l-4-4"/></svg>
                <span>Search</span>
              </button>
              <button className={`nav-item ${navView === "chat" ? "active" : ""}`} onClick={() => setNavView("chat")} title="Chat workspace & findings">
                <svg className="nav-ic" viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" d="M4 5h16v11H7l-3 3z"/></svg>
                <span>Findings</span>
              </button>
              <button className={`nav-item ${navView === "graph" ? "active" : ""}`} onClick={() => setNavView("graph")} title="Knowledge graph (Brain)">
                <svg className="nav-ic" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="6" r="2.4" fill="none" stroke="currentColor" strokeWidth="1.8"/><circle cx="6" cy="17" r="2.4" fill="none" stroke="currentColor" strokeWidth="1.8"/><circle cx="18" cy="17" r="2.4" fill="none" stroke="currentColor" strokeWidth="1.8"/><path stroke="currentColor" strokeWidth="1.8" d="M11 8l-4 7M13 8l4 7M8 17h8"/></svg>
                <span>Brain</span>
              </button>
              <button className="nav-item" onClick={() => setSettingsOpen(true)} title="Settings & API keys">
                <svg className="nav-ic" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" strokeWidth="2"/><path fill="none" stroke="currentColor" strokeWidth="1.6" d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1"/></svg>
                <span>Settings</span>
              </button>
            </nav>
            <div className="rail-section-title chats-head">
              <span>CHATS</span>
            </div>
            {searchOpen && (
              <div className="chat-search-wrap">
                <input className="chat-search" autoFocus placeholder="Search chats…" value={chatSearch}
                  onChange={(e) => setChatSearch(e.target.value)} />
                {chatSearch && <button className="chat-search-x" title="Clear" onClick={() => setChatSearch("")}>✕</button>}
              </div>
            )}
            <div className="session-list">
              {searchResults !== null ? (
                <>
                  {searchResults.map((s) => (
                    <div key={s.id} className={`session-row ${s.id === activeSession ? "active" : ""}`}>
                      <button className="session-open" onClick={() => { switchSession(s.id); setChatSearch(""); }} title={s.target ? `on ${s.target}` : "scope-free chat"}>
                        <span className="session-name">{s.title || "New chat"}</span>
                        {s.snippet ? <span className="session-snippet">{s.snippet}</span> : null}
                      </button>
                    </div>
                  ))}
                  {searchResults.length === 0 && <div className="empty">no matches</div>}
                </>
              ) : (
                <>
                  {sessions.map((s) => (
                    <div key={s.id} className={`session-row ${s.id === activeSession ? "active" : ""}`}
                      draggable={renamingId !== s.id}
                      onDragStart={(e) => { e.dataTransfer.setData("application/json", JSON.stringify({ id: s.id, target: s.target || "" })); e.dataTransfer.effectAllowed = "move"; }}
                      title="Drag onto a program below to attach this chat">
                      {renamingId === s.id ? (
                        <input className="session-rename" autoFocus value={renameDraft}
                          onChange={(e) => setRenameDraft(e.target.value)}
                          onBlur={() => renameSession(s.id, renameDraft)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") renameSession(s.id, renameDraft);
                            if (e.key === "Escape") setRenamingId("");
                          }} />
                      ) : (
                        <button className="session-open" onClick={() => switchSession(s.id)}
                          onDoubleClick={() => { setRenamingId(s.id); setRenameDraft(s.title || ""); }}
                          title={s.target ? `on ${s.target} — double-click to rename` : "scope-free chat — double-click to rename"}>
                          <span className="session-name">{s.title || "New chat"}</span>
                          {s.target ? <span className="session-target">{s.target}</span> : null}
                        </button>
                      )}
                      <button className="session-act" title="Export as Markdown" onClick={(e) => { e.stopPropagation(); exportChat(s.id); }}>↓</button>
                      <button className="session-del" title="Delete chat" onClick={(e) => { e.stopPropagation(); deleteSession(s.id); }}>✕</button>
                    </div>
                  ))}
                  {sessions.length === 0 && <div className="empty">no chats yet</div>}
                </>
              )}
            </div>
            <div className="rail-section-title">TARGETS</div>
            <div className="target-list">
              {(() => {
                // A program's apex domains → the program, so a loose subdomain
                // of the same site (content-service.bugbountymasterclass.com)
                // joins its program instead of floating as a separate target.
                const progOf = new Map<string, string>();
                for (const p of programs) for (const t of p.targets) if (targets.includes(t)) progOf.set(apexDomain(t), p.name);

                const inProgram = new Set(programs.flatMap((p) => p.targets.filter((t) => targets.includes(t))));
                const attached = new Map<string, string[]>(); // program.name → loose subs that belong to it
                const trulyLoose: string[] = [];
                for (const t of targets) {
                  if (inProgram.has(t)) continue;
                  const pn = progOf.get(apexDomain(t));
                  if (pn) { const a = attached.get(pn) || []; a.push(t); attached.set(pn, a); }
                  else trulyLoose.push(t);
                }
                const byHost = (a: string, b: string) => a.length - b.length || a.localeCompare(b);

                // Programs — their own hosts plus any loose subdomains of the same site.
                const progEls = programs.map((p) => {
                  const mine = [...new Set([...p.targets.filter((t) => targets.includes(t)), ...(attached.get(p.name) || [])])].sort(byHost);
                  if (mine.length === 0) return null;
                  const collapsed = collapsedPrograms.has(p.name);
                  return (
                    <div key={p.name} className="program-group">
                      <div className={`program-row ${scope.kind === "program" && scope.name === p.name ? "active" : ""} ${dragOverProg === p.name ? "drop-hover" : ""}`}
                        onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; if (dragOverProg !== p.name) setDragOverProg(p.name); }}
                        onDragLeave={() => setDragOverProg((cur) => (cur === p.name ? "" : cur))}
                        onDrop={(e) => {
                          e.preventDefault();
                          try {
                            const d = JSON.parse(e.dataTransfer.getData("application/json") || "{}");
                            if (d.id) dropChatOnProgram(d.id, d.target || "", p.name, p.display_name);
                          } catch { setDragOverProg(""); }
                        }}>
                        <button className="program-arrow" onClick={() => toggleProgram(p.name)}>{collapsed ? "▸" : "▾"}</button>
                        <button className="program-name" onClick={() => selectProgram(p)} title={`View the whole ${p.display_name} program`}>{p.display_name}</button>
                        <button className="program-add" title={`Add an asset to ${p.display_name} and start a chat on it`}
                          onClick={(e) => { e.stopPropagation(); setAddingProgram(addingProgram === p.name ? "" : p.name); setAddAsset(""); }}>+</button>
                      </div>
                      {addingProgram === p.name && (
                        <div className="program-add-row">
                          <input
                            className="program-add-input"
                            autoFocus
                            value={addAsset}
                            placeholder="asset to attack, e.g. app.example.com"
                            onChange={(e) => setAddAsset(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") { e.preventDefault(); addToProgram(p.name); }
                              if (e.key === "Escape") { setAddingProgram(""); setAddAsset(""); }
                            }}
                          />
                          <button className="program-add-go" onClick={() => addToProgram(p.name)} disabled={!addAsset.trim()}>Start</button>
                        </div>
                      )}
                      {!collapsed && mine.map((t) => (
                        <button key={t} className={`target nested ${t === activeTarget ? "active" : ""}`} onClick={() => switchTarget(t)} title={t}>
                          <span className="target-dot" /><span className="target-name">{t}</span>
                        </button>
                      ))}
                    </div>
                  );
                });

                // Truly-loose targets grouped by apex domain → a sitemap tree per site.
                const byApex = new Map<string, string[]>();
                for (const t of trulyLoose) { const a = apexDomain(t); const arr = byApex.get(a); if (arr) arr.push(t); else byApex.set(a, [t]); }
                const looseEls = [...byApex.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([apex, subs]) => {
                  if (subs.length === 1) {
                    const t = subs[0];
                    return (
                      <button key={t} className={`target ${t === activeTarget ? "active" : ""}`} onClick={() => switchTarget(t)}>
                        <span className="target-dot" /><span className="target-name">{t}</span>
                      </button>
                    );
                  }
                  const key = `apex:${apex}`;
                  const collapsed = collapsedPrograms.has(key);
                  return (
                    <div key={key} className="program-group">
                      <div className="program-row">
                        <button className="program-arrow" onClick={() => toggleProgram(key)}>{collapsed ? "▸" : "▾"}</button>
                        <span className="program-name" title={`${subs.length} hosts under ${apex}`}>{apex}</span>
                      </div>
                      {!collapsed && [...subs].sort(byHost).map((t) => (
                        <button key={t} className={`target nested ${t === activeTarget ? "active" : ""}`} onClick={() => switchTarget(t)} title={t}>
                          <span className="target-dot" /><span className="target-name">{subLabel(t, apex)}</span>
                        </button>
                      ))}
                    </div>
                  );
                });

                return [...progEls, ...looseEls];
              })()}
              {targets.length === 0 && <div className="empty">no targets yet</div>}
            </div>
          </>
        )}
      </aside>

      {/* ── CENTER ─── */}
      <main className="center">
        <header className="topbar">
          {leftCollapsed && (
            <button
              className="topbar-toggle-btn"
              title="Expand sidebar"
              onClick={() => setLeftCollapsed(false)}
            >
              ☰
            </button>
          )}
          <div className="tb-target">
            <span className={`target-badge ${hasTarget ? "" : "unset"}`}>{hasTarget ? activeTarget : "No target yet"}</span>
            {scope.kind === "program" && (
              <span className="program-badge" title="Findings and Knowledge Graph are showing the whole program; chat still talks to the target above">
                whole program: {programs.find((p) => p.name === scope.name)?.display_name || scope.name}
              </span>
            )}
          </div>
          <div className="tb-meta">
            {findings.length > 0 && (
              <span className="tb-findings-count">{findings.length} findings</span>
            )}
            {programs.length > 0 && (
              <button className="tb-attach-btn" title="Attach this chat to a program" onClick={openAttach}>
                ⛓ Attach
              </button>
            )}
            <button className="tb-clear-btn" title="Clear chat for this target" onClick={clearChat}>
              clear chat
            </button>
            <div className={`tb-status ${connected ? "ok" : "err"}`}>
              {connected ? "● connected" : "○ reconnecting"}
            </div>
            <button
              className="topbar-toggle-btn right-toggle"
              title={rightCollapsed ? "Show Actions & Findings" : "Hide panel"}
              onClick={() => setRightCollapsed((v) => !v)}
            >
              {rightCollapsed ? "« panel" : "»"}
            </button>
          </div>
        </header>

        {pendingAttach && (
          <div className="attach-confirm">
            <span>Attach <strong>{pendingAttach.target}</strong> to the <strong>{pendingAttach.label}</strong> program?</span>
            <div className="attach-confirm-actions">
              <button className="attach-go" onClick={confirmPendingAttach}>Attach</button>
              <button className="attach-cancel" onClick={() => setPendingAttach(null)}>Cancel</button>
            </div>
          </div>
        )}

        {attachOpen && (
          <div className="attach-popover">
            <div className="attach-pop-title">Attach this chat to a program</div>
            <div className="attach-pop-row">
              <select value={attachProgram} onChange={(e) => setAttachProgram(e.target.value)}>
                {programs.length === 0 && <option value="">no programs yet</option>}
                {programs.map((p) => <option key={p.name} value={p.name}>{p.display_name}</option>)}
              </select>
              <input value={attachTarget} placeholder="asset domain, e.g. app.example.com"
                onChange={(e) => setAttachTarget(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); attachCurrentToProgram(); } if (e.key === "Escape") setAttachOpen(false); }} />
            </div>
            <div className="attach-pop-actions">
              <button className="attach-go" disabled={!attachTarget.trim() || !attachProgram} onClick={attachCurrentToProgram}>Attach</button>
              <button className="attach-cancel" onClick={() => setAttachOpen(false)}>Cancel</button>
            </div>
          </div>
        )}

        {navView === "graph" ? (
          <Brain
            activeTarget={hasTarget ? activeTarget : undefined}
            apiBase={API}
            onViewReport={(title: string, file: string, target?: string) => setReport({ title, file, target: target || activeTarget || "" })}
          />
        ) : (
        <>
        <div className="log" ref={logRef} onScroll={handleLogScroll}>
          {entries.length === 0 && (
            <div className="chat-empty-state">
              <img className="empty-logo" src={logo} alt="Beast" />
              <h2>BEAST</h2>
              <p>
                {hasTarget
                  ? <>Target: <strong>{activeTarget}</strong>. Tell me what to go after.</>
                  : "Point me at a domain, or pick an existing engagement from the sidebar."}
              </p>
              <div className="empty-suggestions">
                {hasTarget ? (
                  <>
                    <button onClick={() => setInput(`recon ${activeTarget} and discover endpoints`)}>
                      <code>recon {activeTarget} and discover endpoints</code>
                    </button>
                    <button onClick={() => setInput(`check ${activeTarget} for IDOR and access control issues`)}>
                      <code>check {activeTarget} for IDOR and access control issues</code>
                    </button>
                  </>
                ) : (
                  <>
                    <button onClick={() => { setInput("recon "); inputRef.current?.focus(); }}>
                      <code>recon &lt;domain&gt;</code>
                    </button>
                    <button onClick={() => { setInput("/program "); inputRef.current?.focus(); }}>
                      <code>/program list</code>
                    </button>
                  </>
                )}
                <button onClick={() => setInput("what did we find so far?")}>
                  <code>what did we find so far?</code>
                </button>
              </div>
              {!hasTarget && programs.length > 0 && (
                <div className="empty-attach">
                  <button className="attach-open-btn" onClick={openAttach}>
                    ⛓ Attach this chat to a program
                  </button>
                </div>
              )}
            </div>
          )}

          {(() => {
            let lastAssistantIdx = -1;
            for (let j = entries.length - 1; j >= 0; j--) { if (entries[j].kind === "assistant") { lastAssistantIdx = j; break; } }
            let uCount = -1;
            return entries.map((e, i) => {
              let userIndex = -1;
              if (e.kind === "user") { uCount++; userIndex = uCount; }
              return (
                <EntryRow key={i} entry={e}
                  isLastAssistant={i === lastAssistantIdx && !busy}
                  userIndex={userIndex}
                  onRegenerate={regenerate}
                  onEdit={busy ? undefined : editResend} />
              );
            });
          })()}

          {statusLabel && (
            <div className="turn-status-bar">
              <span className="spinner" />
              <span>{statusLabel}</span>
            </div>
          )}
        </div>

        {userScrolled && entries.length > 0 && (
          <button className="scroll-bottom" title="Jump to latest" onClick={scrollToBottom}>
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" d="M12 5v14M6 13l6 6 6-6"/></svg>
          </button>
        )}

        <div className="composer-area">
          {slashActive && slashFiltered.length > 0 && (
            <div className="slash-popup">
              {slashFiltered.map((c, i) => (
                <button
                  key={c.name}
                  className={`slash-item ${i === cmdHighlight ? "highlight" : ""}`}
                  onClick={() => pickCommand(c)}
                  onMouseEnter={() => setCmdHighlight(i)}
                >
                  <span className="slash-name">{c.name}</span>
                  <span className="slash-cat">{c.category}</span>
                  <span className="slash-desc">{c.description}</span>
                </button>
              ))}
            </div>
          )}
          <div className="composer">
            <button
              className="slash-trigger"
              title="Browse slash commands"
              onClick={() => { setInput("/"); inputRef.current?.focus(); }}
            >
              /
            </button>
            <textarea
              ref={inputRef}
              value={input}
              placeholder={busy ? "Hunting in progress… (you can queue more instructions)" : hasTarget ? `Message BEAST about ${activeTarget}… ("/" for commands)` : `Message BEAST… ("/" for commands)`}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (slashActive && slashFiltered.length > 0) {
                  if (e.key === "ArrowDown") { e.preventDefault(); setCmdHighlight((h) => (h + 1) % slashFiltered.length); return; }
                  if (e.key === "ArrowUp") { e.preventDefault(); setCmdHighlight((h) => (h - 1 + slashFiltered.length) % slashFiltered.length); return; }
                  if (e.key === "Tab" || e.key === "Enter") { e.preventDefault(); pickCommand(slashFiltered[cmdHighlight]); return; }
                  if (e.key === "Escape") { e.preventDefault(); setInput(""); return; }
                }
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              rows={1}
            />
            {busy ? (
              <button className="send stop" onClick={stopTurn} title="Stop generating">
                <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/></svg>
                Stop
              </button>
            ) : (
              <button className="send" onClick={send} disabled={!connected || !input.trim()}>
                Send
              </button>
            )}
          </div>
        </div>
        </>
        )}
      </main>

      {/* ── RIGHT RAIL ─── */}
      <aside className={`rail right ${rightCollapsed ? "collapsed" : ""}`}>
        <button
          className="rail-toggle solo"
          title={rightCollapsed ? "Show findings & actions" : "Hide panel"}
          onClick={() => setRightCollapsed((v) => !v)}
        >
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
                  {scope.kind === "program" && f.target && <div className="finding-ep">{f.target}</div>}
                  {f.endpoint && <div className="finding-ep">{f.endpoint}</div>}
                  {f.report && (
                    <button
                      className="view-report"
                      onClick={() => setReport({ title: f.title || "report", file: f.report!, target: f.target || activeTarget })}
                    >
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
          target={report.target}
          file={report.file}
          api={API}
          onClose={() => setReport(null)}
        />
      )}
      {paletteOpen && (
        <div className="palette-backdrop" onClick={() => runPalette()}>
          <div className="palette" onClick={(e) => e.stopPropagation()}>
            <input
              className="palette-input"
              autoFocus
              placeholder="Jump to a chat, target, or command…"
              value={paletteQuery}
              onChange={(e) => { setPaletteQuery(e.target.value); setPaletteIdx(0); }}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") { e.preventDefault(); setPaletteIdx((i) => Math.min(paletteFiltered.length - 1, i + 1)); }
                else if (e.key === "ArrowUp") { e.preventDefault(); setPaletteIdx((i) => Math.max(0, i - 1)); }
                else if (e.key === "Enter") { e.preventDefault(); runPalette(paletteFiltered[paletteIdx]); }
                else if (e.key === "Escape") { e.preventDefault(); setPaletteOpen(false); }
              }}
            />
            <div className="palette-list">
              {paletteFiltered.map((it, i) => (
                <button
                  key={it.group + it.label + i}
                  className={`palette-row ${i === paletteIdx ? "active" : ""}`}
                  onMouseEnter={() => setPaletteIdx(i)}
                  onClick={() => runPalette(it)}
                >
                  <span className="palette-group">{it.group}</span>
                  <span className="palette-label">{it.label}</span>
                  {it.hint && <span className="palette-hint">{it.hint}</span>}
                </button>
              ))}
              {paletteFiltered.length === 0 && <div className="empty">no matches</div>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Component to render any Entry row (User prompt, Assistant reply, Tool Card, or Status) */
function EntryRow({ entry, isLastAssistant, userIndex, onRegenerate, onEdit }: {
  entry: Entry;
  isLastAssistant?: boolean;
  userIndex?: number;
  onRegenerate?: () => void;
  onEdit?: (userIndex: number, text: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  if (entry.kind === "user") {
    const canEdit = !!onEdit && (userIndex ?? -1) >= 0;
    if (editing) {
      const commit = () => { onEdit?.(userIndex ?? -1, draft); setEditing(false); };
      return (
        <div className="chat-row user-row">
          <div className="user-edit">
            <textarea className="user-edit-area" value={draft} autoFocus
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); commit(); }
                if (e.key === "Escape") setEditing(false);
              }} />
            <div className="user-edit-actions">
              <button className="ue-btn" onClick={commit}>Send</button>
              <button className="ue-btn ghost" onClick={() => setEditing(false)}>Cancel</button>
            </div>
          </div>
        </div>
      );
    }
    return (
      <div className="chat-row user-row">
        <div className="user-bubble">
          {entry.text}
          {canEdit && (
            <button className="user-edit-btn" title="Edit & resend"
              onClick={() => { setDraft(entry.text); setEditing(true); }}>
              <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
            </button>
          )}
        </div>
      </div>
    );
  }

  if (entry.kind === "assistant") {
    return (
      <div className="chat-row assistant-row">
        <div className="assistant-avatar">
          <img src={logo} alt="Beast" />
        </div>
        <div className="assistant-content">
          <div className="assistant-header">
            <span className="assistant-name">BEAST</span>
          </div>
          <div className="assistant-body md" onClick={handleCodeCopy} dangerouslySetInnerHTML={renderMd(entry.text)} />
          {entry.streaming && <span className="stream-caret" />}
          {!entry.streaming && entry.text && (
            <div className="msg-actions">
              <button className="act-btn" title="Copy message"
                onClick={(ev) => {
                  const btn = ev.currentTarget;
                  navigator.clipboard?.writeText(entry.text).then(() => {
                    btn.classList.add("ok");
                    setTimeout(() => btn.classList.remove("ok"), 1300);
                  }).catch(() => {});
                }}>
                <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" d="M9 9h10v10H9zM5 15V5h10"/></svg>
                <span className="act-label">Copy</span>
              </button>
              <button className="act-btn" title="Share / copy as quote"
                onClick={(ev) => {
                  const btn = ev.currentTarget;
                  const share = `> ${entry.text.replace(/\n/g, "\n> ")}\n\n— BEAST`;
                  const done = () => { btn.classList.add("ok"); setTimeout(() => btn.classList.remove("ok"), 1300); };
                  if (navigator.share) { navigator.share({ text: entry.text }).then(done).catch(() => {}); }
                  else { navigator.clipboard?.writeText(share).then(done).catch(() => {}); }
                }}>
                <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7M16 6l-4-4-4 4M12 2v13"/></svg>
                <span className="act-label">Share</span>
              </button>
              {isLastAssistant && onRegenerate && (
                <button className="act-btn" title="Regenerate reply" onClick={onRegenerate}>
                  <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6"/></svg>
                  <span className="act-label">Retry</span>
                </button>
              )}
              {(entry.elapsedMs || entry.at) && (
                <span className="act-time" title={fmtClock(entry.at)}>
                  {entry.elapsedMs ? fmtDuration(entry.elapsedMs) : fmtClock(entry.at)}
                </span>
              )}
            </div>
          )}
        </div>
      </div>
    );
  }

  if (entry.kind === "tool") {
    return <ToolCardView card={entry} />;
  }

  // Generic log line (finding, error, section)
  if (entry.logKind === "finding") {
    return <div className="line finding">{entry.text}</div>;
  }
  if (entry.logKind === "section") {
    return <div className="line section">{entry.text}</div>;
  }
  return <div className={`line ${entry.logKind}`}>{entry.text}</div>;
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
      {open && card.done && <pre className="tool-result">{preview.slice(0, 25000)}</pre>}
    </div>
  );
}

function ReportModal({ title, target, file, api, onClose }: { title: string; target: string; file: string; api: string; onClose: () => void }) {
  const url = `${api}/api/report?target=${encodeURIComponent(target)}&file=${encodeURIComponent(file)}`;
  const isMd = file.toLowerCase().endsWith(".md");
  const [md, setMd] = useState<string | null>(null);

  useEffect(() => {
    if (!isMd) return;
    let live = true;
    fetch(url).then((r) => r.text()).then((t) => { if (live) setMd(t); }).catch(() => { if (live) setMd("*Failed to load report.*"); });
    return () => { live = false; };
  }, [url, isMd]);

  // Render the Markdown, rewriting relative image paths to the asset endpoint
  // so `![](shot.png)` in a report resolves from the target's own storage.
  const html = useMemo(() => {
    if (md == null) return "";
    let out = marked.parse(md) as string;
    out = out.replace(
      /(<img[^>]+src=")(?!https?:|data:|\/)([^"]+)(")/g,
      (_m, a, p, b) => `${a}${api}/api/report-asset?target=${encodeURIComponent(target)}&file=${encodeURIComponent(p)}${b}`
    );
    return out;
  }, [md, api, target]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal report-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head"><span>{title}</span><button onClick={onClose}>✕</button></div>
        {isMd ? (
          <div className="report-frame report-md" dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <iframe className="report-frame" src={url} title={title} />
        )}
      </div>
    </div>
  );
}

interface ToolKey {
  tool: string;
  set: boolean;
  masked: string | null;
  source: string | null;
  hint: string;
}

const SETTINGS_TABS = ["models", "llm-keys", "tool-keys", "profile", "behavior"] as const;
type SettingsTab = (typeof SETTINGS_TABS)[number];
const SETTINGS_TAB_LABELS: Record<SettingsTab, string> = {
  "models": "Models",
  "llm-keys": "LLM API Keys",
  "tool-keys": "Recon Tool Keys",
  "profile": "Handle & Headers",
  "behavior": "Behavior",
};

function SettingsModal({ onClose }: { onClose: () => void }) {
  const [cfg, setCfg] = useState<Config | null>(null);
  const [tab, setTab] = useState<SettingsTab>("models");
  const [keyProvider, setKeyProvider] = useState<string>("nvidia");
  const [keyValue, setKeyValue] = useState("");
  const [saved, setSaved] = useState("");

  const [toolKeys, setToolKeys] = useState<ToolKey[]>([]);
  const [newTool, setNewTool] = useState("");
  const [newToolValue, setNewToolValue] = useState("");

  const [headers, setHeaders] = useState<Record<string, string>>({});
  const [newHeaderName, setNewHeaderName] = useState("");
  const [newHeaderValue, setNewHeaderValue] = useState("");

  useEffect(() => {
    fetch(`${API}/api/config`).then((r) => r.json()).then(setCfg).catch(() => setCfg(null));
    refreshToolKeys();
    refreshHeaders();
  }, []);

  const refreshToolKeys = () => fetch(`${API}/api/tool-keys`).then((r) => r.json()).then((d) => setToolKeys(d.tools || [])).catch(() => {});
  const refreshHeaders = () => fetch(`${API}/api/headers`).then((r) => r.json()).then((d) => setHeaders(d.headers || {})).catch(() => {});

  const patch = (p: Partial<Config>) => setCfg((c) => (c ? { ...c, ...p } : c));
  const flash = (msg: string) => { setSaved(msg); setTimeout(() => setSaved(""), 1500); };

  const saveConfig = async () => {
    if (!cfg) return;
    const r = await fetch(`${API}/api/config`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(cfg),
    });
    setCfg(await r.json()); flash("saved ✓");
  };

  const saveKey = async () => {
    if (!keyValue.trim()) return;
    await fetch(`${API}/api/apikey`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: keyProvider, key: keyValue }),
    });
    setKeyValue(""); flash(`${keyProvider} key saved ✓`);
    const r = await fetch(`${API}/api/config`); setCfg(await r.json());
  };

  const saveToolKey = async (tool: string, value: string) => {
    if (!tool.trim() || !value.trim()) return;
    await fetch(`${API}/api/tool-keys`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool, value }),
    });
    setNewTool(""); setNewToolValue(""); flash(`${tool} key saved ✓`);
    refreshToolKeys();
  };

  const clearToolKey = async (tool: string) => {
    await fetch(`${API}/api/tool-keys/delete`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tool }),
    });
    flash(`${tool} key cleared`);
    refreshToolKeys();
  };

  const saveHeader = async () => {
    if (!newHeaderName.trim()) return;
    await fetch(`${API}/api/headers`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newHeaderName, value: newHeaderValue }),
    });
    setNewHeaderName(""); setNewHeaderValue(""); flash("header saved ✓");
    refreshHeaders();
  };

  const deleteHeader = async (name: string) => {
    await fetch(`${API}/api/headers/delete`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }),
    });
    flash("header removed");
    refreshHeaders();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head"><span>Settings</span><button onClick={onClose}>✕</button></div>
        <div className="modal-tabs">
          {SETTINGS_TABS.map((t) => (
            <button key={t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>
              {SETTINGS_TAB_LABELS[t]}
            </button>
          ))}
        </div>
        <div className="modal-body">
          {!cfg && <div className="empty">loading…</div>}
          {cfg && tab === "models" && (
            <>
              <Field label="Orchestrator provider">
                <ProviderSelect value={cfg.orchestrator_provider} configured={cfg.configured_providers} onChange={(v) => patch({ orchestrator_provider: v })} />
              </Field>
              <Field label="Orchestrator model">
                <input value={cfg.orchestrator_model} onChange={(e) => patch({ orchestrator_model: e.target.value })} />
              </Field>
              <Field label="Synthesizer provider">
                <ProviderSelect value={cfg.synthesizer_provider} configured={cfg.configured_providers} onChange={(v) => patch({ synthesizer_provider: v })} />
              </Field>
              <Field label="Synthesizer model">
                <input value={cfg.synthesizer_model} onChange={(e) => patch({ synthesizer_model: e.target.value })} />
              </Field>
            </>
          )}
          {cfg && tab === "llm-keys" && (
            <>
              <p className="settings-hint">Keys for the model providers powering the orchestrator/synthesizer.</p>
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
          {tab === "tool-keys" && (
            <>
              <p className="settings-hint">Keys for external recon tools — separate from the LLM provider keys above. Saved once, reused on every future target.</p>
              <div className="kv-list">
                {toolKeys.map((tk) => (
                  <div key={tk.tool} className="kv-row">
                    <span className="kv-key">{tk.tool}</span>
                    {tk.set ? (
                      <>
                        <span className="kv-val masked">{tk.masked}{tk.source && tk.source !== "/apikey" ? ` (via ${tk.source})` : ""}</span>
                        <button className="kv-del" onClick={() => clearToolKey(tk.tool)}>clear</button>
                      </>
                    ) : (
                      <span className="kv-val unset" title={tk.hint}>unset{tk.hint ? ` — ${tk.hint}` : ""}</span>
                    )}
                  </div>
                ))}
                {toolKeys.length === 0 && <div className="empty">loading…</div>}
              </div>
              <div className="kv-add">
                <input placeholder="tool (e.g. wpscan)" value={newTool} onChange={(e) => setNewTool(e.target.value)} />
                <input type="password" placeholder="key" value={newToolValue} onChange={(e) => setNewToolValue(e.target.value)} />
                <button className="primary" onClick={() => saveToolKey(newTool, newToolValue)}>Add</button>
              </div>
            </>
          )}
          {tab === "profile" && (
            <>
              {cfg && (
                <Field label="Researcher handle (X-Bugbounty header + sign-off)">
                  <input value={cfg.researcher_handle} onChange={(e) => patch({ researcher_handle: e.target.value })} />
                </Field>
              )}
              <p className="settings-hint">Custom HTTP headers sent with every outgoing request (e.g. program-required auth tokens).</p>
              <div className="kv-list">
                {Object.entries(headers).map(([name, value]) => (
                  <div key={name} className="kv-row">
                    <span className="kv-key">{name}</span>
                    <span className="kv-val">{value}</span>
                    <button className="kv-del" onClick={() => deleteHeader(name)}>remove</button>
                  </div>
                ))}
                {Object.keys(headers).length === 0 && <div className="empty">no custom headers set</div>}
              </div>
              <div className="kv-add">
                <input placeholder="Header-Name" value={newHeaderName} onChange={(e) => setNewHeaderName(e.target.value)} />
                <input placeholder="value" value={newHeaderValue} onChange={(e) => setNewHeaderValue(e.target.value)} />
                <button className="primary" onClick={saveHeader}>Add</button>
              </div>
            </>
          )}
          {cfg && tab === "behavior" && (
            <>
              <Field label="Fuzz rate limit (req/s)"><input type="number" value={cfg.fuzz_rate_limit} onChange={(e) => patch({ fuzz_rate_limit: Number(e.target.value) })} /></Field>
              <Field label="Max agent iterations"><input type="number" value={cfg.max_agent_iterations} onChange={(e) => patch({ max_agent_iterations: Number(e.target.value) })} /></Field>
              <label className="check"><input type="checkbox" checked={cfg.auto_install_missing_tools} onChange={(e) => patch({ auto_install_missing_tools: e.target.checked })} /> Auto-install missing tools</label>
              <label className="check"><input type="checkbox" checked={cfg.show_recaps} onChange={(e) => patch({ show_recaps: e.target.checked })} /> Show recaps</label>
            </>
          )}
        </div>
        <div className="modal-foot">
          <span className="saved">{saved}</span>
          {(tab === "models" || tab === "profile" || tab === "behavior") && (
            <button className="primary" onClick={saveConfig} disabled={!cfg}>Save</button>
          )}
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
