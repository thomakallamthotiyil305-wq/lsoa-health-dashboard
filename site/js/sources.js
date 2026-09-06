// Full data source registry — every dataset used in this dashboard, with
// exact provenance. This drives both the sidebar grouping and the "Data &
// methodology" panel so nothing about where a number came from is hidden.

const INDICATOR_GROUPS = [
  {
    id: "conditions",
    label: "QOF disease prevalence",
    coverage: "England only",
    blurb: "Share of registered GP patients recorded on each disease register, from the NHS Quality and Outcomes Framework (QOF), apportioned to LSOA.",
    keys: ["chd", "copd", "af", "stroke", "ckd", "hf", "pad", "osteo"],
  },
  {
    id: "prescribing",
    label: "Prescribing indicators",
    coverage: "England only",
    blurb: "Community prescribing rates (items dispensed per 1,000 patients), from NHS Business Services Authority prescribing data.",
    keys: ["statins", "oac", "anticoag", "clopidogrel", "prasugrel", "ticagrelor"],
  },
  {
    id: "frailty",
    label: "Frailty",
    coverage: "England only (shown at MSOA resolution)",
    blurb: "Modelled frailty among people aged 65+, from the Small Area Frailty Index (SAFI). Published at MSOA level — every LSOA within an MSOA shows that MSOA's value.",
    keys: ["frailty"],
  },
  {
    id: "deprivation",
    label: "Deprivation (not cross-nation comparable)",
    coverage: "England and Wales, on separate national scales",
    blurb: "Each nation's own official deprivation indices. England (IMD2025, with IMD2019 shown alongside for reference) and Wales (WIMD2019) use different indicators and different scoring methods — do not compare a score of one nation directly against the other. The 2019→2025 change layer for England is a rougher comparison than it looks: MHCLG revised the domain's indicators between editions, so part of any change reflects methodology, not just reality on the ground (see \"Compare & Forecast\" for the full caveat). The Wales \"overall\" score covers more than health (income, employment, education, housing etc. are also folded in) — the health domain score above is the health-specific one. Wales's WIMD2025 exists but its raw domain scores are not available as a public bulk download at the time of writing (only ranks/groups, via an interactive tool) — so Wales still shows WIMD2019 only.",
    keys: ["imd_health_en", "imd_health_en_2019", "imd_health_en_change", "wimd_health_wa", "wimd_overall_wa"],
  },
  {
    id: "population",
    label: "Population context",
    coverage: "England and Wales",
    blurb: "Not a disease measure — shown so you can see for yourself how much of a disease pattern might simply track where older people live. This is also the covariate behind every \"age-adjusted\" view below.",
    keys: ["pct65"],
  },
  {
    id: "census",
    label: "Census: self-reported health",
    coverage: "England and Wales",
    blurb: "The only genuine like-for-like comparison across years in this dashboard: both the 2011 and 2021 Censuses asked \"How is your health in general?\" on the same five-point scale, a decade apart. Shown here as the % answering \"Bad\" or \"Very bad\", plus the change between the two censuses.",
    keys: ["census2011_health", "census2021_health", "census_health_change"],
  },
];

// Which analysis "views" exist, in the order offered to the user. Only the
// ones listed in an indicator's meta.modes are actually shown for it.
const VIEW_MODES = [
  { id: "raw", label: "Raw rate", short: "Raw", scale: "sequential" },
  { id: "pctile", label: "Percentile rank", short: "Percentile", scale: "sequential" },
  { id: "yoy", label: "Year-on-year change", short: "YoY change", scale: "diverging" },
  { id: "zscore", label: "Change vs. typical (z-score)", short: "Change z-score", scale: "diverging" },
  { id: "ageadj", label: "Age-adjusted ratio", short: "Age-adjusted", scale: "diverging" },
];

// mode id -> the schema-key suffix that stores it (raw has none — it's the base key)
const MODE_SUFFIX = { raw: "", pctile: "_pctile", yoy: "_yoy", zscore: "_z", ageadj: "_adj" };

