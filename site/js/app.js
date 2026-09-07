(function () {
"use strict";

// ---------- Color ramps ----------
// Sequential blue (validated, dataviz skill palette) — used for "Raw rate".
const RAMP_SEQUENTIAL = ["#b7d3f6", "#6da7ec", "#2a78d6", "#184f95", "#0d366b"];
// Viridis (colourblind-safe, requested for the quantile/percentile scale so
// every indicator — whatever its native units — reads on one common ramp).
const RAMP_VIRIDIS = ["#440154", "#3b528b", "#21908c", "#5dc963", "#fde725"];
// Diverging blue -> pale yellow -> red — for signed/centred quantities:
// year-on-year change, change z-score, age-adjusted ratio. Blue-yellow-red
// (rather than a neutral-gray midpoint) is the standard colourblind-safe
// diverging choice for maps: it avoids the classic red-green confusion, and
// a gray midpoint would have been visually confusable with the "No data"
// grey used everywhere else on this map.
const RAMP_DIVERGING = ["#184f95", "#8fb8e0", "#f5e6a8", "#f0a875", "#d03b3b"];
const NO_DATA_COLOR = "#d7d5cd";
const HOVER_COLOR = "#eb6834";

const state = {
  meta: null,
  data: null,
  schemaIndex: {},
  geoLayer: null,
  activeKey: "chd",
  viewMode: "raw",
  activeCountry: "ALL",
  featuresByCode: new Map(),
  layersByCode: new Map(),
  trendCache: {},
  trendFailed: new Set(),
  loadedIndicators: new Set(),
  allLoaded: false,
  allLoadedPromise: null,
  aboutBuilt: false,
  forecastBuilt: false,
  activeDetailCode: null,
};

const $ = (sel) => document.querySelector(sel);

function formatGeneratedDate(iso) {
  return new Date(iso).toLocaleString("en-GB", { dateStyle: "long", timeStyle: "short", timeZone: "UTC" }) + " UTC";
}

// Read a derived-or-raw value for one LSOA record given a base indicator key
// and a view mode ("raw" | "pctile" | "yoy" | "zscore" | "ageadj").
function getVal(rec, baseKey, mode) {
  if (!rec) return undefined;
  const suffix = MODE_SUFFIX[mode] ?? "";
  const idx = state.schemaIndex[baseKey + suffix];
  if (idx === undefined) return undefined;
  const v = rec.v[idx];
  return v === null ? undefined : v;
}

// ---------- Boot ----------
// Data loads in two waves. Wave 1 (blocking the loading spinner) is just
// enough to make the map interactive: names/LA/country for every LSOA,
// the boundaries, and the *default* indicator's values. Wave 2 (fired
// immediately after, non-blocking) fetches every other indicator's file
// in the background and merges each in as it arrives — the full per-LSOA
// "click any area" profile and the Compare & Forecast live calculations
// both need wave 2 to finish, but the map itself doesn't wait for it.
// This exists because the old single lsoa_data.json (every field for
// every LSOA) was ~6.3MB gzipped and had to fully download+parse before
// anything was visible; splitting by indicator mirrors the trend_<key>.json
// pattern already used elsewhere in this app for exactly this reason.
function mergeIndicatorFile(baseKey, payload) {
  const fieldIdx = payload.fields.map((f) => state.schemaIndex[f]);
  for (const code in payload.data) {
    const rec = state.data[code];
    if (!rec) continue;
    const vals = payload.data[code];
    fieldIdx.forEach((idx, i) => { if (idx !== undefined) rec.v[idx] = vals[i]; });
  }
  state.loadedIndicators.add(baseKey);
}

Promise.all([
  fetch("data/meta.json").then((r) => r.json()),
  fetch("data/lsoa_core.json").then((r) => r.json()),
  fetch("data/lsoa_2011.topojson").then((r) => r.json()),
  fetch(`data/lsoa_ind_${state.activeKey}.json`).then((r) => r.json()),
]).then(([meta, core, topo, firstIndicator]) => {
  state.meta = meta;
  (meta.schema || []).forEach((key, i) => { state.schemaIndex[key] = i; });

  state.data = {};
  for (const code in core) {
    state.data[code] = { n: core[code].n, la: core[code].la, c: core[code].c, v: new Array(state.meta.schema.length).fill(null) };
  }
  mergeIndicatorFile(state.activeKey, firstIndicator);

  const objectName = Object.keys(topo.objects)[0];
  const geojson = topojson.feature(topo, topo.objects[objectName]);

  buildSidebar();
  buildMap(geojson);
  buildLegend();
  buildHowToRead();
  wireGlobalControls();

  if (meta.generated) {
    const badge = $("#freshnessBadge");
    badge.textContent = `📅 Data as of ${formatGeneratedDate(meta.generated)}`;
    badge.hidden = false;
  }

  $("#mapLoading").style.display = "none";

  // Wave 2: every other indicator, in the background. Each one self-heals
  // the map the instant it lands if it happens to be the one currently
  // selected (covers the edge case of switching indicators before this
  // finishes); the full allLoadedPromise below is what the detail panel's
  // "full profile" view and the Compare & Forecast modal wait on.
  const remainingKeys = Object.keys(meta.indicators).filter((k) => k !== state.activeKey);
  state.allLoadedPromise = Promise.all(
    remainingKeys.map((key) =>
      fetch(`data/lsoa_ind_${key}.json`)
        .then((r) => r.json())
        .then((payload) => {
          mergeIndicatorFile(key, payload);
          if (key === state.activeKey) { restyleAll(); buildLegend(); }
        })
        .catch((err) => console.error(`Background load of indicator "${key}" failed:`, err))
    )
  ).then(() => { state.allLoaded = true; });
}).catch((err) => {
  console.error(err);
  $("#mapLoading").innerHTML = "<p>⚠️ Failed to load data. Check the browser console.</p>";
});

// ---------- Sidebar: indicator list ----------
function buildSidebar() {
  const container = $("#layerGroups");
  container.innerHTML = "";

  INDICATOR_GROUPS.forEach((group) => {
    const wrap = document.createElement("div");
    wrap.className = "layer-group";

    const h = document.createElement("h3");
    h.textContent = group.label;
    const span = document.createElement("span");
    span.className = "group-coverage";
    span.textContent = group.coverage;
    h.appendChild(span);
    wrap.appendChild(h);

    const blurb = document.createElement("p");
    blurb.className = "group-blurb";
    blurb.textContent = group.blurb;
    wrap.appendChild(blurb);

    group.keys.forEach((key) => {
      const m = state.meta.indicators[key];
      if (!m) return;
      const row = document.createElement("label");
      row.className = "layer-row";
      row.dataset.key = key;

      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = "activeLayer";
      radio.value = key;
      radio.checked = key === state.activeKey;
      radio.addEventListener("change", () => setActiveIndicator(key));

      const txt = document.createElement("span");
      txt.className = "layer-label";
      txt.textContent = m.label;

      const n = document.createElement("span");
      n.className = "layer-n";
      n.textContent = m.n_lsoas.toLocaleString() + " areas";

      row.appendChild(radio);
      row.appendChild(txt);
      row.appendChild(n);
      wrap.appendChild(row);
    });

    container.appendChild(wrap);
  });

  buildViewModeSelector();
}

// ---------- Sidebar: "View as" mode selector ----------
function buildViewModeSelector() {
  let holder = $("#viewModeHolder");
  if (!holder) {
    holder = document.createElement("div");
    holder.id = "viewModeHolder";
    holder.className = "view-mode-holder";
    const helpP = document.querySelector(".sidebar-help");
    helpP.after(holder);
  }
  renderViewModeSelector();
}

function renderViewModeSelector() {
  const holder = $("#viewModeHolder");
  const m = state.meta.indicators[state.activeKey];
  const available = VIEW_MODES.filter((vm) => (m.modes || ["raw"]).includes(vm.id));

  if (!available.some((vm) => vm.id === state.viewMode)) {
    state.viewMode = "raw";
  }

  holder.innerHTML = `
    <div class="view-mode-label">View <strong>${m.label}</strong> as:</div>
    <div class="view-mode-pills">
      ${available.map((vm) => `<button type="button" class="view-mode-pill ${vm.id === state.viewMode ? "active" : ""}" data-mode="${vm.id}" title="${VIEW_MODE_HELP[vm.id]}">${vm.short}</button>`).join("")}
    </div>
    <p class="view-mode-help">${VIEW_MODE_HELP[state.viewMode]}</p>
  `;

  holder.querySelectorAll(".view-mode-pill").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.viewMode = btn.dataset.mode;
      renderViewModeSelector();
      restyleAll();
      buildLegend();
      buildHowToRead();
    });
  });
}

