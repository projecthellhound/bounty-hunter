# BEAST GUI

A desktop-app front-end for BEAST: a native window (not a browser tab) with a
working-log transcript in the middle, collapsible tool cards, a targets rail on the
left, and a findings rail on the right that can render BEAST's own HTML reports inline.

Under the hood it's a local FastAPI + React app rendered inside a native OS
window (WebKit2GTK via **pywebview**). `beast --gui` opens the window;
`beast --gui --web` opens the same app in a browser tab instead (for headless /
SSH boxes, or if no webview backend is installed).

It is **not** a second agent. The backend is a thin WebSocket wrapper around
the exact same `hellhound.core.agent.get_agent` / `Agent.handle_message`
entrypoint the terminal TUI uses, over the same saved targets in `~/.beast`.
A target you hunt in the GUI is the same one you can `beast` into from a shell.

```
beast_gui/
  backend/
    server.py     FastAPI + WebSocket, serves the built frontend, wraps the agent
    gui_emit.py   Emit backend (subclasses hellhound PlainEmit) → WS events
  frontend/       Vite + React + TS (pure renderer; no agent logic)
    src/App.tsx   the whole UI
    dist/         built output the backend serves (created by `npm run build`)
```

## Run it

```bash
# one-time: install the GUI backend deps + build the frontend
pip install -e '.[gui]'
cd beast_gui/frontend && npm install && npm run build && cd -

# launch as a native desktop window
beast --gui
```

On Linux the native window needs a WebKit2GTK backend
(`libwebkit2gtk-4.1-0` + PyGObject, usually already present on a desktop). If
none is available, `beast --gui` automatically falls back to a browser tab.

`beast` with no flag is still the terminal TUI; `beast --classic` is still the
classic console. `beast --gui --web` forces browser-tab mode; add
`--no-browser` to start the backend without opening a tab. Port is overridable
with `BEAST_GUI_PORT`.

The desktop launcher (`packaging/beast.desktop`) opens the GUI window on
double-click; its right-click "Open terminal console (TUI)" action opens the
terminal UI.

## Develop the frontend

Run the backend and the Vite dev server side by side — Vite proxies `/api` and
`/ws` to the backend (see `frontend/vite.config.ts`), so you get hot reload
against the real agent:

```bash
python3 -m beast_gui.backend.server          # terminal 1 — backend on :8787
cd beast_gui/frontend && npm run dev          # terminal 2 — UI on :5173
```

Open http://127.0.0.1:5173. When you're happy, `npm run build` to refresh
`dist/` so `beast --gui` serves the new UI.

## How it's wired

- **Config is single-sourced.** Settings → Models/API Keys/Behavior read and
  write `~/.beast/config.json` through the same `load_config`/`save_config`
  the CLI uses. API keys are never echoed back — `/api/config` only reports
  which providers are *configured*.
- **Live tool cards.** `handle_message` runs on a worker thread; `GuiEmit`
  pushes `tool_start`/`tool_result` onto a queue that the asyncio side drains
  to the socket, so cards stream in live and match by `card_id` (same
  FIFO-per-tool-name scheme as the Textual TUI).
- **Findings + reports** come straight from the saved target
  (`target.findings`); "view report" renders the HTML BEAST already generated
  under the target's `reports/` dir, served path-traversal-guarded.
- **Private targets are filtered** out of the GUI's target list via
  `is_target_private`, same as everywhere else.
