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

All edits are applied live and stored in the model JSON.

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
- Optional **Push to backend** for saving models
- JSON is reusable and version-controllable

---

## Project Structure

```text
Dashboard/
├─ index_positions_v3.html        # Main UI
├─ graph_positions_v3_fixed2.js   # Core dashboard logic
├─ style_positions_v3_fixed2.css  # Styling
├─ d3.v7.min.js                   # D3.js dependency
├─ data_with_positions_v3.json    # Example causal model
