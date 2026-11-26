"""
hellhound/core/tools/disclosed_intel.py

Direct public-source bug-bounty intel — no third-party API, no key, no per-day
rate limit. Pulls the SAME disclosed-report corpus and payload references that
hosted services aggregate, straight from the open sources:

  * disclosed HackerOne reports  -> reddelexc/hackerone-reports `data.csv`
    (15k+ rows: program, title, link, upvotes, bounty, vuln_type), fetched once
    and cached in memory for a day.
  * payloads / techniques        -> swisskyrepo/PayloadsAllTheThings raw files.

The full write-up of a report is rendered client-side on hackerone.com, so
get_disclosed_report returns the summary + the URL and points the model at
browser_control for the complete page when it actually needs the prose.

This is the unlimited default; the hosted HexBrain MCP remains an optional,
smarter-search fallback when a key is configured.
"""

import csv
import io
import re
import time
from typing import Any, Dict, List, Optional

import requests

_CSV_URL = "https://raw.githubusercontent.com/reddelexc/hackerone-reports/master/data.csv"
_PAYLOADS_BASE = "https://raw.githubusercontent.com/swisskyrepo/PayloadsAllTheThings/master"
_UA = {"User-Agent": "Mozilla/5.0 (compatible; BeastBountyHunter)"}

# Map loose vuln-class words the model uses to the PayloadsAllTheThings folders.
_PAYLOAD_DIRS = {
    "xss": "XSS Injection", "sqli": "SQL Injection", "sql": "SQL Injection",
    "ssrf": "Server Side Request Forgery", "ssti": "Server Side Template Injection",
    "idor": "Insecure Direct Object References", "lfi": "File Inclusion",
    "rfi": "File Inclusion", "xxe": "XXE Injection", "rce": "Command Injection",
    "command injection": "Command Injection", "csv": "CSV Injection",
    "csrf": "CSRF Injection", "cors": "CORS Misconfiguration",
    "open redirect": "Open Redirect", "ldap": "LDAP Injection",
    "nosql": "NoSQL Injection", "upload": "Upload Insecure Files",
    "deserialization": "Insecure Deserialization", "jwt": "JSON Web Token",
    "graphql": "GraphQL Injection", "prototype pollution": "Prototype Pollution",
    "race condition": "Race Condition", "web cache": "Web Cache Deception",
    "oauth": "OAuth Misconfiguration", "saml": "SAML Injection",
}

_index: Optional[List[Dict[str, str]]] = None
_index_ts: float = 0.0


def _load_index(force: bool = False) -> List[Dict[str, str]]:
    """Fetch + cache the disclosed-report index (one day TTL)."""
    global _index, _index_ts
    if _index is not None and not force and (time.time() - _index_ts) < 86400:
        return _index
    try:
        r = requests.get(_CSV_URL, timeout=30, headers=_UA)
        r.raise_for_status()
        rows = [row for row in csv.DictReader(io.StringIO(r.text)) if row.get("title")]
        _index, _index_ts = rows, time.time()
        return rows
    except Exception:
        return _index or []


def _as_float(v: Any) -> float:
    try:
        return float(v)
    except Exception:
        return 0.0


