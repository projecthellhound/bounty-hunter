#!/usr/bin/env python3
"""
preview_brain/server.py
Standalone interactive prototype for:
1. "The Beast Brain" — Visualization of Beast's 30 offensive skills, methodologies & attack chains.
2. "Target Findings & Attack Surface" — Target-centric visualization of saved engagement data.
"""

from __future__ import annotations

import os
import re
import sys
from pathlib import Path
from typing import Dict, List, Any

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

app = FastAPI(title="Beast Brain Knowledge Graph Preview")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

SKILLS_DIR = REPO_ROOT / "hellhound" / "skills"

CATEGORIES = [
    {
        "id": "recon",
        "name": "Recon & Surface Mapping",
        "skills": ["web2-recon", "exposed-source-recon", "bb-methodology", "argus", "triage-validation"],
    },
    {
        "id": "auth",
        "name": "Authentication & Credentials",
        "skills": ["authentication", "auth-bypass", "403-bypass", "credential-attack"],
    },
    {
        "id": "access_control",
        "name": "Access Control & IDOR",
        "skills": ["access-control", "idor", "cors-misconfig", "prototype-pollution-mass-assignment"],
    },
    {
        "id": "injection",
        "name": "Injection & Exploitation",
        "skills": ["xss", "ssti", "ssrf", "insecure-deserialization", "server-side-parameter-pollution"],
    },
    {
        "id": "api_app",
        "name": "API & Logic Attacks",
        "skills": ["graphql-audit", "race-condition", "client-reverse", "cicd-security"],
    },
    {
        "id": "emerging",
        "name": "Web3, Mobile & AI Security",
        "skills": ["web3-audit", "meme-coin-audit", "mobile-pentest", "llm-prompt-injection"],
    },
    {
        "id": "playbooks",
        "name": "Arsenal & Methodology",
        "skills": ["security-arsenal", "bug-bounty", "report-writing", "web2-vuln-classes"],
    },
]

CHAIN_LINKS = [
    ("web2-recon", "graphql-audit"),
    ("graphql-audit", "auth-bypass"),
    ("auth-bypass", "idor"),
    ("access-control", "idor"),
    ("auth-bypass", "403-bypass"),
    ("exposed-source-recon", "credential-attack"),
    ("credential-attack", "auth-bypass"),
    ("web2-recon", "cors-misconfig"),
    ("cors-misconfig", "auth-bypass"),
    ("xss", "auth-bypass"),
    ("ssrf", "access-control"),
    ("prototype-pollution-mass-assignment", "auth-bypass"),
    ("race-condition", "access-control"),
    ("web3-audit", "meme-coin-audit"),
    ("cicd-security", "credential-attack"),
    ("ssti", "ssrf"),
    ("triage-validation", "report-writing"),
    ("client-reverse", "auth-bypass"),
]

def _parse_skill(skill_id: str) -> Dict[str, Any]:
    skill_path = SKILLS_DIR / skill_id / "SKILL.md"
    if not skill_path.exists():
        return {"id": skill_id, "name": skill_id, "description": "", "techniques": [], "markdown": ""}
    
    content = skill_path.read_text(encoding="utf-8", errors="ignore")
    name_m = re.search(r"^name:\s*(.+)$", content, re.M)
    desc_m = re.search(r"^description:\s*(.+)$", content, re.M)
    
    name = name_m.group(1).strip() if name_m else skill_id
    desc = desc_m.group(1).strip() if desc_m else ""
    
    headings = re.findall(r"^##\s+(?:[\d.]+\s+)?(.+)$", content, re.M)
    techniques = [h.strip() for h in headings if h.strip() and not h.startswith("Tools")]
    if not techniques:
        subheadings = re.findall(r"^###\s+(?:[\d.]+\s+)?(.+)$", content, re.M)
        techniques = [s.strip() for s in subheadings[:6]]

    return {
        "id": skill_id,
        "name": name,
        "description": desc,
        "techniques": techniques[:8],
        "markdown": content,
    }

@app.get("/api/brain")
def get_brain():
    """Returns Beast's knowledge graph of offensive skills and methodology."""
    categories_out = []
    total_techniques = 0
    all_skills_map = {}

    for cat in CATEGORIES:
        skills_in_cat = []
        for sid in cat["skills"]:
            s_data = _parse_skill(sid)
            all_skills_map[sid] = s_data
            total_techniques += max(1, len(s_data["techniques"]))
            skills_in_cat.append({
                "id": sid,
                "name": s_data["name"],
                "desc": s_data["description"],
                "techniques": s_data["techniques"],
                "count": max(1, len(s_data["techniques"])),
            })
        
        categories_out.append({
            "id": cat["id"],
            "name": cat["name"],
            "skills": skills_in_cat,
            "totalTechniques": sum(s["count"] for s in skills_in_cat),
        })

    links = []
    for a, b in CHAIN_LINKS:
        if a in all_skills_map and b in all_skills_map:
            links.append({"a": a, "b": b, "label": "Attack Chain"})

    return {
        "title": "BEAST Knowledge Engine",
        "stats": {
            "categories": len(categories_out),
            "skills": len(all_skills_map),
            "techniques": total_techniques,
        },
        "categories": categories_out,
        "links": links,
    }

