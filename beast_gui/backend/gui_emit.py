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
        # Set True around a slash-command dispatch so its banner/info/success
        # lines (its only output — there's no separate return value) survive
        # a reload; left False for free-text agent turns, whose narration is
        # routine chatter not worth persisting.
        self.persist_all_logs = False

    def _push(self, event: Dict[str, Any]) -> None:
        self.events.put(event)

    def _push_log(self, kind: str, text: str) -> None:
        # Stamp persist-worthiness at the moment the event is CREATED (this
        # runs on the worker thread actually executing the command), not
        # when the asyncio pump task later gets around to draining it —
        # persist_all_logs can already have been reset by then, since the
        # dispatch call that set it has long since returned by the time the
        # pump task catches up. A per-event stamp can't go stale like a
        # shared mutable flag read late can.
        self._push({"type": "log", "kind": kind, "text": _strip_markup(text), "persist": self.persist_all_logs})

    # ---- plain text lines -------------------------------------------------
    def _send(self, msg):
        self._push_log("info", msg)

    def info(self, msg):
        self._push_log("info", msg)

    def warn(self, msg):
        self._push_log("warn", msg)

    warning = warn

    def success(self, msg):
        self._push_log("success", msg)

    def error(self, msg):
        self._push_log("error", msg)

    def finding(self, *args):
        self._push_log("finding", " ".join(map(str, args)))

    def banner(self, title):
        self._push_log("banner", title)

    def section(self, title, orbital: bool = False):
        self._push_log("section", title)

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
