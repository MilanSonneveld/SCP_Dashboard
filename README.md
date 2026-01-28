# SCP Dashboard – Causal Relationship Modeling Tool

An interactive, browser-based dashboard for **building, editing, and quantifying causal models** using directed graphs.

This project bridges **conceptual causal diagrams** (e.g. Miro boards) and **computable causal models**, allowing users to transparently define assumptions, formulas, and parameters directly in an interactive interface.

---

## Key Features

### Interactive causal graph
- Nodes represent variables (inputs, intermediates, outcomes)
- Directed edges represent causal relationships
- Click a **node** to edit its initial value or baseline
- Click an **edge** to edit its formula, explanation, sources, and parameters

### Editable causal quantification
For each causal link you can edit:
- **Human-readable formula**
- **Machine-readable formula** (JavaScript expression)
- **Explanation** (assumptions, scope, interpretation)
- **Sources** (papers, reports, URLs)

After all edits are done, the whole model can be saved and exported.

### Parameters & uncertainty
- Edge-scoped parameters (e.g. β, elasticities, scaling factors)
- Adjustable via sliders
- Parameters can be:
  - added manually
  - auto-generated from formulas via **Sync variables**
- Each parameter supports unit, range, default value, and description

### Layout control
- Drag nodes to match conceptual layouts (e.g. Miro)
- Export / import node positions
- Clear layout to revert to force layout
- Export graph as SVG

### Model persistence
- Export the entire model as JSON
- JSON is reusable and version-controllable

---

## Project Structure

```text
Dashboard/
├─ index_positions_v3.html        # Main UI
├─ graph_positions_v3_fixed2.js   # Core dashboard logic
├─ style_positions_v3_fixed2.css  # Styling
├─ d3.v7.min.js                   # D3.js dependency
├─ data_with_positions_v3.json    # Data
```

---

## Running the model

The dashboard evaluates the causal model **locally in the browser**.  
All calculations are deterministic and update immediately when inputs, parameters, or formulas are changed.

### How the model is evaluated

1. **Input nodes**  
   Nodes without incoming edges (typically *Input* nodes) take their value directly from:
   - their initial value / slider value, or
   - their baseline value if no slider is defined.

2. **Intermediate and output nodes**  
   Nodes with incoming edges are computed as the **sum of all incoming causal effects**.  
   Each incoming edge contributes a value based on its machine-readable formula.

3. **Causal propagation**
   - Changes to an input node propagate downstream through the graph
   - Parameters and formulas are evaluated edge-by-edge
   - The graph updates in real time as values change

4. **Baselines and deltas**
   - For nodes with incoming edges, the baseline represents a **reference state**
   - Delta-based formulas can compute changes relative to this baseline

The model does **not** assume equilibrium, optimization, or probabilistic behavior.  
It is intended for **transparent, exploratory causal reasoning**, not black-box prediction.

---

### What “running the model” means in practice

There is no separate “run” button.

The model is continuously evaluated when you:
- move an input slider
- change a parameter value
- edit a machine-readable formula
- update a node baseline

This design supports rapid experimentation and inspection of assumptions.

---

## Running the dashboard and the model

The SCP Dashboard is a **static, browser-based application**.  
It runs entirely in your web browser, but it **must be served via a local web server** so that data files (JSON) can be loaded correctly.

---

### Prerequisites
- Python 3.x installed on your system
- A modern web browser (Chrome, Firefox, Edge)

---

### Step-by-step: starting the dashboard

1. Open a terminal (Command Prompt, PowerShell, or Terminal)
2. Navigate to the folder that contains the dashboard files  
   (for example, the `Dashboard/` folder)

```bash
cd Dashboard

3. Start a local web server using python: python -m http.server
4. Open a browser and navigate to: http://localhost:8000
