"""
beast_gui/backend/server.py

The GUI's backend process. Does NOT reimplement any agent logic — it is a
thin WebSocket wrapper around the exact same hellhound.core.agent.get_agent /
Agent.handle_message entrypoint the classic REPL (chat_ui.py) and the
Textual TUI (tui.py) already call, using the project's existing
Target/create_or_load_target/save_target helpers (hellhound/core/tasks.py)
for session state, so a target opened in the GUI is the same saved target
you can `beast` into from a terminal.

Run standalone (dev):  python3 -m beast_gui.backend.server
The `beast --gui` CLI flag (hellhound/cli.py) launches this the same way.
"""

from __future__ import annotations

import asyncio
import json
import os
import subprocess  # used by _ensure_brain_running / _stop_brain (annotations are strings via __future__)
import sys
import threading  # cooperative turn-cancellation flag (Stop generation)
from pathlib import Path

# Make the existing `hellhound` package importable regardless of cwd —
# this file lives at <repo>/beast_gui/backend/server.py.
_REPO_ROOT = Path(__file__).resolve().parents[2]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

# Every slash-command handler that might block on input() (e.g. /setup) checks
# this exact flag to skip interactive prompts — same guard tui.py sets before
# starting its own full-screen loop. Without it, a worker thread here would
# hang forever waiting on a stdin read nothing will ever satisfy.
os.environ.setdefault("BEAST_TUI", "1")

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from beast_gui.backend.gui_emit import GuiEmit

