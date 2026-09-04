# England & Wales Small-Area Health Atlas (prototype)

An interactive choropleth dashboard showing health conditions, prescribing and
frailty indicators for every Lower Super Output Area (LSOA) in England and
Wales (34,753 areas), built entirely from public NHS, ONS and Welsh Government
data.

**This is an independent prototype**, not an official NHS/ONS/government
product. See the in-app "Data & methodology" panel for full sourcing,
caveats and licensing.

## Live site

Deployed via GitHub Pages from `/site`.

## What's in each folder

- `site/` — the deployed static web app (HTML/CSS/JS, Leaflet map). This is
  the only folder published to GitHub Pages.
- `scripts/build_data.py` — joins all downloaded source CSVs into
  `site/data/lsoa_data.json` (per-LSOA indicator values) and
  `site/data/meta.json` (indicator definitions, units, quintile breaks).
- `data/raw/` — downloaded source files (QOF, prescribing, frailty, WIMD,
  IMD, boundaries, lookups). **Not committed** (see `.gitignore`) because it's
  ~700MB; re-download using the source URLs listed in `site/js/sources.js`.
- `data/processed/` — simplified TopoJSON boundaries, generated via
  `mapshaper`. Also not committed; regenerate with the command below.

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

## Reproducing the data build

```bash
# 1. Download raw sources into data/raw/ (see sources.js for exact URLs)
# 2. Simplify boundaries (requires Node + mapshaper):
npx mapshaper -i data/raw/lsoa_2011_bsc.geojson \
  -simplify dp 8% keep-shapes -clean \
  -o data/processed/lsoa_2011.topojson format=topojson quantization=1e5
cp data/processed/lsoa_2011.topojson site/data/lsoa_2011.topojson

# 3. Join all indicator data:
python3 scripts/build_data.py
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
