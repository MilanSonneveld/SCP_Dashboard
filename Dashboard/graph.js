const svg = d3.select("#graph");
const panel = d3.select("#panel");
const resetBtn = d3.select("#resetBtn");

function setPanel(html) { panel.html(html); }
function escapeHtml(s) {
  return (s ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
function sizeSvgToContainer() {
  const rect = svg.node().getBoundingClientRect();
  svg.attr("viewBox", `0 0 ${rect.width} ${rect.height}`);
  return { width: rect.width, height: rect.height };
}

let simulation;
let nodeSel, linkSel, labelSel, linkLabelSel;
let links = [];

function resetStyles() {
  nodeSel.classed("selected", false).classed("downstream", false).classed("dimmed", false);
  linkSel.classed("selected", false).classed("downstream", false).classed("dimmed", false);

  nodeSel.select("circle").attr("r", d => d.baseR);

  setPanel(`<div class="muted">Nothing selected yet.</div>`);
}

function buildAdjacency(links) {
  const out = new Map();
  const inc = new Map();
  for (const l of links) {
    if (!out.has(l.source.id)) out.set(l.source.id, []);
    if (!inc.has(l.target.id)) inc.set(l.target.id, []);
    out.get(l.source.id).push(l);
    inc.get(l.target.id).push(l);
  }
  return { out, inc };
}

function reachableDownstream(sourceId, outAdj) {
  const visited = new Set([sourceId]);
  const q = [sourceId];
  const downstreamLinks = new Set();
  while (q.length) {
    const cur = q.shift();
    for (const l of (outAdj.get(cur) || [])) {
      downstreamLinks.add(l);
      const tid = l.target.id;
      if (!visited.has(tid)) { visited.add(tid); q.push(tid); }
    }
  }
  return { downstreamNodes: visited, downstreamLinks };
}

function computeInfluenceScores(sourceId, outAdj) {
  const score = new Map();
  score.set(sourceId, 1.0);

  const q = [sourceId];
  const MAX_DEPTH = 8;
  const MIN_FLOW = 0.02;
  const seen = new Set();

  while (q.length) {
    const cur = q.shift();
    for (let depth = 0; depth < MAX_DEPTH; depth++) {
      const key = `${cur}|${depth}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const outgoing = outAdj.get(cur) || [];
      const curScore = score.get(cur) || 0;

      for (const l of outgoing) {
        const w = Math.max(0, Math.min(1, l.weight ?? 0.3));
        const flow = curScore * w;
        if (flow < MIN_FLOW) continue;

        const tid = l.target.id;
        const prev = score.get(tid) || 0;
        const next = prev + flow * 0.6;
        if (next > prev + 1e-6) {
          score.set(tid, next);
          q.push(tid);
        }
      }
    }
  }
  return score;
}

function onNodeClick(event, d, adjacency) {
  const { out, inc } = adjacency;

  const connectedLinks = new Set([...(out.get(d.id) || []), ...(inc.get(d.id) || [])]);
  const connectedNodes = new Set([d.id]);
  connectedLinks.forEach(l => { connectedNodes.add(l.source.id); connectedNodes.add(l.target.id); });

  const { downstreamNodes, downstreamLinks } = reachableDownstream(d.id, out);
  const scores = computeInfluenceScores(d.id, out);

  nodeSel.classed("dimmed", true).classed("selected", false).classed("downstream", false);
  linkSel.classed("dimmed", true).classed("selected", false).classed("downstream", false);

  nodeSel.filter(n => connectedNodes.has(n.id)).classed("dimmed", false);
  linkSel.filter(l => connectedLinks.has(l)).classed("dimmed", false).classed("selected", true);

  nodeSel.filter(n => n.id === d.id).classed("selected", true);

  nodeSel.filter(n => downstreamNodes.has(n.id)).classed("dimmed", false).classed("downstream", true);
  linkSel.filter(l => downstreamLinks.has(l)).classed("dimmed", false).classed("downstream", true);

  let maxScore = 0;
  for (const [nid, s] of scores.entries()) if (nid !== d.id) maxScore = Math.max(maxScore, s);
  maxScore = Math.max(maxScore, 0.01);

  nodeSel.select("circle").attr("r", n => {
    const s = scores.get(n.id) || 0;
    if (n.id === d.id) return n.baseR + 10;
    const t = Math.max(0, Math.min(1, s / maxScore));
    return n.baseR + 18 * t;
  });

  setPanel(`
    <div class="kv"><div class="k">Node</div><div class="v"><b>${escapeHtml(d.label)}</b></div></div>
    <div class="kv"><div class="k">Theme</div><div class="v">${escapeHtml(d.theme || "—")}</div></div>
    <div class="kv"><div class="k">Connected edges</div><div class="v">${connectedLinks.size}</div></div>
    <div class="kv"><div class="k">Downstream reachable nodes</div><div class="v">${downstreamNodes.size - 1}</div></div>
    <div class="kv"><div class="k">Tip</div><div class="v muted">Click an edge to view its formula.</div></div>
  `);

  event.stopPropagation();
}

function onLinkClick(event, l) {
  // IMPORTANT: do NOT let the background reset fire
  event.stopPropagation();

  // Highlight only edge + endpoints
  nodeSel.classed("dimmed", true).classed("selected", false).classed("downstream", false);
  linkSel.classed("dimmed", true).classed("selected", false).classed("downstream", false);

  linkSel.filter(x => x === l).classed("dimmed", false).classed("selected", true);
  nodeSel.filter(n => n.id === l.source.id || n.id === l.target.id)
    .classed("dimmed", false).classed("selected", true);

  nodeSel.select("circle").attr("r", d => d.baseR);
  nodeSel.filter(n => n.id === l.source.id || n.id === l.target.id)
    .select("circle").attr("r", d => d.baseR + 10);

  setPanel(`
    <div class="kv"><div class="k">Edge</div>
      <div class="v"><b>${escapeHtml(l.source.label)} → ${escapeHtml(l.target.label)}</b></div>
    </div>
    <div class="kv"><div class="k">Sign</div><div class="v">${escapeHtml(l.sign || "?")}</div></div>
    <div class="kv"><div class="k">Weight</div><div class="v">${l.weight ?? "-"}</div></div>
    <div class="kv"><div class="k">Formula</div><code>${escapeHtml(l.formula || "—")}</code></div>
  `);
}

function addArrowMarker(defs) {
  defs.append("marker")
    .attr("id", "arrow")
    .attr("viewBox", "0 -5 10 10")
    .attr("refX", 18)
    .attr("refY", 0)
    .attr("markerWidth", 7)
    .attr("markerHeight", 7)
    .attr("orient", "auto")
    .append("path")
    .attr("d", "M0,-5L10,0L0,5")
    .attr("fill", "rgba(18,24,38,0.45)");
}

async function main() {
  const { width, height } = sizeSvgToContainer();
  const data = await d3.json("data.json");

  const nodes = data.nodes.map(d => ({ ...d, baseR: 16 }));
  links = data.links.map(l => ({ ...l }));

  // Theme colors (light theme friendly)
  const themeColor = d3.scaleOrdinal()
    .domain(["health", "safety", "environment", "accessibility"])
    .range(["#22c55e", "#ef4444", "#3b82f6", "#a855f7"]);

  svg.selectAll("*").remove();
  const defs = svg.append("defs");
  addArrowMarker(defs);

  const g = svg.append("g");

  // Background click target ONLY (so edges/nodes remain clickable without resetting)
  const bg = g.append("rect")
    .attr("x", 0).attr("y", 0)
    .attr("width", width).attr("height", height)
    .attr("fill", "transparent")
    .style("pointer-events", "all")
    .on("click", () => resetStyles());

  // Zoom/pan
  svg.call(
    d3.zoom()
      .scaleExtent([0.4, 2.5])
      .on("zoom", (event) => g.attr("transform", event.transform))
  );

  const adjacency = buildAdjacency(links);

  simulation = d3.forceSimulation(nodes)
    .force("link", d3.forceLink(links).id(d => d.id).distance(140).strength(0.6))
    .force("charge", d3.forceManyBody().strength(-520))
    .force("center", d3.forceCenter(width / 2, height / 2))
    .force("collide", d3.forceCollide().radius(d => d.baseR + 16));

  linkSel = g.append("g")
    .attr("class", "links")
    .selectAll("path")
    .data(links)
    .enter()
    .append("path")
    .attr("class", "link")
    .attr("marker-end", "url(#arrow)")
    .style("pointer-events", "stroke")
    .on("click", onLinkClick);

  // +/- labels (signs)
  linkLabelSel = g.append("g")
    .attr("class", "link-labels")
    .selectAll("text")
    .data(links)
    .enter()
    .append("text")
    .attr("class", "link-label")
    .text(d => (d.sign === "-" ? "–" : "+"));

  nodeSel = g.append("g")
    .attr("class", "nodes")
    .selectAll("g")
    .data(nodes)
    .enter()
    .append("g")
    .attr("class", "node")
    .on("click", (event, d) => onNodeClick(event, d, adjacency))
    .call(
      d3.drag()
        .on("start", (event, d) => {
          if (!event.active) simulation.alphaTarget(0.3).restart();
          d.fx = d.x; d.fy = d.y;
        })
        .on("drag", (event, d) => { d.fx = event.x; d.fy = event.y; })
        .on("end", (event, d) => {
          if (!event.active) simulation.alphaTarget(0);
          d.fx = null; d.fy = null;
        })
    );

  nodeSel.append("circle")
    .attr("r", d => d.baseR)
    .attr("fill", d => themeColor(d.theme || "accessibility"));

  labelSel = nodeSel.append("text")
    .attr("dx", d => d.baseR + 10)
    .attr("dy", 4)
    .text(d => d.label);

  resetBtn.on("click", () => resetStyles());

  simulation.on("tick", () => {
    linkSel.attr("d", d => {
      const sx = d.source.x, sy = d.source.y;
      const tx = d.target.x, ty = d.target.y;

      const dx = tx - sx, dy = ty - sy;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;

      const sPad = (d.source.baseR || 16) + 2;
      const tPad = (d.target.baseR || 16) + 10;

      const x1 = sx + (dx / dist) * sPad;
      const y1 = sy + (dy / dist) * sPad;
      const x2 = tx - (dx / dist) * tPad;
      const y2 = ty - (dy / dist) * tPad;

      return `M${x1},${y1} L${x2},${y2}`;
    });

    // Place +/- sign at midpoint of the rendered link
    linkLabelSel
      .attr("x", d => (d.source.x + d.target.x) / 2)
      .attr("y", d => (d.source.y + d.target.y) / 2);

    nodeSel.attr("transform", d => `translate(${d.x},${d.y})`);
  });

  window.addEventListener("resize", () => {
    const r = sizeSvgToContainer();
    bg.attr("width", r.width).attr("height", r.height);
    simulation.force("center", d3.forceCenter(r.width / 2, r.height / 2));
    simulation.alpha(0.3).restart();
  });

  resetStyles();
}

main().catch(err => {
  console.error(err);
  setPanel(`<div class="v">Failed to load. Check console.<br><span class="muted">${escapeHtml(String(err))}</span></div>`);
});