app = FastAPI(title="BEAST GUI backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

KNOWN_PROVIDERS = ("nvidia", "openai", "anthropic", "gemini", "ollama")


# ── config / settings (same ~/.beast/config.json the CLI /model, /setup, /apikey write) ──
def _redacted_config() -> dict:
    from hellhound.core.ai_utils import load_config
    cfg = load_config()
    api_keys = cfg.get("api_keys", {}) or {}
    return {
        "orchestrator_provider": cfg.get("orchestrator_provider", cfg.get("ai_provider", "nvidia")),
        "orchestrator_model": cfg.get("orchestrator_model", cfg.get("ai_model", "")),
        "synthesizer_provider": cfg.get("synthesizer_provider", cfg.get("ai_provider", "nvidia")),
        "synthesizer_model": cfg.get("synthesizer_model", cfg.get("ai_model", "")),
        "researcher_handle": cfg.get("researcher_handle", ""),
        "auto_install_missing_tools": bool(cfg.get("auto_install_missing_tools", False)),
        "show_recaps": bool(cfg.get("show_recaps", True)),
        "fuzz_rate_limit": cfg.get("fuzz_rate_limit", 150),
        "max_agent_iterations": cfg.get("max_agent_iterations", 60),
        "configured_providers": [p for p in KNOWN_PROVIDERS if p == "ollama" or bool(api_keys.get(p))],
    }


@app.get("/api/config")
def get_config():
    return _redacted_config()


@app.post("/api/config")
async def post_config(payload: dict):
    from hellhound.core.ai_utils import load_config, save_config
    cfg = load_config()
    for key in (
        "orchestrator_provider", "orchestrator_model",
        "synthesizer_provider", "synthesizer_model", "researcher_handle",
        "auto_install_missing_tools", "show_recaps",
        "fuzz_rate_limit", "max_agent_iterations",
    ):
        if key in payload:
            cfg[key] = payload[key]
    save_config(cfg)
    return _redacted_config()


@app.post("/api/apikey")
async def post_apikey(payload: dict):
    """Same store `/model set-key <provider> <key>` writes — never logged/echoed."""
    from hellhound.core.ai_utils import load_config, save_config
    provider = str(payload.get("provider", "")).strip().lower()
    key = str(payload.get("key", "")).strip()
    if provider not in KNOWN_PROVIDERS or provider == "ollama" or not key:
        return {"status": "error", "error": "invalid_provider_or_key"}
    cfg = load_config()
    cfg.setdefault("api_keys", {})[provider] = key
    save_config(cfg)
    return {"status": "success", "provider": provider}


@app.get("/api/commands")
def get_commands():
    """Registered slash commands (name/description/usage/category) for the
    chat input's "/" picker — the exact same registry tui.py autocompletes
    against, so the GUI never drifts from what the command layer actually
    supports."""
    from hellhound.core.commands import COMMAND_REGISTRY
    seen = {}
    for cmd in COMMAND_REGISTRY.values():
        if cmd.name not in seen:
            seen[cmd.name] = {
                "name": cmd.name,
                "aliases": cmd.aliases,
                "description": cmd.description,
                "usage": cmd.usage,
                "category": cmd.category,
            }
    return {"commands": sorted(seen.values(), key=lambda c: (c["category"], c["name"]))}


@app.get("/api/brain")
def get_brain():
    """Beast's own brain — not a view of any target. Three hubs: Lessons
    Learned (hellhound/memory/lessons.py's ~/.beast/lessons.json, the
    closest thing to self-learning it has, since there's no fine-tuning the
    underlying model), Skills (methodology playbooks in hellhound/skills/ +
    ~/.beast/skills/, with real usage counts), and Tools (every tool the
    agent can actually call, TOOL_REGISTRY). This is the ONLY place that
    knowledge is shown — a target's own findings are a separate, per-target
    concern rendered inline in the chat's right-hand dock, not here."""
    from hellhound.memory.lessons import load_lessons
    from hellhound.core.skills import discover_skills, get_skill_usage_counts, get_short_description
    from hellhound.core.agent import TOOL_REGISTRY

    items = []
    for i, l in enumerate(load_lessons()):
        if not isinstance(l, dict):
            continue
        items.append({
            "id": f"item:lessons:{i}", "hub": "lessons",
            "label": str(l.get("technique", ""))[:160],
            "detail": str(l.get("note", ""))[:500],
            "meta": f"{l.get('outcome', 'worked')} · seen {int(l.get('seen_count', 1) or 1)}×",
            "tags": l.get("tech_signature") or [],
        })

    usage = get_skill_usage_counts()
    for i, (name, s) in enumerate(sorted(discover_skills().items())):
        items.append({
            "id": f"item:skills:{i}", "hub": "skills",
            "label": name,
            "detail": get_short_description(s.description or ""),
            "meta": f"used {usage.get(name.lower(), 0)}×" + (" · custom" if s.is_user_defined else ""),
            "tags": [],
        })

    for i, (name, spec) in enumerate(sorted(TOOL_REGISTRY.items())):
        items.append({
            "id": f"item:tools:{i}", "hub": "tools",
            "label": name,
            "detail": str(spec.description or "")[:300],
            "meta": "",
            "tags": [],
        })

    counts: dict = {}
    for it in items:
        counts[it["hub"]] = counts.get(it["hub"], 0) + 1
    hubs = [
        {"id": "lessons", "label": "Lessons Learned", "count": counts.get("lessons", 0)},
        {"id": "skills", "label": "Skills", "count": counts.get("skills", 0)},
        {"id": "tools", "label": "Tools", "count": counts.get("tools", 0)},
    ]
    return {"hubs": hubs, "items": items}


@app.get("/api/headers")
def get_headers():
    """Global custom HTTP headers — the same ~/.beast/config.json["global_headers"]
    /headers manages, so a header set here is used on every tool's requests
    exactly like it would be from the TUI."""
    from hellhound.core.ai_utils import load_config
    return {"headers": load_config().get("global_headers") or {}}


@app.post("/api/headers")
async def post_header(payload: dict):
    from hellhound.core.ai_utils import load_config, save_config
    name = str(payload.get("name", "")).strip()
    if not name:
        return JSONResponse({"error": "missing_name"}, status_code=400)
    cfg = load_config()
    headers = cfg.get("global_headers") or {}
    headers[name] = str(payload.get("value", "")).strip()
    cfg["global_headers"] = headers
    save_config(cfg)
    return {"headers": headers}


@app.post("/api/headers/delete")
async def delete_header(payload: dict):
    from hellhound.core.ai_utils import load_config, save_config
    cfg = load_config()
    headers = cfg.get("global_headers") or {}
    headers.pop(str(payload.get("name", "")).strip(), None)
    cfg["global_headers"] = headers
    save_config(cfg)
    return {"headers": headers}


@app.get("/api/tool-keys")
def get_tool_keys():
    """API keys for external recon tools (wpscan, virustotal, urlscan, ...) —
    a separate namespace from the LLM provider keys /api/apikey manages.
    Same resolution order the tool executors themselves use (tool_api_keys ->
    LLM api_keys bucket -> env var), via commands.py's own helpers so this
    never drifts from what /apikey already reports."""
    from hellhound.core.ai_utils import load_config
    from hellhound.core.commands import KNOWN_TOOL_API_KEYS, _resolve_tool_key, _mask_secret
    cfg = load_config()
    tool_keys = cfg.get("tool_api_keys") or {}
    api_keys = cfg.get("api_keys") or {}
    names = sorted(set(KNOWN_TOOL_API_KEYS) | set(tool_keys))
    tools = []
    for name in names:
        val, source = _resolve_tool_key(name, tool_keys, api_keys)
        tools.append({
            "tool": name,
            "set": bool(val),
            "masked": _mask_secret(str(val)) if val else None,
            "source": source,
            "hint": KNOWN_TOOL_API_KEYS.get(name, ""),
        })
    return {"tools": tools}


@app.post("/api/tool-keys")
async def post_tool_key(payload: dict):
    from hellhound.core.ai_utils import load_config, save_config
    tool = str(payload.get("tool", "")).strip().lower()
    value = str(payload.get("value", "")).strip()
    if not tool or not value:
        return JSONResponse({"error": "missing_tool_or_value"}, status_code=400)
    cfg = load_config()
    tool_keys = cfg.get("tool_api_keys") or {}
    tool_keys[tool] = value
    cfg["tool_api_keys"] = tool_keys
    save_config(cfg)
    return {"status": "success", "tool": tool}


@app.post("/api/tool-keys/delete")
async def delete_tool_key(payload: dict):
    from hellhound.core.ai_utils import load_config, save_config
    cfg = load_config()
    tool_keys = cfg.get("tool_api_keys") or {}
    tool_keys.pop(str(payload.get("tool", "")).strip().lower(), None)
    cfg["tool_api_keys"] = tool_keys
    save_config(cfg)
    return {"status": "success"}


@app.get("/api/models")
def get_models():
    from hellhound.core.ai_utils import list_available_models
    try:
        return {"models": list_available_models()}
    except Exception as exc:
        return {"models": [], "error": str(exc)}


# ── targets / findings / reports ──────────────────────────────────────────
def _list_targets():
    """list_targets(exclude_default=True) also drops every dotless name
    (e.g. 'localhost', a real target with real findings) — too blunt for the
    GUI's sidebar. Fetch everything and hide only the literal 'default'
    scratch bucket, the one entry that's never a real engagement."""
    from hellhound.core.tasks import list_targets, is_target_private
    try:
        return [t for t in list_targets(exclude_default=False) if t != "default" and not is_target_private(t)]
    except Exception:
        return []


def _findings_for(target_name: str) -> list:
    """Recorded findings for a target, shaped for the GUI panel (severity, class,
    title, endpoint, affected hosts, and whether an HTML report exists)."""
    from hellhound.core.tasks import create_or_load_target
    try:
        tgt = create_or_load_target(target_name)
    except Exception:
        return []
    out = []
    for i, f in enumerate(getattr(tgt, "findings", []) or []):
        if not isinstance(f, dict):
            continue
        report_path = f.get("report_path")
        out.append({
            "id": i,
            "severity": str(f.get("severity", "medium")),
            "kind": str(f.get("kind", "")),
            "title": str(f.get("type", "")),
            "endpoint": str(f.get("target", "")),
            "note": str(f.get("note", ""))[:600],
            "affected_hosts": f.get("affected_hosts") or [],
            "report": os.path.basename(report_path) if report_path else None,
        })
    return out


def _program_target_names(program_name: str) -> list:
    from hellhound.core.tasks import list_program_targets
    try:
        return list_program_targets(program_name)
    except Exception:
        return []


@app.get("/api/programs")
def get_programs():
    """Every non-private program and its member targets — the same
    program.json records /program already maintains — so the sidebar can
    group targets under the engagement they belong to instead of a flat
    list."""
    from hellhound.core.tasks import list_programs, load_program
    out = []
    for name in list_programs():
        record = load_program(name) or {}
        if record.get("private"):
            continue
        out.append({
            "name": name,
            "display_name": record.get("display_name") or name,
            "targets": record.get("targets") or [],
        })
    return {"programs": out}


@app.get("/api/findings")
def get_findings(target: str = "", program: str = ""):
    if program:
        merged = []
        for t in _program_target_names(program):
            for f in _findings_for(t):
                merged.append({**f, "target": t})
        return {"program": program, "findings": merged}
    return {"target": target, "findings": _findings_for(target)}


def _reports_dir(target_name: str) -> Path:
    from hellhound.core.tasks import get_target_path, sanitize_target_name
    base = Path(get_target_path(sanitize_target_name(target_name))).parent
    return base / "reports"


@app.get("/api/report")
def get_report(target: str, file: str):
    """Serve a Beast-generated finding report so the GUI can render it inline.
    Reports are Markdown now (the GUI renders them with its own markdown
    engine); a few legacy .html artifacts (e.g. CORS PoCs) are still served as
    HTML for the iframe fallback. Path-traversal-guarded: only a basename
    inside the target's own reports dir."""
    safe = os.path.basename(file)
    rpt = _reports_dir(target) / safe
    try:
        rpt = rpt.resolve()
        if rpt.parent != _reports_dir(target).resolve() or not rpt.is_file():
            return JSONResponse({"error": "not_found"}, status_code=404)
        text = rpt.read_text(encoding="utf-8", errors="ignore")
        if rpt.suffix.lower() == ".md":
            return Response(text, media_type="text/markdown; charset=utf-8")
        return HTMLResponse(text)
    except Exception:
        return JSONResponse({"error": "not_found"}, status_code=404)


_IMG_TYPES = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
              ".gif": "image/gif", ".svg": "image/svg+xml", ".webp": "image/webp"}


