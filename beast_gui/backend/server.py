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
import sys
from pathlib import Path

# Make the existing `hellhound` package importable regardless of cwd —
# this file lives at <repo>/beast_gui/backend/server.py.
_REPO_ROOT = Path(__file__).resolve().parents[2]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse
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


@app.get("/api/models")
def get_models():
    from hellhound.core.ai_utils import list_available_models
    try:
        return {"models": list_available_models()}
    except Exception as exc:
        return {"models": [], "error": str(exc)}


# ── targets / findings / reports ──────────────────────────────────────────
def _list_targets():
    from hellhound.core.tasks import list_targets, is_target_private
    try:
        return [t for t in list_targets(exclude_default=False) if not is_target_private(t)]
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


@app.get("/api/findings")
def get_findings(target: str):
    return {"target": target, "findings": _findings_for(target)}


def _reports_dir(target_name: str) -> Path:
    from hellhound.core.tasks import get_target_path, sanitize_target_name
    base = Path(get_target_path(sanitize_target_name(target_name))).parent
    return base / "reports"


@app.get("/api/report")
def get_report(target: str, file: str):
    """Serve a Beast-generated HTML finding report so the GUI can render it inline.
    Path-traversal-guarded: only a basename inside the target's own reports dir."""
    safe = os.path.basename(file)
    rpt = _reports_dir(target) / safe
    try:
        rpt = rpt.resolve()
        if rpt.parent != _reports_dir(target).resolve() or not rpt.is_file():
            return JSONResponse({"error": "not_found"}, status_code=404)
        return HTMLResponse(rpt.read_text(encoding="utf-8", errors="ignore"))
    except Exception:
        return JSONResponse({"error": "not_found"}, status_code=404)