// ---------- "How to read this map" — updates with the selected view mode ----------
// The colour meaning genuinely changes between modes (a single-hue sequential
// scale for Raw, the multi-hue Viridis scale for Percentile, and a diverging
// blue-yellow-red scale for the three signed/centred modes) so this can't be
// one static explanation — it has to match whatever's actually on screen.
function buildHowToRead() {
  const el = $("#howToReadBody");
  if (!el) return;
  const mode = state.viewMode;
  const activeMeta = state.meta.indicators[state.activeKey];
  const rawIsDiverging = mode === "raw" && activeMeta && activeMeta.scale === "diverging";
  const swatch = (c) => `<span class="mini-swatch" style="background:${c}"></span>`;
  let html = "";

  if (mode === "raw" && !rawIsDiverging) {
    html = `
      <li>${swatch(RAMP_SEQUENTIAL[4])}<strong>Darker blue</strong> = a higher value for the indicator selected on the left</li>
      <li>${swatch(RAMP_SEQUENTIAL[0])}<strong>Lighter blue</strong> = a lower value</li>
      <li>${swatch(NO_DATA_COLOR)}<strong>Grey</strong> = no data published for this area for that indicator</li>
    `;
  } else if (mode === "pctile") {
    html = `
      <li>This view uses the <strong>Viridis</strong> colour scale (chosen for being colourblind-safe) — it's not a simple light/dark scale, it runs through four colours:</li>
      <li>${swatch(RAMP_VIRIDIS[0])}<strong>Dark purple</strong> = lowest percentile (near 0) for the indicator on the left</li>
      <li>${swatch(RAMP_VIRIDIS[2])}<strong>Teal / green</strong> = mid-range (around the 50th percentile)</li>
      <li>${swatch(RAMP_VIRIDIS[4])}<strong>Yellow</strong> = highest percentile (near 100)</li>
      <li>${swatch(NO_DATA_COLOR)}<strong>Grey</strong> = no data published for this area for that indicator</li>
    `;
  } else {
    const isAgeAdj = mode === "ageadj";
    const neutralLabel = isAgeAdj ? "about 1.0 — as expected for the local age profile" : "about 0 — no meaningful change";
    const lowLabel = isAgeAdj ? "well below 1.0 (lower than the area's age profile would predict)" : "a sharp decrease";
    const highLabel = isAgeAdj ? "well above 1.0 (higher than the area's age profile would predict)" : "a sharp increase";
    html = `
      <li>This view uses a <strong>blue–yellow–red diverging</strong> scale, since it's measuring direction as well as size:</li>
      <li>${swatch(RAMP_DIVERGING[0])}<strong>Blue</strong> = ${lowLabel}</li>
      <li>${swatch(RAMP_DIVERGING[2])}<strong>Pale yellow</strong> = ${neutralLabel}</li>
      <li>${swatch(RAMP_DIVERGING[4])}<strong>Red</strong> = ${highLabel}</li>
      <li>${swatch(NO_DATA_COLOR)}<strong>Grey</strong> = no data published for this area for that indicator</li>
    `;
  }

  const indicatorCount = Object.keys(state.meta.indicators).length;
  html += `<li><strong>Click any shaded area</strong> on the map for its full health profile — all ${indicatorCount} indicators, with sources — right here in this panel</li>`;
  el.innerHTML = html;
}

const VIEW_MODE_HELP = {
  raw: "The actual measured value, in its own units (e.g. % of patients, or items per 1,000 patients).",
  pctile: "Where this area ranks compared with every other area, from 0 (lowest) to 100 (highest) — puts every indicator on the same 0–100 scale regardless of its real-world units, so different conditions become directly comparable.",
  yoy: "The % change in the raw rate between the two most recent years of data — positive means rising, negative means falling.",
  zscore: "How unusual this area's year-on-year change is, in standard deviations from the typical change seen everywhere else for this condition. 0 = typical, +2 means a much faster rise than most areas, -2 a much sharper fall.",
  ageadj: "The observed rate divided by the rate you'd predict just from how old the local population is. 1.0 = exactly as expected for that age profile; above 1.0 = higher than age alone explains; below 1.0 = lower.",
};

function setActiveIndicator(key) {
  state.activeKey = key;
  document.querySelectorAll(".layer-row").forEach((row) => {
    row.classList.toggle("active", row.dataset.key === key);
  });
  renderViewModeSelector();
  restyleAll();
  buildLegend();
  buildHowToRead();
}

// ---------- Color logic ----------
function rampFor(mode, m) {
  if (mode === "pctile") return RAMP_VIRIDIS;
  if (mode === "yoy" || mode === "zscore" || mode === "ageadj") return RAMP_DIVERGING;
  // A handful of indicators (e.g. the census 2011->2021 change) are
  // inherently signed even in "raw" mode — a plain sequential ramp would
  // make a decrease and an increase look like "less" and "more" of the
  // same thing, rather than opposite directions.
  if (mode === "raw" && m && m.scale === "diverging") return RAMP_DIVERGING;
  return RAMP_SEQUENTIAL;
}

function breaksFor(m, mode) {
  // Percentile rank is always on a fixed 0-100 scale by construction, so its
  // quintile breaks are always exactly 20/40/60/80 — no indicator-specific
  // computation needed (and using the raw-value breaks by mistake here once
  // classified almost every LSOA into a single bin, since raw values and
  // 0-100 percentiles are on completely different scales).
  if (mode === "pctile") return [20, 40, 60, 80];
  const suffix = MODE_SUFFIX[mode] ?? "";
  return m[`breaks${suffix}`] || m.breaks;
}

function colorFor(value, m, mode) {
  if (value === undefined || value === null) return NO_DATA_COLOR;
  const b = breaksFor(m, mode);
  const ramp = rampFor(mode, m);
  if (value <= b[0]) return ramp[0];
  if (value <= b[1]) return ramp[1];
  if (value <= b[2]) return ramp[2];
  if (value <= b[3]) return ramp[3];
  return ramp[4];
}

function styleFeature(code) {
  const rec = state.data[code];
  const m = state.meta.indicators[state.activeKey];
  const value = getVal(rec, state.activeKey, state.viewMode);
  const inCountry = state.activeCountry === "ALL" || (rec && rec.c === state.activeCountry);
  return {
    fillColor: colorFor(value, m, state.viewMode),
    fillOpacity: inCountry ? 0.85 : 0.06,
    color: inCountry ? "rgba(11,11,11,0.12)" : "rgba(11,11,11,0.03)",
    weight: 0.4,
    interactive: inCountry,
  };
}

function restyleAll() {
  state.layersByCode.forEach((layer, code) => {
    layer.setStyle(styleFeature(code));
  });
}

// ---------- Map ----------
function buildMap(geojson) {
  const map = L.map("map", {
    preferCanvas: true,
    zoomControl: true,
    minZoom: 5,
    maxZoom: 16,
  }).setView([52.4, -2.5], 6);

  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19,
  }).addTo(map);

  state.geoLayer = L.geoJSON(geojson, {
    renderer: L.canvas({ padding: 0.3 }),
    style: (feature) => styleFeature(feature.properties.LSOA11CD),
    onEachFeature: (feature, layer) => {
      const code = feature.properties.LSOA11CD;
      state.layersByCode.set(code, layer);
      state.featuresByCode.set(code, feature);

      layer.on("mouseover", () => {
        const rec = state.data[code];
        if (!rec) return;
        const m = state.meta.indicators[state.activeKey];
        const v = getVal(rec, state.activeKey, state.viewMode);
        const valTxt = v === undefined ? "No data"
          : state.viewMode === "pctile" ? `${ordinal(v)} percentile`
          : state.viewMode === "raw" ? `${v} ${m.unit}`
          : `${v} (${VIEW_MODES.find(x => x.id === state.viewMode).short})`;
        layer.bindTooltip(`<strong>${rec.n}</strong><br>${rec.la}<br>${m.label}: ${valTxt}`, {
          sticky: true,
          className: "lsoa-tooltip",
        }).openTooltip();
        layer.setStyle({ weight: 1.6, color: HOVER_COLOR });
      });
      layer.on("mouseout", () => {
        layer.setStyle(styleFeature(code));
      });
      layer.on("click", () => showDetail(code));
    },
  }).addTo(map);

  state.map = map;
}

// ---------- Legend ----------
// One consistent decimal count per legend, chosen by mode — so every row
// shows the same precision instead of whatever a quantile happened to
// compute (e.g. "2.32" next to "2.844"). Diverging modes also get their
// natural "no change" reference value (0%, z=0, ratio=1.0) as an exact row
// boundary (see diverging_breaks() in build_data.py) — the labels below
// simply display that boundary at the same fixed precision as every other
// row, so "0.00%" or "0.000" reads as a real, marked threshold rather than
// an approximation.
function formatLegendValue(v, mode, breaks) {
  if (mode === "pctile") return String(Math.round(v));
  if (mode === "yoy") return `${v.toFixed(2)}%`;
  if (mode === "zscore") return v.toFixed(3);
  if (mode === "ageadj") return `×${v.toFixed(2)}`;
  const scale = Math.max(...breaks.map((x) => Math.abs(x)));
  const decimals = scale >= 100 ? 0 : scale >= 10 ? 1 : 2;
  return v.toFixed(decimals);
}

function buildLegend() {
  const m = state.meta.indicators[state.activeKey];
  const mode = state.viewMode;
  const b = breaksFor(m, mode);
  const ramp = rampFor(mode, m);
  const el = $("#legend");
  const fmt = (v) => formatLegendValue(v, mode, b);
  const cy = (state.meta.change_years || {})[state.activeKey];
  const yearsPhrase = cy ? `comparing ${cy.t0} → ${cy.t1}` : "comparing the two most recent years";
  const unitLabel = mode === "raw" ? (m.scale === "diverging" ? `${m.unit} · 0 = no change` : m.unit)
    : mode === "pctile" ? "percentile rank (0–100)"
    : mode === "yoy" ? `${yearsPhrase} · 0% = no change · updates automatically as new data is published`
    : mode === "zscore" ? `${yearsPhrase} vs. every other area's change · 0 = typical · updates automatically as new data is published`
    : "age-adjusted ratio (1.0 = exactly as the local age profile predicts)";

  const labels = [
    `< ${fmt(b[0])}`,
    `${fmt(b[0])} – ${fmt(b[1])}`,
    `${fmt(b[1])} – ${fmt(b[2])}`,
    `${fmt(b[2])} – ${fmt(b[3])}`,
    `> ${fmt(b[3])}`,
  ];
  const modeLabel = VIEW_MODES.find((v) => v.id === mode).label;
  let html = `<div class="legend-title">${m.label}</div><div class="legend-unit">${modeLabel} &middot; ${unitLabel}</div>`;
  ramp.forEach((c, i) => {
    html += `<div class="legend-row"><span class="swatch" style="background:${c}"></span>${labels[i]}</div>`;
  });
  html += `<div class="legend-row"><span class="swatch" style="background:${NO_DATA_COLOR}"></span>No data</div>`;
  html += `<div class="legend-meta">${m.coverage} · ${m.year} · ${m.n_lsoas.toLocaleString()} areas</div>`;
  // Every indicator's values load in the background right after the map
  // first appears (see the boot sequence) — this only shows if someone
  // switches to one that hasn't landed yet, in the first second or two.
  if (!state.loadedIndicators.has(state.activeKey)) {
    html += `<div class="legend-meta">⏳ Loading this indicator's data…</div>`;
  }
  el.innerHTML = html;
}

