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
Promise.all([
  fetch("data/meta.json").then((r) => r.json()),
  fetch("data/lsoa_data.json").then((r) => r.json()),
  fetch("data/lsoa_2011.topojson").then((r) => r.json()),
]).then(([meta, data, topo]) => {
  state.meta = meta;
  state.data = data;
  (meta.schema || []).forEach((key, i) => { state.schemaIndex[key] = i; });

  const objectName = Object.keys(topo.objects)[0];
  const geojson = topojson.feature(topo, topo.objects[objectName]);

  buildSidebar();
  buildMap(geojson);
  buildLegend();
  buildAboutModal();
  wireGlobalControls();

  if (meta.generated) {
    const badge = $("#freshnessBadge");
    badge.textContent = `📅 Data as of ${formatGeneratedDate(meta.generated)}`;
    badge.hidden = false;
  }

  $("#mapLoading").style.display = "none";
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
    });
  });
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
}

// ---------- Color logic ----------
function rampFor(mode) {
  if (mode === "pctile") return RAMP_VIRIDIS;
  if (mode === "yoy" || mode === "zscore" || mode === "ageadj") return RAMP_DIVERGING;
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
  const ramp = rampFor(mode);
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
        const unit = state.viewMode === "pctile" ? "th percentile" : state.viewMode === "raw" ? ` ${m.unit}` : ` (${VIEW_MODES.find(x => x.id === state.viewMode).short})`;
        const valTxt = v === undefined ? "No data" : `${v}${unit}`;
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
function buildLegend() {
  const m = state.meta.indicators[state.activeKey];
  const mode = state.viewMode;
  const b = breaksFor(m, mode);
  const ramp = rampFor(mode);
  const el = $("#legend");
  const fmt = (n) => (Math.abs(n) >= 100 ? Math.round(n) : n);
  const unitLabel = mode === "raw" ? m.unit
    : mode === "pctile" ? "percentile rank (0–100)"
    : mode === "yoy" ? "% change vs. previous year"
    : mode === "zscore" ? "z-score of year-on-year change"
    : "age-adjusted ratio (1.0 = as expected)";

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
  el.innerHTML = html;
}

// ---------- Detail panel ----------
function formatStat(v, suffix) {
  if (v === undefined || v === null) return null;
  const r2 = Math.round(v * 100) / 100;
  return suffix === "pctile" ? `${Math.round(v)}th percentile`
    : suffix === "yoy" ? `${r2 > 0 ? "+" : ""}${r2}% vs last year`
    : suffix === "z" ? `z ${r2 > 0 ? "+" : ""}${r2}`
    : suffix === "adj" ? `age-adjusted ×${r2}`
    : String(v);
}

function showDetail(code) {
  const rec = state.data[code];
  if (!rec) return;
  $("#detailEmpty").hidden = true;
  const el = $("#detailContent");
  el.hidden = false;
  $("#detailPanel").classList.add("open");

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

  // About modal
  $("#aboutBtn").addEventListener("click", () => {
    $("#aboutModalBackdrop").hidden = false;
  });
  $("#aboutModalClose").addEventListener("click", () => {
    $("#aboutModalBackdrop").hidden = true;
  });
  $("#aboutModalBackdrop").addEventListener("click", (e) => {
    if (e.target.id === "aboutModalBackdrop") $("#aboutModalBackdrop").hidden = true;
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") $("#aboutModalBackdrop").hidden = true;
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
    <p>Older populations naturally have higher rates of most of these conditions, so a simple map of raw rates partly just shows "where older people
    live." To separate that mechanical effect from genuine clustering, this dashboard also shows population aged 65+ (its own map layer) and an
    <strong>age-adjusted ratio</strong> for the 8 QOF conditions.</p>
    <p><strong>Important limitation:</strong> a fully rigorous directly age-standardised rate needs age-<em>specific</em> disease rates — e.g. a separate
    prevalence figure for ages 65–74, 75–84, 85+ — re-weighted onto a standard population. NHS QOF publishes only a single all-ages rate per LSOA; no
    age-specific breakdown exists at this geography. A true directly-standardised rate therefore cannot be computed from this source. What's shown
    instead is an <strong>indirect-standardisation-style ratio</strong>: a simple regression of each condition's rate against local % aged 65+ across
    every LSOA in England, then <code>ratio = observed rate ÷ rate that regression predicts for this area's age profile</code>. This controls for the
    linear relationship between age and prevalence, but not the full age-specific structure a certified age-standardised rate would use — treat it as
    a genuinely useful, transparent approximation, not an official age-standardised statistic.</p>

    <h3>National trends over time, and NHS commissioning reforms</h3>
    <p>These charts show the England-wide average (and 10th–90th percentile spread) for each condition with a multi-year series, with vertical dashed
    lines marking two major NHS structural reforms that changed how regional medical resources are commissioned and allocated:</p>
    <ul>${reformRows}</ul>
    <p>These lines are shown for context only — a change in the trend around a reform date is not evidence the reform caused it; many other things
    change every year too. Click "📈 Trend" next to any condition in an area's profile (after clicking that area on the map) to see that specific
    area's own trajectory rather than the national average.</p>
    <div class="national-trends-grid">${nationalTrendCharts}</div>

    <h3>Why some data only covers England</h3>
    <p>QOF disease-prevalence indicators, NHS prescribing indicators, and the Small Area Frailty Index are all sourced from NHS England / NHS Business
    Services Authority systems, which do not cover Wales — health data collection is devolved. A small number of Welsh LSOAs near the border do appear
    with values, because some residents are registered with English GP practices; the rest show "No data" for these layers, which is the honest state
    of public data availability, not a gap in this dashboard. Wales does not publish LSOA-level clinical disease-register prevalence in the public domain
    at the time of writing (finest published granularity found was GP practice / cluster / health board, via StatsWales). Instead, this dashboard uses
    Wales's own official small-area health measure — the WIMD 2019 Health Domain score — which <strong>is</strong> published at LSOA level.</p>

    <h3>England vs Wales deprivation scores are not directly comparable</h3>
    <p>England's IMD2019 Health Deprivation &amp; Disability score and Wales's WIMD2019 Health Domain score are each constructed from different underlying
    indicators, on different scales, calculated independently by MHCLG and the Welsh Government respectively. Both are shown because both are the
    official small-area health-deprivation measure for their nation, but a numeric value in one nation is not equivalent to the same number in the other.</p>

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
      <li><strong>Prescribing rates</strong> use the source data's own pre-calculated "items per 1,000 patients" rate field; see each PLDR indicator specification (linked from its dataset page) for the exact denominator methodology. Prescribing does not currently have a multi-year trend view (see below).</li>
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

})();
