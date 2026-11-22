"""
beast_gui/backend/gui_emit.py

The GUI's Emit backend. Mirrors hellhound/core/emit.py's PlainEmit /
ConsoleEmit (never duplicates that interface's logic — just a new renderer
target, same contract every other Emit backend already honors) and
hellhound/core/tui.py's ToolCard pending-stack pattern for matching
tool_start -> tool_result (same FIFO-per-tool_name approach the TUI itself
settled on — see _pending_cards there), so sub-agent cards behave exactly
the same way in the GUI as they already do in the researcher's TUI.

Every event pushed here is a plain dict appended to a thread-safe queue.
handle_message() always runs on a worker thread (see server.py) so this
class's methods are called from THAT thread; the asyncio side drains the
queue and forwards each event over the WebSocket. This mirrors PlainEmit's
own existing hook rather than inventing a parallel transport convention.
"""

from __future__ import annotations

import itertools
import queue
import re
from typing import Any, Dict, List

from hellhound.core.emit import PlainEmit

_TAG_RE = re.compile(r"\[/?[a-zA-Z0-9 _#]+\]")


def _strip_markup(msg: Any) -> str:
    """Rich/bbcode-style tags ([bold red]...[/bold red]) -> plain text."""
    return _TAG_RE.sub("", str(msg))


class GuiEmit(PlainEmit):
    def __init__(self):
        super().__init__(socketio=None)
        self.events: "queue.Queue[Dict[str, Any]]" = queue.Queue()
        self._pending_cards: Dict[str, List[str]] = {}
        self._card_ids = itertools.count(1)

    def _push(self, event: Dict[str, Any]) -> None:
        self.events.put(event)

    # ---- plain text lines -------------------------------------------------
    def _send(self, msg):
        self._push({"type": "log", "kind": "info", "text": _strip_markup(msg)})

    def info(self, msg):
        self._push({"type": "log", "kind": "info", "text": _strip_markup(msg)})

    def warn(self, msg):
        self._push({"type": "log", "kind": "warn", "text": _strip_markup(msg)})

    warning = warn

    def success(self, msg):
        self._push({"type": "log", "kind": "success", "text": _strip_markup(msg)})

    def error(self, msg):
        self._push({"type": "log", "kind": "error", "text": _strip_markup(msg)})

    def finding(self, *args):
        text = " ".join(map(str, args))
        self._push({"type": "log", "kind": "finding", "text": _strip_markup(text)})

    def banner(self, title):
        self._push({"type": "log", "kind": "banner", "text": _strip_markup(title)})

    def section(self, title, orbital: bool = False):
        self._push({"type": "log", "kind": "section", "text": _strip_markup(title)})

    def set_label(self, label):
        # A transient "what the agent is doing right now" label — surfaced as a
        # quiet status line so the GUI can show it the way the TUI's WorkingIndicator does.
        self._push({"type": "status_label", "text": _strip_markup(label)})

    # ---- tool cards (same FIFO-per-name matching as tui.py's _pending_cards)
    def tool_start(self, tool_name: str, args: dict):
        card_id = f"c{next(self._card_ids)}"
        self._pending_cards.setdefault(tool_name, []).append(card_id)
        self._push({
            "type": "tool_start",
            "tool": tool_name,
            "args": args or {},
            "card_id": card_id,
        })

    def tool_result(self, tool_name: str, result: Any):
        stack = self._pending_cards.get(tool_name)
        card_id = stack.pop(0) if stack else None
        self._push({
            "type": "tool_result",
            "tool": tool_name,
            "card_id": card_id,
            "result": result if isinstance(result, (dict, list, str, int, float, bool, type(None))) else str(result),
        })
