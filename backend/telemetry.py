"""Telemetry helpers: loading ESA-ADB channel files, synthetic signals, a baseline detector.

The ESA-ADB file reader is written from memory of the dataset layout and has NOT been
run against the real files. It tries zip / parquet / pickle / csv and guesses the time
and value columns. If it fails on your files, fix `load_series` -- everything else
depends only on it returning a pandas Series indexed by datetime.
"""
import io
import zipfile
from functools import lru_cache
from pathlib import Path

import numpy as np
import pandas as pd

EXTS = {".zip", ".parquet", ".pkl", ".pickle", ".csv"}


@lru_cache(maxsize=8)
def channel_index(mission_dir: str) -> dict:
    """stem -> path for every candidate telemetry file under a mission folder."""
    idx = {}
    for p in Path(mission_dir).rglob("*"):
        if p.is_file() and p.suffix.lower() in EXTS and p.stem.lower().startswith("channel"):
            idx.setdefault(p.stem.lower(), p)
    return idx


def find_channel_file(root, mission, channel):
    mdir = Path(root) / f"ESA-Mission{mission}"
    if not mdir.exists():
        return None
    return channel_index(str(mdir)).get(str(channel).lower())


def _read_bytes(name: str, raw: bytes):
    """Decode a telemetry file by extension if it has one, else by trying pickle, parquet, csv."""
    suffix = Path(name).suffix.lower()
    order = {".parquet": ["parquet"], ".csv": ["csv"], ".pkl": ["pickle"], ".pickle": ["pickle"]}.get(
        suffix, ["pickle", "parquet", "csv"])
    errors = []
    for kind in order:
        try:
            buf = io.BytesIO(raw)
            if kind == "pickle":
                return pd.read_pickle(buf)
            if kind == "parquet":
                return pd.read_parquet(buf)
            return pd.read_csv(buf)
        except Exception as e:
            errors.append(f"{kind}: {type(e).__name__}: {e}")
    raise ValueError(f"could not decode {name} ({'; '.join(errors)})")


@lru_cache(maxsize=3)
def load_series(path: str) -> pd.Series:
    p = Path(path)
    if p.suffix.lower() == ".zip":
        with zipfile.ZipFile(p) as z:
            names = [n for n in z.namelist() if not n.endswith("/")]
            if not names:
                raise ValueError(f"{p.name} is an empty zip")
            df = _read_bytes(names[0], z.read(names[0]))
    else:
        df = _read_bytes(p.name, p.read_bytes())
    if isinstance(df, pd.Series):
        df = df.to_frame("value")
    if not isinstance(df.index, pd.DatetimeIndex):
        tcols = [c for c in df.columns if "time" in str(c).lower() or "date" in str(c).lower()]
        tcol = tcols[0] if tcols else df.columns[0]
        df = df.set_index(pd.to_datetime(df[tcol], utc=True)).drop(columns=[tcol])
    idx = df.index
    if idx.tz is not None:
        idx = idx.tz_convert("UTC").tz_localize(None)
    num = df.select_dtypes("number")
    s = pd.Series(num.iloc[:, 0].to_numpy(dtype=float), index=idx).sort_index()
    return s[~s.index.duplicated()]


def downsample(s: pd.Series, t0, t1, n=240):
    w = s.loc[t0:t1]
    if len(w) < 4:
        return None
    parts = np.array_split(np.arange(len(w)), min(n, len(w)))
    vals = [float(np.nanmean(w.to_numpy()[ix])) for ix in parts]
    times = [w.index[ix[len(ix) // 2]] for ix in parts]
    return times, vals


def synth_signals(start, end, names, typ, seed, n=240):
    pad = max(end - start, pd.Timedelta(hours=1))
    times = list(pd.date_range(start - pad, end + pad, periods=n))
    a, b = n // 3, 2 * n // 3
    rng = np.random.default_rng(seed)
    series = []
    for k, name in enumerate(names):
        v = 0.6 * np.sin(np.arange(n) * 0.12 + k) + 0.25 * rng.standard_normal(n)
        L = b - a
        if typ == "freeze":
            v[a:b] = v[a - 1]
        elif typ == "drift":
            v[a:b] += np.linspace(0, 3, L) * (-1 if k == 1 else 1)
        elif typ == "spike":
            v[a + 10 + 4 * k] += 4
        else:
            v[a:b] += (1.8 + 0.5 * k) * np.sin(np.arange(L) * 0.9 + k)
        series.append(v.tolist())
    return times, series, (times[a], times[b - 1])


def baseline_alarm(times, series, a_idx):
    """First sample at/after the labeled window start where |z| > 4 against the
    pre-window baseline, or where a channel is perfectly flat for 8 samples."""
    for i in range(max(a_idx, 8), len(times)):
        for v in series:
            base = np.asarray(v[:max(a_idx, 8)])
            sd = base.std() or 1.0
            if abs(v[i] - base.mean()) / sd > 4:
                return times[i]
            if i >= 8 and np.ptp(v[i - 8:i + 1]) == 0:
                return times[i]
    return None