"""Build data/events.csv (one row per event) and data/source.json.

  python prep_data.py                              # synthetic demo data
  python prep_data.py /path/to/ESA-ADB [--no-features]   # real ESA-ADB

Columns: id, mission, category, type, start, end, duration_h, n_channels,
         subsystems (|-joined), channels (|-joined), dimensionality, locality,
         var_ratio, flat_share   (last two are empty if telemetry was not read)

The ESA-ADB path is written from memory of the dataset layout (per mission:
labels.csv [ID, Channel, StartTime, EndTime], anomaly_types.csv [ID, Category,
Dimensionality, Locality, ...], channels.csv [Channel, Subsystem, ...]) and has
NOT been run against the real files. Column names are matched case-insensitively and
the columns found are printed, so mismatches are easy to fix in `esa()`.
"""
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

import telemetry

OUT = Path(__file__).parent / "data"
COLS = ["id", "mission", "category", "type", "start", "end", "duration_h", "n_channels",
        "subsystems", "channels", "dimensionality", "locality", "var_ratio", "flat_share"]


def synthetic() -> pd.DataFrame:
    rng = np.random.default_rng(7)
    subs = ["Power", "Thermal", "Attitude", "Comms", "Payload", "Propulsion"]
    cfg = {1: ("2015-01-01", 36, 800, 45), 2: ("2018-06-01", 30, 450, 25)}
    rows, n = [], 0
    for mission, (start, months, count, n_anom) in cfg.items():
        t0 = pd.Timestamp(start)
        span_h = months * 30.4 * 24
        anom_idx = set(rng.choice(count, n_anom, replace=False).tolist())
        centers = rng.uniform(0.1, 0.9, 4)
        for i in range(count):
            anom = i in anom_idx
            hard = anom and rng.random() < 0.25
            if anom:
                typ = rng.choice(["freeze", "drift", "spike"], p=[0.58, 0.26, 0.16])
                cat = "Anomaly"
            else:
                typ = "gap" if rng.random() < 0.12 else "rare"
                cat = "Communication Gap" if typ == "gap" else "Rare Event"
            frac = rng.random() if rng.random() < 0.55 else np.clip(rng.choice(centers) + rng.normal(0, 0.03), 0, 0.999)
            s = t0 + pd.Timedelta(hours=float(frac * span_h))
            dur = float(np.exp(np.log(14 if anom and not hard else 5) + 0.65 * rng.standard_normal()))
            nch = int(np.clip(7 + 3 * rng.standard_normal() if anom and not hard else 19 + 8 * rng.standard_normal(), 2, 41))
            if anom and not hard:
                k, w = 1 + rng.integers(0, 2), np.array([3, 1, 3, 1, 1, 1], float)
            else:
                k, w = 3 + rng.integers(0, 4), np.ones(6)
            sub_idx = rng.choice(6, int(k), replace=False, p=w / w.sum())
            vr = (0.1 + rng.random() * 0.8 if typ == "freeze" else 1 + rng.random() * 1.5 if typ == "drift" else 3.5 + rng.random() * 2) \
                if anom and not hard else float(np.clip(3.2 + 1.2 * rng.standard_normal(), 0.5, 7))
            flat = 0.5 + rng.random() * 0.5 if anom and not hard and typ == "freeze" else (rng.random() * 0.08 if rng.random() < 0.9 else rng.random() * 0.3)
            n += 1
            rows.append(dict(
                id=f"m{mission}_{n}", mission=mission, category=cat, type=typ,
                start=s, end=s + pd.Timedelta(hours=dur), duration_h=dur, n_channels=nch,
                subsystems="|".join(subs[j] for j in sorted(sub_idx)),
                channels="|".join(f"channel_{c}" for c in sorted(rng.choice(60, nch, replace=False))),
                dimensionality="Multivariate" if nch > 1 else "Univariate",
                locality=str(rng.choice(["Local", "Global"])), var_ratio=vr, flat_share=flat))
    return pd.DataFrame(rows)[COLS]


def _lower(df):
    df = df.copy()
    df.columns = [str(c).strip().lower().replace(" ", "_") for c in df.columns]
    return df


def resolve_root(p: Path):
    """Accept either the dataset root (contains ESA-Mission1..) or a single ESA-MissionN folder.
    Returns (mission_dirs, root) where root is the folder that contains the mission folders."""
    p = Path(p).resolve()
    if p.name.startswith("ESA-Mission"):
        return [p], p.parent
    dirs = sorted(p.glob("ESA-Mission*"))
    if not dirs:
        raise SystemExit(f"No ESA-Mission* folders found in {p}. Pass the dataset root or one ESA-MissionN folder.")
    return dirs, p