@app.get("/api/skill/{skill_id}")
def get_skill_detail(skill_id: str):
    """Returns markdown and details of an individual skill."""
    data = _parse_skill(skill_id)
    if not data.get("markdown"):
        raise HTTPException(status_code=404, detail="Skill not found")
    return data

@app.get("/api/targets")
def get_targets():
    """Lists saved targets with finding and asset counts."""
    from hellhound.core.tasks import list_targets, create_or_load_target
    targets_list = []
    try:
        raw = list_targets(exclude_default=False)
    except Exception:
        raw = []

    for tname in raw:
        if tname == "default":
            continue
        try:
            tgt = create_or_load_target(tname)
            findings_count = len(getattr(tgt, "findings", []) or [])
            state = getattr(tgt, "state", {}) or {}
            hosts_count = len(state.get("live_hosts", []) or [])
            subs_count = len(state.get("subdomains", []) or [])
            targets_list.append({
                "id": tname,
                "name": tname,
                "findings": findings_count,
                "liveHosts": hosts_count,
                "subdomains": subs_count,
            })
        except Exception:
            continue
    
    targets_list.sort(key=lambda t: (-t["findings"], t["name"]))
    return {"targets": targets_list}

@app.get("/api/target/{target_name}")
def get_target_graph(target_name: str):
    """Returns finding nodes, attack surface, and correlations for an individual target."""
    from hellhound.core.tasks import create_or_load_target
    try:
        tgt = create_or_load_target(target_name)
    except Exception as exc:
        raise HTTPException(status_code=404, detail=f"Target not found: {exc}")

    findings_raw = getattr(tgt, "findings", []) or []
    state = getattr(tgt, "state", {}) or {}

    hubs: Dict[str, Dict[str, Any]] = {}
    finding_nodes = []
    host_to_findings: Dict[str, List[str]] = {}

    for i, f in enumerate(findings_raw):
        if not isinstance(f, dict):
            continue
        fid = f"finding:{i}"
        kind = str(f.get("kind") or "uncategorized")
        sev = str(f.get("severity") or "medium").lower()
        title = str(f.get("type") or "Finding")
        endpoint = str(f.get("target") or "")
        note = str(f.get("note") or "")
        affected_hosts = f.get("affected_hosts") or []
        report_path = f.get("report_path")

        if kind not in hubs:
            hubs[kind] = {
                "id": kind,
                "name": kind.replace("_", " ").title(),
                "count": 0,
                "severities": {"critical": 0, "high": 0, "medium": 0, "low": 0, "info": 0},
            }
        
        hubs[kind]["count"] += 1
        if sev in hubs[kind]["severities"]:
            hubs[kind]["severities"][sev] += 1

        finding_nodes.append({
            "id": fid,
            "hub": kind,
            "title": title,
            "severity": sev,
            "endpoint": endpoint,
            "note": note,
            "hosts": affected_hosts,
            "report": os.path.basename(report_path) if report_path else None,
        })

        for h in affected_hosts:
            host_to_findings.setdefault(h, []).append(fid)

    links = []
    seen = set()
    for h, fids in host_to_findings.items():
        if len(fids) > 1:
            for j in range(len(fids)):
                for k in range(j + 1, len(fids)):
                    pair = tuple(sorted([fids[j], fids[k]]))
                    if pair not in seen:
                        seen.add(pair)
                        links.append({"a": pair[0], "b": pair[1], "reason": f"Shared host: {h}"})

    return {
        "target": target_name,
        "stats": {
            "totalFindings": len(finding_nodes),
            "hubsCount": len(hubs),
            "criticalCount": sum(1 for f in finding_nodes if f["severity"] == "critical"),
            "highCount": sum(1 for f in finding_nodes if f["severity"] == "high"),
            "liveHosts": len(state.get("live_hosts", []) or []),
            "subdomains": len(state.get("subdomains", []) or []),
            "endpoints": len(state.get("endpoints", []) or []),
            "openPorts": len(state.get("open_ports", []) or []),
        },
        "hubs": sorted(hubs.values(), key=lambda h: -h["count"]),
        "findings": finding_nodes,
        "links": links,
        "attackSurface": {
            "liveHosts": (state.get("live_hosts", []) or [])[:30],
            "technologies": (state.get("technologies", []) or [])[:20],
        }
    }

STATIC_DIR = Path(__file__).parent / "static"
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

@app.get("/")
def index():
    index_file = STATIC_DIR / "index.html"
    return HTMLResponse(content=index_file.read_text(encoding="utf-8"))

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=3456, log_level="info")
