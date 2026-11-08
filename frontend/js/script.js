// Spacecraft Anomaly Explorer. One shared state object S; every view re-renders from it.
const API = "http://localhost:8000"; // single constant: point this at a deployed backend

const S = { mission: null, filt: {}, dom: null, sel: null };
let META, EV = [], SUBS = [], DIMS = [];
let parBrushes = [], timeBrush = null, timeBrushG = null;

const $ = (id) => document.getElementById(id);
const CAT_COL = { "Anomaly": "var(--accent)", "Rare Event": "var(--rare)", "Communication Gap": "var(--cool)" };
const catCol = (c) => CAT_COL[c] || "var(--muted)";
const isAnom = (e) => e.category === "Anomaly";
const fmtDate = d3.timeFormat("%b %d, %Y");
const fmtTime = d3.timeFormat("%b %d %H:%M");
const fmtNum = (v) => (Math.abs(v) >= 100 ? d3.format(",.0f")(v) : d3.format(".3~g")(v));

// ---------- state predicates ----------
const pass = (e) => DIMS.every((d) => {
  const f = S.filt[d.k];
  if (!f) return true;
  const v = e[d.k];
  return v != null && v >= f[0] && v <= f[1];
});
const inWin = (e) => S.dom == null || (e.end >= S.dom[0] && e.start <= S.dom[1]);
const active = (e) => pass(e) && inWin(e);

// ---------- tooltip ----------
const tip = $("tip");
function showTip(ev, html) {
  tip.hidden = false; tip.innerHTML = html;
  const pad = 12, w = tip.offsetWidth, h = tip.offsetHeight;
  let x = ev.clientX + pad, y = ev.clientY + pad;
  if (x + w > innerWidth - 8) x = ev.clientX - w - pad;   // flip near the right edge
  if (y + h > innerHeight - 8) y = ev.clientY - h - pad;  // and the bottom edge
  tip.style.left = x + "px"; tip.style.top = y + "px";
}
const hideTip = () => { tip.hidden = true; };
const evHtml = (e) => `<b>${e.id}</b> &middot; ${e.category}${e.type ? " (" + e.type + ")" : ""}<br>${fmtTime(e.start)}<br>` +
  `${fmtNum(e.duration_h)} h &middot; ${e.n_channels} channels<br>${e.subsystems.join(", ")}`;

function emptyMsg(svg, W, H, msg) {
  svg.append("text").attr("class", "empty").attr("x", W / 2).attr("y", H / 2).attr("text-anchor", "middle").text(msg);
}

// ---------- boot ----------
async function boot() {
  try {
    META = await (await fetch(API + "/api/meta")).json();
  } catch (e) {
    $("status").textContent = "Cannot reach the backend at " + API + ". Start it first (see README).";
    return;
  }
  if (META.source === "synthetic") {
    $("banner").hidden = false;
    $("banner").textContent = "Demo data: events and signals are synthetic, not ESA-ADB. Nothing shown here is a result.";
  }
  const sel = $("mission");
  sel.innerHTML = META.missions.map((m) => `<option value="${m}">Mission ${m}</option>`).join("");
  sel.onchange = () => loadMission(+sel.value);
  $("clear").onclick = clearAll;
  await loadMission(META.missions[0]);
}

async function loadMission(m) {
  $("status").textContent = "Loading mission " + m + "…";
  let res;
  try { res = await (await fetch(`${API}/api/events?mission=${m}`)).json(); }
  catch (e) { $("status").textContent = "Backend request failed."; return; }
  S.mission = m; S.filt = {}; S.dom = null; S.sel = null;
  EV = res.events.map((e) => ({ ...e, start: new Date(e.start), end: new Date(e.end) }));
  SUBS = [...new Set(EV.flatMap((e) => e.subsystems))].sort();
  DIMS = META.features.filter((f) => EV.some((e) => e[f.k] != null));
  const cats = [...new Set(EV.map((e) => e.category))];
  $("leg-cat").innerHTML = cats.map((c) => `<span><i class="sw" style="background:${catCol(c)}"></i>${c}</span>`).join("");
  drawPar(); drawTimeScaffold(); drawSignalsEmpty("Click an event in panel B.");
  refresh();
}