@app.get("/api/report-asset")
def get_report_asset(target: str, file: str):
    """Serve an image referenced by a Markdown report (e.g. a screenshot), so
    `![](shot.png)` renders inside the GUI. Contained to the target's own
    reports/ and screenshots/ dirs — a report can never pull a file from
    outside the engagement's own storage."""
    from hellhound.core.tasks import get_target_path, sanitize_target_name
    rel = os.path.normpath(file).lstrip("/")
    if rel.startswith(".."):
        return JSONResponse({"error": "bad_path"}, status_code=400)
    ext = os.path.splitext(rel)[1].lower()
    if ext not in _IMG_TYPES:
        return JSONResponse({"error": "unsupported"}, status_code=400)
    base = Path(get_target_path(sanitize_target_name(target))).parent.resolve()
    for sub in ("reports", "screenshots", ""):
        cand = (base / sub / rel).resolve() if sub else (base / rel).resolve()
        try:
            if str(cand).startswith(str(base)) and cand.is_file():
                return Response(cand.read_bytes(), media_type=_IMG_TYPES[ext])
        except Exception:
            continue
    return JSONResponse({"error": "not_found"}, status_code=404)


_KIND_ACRONYMS = {"idor", "xss", "ssrf", "sqli", "sql", "xxe", "csrf", "jwt", "api", "rce", "ssti", "lfi", "rfi"}


def _kind_label(kind: str) -> str:
    """'exposed_debug_endpoint' -> 'Exposed Debug Endpoint' — findings don't
    carry a separate human-readable vulnerability-class name, only this
    snake_case `kind`, so derive one instead of showing raw dots."""
    kind = (kind or "").strip()
    if not kind:
        return "Uncategorized"
    return " ".join(w.upper() if w in _KIND_ACRONYMS else w.capitalize() for w in kind.split("_"))


def _graph_for_targets(center_label: str, target_names: list) -> dict:
    """The knowledge-graph data for one or several targets: a hub per
    finding `kind` (the ring), every finding a dot under its hub, and the
    hosts/artifacts/targets it actually touches as satellites — all real
    cross-references pulled straight from recorded data, nothing invented.
    Geometry (angles, radii, bezier curvature) is entirely a frontend
    concern; this just ships the graph itself."""
    from hellhound.core.tasks import create_or_load_target

    targets, hubs, findings, hosts, artifacts = [], {}, [], {}, []
    for tname in target_names:
        try:
            tgt = create_or_load_target(tname)
        except Exception:
            continue
        tid = f"target:{tname}"
        targets.append({"id": tid, "label": tname})
        for i, f in enumerate(getattr(tgt, "findings", []) or []):
            if not isinstance(f, dict):
                continue
            kind = str(f.get("kind") or "uncategorized")
            hub_id = f"kind:{kind}"
            hub = hubs.setdefault(hub_id, {"id": hub_id, "label": _kind_label(kind), "count": 0})
            hub["count"] += 1
            host_ids = []
            for h in (f.get("affected_hosts") or []):
                hid = f"host:{h}"
                hosts.setdefault(hid, {"id": hid, "label": h})
                host_ids.append(hid)
            findings.append({
                "id": f"finding:{tname}:{i}",
                "hub": hub_id,
                "target": tid,
                "severity": str(f.get("severity", "medium")),
                "label": str(f.get("type", ""))[:80],
                "endpoint": str(f.get("target", "")),
                "note": str(f.get("note", ""))[:400],
                "hosts": host_ids,
                "report": os.path.basename(f["report_path"]) if f.get("report_path") else None,
                "report_target": tname,
            })
        # A long recon pass can harvest hundreds of artifacts (tokens, URLs,
        # parameters) per target — real data, but drawing each one as its own
        # node would bury the one or two actual findings under a sunflower
        # of noise. So past a point, show the count, not every dot (see
        # ARTIFACT_CAP).
        ARTIFACT_CAP = 20
        arts = (getattr(tgt, "state", {}) or {}).get("artifacts") or []
        arts = [a for a in arts if isinstance(a, dict)]
        for j, a in enumerate(arts[:ARTIFACT_CAP]):
            artifacts.append({
                "id": f"artifact:{tname}:{j}",
                "target": tid,
                "label": (a.get("kind") or a.get("type") or "artifact")[:32],
            })
        if len(arts) > ARTIFACT_CAP:
            artifacts.append({
                "id": f"artifact:{tname}:more",
                "target": tid,
                "label": f"+{len(arts) - ARTIFACT_CAP} more",
            })

    return {
        "center": center_label,
        "targets": targets,
        "hubs": sorted(hubs.values(), key=lambda h: -h["count"]),
        "findings": findings,
        "hosts": list(hosts.values())[:80],
        "artifacts": artifacts,
    }