@app.get("/api/graph")
def get_graph(target: str):
    """Nodes/links for the findings graph: the target at the center, each finding a
    node, affected hosts their own nodes, and harvested artifacts (tokens/creds from
    target.state['artifacts']) linking findings that share a source — the real
    cross-reference data, not invented."""
    from hellhound.core.tasks import create_or_load_target
    try:
        tgt = create_or_load_target(target)
    except Exception:
        return {"nodes": [], "links": []}
    nodes = [{"id": target, "type": "target", "label": target}]
    links = []
    seen = {target}
    for i, f in enumerate(getattr(tgt, "findings", []) or []):
        if not isinstance(f, dict):
            continue
        fid = f"finding:{i}"
        nodes.append({"id": fid, "type": "finding", "label": f.get("type", "")[:48],
                      "severity": f.get("severity", "medium")})
        links.append({"source": target, "target": fid})
        for h in (f.get("affected_hosts") or []):
            hid = f"host:{h}"
            if hid not in seen:
                seen.add(hid)
                nodes.append({"id": hid, "type": "host", "label": h})
            links.append({"source": fid, "target": hid})
    # Harvested artifacts (tokens/creds) that bind findings to a source.
    arts = (getattr(tgt, "state", {}) or {}).get("artifacts") or []
    for j, a in enumerate(arts if isinstance(arts, list) else []):
        if not isinstance(a, dict):
            continue
        aid = f"artifact:{j}"
        nodes.append({"id": aid, "type": "artifact",
                      "label": (a.get("kind") or a.get("type") or "artifact")[:32]})
        src = a.get("source") or a.get("source_url")
        if src:
            links.append({"source": aid, "target": target})
    return {"nodes": nodes, "links": links}


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
            if lkind in ("finding", "error"):
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

    current_target = "default"
    agent = get_agent(current_target)
    gui_emit = GuiEmit()
    stop = asyncio.Event()

    active_target_name = agent.target.name
    active_entries = _load_chat_history(active_target_name)

    def get_active_target():
        return active_target_name

    pump_task = asyncio.create_task(_pump_events(ws, gui_emit, stop, active_entries, get_active_target))

    await ws.send_json({"type": "targets", "list": _list_targets()})
    await ws.send_json({"type": "findings", "target": agent.target.name, "list": _findings_for(agent.target.name)})
    # Send preserved conversation history across past sessions
    await ws.send_json({"type": "chat_history", "target": agent.target.name, "entries": active_entries})

    loop = asyncio.get_running_loop()

    async def _send_findings():
        await ws.send_json({"type": "findings", "target": agent.target.name, "list": _findings_for(agent.target.name)})

    async def run_turn(text: str):
        nonlocal active_entries
        # Record user turn into persistent history
        active_entries.append({"kind": "log", "logKind": "banner", "text": f"❯ {text}"})
        _save_chat_history(active_target_name, active_entries)

        session_context = {"target": agent.target.name,
                           "scope_rules": getattr(agent.target, "scope_rules", None)}
        try:
            final_response = await loop.run_in_executor(
                None, lambda: agent.handle_message(text, session_context=session_context, emit=gui_emit)
            )
        except Exception as exc:
            err_msg = f"{type(exc).__name__}: {exc}"
            active_entries.append({"kind": "log", "logKind": "error", "text": err_msg})
            _save_chat_history(active_target_name, active_entries)
            await ws.send_json({"type": "error", "text": err_msg})
            return

        if final_response:
            active_entries.append({"kind": "log", "logKind": "success", "text": final_response})
        _save_chat_history(active_target_name, active_entries)

        await ws.send_json({"type": "turn_end", "text": final_response,
                            "auto_continue": bool(getattr(agent, "_last_turn_auto_continue", False))})
        await _send_findings()

        # Same auto-continue loop as tui.py / chat_ui.py.
        while getattr(agent, "_last_turn_auto_continue", False):
            await ws.send_json({"type": "turn_status", "text": "Still mid-investigation — continuing on its own…"})
            try:
                final_response = await loop.run_in_executor(
                    None, lambda: agent.handle_message("continue", session_context=session_context, emit=gui_emit)
                )
            except Exception as exc:
                err_msg = f"{type(exc).__name__}: {exc}"
                active_entries.append({"kind": "log", "logKind": "error", "text": err_msg})
                _save_chat_history(active_target_name, active_entries)
                await ws.send_json({"type": "error", "text": err_msg})
                return

            if final_response:
                active_entries.append({"kind": "log", "logKind": "success", "text": final_response})
            _save_chat_history(active_target_name, active_entries)

            await ws.send_json({"type": "turn_end", "text": final_response,
                                "auto_continue": bool(getattr(agent, "_last_turn_auto_continue", False))})
            await _send_findings()

    try:
        while True:
            msg = await ws.receive_json()
            mtype = msg.get("type")
            if mtype == "message":
                await run_turn(str(msg.get("text", "")))
            elif mtype == "switch_target":
                name = str(msg.get("target", "")).strip()
                if name:
                    # Save current target before switching
                    _save_chat_history(active_target_name, active_entries)
                    agent = get_agent(name)
                    active_target_name = name
                    # Load chat history for newly active target
                    active_entries.clear()
                    active_entries.extend(_load_chat_history(name))
                    await ws.send_json({"type": "targets", "list": _list_targets()})
                    await _send_findings()
                    await ws.send_json({"type": "chat_history", "target": name, "entries": active_entries})
            elif mtype == "list_targets":
                await ws.send_json({"type": "targets", "list": _list_targets()})
            elif mtype == "clear_history":
                target_to_clear = str(msg.get("target", active_target_name)).strip()
                p = _chat_history_path(target_to_clear)
                if p.is_file():
                    p.unlink(missing_ok=True)
                active_entries.clear()
                await ws.send_json({"type": "chat_history", "target": target_to_clear, "entries": []})
    except WebSocketDisconnect:
        pass
    finally:
        _save_chat_history(active_target_name, active_entries)
        stop.set()
        gui_emit.events.put({"type": "_stop"})
        pump_task.cancel()


# ── serve the built frontend from this same process ───────────────────────
_FRONTEND_DIST = _REPO_ROOT / "beast_gui" / "frontend" / "dist"
if _FRONTEND_DIST.is_dir():
    app.mount("/", StaticFiles(directory=str(_FRONTEND_DIST), html=True), name="frontend")


def _resolve_port() -> int:
    return int(os.environ.get("BEAST_GUI_PORT", "8787"))


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
    uvicorn.run(app, host="127.0.0.1", port=_resolve_port(), log_level="warning")


def run_desktop(title: str = "BEAST") -> bool:
    """Native desktop application window over the local server — the same FastAPI+React
    app, running in an OS window (WebKit2GTK via pywebview) instead of a browser tab.

    uvicorn runs on a daemon thread; pywebview owns the main thread (the GTK
    backend requires it). Returns False if no native webview backend is
    available, so the caller can fall back to opening a browser.
    """
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
