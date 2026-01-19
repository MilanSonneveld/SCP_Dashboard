const svg = d3.select("#graph");

// Right-side "Selection" panel is being phased out.
// If #panel still exists in HTML, we’ll update it; otherwise no-op.
const panel = d3.select("#panel");
const resetBtn = d3.select("#resetBtn");

// Inputs
const slidersDiv = d3.select("#sliders");

// Bottom formula area
const drawer = d3.select("#drawer");
const drawerTitle = d3.select("#drawerTitle");
const drawerEdge = d3.select("#drawerEdge");          // NEW in your HTML
const drawerFormula = d3.select("#drawerFormula");
const drawerExplanation = d3.select("#drawerExplanation");
const drawerSources = d3.select("#drawerSources");
const drawerVars = d3.select("#drawerVars");          // NEW in your HTML

// Old close button may or may not exist now
const drawerClose = d3.select("#drawerClose");
if (!drawerClose.empty()) {
  drawerClose.on("click", () => drawer.classed("open", false));
}

function setPanel(html) {
  if (!panel.empty()) panel.html(html);
}

function escapeHtml(s) {
  return (s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function sizeSvgToContainer() {
  const rect = svg.node().getBoundingClientRect();
  svg.attr("viewBox", `0 0 ${rect.width} ${rect.height}`);
  return { width: rect.width, height: rect.height };
}

let simulation;
let nodeSel, linkSel, labelSel, linkLabelSel;
let links = [];
let nodes = [];

// Slider-driven values
const nodeValue = new Map(); // id -> numeric

// Token index for variable parsing: formulaToken -> node
const tokenToNode = new Map();

function formatNumber(x) {
  if (x == null || Number.isNaN(x)) return "—";
  const ax = Math.abs(x);
  if (ax >= 1e9) return (x / 1e9).toFixed(2) + "B";
  if (ax >= 1e6) return (x / 1e6).toFixed(2) + "M";
  if (ax >= 1e3) return (x / 1e3).toFixed(2) + "k";
  return String(Math.round(x * 100) / 100);
}

function resetStyles() {
  nodeSel.classed("selected", false).classed("downstream", false).classed("dimmed", false);
  linkSel.classed("selected", false).classed("downstream", false).classed("dimmed", false);

  updateNodeSizingFromValues();

  // Optional legacy panel (if present)
  setPanel(`<div class="muted">Use the sliders on the right. Click an edge to view quantification below.</div>`);

  // Reset bottom formula section
  if (!drawerTitle.empty()) drawerTitle.text("Formula details");
  if (!drawerEdge.empty()) drawerEdge.text("Click an edge to view its quantification.");
  if (!drawerFormula.empty()) drawerFormula.text("—");
  if (!drawerExplanation.empty()) drawerExplanation.text("—");
  if (!drawerSources.empty()) drawerSources.html("").append("li").text("—");
  renderQuantificationVars([], null);
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

/**
 * Build a mapping so formula tokens can resolve to node objects.
 * Uses:
 * - node.id
 * - snake(label)
 * - aliases (recommended in JSON)
 */
function buildTokenIndexFromNodes() {
  tokenToNode.clear();

  const snake = (s) => (s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  for (const n of nodes) {
    const candidates = new Set();

    candidates.add(String(n.id));
    candidates.add(String(n.id).toUpperCase());

    const sl = snake(n.label);
    if (sl) {
      candidates.add(sl);
      candidates.add(sl.toUpperCase());
    }

    // optional: allow explicit aliases in JSON nodes
    if (Array.isArray(n.aliases)) {
      for (const a of n.aliases) {
        if (!a) continue;
        candidates.add(String(a));
        candidates.add(String(a).toUpperCase());
      }
    }

    // Add common delta variants for candidates (e.g., ΔTRUCK_KM)
    for (const c of Array.from(candidates)) {
      tokenToNode.set(c, n);
      tokenToNode.set("Δ" + c, n);
    }
  }
}

/**
 * Extract variable-like tokens from a formula string.
 * - Handles underscores, dots (DALY_PM2.5), and Δ prefix.
 * - Ignores common function names and placeholder words.
 */
function parseFormulaVariables(formula) {
  const s = (formula || "").trim();
  if (!s) return [];

  // Pull tokens like: DALY_PM2.5, TRUCK_KM, ΔTRUCK_KM, Deaths_baseline, LE, C0
  const raw = s.match(/[Δ]?[A-Za-z][A-Za-z0-9_.]*/g) || [];

  const ignore = new Set([
    "tbd", "TBD",
    "min", "max", "log", "ln", "exp", "sqrt", "sin", "cos", "tan",
    "alpha", "beta", "gamma", "epsilon", "controls"
  ]);

  const cleaned = raw
    .map(x => x.trim())
    .filter(x => x.length > 0)
    .filter(x => !ignore.has(x) && !ignore.has(x.toLowerCase()))
    // avoid single-letter variables if you don’t want them:
    // .filter(x => x.length > 1 || ["C"].includes(x))
    ;

  // unique preserve order
  const seen = new Set();
  const out = [];
  for (const t of cleaned) {
    if (!seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

/**
 * For a link, resolve each variable into:
 * - label/name
 * - description
 * - default/current value
 *
 * Resolution priority:
 * 1) node match (via tokenToNode)
 * 2) link.params (recommended in JSON)
 * 3) unknown parameter
 */
function buildQuantificationItemsForLink(l) {
  const vars = parseFormulaVariables(l.formula || "");

  // Build quick lookup for link params if present
  const paramsByName = new Map();
  if (Array.isArray(l.params)) {
    for (const p of l.params) {
      if (!p?.name) continue;
      paramsByName.set(String(p.name), p);
      paramsByName.set(String(p.name).toUpperCase(), p);
      paramsByName.set("Δ" + String(p.name), p);
      paramsByName.set(("Δ" + String(p.name)).toUpperCase(), p);
    }
  }

  const items = vars.map(v => {
    const vKey = String(v);
    const node = tokenToNode.get(vKey) || tokenToNode.get(vKey.toUpperCase());

    if (node) {
      const isInput = (node.type || "").toLowerCase() === "input";
      const hasSlider = !!node.slider;
      const current = nodeValue.get(node.id);
      const defaultVal = node.slider?.default;

      // Prefer current slider value if input, else show current computed value
      const valueToShow = (isInput && hasSlider) ? current : current;

      return {
        token: vKey,
        name: node.label || node.id,
        description: node.unit ? `Unit: ${node.unit}` : "Model variable",
        value: (valueToShow == null ? defaultVal : valueToShow),
        unit: node.unit || ""
      };
    }

    const p = paramsByName.get(vKey) || paramsByName.get(vKey.toUpperCase());
    if (p) {
      return {
        token: vKey,
        name: p.name,
        description: p.description || "Parameter",
        value: p.default,
        unit: p.unit || ""
      };
    }

    return {
      token: vKey,
      name: vKey,
      description: "Parameter (not mapped yet). Add node.aliases or link.params in data.json to explain it.",
      value: null,
      unit: ""
    };
  });

  return items;
}

function renderQuantificationVars(items, l) {
  if (drawerVars.empty()) return;

  drawerVars.html("");

  if (!items || items.length === 0) {
    drawerVars.append("div").attr("class", "vars-empty muted").text("—");
    return;
  }

  for (const it of items) {
    const box = drawerVars.append("div").attr("class", "var");
    const top = box.append("div").attr("class", "var-top");

    top.append("div").attr("class", "var-name")
      .text(it.name);

    const unit = it.unit ? ` (${it.unit})` : "";
    top.append("div").attr("class", "var-default")
      .text(`Start: ${formatNumber(it.value)}${unit}`);

    box.append("div").attr("class", "var-desc")
      .text(it.description || "—");
  }
}

function initSlidersFromNodes() {
  if (slidersDiv.empty()) return;

  const inputNodes = nodes
    .filter(n => (n.type || "").toLowerCase() === "input" && n.slider);

  slidersDiv.html("");

  inputNodes.forEach(n => {
    if (!nodeValue.has(n.id)) nodeValue.set(n.id, n.slider.default ?? 0);

    const wrap = slidersDiv.append("div").attr("class", "slider");
    const top = wrap.append("div").attr("class", "top");
    top.append("div").attr("class", "name").text(n.label);

    const valSpan = top.append("div").attr("class", "val");
    const unit = n.unit ? ` ${n.unit}` : "";
    valSpan.text(`${formatNumber(nodeValue.get(n.id))}${unit}`);

    const range = wrap.append("input")
      .attr("type", "range")
      .attr("min", n.slider.min)
      .attr("max", n.slider.max)
      .attr("step", n.slider.step ?? 1)
      .attr("value", nodeValue.get(n.id));

    range.on("input", (event) => {
      const v = +event.target.value;
      nodeValue.set(n.id, v);
      valSpan.text(`${formatNumber(v)}${unit}`);

      propagateValues();
      updateNodeSizingFromValues();

      // If a link is currently shown, refresh quantification panel
      if (drawer.attr("data-active-link") === "1" && drawer.node().__activeLink) {
        const active = drawer.node().__activeLink;
        renderQuantificationVars(buildQuantificationItemsForLink(active), active);
      }
    });
  });

  propagateValues();
  updateNodeSizingFromValues();
}

function propagateValues() {
  // Reset non-input nodes to 0 each time
  nodes.forEach(n => {
    if ((n.type || "").toLowerCase() !== "input") nodeValue.set(n.id, 0);
  });

  const ITER = 6;

  for (let it = 0; it < ITER; it++) {
    for (const l of links) {
      const sid = l.source.id;
      const tid = l.target.id;

      const x = nodeValue.get(sid) ?? 0;

      let delta = 0;
      const impact = l.impact;

      if (impact?.type === "linear" && typeof impact.k === "number") {
        delta = impact.k * x;
      } else if (impact?.type === "qualitative") {
        delta = 0;
      } else {
        delta = (l.weight ?? 0.1) * x * 0.001;
      }

      if (l.sign === "-") delta = -delta;

      nodeValue.set(tid, (nodeValue.get(tid) ?? 0) + delta);
    }
  }
}

function updateNodeSizingFromValues() {
  if (!nodeSel) return;

  let maxAbs = 0;
  for (const n of nodes) {
    const v = nodeValue.get(n.id) ?? 0;
    maxAbs = Math.max(maxAbs, Math.abs(v));
  }
  maxAbs = Math.max(maxAbs, 1e-9);

  nodeSel.select("circle")
    .attr("r", n => {
      const v = nodeValue.get(n.id) ?? 0;
      const t = Math.min(1, Math.abs(v) / maxAbs);
      return n.baseR + 10 * t;
    });
}

function openDrawerForLink(l) {
  if (drawer.empty()) return;

  // Title + relationship line
  if (!drawerTitle.empty()) drawerTitle.text(`${l.source.label} → ${l.target.label}`);
  if (!drawerEdge.empty()) drawerEdge.text(`${l.source.label} → ${l.target.label}`);

  // Formula + explanation
  if (!drawerFormula.empty()) drawerFormula.text(l.formula || "—");
  if (!drawerExplanation.empty()) drawerExplanation.text(l.explanation || l.notes || "—");

  // Sources
  if (!drawerSources.empty()) {
    drawerSources.html("");
    const srcs = l.sources || [];
    if (srcs.length === 0) {
      drawerSources.append("li").text("—");
    } else {
      srcs.forEach(s => drawerSources.append("li").text(String(s)));
    }
  }

  // Quantification: parse variables from formula
  const items = buildQuantificationItemsForLink(l);
  renderQuantificationVars(items, l);

  // Remember active link so sliders can refresh quantification display
  drawer.attr("data-active-link", "1");
  drawer.node().__activeLink = l;

  // Keep open (your CSS may not use .open anymore; harmless)
  drawer.classed("open", true).attr("aria-hidden", "false");
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
    if (n.id === d.id) return n.baseR + 12;
    const t = Math.max(0, Math.min(1, s / maxScore));
    return n.baseR + 18 * t;
  });

  // No longer show node details in the right panel (keep optional fallback)
  setPanel(`<div class="muted">Adjust inputs on the right. Click an edge to view formula details below.</div>`);

  event.stopPropagation();
}

function onLinkClick(event, l) {
  event.stopPropagation();

  nodeSel.classed("dimmed", true).classed("selected", false).classed("downstream", false);
  linkSel.classed("dimmed", true).classed("selected", false).classed("downstream", false);

  linkSel.filter(x => x === l).classed("dimmed", false).classed("selected", true);
  nodeSel.filter(n => n.id === l.source.id || n.id === l.target.id)
    .classed("dimmed", false).classed("selected", true);

  updateNodeSizingFromValues();

  // Optional: clear right panel
  setPanel(`<div class="muted">Use the bottom panel for formula details.</div>`);

  openDrawerForLink(l);
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

  nodes = data.nodes.map(d => ({ ...d, baseR: 16 }));
  links = data.links.map(l => ({ ...l }));

  // Build token index now; note link endpoints become node objects after forceLink runs
  buildTokenIndexFromNodes();

  const themeColor = d3.scaleOrdinal()
    .domain(["health", "safety", "environment", "accessibility"])
    .range(["#22c55e", "#ef4444", "#3b82f6", "#a855f7"]);

  svg.selectAll("*").remove();
  const defs = svg.append("defs");
  addArrowMarker(defs);

  const g = svg.append("g");

  const bg = g.append("rect")
    .attr("x", 0).attr("y", 0)
    .attr("width", width).attr("height", height)
    .attr("fill", "transparent")
    .style("pointer-events", "all")
    .on("click", () => {
      // Keep bottom panel visible; just reset highlights
      resetStyles();
    });

  svg.call(
    d3.zoom()
      .scaleExtent([0.4, 2.5])
      .on("zoom", (event) => g.attr("transform", event.transform))
  );

  simulation = d3.forceSimulation(nodes)
    .force("link", d3.forceLink(links).id(d => d.id).distance(140).strength(0.6))
    .force("charge", d3.forceManyBody().strength(-520))
    .force("center", d3.forceCenter(width / 2, height / 2))
    .force("collide", d3.forceCollide().radius(d => d.baseR + 16));

  const adjacency = buildAdjacency(links);

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

  resetBtn.on("click", () => {
    resetStyles();
  });

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

  initSlidersFromNodes();
  resetStyles();
}

main().catch(err => {
  console.error(err);
  setPanel(`<div class="v">Failed to load. Check console.<br><span class="muted">${escapeHtml(String(err))}</span></div>`);
});



