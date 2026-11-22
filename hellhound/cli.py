import sys
import warnings

# Suppress annoying requests/urllib3 dependency warnings before they trigger
warnings.filterwarnings("ignore", message=".*urllib3.*match a supported version.*")
warnings.filterwarnings("ignore", message=".*RequestsDependencyWarning.*")

import click


def _configure_logging():
    """
    Routes Python's `logging` module to a file instead of the terminal.

    Nothing in this codebase ever called logging.basicConfig()/addHandler(),
    so every logger.warning()/logger.error() call (e.g. agent.py's
    "Synthesizer failed after tool execution..." diagnostic, which can
    include the full raw orchestrator response) fell through to Python's
    default "handler of last resort" — a bare StreamHandler on sys.stderr,
    printed with zero coordination with the interactive console's Rich
    Live/spinner rendering on stdout. The result: a raw, unformatted log
    line could land mid-character inside an actively-redrawing spinner
    line, producing exactly the garbled, half-rendered output interleaved
    with tool output that the console is supposed to never show. Giving the
    root logger a real FileHandler (and nothing else) means that text now
    always goes to a log file for later debugging, and NEVER touches the
    terminal the researcher is actually watching.
    """
    import logging
    from pathlib import Path

    log_dir = Path.home() / ".beast" / "logs"
    try:
        log_dir.mkdir(parents=True, exist_ok=True)
        handler = logging.FileHandler(log_dir / "hellhound.log", encoding="utf-8")
        handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
        root = logging.getLogger()
        root.setLevel(logging.INFO)
        root.addHandler(handler)
        # Belt-and-suspenders: explicitly disable the stderr "last resort"
        # fallback so a logger call before this point (or from a module
        # that grabs its own logger before configure runs) still can't
        # reach the terminal even without this handler.
        logging.lastResort = None
    except Exception:
        # Logging to a file failing (e.g. unwritable home dir) must never
        # block the console from starting — worst case, falls back to
        # Python's default behavior for that run.
        pass


# -------------------------------------------------
# Root CLI Group
# invoke_without_command=True means bare `hellhound`
# launches the console instead of printing help.
# -------------------------------------------------
@click.group(
    invoke_without_command=True,
    context_settings=dict(help_option_names=["-h", "--help"])
)
@click.option("--print", "-p", "print_cmd", default=None, help="Execute a slash command in headless mode and print output")
@click.option("--json", "-j", "json_output", is_flag=True, default=False, help="Force structured JSON output for automation")
@click.option("--classic", is_flag=True, default=False, help="Launch the classic prompt_toolkit console instead of the Textual TUI")
@click.option("--gui", is_flag=True, default=False, help="Launch the GUI as a native desktop application window")
@click.option("--web", is_flag=True, default=False, help="With --gui, open in a browser tab instead of a native window (for headless/SSH)")
@click.option("--no-browser", is_flag=True, default=False, help="With --gui --web, start the backend but don't auto-open a browser tab")
@click.version_option("12.7.0", prog_name="HELLHOUND")
@click.pass_context
def cli(ctx, print_cmd, json_output, classic, gui, web, no_browser):
    """
    BEAST (Bounty Hunter) — Project Hellhound's autonomous bug bounty recon & triage AI

    Run without arguments to launch the interactive chat console.

      beast                     → interactive Textual TUI
      beast --gui               → native desktop application window
      beast --gui --web         → same GUI in a browser tab (headless/SSH)
      beast --classic           → classic prompt_toolkit console
      beast --print "/scope show --json"
      beast -p "/recon example.com"
    """
    if print_cmd:
        _execute_headless(print_cmd, json_output)
        return

    if ctx.invoked_subcommand is None:
        if gui:
            _launch_gui(web=web, open_browser=not no_browser)
        else:
            _launch_console(classic=classic)