def _execute_search_disclosed(args: Dict[str, Any], target: Any = None, emit: Any = None) -> Dict[str, Any]:
    query = str(args.get("query", "")).strip().lower()
    vuln = str(args.get("vuln_type", "")).strip().lower()
    program = str(args.get("program", "")).strip().lower()
    try:
        limit = max(1, min(int(args.get("limit", 10) or 10), 40))
    except Exception:
        limit = 10

    rows = _load_index()
    if not rows:
        return {"status": "error", "error": "Could not fetch the disclosed-report index (network?). Try again, or use the hexbrain MCP if configured."}

    terms = [t for t in query.split() if t]

    def ok(row: Dict[str, str]) -> bool:
        if program and program not in row.get("program", "").lower():
            return False
        if vuln and vuln not in row.get("vuln_type", "").lower():
            return False
        hay = f"{row.get('title','')} {row.get('program','')} {row.get('vuln_type','')}".lower()
        return all(t in hay for t in terms)

    hits = [r for r in rows if ok(r)]
    hits.sort(key=lambda r: _as_float(r.get("upvotes")), reverse=True)
    top = hits[:limit]
    lines = [
        f"- {r['title']}  [{r.get('vuln_type','?')} · {r.get('program','?')} · {r.get('upvotes','0')}▲"
        + (f" · ${r.get('bounty')}" if _as_float(r.get('bounty')) > 0 else "") + f"]  {r.get('link','')}"
        for r in top
    ]
    return {
        "status": "success",
        "total_matches": len(hits),
        "shown": len(top),
        "reports": [
            {"title": r["title"], "program": r.get("program"), "vuln_type": r.get("vuln_type"),
             "upvotes": r.get("upvotes"), "bounty": r.get("bounty"), "url": r.get("link")}
            for r in top
        ],
        "summary": (f"{len(hits)} disclosed reports match; top {len(top)} by upvotes:\n" + "\n".join(lines)
                    if hits else "No disclosed reports matched. Try broader terms or a different vuln_type."),
        "note": "Public corpus, unlimited. For a report's full write-up, open its url with browser_control.",
    }


def _execute_get_disclosed_report(args: Dict[str, Any], target: Any = None, emit: Any = None) -> Dict[str, Any]:
    ref = str(args.get("id_or_url", "")).strip()
    m = re.search(r"(\d{4,})", ref)
    if not m:
        return {"status": "error", "error": "Give a HackerOne report id or hackerone.com/reports/<id> URL."}
    rid = m.group(1)
    url = f"https://hackerone.com/reports/{rid}"
    summary = ""
    try:
        r = requests.get(url, timeout=20, headers=_UA)
        if r.status_code == 200:
            mo = re.search(r'<meta[^>]+property=["\']og:description["\'][^>]+content=["\']([^"\']+)', r.text, re.I)
            if mo:
                summary = re.sub(r"\s+", " ", mo.group(1)).strip()
    except Exception as e:
        return {"status": "error", "error": f"Could not fetch {url}: {e}", "url": url}
    # Enrich from the index if we have it cached.
    meta = next((row for row in (_index or []) if rid in (row.get("link") or "")), None)
    return {
        "status": "success",
        "url": url,
        "title": (meta or {}).get("title"),
        "program": (meta or {}).get("program"),
        "vuln_type": (meta or {}).get("vuln_type"),
        "summary": summary or "(summary not in the static page)",
        "note": "HackerOne renders the full write-up client-side — call browser_control on this url for the complete report, including the reproduction steps.",
    }


def _execute_find_payloads(args: Dict[str, Any], target: Any = None, emit: Any = None) -> Dict[str, Any]:
    cls = str(args.get("vuln_class", "")).strip().lower()
    folder = _PAYLOAD_DIRS.get(cls)
    if not folder:
        # best-effort keyword match
        for key, val in _PAYLOAD_DIRS.items():
            if key in cls or cls in key:
                folder = val
                break
    if not folder:
        return {"status": "error",
                "error": f"No PayloadsAllTheThings folder known for '{cls}'. Known: {', '.join(sorted(set(_PAYLOAD_DIRS)))}."}
    raw = f"{_PAYLOADS_BASE}/{folder.replace(' ', '%20')}/README.md"
    try:
        r = requests.get(raw, timeout=25, headers=_UA)
        r.raise_for_status()
        text = r.text
    except Exception as e:
        return {"status": "error", "error": f"Could not fetch payloads for {folder}: {e}"}
    # Keep it bounded — the model gets the techniques/payloads, not a megabyte.
    body = text[:20000]
    truncated = len(text) > 20000
    return {
        "status": "success",
        "vuln_class": folder,
        "source": f"https://github.com/swisskyrepo/PayloadsAllTheThings/tree/master/{folder.replace(' ', '%20')}",
        "content": body + ("\n\n[...truncated; see the source link for the rest]" if truncated else ""),
    }