// ---------- Detail panel ----------
function ordinal(n) {
  const r = Math.round(n);
  const mod100 = r % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${r}th`;
  const mod10 = r % 10;
  return `${r}${mod10 === 1 ? "st" : mod10 === 2 ? "nd" : mod10 === 3 ? "rd" : "th"}`;
}

function formatStat(v, suffix) {
  if (v === undefined || v === null) return null;
  const r2 = Math.round(v * 100) / 100;
  return suffix === "pctile" ? `${ordinal(v)} percentile`
    : suffix === "yoy" ? `${r2 > 0 ? "+" : ""}${r2}% vs last year`
    : suffix === "z" ? `z ${r2 > 0 ? "+" : ""}${r2}`
    : suffix === "adj" ? `age-adjusted ×${r2}`
    : String(v);
}

async function showDetail(code) {
  const rec = state.data[code];
  if (!rec) return;
  $("#detailEmpty").hidden = true;
  const el = $("#detailContent");
  el.hidden = false;
  $("#detailPanel").classList.add("open");

  // The full profile below reads every indicator, but only the map's own
  // active indicator is guaranteed loaded this early (see the boot
  // sequence) — without this wait, an area clicked in the first second or
  // two would wrongly show "No data" for everything still in flight rather
  // than what's actually true (data on its way). In practice this resolves
  // near-instantly; it only visibly waits on a very fast click or a very
  // slow connection.
  state.activeDetailCode = code;
  if (!state.allLoaded) {
    el.innerHTML = `<p class="nodata">Loading this area's full profile…</p>`;
    await state.allLoadedPromise;
    // If the user clicked a different area while this was in flight,
    // abandon this now-stale render rather than clobbering theirs.
    if (state.activeDetailCode !== code) return;
  }

  const countryName = rec.c === "E" ? "England" : "Wales";
  let html = `
    <div class="detail-head">
      <h2>${rec.n}</h2>
      <p class="detail-sub">${rec.la} &middot; ${countryName} &middot; <code>${code}</code></p>
    </div>
  `;

  INDICATOR_GROUPS.forEach((group) => {
    const rows = group.keys
      .map((key) => {
        const m = state.meta.indicators[key];
        if (!m) return "";
        const raw = getVal(rec, key, "raw");
        const valTxt = raw === undefined ? '<span class="nodata">No data for this area</span>' : `<strong>${raw}</strong> ${m.unit}`;

        const stats = [];
        const pctile = getVal(rec, key, "pctile");
        if (pctile !== undefined) stats.push(formatStat(pctile, "pctile"));
        const yoy = getVal(rec, key, "yoy");
        if (yoy !== undefined) stats.push(formatStat(yoy, "yoy"));
        const z = getVal(rec, key, "zscore");
        if (z !== undefined) stats.push(formatStat(z, "z"));
        const adj = getVal(rec, key, "ageadj");
        if (adj !== undefined) stats.push(formatStat(adj, "adj"));
        const statsLine = stats.length ? `<div class="detail-row-stats">${stats.join(" &middot; ")}</div>` : "";

        const trendBtn = m.has_trend && raw !== undefined
          ? `<button type="button" class="trend-btn" data-key="${key}" data-code="${code}">📈 Trend</button>`
          : "";

        return `<div class="detail-row-wrap">
          <div class="detail-row"><span class="detail-row-label">${m.label}</span><span class="detail-row-val">${valTxt}</span></div>
          ${statsLine}
          ${trendBtn}
          <div class="trend-slot" data-key="${key}"></div>
        </div>`;
      })
      .join("");
    if (!rows) return;
    html += `<div class="detail-group"><h3>${group.label}</h3>${rows}</div>`;
  });

  html += `<p class="detail-footnote">Click "ℹ️ Data &amp; methodology" above for exact sources, years, and a plain-language glossary of percentile rank, z-score and age-adjustment.</p>`;

  el.innerHTML = html;

  el.querySelectorAll(".trend-btn").forEach((btn) => {
    btn.addEventListener("click", () => toggleTrend(btn));
  });

  // Zoom to feature
  const layer = state.layersByCode.get(code);
  if (layer && state.map) {
    state.map.fitBounds(layer.getBounds(), { maxZoom: 13, padding: [40, 40] });
  }
}

// ---------- Trend sparkline (lazy-loaded per indicator) ----------
async function toggleTrend(btn) {
  const key = btn.dataset.key;
  const code = btn.dataset.code;
  const slot = document.querySelector(`.trend-slot[data-key="${key}"]`);
  if (!slot) return;

  if (slot.dataset.open === "1") {
    slot.innerHTML = "";
    slot.dataset.open = "0";
    btn.textContent = "📈 Trend";
    return;
  }

  btn.textContent = "⏳ Loading…";
  try {
    // If a previous attempt for this indicator failed, force a fresh fetch
    // rather than risk quietly replaying a bad cached/CDN-edge-cached
    // response — retrying with a plain fetch() alone doesn't guarantee that.
    const retry = state.trendFailed.has(key);
    const trend = await loadTrend(key, retry);
    state.trendFailed.delete(key);
    const values = trend.data[code] || [];
    slot.innerHTML = buildSparklineSVG(trend.years, values, state.meta.reform_years, state.meta.indicators[key].label);
    slot.dataset.open = "1";
    btn.textContent = "📈 Hide trend";
  } catch (e) {
    console.error(e);
    state.trendFailed.add(key);
    slot.innerHTML = `<p class="nodata">Couldn't load trend data — <button type="button" class="trend-retry-link" data-key="${key}" data-code="${code}">tap to retry</button>.</p>`;
    slot.querySelector(".trend-retry-link")?.addEventListener("click", () => toggleTrend(btn));
    btn.textContent = "📈 Trend";
    slot.dataset.open = "0";
  }
}

function loadTrend(key, forceRefresh) {
  if (!forceRefresh && state.trendCache[key]) return Promise.resolve(state.trendCache[key]);
  const url = forceRefresh ? `data/trend_${key}.json?retry=${Date.now()}` : `data/trend_${key}.json`;
  return fetch(url, forceRefresh ? { cache: "reload" } : {})
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    })
    .then((json) => {
      if (!json || !json.years || !json.data) throw new Error("malformed trend payload");
      state.trendCache[key] = json;
      return json;
    });
}

function fmtAxis(n) {
  if (n === null || n === undefined) return "";
  const rounded = Math.round(n * 100) / 100;
  return Math.abs(rounded) >= 100 ? Math.round(rounded) : rounded;
}

function buildSparklineSVG(years, values, reformYears, label) {
  const W = 260, H = 100, padL = 28, padR = 10, padT = 10, padB = 20;
  const plotW = W - padL - padR, plotH = H - padT - padB;

  const points = years.map((y, i) => ({ y, v: values[i] })).filter((p) => p.v !== null && p.v !== undefined);
  if (points.length < 2) {
    return `<p class="nodata">Not enough data for a trend line in this area.</p>`;
  }
  const yMin = Math.min(...points.map((p) => p.v));
  const yMax = Math.max(...points.map((p) => p.v));
  const yRange = yMax - yMin || 1;
  const xMin = years[0], xMax = years[years.length - 1];
  const xRange = xMax - xMin || 1;

  const xPos = (y) => padL + ((y - xMin) / xRange) * plotW;
  const yPos = (v) => padT + plotH - ((v - yMin) / yRange) * plotH;

  const path = points.map((p, i) => `${i === 0 ? "M" : "L"}${xPos(p.y).toFixed(1)},${yPos(p.v).toFixed(1)}`).join(" ");
  const dots = points.map((p) => `<circle cx="${xPos(p.y).toFixed(1)}" cy="${yPos(p.v).toFixed(1)}" r="2" fill="var(--accent)" />`).join("");

  const reformLines = (reformYears || [])
    .filter((r) => r.year >= xMin && r.year <= xMax)
    .map((r) => {
      const x = xPos(r.year).toFixed(1);
      return `<line x1="${x}" y1="${padT}" x2="${x}" y2="${padT + plotH}" stroke="var(--text-muted)" stroke-dasharray="2,2" stroke-width="1" />
              <text x="${x}" y="${H - 4}" font-size="8" fill="var(--text-muted)" text-anchor="middle">${r.year}</text>`;
    }).join("");

  const yLabelTop = `<text x="${padL - 4}" y="${padT + 4}" font-size="8" fill="var(--text-muted)" text-anchor="end">${fmtAxis(yMax)}</text>`;
  const yLabelBottom = `<text x="${padL - 4}" y="${padT + plotH}" font-size="8" fill="var(--text-muted)" text-anchor="end">${fmtAxis(yMin)}</text>`;
  const xLabelStart = `<text x="${padL}" y="${H - 4}" font-size="8" fill="var(--text-muted)" text-anchor="start">${xMin}</text>`;
  const xLabelEnd = `<text x="${W - padR}" y="${H - 4}" font-size="8" fill="var(--text-muted)" text-anchor="end">${xMax}</text>`;

  return `
    <svg class="sparkline" viewBox="0 0 ${W} ${H}" role="img" aria-label="${label} trend over time">
      ${reformLines}
      <path d="${path}" fill="none" stroke="var(--accent)" stroke-width="1.5" />
      ${dots}
      ${yLabelTop}${yLabelBottom}
    </svg>
    <p class="sparkline-caption">Dashed lines mark national NHS commissioning reforms (see glossary) — not necessarily a cause of any change shown here.</p>
  `;
}

