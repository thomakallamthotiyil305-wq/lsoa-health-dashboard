(function () {
"use strict";

// ---------- Color ramp (validated sequential blue, dataviz skill palette) ----------
const RAMP = ["#b7d3f6", "#6da7ec", "#2a78d6", "#184f95", "#0d366b"];
const NO_DATA_COLOR = "#d7d5cd";
const HOVER_COLOR = "#eb6834"; // categorical slot 2 (orange) — used only for hover outline

const state = {
  meta: null,
  data: null,
  geoLayer: null,
  activeKey: "chd",
  activeCountry: "ALL",
  featuresByCode: new Map(),
  layersByCode: new Map(),
};

const $ = (sel) => document.querySelector(sel);

function formatGeneratedDate(iso) {
  return new Date(iso).toLocaleString("en-GB", { dateStyle: "long", timeStyle: "short", timeZone: "UTC" }) + " UTC";
}

// ---------- Boot ----------
Promise.all([
  fetch("data/meta.json").then((r) => r.json()),
  fetch("data/lsoa_data.json").then((r) => r.json()),
  fetch("data/lsoa_2011.topojson").then((r) => r.json()),
]).then(([meta, data, topo]) => {
  state.meta = meta;
  state.data = data;

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

// ---------- Sidebar ----------
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
}

function setActiveIndicator(key) {
  state.activeKey = key;
  document.querySelectorAll(".layer-row").forEach((row) => {
    row.classList.toggle("active", row.dataset.key === key);
  });
  restyleAll();
  buildLegend();
}

// ---------- Color logic ----------
function colorFor(value, m) {
  if (value === undefined || value === null) return NO_DATA_COLOR;
  const b = m.breaks; // 4 break points -> 5 bins
  if (value <= b[0]) return RAMP[0];
  if (value <= b[1]) return RAMP[1];
  if (value <= b[2]) return RAMP[2];
  if (value <= b[3]) return RAMP[3];
  return RAMP[4];
}

function styleFeature(code) {
  const rec = state.data[code];
  const m = state.meta.indicators[state.activeKey];
  const value = rec && rec.v ? rec.v[state.activeKey] : undefined;
  const inCountry = state.activeCountry === "ALL" || (rec && rec.c === state.activeCountry);
  return {
    fillColor: colorFor(value, m),
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
        const v = rec.v[state.activeKey];
        const valTxt = v === undefined ? "No data" : `${v} ${m.unit}`;
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
  const el = $("#legend");
  const fmt = (n) => (Math.abs(n) >= 100 ? Math.round(n) : n);
  const labels = [
    `< ${fmt(m.breaks[0])}`,
    `${fmt(m.breaks[0])} – ${fmt(m.breaks[1])}`,
    `${fmt(m.breaks[1])} – ${fmt(m.breaks[2])}`,
    `${fmt(m.breaks[2])} – ${fmt(m.breaks[3])}`,
    `> ${fmt(m.breaks[3])}`,
  ];
  let html = `<div class="legend-title">${m.label}</div><div class="legend-unit">${m.unit}</div>`;
  RAMP.forEach((c, i) => {
    html += `<div class="legend-row"><span class="swatch" style="background:${c}"></span>${labels[i]}</div>`;
  });
  html += `<div class="legend-row"><span class="swatch" style="background:${NO_DATA_COLOR}"></span>No data</div>`;
  html += `<div class="legend-meta">${m.coverage} · ${m.year} · ${m.n_lsoas.toLocaleString()} areas</div>`;
  el.innerHTML = html;
}

// ---------- Detail panel ----------
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
        const v = rec.v[key];
        const valTxt = v === undefined || v === null ? '<span class="nodata">No data for this area</span>' : `<strong>${v}</strong> ${m.unit}`;
        return `<div class="detail-row"><span class="detail-row-label">${m.label}</span><span class="detail-row-val">${valTxt}</span></div>`;
      })
      .join("");
    if (!rows) return;
    html += `<div class="detail-group"><h3>${group.label}</h3>${rows}</div>`;
  });

  html += `<p class="detail-footnote">Click "ℹ️ Data &amp; methodology" above for exact sources, years and definitions for every figure shown here.</p>`;

  el.innerHTML = html;

  // Zoom to feature
  const layer = state.layersByCode.get(code);
  if (layer && state.map) {
    state.map.fitBounds(layer.getBounds(), { maxZoom: 13, padding: [40, 40] });
  }
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

    <h3>Geographic boundaries</h3>
    <p><strong>${BOUNDARY_SOURCE.dataset}</strong>, published by ${BOUNDARY_SOURCE.publisher}.
    ${BOUNDARY_SOURCE.note} Boundaries are simplified (generalised to 200m and further Douglas-Peucker simplified) for web performance —
    not suitable for precise spatial analysis. <a href="${BOUNDARY_SOURCE.url}" target="_blank" rel="noopener">Source ↗</a></p>
    <p>LSOA→MSOA→Local Authority linkage: <strong>${LOOKUP_SOURCE.dataset}</strong>, ${LOOKUP_SOURCE.publisher}.
    <a href="${LOOKUP_SOURCE.url}" target="_blank" rel="noopener">Source ↗</a></p>

    <h3>Methodology notes</h3>
    <ul>
      <li><strong>Latest available period only.</strong> Each indicator shows only the most recent period in the source data (year shown per indicator above) — this prototype does not yet include a time trend / historical slider, though the underlying raw archives (back to 2005 for QOF, 2010 for prescribing) support one in a future version.</li>
      <li><strong>Prescribing rates</strong> use the source data's own pre-calculated "items per 1,000 patients" rate field; see each PLDR indicator specification (linked from its dataset page) for the exact denominator methodology.</li>
      <li><strong>QOF prevalence</strong> is the percentage of a GP practice's registered patients on that condition's disease register, apportioned to LSOA by the home postcodes of registered patients — these are modelled small-area estimates, not direct counts, and carry the uncertainty that implies.</li>
      <li><strong>Frailty</strong> is published at Middle Super Output Area (MSOA) level — roughly 4–5 LSOAs per MSOA — and has been broadcast unchanged to every LSOA within each MSOA so it can be shown on this LSOA-level map. It should be read at MSOA resolution, not interpreted as LSOA-specific.</li>
      <li><strong>Colour classes</strong> are quintiles (five equal-count bins) computed independently per indicator across all LSOAs with data, using the 2011 LSOA geography.</li>
      <li><strong>Small numbers</strong> in NHS source data are sometimes suppressed or rounded for disclosure control; areas affected show as "No data" here rather than a potentially unreliable figure.</li>
    </ul>

    <h3>Licensing &amp; attribution</h3>
    <p>All datasets are published under the <a href="https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/" target="_blank" rel="noopener">Open Government Licence v3.0</a>
    or equivalent open terms. Contains public sector information licensed under the Open Government Licence v3.0. Contains OS data © Crown copyright and database right.
    This dashboard itself is an independent, non-commercial prototype.</p>

    <h3>Accessibility</h3>
    <p>Map colours use a single-hue sequential blue scale validated for colour-vision-deficiency safety. All map information (indicator, value, area name)
    is also available as text via hover tooltips, the click-through detail panel, and the search box — colour is never the only way to read a value.
    If you need this data in another format, use the source links above to access the original published tables directly.</p>

    <h3>Last updated</h3>
    <p>This dataset was last rebuilt <strong>${lastUpdatedText}</strong>. A scheduled job re-checks every source above weekly and automatically rebuilds
    and redeploys this site if anything upstream has changed — the "reference year" column in the table above always reflects whatever period was
    actually current in the source data at that most recent rebuild, not a fixed date written into this page.</p>
  `;
}

})();