// Detailed citation for every field key that can appear in v{} for an LSOA,
// keyed the same as meta.json's "indicators" object (meta.json supplies
// label/unit/source/year/coverage/breaks/min/max at runtime — this file adds
// the longer-form citation text used only in the About modal).
const SOURCE_CITATIONS = {
  chd:          { dataset: "QOF Indicators: Coronary heart disease prevalence (QOF_4_02)", publisher: "NHS England, via Place-based Longitudinal Data Resource (PLDR)", url: "https://pldr.org/dataset/quality-and-outcomes-framework-indicators-coronary-heart-disease-2kkd2" },
  copd:         { dataset: "QOF Indicators: COPD prevalence (QOF_4_04)", publisher: "NHS England, via PLDR", url: "https://pldr.org/dataset/quality-and-outcomes-framework-indicators-chronic-obstructive-pu-23q1e" },
  af:           { dataset: "QOF Indicators: Atrial fibrillation prevalence (QOF_4_07)", publisher: "NHS England, via PLDR", url: "https://pldr.org/dataset/quality-and-outcomes-framework-indicators-atrial-fibrillation-pr-e1xjv" },
  stroke:       { dataset: "QOF Indicators: Stroke / TIA prevalence (QOF_4_10)", publisher: "NHS England, via PLDR", url: "https://pldr.org/dataset/quality-and-outcomes-framework-indicators-stroketransient-ischem-2gd02" },
  ckd:          { dataset: "QOF: Chronic kidney disease prevalence (QOF_4_08)", publisher: "NHS England, via PLDR", url: "https://pldr.org/dataset/quality-and-outcomes-framework-indicators-chronic-kidney-disease-vq1n2" },
  hf:           { dataset: "QOF: Heart failure prevalence (QOF_4_14)", publisher: "NHS England, via PLDR", url: "https://pldr.org/dataset/quality-and-outcomes-framework-heart-failure-prevalence-qof414-2woln" },
  pad:          { dataset: "QOF: Peripheral arterial disease prevalence (QOF_4_16)", publisher: "NHS England, via PLDR", url: "https://pldr.org/dataset/quality-and-outcomes-framework-peripheral-arterial-disease-preva-2o695" },
  osteo:        { dataset: "QOF: Osteoporosis prevalence (QOF_4_19)", publisher: "NHS England, via PLDR", url: "https://pldr.org/dataset/quality-and-outcomes-framework-osteoporosis-prevalence-qof419-2l6rm" },
  statins:      { dataset: "Prescribing indicators — Statins (P_1_08)", publisher: "NHS Business Services Authority, via PLDR", url: "https://pldr.org/dataset/prescribing-indicators-statins-p108-24j52" },
  oac:          { dataset: "Prescribing indicators — Oral Anticoagulants (P_1_18)", publisher: "NHS Business Services Authority, via PLDR", url: "https://pldr.org/dataset/prescribing-indicators-oral-anticoagulants-p118-exzrv" },
  anticoag:     { dataset: "Prescribing indicators — Anti-coagulants (P_1_11)", publisher: "NHS Business Services Authority, via PLDR", url: "https://pldr.org/dataset/prescribing-indicators-anti-coagulants-p111-2jjd2" },
  clopidogrel:  { dataset: "Prescribing indicators — Clopidogrel (P_1_15)", publisher: "NHS Business Services Authority, via PLDR", url: "https://pldr.org/dataset/prescribing-indicators-clopidogrel-p115-2y3we" },
  prasugrel:    { dataset: "Prescribing indicators — Prasugrel (P_1_16)", publisher: "NHS Business Services Authority, via PLDR", url: "https://pldr.org/dataset/prescribing-indicators-pragusel-p116-e5gwv" },
  ticagrelor:   { dataset: "Prescribing indicators — Ticagrelor (P_1_17)", publisher: "NHS Business Services Authority, via PLDR", url: "https://pldr.org/dataset/prescribing-indicators-ticagrelor-p117-2wky2" },
  frailty:      { dataset: "Small Area Frailty Index (SAFI), moderate/severe, 65+", publisher: "via PLDR", url: "https://pldr.org/dataset/small-area-frailty-index-vqorl" },
  imd_health_en:{ dataset: "English Indices of Deprivation 2025 — Health Deprivation & Disability Domain", publisher: "Ministry of Housing, Communities & Local Government (MHCLG)", url: "https://www.gov.uk/government/statistics/english-indices-of-deprivation-2025" },
  imd_health_en_2019:{ dataset: "English Indices of Deprivation 2019 — Health Deprivation & Disability Domain", publisher: "Ministry of Housing, Communities & Local Government (MHCLG)", url: "https://www.gov.uk/government/statistics/english-indices-of-deprivation-2019" },
  imd_health_en_change:{ dataset: "English Indices of Deprivation, Health Deprivation & Disability Domain — 2019 and 2025 editions compared", publisher: "Ministry of Housing, Communities & Local Government (MHCLG)", url: "https://www.gov.uk/government/statistics/english-indices-of-deprivation-2025" },
  wimd_health_wa:{ dataset: "Welsh Index of Multiple Deprivation 2019 — Health Domain score", publisher: "Welsh Government", url: "https://www.gov.wales/welsh-index-multiple-deprivation-full-index-update-ranks-2019" },
  wimd_overall_wa:{ dataset: "Welsh Index of Multiple Deprivation 2019 — Overall score", publisher: "Welsh Government", url: "https://www.gov.wales/welsh-index-multiple-deprivation-full-index-update-ranks-2019" },
  pct65:        { dataset: "Population estimates for LSOAs by broad age band", publisher: "Office for National Statistics", url: "https://www.ons.gov.uk/peoplepopulationandcommunity/populationandmigration/populationestimates/datasets/lowersuperoutputareamidyearpopulationestimatesnationalstatistics" },
  census2011_health:  { dataset: "Census 2011, table KS301EW — Health and provision of unpaid care", publisher: "Office for National Statistics, via Nomis", url: "https://www.nomisweb.co.uk/census/2011/ks301ew" },
  census2021_health:  { dataset: "Census 2021, table TS037 — General health", publisher: "Office for National Statistics, via Nomis", url: "https://www.nomisweb.co.uk/datasets/c2021ts037" },
  census_health_change: { dataset: "Census 2011 (KS301EW) and Census 2021 (TS037) — General health, compared", publisher: "Office for National Statistics, via Nomis", url: "https://www.nomisweb.co.uk/datasets/c2021ts037" },
};

