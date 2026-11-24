// Beast Brain & Target Knowledge Graph — Interactive Radial Engine
(function() {
  const canvas = document.getElementById("graph-canvas");
  const ctx = canvas.getContext("2d");
  const svg = document.getElementById("graph-svg");
  const viewport = document.getElementById("viewport");

  const drawer = document.getElementById("drawer");
  const drawerClose = document.getElementById("drawer-close");
  const drawerTitle = document.getElementById("drawer-title");
  const drawerBadge = document.getElementById("drawer-badge");
  const drawerMeta = document.getElementById("drawer-meta");
  const drawerBody = document.getElementById("drawer-body");

  const lensBrain = document.getElementById("lens-brain");
  const lensTarget = document.getElementById("lens-target");
  const targetSelectWrap = document.getElementById("target-select-wrap");
  const targetSelect = document.getElementById("target-select");
  const findBtn = document.getElementById("find-btn");
  const searchModal = document.getElementById("search-modal");
  const searchInput = document.getElementById("search-input");
  const searchClose = document.getElementById("search-close");
  const searchResults = document.getElementById("search-results");

  const footerTitle = document.getElementById("footer-title");
  const footerDesc = document.getElementById("footer-desc");
  const footerStats = document.getElementById("footer-stats");

  // State
  let currentLens = "brain"; // "brain" | "target"
  let brainData = null;
  let targetsList = [];
  let currentTargetData = null;
  let activeTargetName = "";

  // Nodes for interaction
  let nodes = []; // { id, x, y, r, type, data, label }
  let links = []; // { a: nodeA, b: nodeB, label }
  let hoveredNode = null;
  let selectedNode = null;

  // Camera & smooth motion
  const cam = { x: 0, y: 0, s: 1, rot: 0 };
  const targetCam = { x: 0, y: 0, s: 1, rot: 0 };
  let isDragging = false;
  let dragStart = { x: 0, y: 0, camX: 0, camY: 0 };
  let hasDragged = false;
  let pulsePhase = 0;

  const TAU = Math.PI * 2;
  const lerp = (a, b, t) => a + (b - a) * t;

  // ── Resize Canvas ──────────────────────────────────────────────────────────
  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = viewport.clientWidth;
    const h = viewport.clientHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  window.addEventListener("resize", resize);
  resize();

  // ── Data Fetching ──────────────────────────────────────────────────────────
  async function init() {
    try {
      // 1. Fetch Brain Data
      const resB = await fetch("/api/brain");
      brainData = await resB.json();

      // 2. Fetch Targets List
      const resT = await fetch("/api/targets");
      const dataT = await resT.json();
      targetsList = dataT.targets || [];

      // Populate Target Dropdown
      targetSelect.innerHTML = "";
      targetsList.forEach(t => {
        const opt = document.createElement("option");
        opt.value = t.id;
        opt.textContent = `${t.name} (${t.findings} findings)`;
        targetSelect.appendChild(opt);
      });

      // Check URL parameters for lens and target
      const params = new URLSearchParams(window.location.search);
      const urlLens = params.get("lens");
      const urlTarget = params.get("target");

      if (urlTarget && targetsList.some(t => t.id === urlTarget)) {
        activeTargetName = urlTarget;
      } else if (targetsList.length > 0) {
        activeTargetName = targetsList[0].id;
      }

      if (activeTargetName) {
        targetSelect.value = activeTargetName;
        await loadTarget(activeTargetName);
      }

      // Initial layout
      if (urlLens === "target") {
        switchLens("target");
      } else {
        switchLens("brain");
      }
    } catch (err) {
      console.error("Failed to load initial data", err);
    }
  }

  async function loadTarget(targetName) {
    if (!targetName) return;
    try {
      const res = await fetch(`/api/target/${encodeURIComponent(targetName)}`);
      currentTargetData = await res.json();
      if (currentLens === "target") {
        buildTargetLayout();
      }
    } catch (err) {
      console.error("Failed to load target data", err);
    }
  }

  // ── Layout Builders ────────────────────────────────────────────────────────
  function buildBrainLayout() {
    nodes = [];
    links = [];
    if (!brainData) return;

    const categories = brainData.categories;
    const R_SKILL = 230;
    const R_CAT_BEZEL = 350;

    // Distribute skills along the circle
    let totalSkills = 0;
    categories.forEach(c => totalSkills += c.skills.length);

    let angleCounter = -Math.PI / 2;
    const skillNodeMap = new Map();

    categories.forEach((cat) => {
      const catSkillCount = cat.skills.length;
      const catSpan = (catSkillCount / totalSkills) * TAU;
      const catMidAngle = angleCounter + catSpan / 2;

      // Category arc label node
      const [cx, cy] = [Math.cos(catMidAngle) * R_CAT_BEZEL, Math.sin(catMidAngle) * R_CAT_BEZEL];
      nodes.push({
        id: `cat:${cat.id}`,
        type: "category",
        label: cat.name,
        x: cx,
        y: cy,
        r: 18,
        angle: catMidAngle,
        span: catSpan,
        data: cat,
      });

      // Individual Skills within Category
      cat.skills.forEach((skill, idx) => {
        const skillAngle = angleCounter + ((idx + 0.5) / catSkillCount) * catSpan;
        const [sx, sy] = [Math.cos(skillAngle) * R_SKILL, Math.sin(skillAngle) * R_SKILL];

        const sNode = {
          id: skill.id,
          type: "skill",
          label: skill.name,
          desc: skill.desc,
          x: sx,
          y: sy,
          r: 12 + Math.min(8, skill.techniques.length * 1.2),
          angle: skillAngle,
          data: skill,
        };
        nodes.push(sNode);
        skillNodeMap.set(skill.id, sNode);

        // Techniques radiating outward from skill
        const nTech = skill.techniques.length;
        skill.techniques.forEach((tech, tIdx) => {
          const techDist = R_SKILL + 36 + tIdx * 14;
          const techAngle = skillAngle + (tIdx - nTech / 2) * 0.025;
          const [tx, ty] = [Math.cos(techAngle) * techDist, Math.sin(techAngle) * techDist];
          nodes.push({
            id: `${skill.id}:tech:${tIdx}`,
            type: "technique",
            label: tech,
            parentSkill: sNode,
            x: tx,
            y: ty,
            r: 3.5,
            data: { skillId: skill.id, title: tech, index: tIdx },
          });
        });
      });

      angleCounter += catSpan;
    });

    // Center Cross-Skill Attack Chains
    brainData.links.forEach(l => {
      const aNode = skillNodeMap.get(l.a);
      const bNode = skillNodeMap.get(l.b);
      if (aNode && bNode) {
        links.push({ a: aNode, b: bNode, label: l.label });
      }
    });

    // Update Footer
    footerTitle.textContent = "Beast Knowledge Engine: Offensive Skills & Methodology";
    footerDesc.textContent = "Interactive radial map of 30 offensive hunting skills, sub-techniques, and chained attack vectors. Click any skill or pip to inspect methodology and tools.";
    footerStats.innerHTML = `
      <div class="stat-box"><span class="val">${brainData.stats.categories}</span><span class="lbl">Domains</span></div>
      <div class="stat-box"><span class="val">${brainData.stats.skills}</span><span class="lbl">Skills</span></div>
      <div class="stat-box highlight"><span class="val">${brainData.stats.techniques}</span><span class="lbl">Techniques</span></div>
    `;

    refit(380, true);
  }

  function buildTargetLayout() {
    nodes = [];
    links = [];
    if (!currentTargetData) return;

    const t = currentTargetData;
    const R_HUB = 240;

    // Center Node: Target Domain
    const centerNode = {
      id: "target:core",
      type: "target_core",
      label: t.target,
      x: 0,
      y: 0,
      r: 32,
      data: t,
    };
    nodes.push(centerNode);

    // Finding Hubs (Categories on target)
    const hubs = t.hubs;
    const hubCount = Math.max(1, hubs.length);
    const hubNodeMap = new Map();
    const findingNodeMap = new Map();

    hubs.forEach((hub, idx) => {
      const angle = -Math.PI / 2 + (idx / hubCount) * TAU;
      const [hx, hy] = [Math.cos(angle) * R_HUB, Math.sin(angle) * R_HUB];

      const hNode = {
        id: `hub:${hub.id}`,
        type: "target_hub",
        label: hub.name,
        count: hub.count,
        x: hx,
        y: hy,
        r: 16 + Math.min(14, hub.count * 3),
        angle: angle,
        data: hub,
      };
      nodes.push(hNode);
      hubNodeMap.set(hub.id, hNode);

      // Hub links to center
      links.push({ a: centerNode, b: hNode, tone: "hub" });
    });

    // Findings as radial leaves fanning out from each hub
    t.findings.forEach((f, idx) => {
      const hNode = hubNodeMap.get(f.hub);
      if (!hNode) return;

      const fHubFindings = t.findings.filter(item => item.hub === f.hub);
      const fIdxInHub = fHubFindings.indexOf(f);
      const totalInHub = fHubFindings.length;

      const spread = Math.min(0.35, totalInHub * 0.08);
      const fAngle = hNode.angle + (totalInHub > 1 ? (fIdxInHub / (totalInHub - 1) - 0.5) * spread : 0);
      const dist = R_HUB + 45 + (fIdxInHub % 3) * 22;
      const [fx, fy] = [Math.cos(fAngle) * dist, Math.sin(fAngle) * dist];

      const fNode = {
        id: f.id,
        type: "finding",
        label: f.title,
        severity: f.severity,
        hubNode: hNode,
        x: fx,
        y: fy,
        r: f.severity === "critical" ? 7 : f.severity === "high" ? 6 : 5,
        data: f,
      };
      nodes.push(fNode);
      findingNodeMap.set(f.id, fNode);
    });

    // Inter-finding links (shared host or correlation)
    t.links.forEach(l => {
      const aNode = findingNodeMap.get(l.a);
      const bNode = findingNodeMap.get(l.b);
      if (aNode && bNode) {
        links.push({ a: aNode, b: bNode, tone: "correlation", reason: l.reason });
      }
    });

    // Update Footer
    footerTitle.textContent = `Target Engagement: ${t.target}`;
    footerDesc.textContent = `Real finding graph for ${t.target}. Center links connect findings sharing compromised hosts or credentials.`;
    footerStats.innerHTML = `
      <div class="stat-box"><span class="val">${t.stats.liveHosts}</span><span class="lbl">Hosts</span></div>
      <div class="stat-box"><span class="val">${t.stats.endpoints}</span><span class="lbl">Endpoints</span></div>
      <div class="stat-box highlight"><span class="val">${t.stats.totalFindings}</span><span class="lbl">Findings</span></div>
      <div class="stat-box highlight"><span class="val" style="color:#ff453a;">${t.stats.criticalCount}</span><span class="lbl">Critical</span></div>
    `;

    refit(280, true);
  }

  // ── Camera & Coordinate Math ───────────────────────────────────────────────
  function refit(worldRadius = 380, snap = false) {
    const w = viewport.clientWidth;
    const h = viewport.clientHeight;
    const pad = 140;
    const scale = Math.max(0.2, Math.min((w - pad) / (worldRadius * 2), (h - pad) / (worldRadius * 2)));
    targetCam.x = w / 2;
    targetCam.y = h / 2;
    targetCam.s = scale;
    targetCam.rot = 0;
    if (snap || cam.x === 0) {
      cam.x = targetCam.x;
      cam.y = targetCam.y;
      cam.s = targetCam.s;
      cam.rot = targetCam.rot;
    }
  }

  function toScreen(wx, wy) {
    const cos = Math.cos(cam.rot);
    const sin = Math.sin(cam.rot);
    const rx = wx * cos - wy * sin;
    const ry = wx * sin + wy * cos;
    return [rx * cam.s + cam.x, ry * cam.s + cam.y];
  }

  function toWorld(sx, sy) {
    const dx = (sx - cam.x) / cam.s;
    const dy = (sy - cam.y) / cam.s;
    const cos = Math.cos(-cam.rot);
    const sin = Math.sin(-cam.rot);
    return [dx * cos - dy * sin, dx * sin + dy * cos];
  }

  // ── Render Loop (60 FPS) ───────────────────────────────────────────────────
  function tick() {
    pulsePhase += 0.03;

    // Smooth camera lerp
    cam.x = lerp(cam.x, targetCam.x, 0.12);
    cam.y = lerp(cam.y, targetCam.y, 0.12);
    cam.s = lerp(cam.s, targetCam.s, 0.12);
    cam.rot = lerp(cam.rot, targetCam.rot, 0.12);

    draw();
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  function draw() {
    const w = viewport.clientWidth;
    const h = viewport.clientHeight;
    ctx.clearRect(0, 0, w, h);

    // 1. Concentric HUD Radar Rings
    const [cx, cy] = toScreen(0, 0);
    ctx.save();
    ctx.strokeStyle = "rgba(239, 230, 208, 0.05)";
    ctx.lineWidth = 1;
    [100, 200, 280, 380, 480].forEach(r => {
      ctx.beginPath();
      ctx.arc(cx, cy, r * cam.s, 0, TAU);
      ctx.stroke();
    });

    // Center crosshair
    ctx.beginPath();
    ctx.moveTo(cx - 10, cy); ctx.lineTo(cx + 10, cy);
    ctx.moveTo(cx, cy - 10); ctx.lineTo(cx, cy + 10);
    ctx.strokeStyle = "rgba(239, 230, 208, 0.15)";
    ctx.stroke();
    ctx.restore();

    // 2. Draw Links (Bezier cords through center / attack chains)
    links.forEach(l => {
      const [ax, ay] = toScreen(l.a.x, l.a.y);
      const [bx, by] = toScreen(l.b.x, l.b.y);

      const isHovered = hoveredNode && (l.a.id === hoveredNode.id || l.b.id === hoveredNode.id);
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(ax, ay);

      // Bezier curve pulling toward center
      const [midX, midY] = [(ax + bx) / 2, (ay + by) / 2];
      const pull = 0.55;
      const cpx = lerp(midX, cx, pull);
      const cpy = lerp(midY, cy, pull);

      ctx.quadraticCurveTo(cpx, cpy, bx, by);

      if (isHovered) {
        ctx.strokeStyle = "#ff6a3d";
        ctx.lineWidth = 2.2;
        ctx.shadowColor = "#ff6a3d";
        ctx.shadowBlur = 10;
      } else {
        ctx.strokeStyle = l.tone === "correlation" ? "rgba(229, 72, 77, 0.35)" : "rgba(239, 230, 208, 0.12)";
        ctx.lineWidth = 1.2;
      }
      ctx.stroke();
      ctx.restore();
    });

    // 3. Draw Category Arcs & Bezier Branches (Brain mode)
    if (currentLens === "brain") {
      nodes.filter(n => n.type === "category").forEach(cat => {
        const [arcX, arcY] = toScreen(cat.x, cat.y);
        ctx.save();
        ctx.fillStyle = "rgba(239, 230, 208, 0.35)";
        ctx.font = `${Math.max(10, 11 * cam.s)}px var(--font-mono)`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(cat.label.toUpperCase(), arcX, arcY);
        ctx.restore();
      });

      // Branch lines from skill to techniques
      nodes.filter(n => n.type === "technique").forEach(tech => {
        const [tx, ty] = toScreen(tech.x, tech.y);
        const [sx, sy] = toScreen(tech.parentSkill.x, tech.parentSkill.y);
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(tx, ty);
        ctx.strokeStyle = "rgba(239, 230, 208, 0.1)";
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.restore();
      });
    }

    // 4. Draw Nodes
    nodes.forEach(n => {
      const [sx, sy] = toScreen(n.x, n.y);
      const isHover = hoveredNode && hoveredNode.id === n.id;
      const isSel = selectedNode && selectedNode.id === n.id;
      const sr = n.r * cam.s;

      ctx.save();

      if (n.type === "target_core") {
        // Target Central Core
        ctx.shadowColor = "#e5484d";
        ctx.shadowBlur = 16 + Math.sin(pulsePhase) * 6;
        ctx.beginPath();
        ctx.fillStyle = "#181612";
        ctx.strokeStyle = "#e5484d";
        ctx.lineWidth = 2.5;
        ctx.arc(sx, sy, sr, 0, TAU);
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = "#efe6d0";
        ctx.font = `bold ${Math.max(11, 13 * cam.s)}px var(--font-mono)`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(n.label, sx, sy);
      }
      else if (n.type === "skill" || n.type === "target_hub") {
        // Hub / Skill Node
        ctx.shadowColor = isHover || isSel ? "#ff6a3d" : "transparent";
        ctx.shadowBlur = isHover || isSel ? 14 : 0;
        ctx.beginPath();
        ctx.fillStyle = "#1c1a16";
        ctx.strokeStyle = isHover || isSel ? "#ff6a3d" : "#efe6d0";
        ctx.lineWidth = isHover || isSel ? 2 : 1.2;
        ctx.arc(sx, sy, sr, 0, TAU);
        ctx.fill();
        ctx.stroke();

        // Inner glowing pip
        ctx.beginPath();
        ctx.fillStyle = isHover || isSel ? "#ff6a3d" : "rgba(239, 230, 208, 0.4)";
        ctx.arc(sx, sy, Math.max(2, sr * 0.3), 0, TAU);
        ctx.fill();

        // Label beside hub
        ctx.fillStyle = isHover || isSel ? "#ff6a3d" : "#efe6d0";
        ctx.font = `${Math.max(10, 11 * cam.s)}px var(--font-mono)`;
        ctx.textAlign = sx > cx ? "left" : "right";
        ctx.textBaseline = "middle";
        const offset = (sr + 8) * (sx > cx ? 1 : -1);
        ctx.fillText(n.label, sx + offset, sy);
      }
      else if (n.type === "finding") {
        // Finding leaf pip
        const sev = n.severity;
        const color = sev === "critical" ? "#ff453a" : sev === "high" ? "#ff6a3d" : sev === "medium" ? "#d0a060" : "#8a8a8a";

        if (sev === "critical" || sev === "high") {
          ctx.shadowColor = color;
          ctx.shadowBlur = 8 + Math.sin(pulsePhase * 2) * 4;
        }

        ctx.beginPath();
        ctx.fillStyle = color;
        ctx.arc(sx, sy, sr * (isHover || isSel ? 1.4 : 1), 0, TAU);
        ctx.fill();

        if (isHover || isSel) {
          ctx.strokeStyle = "#ffffff";
          ctx.lineWidth = 1.5;
          ctx.stroke();
          // Tooltip title
          ctx.fillStyle = "#ffffff";
          ctx.font = "11px var(--font-mono)";
          ctx.textAlign = "left";
          ctx.fillText(n.label, sx + 10, sy + 3);
        }
      }
      else if (n.type === "technique") {
        // Technique dot
        ctx.beginPath();
        ctx.fillStyle = isHover || isSel ? "#ff6a3d" : "rgba(239, 230, 208, 0.5)";
        ctx.arc(sx, sy, sr * (isHover || isSel ? 1.6 : 1), 0, TAU);
        ctx.fill();

        if (isHover || isSel) {
          ctx.fillStyle = "#ff6a3d";
          ctx.font = "11px var(--font-mono)";
          ctx.textAlign = sx > cx ? "left" : "right";
          const offset = 8 * (sx > cx ? 1 : -1);
          ctx.fillText(n.label, sx + offset, sy);
        }
      }

      ctx.restore();
    });
  }

  // ── Mouse & Pointer Interaction ────────────────────────────────────────────
  function findNodeUnder(clientX, clientY) {
    const rect = viewport.getBoundingClientRect();
    const sx = clientX - rect.left;
    const sy = clientY - rect.top;

    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      if (n.type === "category") continue;
      const [nx, ny] = toScreen(n.x, n.y);
      const hitR = Math.max(8, n.r * cam.s + 4);
      if (Math.hypot(sx - nx, sy - ny) <= hitR) {
        return n;
      }
    }
    return null;
  }

  viewport.addEventListener("mousedown", (e) => {
    isDragging = true;
    hasDragged = false;
    dragStart = { x: e.clientX, y: e.clientY, camX: targetCam.x, camY: targetCam.y };
  });

  window.addEventListener("mousemove", (e) => {
    if (isDragging) {
      const dx = e.clientX - dragStart.x;
      const dy = e.clientY - dragStart.y;
      if (Math.hypot(dx, dy) > 4) hasDragged = true;
      targetCam.x = dragStart.camX + dx;
      targetCam.y = dragStart.camY + dy;
    } else {
      hoveredNode = findNodeUnder(e.clientX, e.clientY);
      viewport.style.cursor = hoveredNode ? "pointer" : "grab";
    }
  });

  window.addEventListener("mouseup", (e) => {
    if (!isDragging) return;
    isDragging = false;
    if (!hasDragged) {
      const clicked = findNodeUnder(e.clientX, e.clientY);
      if (clicked) {
        selectNode(clicked);
      } else {
        closeDrawer();
      }
    }
  });

  viewport.addEventListener("wheel", (e) => {
    e.preventDefault();
    const rect = viewport.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    const zoomFactor = e.deltaY < 0 ? 1.15 : 0.87;
    const newScale = Math.max(0.15, Math.min(6, targetCam.s * zoomFactor));

    targetCam.x = mx - (mx - targetCam.x) * (newScale / targetCam.s);
    targetCam.y = my - (my - targetCam.y) * (newScale / targetCam.s);
    targetCam.s = newScale;
  }, { passive: false });

  // ── Node Selection & Drawer ────────────────────────────────────────────────
  async function selectNode(node) {
    selectedNode = node;

    // Smoothly focus camera on node
    const w = viewport.clientWidth;
    const h = viewport.clientHeight;
    targetCam.x = w / 2 - node.x * targetCam.s;
    targetCam.y = h / 2 - node.y * targetCam.s;

    if (node.type === "skill") {
      drawerBadge.className = "drawer-badge";
      drawerBadge.textContent = "SKILL METHODOLOGY";
      drawerTitle.textContent = node.data.name;
      drawerMeta.innerHTML = `<code>${node.data.id}</code> · <b>${node.data.techniques.length}</b> Techniques / Procedures`;

      drawerBody.innerHTML = "<p>Loading full skill guide...</p>";
      openDrawer();

      try {
        const res = await fetch(`/api/skill/${node.data.id}`);
        const data = await res.json();
        drawerBody.innerHTML = window.marked ? marked.parse(data.markdown) : `<pre>${data.markdown}</pre>`;
      } catch (err) {
        drawerBody.innerHTML = `<p>${node.data.desc}</p><ul>${node.data.techniques.map(t => `<li>${t}</li>`).join("")}</ul>`;
      }
    }
    else if (node.type === "technique") {
      drawerBadge.className = "drawer-badge";
      drawerBadge.textContent = "ATTACK TECHNIQUE";
      drawerTitle.textContent = node.label;
      drawerMeta.innerHTML = `Skill: <code>${node.data.skillId}</code>`;
      drawerBody.innerHTML = `<p>Technique procedure extracted from Beast's <code>${node.data.skillId}</code> methodology.</p>`;
      openDrawer();
    }
    else if (node.type === "finding") {
      const f = node.data;
      drawerBadge.className = `drawer-badge sev-${f.severity}`;
      drawerBadge.textContent = f.severity.toUpperCase();
      drawerTitle.textContent = f.title;
      drawerMeta.innerHTML = `
        <div>Endpoint: <code>${f.endpoint || "N/A"}</code></div>
        ${f.hosts && f.hosts.length ? `<div>Affected Hosts: <code>${f.hosts.join(", ")}</code></div>` : ""}
      `;

      drawerBody.innerHTML = `
        <h2>Finding Notes &amp; Evidence</h2>
        <p>${f.note || "No note recorded."}</p>
        ${f.report ? `<button class="find-btn" style="margin-top:14px; background:rgba(229,72,77,0.2); border-color:#e5484d;">📄 View Full Report (${f.report})</button>` : ""}
      `;
      openDrawer();
    }
    else if (node.type === "target_core") {
      const t = node.data;
      drawerBadge.className = "drawer-badge";
      drawerBadge.textContent = "TARGET PROFILE";
      drawerTitle.textContent = t.target;
      drawerMeta.innerHTML = `Total Findings: <b>${t.stats.totalFindings}</b> (${t.stats.criticalCount} Critical, ${t.stats.highCount} High)`;
      drawerBody.innerHTML = `
        <h2>Attack Surface Overview</h2>
        <p>Live Hosts: <b>${t.stats.liveHosts}</b></p>
        <p>Discovered Subdomains: <b>${t.stats.subdomains}</b></p>
        <p>Discovered Endpoints: <b>${t.stats.endpoints}</b></p>
        <p>Open Ports: <b>${t.stats.openPorts}</b></p>
        <h2>Active Technologies</h2>
        <ul>${t.attackSurface.technologies.map(tech => `<li><code>${tech}</code></li>`).join("")}</ul>
      `;
      openDrawer();
    }
  }

  function openDrawer() {
    drawer.classList.add("open");
    drawer.setAttribute("aria-hidden", "false");
  }

  function closeDrawer() {
    drawer.classList.remove("open");
    drawer.setAttribute("aria-hidden", "true");
    selectedNode = null;
  }

  drawerClose.addEventListener("click", closeDrawer);
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeDrawer();
      searchModal.style.display = "none";
    } else if (e.key === "f" || e.key === "F") {
      if (document.activeElement.tagName !== "INPUT") {
        e.preventDefault();
        openSearch();
      }
    }
  });

  // ── Lens Switching ─────────────────────────────────────────────────────────
  function switchLens(lens) {
    currentLens = lens;
    closeDrawer();
    if (lens === "brain") {
      lensBrain.classList.add("active");
      lensTarget.classList.remove("active");
      targetSelectWrap.style.display = "none";
      buildBrainLayout();
    } else {
      lensBrain.classList.remove("active");
      lensTarget.classList.add("active");
      targetSelectWrap.style.display = "flex";
      buildTargetLayout();
    }
  }

  lensBrain.addEventListener("click", () => switchLens("brain"));
  lensTarget.addEventListener("click", () => switchLens("target"));

  targetSelect.addEventListener("change", (e) => {
    activeTargetName = e.target.value;
    loadTarget(activeTargetName);
  });

  // ── Search Modal ───────────────────────────────────────────────────────────
  function openSearch() {
    searchModal.style.display = "flex";
    searchInput.value = "";
    searchResults.innerHTML = "";
    searchInput.focus();
  }

  findBtn.addEventListener("click", openSearch);
  searchClose.addEventListener("click", () => searchModal.style.display = "none");

  searchInput.addEventListener("input", (e) => {
    const q = e.target.value.toLowerCase().trim();
    if (!q) { searchResults.innerHTML = ""; return; }

    const matches = nodes.filter(n => n.label.toLowerCase().includes(q)).slice(0, 12);
    searchResults.innerHTML = matches.map(m => `
      <div class="search-item" data-id="${m.id}">
        <div class="search-item-title">${m.label}</div>
        <div class="search-item-sub">${m.type.toUpperCase()}</div>
      </div>
    `).join("");

    searchResults.querySelectorAll(".search-item").forEach(el => {
      el.addEventListener("click", () => {
        const id = el.getAttribute("data-id");
        const found = nodes.find(n => n.id === id);
        if (found) {
          searchModal.style.display = "none";
          selectNode(found);
        }
      });
    });
  });

  // Boot
  init();
})();
