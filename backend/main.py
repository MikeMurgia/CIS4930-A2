"""Backend for the Spacecraft Anomaly Explorer.

Run:  uvicorn main:app --reload --port 8000     (docs at /docs)
Env:  ESA_ROOT=/path/to/ESA-ADB   (optional; lets /api/event/{id}/signals read real telemetry)
"""
import json
import os
import zlib
from pathlib import Path

import pandas as pd
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

import prep_data
import telemetry

DATA = Path(__file__).parent / "data"
if not (DATA / "events.csv").exists():  # always start, even before real data is prepared
    DATA.mkdir(exist_ok=True)
    prep_data.synthetic().to_csv(DATA / "events.csv", index=False)
    (DATA / "source.json").write_text(json.dumps({"source": "synthetic"}))

SOURCE = json.loads((DATA / "source.json").read_text()) if (DATA / "source.json").exists() else {"source": "synthetic"}
ESA_ROOT = os.environ.get("ESA_ROOT") or SOURCE.get("root")

df = pd.read_csv(DATA / "events.csv", parse_dates=["start", "end"])
df["subsystems"] = df["subsystems"].fillna("")
df["channels"] = df["channels"].fillna("")
by_id = df.set_index("id")

FEATURES = [
    {"k": "duration_h", "n": "duration (h)", "log": True},
    {"k": "n_channels", "n": "channels touched", "log": False},
    {"k": "var_ratio", "n": "variance ratio", "log": False},
    {"k": "flat_share", "n": "frozen share", "log": False},
]

app = FastAPI(title="Spacecraft Anomaly Explorer")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


def iso(t):
    return pd.Timestamp(t).strftime("%Y-%m-%dT%H:%M:%S")


@app.get("/api/meta")
def meta():
    feats = [f for f in FEATURES if df[f["k"]].notna().any()]
    return {
        "source": SOURCE["source"],
        "missions": sorted(int(m) for m in df["mission"].unique()),
        "features": feats,
        "counts": df.groupby("mission").size().to_dict(),
    }


@app.get("/api/events")
def events(mission: int):
    """One slim row per event for a mission; brushing/filtering then happens client-side."""
    out = df[df["mission"] == mission]
    rows = []
    for r in out.itertuples():
        d = {"id": r.id, "category": r.category, "type": r.type, "start": iso(r.start), "end": iso(r.end),
             "duration_h": round(r.duration_h, 3), "n_channels": int(r.n_channels),
             "subsystems": [s for s in r.subsystems.split("|") if s],
             "dimensionality": r.dimensionality, "locality": r.locality}
        for k in ("var_ratio", "flat_share"):
            v = getattr(r, k)
            d[k] = None if pd.isna(v) else round(float(v), 4)
        rows.append(d)
    return {"mission": mission, "events": rows}


@app.get("/api/event/{event_id}/signals")
def signals(event_id: str, channels: int = 3, points: int = 240):
    """Server-side computation: pull a window around the event, downsample, run the baseline detector."""
    if event_id not in by_id.index:
        raise HTTPException(404, "unknown event")
    e = by_id.loc[event_id]
    names = [c for c in e["channels"].split("|") if c][:channels] or ["channel"]
    pad = max(e["end"] - e["start"], pd.Timedelta(hours=1))
    t0, t1 = e["start"] - pad, e["end"] + pad

    real = []
    if ESA_ROOT:
        for ch in names:
            p = telemetry.find_channel_file(ESA_ROOT, int(e["mission"]), ch)
            if p is None:
                continue
            try:
                ds = telemetry.downsample(telemetry.load_series(str(p)), t0, t1, points)
            except Exception:
                ds = None
            if ds:
                real.append((ch, ds))
    if real and len(real) == len(names):
        times = real[0][1][0]
        series = []
        for _, (tt, vv) in real:
            series.append(pd.Series(vv, index=tt).reindex(times, method="nearest").tolist())
        synthetic = False
        window = (e["start"], e["end"])
    else:
        times, series, window = telemetry.synth_signals(e["start"], e["end"], names, e["type"], zlib.crc32(event_id.encode()), points)
        synthetic = True
    a_idx = next((i for i, t in enumerate(times) if t >= window[0]), len(times) // 3)
    alarm = telemetry.baseline_alarm(times, series, a_idx)
    return {
        "synthetic": synthetic,
        "times": [iso(t) for t in times],
        "channels": [{"name": n, "values": v} for n, v in zip(names, series)],
        "window": [iso(window[0]), iso(window[1])],
        "alarm": iso(alarm) if alarm is not None else None,
    }