// General reference for the simple forecasting method used in the
// "Compare & Forecast" panel — a standard, citable open-access source
// rather than an uncredited technique.
const FORECAST_REFERENCE = {
  title: "Forecasting: Principles and Practice (3rd ed.), Section 5.2 — \"The linear trend model\"",
  authors: "Rob J Hyndman & George Athanasopoulos",
  url: "https://otexts.com/fpp3/regression-intro.html",
};

const BOUNDARY_SOURCE = {
  dataset: "Lower Layer Super Output Areas (December 2011) Boundaries, Super Generalised Clipped (BSC)",
  publisher: "Office for National Statistics, contains OS data © Crown copyright and database right",
  url: "https://geoportal.statistics.gov.uk/datasets/ons::lower-layer-super-output-areas-december-2011-boundaries-ew-bsc-v4",
  note: "2011 boundaries were used (not 2021) because the health datasets above are published against 2011 LSOA codes.",
};

const LOOKUP_SOURCE = {
  dataset: "Output Area (2011) to LSOA to MSOA to LAD (December 2011) Exact Fit Lookup in EW",
  publisher: "Office for National Statistics",
  url: "https://geoportal.statistics.gov.uk/",
};

const LOOKUP21_SOURCE = {
  dataset: "LSOA (2011) to LSOA (2021) to Local Authority District (2022) Exact Fit Lookup for EW",
  publisher: "Office for National Statistics",
  url: "https://geoportal.statistics.gov.uk/",
  note: "The population-by-age data below is only published on 2021 LSOA geography. This lookup re-associates it back onto the 2011 LSOAs used everywhere else in this dashboard — about 97% of areas map 1:1 unchanged; the remainder (splits/merges) are approximated by averaging across the affected areas.",
};