function clearAll() {
  S.filt = {}; S.dom = null; S.sel = null;
  parBrushes.forEach((b) => b.g.call(b.brush.move, null));   // programmatic: handlers ignore it
  if (timeBrushG) timeBrushG.call(timeBrush.move, null);
  drawSignalsEmpty("Click an event in panel B.");
  refresh();
}

// ---------- A: parallel coordinates (source of pair 1) ----------
let parLines;
function drawPar() {
  const W = 1000, H = 220, m = { l: 80, r: 80, t: 36, b: 16 };
  const svg = d3.select("#par").attr("viewBox", `0 0 ${W} ${H}`);
  svg.selectAll("*").remove(); parBrushes = [];
  if (!EV.length) { emptyMsg(svg, W, H, "No events for this mission."); return; }
  const x = d3.scalePoint(DIMS.map((d) => d.k), [m.l, W - m.r]);
  DIMS.forEach((d) => {
    const vals = EV.map((e) => e[d.k]).filter((v) => v != null);
    const hi = d3.max(vals);
    d.y = (d.log ? d3.scaleLog().domain([Math.max(0.01, d3.min(vals)), hi]) : d3.scaleLinear().domain([0, hi]).nice())
      .range([H - m.b, m.t]).clamp(true);
  });
  const stride = Math.max(1, Math.ceil(EV.filter((e) => !isAnom(e)).length / 220));
  let k = 0;
  const sample = EV.filter((e) => isAnom(e) || (k++ % stride === 0));
  const line = d3.line().defined((p) => p[1] != null);
  parLines = svg.append("g").selectAll("path").data(sample, (e) => e.id).join("path")
    .attr("d", (e) => line(DIMS.map((d) => [x(d.k), e[d.k] == null ? null : d.y(e[d.k])])))
    .style("fill", "none").style("cursor", "pointer")
    .on("mousemove", (ev, e) => showTip(ev, evHtml(e))).on("mouseleave", hideTip)
    .on("click", (ev, e) => selectEvent(e));
  parLines.sort((a, b) => isAnom(a) - isAnom(b));
  DIMS.forEach((d) => {
    const g = svg.append("g").attr("transform", `translate(${x(d.k)},0)`);
    g.append("line").attr("y1", m.t).attr("y2", H - m.b).style("stroke", "var(--line)");
    g.append("text").attr("y", 18).attr("text-anchor", "middle").attr("class", "strong").text(d.n);
    (d.log ? [1, 10, 100].filter((t) => t >= d.y.domain()[0] && t <= d.y.domain()[1]) : d.y.ticks(3))
      .forEach((t) => g.append("text").attr("x", -8).attr("y", d.y(t) + 4).attr("text-anchor", "end").text(fmtNum(t)));
    const brush = d3.brushY().extent([[-9, m.t], [9, H - m.b]]).on("brush end", (ev) => {
      if (!ev.sourceEvent) return;
      if (ev.selection) S.filt[d.k] = ev.selection.map(d.y.invert).sort((a, b) => a - b);
      else delete S.filt[d.k];
      refresh();
    });
    const bg = g.append("g").call(brush);
    parBrushes.push({ g: bg, brush });
  });
}

