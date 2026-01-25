/* eslint-disable no-new-func */
/**
 * graph.js (no build tools) — single-file D3 dashboard
 * Features:
 * - Force / saved-position layout
 * - Edit layout (drag nodes), export/import positions to/from JSON
 * - Edge click -> formula + edge-scoped parameters sliders
 * - Node click -> highlight downstream path
 */

(() => {
  const BUILD = "v4-positions";
  const $ = (sel) => document.querySelector(sel);

  const svg = d3.select("#graph");
  const slidersDiv = d3.select("#sliders");

  // Drawer elements
  const drawerTitle = d3.select("#drawerTitle");
  const drawerEdge = d3.select("#drawerEdge");
  const drawerFormula = d3.select("#drawerFormula");
  const drawerExplanation = d3.select("#drawerExplanation");
  const drawerSources = d3.select("#drawerSources");
  const drawerVars = d3.select("#drawerVars");
  const resetEdgeVarsBtn = d3.select("#resetEdgeVarsBtn");

  // Buttons
  const resetBtn = d3.select("#resetBtn");
  const editLayoutBtn = d3.select("#editLayoutBtn");
  const exportPositionsBtn = d3.select("#exportPositionsBtn");
  const importPositionsBtn = d3.select("#importPositionsBtn");
  const importPositionsFile = $("#importPositionsFile");
  const clearPositionsBtn = d3.select("#clearPositionsBtn");
  const exportSvgBtn = d3.select("#exportSvgBtn");

  const buildTag = $("#buildTag");
  if (buildTag) buildTag.textContent = `Loaded ${BUILD} • ${new Date().toLocaleString()}`;

  // --- State --------------------------------------------------------------
  let data = null;
  let baselineMap = new Map(); // nodeId -> baseline (initial) value
  function getBaseline(id) {
    return baselineMap.has(id) ? baselineMap.get(id) : 0;
  }

  let inputState = {};          // nodeId -> value
  let edgeParamState = {};      // edgeId -> {param -> value}
  let selectedEdgeId = null;
  let selectedNodeId = null;

  let editMode = false;

  // D3 elements
  let simulation = null;
  let linkSel = null;
  let nodeSel = null;
  let labelSel = null;

  // graph sizing
  const LEFT_PAD = 16;
  const TOP_PAD = 16;

  function clamp(n, lo, hi) {
    return Math.max(lo, Math.min(hi, n));
  }

  function safeNumber(v, fallback = 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }

  // --- Compute ------------------------------------------------------------
  function evaluateEdge(edge, fromValue) {
    // Edge-scoped base vars live in data.baseVars[edge.id]
    const base = (data.baseVars && data.baseVars[edge.id]) ? data.baseVars[edge.id] : {};
    const params = edgeParamState[edge.id] || {};
    const ctx = { from: safeNumber(fromValue, 0) };

    const uses = (edge.compute && Array.isArray(edge.compute.uses)) ? edge.compute.uses : [];
    for (const name of uses) {
      // priority: live param state -> baseVar default -> 0
      if (name in params) ctx[name] = safeNumber(params[name], 0);
      else if (base[name] && "defaultValue" in base[name]) ctx[name] = safeNumber(base[name].defaultValue, 0);
      else ctx[name] = 0;
    }

    // Replace tokens with numeric values (whole-word)
    let expr = (edge.compute && edge.compute.expr) ? String(edge.compute.expr) : "0";
    for (const [k, v] of Object.entries(ctx)) {
      expr = expr.replace(new RegExp(`\\b${k}\\b`, "g"), String(v));
    }

    try {
      const result = Function(`"use strict"; return (${expr});`)();
      return safeNumber(result, 0);
    } catch (e) {
      return 0;
    }
  }

  function computeAllNodes() {
    // For now we compute:
    // - input nodes = inputState
    // - computed nodes = sum of incoming evaluated edges
    const state = { ...inputState };
    const computed = new Set();

    for (const n of data.nodes) {
      if (n.type === "Input") computed.add(n.id);
    }

    let guard = 0;
    while (computed.size < data.nodes.length && guard < 200) {
      let progressed = false;

      for (const node of data.nodes) {
        if (computed.has(node.id)) continue;

        const incoming = data.links.filter(l => l.target === node.id);
        const allReady = incoming.every(l => computed.has(l.source));
        if (!allReady) continue;

        let value = getBaseline(node.id);
        for (const edge of incoming) {
          value += evaluateEdge(edge, state[edge.source] ?? 0);
        }

        // Keep things stable for now (visual sizing), but do NOT clamp parameters.
        state[node.id] = clamp(value, 0, 100);
        computed.add(node.id);
        progressed = true;
      }

      if (!progressed) break;
      guard++;
    }

    return state;
  }

  function getDownstreamEdges(nodeId) {
    const out = new Set();
    const visited = new Set([nodeId]);
    const q = [nodeId];

    while (q.length) {
      const cur = q.shift();
      for (const e of data.links) {
        if (e.source === cur) {
          out.add(e.id);
          if (!visited.has(e.target)) {
            visited.add(e.target);
            q.push(e.target);
          }
        }
      }
    }
    return out;
  }

  // --- UI: sliders --------------------------------------------------------
  function renderInputSliders() {
    slidersDiv.html("");

    const inputNodes = data.nodes.filter(n => n.type === "Input");
    for (const node of inputNodes) {
      const box = slidersDiv.append("div").attr("class", "slider-card");
      box.append("div").attr("class", "slider-title").text(node.label);

      const unit = node.unit ? ` (${node.unit})` : "";
      box.append("div").attr("class", "slider-subtitle").text(unit);

      const cfg = node.slider || { min: 0, max: 100, step: 1, default: 0 };
      const value = safeNumber(inputState[node.id], safeNumber(cfg.default, 0));

      const row = box.append("div").attr("class", "slider-row");
      const input = row.append("input")
        .attr("type", "range")
        .attr("min", cfg.min)
        .attr("max", cfg.max)
        .attr("step", cfg.step ?? 1)
        .attr("value", value);

      const valEl = row.append("div").attr("class", "slider-value");
      const fmt = (v) => {
        const n = safeNumber(v, 0);
        // Show big numbers with separators
        return n >= 1000 ? n.toLocaleString() : String(n);
      };
      valEl.text(fmt(value));

      input.on("input", (ev) => {
        const v = safeNumber(ev.target.value, 0);
        inputState[node.id] = v;
        valEl.text(fmt(v));
        updateGraph();
      });
    }
  }

  function renderEdgeVars(edge) {
    drawerVars.html("");
    resetEdgeVarsBtn.style("display", "none");

    const base = data.baseVars && data.baseVars[edge.id] ? data.baseVars[edge.id] : null;
    if (!base) {
      drawerVars.append("div").attr("class", "tiny").text("No parameters defined for this relationship.");
      return;
    }

    if (!edgeParamState[edge.id]) edgeParamState[edge.id] = {};
    const state = edgeParamState[edge.id];

    const uses = (edge.compute && Array.isArray(edge.compute.uses)) ? edge.compute.uses : Object.keys(base);

    // Reset button
    resetEdgeVarsBtn.style("display", "inline-flex");
    resetEdgeVarsBtn.on("click", () => {
      for (const k of Object.keys(base)) {
        state[k] = safeNumber(base[k].defaultValue, 0);
      }
      renderEdgeVars(edge);
      updateGraph();
    });

    for (const key of uses) {
      const def = base[key];
      if (!def) continue;

      if (!(key in state)) state[key] = safeNumber(def.defaultValue, 0);

      const card = drawerVars.append("div").attr("class", "var-card");
      const header = card.append("div").attr("class", "var-header");
      header.append("div").attr("class", "var-name").text(def.label || key);

      const cur = safeNumber(state[key], 0);
      const right = header.append("div").attr("class", "var-cur").text(String(cur));

      if (def.unit) card.append("div").attr("class", "var-unit").text(`Unit: ${def.unit}`);
      if (def.description) card.append("div").attr("class", "var-desc").text(def.description);

      const row = card.append("div").attr("class", "var-row");
      const r = row.append("input")
        .attr("type", "range")
        .attr("min", def.min ?? 0)
        .attr("max", def.max ?? 100)
        .attr("step", def.step ?? 1)
        .attr("value", cur);

      r.on("input", (ev) => {
        const v = safeNumber(ev.target.value, 0);
        state[key] = v;
        right.text(String(v));
        updateGraph();
      });
    }
  }

  // --- Drawer -------------------------------------------------------------
  function showEdgeDetails(edge) {
    selectedEdgeId = edge.id;
    selectedNodeId = null;

    drawerTitle.text(`${edge.sourceLabel || edge.source} → ${edge.targetLabel || edge.target}`);
    drawerEdge.text(`${edge.sourceLabel || edge.source} → ${edge.targetLabel || edge.target}`);

    drawerFormula.text(edge.formula || edge.displayFormula || "—");
    drawerExplanation.text(edge.explanation || "—");

    drawerSources.html("");
    const sources = Array.isArray(edge.sources) ? edge.sources : [];
    if (!sources.length) {
      drawerSources.append("li").text("—");
    } else {
      for (const s of sources) drawerSources.append("li").text(s);
    }

    renderEdgeVars(edge);

    // Highlight selected edge
    linkSel.classed("selected", d => d.id === selectedEdgeId);
  }

  // --- Layout + rendering -------------------------------------------------
  function applyPositionsToSimulation(nodes) {
    for (const n of nodes) {
      // If positions exist, we pin unless editMode is on
      if (typeof n.x === "number" && typeof n.y === "number") {
        if (!editMode) {
          n.fx = n.x;
          n.fy = n.y;
        }
      }
      // When edit mode, do not force-pin
      if (editMode) {
        n.fx = null;
        n.fy = null;
      }
    }
  }

  function setupGraph() {
    // --- Size SVG to container
    const leftEl = $("#left");
    const bbox = leftEl.getBoundingClientRect();
    const width = Math.max(600, Math.floor(bbox.width - LEFT_PAD));
    const height = Math.max(420, Math.floor(bbox.height - TOP_PAD));

    svg.attr("viewBox", `0 0 ${width} ${height}`);
    svg.attr("preserveAspectRatio", "xMidYMid meet");

    svg.selectAll("*").remove();

    // defs: arrow marker
    const defs = svg.append("defs");
    defs.append("marker")
      .attr("id", "arrow")
      .attr("viewBox", "0 -5 10 10")
      .attr("refX", 18)
      .attr("refY", 0)
      .attr("markerWidth", 6)
      .attr("markerHeight", 6)
      .attr("orient", "auto")
      .append("path")
      .attr("d", "M0,-5L10,0L0,5");

    const g = svg.append("g").attr("class", "viewport");

    // Zoom/pan
    svg.call(d3.zoom().scaleExtent([0.3, 3]).on("zoom", (ev) => g.attr("transform", ev.transform)));

    // Prepare node objects
    const nodes = data.nodes.map(n => ({ ...n }));
    const nodeById = new Map(nodes.map(n => [n.id, n]));

    const links = data.links.map(l => ({
      ...l,
      source: nodeById.get(l.source) || l.source,
      target: nodeById.get(l.target) || l.target,
      sourceLabel: (nodeById.get(l.source)?.label) || l.source,
      targetLabel: (nodeById.get(l.target)?.label) || l.target,
    }));

    applyPositionsToSimulation(nodes);

    // D3 selections
    linkSel = g.append("g").attr("class", "links")
      .selectAll("path")
      .data(links, d => d.id)
      .join("path")
      .attr("class", "link")
      .attr("marker-end", "url(#arrow)")
      .on("click", (ev, d) => {
        ev.stopPropagation();
        showEdgeDetails(d);
      });

    nodeSel = g.append("g").attr("class", "nodes")
      .selectAll("circle")
      .data(nodes, d => d.id)
      .join("circle")
      .attr("class", d => `node ${d.type === "Input" ? "input" : "computed"}`)
      .on("click", (ev, d) => {
        ev.stopPropagation();
        selectedNodeId = d.id;
        selectedEdgeId = null;

        const downstream = getDownstreamEdges(d.id);
        linkSel.classed("downstream", e => downstream.has(e.id));
        linkSel.classed("selected", false);
      });

    labelSel = g.append("g").attr("class", "labels")
      .selectAll("text")
      .data(nodes, d => d.id)
      .join("text")
      .attr("class", "label")
      .text(d => d.label);

    // background click clears selection
    svg.on("click", () => {
      selectedNodeId = null;
      selectedEdgeId = null;
      linkSel.classed("selected", false).classed("downstream", false);
    });

    // Drag only in edit mode
    const drag = d3.drag()
      .on("start", (ev, d) => {
        if (!editMode) return;
        if (!ev.active) simulation.alphaTarget(0.3).restart();
        d.fx = d.x;
        d.fy = d.y;
      })
      .on("drag", (ev, d) => {
        if (!editMode) return;
        d.fx = ev.x;
        d.fy = ev.y;
      })
      .on("end", (ev, d) => {
        if (!editMode) return;
        if (!ev.active) simulation.alphaTarget(0);
        // Save final position into data.nodes (authoritative) as x/y
        const orig = data.nodes.find(n => n.id === d.id);
        if (orig) {
          orig.x = d.fx;
          orig.y = d.fy;
        }
      });

    nodeSel.call(drag);
    labelSel.call(drag);

    // Simulation
    simulation = d3.forceSimulation(nodes)
      .force("link", d3.forceLink(links).id(d => d.id).distance(120).strength(0.6))
      .force("charge", d3.forceManyBody().strength(-450))
      .force("collide", d3.forceCollide().radius(d => nodeRadius(d) + 10))
      .force("center", d3.forceCenter(width / 2, height / 2))
      .on("tick", () => {
        linkSel.attr("d", d => linkPath(d));
        nodeSel.attr("cx", d => d.x).attr("cy", d => d.y);
        labelSel.attr("x", d => d.x).attr("y", d => d.y - (nodeRadius(d) + 8));
      });

    // If we have saved positions and not editing, lock them by killing alpha.
    if (!editMode && nodes.some(n => typeof n.fx === "number")) {
      simulation.alpha(0.05).restart();
      setTimeout(() => simulation.alphaTarget(0), 300);
    }

    updateGraph();
  }

  function nodeRadius(d) {
    // Use computed node values to set size a bit (inputs fixed)
    if (!data) return 10;
    if (d.type === "Input") return 10;

    const nodeValues = computeAllNodes();
    const v = safeNumber(nodeValues[d.id], 0);
    return clamp(6 + (v / 100) * 16, 6, 28);
  }

  function linkPath(d) {
    const sx = d.source.x, sy = d.source.y;
    const tx = d.target.x, ty = d.target.y;

    // Small curve for readability
    const dx = tx - sx;
    const dy = ty - sy;
    const dr = Math.sqrt(dx*dx + dy*dy) * 0.9;
    return `M${sx},${sy}A${dr},${dr} 0 0,1 ${tx},${ty}`;
  }

  function updateGraph() {
    if (!data || !nodeSel || !linkSel) return;

    const values = computeAllNodes();

    // Update node sizes
    nodeSel.attr("r", d => {
      if (d.type === "Input") return 10;
      const v = safeNumber(values[d.id], 0);
      return clamp(6 + (v / 100) * 16, 6, 28);
    });

    // Edge thickness based on contribution from "from" node
    linkSel.attr("stroke-width", d => {
      const fromId = d.source.id || d.source;
      const fromValue = (fromId in values) ? values[fromId] : (inputState[fromId] ?? 0);
      const contrib = Math.abs(evaluateEdge(d, fromValue));
      const w = 1 + Math.min(6, contrib / 20);
      return w;
    });

    // Keep highlight classes
    linkSel.classed("selected", d => d.id === selectedEdgeId);
    if (selectedNodeId) {
      const downstream = getDownstreamEdges(selectedNodeId);
      linkSel.classed("downstream", e => downstream.has(e.id));
    } else {
      linkSel.classed("downstream", false);
    }

    // Update labels to show value (optional: keep compact)
    labelSel.text(d => {
      if (d.type === "Input") return d.label;
      const v = safeNumber(values[d.id], 0);
      return `${d.label}`;
    });
  }

  // --- Export/Import ------------------------------------------------------
  function downloadText(filename, text, mime = "application/json") {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function exportPositions() {
    // Merge current data.nodes positions into JSON and download
    const out = structuredClone(data);

    // Ensure x/y exist only when we have them
    for (const n of out.nodes) {
      if (typeof n.x !== "number" || typeof n.y !== "number") {
        delete n.x;
        delete n.y;
      }
    }
    downloadText("data.positions.json", JSON.stringify(out, null, 2));
  }

  function clearPositions() {
    for (const n of data.nodes) {
      delete n.x;
      delete n.y;
    }
    // Rebuild graph with auto layout
    editMode = false;
    editLayoutBtn.text("Edit layout").classed("active", false);
    setupGraph();
  }

  function importPositionsFromJson(obj) {
    if (!obj || !Array.isArray(obj.nodes)) return;

    const posById = new Map();
    for (const n of obj.nodes) {
      if (n && n.id && typeof n.x === "number" && typeof n.y === "number") {
        posById.set(n.id, { x: n.x, y: n.y });
      }
    }

    for (const n of data.nodes) {
      const p = posById.get(n.id);
      if (p) {
        n.x = p.x;
        n.y = p.y;
      }
    }

    editMode = false;
    editLayoutBtn.text("Edit layout").classed("active", false);
    setupGraph();
  }

  function exportSvg() {
    const svgEl = $("#graph");
    if (!svgEl) return;

    // Inline marker defs etc already present; serialize
    const clone = svgEl.cloneNode(true);

    // Ensure xmlns
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    const serializer = new XMLSerializer();
    const source = serializer.serializeToString(clone);
    downloadText("graph.svg", source, "image/svg+xml");
  }

  // --- Init ---------------------------------------------------------------
  async function init() {
    // Fetch data.json (same folder as index.html)
    const res = await fetch("data_with_positions_v2.json", { cache: "no-store" });
    data = await res.json();

    // Build baseline map (used for delta-style formulas and stable initialization)
    baselineMap = new Map(
      data.nodes.map(n => [
        n.id,
        safeNumber(
          n.baseline,
          (n.slider && n.slider.default !== undefined) ? n.slider.default : 0
        )
      ])
    );


    // Init input state from sliders default
    inputState = {};
    for (const n of data.nodes) {
      const cfg = n.slider || {};
      inputState[n.id] = safeNumber(cfg.default, 0);
    }

    // Init edge param state from baseVars defaults (edge-scoped)
    edgeParamState = {};
    if (data.baseVars) {
      for (const [edgeId, params] of Object.entries(data.baseVars)) {
        edgeParamState[edgeId] = {};
        for (const [k, meta] of Object.entries(params)) {
          edgeParamState[edgeId][k] = safeNumber(meta.defaultValue, 0);
        }
      }
    }

    renderInputSliders();
    setupGraph();

    // Buttons
    resetBtn.on("click", () => {
      for (const n of data.nodes) {
        const cfg = n.slider || {};
        inputState[n.id] = safeNumber(cfg.default, 0);
      }
      renderInputSliders();

      // reset edge vars too
      if (data.baseVars) {
        for (const [edgeId, params] of Object.entries(data.baseVars)) {
          for (const [k, meta] of Object.entries(params)) {
            edgeParamState[edgeId][k] = safeNumber(meta.defaultValue, 0);
          }
        }
      }

      selectedEdgeId = null;
      selectedNodeId = null;

      updateGraph();
      // If an edge is selected, re-render its vars with defaults
      if (selectedEdgeId) {
        const e = data.links.find(x => x.id === selectedEdgeId);
        if (e) renderEdgeVars(e);
      }
    });

    editLayoutBtn.on("click", () => {
      editMode = !editMode;
      editLayoutBtn.classed("active", editMode);
      editLayoutBtn.text(editMode ? "Finish layout" : "Edit layout");
      setupGraph();
    });

    exportPositionsBtn.on("click", exportPositions);
    clearPositionsBtn.on("click", clearPositions);

    importPositionsBtn.on("click", () => importPositionsFile.click());
    importPositionsFile.addEventListener("change", async (ev) => {
      const file = ev.target.files && ev.target.files[0];
      if (!file) return;
      try {
        const txt = await file.text();
        const obj = JSON.parse(txt);
        importPositionsFromJson(obj);
      } catch (e) {
        alert("Could not import positions: invalid JSON.");
      } finally {
        ev.target.value = "";
      }
    });

    exportSvgBtn.on("click", exportSvg);

    // Handle resizing
    window.addEventListener("resize", () => setupGraph());
  }

  init().catch(err => {
    console.error(err);
    alert("Failed to load dashboard. Open DevTools console for details.");
  });
})();