// ---------- Search ----------
function wireGlobalControls() {
  const input = $("#searchInput");
  const results = $("#searchResults");

  input.addEventListener("input", () => {
    const q = input.value.trim().toLowerCase();
    if (q.length < 2) {
      results.hidden = true;
      results.innerHTML = "";
      return;
    }
    const matches = [];
    for (const code in state.data) {
      const rec = state.data[code];
      if (rec.n.toLowerCase().includes(q) || rec.la.toLowerCase().includes(q) || code.toLowerCase() === q) {
        matches.push({ code, rec });
        if (matches.length >= 25) break;
      }
    }
    if (matches.length === 0) {
      results.innerHTML = `<div class="search-empty">No matches</div>`;
      results.hidden = false;
      return;
    }
    results.innerHTML = matches
      .map((m) => `<div class="search-item" data-code="${m.code}"><strong>${m.rec.n}</strong><br><span>${m.rec.la}</span></div>`)
      .join("");
    results.hidden = false;
  });

  results.addEventListener("click", (e) => {
    const item = e.target.closest(".search-item");
    if (!item) return;
    const code = item.dataset.code;
    showDetail(code);
    results.hidden = true;
    input.value = state.data[code].n;
  });

  document.addEventListener("click", (e) => {
    if (!e.target.closest(".search-box")) results.hidden = true;
  });

  // Country toggle
  document.querySelectorAll(".country-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".country-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.activeCountry = btn.dataset.country;
      restyleAll();
    });
  });

  // Sidebar toggle (mobile)
  $("#sidebarToggle").addEventListener("click", () => {
    $("#sidebar").classList.toggle("open");
  });
  $("#detailPanelClose").addEventListener("click", () => {
    $("#detailPanel").classList.remove("open");
  });

  // About and Compare & Forecast are built lazily on first open, not at
  // boot — both need every indicator's data (a full LSOA profile / a live
  // national correlation across all LSOAs), which only wave 2 of the boot
  // sequence guarantees. In practice wave 2 finishes long before a user
  // finds either button; this just makes the rare fast-click case correct
  // instead of showing a modal built from a partially-loaded dataset.
  async function ensureModalBuilt(bodyId, builtFlag, buildFn) {
    if (state[builtFlag]) return;
    if (!state.allLoaded) {
      $(bodyId).innerHTML = `<p class="modal-lede">Loading the full dataset…</p>`;
      await state.allLoadedPromise;
    }
    buildFn();
    state[builtFlag] = true;
  }

  // About modal
  $("#aboutBtn").addEventListener("click", () => {
    $("#aboutModalBackdrop").hidden = false;
    ensureModalBuilt("#aboutModalBody", "aboutBuilt", buildAboutModal);
  });
  $("#aboutModalClose").addEventListener("click", () => {
    $("#aboutModalBackdrop").hidden = true;
  });
  $("#aboutModalBackdrop").addEventListener("click", (e) => {
    if (e.target.id === "aboutModalBackdrop") $("#aboutModalBackdrop").hidden = true;
  });

  // Compare & Forecast modal
  $("#forecastBtn").addEventListener("click", () => {
    $("#forecastModalBackdrop").hidden = false;
    ensureModalBuilt("#forecastModalBody", "forecastBuilt", buildForecastModal);
  });
  $("#forecastModalClose").addEventListener("click", () => {
    $("#forecastModalBackdrop").hidden = true;
  });
  $("#forecastModalBackdrop").addEventListener("click", (e) => {
    if (e.target.id === "forecastModalBackdrop") $("#forecastModalBackdrop").hidden = true;
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      $("#aboutModalBackdrop").hidden = true;
      $("#forecastModalBackdrop").hidden = true;
    }
  });
}

