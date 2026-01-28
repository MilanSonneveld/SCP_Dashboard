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
  const BUILD = "v5-editable-edge-metadata";
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

  
// Node editor elements
const nodeEditor = d3.select("#nodeEditor");
const nodeEditorTitle = d3.select("#nodeEditorTitle");
const nodeEditorSubtitle = d3.select("#nodeEditorSubtitle");
const nodeBaselineLabel = d3.select("#nodeBaselineLabel");
const nodeBaselineHint = d3.select("#nodeBaselineHint");
const nodeBaselineInput = $("#nodeBaselineInput");
const applyNodeBaselineBtn = d3.select("#applyNodeBaselineBtn");

// Preferred UI (slider) for baselines, if present in the HTML.
// Backwards compatible with the number-input UI.
const nodeBaselineRange = document.getElementById("nodeBaselineRange");
const nodeBaselineValueEl = document.getElementById("nodeBaselineValue");

// Editable edge metadata editors
const drawerFormulaEditor = $("#drawerFormulaEditor");
const drawerExplanationEditor = $("#drawerExplanationEditor");
const drawerSourcesEditor = $("#drawerSourcesEditor");
const applyEdgeMetaBtn = d3.select("#applyEdgeMetaBtn");

// Push backend button
const pushBackendBtn = d3.select("#pushBackendBtn");
// Formula editor (machine readable)
  const drawerComputeMeta = d3.select("#drawerComputeMeta");
  const drawerComputeExpr = d3.select("#drawerComputeExpr");
  const computeExprEditor = $("#computeExprEditor");
  const applyComputeExprBtn = d3.select("#applyComputeExprBtn");
  const syncUsesBtn = d3.select("#syncUsesBtn");

  async function pushModelToBackend(){
  const ENDPOINT = window.MODEL_BACKEND_URL || "/api/model";
  try{
    const payload = JSON.stringify(data, null, 2);
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload
    });
    if (!res.ok){
      const txt = await res.text();
      alert(`Backend push failed (${res.status}).
${txt}`);
      return;
    }
    alert("Pushed model to backend successfully.");
  }catch(e){
    alert("Backend push failed (network/CORS). Check endpoint and console.");
  }
}