def esa(root: Path, features: bool = True) -> pd.DataFrame:
    frames = []
    mdirs, root = resolve_root(root)
    for mdir in mdirs:
        mission = int(mdir.name.replace("ESA-Mission", ""))
        lab = _lower(pd.read_csv(mdir / "labels.csv"))
        typ = _lower(pd.read_csv(mdir / "anomaly_types.csv"))
        chn = _lower(pd.read_csv(mdir / "channels.csv"))
        print(mdir.name, "| labels:", list(lab.columns), "| types:", list(typ.columns), "| channels:", list(chn.columns))
        sub_col = "subsystem" if "subsystem" in chn.columns else ("group" if "group" in chn.columns else None)
        sub_of = dict(zip(chn["channel"], chn[sub_col])) if sub_col else {}
        lab["start"] = pd.to_datetime(lab["starttime"], utc=True).dt.tz_localize(None)
        lab["end"] = pd.to_datetime(lab["endtime"], utc=True).dt.tz_localize(None)
        lab["subsystem"] = lab["channel"].map(sub_of).fillna("unknown")
        g = lab.groupby("id").agg(start=("start", "min"), end=("end", "max"),
                                  channels=("channel", lambda s: "|".join(sorted(set(s.astype(str))))),
                                  subsystems=("subsystem", lambda s: "|".join(sorted(set(s.astype(str))))),
                                  n_channels=("channel", "nunique")).reset_index()
        keep = [c for c in ("id", "category", "subclass", "class", "dimensionality", "locality") if c in typ.columns]
        g = g.merge(typ[keep].drop_duplicates("id"), on="id", how="left")
        g["mission"] = mission
        g["id"] = f"m{mission}_" + g["id"].astype(str)
        g["category"] = g.get("category", pd.Series("Unknown", index=g.index)).fillna("Unknown")
        g["type"] = g["subclass"] if "subclass" in g else g.get("class", "unknown")
        g["dimensionality"] = g.get("dimensionality", pd.Series("Unknown", index=g.index)).fillna("Unknown")
        g["locality"] = g.get("locality", pd.Series("Unknown", index=g.index)).fillna("Unknown")
        g["duration_h"] = (g["end"] - g["start"]).dt.total_seconds() / 3600
        g["var_ratio"] = np.nan
        g["flat_share"] = np.nan
        if features:
            add_features(root, mission, g)
        frames.append(g.reindex(columns=COLS))
    return pd.concat(frames, ignore_index=True)


def add_features(root, mission, g):
    """variance ratio (window vs preceding baseline) and frozen share (identical consecutive
    samples) per event, averaged over up to 3 of its channels. Needs the telemetry files."""
    acc = {i: {"vr": [], "fl": []} for i in g.index}
    by_channel = {}
    for i, row in g.iterrows():
        for ch in row["channels"].split("|")[:3]:
            by_channel.setdefault(ch, []).append(i)
    found = 0
    for n, (ch, idxs) in enumerate(by_channel.items(), 1):
        p = telemetry.find_channel_file(root, mission, ch)
        if p is None:
            continue
        try:
            s = telemetry.load_series(str(p))
        except Exception as e:  # keep going; report once per channel
            print("  could not read", p.name, "->", repr(e))
            continue
        found += 1
        for i in idxs:
            st, en = g.at[i, "start"], g.at[i, "end"]
            w = s.loc[st:en]
            b = s.loc[st - 3 * (en - st):st]
            if len(w) < 3 or len(b) < 3 or b.var() == 0:
                continue
            acc[i]["vr"].append(float(w.var() / b.var()))
            acc[i]["fl"].append(float((w.diff().dropna() == 0).mean()))
        telemetry.load_series.cache_clear()  
        print(f"  features: {n}/{len(by_channel)} channels ({ch})")
    print(f"  Mission {mission}: telemetry read for {found}/{len(by_channel)} channels")
    for i, a in acc.items():
        if a["vr"]:
            g.at[i, "var_ratio"] = float(np.clip(np.mean(a["vr"]), 0, 50))
            g.at[i, "flat_share"] = float(np.mean(a["fl"]))


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    OUT.mkdir(exist_ok=True)
    if args:
        df = esa(Path(args[0]), features="--no-features" not in sys.argv)
        src = {"source": "esa-adb", "root": str(resolve_root(Path(args[0]))[1])}
    else:
        df = synthetic()
        src = {"source": "synthetic"}
    df.to_csv(OUT / "events.csv", index=False)
    (OUT / "source.json").write_text(json.dumps(src))
    print(f"wrote {len(df)} events ({src['source']}) to {OUT / 'events.csv'}")