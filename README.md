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
- `scripts/build_data.py` — joins `data/raw/` into
  `site/data/lsoa_data.json` (per-LSOA indicator values) and
  `site/data/meta.json` (indicator definitions, units, auto-detected years,
  quintile breaks, and a `generated` build timestamp shown in-app).
- `data/raw/` — downloaded source files. **Not committed** (see
  `.gitignore`) because it's ~700MB; `fetch_raw.py` re-creates it.
- `data/processed/` — simplified TopoJSON boundaries, generated via
  `mapshaper`. Not committed either — see the boundaries note below.

## Data sources (headline)

| Type | Source | Coverage |
|---|---|---|
| QOF disease prevalence (8 conditions) | NHS England via [PLDR](https://pldr.org) | England (+ partial border) |
| Prescribing rates (6 drug classes) | NHS Business Services Authority via PLDR | England (+ partial border) |
| Frailty | Small Area Frailty Index via PLDR (MSOA) | England |
| Health deprivation | MHCLG English Indices of Deprivation 2019 | England |
| Health deprivation | Welsh Index of Multiple Deprivation 2019 | Wales |
| Boundaries | ONS Open Geography Portal, LSOA (Dec 2011) BSC | England & Wales |
| Geography lookup | ONS OA→LSOA→MSOA→LAD (Dec 2011) Exact Fit | England & Wales |

Full per-indicator citations, licences and caveats are in
`site/js/sources.js` and rendered in the app's "Data & methodology" modal.

## Running the pipeline manually

```bash
pip install pandas odfpy openpyxl
python3 scripts/fetch_raw.py    # downloads/refreshes data/raw/
python3 scripts/build_data.py   # rebuilds site/data/lsoa_data.json + meta.json
```

Boundaries are a one-off, separate step — 2011 LSOA geography is permanently
frozen, so this never needs to run on a schedule:

```bash
# (fetch data/raw/lsoa_2011_bsc.geojson — see the ONS FeatureServer query
#  documented in git history / sources.js — then:)
npx mapshaper -i data/raw/lsoa_2011_bsc.geojson \
  -simplify dp 8% keep-shapes -clean \
  -o data/processed/lsoa_2011.topojson format=topojson quantization=1e5
cp data/processed/lsoa_2011.topojson site/data/lsoa_2011.topojson
```

## Local preview

```bash
python3 -m http.server 8642 --directory site
```

## Known limitations / next steps

- Shows only the latest available period per indicator (no time trend yet —
  raw archives support one back to 2005 for QOF, 2010 for prescribing).
- Frailty is MSOA-level data broadcast to member LSOAs, not LSOA-native.
- Wales has no public LSOA-level clinical disease-register data at the time
  of writing; Wales uses WIMD2019 Health Domain instead (see methodology
  panel for the full explanation).
- Boundaries are geometry-simplified for web performance, not for spatial
  analysis.