// ---------- B: timeline overview + detail (source of pair 2) ----------
const TL = { W: 1000, m: { l: 48, r: 16 }, OVH: 54, DY: 100, DH: 150, H: 316 };
let ox, detailG, ticks;
function drawTimeScaffold() {
  const { W, m, OVH, DY, DH, H } = TL;
  const svg = d3.select("#time").attr("viewBox", `0 0 ${W} ${H}`);
  svg.selectAll("*").remove();
  detailG = null; timeBrushG = null;
  if (!EV.length) { emptyMsg(svg, W, H, "No events for this mission."); return; }
  const lo = d3.min(EV, (e) => e.start), hi = d3.max(EV, (e) => e.end);
  ox = d3.scaleTime([lo, hi], [m.l, W - m.r]);
  const ov = svg.append("g").attr("transform", "translate(0,8)");
  ov.append("line").attr("x1", m.l).attr("x2", W - m.r).attr("y1", OVH).attr("y2", OVH).style("stroke", "var(--line)");
  ticks = ov.selectAll("line.t").data(EV, (e) => e.id).join("line").attr("class", "t")
    .attr("x1", (e) => ox(e.start)).attr("x2", (e) => ox(e.start)).attr("y1", OVH).attr("y2", (e) => OVH - (isAnom(e) ? 44 : 14))
    .style("stroke", (e) => catCol(e.category)).style("stroke-width", (e) => (isAnom(e) ? 2 : 1));
  ov.append("g").attr("transform", `translate(0,${OVH})`).call(d3.axisBottom(ox).ticks(8)).call(styleAxis);
  timeBrush = d3.brushX().extent([[m.l, 0], [W - m.r, OVH]]).on("brush end", (ev) => {
    if (!ev.sourceEvent) return;
    S.dom = ev.selection ? ev.selection.map(ox.invert) : null;
    refresh();
  });
  timeBrushG = ov.append("g").call(timeBrush);
  detailG = svg.append("g").attr("transform", `translate(0,${DY})`);
}

function styleAxis(g) {
  g.selectAll("path,line").style("stroke", "var(--line)");
  g.selectAll("text").style("fill", "var(--muted)").style("font", "11px var(--mono)");
}

function drawDetail() {
  const { W, m, DH } = TL;
  if (!detailG) return [];
  const dom = S.dom || ox.domain();
  const dx = d3.scaleTime(dom, [m.l, W - m.r]);
  const maxCh = Math.max(2, d3.max(EV, (e) => e.n_channels));
  const dy = d3.scaleLinear([0, maxCh], [DH - 24, 8]).nice();
  const data = EV.filter(inWin).sort((a, b) => pass(a) - pass(b) || isAnom(a) - isAnom(b));
  detailG.selectAll(".ax, .empty, .lbl").remove();
  detailG.append("g").attr("class", "ax").attr("transform", `translate(0,${DH - 24})`).call(d3.axisBottom(dx).ticks(8)).call(styleAxis);
  detailG.append("g").attr("class", "ax").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(dy).ticks(4)).call(styleAxis);
  detailG.append("text").attr("class", "lbl").attr("transform", "rotate(-90)").attr("x", -(DH - 24) / 2).attr("y", 10).attr("text-anchor", "middle").text("channels touched");
  detailG.append("text").attr("class", "lbl").attr("x", (m.l + W - m.r) / 2).attr("y", DH + 10).attr("text-anchor", "middle")
    .text(`event start time · ${fmtDate(dom[0])} to ${fmtDate(dom[1])}`);
  detailG.selectAll("circle").data(data, (e) => e.id).join(
    (en) => en.append("circle").attr("cx", (e) => dx(e.start)).attr("cy", (e) => dy(e.n_channels)).attr("fill-opacity", 0),
    (up) => up, (ex) => ex.remove())
    .order()
    .attr("r", (e) => (isAnom(e) ? 6 : 3.8)).style("fill", (e) => catCol(e.category)).style("cursor", "pointer")
    .style("stroke", (e) => (S.sel === e ? "var(--fg)" : "none")).style("stroke-width", 2.5)
    .on("mousemove", (ev, e) => showTip(ev, evHtml(e))).on("mouseleave", hideTip).on("click", (ev, e) => selectEvent(e))
    .transition().duration(300)
    .attr("cx", (e) => dx(e.start)).attr("cy", (e) => dy(e.n_channels))
    .attr("fill-opacity", (e) => (pass(e) ? (isAnom(e) ? 0.95 : 0.6) : 0.1));
  if (!data.length) emptyMsg(detailG, W, DH, "No events in this window.");
  return data;
}

// ---------- C: linked signals ----------
let sigReq = 0;
function selectEvent(e) {
  S.sel = e;
  refresh();
  loadSignals(e);
}