// ---------- About / methodology modal ----------
function buildAboutModal() {
  const body = $("#aboutModalBody");

  const lastUpdatedText = state.meta.generated ? formatGeneratedDate(state.meta.generated) : "an unknown date";

  let sourceRows = "";
  Object.keys(SOURCE_CITATIONS).forEach((key) => {
    const m = state.meta.indicators[key];
    const s = SOURCE_CITATIONS[key];
    if (!m) return;
    sourceRows += `
      <tr>
        <td>${m.label}</td>
        <td>${s.dataset}</td>
        <td>${s.publisher}</td>
        <td>${m.year}</td>
        <td>${m.coverage}</td>
        <td><a href="${s.url}" target="_blank" rel="noopener">Source ↗</a></td>
      </tr>`;
  });

  // Worked example for the percentile-rank explanation, using real numbers.
  const chdEx = pickExampleIndicator("chd");
  const statinsEx = pickExampleIndicator("statins");

  const reformRows = (state.meta.reform_years || [])
    .map((r) => `<li><strong>${r.year}:</strong> ${r.label}</li>`)
    .join("");

  const nationalTrendCharts = Object.keys(state.meta.national_trends || {})
    .map((key) => buildNationalTrendChart(key))
    .join("");

  // Reform-impact table: for every indicator with a reform year nearby in
  // its data, compares that year's national change AND its cross-region
  // spread (SD of change across LSOAs) against what's typical for that
  // same indicator — see compute_reform_impact() in build_data.py. A ratio
  // above 1 means areas moved more differently from each other than usual
  // that year; below 1 means the change was more uniform than usual.
  const reformImpactRows = [];
  for (const key in state.meta.reform_impact || {}) {
    const m = state.meta.indicators[key];
    if (!m) continue;
    for (const year in state.meta.reform_impact[key]) {
      reformImpactRows.push({ key, label: m.label, year: Number(year), ...state.meta.reform_impact[key][year] });
    }
  }
  reformImpactRows.sort((a, b) => a.year - b.year || b.heterogeneity_ratio - a.heterogeneity_ratio);
  const reformReading = (ratio) =>
    ratio >= 1.5 ? "much more regionally uneven than usual"
    : ratio >= 1.15 ? "somewhat more regionally uneven"
    : ratio <= 0.67 ? "much more regionally uniform than usual"
    : ratio <= 0.87 ? "somewhat more regionally uniform"
    : "close to a typical year";
  const reformImpactTableRows = reformImpactRows.map((r) => `
    <tr>
      <td>${r.label}</td>
      <td>${r.year}</td>
      <td>${r.mean_change_pct > 0 ? "+" : ""}${r.mean_change_pct}%</td>
      <td>${r.heterogeneity_ratio}×</td>
      <td>${reformReading(r.heterogeneity_ratio)}</td>
    </tr>
  `).join("");

  body.innerHTML = `
    <h2 id="aboutTitle">Data &amp; methodology</h2>

    <p class="modal-lede">This is an independent <strong>prototype</strong> dashboard built entirely from publicly available UK government, NHS and Welsh Government data.
    It is <strong>not</strong> an official NHS, ONS, UK Government or Welsh Government product, has not been clinically validated, and must not be used for individual
    clinical decisions, resource allocation, or as a substitute for official statistics.</p>

    <h3>What this shows</h3>
    <p>The map shades every Lower Super Output Area (LSOA) — a small-area statistical geography of ~1,500 residents each — in England and Wales
    by whichever single health indicator is selected in the sidebar. There are <strong>34,753 LSOAs</strong> in this dataset (32,844 in England, 1,909 in Wales).
    Only one indicator is shaded at a time, by design: overlaying multiple differently-scaled health measures as combined colour would be visually
    misleading, so this uses a single-select list rather than independent tick-boxes. Click any area for its complete profile across every indicator.</p>

    <h3>Understanding the numbers — a plain-language glossary</h3>
    <p>Every indicator can be viewed five different ways using the "View as" buttons above the indicator list (only the ones that make sense for
    that indicator are shown). Here's what each one actually means, with real examples from this dataset:</p>
    <ul>
      <li><strong>Raw rate</strong> — the number as published: e.g. the % of a GP practice's patients on a disease register, or prescription items per 1,000 patients.</li>
      <li><strong>Percentile rank</strong> — this is the "unified scale" feature: instead of the raw number, you see where an area ranks from
      0 (lowest in England &amp; Wales) to 100 (highest), regardless of the indicator's real units. This is what makes very different diseases
      directly comparable on one colour scale. For example, an area might sit at the ${chdEx ? chdEx.pctile + "th" : "80th"} percentile for
      ${chdEx ? chdEx.label.toLowerCase() : "coronary heart disease"} (raw rate ${chdEx ? chdEx.raw : "2.0"}${chdEx ? "" : "%"}) while sitting at only the
      ${statinsEx ? statinsEx.pctile + "th" : "40th"} percentile for ${statinsEx ? statinsEx.label.toLowerCase() : "statins prescribing"}
      (raw rate ${statinsEx ? statinsEx.raw : "0.97"}) — two numbers on totally different scales, now directly comparable as percentile ranks.
      Colours use the <strong>Viridis</strong> palette (dark purple → blue → green → yellow), chosen because it's verified colourblind-safe and reads correctly
      in greyscale print.</li>
      <li><strong>Year-on-year change</strong> — the % change in the raw rate between the two most recent years available, calculated as
      (this year − last year) ÷ last year. Positive = rising, negative = falling. Only available for indicators with an annual time series
      (the 8 QOF conditions and frailty).</li>
      <li><strong>Change vs. typical (z-score)</strong> — some conditions naturally shift faster or slower year to year than others, so the same
      1-percentage-point change can be "huge" for a slow-moving condition and "unremarkable" for a fast-moving one. This standardises the year-on-year
      change by how much that specific condition typically varies across all areas: <code>z = (this area's change − average change everywhere) ÷ standard deviation of change everywhere</code>.
      A z-score of 0 is exactly typical; +2 means a much faster rise than almost anywhere else; -2 a much sharper fall.</li>
      <li><strong>Age-adjusted ratio</strong> — see the dedicated section below. In short: <code>observed rate ÷ rate expected from local age profile alone</code>.
      1.0 = exactly as expected given how old the area's population is; above 1.0 = a genuinely higher burden than age explains; below 1.0 = lower.</li>
    </ul>

    <h3>Age-adjustment — what it is, and importantly, what it is not</h3>
    <p>Older populations naturally have higher rates of most of these conditions — and are prescribed more of these medicines — so a simple map of raw
    rates partly just shows "where older people live." To separate that mechanical effect from genuine clustering, this dashboard also shows population
    aged 65+ (its own map layer) and an <strong>age-adjusted ratio</strong> for the 8 QOF conditions and 6 prescribing indicators.</p>
    <p><strong>Important limitation:</strong> a fully rigorous directly age-standardised rate needs age-<em>specific</em> rates — e.g. a separate
    prevalence or prescribing figure for ages 65–74, 75–84, 85+, computed for each area — re-weighted onto a standard population. Neither NHS QOF nor
    NHSBSA prescribing data publishes an age-specific breakdown at LSOA level, so a true directly-standardised rate cannot be computed from this
    source. Two other routes were investigated and deliberately not used, because each would produce a number that <em>looks</em> like a certified
    age-standardised rate without being one: Health Survey for England has genuinely age-specific prevalence for some conditions, but it's
    self-reported survey diagnosis, not GP disease-register counts — a different measurement system than QOF; and the old APHO/PHE "expected
    prevalence" models built for exactly this kind of comparison appear to be discontinued 2008–2013-era models, too stale to apply to current data.</p>
    <p>What's shown instead is an <strong>indirect-standardisation-style ratio</strong>, using every local age band this data supports: a multiple
    regression of each condition's rate against the local population share in four age bands (16–29, 30–44, 45–64, 65+; 0–15 is the implicit
    reference category) across every LSOA in England, then <code>ratio = observed rate ÷ rate the regression predicts from this area's full age
    profile</code>. This is an upgrade from an earlier version of this dashboard that used only % aged 65+ as a single covariate — using the complete
    local age structure captures more of the real age-driven variation (R² improved for every single indicator when this was tested, e.g. atrial
    fibrillation's rose from 0.53 to 0.56, statins prescribing's from 0.07 to 0.10) — but it's still a regression-based proxy, not age-specific
    rates re-weighted onto a standard population. Treat it as a genuinely useful, transparent approximation, not an official age-standardised
    statistic.</p>

    <h3>National trends over time, and NHS commissioning reforms</h3>
    <p>These charts show the England-wide average (and 10th–90th percentile spread) for each condition with a multi-year series, with vertical dashed
    lines marking two major NHS structural reforms that changed how regional medical resources are commissioned and allocated:</p>
    <ul>${reformRows}</ul>
    <p>These lines are shown for context only — a change in the trend around a reform date is not evidence the reform caused it; many other things
    change every year too. Click "📈 Trend" next to any condition in an area's profile (after clicking that area on the map) to see that specific
    area's own trajectory rather than the national average.</p>
    <div class="national-trends-grid">${nationalTrendCharts}</div>

    <h3>Reform-year impact: was the change unusual, and unusually uneven across regions?</h3>
    <p>For every indicator with data near a reform year, this compares that specific year's national change — and, more importantly, how
    <em>differently areas moved from each other</em> that year (the cross-region standard deviation of change) — against what's typical for that same
    indicator in other years. A heterogeneity ratio above 1× means that year was more regionally uneven than usual for this indicator; below 1× means
    it was more uniform than usual. This is exactly the kind of comparison a commissioner might use to ask "did this reform coincide with some regions
    pulling away from others?" — a computed answer, not a visual impression from a chart.</p>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Indicator</th><th>Reform year</th><th>National mean change</th><th>Regional heterogeneity</th><th>Reading</th></tr></thead>
        <tbody>${reformImpactTableRows}</tbody>
      </table>
    </div>
    <p class="modal-lede" style="margin-top:10px;"><strong>Read this as descriptive, not causal.</strong> A high heterogeneity ratio says regions
    moved unusually differently from each other that year — it does not by itself say the reform caused that, since other things (weather, local
    outbreaks, coding changes, staffing) also vary year to year. Atrial fibrillation's 2013 ratio (2.13×) is the most striking figure in this table —
    worth a specific look if you're investigating that reform's regional effects — but treat every row as a lead worth investigating, not a proven
    effect.</p>

    <h3>Why some data only covers England</h3>
    <p>QOF disease-prevalence indicators, NHS prescribing indicators, and the Small Area Frailty Index are all sourced from NHS England / NHS Business
    Services Authority systems, which do not cover Wales — health data collection is devolved. A small number of Welsh LSOAs near the border do appear
    with values, because some residents are registered with English GP practices; the rest show "No data" for these layers, which is the honest state
    of public data availability, not a gap in this dashboard. Wales does not publish LSOA-level clinical disease-register prevalence in the public domain
    at the time of writing (finest published granularity found was GP practice / cluster / health board, via StatsWales). Instead, this dashboard uses
    Wales's own official small-area health measure — the WIMD 2019 Health Domain score — which <strong>is</strong> published at LSOA level.</p>

    <h3>England vs Wales deprivation scores are not directly comparable</h3>
    <p>England's IMD Health Deprivation &amp; Disability score and Wales's WIMD2019 Health Domain score are each constructed from different underlying
    indicators, on different scales, calculated independently by MHCLG and the Welsh Government respectively. Both are shown because both are the
    official small-area health-deprivation measure for their nation, but a numeric value in one nation is not equivalent to the same number in the other.</p>
    <p>England's score is shown for its two most recent editions — <strong>IMD2025</strong> (the current raw-value layer) and <strong>IMD2019</strong> —
    plus the change between them, so you can see how an area's relative deprivation has shifted. Treat that change with real caution: see
    "📈 Compare &amp; Forecast" for why a 2019→2025 change is a rougher comparison than the Census change above it. Wales's WIMD2025 also exists, but its
    raw domain scores aren't available as a public bulk download at the time of writing (the new StatsWales platform only exposes ranks/quintile
    groups through an interactive query tool, not a downloadable score) — so Wales here still shows WIMD2019 only.</p>

    <h3>Full source list</h3>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Indicator</th><th>Dataset</th><th>Publisher</th><th>Reference year</th><th>Coverage</th><th></th></tr></thead>
        <tbody>${sourceRows}</tbody>
      </table>
    </div>

    <h3>Geographic boundaries &amp; population data</h3>
    <p><strong>${BOUNDARY_SOURCE.dataset}</strong>, published by ${BOUNDARY_SOURCE.publisher}.
    ${BOUNDARY_SOURCE.note} Boundaries are simplified (generalised to 200m and further Douglas-Peucker simplified) for web performance —
    not suitable for precise spatial analysis. <a href="${BOUNDARY_SOURCE.url}" target="_blank" rel="noopener">Source ↗</a></p>
    <p>LSOA→MSOA→Local Authority linkage: <strong>${LOOKUP_SOURCE.dataset}</strong>, ${LOOKUP_SOURCE.publisher}.
    <a href="${LOOKUP_SOURCE.url}" target="_blank" rel="noopener">Source ↗</a></p>
    <p>Population by age (for the age-adjustment feature): <strong>${LOOKUP21_SOURCE.dataset}</strong>, ${LOOKUP21_SOURCE.publisher}.
    ${LOOKUP21_SOURCE.note} <a href="${LOOKUP21_SOURCE.url}" target="_blank" rel="noopener">Source ↗</a></p>

    <h3>Methodology notes</h3>
    <ul>
      <li><strong>Raw rate</strong> shows only the latest available period per indicator (year shown per indicator above); the year-on-year change and
      z-score use the two most recent years, and the trend charts use every year available in the source archive (back to 2005 for some QOF conditions).</li>
      <li><strong>Prescribing rates</strong> use the source data's own pre-calculated "items per 1,000 patients" rate field; see each PLDR indicator specification (linked from its dataset page) for the exact denominator methodology. Prescribing's annual series uses each year's last available quarter (Q4, where published) as that year's snapshot, so it's comparable year-to-year the same way QOF's genuinely-annual data is.</li>
      <li><strong>Why deprivation scores don't get the same trend/z-score/age-adjusted treatment as QOF and prescribing</strong> — deprivation indices are composite, rank-based indices rebuilt from scratch each edition (new indicators, new weights), unlike QOF's genuinely repeated annual measurement of the same thing. England's IMD2019→2025 change (below, and in "📈 Compare &amp; Forecast") is offered as a rough, honestly-caveated comparison — not a real year-on-year series, so it doesn't get a z-score or age-adjustment either. Wales's WIMD2019 is a single edition with no newer comparable data available (see above), so it gets no change view at all. ONS/Welsh Government guidance explicitly warns against comparing scores or ranks <em>across</em> editions for exactly this reason — a rank can shift simply because other areas changed relative to it, not because the area itself did.</li>
      <li><strong>QOF prevalence</strong> is the percentage of a GP practice's registered patients on that condition's disease register, apportioned to LSOA by the home postcodes of registered patients — these are modelled small-area estimates, not direct counts, and carry the uncertainty that implies.</li>
      <li><strong>Frailty</strong> is published at Middle Super Output Area (MSOA) level — roughly 4–5 LSOAs per MSOA — and has been broadcast unchanged to every LSOA within each MSOA so it can be shown on this LSOA-level map. It should be read at MSOA resolution, not interpreted as LSOA-specific.</li>
      <li><strong>Colour classes</strong> are quintiles (five equal-count bins) computed independently per indicator and per view mode across all LSOAs with data, using the 2011 LSOA geography.</li>
      <li><strong>Extreme year-on-year % changes</strong> (occasionally very large positive or negative numbers) usually come from areas with a very small underlying patient count, where a handful of patients moving in or out of a disease register creates a large relative swing. The percentile and z-score views are less sensitive to this than the raw % change figure.</li>
      <li><strong>Small numbers</strong> in NHS source data are sometimes suppressed or rounded for disclosure control; areas affected show as "No data" here rather than a potentially unreliable figure.</li>
    </ul>

    <h3>Licensing &amp; attribution</h3>
    <p>All datasets are published under the <a href="https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/" target="_blank" rel="noopener">Open Government Licence v3.0</a>
    or equivalent open terms. Contains public sector information licensed under the Open Government Licence v3.0. Contains OS data © Crown copyright and database right.
    This dashboard itself is an independent, non-commercial prototype.</p>

    <h3>Accessibility</h3>
    <p>Map colours use either a single-hue sequential scale, the Viridis colourblind-safe palette, or a blue↔red diverging scale depending on view
    mode — all chosen and checked for colour-vision-deficiency safety. All map information (indicator, value, area name) is also available as text via
    hover tooltips, the click-through detail panel, and the search box — colour is never the only way to read a value.
    If you need this data in another format, use the source links above to access the original published tables directly.</p>

    <h3>Last updated</h3>
    <p>This dataset was last rebuilt <strong>${lastUpdatedText}</strong>. A scheduled job re-checks every source above weekly and automatically rebuilds
    and redeploys this site if anything upstream has changed — the "reference year" column in the table above always reflects whatever period was
    actually current in the source data at that most recent rebuild, not a fixed date written into this page.</p>
  `;
}