def _execute_headless(command_str: str, force_json: bool = False):
    """Executes a command via central dispatcher in headless mode."""
    _configure_logging()
    from hellhound.core.commands import dispatch
    from hellhound.core.emit import PlainEmit
    from hellhound.core.ai_utils import load_config
    from hellhound.core.scope import ScopeRules

    cfg = load_config()
    session_context = {
        "options": {
            "ai_model": cfg.get("ai_model", ""),
            "ai_provider": cfg.get("ai_provider", "ollama"),
            "global_headers": cfg.get("global_headers", {})
        },
        "scope_rules": ScopeRules.from_dict(cfg.get("scope", {})),
        "results": {}
    }
    # Resume the active program's target (set by `/program select`) so a headless
    # hunt/command runs against the right host WITH its scope gate — a fresh
    # `beast -p` process is otherwise cold and would start at "default" with no
    # scope. The target's saved scope (inherited from the program) wins over the
    # bare global scope above.
    _active_target = cfg.get("active_target")
    if _active_target:
        session_context["target"] = _active_target
        try:
            from hellhound.core.tasks import create_or_load_target
            _t = create_or_load_target(_active_target)
            _sr = getattr(_t, "scope_rules", None)
            if _sr and (_sr.in_scope or _sr.out_scope or _sr.disallowed):
                session_context["scope_rules"] = _sr
        except Exception:
            pass

    emit = PlainEmit()
    if force_json or "--json" in command_str:
        setattr(emit, "json_mode", True)

    try:
        dispatch(command_str, session_context, emit)
    except Exception as e:
        if force_json:
            import json
            print(json.dumps({"status": "error", "error": "execution_failed", "message": str(e)}))
        else:
            emit.error(f"Execution failed: {e}")
        sys.exit(1)



# -------------------------------------------------
# Console subcommand (explicit, for compatibility)
# -------------------------------------------------
@cli.command()
def console():
    """Launch interactive console mode"""
    _launch_console()


# -------------------------------------------------
# Upgrade subcommand
# -------------------------------------------------
@cli.command()
def upgrade():
    """Pull latest updates and sync dependencies"""
    import os
    import subprocess
    from pathlib import Path

    # Find the project root (where update.sh lives)
    project_root = Path(__file__).resolve().parent.parent
    update_script = project_root / "update.sh"

    if not update_script.exists():
        click.echo(click.style(f"[x] Error: Update script not found at {update_script}", fg="red"))
        return

    # Ensure it's executable
    os.chmod(update_script, 0o755)

    try:
        subprocess.run(["bash", str(update_script)], check=True)
    except subprocess.CalledProcessError:
        click.echo(click.style("[!] Upgrade process encountered an error.", fg="yellow"))
    except Exception as e:
        click.echo(click.style(f"[x] Critical error during upgrade: {e}", fg="red"))


# -------------------------------------------------
# Terminal preference (used by packaging/beast-launch.sh, the desktop
# launcher's entry point) — NOT read by the console itself. Stored as a
# plain one-line file, not config.json, so the bash wrapper can read it
# with `cat` before Python (and the venv) is even on the critical path.
# -------------------------------------------------
@cli.group()
def terminal():
    """Configure which terminal emulator the desktop launcher opens."""
    pass


@terminal.command("set")
@click.argument("name")
def terminal_set(name):
    """Pin the desktop launcher to a specific terminal (e.g. ghostty, kitty, alacritty)."""
    import os as _os
    import shutil as _shutil
    from pathlib import Path

    if _shutil.which(name) is None:
        click.echo(click.style(
            f"[!] Warning: '{name}' was not found on PATH right now — saving the "
            f"preference anyway in case it's installed later.", fg="yellow"
        ))

    pref_dir = Path.home() / ".beast"
    pref_dir.mkdir(parents=True, exist_ok=True)
    (pref_dir / "terminal_preference").write_text(name.strip() + "\n")
    click.echo(f"[+] Desktop launcher will now open HELLHOUND in: {name}")


@terminal.command("show")
def terminal_show():
    """Show the currently configured terminal preference."""
    from pathlib import Path
    pref_file = Path.home() / ".beast" / "terminal_preference"
    if pref_file.exists() and pref_file.read_text().strip():
        click.echo(pref_file.read_text().strip())
    else:
        click.echo("(none set — desktop launcher auto-detects an installed terminal)")


@terminal.command("clear")
def terminal_clear():
    """Clear the saved terminal preference and go back to auto-detect."""
    from pathlib import Path
    pref_file = Path.home() / ".beast" / "terminal_preference"
    if pref_file.exists():
        pref_file.unlink()
    click.echo("[+] Cleared — desktop launcher will auto-detect a terminal.")


