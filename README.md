# Spacecraft Anomaly Explorer (CIS4930 Assignment 2)

Four linked D3 views over spacecraft telemetry events (ESA-ADB), served by a FastAPI backend.

```
Murgia_Michael_A2/
├── backend/    FastAPI app, prep_data.py, telemetry.py, data/ (events.csv, source.json)
└── frontend/   index.html, css/, js/script.js, js/vendor/d3.min.js (D3 v7.9.0, bundled)
```

## Run (two terminals)

Backend, port 8000:
```bash
cd backend
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```
Frontend, port 5173:
```bash
cd frontend
python3 -m http.server 5173
```
Open http://localhost:5173. API docs: http://localhost:8000/docs.
The API base URL is the one constant `API` at the top of `frontend/js/script.js`.
No credentials or required environment variables.

## Data

`backend/data/events.csv` holds the 644 labeled events of ESA-ADB Mission 2 (labels, anomaly types, channel/subsystem metadata, and two features computed from the telemetry: variance ratio and frozen share). The raw telemetry (several GB) is not included.

To rebuild from the original dataset:

    cd backend
    python prep_data.py /path/to/ESA-ADB/ESA-Mission2
    # PowerShell:  $env:ESA_ROOT = (Resolve-Path .\data).Path ; python -m uvicorn main:app --port 8000

Data source: ESA Anomaly Detection Benchmark (ESA-ADB), <add the citation and licence from the dataset page>.

## Hosted version (GitHub Pages)

Live site: [<your github.io URL>](https://mikemurgia.github.io/CIS4930-A2/). GitHub Pages cannot run FastAPI, so the hosted site is a static export: the same JSON the API returns, saved under `frontend/api/` (meta, events, and the downsampled signals for every event). The page switches to those files automatically on `github.io` (or with `?static` in the URL). The live FastAPI backend is in `backend/` and is what runs on localhost.

## Views and coordination

| Panel | View | In-view interaction |
|---|---|---|
| A | Parallel coordinates of event features | axis brushes (filters), line tooltips and click-to-select |
| B | Overview strip + detail scatter (time vs channels touched) | time brush, tooltips, click-to-select |
| C | Linked signals for the selected event | crosshair with values, shaded labeled window, detector alarm |
| D | Subsystem heatmap | cell tooltips, animated share changes |

- **Pair 1: A to B and D.** Brushing a feature axis filters: non-matching events fade in B (overview and detail) and are excluded from D's shares.
- **Pair 2: B to D (and C).** Brushing the overview strip sets the time window: the detail view rescales to it and D re-aggregates over that window. Clicking an event (in B, or a line in A) fills panel C via the server and adds a "selected" row to D.

All state lives in one object `S` (`mission`, `filt`, `dom`, `sel`). Selection is shown as chips plus a live count; "Clear all selections" resets everything. Filtering and brushing run on the client; the server is called for a mission's events and for signals.

## Endpoints

| Endpoint | Purpose |
|---|---|
| `GET /api/meta` | data source, missions, available feature dimensions |
| `GET /api/events?mission=` | one slim row per event (a few thousand at most) |
| `GET /api/event/{id}/signals?channels=3&points=240` | server-side: slice a window around the event, downsample, run a baseline detector (z-score + flatline) |
