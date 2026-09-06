# England & Wales Small-Area Health Atlas (prototype)

An interactive choropleth dashboard showing health conditions, prescribing and
frailty indicators for every Lower Super Output Area (LSOA) in England and
Wales (34,753 areas), built entirely from public NHS, ONS and Welsh Government
data.

**This is an independent prototype**, not an official NHS/ONS/government
product. See the in-app "Data & methodology" panel for full sourcing,
caveats and licensing.

## Live site

Deployed via GitHub Pages from `/site`, and mirrored on Render
(`render.yaml`). Both auto-deploy on every push to `main`.

## Data stays current automatically

`.github/workflows/refresh-data.yml` runs every Monday (and on-demand via
"Run workflow" in the Actions tab). It:

1. Runs `scripts/fetch_raw.py`, which re-queries every source (PLDR's CKAN
   API, gov.uk, gov.wales) and **auto-discovers whatever period is currently
   newest** — it never assumes a specific year, so a new QOF year, a new
   prescribing quarter, or a new frailty release gets picked up with no code
   change.
2. Runs `scripts/build_data.py`, which rebuilds `site/data/*.json`, again
   auto-detecting the latest year/quarter present in whatever was just
   downloaded (see each indicator's `year` field in `meta.json`).
3. Commits and pushes `site/data/*.json` **only if something actually
   changed** — which triggers the existing Pages/Render deploys automatically.

Nothing here needs a person to notice new data exists and manually update a
file. The one soft spot: England's IMD and Wales's WIMD don't have a stable
API, so `fetch_raw.py` does a best-effort scrape for a newer edition and
falls back to the known 2019 URLs if that fails — if either nation ever
publishes a genuinely new edition under an unrecognisably different page
structure, that one step might need a URL bump (everything else needs none).

## What's in each folder

- `site/` — the deployed static web app (HTML/CSS/JS, Leaflet map). This is
  the only folder published to GitHub Pages / Render.
- `scripts/fetch_raw.py` — downloads/refreshes everything in `data/raw/`,
  auto-discovering the latest period per source (see above).
- `scripts/build_data.py` — joins `data/raw/` into `site/data/lsoa_data.json`
  (per-LSOA indicator values, packed into a compact schema-indexed array —
  see the file's own header comment) and `site/data/meta.json` (indicator
  definitions, units, sources, auto-detected years, quintile breaks, national
  year-by-year aggregates, and a `generated` build timestamp shown in-app).
  Also writes `site/data/trend_<key>.json` — one lazy-loaded file per
  indicator with a multi-year history, fetched only when a user opens that
  indicator's trend view (not part of the main payload).
- `scripts/fetch_census.py` — **one-off**, like `fetch_boundaries.py`: pulls
  self-reported general health from the 2011 and 2021 Censuses (Nomis API),
  the one genuine two-time-point comparison in this dashboard. Not run on a
  schedule — nothing changes here until the next Census in 2031.
- `data/raw/` — downloaded source files. **Not committed** (see
  `.gitignore`) because it's ~1GB; `fetch_raw.py` re-creates it.
- `data/static/` — small, permanently-frozen assets that *are* committed
  (geography lookups, the age-population crosswalk, the Census summary) —
  see each script's header comment for why each one belongs here rather than
  in `data/raw/`.
- `data/processed/` — simplified TopoJSON boundaries, generated via
  `mapshaper`. Not committed either — see the boundaries note below.

## Data sources (headline)

| Type | Source | Coverage |
|---|---|---|
| QOF disease prevalence (8 conditions) | NHS England via [PLDR](https://pldr.org) | England (+ partial border) |
| Prescribing rates (6 drug classes) | NHS Business Services Authority via PLDR | England (+ partial border) |
| Frailty | Small Area Frailty Index via PLDR (MSOA) | England |
| Health deprivation | MHCLG English Indices of Deprivation 2025 (+ 2019 for comparison) | England |
| Health deprivation | Welsh Index of Multiple Deprivation 2019 | Wales |
| Population aged 65+ | ONS mid-year LSOA population estimates by broad age band (12-year series) | England & Wales |
| Self-reported general health, Census 2011 | ONS, table KS301EW, via Nomis | England & Wales |
| Self-reported general health, Census 2021 | ONS, table TS037, via Nomis | England & Wales |
| Boundaries | ONS Open Geography Portal, LSOA (Dec 2011) BSC | England & Wales |
| Geography lookup | ONS OA→LSOA→MSOA→LAD (Dec 2011) Exact Fit | England & Wales |

Full per-indicator citations, licences and caveats are in
`site/js/sources.js` and rendered in the app's "Data & methodology" modal.

## Beyond raw values: percentile rank, change, and age-adjustment

Every indicator can be viewed as its raw value, a 0–100 percentile rank
(Viridis palette), or — for the 8 QOF conditions, 6 prescribing indicators
and frailty, which have a genuine multi-year annual series — year-on-year
% change, a change z-score, and an age-adjusted ratio. See `build_data.py`'s
module docstring for exact formulas, and the in-app "Data & methodology"
glossary for plain-language explanations with worked examples.

## Compare & Forecast

A second modal (separate from "Data & methodology") holds two more things:

- **Census 2011 vs 2021**: both censuses asked the same "How is your health
  in general?" question on the same five-point scale, which is what makes
  this the one genuinely valid cross-year comparison in the dashboard —
  unlike the deprivation indices, which are explicitly *not* comparable
  across editions (see the in-app explanation). Also selectable as three map
  layers: 2011, 2021, and the change between them.
- **England deprivation, IMD2019 vs IMD2025**: offered with a much heavier
  caveat than the Census comparison, because MHCLG revised the Health
  Deprivation & Disability domain's indicators between editions — a change
  in score is a mix of real change and methodology revision that can't be
  cleanly separated. Deliberately does **not** show a national mean-vs-mean
  figure (IMD scores are standardised to ~0 nationally in every edition, so
  that comparison would be circular); instead shows the cross-edition
  correlation and the % of LSOAs whose relative score rose vs fell. Wales's
  WIMD2025 exists but isn't included — its raw domain scores aren't
  available as a public bulk download at the time of writing, only via an
  interactive ranks/groups tool on the new StatsWales platform.
- **Simple trend forecasts**: an ordinary-least-squares linear trend fit to
  each multi-year indicator's national series, extrapolated 3 years with a
  proper widening prediction interval. Deliberately the simplest defensible
  method (see `computeLinearForecast()` in `app.js`) rather than ARIMA/
  exponential smoothing, so a reader can sanity-check it by eye — and
  explicitly labelled as a naive extrapolation, not a real forecast, since it
  has no way to know about future reforms, funding changes, or events like a
  pandemic.

## Running the pipeline manually

```bash
pip install pandas odfpy openpyxl
python3 scripts/fetch_raw.py    # downloads/refreshes data/raw/
python3 scripts/build_data.py   # rebuilds site/data/lsoa_data.json + meta.json
```

Boundaries are a one-off, separate script — 2011 LSOA geography is
permanently frozen, so this never needs to run on a schedule and isn't part
of `fetch_raw.py`. Only run it if `site/data/lsoa_2011.topojson` or
`data/static/lsoa_msoa_lad_lookup.csv` are ever lost or need regenerating:

```bash
python3 scripts/fetch_boundaries.py   # requires Node (uses npx mapshaper)
```

Census data is the same story — one-off, not scheduled, since nothing changes
until the 2031 Census:

```bash
python3 scripts/fetch_census.py   # requires data/static/lsoa11_to_lsoa21_lookup.csv to already exist
```

## Local preview

```bash
python3 -m http.server 8642 --directory site
```

## Known limitations / next steps

- England's deprivation score now compares IMD2019 and IMD2025, but
  deliberately still gets no z-score or age-adjusted view — it's two
  independently-rebuilt composite indices, not a real annual series, and
  ONS/Welsh Government guidance warns against comparing scores or ranks
  across editions. See "📈 Compare & Forecast" for the full caveat and why
  the comparison shown is a correlation + % worse/better, not a naive mean
  difference. Wales stays at WIMD2019 only — WIMD2025 exists but its raw
  domain scores aren't accessible as a bulk download (only ranks/groups via
  an interactive tool on the new StatsWales platform), a genuine data-access
  gap rather than a methodological choice.
- The age-adjusted ratio is an indirect-standardisation-style approximation
  (regression against local % 65+), not a true directly age-standardised
  rate — neither QOF nor NHSBSA data publishes age-specific rates at LSOA
  level, so a certified DSR isn't computable from this source. Stated
  plainly in-app rather than overclaiming rigour.
- Frailty is MSOA-level data broadcast to member LSOAs, not LSOA-native.
- Wales has no public LSOA-level clinical disease-register data at the time
  of writing; Wales uses WIMD2019 Health Domain instead (see methodology
  panel for the full explanation).
- The trend forecast is a naive linear extrapolation, explicitly labelled as
  such — it cannot anticipate future reforms, funding changes, or shocks.
- Boundaries are geometry-simplified for web performance, not for spatial
  analysis.