@app.get("/api/graph")
def get_graph(target: str = "", program: str = ""):
    """With no target/program given, this is the whole-Beast knowledge graph —
    every target it has ever recorded findings for, merged into one ring by
    finding kind. It deliberately does NOT default to whatever target/program
    happens to be selected in the sidebar: the graph is the accumulated
    picture across everything, not a per-engagement view that goes empty the
    moment nothing is active."""
    if program:
        return _graph_for_targets(program, _program_target_names(program))
    if target:
        return _graph_for_targets(target, [target])
    return _graph_for_targets("All Programs", _list_targets())


# ── chat history persistence per target ────────────────────────────────────
def _chat_history_path(target_name: str) -> Path:
    from hellhound.core.tasks import get_target_path, sanitize_target_name
    base = Path(get_target_path(sanitize_target_name(target_name))).parent
    return base / "gui_chat.json"


def _load_chat_history(target_name: str) -> list:
    path = _chat_history_path(target_name)
    if path.is_file():
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
                if isinstance(data, list):
                    return data
        except Exception:
            return []
    return []


def _save_chat_history(target_name: str, entries: list) -> None:
    path = _chat_history_path(target_name)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        # Bounded to last 400 entries per target to keep fast while preserving days of history
        to_save = entries[-400:] if len(entries) > 400 else entries
        with open(path, "w", encoding="utf-8") as f:
            json.dump(to_save, f, ensure_ascii=False, indent=2)
    except Exception as exc:
        print(f"[!] Warning: failed to save chat history for {target_name}: {exc}")


# ── chat sessions (freeform conversations, target optional) ─────────────────
# A session is one conversation: {id, title, target, created, updated, entries}.
# target "" means a scope-free/planning chat (runs on the "default" target until
# one is attached). Stored one file per session so they list/switch like a chat
# app's sidebar, independent of which target is active.
def _sessions_dir() -> Path:
    d = Path(os.path.expanduser("~/.beast")) / "gui_sessions"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _session_path(sid: str) -> Path:
    return _sessions_dir() / f"{os.path.basename(str(sid))}.json"


def _load_session(sid: str) -> Optional[dict]:
    p = _session_path(sid)
    if p.is_file():
        try:
            s = json.loads(p.read_text(encoding="utf-8"))
            if isinstance(s, dict) and s.get("id"):
                s.setdefault("entries", [])
                s.setdefault("target", "")
                s.setdefault("title", "New chat")
                return s
        except Exception:
            return None
    return None