function drawSignalsEmpty(msg) {
  $("r-sel").textContent = "no event selected"; $("syn").textContent = "";
  const svg = d3.select("#chan").attr("viewBox", "0 0 640 262"); svg.selectAll("*").remove();
  emptyMsg(svg, 640, 262, msg);
}

async function loadSignals(e) {
  const id = ++sigReq;
  $("r-sel").textContent = `${e.id} · ${e.category}${e.type ? " (" + e.type + ")" : ""} · ${e.n_channels} channels`;
  drawSignalsEmpty("Loading signals…"); $("r-sel").textContent = `${e.id} · loading…`;
  let res;
  try { res = await (await fetch(`${API}/api/event/${encodeURIComponent(e.id)}/signals`)).json(); }
  catch (err) { if (id === sigReq) drawSignalsEmpty("Could not load signals."); return; }
  if (id !== sigReq) return; // a newer click superseded this one
  $("r-sel").textContent = `${e.id} · ${e.category}${e.type ? " (" + e.type + ")" : ""} · ${e.n_channels} channels`;
  $("syn").textContent = res.synthetic ? "· signals are synthetic" : "";
  drawSignals(res);
}

function drawSignals(res) {
  const W = 640, rh = 80, n = res.channels.length, H = n * rh + 28, m = { l: 66, r: 10 };
  const svg = d3.select("#chan").attr("viewBox", `0 0 ${W} ${H}`); svg.selectAll("*").remove();
  const times = res.times.map((t) => new Date(t));
  const x = d3.scaleTime(d3.extent(times), [m.l, W - m.r]);
  const w0 = new Date(res.window[0]), w1 = new Date(res.window[1]);
  svg.append("rect").attr("x", x(w0)).attr("y", 2).attr("width", Math.max(2, x(w1) - x(w0))).attr("height", n * rh)
    .style("fill", "var(--accent)").style("fill-opacity", 0.14);
  if (res.alarm) {
    const ax = x(new Date(res.alarm));
    svg.append("line").attr("x1", ax).attr("x2", ax).attr("y1", 2).attr("y2", n * rh).style("stroke", "var(--fg)").style("stroke-dasharray", "5 5");
  }
  res.channels.forEach((c, k) => {
    const ext = d3.extent(c.values), pad = (ext[1] - ext[0]) * 0.1 || 1;
    const y = d3.scaleLinear([ext[0] - pad, ext[1] + pad], [(k + 1) * rh - 8, k * rh + 8]);
    svg.append("line").attr("x1", m.l).attr("x2", W - m.r).attr("y1", (k + 1) * rh - 2).attr("y2", (k + 1) * rh - 2).style("stroke", "var(--grid)");
    svg.append("text").attr("x", m.l - 6).attr("y", y(d3.mean(c.values)) + 4).attr("text-anchor", "end").text(c.name.replace("channel_", "ch. "));
    svg.append("path").attr("d", d3.line().x((v, i) => x(times[i])).y((v) => y(v))(c.values))
      .style("fill", "none").style("stroke", "var(--fg)").style("stroke-width", 1.4);
  });
  svg.append("g").attr("transform", `translate(0,${n * rh + 2})`).call(d3.axisBottom(x).ticks(5)).call(styleAxis);
  const cross = svg.append("line").attr("y1", 2).attr("y2", n * rh).style("stroke", "var(--muted)").style("opacity", 0);
  svg.append("rect").attr("x", m.l).attr("y", 0).attr("width", W - m.l - m.r).attr("height", n * rh).style("fill", "none").style("pointer-events", "all")
    .on("mousemove", (ev) => {
      const [px] = d3.pointer(ev);
      const i = d3.bisector((t) => t).center(times, x.invert(px));
      cross.attr("x1", x(times[i])).attr("x2", x(times[i])).style("opacity", 1);
      showTip(ev, `${fmtTime(times[i])}<br>` + res.channels.map((c) => `${c.name}: ${fmtNum(c.values[i])}`).join("<br>"));
    })
    .on("mouseleave", () => { cross.style("opacity", 0); hideTip(); });
}

