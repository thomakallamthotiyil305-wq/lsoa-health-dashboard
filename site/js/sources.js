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
    label: "Health deprivation (not cross-nation comparable)",
    coverage: "England and Wales, on separate national scales",
    blurb: "Each nation's own official health-deprivation index. England (IMD2019) and Wales (WIMD2019) use different indicators and different scoring methods — do not compare a score of one nation directly against the other.",
    keys: ["imd_health_en", "wimd_health_wa"],
  },
];

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
  imd_health_en:{ dataset: "English Indices of Deprivation 2019 — Health Deprivation & Disability Domain", publisher: "Ministry of Housing, Communities & Local Government (MHCLG)", url: "https://www.gov.uk/government/statistics/english-indices-of-deprivation-2019" },
  wimd_health_wa:{ dataset: "Welsh Index of Multiple Deprivation 2019 — Health Domain score", publisher: "Welsh Government", url: "https://www.gov.wales/welsh-index-multiple-deprivation-full-index-update-ranks-2019" },
  wimd_overall_wa:{ dataset: "Welsh Index of Multiple Deprivation 2019 — Overall score", publisher: "Welsh Government", url: "https://www.gov.wales/welsh-index-multiple-deprivation-full-index-update-ranks-2019" },
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