def _save_session(s: dict) -> None:
    import time as _time
    try:
        s["updated"] = _time.time()
        if len(s.get("entries", [])) > 400:
            s["entries"] = s["entries"][-400:]
        _session_path(s["id"]).write_text(json.dumps(s, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception as exc:
        print(f"[!] Warning: failed to save session {s.get('id')}: {exc}")


def _list_sessions() -> list:
    out = []
    for p in _sessions_dir().glob("*.json"):
        try:
            s = json.loads(p.read_text(encoding="utf-8"))
            out.append({
                "id": s["id"],
                "title": s.get("title") or "New chat",
                "target": s.get("target") or "",
                "updated": s.get("updated", 0),
            })
        except Exception:
            continue
    out.sort(key=lambda x: x.get("updated", 0), reverse=True)
    return out


def _new_session(target: str = "") -> dict:
    import time as _time, uuid as _uuid
    sid = _uuid.uuid4().hex[:12]
    now = _time.time()
    s = {"id": sid, "title": "New chat", "target": target or "", "created": now, "updated": now, "entries": []}
    _save_session(s)
    return s


def _session_title_from(text: str) -> str:
    t = " ".join((text or "").strip().split())
    return (t[:40] + "…") if len(t) > 40 else (t or "New chat")


def _is_empty_session(s: dict) -> bool:
    """A fresh, untouched chat — no messages, no target, default title. These
    are disposable so blank 'New chat' entries don't pile up."""
    return (not s.get("entries")
            and not (s.get("target") or "").strip()
            and (s.get("title") or "New chat") == "New chat")


def _prune_empty_sessions(keep_id: str = "") -> None:
    """Delete abandoned empty 'New chat' sessions (except keep_id)."""
    for meta in _list_sessions():
        if meta["id"] == keep_id:
            continue
        s = _load_session(meta["id"])
        if s and _is_empty_session(s):
            _session_path(meta["id"]).unlink(missing_ok=True)


@app.get("/api/sessions")
def get_sessions():
    return {"sessions": _list_sessions()}


@app.post("/api/sessions")
async def post_session(payload: dict = None):
    target = str((payload or {}).get("target", "")).strip()
    return _new_session(target)


@app.post("/api/sessions/delete")
async def delete_session(payload: dict):
    sid = str(payload.get("id", "")).strip()
    if sid:
        _session_path(sid).unlink(missing_ok=True)
    return {"sessions": _list_sessions()}


@app.post("/api/sessions/rename")
async def rename_session(payload: dict):
    sid = str(payload.get("id", "")).strip()
    s = _load_session(sid)
    if s:
        # Explicit rename keeps the user's exact text (capped), unlike the
        # auto-title derivation used for a fresh chat's first message.
        raw = " ".join(str(payload.get("title", "")).strip().split())
        if raw:
            s["title"] = raw[:60]
            _save_session(s)
    return {"sessions": _list_sessions()}


def _entry_plain_text(e: dict) -> str:
    """Human-readable text of a transcript entry, for search + export."""
    if not isinstance(e, dict):
        return str(e)
    if e.get("kind") == "tool":
        return f"[tool] {e.get('tool','')} {e.get('args','')}"
    return str(e.get("text", ""))


@app.get("/api/sessions/search")
def search_sessions(q: str = ""):
    """Full-text search across every conversation (titles + message bodies).
    Returns matching sessions with a short snippet around the first hit."""
    needle = (q or "").strip().lower()
    if not needle:
        return {"results": []}
    results = []
    for p in _sessions_dir().glob("*.json"):
        try:
            s = json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            continue
        title = s.get("title") or "New chat"
        hay_title = title.lower()
        snippet = ""
        hit = needle in hay_title
        for e in (s.get("entries") or []):
            txt = _entry_plain_text(e)
            low = txt.lower()
            if needle in low:
                hit = True
                i = low.find(needle)
                start = max(0, i - 40)
                snippet = ("…" if start else "") + txt[start:i + len(needle) + 40].strip() + "…"
                break
        if hit:
            results.append({
                "id": s["id"], "title": title, "target": s.get("target") or "",
                "updated": s.get("updated", 0), "snippet": snippet,
            })
    results.sort(key=lambda x: x.get("updated", 0), reverse=True)
    return {"results": results[:50]}


@app.get("/api/sessions/export")
def export_session(id: str = ""):
    """Download one conversation as Markdown (prompts + replies)."""
    from fastapi.responses import PlainTextResponse
    s = _load_session(str(id).strip())
    if not s:
        return PlainTextResponse("Session not found.", status_code=404)
    title = s.get("title") or "Chat"
    lines = [f"# {title}", ""]
    if s.get("target"):
        lines.append(f"**Target:** {s['target']}  ")
    lines.append("")
    for e in (s.get("entries") or []):
        if not isinstance(e, dict):
            continue
        kind, lk = e.get("kind"), e.get("logKind")
        txt = str(e.get("text", "")).strip()
        if kind == "user" or lk == "user_echo":
            lines.append(f"### 🧑 You\n\n{txt}\n")
        elif kind == "assistant" or lk == "success":
            lines.append(f"### 🐺 BEAST\n\n{txt}\n")
        elif kind == "tool":
            lines.append(f"> 🔧 `{e.get('tool','')}` — {_entry_plain_text(e)[:200]}\n")
        # plain status/log lines are skipped to keep the export clean
    md = "\n".join(lines)
    fname = "".join(c if c.isalnum() or c in "-_" else "-" for c in title)[:40] or "chat"
    return PlainTextResponse(md, media_type="text/markdown", headers={
        "Content-Disposition": f'attachment; filename="{fname}.md"',
    })


# ── event pump + websocket ────────────────────────────────────────────────
async def _pump_events(ws: WebSocket, gui_emit: GuiEmit, stop: asyncio.Event, current_entries: list, target_getter: callable):
    """Drains gui_emit's thread-safe queue and forwards each event to the client,
    concurrently with handle_message running on a worker thread — so tool_start/
    tool_result land live, not all at once after the turn. Also keeps track of
    the live entries for history persistence."""
    loop = asyncio.get_running_loop()
    while not stop.is_set():
        event = await loop.run_in_executor(None, gui_emit.events.get)
        if event.get("type") == "_stop":
            break
        # Track tool events in current entries
        etype = event.get("type")
        if etype == "tool_start":
            current_entries.append({
                "kind": "tool",
                "cardId": event.get("card_id"),
                "tool": event.get("tool", ""),
                "args": event.get("args") or {},
                "done": False,
            })
        elif etype == "tool_result":
            cid = event.get("card_id")
            for item in reversed(current_entries):
                if item.get("kind") == "tool" and not item.get("done") and item.get("cardId") == cid:
                    item["result"] = event.get("result")
                    item["done"] = True
                    break
        elif etype == "log":
            lkind = event.get("kind")
            # findings/errors always persist; a slash command's own output
            # (banner/info/success/warn/section — there's no separate
            # "result" object, the log lines ARE the answer) persists only
            # when GuiEmit stamped it "persist" at push-time (set while
            # persist_all_logs was True for that turn) — NOT by re-checking
            # gui_emit.persist_all_logs here, since that flag is long since
            # reset by the time this queue-draining loop catches up to an
            # event a burst of dispatch() output pushed moments earlier.
            if lkind in ("finding", "error") or (event.get("persist") and lkind in
                    ("info", "success", "warn", "banner", "section")):
                current_entries.append({
                    "kind": "log",
                    "logKind": lkind,
                    "text": event.get("text", ""),
                })

        try:
            await ws.send_json(event)
        except Exception:
            break


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    from hellhound.core.agent import get_agent

    # Resume the most-recent chat session, or start a fresh blank one. A session
    # carries its own entries + an optional target; blank target = scope-free
    # planning on the "default" target until one is attached.
    _recent = _list_sessions()
    active_session = (_load_session(_recent[0]["id"]) if _recent else None) or _new_session()
    _prune_empty_sessions(active_session["id"])  # clear abandoned blank "New chat"s
    active_entries = active_session["entries"]
    active_target_name = (active_session.get("target") or "").strip() or "default"
    agent = get_agent(active_target_name)
    if agent.target.name != active_target_name:  # force even a switch back to "default"
        agent.set_target(active_target_name)
    gui_emit = GuiEmit()
    stop = asyncio.Event()
    cancel_turn = threading.Event()  # set by "stop_turn"; polled via cancel_check

    def get_active_target():
        return active_target_name

    def _truncate_to_user_turn(k: int) -> Optional[str]:
        """Rewind the chat to just BEFORE the k-th user message (0-based):
        drop that user_echo and everything after it from the visible transcript,
        rewind the agent's model memory to the snapshot taken when that turn began,
        and return the original text of that user turn (or None if not found).
        Used by regenerate (k = last) and edit-&-resend."""
        marks = [i for i, e in enumerate(active_entries)
                 if isinstance(e, dict) and e.get("logKind") == "user_echo"]
        if not marks or k < 0 or k >= len(marks):
            return None
        idx = marks[k]
        orig = active_entries[idx].get("text")
        hist_mark = active_entries[idx].get("hist")
        del active_entries[idx:]
        if isinstance(hist_mark, int):
            try:
                hist = getattr(agent, "history", None)
                if isinstance(hist, list) and 0 <= hist_mark <= len(hist):
                    del hist[hist_mark:]
                    from hellhound.core.tasks import save_target
                    save_target(agent.target)
            except Exception as _e:
                print(f"[!] history rewind failed: {_e}")
        return orig

    def _sync_agent_target(tgt: str):
        # get_agent() deliberately refuses to switch *to* "default", so a chat
        # going scope-free would otherwise stay stuck on the previous target.
        # Force the move so the active agent always matches the chat.
        nonlocal agent, active_target_name
        active_target_name = tgt
        agent = get_agent(tgt)
        if agent.target.name != tgt:
            agent.set_target(tgt)

    def _activate_session(s: dict):
        # Keep the SAME entries list object the pump already holds, so streaming
        # events keep landing in the right place after a switch.
        nonlocal active_session
        active_entries.clear()
        active_entries.extend(s.get("entries", []))
        s["entries"] = active_entries
        active_session = s
        _sync_agent_target((s.get("target") or "").strip() or "default")

    pump_task = asyncio.create_task(_pump_events(ws, gui_emit, stop, active_entries, get_active_target))

    await ws.send_json({"type": "targets", "list": _list_targets()})
    await ws.send_json({"type": "sessions", "list": _list_sessions(), "active": active_session["id"]})
    await ws.send_json({"type": "findings", "target": active_target_name, "list": _findings_for(active_target_name)})
    await ws.send_json({"type": "chat_history", "target": active_session.get("target") or "", "entries": active_entries, "session": active_session["id"]})

    loop = asyncio.get_running_loop()

    async def _send_findings():
        # Report the CHAT's target (blank "" for a scope-free chat), not the
        # agent's fallback "default" — so the UI reads as having no target.
        tgt = (active_session.get("target") or "").strip()
        await ws.send_json({"type": "findings", "target": tgt, "list": _findings_for(tgt) if tgt else []})

    async def _resync_target_if_changed(new_target):
        """A slash command (/target, /recon <other-site>, /program) can repoint
        session_context['target']. Attach that target to the CURRENT chat (the
        conversation continues; only its scope changes) rather than swapping to a
        different per-target history."""
        if not new_target or new_target == active_target_name:
            return
        _sync_agent_target(new_target)
        active_session["target"] = new_target
        _save_session(active_session)
        await ws.send_json({"type": "targets", "list": _list_targets()})
        await ws.send_json({"type": "sessions", "list": _list_sessions(), "active": active_session["id"]})

    async def _run_slash(text: str, session_context: dict):
        """Routes a "/"-prefixed message through the exact same central
        dispatcher (hellhound.core.commands.dispatch) the TUI and classic
        REPL use, instead of free-texting it at the agent — so /scope,
        /recon, /program, /loot, /mcp etc. actually work from the GUI."""
        from hellhound.core.commands import dispatch as commands_dispatch
        gui_emit.persist_all_logs = True
        try:
            result = await loop.run_in_executor(
                None, lambda: commands_dispatch(text, session_context, emit=gui_emit)
            )
        finally:
            gui_emit.persist_all_logs = False
        await _resync_target_if_changed(session_context.get("target"))
        if isinstance(result, dict):
            return result.get("advice") or result.get("response")
        return result if isinstance(result, str) else None

    async def run_turn(text: str):
        nonlocal active_entries
        cancel_turn.clear()  # fresh turn — clear any prior Stop request
        # Record user turn into persistent history, tagging the agent-memory
        # position so regenerate / edit-&-resend can rewind precisely here.
        try:
            _hist_mark = len(getattr(agent, "history", []) or [])
        except Exception:
            _hist_mark = 0
        active_entries.append({"kind": "log", "logKind": "user_echo", "text": text, "hist": _hist_mark})
        # Title a fresh chat from its first real message (like a chat app does).
        _titled_now = False
        if active_session.get("title") in (None, "", "New chat") and not text.strip().startswith("/"):
            active_session["title"] = _session_title_from(text)
            _titled_now = True
        _save_session(active_session)
        if _titled_now:  # refresh the sidebar so the chat shows its new title live
            await ws.send_json({"type": "sessions", "list": _list_sessions(), "active": active_session["id"]})

        session_context = {"target": agent.target.name,
                           "scope_rules": getattr(agent.target, "scope_rules", None)}
        is_slash = text.strip().startswith("/")
        # Stream the final answer token-by-token (runs on the worker thread;
        # _push is queue-backed so it's safe from there). The frontend grows a
        # live assistant bubble, then turn_end finalizes it.
        _on_token = lambda t: gui_emit._push({"type": "token", "text": t})
        try:
            if is_slash:
                final_response = await _run_slash(text, session_context)
            else:
                final_response = await loop.run_in_executor(
                    None, lambda: agent.handle_message(text, session_context=session_context, emit=gui_emit, on_token=_on_token, cancel_check=cancel_turn.is_set)
                )
        except Exception as exc:
            err_msg = f"{type(exc).__name__}: {exc}"
            active_entries.append({"kind": "log", "logKind": "error", "text": err_msg})
            _save_session(active_session)
            await ws.send_json({"type": "error", "text": err_msg})
            return

        if final_response:
            active_entries.append({"kind": "log", "logKind": "success", "text": final_response})
        _save_session(active_session)

        _stopped = cancel_turn.is_set()
        await ws.send_json({"type": "turn_end", "text": final_response, "stopped": _stopped,
                            "auto_continue": bool(getattr(agent, "_last_turn_auto_continue", False)) and not _stopped})
        await _send_findings()

        # Same auto-continue loop as tui.py / chat_ui.py — only for free-text
        # hunting turns; a slash command's own handler already ran any
        # continuation it needed to completion before dispatch() returned.
        while (not is_slash) and (not cancel_turn.is_set()) and getattr(agent, "_last_turn_auto_continue", False):
            await ws.send_json({"type": "turn_status", "text": "Still mid-investigation — continuing on its own…"})
            try:
                final_response = await loop.run_in_executor(
                    None, lambda: agent.handle_message("continue", session_context=session_context, emit=gui_emit, on_token=_on_token, cancel_check=cancel_turn.is_set)
                )
            except Exception as exc:
                err_msg = f"{type(exc).__name__}: {exc}"
                active_entries.append({"kind": "log", "logKind": "error", "text": err_msg})
                _save_session(active_session)
                await ws.send_json({"type": "error", "text": err_msg})
                return

            if final_response:
                active_entries.append({"kind": "log", "logKind": "success", "text": final_response})
            _save_session(active_session)

            _stopped = cancel_turn.is_set()
            await ws.send_json({"type": "turn_end", "text": final_response, "stopped": _stopped,
                                "auto_continue": bool(getattr(agent, "_last_turn_auto_continue", False)) and not _stopped})
            await _send_findings()

    try:
        while True:
            msg = await ws.receive_json()
            mtype = msg.get("type")
            if mtype == "message":
                await run_turn(str(msg.get("text", "")))
            elif mtype == "switch_target":
                # Attach (or detach, name="") a target to the CURRENT chat — the
                # conversation stays; only its scope changes.
                name = str(msg.get("target", "")).strip()
                active_session["target"] = name
                _sync_agent_target(name or "default")
                _save_session(active_session)
                await ws.send_json({"type": "targets", "list": _list_targets()})
                await ws.send_json({"type": "sessions", "list": _list_sessions(), "active": active_session["id"]})
                await _send_findings()
            elif mtype == "new_session":
                if _is_empty_session(active_session):
                    # Already on a fresh blank chat — don't spawn a duplicate.
                    await ws.send_json({"type": "sessions", "list": _list_sessions(), "active": active_session["id"]})
                else:
                    _save_session(active_session)
                    _prune_empty_sessions(active_session["id"])
                    _activate_session(_new_session(str(msg.get("target", "")).strip()))
                    await ws.send_json({"type": "sessions", "list": _list_sessions(), "active": active_session["id"]})
                    await ws.send_json({"type": "chat_history", "target": active_session.get("target") or "", "entries": active_entries, "session": active_session["id"]})
                    await _send_findings()
            elif mtype == "new_session_for_program":
                # New chat on a fresh asset, auto-attached to a program so it
                # inherits that engagement's scope and shows under it.
                tgt = str(msg.get("target", "")).strip()
                prog = str(msg.get("program", "")).strip()
                if tgt:
                    _save_session(active_session)
                    _activate_session(_new_session(tgt))  # creates/loads the target
                    if prog:
                        try:
                            from hellhound.core.tasks import attach_target_to_program
                            attach_target_to_program(agent.target, prog)
                        except Exception as _e:
                            print(f"[!] attach_target_to_program failed: {_e}")
                    _save_session(active_session)
                    await ws.send_json({"type": "targets", "list": _list_targets()})
                    await ws.send_json({"type": "sessions", "list": _list_sessions(), "active": active_session["id"]})
                    await ws.send_json({"type": "chat_history", "target": active_session.get("target") or "", "entries": active_entries, "session": active_session["id"]})
                    await _send_findings()
            elif mtype == "attach_current_to_program":
                # Attach the CURRENT (e.g. fresh) chat to a program + asset — the
                # conversation stays; it just gains that engagement's scope.
                tgt = str(msg.get("target", "")).strip()
                prog = str(msg.get("program", "")).strip()
                if tgt:
                    active_session["target"] = tgt
                    _sync_agent_target(tgt)
                    if prog:
                        try:
                            from hellhound.core.tasks import attach_target_to_program
                            attach_target_to_program(agent.target, prog)
                        except Exception as _e:
                            print(f"[!] attach_target_to_program failed: {_e}")
                    _save_session(active_session)
                    await ws.send_json({"type": "targets", "list": _list_targets()})
                    await ws.send_json({"type": "sessions", "list": _list_sessions(), "active": active_session["id"]})
                    await _send_findings()
            elif mtype == "attach_session_to_program":
                # Drag-to-attach: attach ANY chat (by id) to a program. If that
                # chat already has a target, its target joins the program; an
                # optional asset overrides/sets the target for a scope-free chat.
                sid = str(msg.get("id", "")).strip()
                prog = str(msg.get("program", "")).strip()
                asset = str(msg.get("target", "")).strip()
                s = active_session if sid == active_session.get("id") else _load_session(sid)
                if s and prog:
                    tgt = asset or (s.get("target") or "").strip()
                    if tgt:
                        s["target"] = tgt
                        try:
                            from hellhound.core.tasks import create_or_load_target, attach_target_to_program
                            attach_target_to_program(create_or_load_target(tgt), prog)
                        except Exception as _e:
                            print(f"[!] attach_session_to_program failed: {_e}")
                        if s is active_session:
                            _sync_agent_target(tgt)
                        _save_session(s)
                        await ws.send_json({"type": "targets", "list": _list_targets()})
                        await ws.send_json({"type": "sessions", "list": _list_sessions(), "active": active_session["id"]})
                        await _send_findings()
            elif mtype == "switch_session":
                s = _load_session(str(msg.get("id", "")).strip())
                if s:
                    _save_session(active_session)
                    _activate_session(s)
                    _prune_empty_sessions(active_session["id"])  # drop the blank we just left
                    await ws.send_json({"type": "sessions", "list": _list_sessions(), "active": active_session["id"]})
                    await ws.send_json({"type": "chat_history", "target": active_session.get("target") or "", "entries": active_entries, "session": active_session["id"]})
                    await _send_findings()
            elif mtype == "list_sessions":
                await ws.send_json({"type": "sessions", "list": _list_sessions(), "active": active_session["id"]})
            elif mtype == "list_targets":
                await ws.send_json({"type": "targets", "list": _list_targets()})
            elif mtype == "clear_history":
                active_entries.clear()
                _save_session(active_session)
                await ws.send_json({"type": "chat_history", "target": active_session.get("target") or "", "entries": [], "session": active_session["id"]})
            elif mtype == "stop_turn":
                # Cooperative cancel — the agent polls cancel_check at every tool
                # boundary and bails out cleanly at the next one.
                cancel_turn.set()
            elif mtype == "regenerate":
                # Re-run the LAST user turn: rewind transcript + model memory to
                # just before it, then run it again for a fresh answer. The client
                # updates its own view optimistically, so no chat_history repaint.
                n_users = len([1 for e in active_entries if isinstance(e, dict) and e.get("logKind") == "user_echo"])
                if n_users:
                    orig = _truncate_to_user_turn(n_users - 1)
                    if orig:
                        await run_turn(orig)
            elif mtype == "edit_resend":
                # Edit the k-th user message and resend — forks the chat from there:
                # everything after that message is discarded, then the edited text runs.
                try:
                    k = int(msg.get("user_index"))
                except Exception:
                    k = -1
                new_text = str(msg.get("text", "")).strip()
                if k >= 0 and new_text and _truncate_to_user_turn(k) is not None:
                    await run_turn(new_text)
    except WebSocketDisconnect:
        pass
    finally:
        _save_session(active_session)
        stop.set()
        gui_emit.events.put({"type": "_stop"})
        pump_task.cancel()


_brain_proc: Optional[subprocess.Popen] = None


def _is_brain_listening(port: int = 3220) -> bool:
    import socket
    try:
        with socket.socket() as s:
            s.settimeout(0.3)
            return s.connect_ex(("127.0.0.1", port)) == 0
    except Exception:
        return False


def _ensure_brain_running() -> bool:
    """Ensure the Brain visualization service is running on port 3220."""
    global _brain_proc
    if _is_brain_listening(3220):
        return True

    # The brain visualization lives inside this repo (one project, one clone).
    brain_dir = _REPO_ROOT / "beast_gui" / "brain"
    if not brain_dir.is_dir():
        return False

    next_shim = brain_dir / "node_modules" / ".bin" / "next"
    if not next_shim.exists():
        return False

    # Prefer the production server (`next start`) — it binds in ~1s and is
    # stable, where `next dev` cold-compiles on first open (20-40s, and the
    # frontend panics before it finishes). Fall back to `next dev` only when
    # no build exists (e.g. a dev editing the brain without building first).
    built = (brain_dir / ".next" / "BUILD_ID").exists()
    mode = "start" if built else "dev"
    try:
        log_file = open("/tmp/beast-brain.log", "a")
        _brain_proc = subprocess.Popen(
            ["/bin/sh", str(next_shim), mode, "--port", "3220"],
            cwd=str(brain_dir),
            stdout=log_file,
            stderr=subprocess.STDOUT,
            preexec_fn=os.setsid if hasattr(os, "setsid") else None,
        )
        return True
    except Exception as exc:
        print(f"[!] Failed to start the Brain ({mode}) on :3220 — {type(exc).__name__}: {exc}")
        return False


def _dump_tools_feed() -> None:
    """Snapshot the real agent tool registry to ~/.beast/tools.json so the
    Brain visualization (a separate Next app that reads from the
    filesystem, like it reads skills and lessons) can render the actual tools
    the beast can call — not a hand-maintained list. Written on GUI launch,
    right before the brain is (auto-)started."""
    try:
        from hellhound.core.agent import TOOL_REGISTRY
    except Exception:
        return
    try:
        tools = [
            {"name": name, "description": str(getattr(spec, "description", "") or "")[:400]}
            for name, spec in sorted(TOOL_REGISTRY.items())
        ]
        out = Path(os.path.expanduser("~/.beast")) / "tools.json"
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(tools, indent=1), encoding="utf-8")
    except Exception:
        pass


def _stop_brain():
    global _brain_proc
    if _brain_proc and _brain_proc.poll() is None:
        try:
            import signal
            if hasattr(os, "killpg") and hasattr(os, "getpgid"):
                os.killpg(os.getpgid(_brain_proc.pid), signal.SIGTERM)
            else:
                _brain_proc.terminate()
        except Exception:
            pass
        _brain_proc = None


import atexit
atexit.register(_stop_brain)


@app.get("/api/brain/url")
def get_brain_url():
    _ensure_brain_running()
    return {"url": "http://localhost:3220"}


@app.get("/api/brain/status")
def get_brain_status():
    started = _ensure_brain_running()
    is_up = _is_brain_listening(3220)
    return {
        "online": is_up,
        "started": started,
        "url": "http://localhost:3220"
    }


@app.post("/api/brain/start")
def start_brain_endpoint():
    _ensure_brain_running()
    return {"status": "starting", "url": "http://localhost:3220"}


# ── serve the built frontend from this same process ───────────────────────
_FRONTEND_DIST = _REPO_ROOT / "beast_gui" / "frontend" / "dist"
if _FRONTEND_DIST.is_dir():
    app.mount("/", StaticFiles(directory=str(_FRONTEND_DIST), html=True), name="frontend")


def _resolve_port() -> int:
    return int(os.environ.get("BEAST_GUI_PORT", "8787"))


def _resolve_host() -> str:
    # Localhost by default (desktop app / single-user). Containers set
    # BEAST_GUI_HOST=0.0.0.0 so the browser UI is reachable from the host.
    return os.environ.get("BEAST_GUI_HOST", "127.0.0.1")


def _build_server(port: int):
    """A uvicorn Server we can drive ourselves (so the desktop-app window can run
    it on a background thread and shut it down when the window closes)."""
    import uvicorn
    config = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning")
    return uvicorn.Server(config)


def _wait_until_up(port: int, timeout: float = 15.0) -> bool:
    import socket
    import time
    deadline = time.time() + timeout
    while time.time() < deadline:
        with socket.socket() as s:
            s.settimeout(0.25)
            if s.connect_ex(("127.0.0.1", port)) == 0:
                return True
        time.sleep(0.1)
    return False


def main():
    """Headless/web mode: just serve. A browser (or the --web CLI path) points at it."""
    import uvicorn
    _dump_tools_feed()
    _ensure_brain_running()
    uvicorn.run(app, host=_resolve_host(), port=_resolve_port(), log_level="warning")


def run_desktop(title: str = "BEAST") -> bool:
    """Native desktop application window over the local server — the same FastAPI+React
    app, running in an OS window (WebKit2GTK via pywebview) instead of a browser tab.

    uvicorn runs on a daemon thread; pywebview owns the main thread (the GTK
    backend requires it). Returns False if no native webview backend is
    available, so the caller can fall back to opening a browser.
    """
    _dump_tools_feed()
    _ensure_brain_running()
    try:
        import webview
        from webview.guilib import initialize
        initialize()  # raises if no GTK/Qt/… backend is usable (e.g. headless)
    except Exception:
        return False

    import threading

    port = _resolve_port()
    server = _build_server(port)
    t = threading.Thread(target=server.run, daemon=True)
    t.start()

    if not _wait_until_up(port):
        server.should_exit = True
        return False

    webview.create_window(
        title,
        f"http://127.0.0.1:{port}",
        width=1280,
        height=820,
        min_size=(900, 600),
    )
    webview.start()  # blocks until the window is closed
    server.should_exit = True
    return True


if __name__ == "__main__":
    main()