// ---------- D: subsystem heatmap ----------
const PREV = new Map();
function drawHeat(active_) {
  const svg = d3.select("#heat");
  const cats = [...new Set(EV.map((e) => e.category))];
  const rows = [];
  if (S.sel) rows.push({ key: "sel", label: S.sel.id, set: [S.sel], col: "var(--fg)" });
  cats.forEach((c) => {
    const set = active_.filter((e) => e.category === c);
    rows.push({ key: c, label: `${c} (${set.length})`, set, col: catCol(c) });
  });
  const W = 440, m = { l: 152, t: 54 }, rh = 34;
  const cw = Math.min(56, (W - m.l - 34) / Math.max(1, SUBS.length)); // right margin leaves room for rotated headers
  const H = m.t + rows.length * rh + 8;
  svg.attr("viewBox", `0 0 ${W} ${H}`); svg.selectAll("*").remove();
  if (!SUBS.length) { emptyMsg(svg, W, 100, "No subsystem information."); return; }
  SUBS.forEach((s, i) => svg.append("text").attr("transform", `translate(${m.l + i * cw + cw / 2},${m.t - 8}) rotate(-35)`).attr("text-anchor", "start").text(s));
  rows.forEach((r, ri) => {
    svg.append("text").attr("x", m.l - 8).attr("y", m.t + ri * rh + rh / 2 + 4).attr("text-anchor", "end").attr("class", "strong").text(r.label);
    SUBS.forEach((s, i) => {
      const hit = r.set.filter((e) => e.subsystems.includes(s)).length;
      const share = r.set.length ? hit / r.set.length : 0;
      const k = r.key + "|" + s, prev = PREV.get(k) ?? 0;
      PREV.set(k, share);
      const cell = svg.append("rect").attr("x", m.l + i * cw).attr("y", m.t + ri * rh).attr("width", cw - 3).attr("height", rh - 3)
        .style("fill", r.key === "sel" ? "var(--fg)" : r.col).style("fill-opacity", 0.06 + prev * 0.94)
        .on("mousemove", (ev) => showTip(ev, `<b>${r.label}</b><br>${s}: ${Math.round(share * 100)}% (${hit} of ${r.set.length})`)).on("mouseleave", hideTip);
      cell.transition().duration(300).style("fill-opacity", 0.06 + share * 0.94);
      svg.append("text").attr("x", m.l + i * cw + cw / 2 - 1).attr("y", m.t + ri * rh + rh / 2 + 3).attr("text-anchor", "middle")
        .style("pointer-events", "none").style("font-size", "10.5px")
        .style("fill", share > 0.55 ? "#fff" : null).text(r.set.length ? Math.round(share * 100) + "%" : "–");
    });
  });
}

// ---------- orchestration ----------
function refresh() {
  if (!EV.length) { $("status").textContent = "No events for this mission."; return; }
  parLines.style("stroke", (e) => catCol(e.category)).style("stroke-width", (e) => (isAnom(e) ? 1.8 : 1))
    .style("stroke-opacity", (e) => (pass(e) ? (isAnom(e) ? 0.9 : 0.3) : 0.04));
  ticks.style("stroke-opacity", (e) => (pass(e) ? 1 : 0.1));
  const inW = drawDetail();
  const act = inW.filter(pass);
  $("r-time").textContent = `${act.length} of ${inW.length} events in window match · ${act.filter(isAnom).length} anomalies`;
  drawHeat(act);
  const chips = [];
  if (S.dom) chips.push(`<span class="chip">${fmtDate(S.dom[0])} – ${fmtDate(S.dom[1])}</span>`);
  DIMS.forEach((d) => { if (S.filt[d.k]) chips.push(`<span class="chip">${d.n} ${fmtNum(S.filt[d.k][0])}–${fmtNum(S.filt[d.k][1])}</span>`); });
  if (S.sel) chips.push(`<span class="chip">selected ${S.sel.id}</span>`);
  $("status").innerHTML = `${act.length.toLocaleString()} of ${EV.length.toLocaleString()} events active ` + chips.join("");
}

boot();