// Buttons
  const resetBtn = d3.select("#resetBtn");
  const editLayoutBtn = d3.select("#editLayoutBtn");
  const exportPositionsBtn = d3.select("#exportPositionsBtn");
  const exportModelBtn = d3.select("#exportModelBtn");
  const importPositionsBtn = d3.select("#importPositionsBtn");
  const importPositionsFile = $("#importPositionsFile");
  const clearPositionsBtn = d3.select("#clearPositionsBtn");
  const exportSvgBtn = d3.select("#exportSvgBtn");

  // Add variable UI
  const addVarBtn = d3.select("#addVarBtn");
  const addVarForm = d3.select("#addVarForm");

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

  function uniq(arr) {
    return Array.from(new Set(arr));
  }

  function ensureEdgeStructures(edge) {
    if (!edge.compute) edge.compute = { mode: "direct", expr: "0", uses: [] };
    if (!Array.isArray(edge.compute.uses)) edge.compute.uses = [];
    if (!data.baseVars) data.baseVars = {};
    if (!data.baseVars[edge.id]) data.baseVars[edge.id] = {};
    if (!edgeParamState[edge.id]) edgeParamState[edge.id] = {};
  }

  function parseUsesFromExpr(expr) {
    // Very small, local-only identifier parser.
    // Picks up tokens like beta, TRUCK_KM, baselineFrom, etc.
    const raw = String(expr || "").match(/[A-Za-z_][A-Za-z0-9_]*/g) || [];
    const banned = new Set([
      // runtime context
      "from", "baselineFrom", "baselineTarget", "fromDelta",
      // JS keywords / literals
      "Math", "true", "false", "null", "undefined", "NaN", "Infinity",
      "return", "if", "else", "let", "const", "var", "function", "new",
    ]);
    return uniq(raw.filter(t => !banned.has(t)));
  }

  function ensureBaseVar(edge, name) {
    ensureEdgeStructures(edge);
    const base = data.baseVars[edge.id];
    if (!base[name]) {
      base[name] = {
        label: name,
        description: "(added on the fly)",
        unit: "",
        min: 0,
        max: 100,
        step: 1,
        defaultValue: 0,
      };
    }
    if (!(name in edgeParamState[edge.id])) {
      edgeParamState[edge.id][name] = safeNumber(base[name].defaultValue, 0);
    }
  }

  function syncUsesFromEditor(edge) {
    ensureEdgeStructures(edge);
    const expr = computeExprEditor ? computeExprEditor.value : (edge.compute.expr || "0");
    const uses = parseUsesFromExpr(expr);
    edge.compute.uses = uses;
    for (const name of uses) ensureBaseVar(edge, name);
    renderEdgeVars(edge);
    updateGraph();
  }

  function renderAddVarForm(edge) {
    addVarForm.html("");
    if (!edge) {
      addVarForm.style("display", "none");
      return;
    }

    ensureEdgeStructures(edge);

    addVarForm.style("display", "none");
    addVarBtn.style("display", "inline-flex");

    addVarBtn.on("click", () => {
      const isOpen = addVarForm.style("display") !== "none";
      addVarForm.style("display", isOpen ? "none" : "block");
    });

    const grid = addVarForm.append("div").attr("class", "var-form-grid");

    const field = (label, type = "text", cls = "", placeholder = "") => {
      const wrap = grid.append("div").attr("class", `field ${cls}`.trim());
      wrap.append("label").text(label);
      const el = type === "textarea"
        ? wrap.append("textarea").attr("rows", 2)
        : wrap.append("input").attr("type", type);
      if (placeholder) el.attr("placeholder", placeholder);
      return el;
    };

    const nameEl = field("Variable name (identifier)", "text", "", "e.g. beta");
    const labelEl = field("Label", "text", "", "Shown in the UI");
    const unitEl = field("Unit", "text", "", "optional");
    const defEl = field("Default", "number");
    const minEl = field("Min", "number");
    const maxEl = field("Max", "number");
    const stepEl = field("Step", "number");
    const descEl = field("Description", "textarea", "full", "What does this represent?");

    // sensible defaults
    defEl.property("value", 0);
    minEl.property("value", 0);
    maxEl.property("value", 100);
    stepEl.property("value", 1);

    const actions = addVarForm.append("div").attr("class", "row-actions").style("marginTop", "10px");
    const addBtn = actions.append("button").attr("class", "btn btn-secondary btn-small").text("Add");
    const cancelBtn = actions.append("button").attr("class", "btn btn-secondary btn-small").text("Close");

    cancelBtn.on("click", () => addVarForm.style("display", "none"));

    addBtn.on("click", () => {
      const name = String(nameEl.property("value") || "").trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        alert("Invalid variable name. Use letters, numbers and underscore; cannot start with a number.");
        return;
      }

      const base = data.baseVars[edge.id];
      base[name] = {
        label: String(labelEl.property("value") || name).trim() || name,
        description: String(descEl.property("value") || "").trim(),
        unit: String(unitEl.property("value") || "").trim(),
        min: safeNumber(minEl.property("value"), 0),
        max: safeNumber(maxEl.property("value"), 100),
        step: safeNumber(stepEl.property("value"), 1),
        defaultValue: safeNumber(defEl.property("value"), 0),
      };

      edgeParamState[edge.id][name] = safeNumber(base[name].defaultValue, 0);

      // keep uses list in sync
      edge.compute.uses = uniq([...(edge.compute.uses || []), name]);

// Optional: insert the variable name into the machine-readable expression editor for convenience
if (computeExprEditor && computeExprEditor.value !== undefined) {
  const ta = computeExprEditor;
  const before = ta.value.slice(0, ta.selectionStart || 0);
  const after = ta.value.slice(ta.selectionEnd || 0);
  const spacer = (before && !/\s$/.test(before)) ? " " : "";
  ta.value = before + spacer + name + after;
  const pos = (before + spacer + name).length;
  ta.selectionStart = ta.selectionEnd = pos;
}

      renderEdgeVars(edge);
      updateGraph();
      addVarForm.style("display", "none");
    });
  }