# -------------------------------------------------
# Shared launcher
# -------------------------------------------------
def _launch_console(classic: bool = False):
    _configure_logging()

    # Default to the Claude Code-style Textual TUI (scrollable transcript,
    # pinned input, clickable/collapsible tool cards showing the real
    # request/response). Force the classic prompt_toolkit REPL with either
    # `hellhound --classic` or HELLHOUND_CLASSIC_UI=1. If the TUI can't start
    # for any reason, fall back to classic automatically rather than leaving
    # the user with no console.
    import os
    _classic = os.environ.get("HELLHOUND_CLASSIC_UI", "").strip().lower()
    use_classic = classic or (_classic not in ("", "0", "false", "no"))

    if not use_classic:
        try:
            from hellhound.core.tui import start_tui_session
            start_tui_session()
            return
        except KeyboardInterrupt:
            click.echo("\n[+] Exiting HELLHOUND.")
            sys.exit(0)
        except Exception as e:
            click.echo(f"[!] TUI unavailable ({e}); falling back to the classic console. "
                       f"Force classic anytime with HELLHOUND_CLASSIC_UI=1.")

    try:
        from hellhound.core.chat_ui import start_chat_session
        start_chat_session()
    except KeyboardInterrupt:
        click.echo("\n[+] Exiting HELLHOUND.")
        sys.exit(0)
    except Exception as e:
        click.echo(f"[!] Failed to start console: {e}")
        sys.exit(1)


def _launch_gui(web: bool = False, open_browser: bool = True):
    """Launch the GUI over the FastAPI backend (beast_gui/backend/server.py),
    which serves the built React frontend. By default this opens a NATIVE
    desktop-app window (WebKit2GTK via pywebview) so it feels like an app, not a
    website; `--web` opens it in a browser tab instead (headless/SSH).

    The backend is the SAME process that drives real hunts — it wraps
    hellhound.core.agent.get_agent / handle_message exactly like the TUI, so
    nothing about the agent is duplicated or mocked. `beast` (no flag) is still
    the terminal TUI; this is purely an alternate front-end."""
    _configure_logging()

    import os
    from pathlib import Path

    # beast_gui lives at the repo root, a sibling of the `hellhound` package.
    repo_root = Path(__file__).resolve().parents[1]
    gui_dir = repo_root / "beast_gui"
    dist_dir = gui_dir / "frontend" / "dist"

    if not gui_dir.is_dir():
        click.echo("[!] GUI not found (beast_gui/ missing). Reinstall with the GUI extra: "
                   "pip install 'hellhound[gui]'")
        sys.exit(1)

    try:
        import fastapi  # noqa: F401
        import uvicorn  # noqa: F401
    except Exception:
        click.echo("[!] GUI dependencies missing. Install them with: pip install 'hellhound[gui]'")
        sys.exit(1)

    if not dist_dir.is_dir():
        click.echo("[!] GUI frontend isn't built yet. Build it once with:")
        click.echo("      cd beast_gui/frontend && npm install && npm run build")
        click.echo("    (or run the dev server with `npm run dev`).")
        sys.exit(1)

    # Make `import beast_gui...` resolvable even when `beast` is on PATH from
    # an installed console-script whose cwd is elsewhere.
    if str(repo_root) not in sys.path:
        sys.path.insert(0, str(repo_root))

    port = int(os.environ.get("BEAST_GUI_PORT", "8787"))
    url = f"http://127.0.0.1:{port}"

    # Default: a native desktop-app window. Falls through to web mode if there's
    # no usable webview backend (headless box, no pywebview, SSH without X).
    if not web:
        try:
            from beast_gui.backend.server import run_desktop
            click.echo(f"[+] BEAST GUI — opening a desktop window ({url})")
            if run_desktop(title="BEAST"):
                return
            click.echo("[!] No native webview backend available; falling back to a browser tab.")
            click.echo("    (For a real app window: pip install pywebview + a WebKit2GTK/Qt backend.)")
        except KeyboardInterrupt:
            click.echo("\n[+] GUI stopped.")
            sys.exit(0)
        except Exception as e:
            click.echo(f"[!] Desktop window unavailable ({e}); falling back to a browser tab.")

    # Web mode: serve and (optionally) open the default browser.
    click.echo(f"[+] BEAST GUI → {url}  (Ctrl-C to stop)")
    if open_browser:
        import threading
        import webbrowser

        def _open():
            import time
            time.sleep(1.2)  # give uvicorn a moment to bind
            try:
                webbrowser.open(url)
            except Exception:
                pass

        threading.Thread(target=_open, daemon=True).start()

    try:
        from beast_gui.backend.server import main as serve
        serve()
    except KeyboardInterrupt:
        click.echo("\n[+] GUI stopped.")
        sys.exit(0)
    except Exception as e:
        click.echo(f"[!] Failed to start GUI backend: {e}")
        sys.exit(1)


# -------------------------------------------------
# Entry Point
# -------------------------------------------------
def main():
    cli()


if __name__ == "__main__":
    main()