function pickExampleIndicator(key) {
  for (const code in state.data) {
    const rec = state.data[code];
    const raw = getVal(rec, key, "raw");
    const pctile = getVal(rec, key, "pctile");
    if (raw !== undefined && pctile !== undefined) {
      return { label: state.meta.indicators[key].label, raw, pctile: Math.round(pctile) };
    }
  }
  return null;
}

function buildNationalTrendChart(key) {
  const nt = state.meta.national_trends[key];
  const m = state.meta.indicators[key];
  const W = 300, H = 120, padL = 34, padR = 10, padT = 14, padB = 22;
  const plotW = W - padL - padR, plotH = H - padT - padB;

  const allVals = [...nt.p10, ...nt.p90].filter((v) => v !== null);
  const yMin = Math.min(...allVals), yMax = Math.max(...allVals);
  const yRange = yMax - yMin || 1;
  const xMin = nt.years[0], xMax = nt.years[nt.years.length - 1];
  const xRange = xMax - xMin || 1;
  const xPos = (y) => padL + ((y - xMin) / xRange) * plotW;
  const yPos = (v) => padT + plotH - ((v - yMin) / yRange) * plotH;

  const bandPath = nt.years.map((y, i) => `${i === 0 ? "M" : "L"}${xPos(y).toFixed(1)},${yPos(nt.p90[i]).toFixed(1)}`).join(" ") +
    " " + nt.years.slice().reverse().map((y, i) => `L${xPos(y).toFixed(1)},${yPos(nt.p10[nt.p10.length - 1 - i]).toFixed(1)}`).join(" ") + " Z";
  const meanPath = nt.years.map((y, i) => `${i === 0 ? "M" : "L"}${xPos(y).toFixed(1)},${yPos(nt.mean[i]).toFixed(1)}`).join(" ");

  const reformLines = (state.meta.reform_years || [])
    .filter((r) => r.year >= xMin && r.year <= xMax)
    .map((r) => `<line x1="${xPos(r.year).toFixed(1)}" y1="${padT}" x2="${xPos(r.year).toFixed(1)}" y2="${padT + plotH}" stroke="var(--text-muted)" stroke-dasharray="2,2" stroke-width="1" />`)
    .join("");

  return `
    <div class="national-trend-card">
      <div class="national-trend-title">${m.label}</div>
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${m.label} national trend">
        <path d="${bandPath}" fill="var(--accent)" opacity="0.12" stroke="none" />
        ${reformLines}
        <path d="${meanPath}" fill="none" stroke="var(--accent)" stroke-width="1.5" />
        <text x="${padL - 4}" y="${padT + 4}" font-size="8" fill="var(--text-muted)" text-anchor="end">${fmtAxis(yMax)}</text>
        <text x="${padL - 4}" y="${padT + plotH}" font-size="8" fill="var(--text-muted)" text-anchor="end">${fmtAxis(yMin)}</text>
        <text x="${padL}" y="${H - 6}" font-size="8" fill="var(--text-muted)" text-anchor="start">${xMin}</text>
        <text x="${W - padR}" y="${H - 6}" font-size="8" fill="var(--text-muted)" text-anchor="end">${xMax}</text>
      </svg>
      <p class="national-trend-caption">England mean (line) &amp; 10th–90th percentile spread (shaded), ${m.unit}</p>
    </div>
  `;
}

// ============================================================================
// "Compare & Forecast" — cross-year Census comparison + simple trend forecasts
// ============================================================================

// Ordinary least-squares linear trend, fit on whatever years are available,
// extrapolated `horizon` years past the last observed year. This is
// deliberately the simplest defensible forecasting method rather than
// something like ARIMA or exponential smoothing: it's fully transparent
// (a straight line through the historical trend), matching the "how did we
// get this number" standard the rest of this dashboard holds itself to.
// See the Method & references section in the modal for the citation and
// the caveats that come with any naive trend extrapolation.
function computeLinearForecast(years, values, horizon) {
  const pts = years.map((y, i) => ({ x: y, y: values[i] })).filter((p) => p.y !== null && p.y !== undefined && isFinite(p.y));
  if (pts.length < 4) return null; // too few points for a defensible fit

  const n = pts.length;
  const meanX = pts.reduce((s, p) => s + p.x, 0) / n;
  const meanY = pts.reduce((s, p) => s + p.y, 0) / n;
  let num = 0, den = 0;
  pts.forEach((p) => { num += (p.x - meanX) * (p.y - meanY); den += (p.x - meanX) ** 2; });
  const slope = den === 0 ? 0 : num / den;
  const intercept = meanY - slope * meanX;

  let ssResid = 0;
  pts.forEach((p) => { const pred = intercept + slope * p.x; ssResid += (p.y - pred) ** 2; });
  const se = Math.sqrt(ssResid / Math.max(n - 2, 1));

  const lastYear = years[years.length - 1];
  const fYears = [], fValues = [], fLow = [], fHigh = [];
  for (let i = 1; i <= horizon; i++) {
    const x0 = lastYear + i;
    const pred = intercept + slope * x0;
    // Standard prediction-interval formula for a new observation from a
    // fitted simple linear regression (widens the further x0 is from the
    // years actually observed) — a 95% interval, z = 1.96.
    const sePred = se * Math.sqrt(1 + 1 / n + ((x0 - meanX) ** 2) / (den || 1));
    fYears.push(x0);
    fValues.push(pred);
    fLow.push(pred - 1.96 * sePred);
    fHigh.push(pred + 1.96 * sePred);
  }
  return { slope, nPoints: n, years: fYears, values: fValues, low: fLow, high: fHigh };
}

const FORECAST_HORIZON = 3;

// ----------------------------------------------------------------------
// Snapshot-comparison chart (Census 2011→2021, IMD 2019→latest edition):
// a real line chart of the actual national distribution at each snapshot,
// not just a single before/after number. The shaded band is the 10th-90th
// percentile range across every LSOA at that snapshot — most areas fall
// somewhere in that band, not on the mean line — so a reader sees the
// spread of the real data, not one summary statistic standing in for it.
// ----------------------------------------------------------------------
function buildComparisonChartSVG(comp, opts) {
  const { unit = "", flatMeanNote = null } = opts || {};
  const labels = comp.labels;
  const n = labels.length;
  if (n < 2 || comp.mean.some((v) => v === null)) {
    return `<p class="nodata">Not enough data to chart this comparison.</p>`;
  }

  const W = 560, H = 240, padL = 52, padR = 20, padT = 26, padB = 34;
  const plotW = W - padL - padR, plotH = H - padT - padB;

  const allVals = [...comp.p10, ...comp.p90];
  let yMin = Math.min(...allVals), yMax = Math.max(...allVals);
  const pad = (yMax - yMin) * 0.18 || Math.abs(yMax) * 0.1 || 1;
  yMin -= pad; yMax += pad;
  const yRange = yMax - yMin || 1;

  const xPos = (i) => padL + (i / (n - 1)) * plotW;
  const yPos = (v) => padT + plotH - ((v - yMin) / yRange) * plotH;

  const bandTop = labels.map((_, i) => `${i === 0 ? "M" : "L"}${xPos(i).toFixed(1)},${yPos(comp.p90[i]).toFixed(1)}`).join(" ");
  const bandBottom = labels.slice().reverse().map((_, k) => {
    const i = n - 1 - k;
    return `L${xPos(i).toFixed(1)},${yPos(comp.p10[i]).toFixed(1)}`;
  }).join(" ");
  const bandPath = `${bandTop} ${bandBottom} Z`;

  const meanPath = labels.map((_, i) => `${i === 0 ? "M" : "L"}${xPos(i).toFixed(1)},${yPos(comp.mean[i]).toFixed(1)}`).join(" ");

  const markers = labels.map((lab, i) => {
    const above = i === 0 ? -14 : -14;
    return `
    <circle cx="${xPos(i).toFixed(1)}" cy="${yPos(comp.mean[i]).toFixed(1)}" r="4.5" fill="var(--accent)" stroke="var(--surface, #1a1a1a)" stroke-width="1.5" />
    <text x="${xPos(i).toFixed(1)}" y="${(yPos(comp.mean[i]) + above).toFixed(1)}" font-size="12" font-weight="700" fill="var(--text-primary, #f2f2f2)" text-anchor="middle">${fmtAxis(comp.mean[i])}${unit}</text>
    <text x="${xPos(i).toFixed(1)}" y="${H - 10}" font-size="11" fill="var(--text-muted)" text-anchor="middle">${lab}</text>
  `;
  }).join("");

  const bandLabels = labels.map((_, i) => `
    <text x="${xPos(i).toFixed(1)}" y="${(yPos(comp.p90[i]) - 6).toFixed(1)}" font-size="9" fill="var(--text-muted)" text-anchor="middle">${fmtAxis(comp.p90[i])}${unit}</text>
    <text x="${xPos(i).toFixed(1)}" y="${(yPos(comp.p10[i]) + 12).toFixed(1)}" font-size="9" fill="var(--text-muted)" text-anchor="middle">${fmtAxis(comp.p10[i])}${unit}</text>
  `).join("");

  const midX = padL + plotW / 2;
  const midMean = (comp.mean[0] + comp.mean[n - 1]) / 2;
  const noteEl = flatMeanNote
    ? `<text x="${midX.toFixed(1)}" y="${(yPos(midMean) - 22).toFixed(1)}" font-size="10" fill="var(--series-orange, #eb6834)" text-anchor="middle">${flatMeanNote}</text>`
    : "";

  return `
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Comparison of ${labels.join(" vs ")}" style="width:100%;height:auto;">
      <path d="${bandPath}" fill="var(--accent)" opacity="0.16" stroke="none" />
      <path d="${meanPath}" fill="none" stroke="var(--accent)" stroke-width="2.5" />
      ${bandLabels}
      ${markers}
      ${noteEl}
    </svg>
  `;
}