function getNodeUnit(nodeId) {
  const n = data.nodes.find(n => n.id === nodeId);
  return (n && n.unit) ? n.unit : "";
}


  // --- Compute ------------------------------------------------------------
  function evaluateEdge(edge, fromValue) {
    // Edge-scoped base vars live in data.baseVars[edge.id]
    const base = (data.baseVars && data.baseVars[edge.id]) ? data.baseVars[edge.id] : {};
    const params = edgeParamState[edge.id] || {};
    const ctx = { from: safeNumber(fromValue, 0) };

    // Delta-mode helpers (timeless baseline comparison)
    if (edge.compute && edge.compute.mode === "delta") {
      ctx.baselineFrom = getBaseline(edge.source);
      ctx.baselineTarget = getBaseline(edge.target);
      ctx.fromDelta = ctx.from - ctx.baselineFrom;
    }

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

    // Show sliders only for "source" nodes: no incoming links, at least one outgoing.
    const inDeg = new Map();
    const outDeg = new Map();
    for (const n of data.nodes) { inDeg.set(n.id, 0); outDeg.set(n.id, 0); }
    for (const e of data.links) {
      outDeg.set(e.source, (outDeg.get(e.source) || 0) + 1);
      inDeg.set(e.target, (inDeg.get(e.target) || 0) + 1);
    }
    const isSourceNode = (id) => (inDeg.get(id) || 0) === 0 && (outDeg.get(id) || 0) > 0;

    const inputNodes = data.nodes.filter(n => n.slider && isSourceNode(n.id));
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

    ensureEdgeStructures(edge);
    const base = data.baseVars[edge.id];
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

    // Add variable controls
    renderAddVarForm(edge);

    for (const key of uses) {
      const def = base[key];
      if (!def) {
        // If the expression references a var that doesn't exist yet, auto-create it.
        ensureBaseVar(edge, key);
      }
      const def2 = base[key];
      if (!def2) continue;

      if (!(key in state)) state[key] = safeNumber(def2.defaultValue, 0);

      const card = drawerVars.append("div").attr("class", "var-card");
      const header = card.append("div").attr("class", "var-header");
      header.append("div").attr("class", "var-name").text(def2.label || key);

      const cur = safeNumber(state[key], 0);
      const right = header.append("div").attr("class", "var-cur").text(String(cur));

      if (def2.unit) card.append("div").attr("class", "var-unit").text(`Unit: ${def2.unit}`);
      if (def2.description) card.append("div").attr("class", "var-desc").text(def2.description);


// --- Editable definition (label/unit/range/step/default/description) ---
const editRow = card.append("div").attr("class", "row-actions").style("justifyContent", "flex-end").style("marginTop", "6px");
const editBtn = editRow.append("button").attr("class", "btn btn-secondary btn-small").text("Edit");
const editor = card.append("div").attr("class", "var-editor").style("display", "none");

const f = (lbl, type="text", val="") => {
  const w = editor.append("div").attr("class", "field");
  w.append("label").text(lbl);
  const el = (type === "textarea")
    ? w.append("textarea").attr("rows", 2)
    : w.append("input").attr("type", type);
  el.property("value", val ?? "");
  return el;
};

const eLabel = f("Label", "text", def2.label || key);
const eUnit = f("Unit", "text", def2.unit || "");
const eDefault = f("Default", "number", def2.defaultValue ?? 0);
const eMin = f("Min", "number", def2.min ?? 0);
const eMax = f("Max", "number", def2.max ?? 100);
const eStep = f("Step", "number", def2.step ?? 1);
const eDesc = f("Description", "textarea", def2.description || "");

const edActions = editor.append("div").attr("class", "row-actions").style("marginTop", "8px");
const saveDefBtn = edActions.append("button").attr("class", "btn btn-secondary btn-small").text("Save");
const closeDefBtn = edActions.append("button").attr("class", "btn btn-secondary btn-small").text("Close");

editBtn.on("click", () => {
  const open = editor.style("display") !== "none";
  editor.style("display", open ? "none" : "block");
});
closeDefBtn.on("click", () => editor.style("display", "none"));

saveDefBtn.on("click", () => {
  def2.label = String(eLabel.property("value") || key).trim() || key;
  def2.unit = String(eUnit.property("value") || "").trim();
  def2.description = String(eDesc.property("value") || "").trim();
  def2.defaultValue = safeNumber(eDefault.property("value"), 0);
  def2.min = safeNumber(eMin.property("value"), 0);
  def2.max = safeNumber(eMax.property("value"), 100);
  def2.step = safeNumber(eStep.property("value"), 1);

  // clamp current state into bounds
  const cur2 = safeNumber(state[key], def2.defaultValue);
  state[key] = Math.max(def2.min ?? cur2, Math.min(def2.max ?? cur2, cur2));

  renderEdgeVars(edge);
  updateGraph();
});

      const row = card.append("div").attr("class", "var-row");
      const r = row.append("input")
        .attr("type", "range")
        .attr("min", def2.min ?? 0)
        .attr("max", def2.max ?? 100)
        .attr("step", def2.step ?? 1)
        .attr("value", cur);

      r.on("input", (ev) => {
        const v = safeNumber(ev.target.value, 0);
        state[key] = v;
        right.text(String(v));
        updateGraph();
      });
    }
  }

  function showNodeEditor(node){
  if (!node) { nodeEditor.style("display","none"); return; }
  nodeEditor.style("display","block");
  nodeEditorTitle.text(`Selected: ${node.label}`);
  nodeEditorSubtitle.text(node.unit ? `(${node.unit})` : "—");

  const hasIncoming = (inDeg.get(node.id) || 0) > 0;
  if (hasIncoming){
    nodeBaselineLabel.text("Baseline (used by delta formulas)");
    nodeBaselineHint.text("Reference point for Δ (fromDelta). Computed values still come from incoming links.");
  } else {
    nodeBaselineLabel.text("Initial value (no incoming arrows)");
    nodeBaselineHint.text("Starting value for source nodes. If it is an Input, this also updates its slider default.");
  }

  // Populate baseline UI with current baseline
  const curBaseline = safeNumber(getBaseline(node.id), 0);
  if (nodeBaselineInput) nodeBaselineInput.value = String(curBaseline);
  if (nodeBaselineValueEl) nodeBaselineValueEl.textContent = String(curBaseline);

  // If a range slider exists in the HTML, configure it.
  if (nodeBaselineRange){
    // Prefer the node's own slider definition (for Input nodes). Otherwise, derive a sensible range.
    let min = 0, max = 200, step = 1;
    const orig = data.nodes.find(n => n.id === node.id);
    if (orig && orig.slider){
      min = safeNumber(orig.slider.min, 0);
      max = safeNumber(orig.slider.max, 100);
      step = safeNumber(orig.slider.step, 1);
    } else {
      // Derived range: if baseline is non-zero, use ±50%; otherwise 0..200.
      if (curBaseline !== 0){
        min = curBaseline * 0.5;
        max = curBaseline * 1.5;
        step = (max - min) / 200;
      }
    }
    // Clean up invalid ranges
    if (!(Number.isFinite(min) && Number.isFinite(max)) || min === max){
      min = 0; max = 200; step = 1;
    }
    if (!Number.isFinite(step) || step <= 0) step = 1;

    nodeBaselineRange.min = String(min);
    nodeBaselineRange.max = String(max);
    nodeBaselineRange.step = String(step);
    nodeBaselineRange.value = String(curBaseline);

    // Live update the display + number field, but keep committing on Apply (so accidental drags don't rewrite baselines).
    nodeBaselineRange.oninput = (ev) => {
      const v = safeNumber(ev.target.value, 0);
      if (nodeBaselineInput) nodeBaselineInput.value = String(v);
      if (nodeBaselineValueEl) nodeBaselineValueEl.textContent = String(v);
    };
  }

  applyNodeBaselineBtn.on("click", () => {
    // Commit whichever control is present
    const v = safeNumber(
      (nodeBaselineInput && nodeBaselineInput.value) || (nodeBaselineRange && nodeBaselineRange.value) || curBaseline,
      0
    );

    baselineMap.set(node.id, v);
    const orig = data.nodes.find(n => n.id === node.id);
    if (orig) orig.baseline = v;

    // If it's a true Input node (has slider), also align its slider default and current state.
    if (orig && orig.type === "Input" && orig.slider){
      orig.slider.default = v;
      inputState[node.id] = v;
      renderInputSliders();
    }

    // Keep UI in sync after committing
    if (nodeBaselineRange) nodeBaselineRange.value = String(v);
    if (nodeBaselineInput) nodeBaselineInput.value = String(v);
    if (nodeBaselineValueEl) nodeBaselineValueEl.textContent = String(v);
    updateGraph();
  });
}

  // --- Drawer -------------------------------------------------------------
  function showEdgeDetails(edge) {
    selectedEdgeId = edge.id;
    selectedNodeId = null;

    ensureEdgeStructures(edge);

    drawerTitle.text(`${edge.sourceLabel || edge.source} → ${edge.targetLabel || edge.target}`);
    drawerEdge.text(`${edge.sourceLabel || edge.source} → ${edge.targetLabel || edge.target}`);

    showNodeEditor(null);

    if (drawerFormulaEditor) drawerFormulaEditor.value = String(edge.formula || edge.displayFormula || "");

    // Machine readable compute
    const mode = (edge.compute && edge.compute.mode) ? edge.compute.mode : "direct";
    const uses = (edge.compute && Array.isArray(edge.compute.uses)) ? edge.compute.uses : [];
    drawerComputeMeta.text(`mode: ${mode} • uses: ${uses.length ? uses.join(", ") : "(none)"}`);
    drawerComputeExpr.text((edge.compute && edge.compute.expr) ? String(edge.compute.expr) : "0");

    if (computeExprEditor) computeExprEditor.value = (edge.compute && edge.compute.expr) ? String(edge.compute.expr) : "0";

    applyComputeExprBtn.on("click", () => {
      if (!computeExprEditor) return;
      edge.compute.expr = String(computeExprEditor.value || "0");
      drawerComputeExpr.text(edge.compute.expr);
      // Keep uses in sync (without forcing): show updated meta immediately
      const u = (edge.compute && Array.isArray(edge.compute.uses)) ? edge.compute.uses : [];
      drawerComputeMeta.text(`mode: ${mode} • uses: ${u.length ? u.join(", ") : "(none)"}`);
      updateGraph();
    });

    syncUsesBtn.on("click", () => {
      syncUsesFromEditor(edge);
      drawerComputeMeta.text(`mode: ${mode} • uses: ${edge.compute.uses.length ? edge.compute.uses.join(", ") : "(none)"}`);
    });
    
applyEdgeMetaBtn.on("click", () => {
  if (drawerFormulaEditor) edge.formula = String(drawerFormulaEditor.value || "").trim();
  if (drawerExplanationEditor) edge.explanation = String(drawerExplanationEditor.value || "").trim();
  if (drawerSourcesEditor){
    const lines = String(drawerSourcesEditor.value || "")
      .split(/\r?\n/)
      .map(s => s.trim())
      .filter(Boolean);
    edge.sources = lines;
  }
  updateGraph();
});
if (drawerExplanationEditor) drawerExplanationEditor.value = String(edge.explanation || "");

    if (drawerSourcesEditor) drawerSourcesEditor.value = (Array.isArray(edge.sources) ? edge.sources : []).join("\n");
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

        showNodeEditor(d);

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
      showNodeEditor(null);
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

  function exportModel() {
    // Export the entire edited model + current runtime values.
    const out = structuredClone(data);
    out.runtime = {
      inputState: structuredClone(inputState),
      edgeParamState: structuredClone(edgeParamState),
      selectedEdgeId,
      selectedNodeId,
    };

    // Clean up positions if not present
    for (const n of out.nodes) {
      if (typeof n.x !== "number" || typeof n.y !== "number") {
        delete n.x;
        delete n.y;
      }
    }
    downloadText("model.edited.json", JSON.stringify(out, null, 2));
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
    const res = await fetch("./data_new.json", { cache: "no-store" });
    data = await res.json();

    
    baselineMap = new Map(
      data.nodes.map(n => [
        n.id,
        safeNumber(
          n.baseline,
          (n.slider && n.slider.default !== undefined) ? n.slider.default : 0
        )
      ])
    );
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
    exportModelBtn.on("click", exportModel);
    
    if (pushBackendBtn && !pushBackendBtn.empty()) pushBackendBtn.on("click", () => pushModelToBackend());
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