function buildComparisonStatsTable(comp, unit) {
  const rows = comp.labels.map((lab, i) => `
    <tr>
      <td>${lab}</td>
      <td>${fmtAxis(comp.p10[i])}${unit}</td>
      <td>${fmtAxis(comp.median[i])}${unit}</td>
      <td>${fmtAxis(comp.mean[i])}${unit}</td>
      <td>${fmtAxis(comp.p90[i])}${unit}</td>
      <td>${comp.n[i].toLocaleString()}</td>
    </tr>
  `).join("");
  return `
    <div class="table-wrap">
      <table>
        <thead><tr><th></th><th>10th percentile</th><th>Median</th><th>Mean</th><th>90th percentile</th><th>LSOAs</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

function buildForecastChartSVG(key) {
  const nt = state.meta.national_trends[key];
  const m = state.meta.indicators[key];
  if (!nt) return `<p class="nodata">No multi-year series available for this indicator.</p>`;

  const forecast = computeLinearForecast(nt.years, nt.mean, FORECAST_HORIZON);
  const W = 520, H = 220, padL = 44, padR = 14, padT = 18, padB = 30;
  const plotW = W - padL - padR, plotH = H - padT - padB;

  const allHistVals = [...nt.p10, ...nt.p90].filter((v) => v !== null);
  const allVals = forecast ? [...allHistVals, ...forecast.low, ...forecast.high] : allHistVals;
  const yMin = Math.min(...allVals), yMax = Math.max(...allVals);
  const yRange = (yMax - yMin) || 1;
  const xMin = nt.years[0];
  const xMax = forecast ? forecast.years[forecast.years.length - 1] : nt.years[nt.years.length - 1];
  const xRange = (xMax - xMin) || 1;
  const xPos = (y) => padL + ((y - xMin) / xRange) * plotW;
  const yPos = (v) => padT + plotH - ((v - yMin) / yRange) * plotH;

  const bandPath = nt.years.map((y, i) => `${i === 0 ? "M" : "L"}${xPos(y).toFixed(1)},${yPos(nt.p90[i]).toFixed(1)}`).join(" ") +
    " " + nt.years.slice().reverse().map((y, i) => `L${xPos(y).toFixed(1)},${yPos(nt.p10[nt.p10.length - 1 - i]).toFixed(1)}`).join(" ") + " Z";
  const meanPath = nt.years.map((y, i) => `${i === 0 ? "M" : "L"}${xPos(y).toFixed(1)},${yPos(nt.mean[i]).toFixed(1)}`).join(" ");

  let forecastBand = "", forecastLine = "", forecastLabel = "";
  if (forecast) {
    const lastYear = nt.years[nt.years.length - 1];
    const lastMean = nt.mean[nt.mean.length - 1];
    const fYearsWithAnchor = [lastYear, ...forecast.years];
    const fLowWithAnchor = [lastMean, ...forecast.low];
    const fHighWithAnchor = [lastMean, ...forecast.high];
    forecastBand = fYearsWithAnchor.map((y, i) => `${i === 0 ? "M" : "L"}${xPos(y).toFixed(1)},${yPos(fHighWithAnchor[i]).toFixed(1)}`).join(" ") +
      " " + fYearsWithAnchor.slice().reverse().map((y, i) => `L${xPos(y).toFixed(1)},${yPos(fLowWithAnchor[fLowWithAnchor.length - 1 - i]).toFixed(1)}`).join(" ") + " Z";
    forecastLine = [lastYear, ...forecast.years].map((y, i) => `${i === 0 ? "M" : "L"}${xPos(y).toFixed(1)},${yPos([lastMean, ...forecast.values][i]).toFixed(1)}`).join(" ");
    forecastLabel = `<text x="${xPos(forecast.years[forecast.years.length - 1]).toFixed(1)}" y="${yPos(forecast.values[forecast.values.length - 1]) - 8}" font-size="9" fill="var(--series-orange, #eb6834)" text-anchor="end">forecast →</text>`;
  }

  const reformLines = (state.meta.reform_years || [])
    .filter((r) => r.year >= xMin && r.year <= nt.years[nt.years.length - 1])
    .map((r) => `<line x1="${xPos(r.year).toFixed(1)}" y1="${padT}" x2="${xPos(r.year).toFixed(1)}" y2="${padT + plotH}" stroke="var(--text-muted)" stroke-dasharray="2,2" stroke-width="1" />`)
    .join("");

  const yearLabels = [xMin, nt.years[nt.years.length - 1], xMax].filter((v, i, a) => a.indexOf(v) === i)
    .map((y) => `<text x="${xPos(y).toFixed(1)}" y="${H - 8}" font-size="9" fill="var(--text-muted)" text-anchor="middle">${y}</text>`).join("");

  return `
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${m.label} historical trend and ${FORECAST_HORIZON}-year forecast" style="width:100%;height:auto;">
      <path d="${bandPath}" fill="var(--accent)" opacity="0.12" stroke="none" />
      ${forecast ? `<path d="${forecastBand}" fill="#eb6834" opacity="0.12" stroke="none" />` : ""}
      ${reformLines}
      <path d="${meanPath}" fill="none" stroke="var(--accent)" stroke-width="2" />
      ${forecast ? `<path d="${forecastLine}" fill="none" stroke="#eb6834" stroke-width="2" stroke-dasharray="5,4" />` : ""}
      ${forecastLabel}
      <text x="${padL - 6}" y="${padT + 4}" font-size="9" fill="var(--text-muted)" text-anchor="end">${fmtAxis(yMax)}</text>
      <text x="${padL - 6}" y="${padT + plotH}" font-size="9" fill="var(--text-muted)" text-anchor="end">${fmtAxis(yMin)}</text>
      ${yearLabels}
    </svg>
  `;
}

function renderForecastChart(key) {
  const holder = $("#forecastChartHolder");
  const m = state.meta.indicators[key];
  const forecast = computeLinearForecast(state.meta.national_trends[key].years, state.meta.national_trends[key].mean, FORECAST_HORIZON);
  holder.innerHTML = buildForecastChartSVG(key);

  const notesEl = $("#forecastNotes");
  if (!forecast) {
    notesEl.innerHTML = `<p class="nodata">Not enough historical data points for ${m.label} to fit a trend line.</p>`;
    return;
  }
  const direction = forecast.slope > 0 ? "rising" : forecast.slope < 0 ? "falling" : "flat";
  const lastForecast = forecast.values[forecast.values.length - 1];
  const lastYear = forecast.years[forecast.years.length - 1];
  const lastLow = forecast.low[forecast.low.length - 1];
  const lastHigh = forecast.high[forecast.high.length - 1];
  notesEl.innerHTML = `
    <p><strong>${m.label}</strong> has been ${direction} nationally by about
    <strong>${Math.abs(forecast.slope).toFixed(3)} ${m.unit} per year</strong> on average (simple linear trend fit across
    ${forecast.nPoints} years of data). Extrapolating that straight line forward, ${lastYear} would be roughly
    <strong>${fmtAxis(lastForecast)} ${m.unit}</strong> — with a wide plausible range of
    <strong>${fmtAxis(lastLow)} to ${fmtAxis(lastHigh)}</strong> even under this simple model.</p>
    <p class="modal-lede" style="margin-top:10px;"><strong>This is a naive trend extrapolation, not a real forecast.</strong>
    It only knows "the line went this way before" — it has no idea about future NHS reforms, funding changes, new
    treatments, or events like a pandemic, all of which have visibly bent these lines in the past (see the dashed
    reform markers). Treat the shaded band as "plausible if absolutely nothing changes," not a prediction anyone
    should plan around.</p>
  `;
}

function buildForecastModal() {
  const body = $("#forecastModalBody");

  // National census summary, computed live from the loaded per-LSOA data
  // (population-weighting isn't attempted here — this is a simple mean
  // across LSOAs, each treated equally regardless of population size).
  let sum2011 = 0, n2011 = 0, sum2021 = 0, n2021 = 0;
  for (const code in state.data) {
    const rec = state.data[code];
    const v11 = getVal(rec, "census2011_health", "raw");
    const v21 = getVal(rec, "census2021_health", "raw");
    if (v11 !== undefined) { sum2011 += v11; n2011++; }
    if (v21 !== undefined) { sum2021 += v21; n2021++; }
  }
  const mean2011 = sum2011 / n2011, mean2021 = sum2021 / n2021;
  const censusChange = mean2021 - mean2011;

  // England's two most recent deprivation editions — deliberately NOT shown
  // as a national mean-vs-mean comparison like the Census above. IMD scores
  // are constructed so the England-wide mean sits near zero in every single
  // edition (it's a standardised score, not a measured quantity like %
  // reporting bad health) — so a "mean 2019 vs mean 2025" comparison would
  // be near-zero *by construction*, regardless of what actually happened,
  // and would misleadingly look like "no change" either way. What's
  // actually meaningful is whether areas kept their relative position:
  // the correlation between an LSOA's 2019 and 2025 score, and how many
  // areas' relative score rose (worse) vs fell (better).
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0, nImd = 0, nWorse = 0, nBetter = 0;
  for (const code in state.data) {
    const rec = state.data[code];
    const v19 = getVal(rec, "imd_health_en_2019", "raw");
    const v25 = getVal(rec, "imd_health_en", "raw");
    if (v19 !== undefined && v25 !== undefined) {
      sumX += v19; sumY += v25; sumXY += v19 * v25; sumX2 += v19 * v19; sumY2 += v25 * v25; nImd++;
      if (v25 > v19) nWorse++; else if (v25 < v19) nBetter++;
    }
  }
  const meanX = sumX / nImd, meanY = sumY / nImd;
  const covXY = sumXY / nImd - meanX * meanY;
  const varX = sumX2 / nImd - meanX * meanX, varY = sumY2 / nImd - meanY * meanY;
  const imdCorr = covXY / Math.sqrt(varX * varY);
  const pctWorse = (nWorse / nImd) * 100, pctBetter = (nBetter / nImd) * 100;

  const trendKeys = Object.keys(state.meta.indicators).filter((k) => state.meta.indicators[k].has_trend);
  const trendOptions = trendKeys.map((k) =>
    `<option value="${k}">${state.meta.indicators[k].label}</option>`
  ).join("");

  body.innerHTML = `
    <h2 id="forecastTitle">📈 Compare & Forecast</h2>
    <p class="modal-lede">Two things live here: a genuine like-for-like comparison across the two most recent UK Censuses,
    and simple statistical trend projections for the indicators with a multi-year history. Both come with full
    citations and honest caveats — nothing here should be read as a certain prediction.</p>

    <h3>Census 2011 vs 2021: has self-reported health changed?</h3>
    <p>Both censuses asked the same question — <em>"How is your health in general?"</em> — on the same five-point scale
    (Very good / Good / Fair / Bad / Very bad), a decade apart. That shared wording and scale is what makes this a
    genuinely valid comparison, unlike the deprivation indices elsewhere in this dashboard. Census only happens once a
    decade, so there genuinely are only two real data points here — 2011 and 2021 — no in-between years exist to plot;
    the chart below shows exactly those two, not an interpolation.</p>
    <p><strong>How to read this chart:</strong> each dot is the England &amp; Wales average % of people reporting bad or
    very bad health that census year. The shaded band is <em>not</em> a margin of error — it's the actual range within
    which the middle 80% of neighbourhoods fall (the 10th to 90th percentile), so you can see that most LSOAs sit
    somewhere inside that band, not exactly on the average line.</p>
    <div class="forecast-chart-holder">${buildComparisonChartSVG(state.meta.national_comparisons.census_general_health, { unit: "%" })}</div>
    ${buildComparisonStatsTable(state.meta.national_comparisons.census_general_health, "%")}
    <p>Both the average <em>and</em> the spread narrowed slightly between 2011 and 2021 — the whole distribution shifted
    towards better self-reported health, not just the headline average. This is also on the map itself — look for the
    <strong>"Census: self-reported health"</strong> group in the sidebar, with 2011, 2021, and the change between them as
    three separate layers you can explore area-by-area.</p>

    <h3>England deprivation: IMD2019 vs IMD2025 (use with caution)</h3>
    <p>Unlike the Census comparison above, this one comes with a real methodological catch, stated plainly:
    <strong>MHCLG rebuilds the Index of Multiple Deprivation from scratch each edition</strong> — the underlying indicators,
    data sources and weightings within the Health Deprivation &amp; Disability domain were revised between 2019 and 2025.
    So a change in this score is a mix of <em>genuine change in an area's relative health deprivation</em> and
    <em>changes in how the index itself is built</em> — and there is no way to cleanly separate the two from the published
    scores alone. MHCLG's own guidance is that IMD scores and ranks are designed to compare areas <em>within the same
    edition</em>, not across editions. Read the figures below as suggestive context, not a validated trend the way the
    Census comparison is.</p>
    <p><strong>How to read this chart</strong> — read the <em>band width</em>, not the line height. The solid line is the
    England mean, and it barely moves, because IMD scores are standardised so the national mean sits near zero in
    <em>every single edition</em> — that's a property of how the score is built, not a measurement of anything. Plotting
    it isn't meaningless, though: what genuinely can shift is the <strong>shaded band</strong> — the range covering the
    middle 80% of LSOAs. A wider band means a bigger gap between England's least and most deprived neighbourhoods; a
    narrower one means less inequality between them. That gap is not fixed by the scoring method, so a real change
    there is a real finding.</p>
    <div class="forecast-chart-holder">${buildComparisonChartSVG(state.meta.national_comparisons.imd_health_en, { unit: "", flatMeanNote: "↑ mean pinned near 0 by design — read the band, not this line" })}</div>
    ${buildComparisonStatsTable(state.meta.national_comparisons.imd_health_en, "")}
    <p>The band widened slightly between 2019 and ${state.meta.indicators.imd_health_en.year} — a small increase in the
    gap between England's most and least health-deprived neighbourhoods — though remember this mixes any real change
    with the effect of MHCLG's methodology revision, so treat it as suggestive, not proof of rising inequality.</p>
    <p>The chart above describes the shape of the whole distribution; a different, equally valid question is whether
    <em>individual</em> areas kept their relative position within it:</p>
    <div class="census-stat-row">
      <div class="census-stat"><div class="census-stat-label">Correlation (r)</div><div class="census-stat-value">${imdCorr.toFixed(2)}</div><div class="census-stat-sub">2019 vs 2025 score, across ${nImd.toLocaleString()} LSOAs</div></div>
      <div class="census-stat"><div class="census-stat-label">Relatively worse</div><div class="census-stat-value">${pctWorse.toFixed(1)}%</div><div class="census-stat-sub">of LSOAs' score rose (higher = more deprived)</div></div>
      <div class="census-stat"><div class="census-stat-label">Relatively better</div><div class="census-stat-value">${pctBetter.toFixed(1)}%</div><div class="census-stat-sub">of LSOAs' score fell</div></div>
    </div>
    <p>A correlation this close to 1 means most areas' <em>relative</em> position barely moved — expected, since
    deprivation is strongly geographically persistent — but it still mixes real local change with the effect of
    MHCLG's methodology revision, so don't read even this as a clean "X% of England got worse."</p>
    <p>England-only (Wales has no comparable newer edition available — see below). Also on the map: the
    <strong>"Deprivation"</strong> group in the sidebar now has three England layers — 2025, 2019, and the change between
    them — alongside Wales's WIMD2019.</p>
    <p class="modal-lede" style="margin-top:10px;"><strong>Wales's WIMD2025 exists but isn't usable here.</strong> The Welsh
    Government published WIMD2025 on the new StatsWales platform, but at the time of writing it only exposes ranks and
    quintile groups through an interactive, JavaScript-driven query tool — not a downloadable file of raw domain scores
    (unlike WIMD2019, which was published as a plain spreadsheet). Rather than fabricate a Wales comparison from
    incomplete data, this dashboard simply doesn't show one. If Stats Wales publishes a bulk download in future, this is
    the one gap here that's an access problem, not a methodological one.</p>

    <h3>Simple trend forecasts</h3>
    <p>Pick an indicator to see its England-wide trend and a ${FORECAST_HORIZON}-year projection:</p>
    <select id="forecastIndicatorPicker" class="forecast-picker">${trendOptions}</select>
    <div id="forecastChartHolder" class="forecast-chart-holder"></div>
    <div id="forecastNotes"></div>

    <h3>Method &amp; full references</h3>
    <ul>
      <li><strong>Forecasting method:</strong> ordinary least-squares linear regression fit to the full available annual
      series, extrapolated ${FORECAST_HORIZON} years past the last observed year, with a standard prediction interval
      (95%) that widens the further the forecast extends — the same textbook approach as
      <a href="${FORECAST_REFERENCE.url}" target="_blank" rel="noopener">${FORECAST_REFERENCE.authors} — <em>${FORECAST_REFERENCE.title}</em></a>,
      a freely available open-access textbook, describes as the simplest defensible trend-extrapolation model. More
      sophisticated approaches exist (exponential smoothing, ARIMA, structural break detection around known reforms) —
      deliberately not used here, in favour of a method any reader can sanity-check by eye against the chart.</li>
      <li><strong>Census 2011 general health:</strong> <a href="${SOURCE_CITATIONS.census2011_health.url}" target="_blank" rel="noopener">${SOURCE_CITATIONS.census2011_health.dataset}</a>, ${SOURCE_CITATIONS.census2011_health.publisher}.</li>
      <li><strong>Census 2021 general health:</strong> <a href="${SOURCE_CITATIONS.census2021_health.url}" target="_blank" rel="noopener">${SOURCE_CITATIONS.census2021_health.dataset}</a>, ${SOURCE_CITATIONS.census2021_health.publisher}.</li>
      <li><strong>2021 figures</strong> are published on 2021 LSOA boundaries; they're matched onto the 2011 LSOAs used throughout this dashboard via the same ONS exact-fit crosswalk documented in "Data &amp; methodology".</li>
      <li><strong>IMD2025 (England):</strong> <a href="${SOURCE_CITATIONS.imd_health_en.url}" target="_blank" rel="noopener">${SOURCE_CITATIONS.imd_health_en.dataset}</a>, ${SOURCE_CITATIONS.imd_health_en.publisher}, published 30 October 2025. Also on 2021 LSOA boundaries, crosswalked to 2011 LSOAs the same way as the Census 2021 and population-by-age figures.</li>
      <li><strong>IMD2019 (England):</strong> <a href="${SOURCE_CITATIONS.imd_health_en_2019.url}" target="_blank" rel="noopener">${SOURCE_CITATIONS.imd_health_en_2019.dataset}</a>, ${SOURCE_CITATIONS.imd_health_en_2019.publisher}.</li>
      <li><strong>WIMD2019 (Wales):</strong> <a href="${SOURCE_CITATIONS.wimd_health_wa.url}" target="_blank" rel="noopener">${SOURCE_CITATIONS.wimd_health_wa.dataset}</a>, ${SOURCE_CITATIONS.wimd_health_wa.publisher}. WIMD2025 was checked but its raw domain scores were not available as a bulk download at the time of writing — see the caveat above.</li>
      <li><strong>Population aged 65+:</strong> <a href="${SOURCE_CITATIONS.pct65.url}" target="_blank" rel="noopener">${SOURCE_CITATIONS.pct65.dataset}</a>, ${SOURCE_CITATIONS.pct65.publisher} — now shown with a full ${state.meta.national_trends.pct65 ? state.meta.national_trends.pct65.years.length : ""}-year history (${state.meta.national_trends.pct65 ? state.meta.national_trends.pct65.years[0] : ""}–${state.meta.national_trends.pct65 ? state.meta.national_trends.pct65.years[state.meta.national_trends.pct65.years.length - 1] : ""}), selectable above like any other trend indicator.</li>
    </ul>
  `;

  $("#forecastIndicatorPicker").addEventListener("change", (e) => renderForecastChart(e.target.value));
  if (trendKeys.length) renderForecastChart(trendKeys[0]);
}

})();
