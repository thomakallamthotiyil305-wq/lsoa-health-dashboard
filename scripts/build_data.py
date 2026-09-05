#!/usr/bin/env python3
"""
Joins all downloaded source data into:
  site/data/lsoa_data.json   — per-LSOA snapshot: raw values + derived stats
  site/data/meta.json        — indicator definitions, units, sources, breaks
  site/data/trend_<key>.json — full historical time series, one file per
                               indicator that has one, fetched lazily by the
                               frontend only when a user asks for a trend view

Fully dynamic: every "latest year / latest quarter" is auto-detected from
whatever files fetch_raw.py most recently downloaded — nothing here is
hardcoded to a specific year.

Derived statistics (added on top of the original raw-value pipeline):
  <key>_pctile  — percentile rank (0-100) of this LSOA's raw value among all
                  LSOAs with data for that indicator. Makes differently-scaled
                  diseases visually comparable on one 0-100 scale.
  <key>_yoy     — % change in the raw value between the latest two available
                  years: (T1 - T0) / T0 * 100.  QOF conditions + frailty only
                  (the only indicators with a multi-year annual series).
  <key>_z       — z-score of the *absolute* (percentage-point) change between
                  those same two years, relative to every other LSOA's change
                  for that indicator: (change_i - mean(change)) / SD(change).
                  This is deliberately a different quantity from `_yoy`: `_yoy`
                  is this area's own relative change; `_z` is how unusual that
                  change is compared to everywhere else, in units of standard
                  deviation, so a fast-moving condition and a slow-moving one
                  become comparable. QOF conditions + frailty only.
  <key>_adj     — age-profile-adjusted ratio (observed / expected-given-local-
                  age-profile), an indirect-standardisation-style measure.
                  QOF conditions only (see fit_age_adjustment() docstring for
                  exactly what this is and, importantly, is NOT).
  <key>_adj_pctile — percentile rank of `_adj`, same idea as `_pctile`.
  pct65         — % of the LSOA's population aged 65+ (own contextual layer).
"""
import csv
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from collections import defaultdict

import pandas as pd
import numpy as np

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
STATIC = ROOT / "data" / "static"
OUT = ROOT / "site" / "data"
OUT.mkdir(parents=True, exist_ok=True)

records = defaultdict(dict)   # lsoa_code -> {n, la, c, msoa, v:{...}}
detected_years = {}            # indicator key -> year/period string actually used
time_series = {}                # indicator key -> {year: {lsoa_code: value}}  (QOF + frailty only)

QOF_KEYS = ["chd", "copd", "af", "stroke", "ckd", "hf", "pad", "osteo"]
TREND_KEYS = QOF_KEYS + ["frailty"]   # indicators with a usable annual series
REFORM_YEARS = [
    {"year": 2013, "label": "PCTs abolished, CCGs created (Health and Social Care Act 2012)"},
    {"year": 2022, "label": "CCGs abolished, Integrated Care Boards created (Health and Care Act 2022)"},
]


def get(code):
    return records[code]

# ---------- 1. LSOA -> MSOA -> LAD lookup (name/LA/country backbone) ----------
with open(STATIC / "lsoa_msoa_lad_lookup.csv") as f:
    for row in csv.DictReader(f):
        code = row["LSOA11CD"]
        rec = get(code)
        rec["la"] = row["LAD11NM"]
        rec["msoa"] = row["MSOA11CD"]
        rec["c"] = "E" if code.startswith("E") else "W"

# ---------- 2. England IMD2019 Health Deprivation domain (parsed live from .xlsx) ----------
imd_path = RAW / "england_imd" / "File_5_scores.xlsx"
if imd_path.exists():
    xl = pd.ExcelFile(imd_path)
    sheet = next((s for s in xl.sheet_names if "score" in s.lower()), xl.sheet_names[-1])
    df = pd.read_excel(imd_path, sheet_name=sheet)
    col_lsoa = next(c for c in df.columns if c.lower().startswith("lsoa code"))
    col_name = next(c for c in df.columns if c.lower().startswith("lsoa name"))
    col_health = next(c for c in df.columns if "health deprivation" in c.lower())
    for _, row in df.iterrows():
        code = row[col_lsoa]
        rec = get(code)
        rec["n"] = row[col_name]
        rec.setdefault("v", {})["imd_health_en"] = round(float(row[col_health]), 3)
    print(f"England IMD: {len(df)} LSOAs loaded from {imd_path.name}")

# ---------- 3. Wales WIMD2019 domain scores (parsed live from .ods) ----------
wimd_path = RAW / "wales" / "wimd_domain_scores.ods"
if wimd_path.exists():
    raw = pd.read_excel(wimd_path, engine="odf", sheet_name="Data", header=None)
    header_row = next(i for i in range(len(raw)) if str(raw.iloc[i, 0]).strip() == "LSOA code")
    df = pd.read_excel(wimd_path, engine="odf", sheet_name="Data", header=header_row)
    df = df.dropna(subset=["LSOA code"])
    for _, row in df.iterrows():
        code = row["LSOA code"]
        rec = get(code)
        rec["n"] = row["LSOA name"]
        rec["la"] = str(row["Local Authority name "]).strip()
        rec["c"] = "W"
        rec.setdefault("v", {})["wimd_health_wa"] = round(float(row["Health"]), 3)
        rec["v"]["wimd_overall_wa"] = round(float(row["WIMD 2019 "]), 3)
    print(f"Wales WIMD: {len(df)} LSOAs loaded from {wimd_path.name}")

# ---------- 4. QOF disease-prevalence indicators — full annual series retained ----------
for key in QOF_KEYS:
    path = RAW / "qof" / f"{key}.csv"
    if not path.exists():
        print(f"QOF {key}: file missing, skipped")
        continue
    by_lsoa_year = defaultdict(dict)   # lsoa -> {year: rate}
    with open(path) as f:
        for row in csv.DictReader(f):
            rate = row["p_rate"]
            if not rate or rate == "NA":
                continue
            by_lsoa_year[row["lsoa11"]][row["year"]] = float(rate)

    years_present = sorted({y for yrs in by_lsoa_year.values() for y in yrs})
    latest, prev = years_present[-1], years_present[-2] if len(years_present) > 1 else None
    detected_years[key] = latest
    time_series[key] = {y: {lsoa: yrs[y] for lsoa, yrs in by_lsoa_year.items() if y in yrs} for y in years_present}

    found = 0
    for lsoa, yrs in by_lsoa_year.items():
        if latest not in yrs:
            continue
        rec = get(lsoa)
        rec.setdefault("v", {})[key] = round(yrs[latest], 3)
        found += 1
    print(f"QOF {key}: {found} LSOAs @ {latest} (auto-detected latest year; {len(years_present)} years of history retained)")

# ---------- 5. Prescribing indicators — latest period auto-detected via .period sidecar ----------
# Basenames must match fetch_raw.py's PRESCRIBING_DATASETS keys exactly
# (it writes "<key>_latest.csv") — this is deliberately not a separately
# maintained mapping, since a mismatch here fails silently on case-sensitive
# filesystems (macOS masks it; Linux CI runners do not).
PRESCRIBING_KEYS = ["statins", "oac", "anticoag", "clopidogrel", "prasugrel", "ticagrelor"]
for key in PRESCRIBING_KEYS:
    csv_path = RAW / "prescribing" / "extracted" / f"{key}_latest.csv"
    period_path = RAW / "prescribing" / "extracted" / f"{key}_latest.period"
    if not csv_path.exists():
        print(f"Prescribing {key}: file missing, skipped")
        continue
    period = period_path.read_text().strip() if period_path.exists() else "unknown period"
    detected_years[key] = period
    found = 0
    with open(csv_path) as f:
        for row in csv.DictReader(f):
            code = row["lsoa11"]
            if not (code.startswith("E") or code.startswith("W")):
                continue
            rate = row.get("items_r")
            if not rate or rate == "NA":
                continue
            rec = get(code)
            rec.setdefault("v", {})[key] = round(float(rate), 2)
            found += 1
    print(f"Prescribing {key}: {found} LSOAs @ {period} (auto-detected latest period)")

# ---------- 6. Frailty index (MSOA, full annual series) broadcast to member LSOAs ----------
frailty_dir = RAW / "frailty"
frailty_files = sorted(frailty_dir.glob("*.csv")) if frailty_dir.exists() else []
year_files = {int(p.stem): p for p in frailty_files if p.stem.isdigit()}
if year_files:
    msoa_by_year = {}
    for year, path in year_files.items():
        d = {}
        with open(path) as f:
            for row in csv.DictReader(f):
                d[row["msoa11"]] = float(row["mod_sev_pct"])
        msoa_by_year[year] = d

    lsoa_msoa = {code: rec.get("msoa") for code, rec in records.items()}
    years_present = sorted(str(y) for y in msoa_by_year)
    time_series["frailty"] = {
        str(y): {lsoa: msoa_by_year[y][msoa] for lsoa, msoa in lsoa_msoa.items() if msoa in msoa_by_year[y]}
        for y in msoa_by_year
    }

    latest_year = max(msoa_by_year)
    detected_years["frailty"] = str(latest_year)
    frailty_applied = 0
    for code, rec in records.items():
        msoa = rec.get("msoa")
        if msoa in msoa_by_year[latest_year]:
            rec.setdefault("v", {})["frailty"] = round(msoa_by_year[latest_year][msoa], 2)
            frailty_applied += 1
    print(f"Frailty: broadcast to {frailty_applied} LSOAs from {len(msoa_by_year[latest_year])} MSOAs @ {latest_year} "
          f"(auto-detected latest year; {len(years_present)} years of history retained)")

# ---------- 7. Population by broad age band -> % aged 65+ per LSOA (2011 geography) ----------
pct65 = {}
age_pop_path = RAW / "age_pop" / "sapelsoabroadage.xlsx"
lookup_path = STATIC / "lsoa11_to_lsoa21_lookup.csv"
if age_pop_path.exists() and lookup_path.exists():
    xl = pd.ExcelFile(age_pop_path)
    # Sheets are named e.g. "Mid-2022 LSOA 2021" — pick the latest year available.
    year_sheets = {}
    for s in xl.sheet_names:
        m = re.match(r"Mid-(\d{4}) LSOA", s)
        if m:
            year_sheets[int(m.group(1))] = s
    latest_pop_year = max(year_sheets)
    sheet_name = year_sheets[latest_pop_year]
    df = pd.read_excel(age_pop_path, sheet_name=sheet_name, header=3)
    col_65 = [c for c in df.columns if "65" in str(c)]
    total_col = "Total"
    lsoa21_col = next(c for c in df.columns if "LSOA" in str(c) and "Code" in str(c))
    pct65_by_lsoa21 = {}
    for _, row in df.iterrows():
        total = row[total_col]
        if not total:
            continue
        p65 = sum(row[c] for c in col_65)
        pct65_by_lsoa21[row[lsoa21_col]] = p65 / total * 100

    lsoa11_to_21 = defaultdict(list)
    with open(lookup_path) as f:
        for row in csv.DictReader(f):
            lsoa11_to_21[row["LSOA11CD"]].append(row["LSOA21CD"])

    for lsoa11, lsoa21_list in lsoa11_to_21.items():
        vals = [pct65_by_lsoa21[c] for c in lsoa21_list if c in pct65_by_lsoa21]
        if vals:
            pct65[lsoa11] = sum(vals) / len(vals)

    for code, val in pct65.items():
        if code in records:
            records[code].setdefault("v", {})["pct65"] = round(val, 2)

    print(f"Age profile: % 65+ computed for {len(pct65)} LSOAs from mid-{latest_pop_year} "
          f"population estimates (2021 LSOA geography, matched via ONS exact-fit crosswalk)")
else:
    print("Age profile: source files missing, skipping age-adjustment features")

# ---------- 8. Derived statistic: percentile rank (0-100) for every indicator ----------
def add_percentiles(key):
    pairs = [(code, rec["v"][key]) for code, rec in records.items() if key in rec.get("v", {})]
    if len(pairs) < 2:
        return
    pairs.sort(key=lambda p: p[1])
    n = len(pairs)
    for i, (code, _) in enumerate(pairs):
        pctile = i / (n - 1) * 100
        records[code]["v"][f"{key}_pctile"] = round(pctile, 1)


# ---------- 9. Derived statistics: year-on-year % change + z-score of change ----------
def add_change_stats(key):
    if key not in time_series:
        return
    years = sorted(time_series[key].keys(), key=lambda y: int(y))
    if len(years) < 2:
        return
    t1, t0 = years[-1], years[-2]
    v1, v0 = time_series[key][t1], time_series[key][t0]
    common = [c for c in v1 if c in v0]

    changes = {}
    for code in common:
        if v0[code] != 0:
            changes[code] = v1[code] - v0[code]   # absolute (percentage-point) change

    if not changes:
        return
    change_vals = np.array(list(changes.values()))
    mean_change, sd_change = change_vals.mean(), change_vals.std()

    for code in common:
        rec = get(code)
        if v0[code] != 0:
            yoy_pct = (v1[code] - v0[code]) / v0[code] * 100
            rec.setdefault("v", {})[f"{key}_yoy"] = round(yoy_pct, 2)
        if code in changes and sd_change > 0:
            z = (changes[code] - mean_change) / sd_change
            rec.setdefault("v", {})[f"{key}_z"] = round(float(z), 3)

    print(f"  {key}: change stats {t0}->{t1} for {len(common)} LSOAs "
          f"(mean change {mean_change:+.3f}, SD {sd_change:.3f})")


# ---------- 10. Derived statistic: age-profile-adjusted ratio (QOF conditions only) ----------
def fit_age_adjustment(key):
    """
    Indirect-standardisation-style adjustment, NOT a true directly age-
    standardised rate. A true DSR needs age-*specific* prevalence (e.g. a
    separate rate for 65-74, 75-84, 85+) re-weighted onto a standard
    population's age structure. NHS QOF data is only published as a single
    all-ages rate per LSOA — no age-specific numerator exists at this
    geography — so a real DSR cannot be computed from this source.

    What this computes instead: fit rate ~ pct65 as a simple linear
    regression across every LSOA with data, then for each LSOA:
        adjusted_ratio = observed_rate / rate_predicted_from_its_own_pct65
    A ratio of 1.0 means "exactly what you'd expect given how old the local
    population is"; above 1.0 means higher than that area's age profile
    alone would predict; below 1.0 means lower. This is the same logic as
    an indirect-standardisation / SMR-style ratio, and is a reasonable,
    transparent proxy — but it only controls for the *linear* association
    between one covariate (% 65+) and the rate, not the full age-specific
    structure a proper DSR would use. Documented plainly in the About panel
    so this is never mistaken for a certified age-standardised rate.
    """
    pairs = [(code, rec["v"][key]) for code, rec in records.items() if key in rec.get("v", {}) and code in pct65]
    if len(pairs) < 30:
        return
    codes = [p[0] for p in pairs]
    y = np.array([p[1] for p in pairs])
    x = np.array([pct65[c] for c in codes])
    slope, intercept = np.polyfit(x, y, 1)
    predicted = intercept + slope * x
    predicted = np.where(predicted <= 0, np.nan, predicted)
    ratio = y / predicted
    r2 = 1 - np.nansum((y - predicted) ** 2) / np.sum((y - y.mean()) ** 2)

    n_applied = 0
    for code, r in zip(codes, ratio):
        if np.isfinite(r):
            records[code].setdefault("v", {})[f"{key}_adj"] = round(float(r), 3)
            n_applied += 1
    print(f"  {key}: age-adjusted ratio for {n_applied} LSOAs "
          f"(slope={slope:.4f}, R²={r2:.3f} — % 65+ explains {r2*100:.0f}% of cross-LSOA variance)")


def national_trend(key):
    """
    Year-by-year England-wide summary (mean, median, 10th/90th percentile
    across all LSOAs) for one indicator. This is what actually powers the
    "trajectory" view cheaply: it's ~20 numbers per statistic, embedded
    directly in meta.json, versus the ~33,000-LSOA full series (only worth
    fetching lazily, and only for one specific area at a time).
    """
    if key not in time_series:
        return None
    years = sorted(time_series[key].keys(), key=lambda y: int(y))
    out = {"years": [int(y) for y in years], "mean": [], "median": [], "p10": [], "p90": []}
    for y in years:
        vals = np.array(list(time_series[key][y].values()))
        if len(vals) == 0:
            out["mean"].append(None); out["median"].append(None)
            out["p10"].append(None); out["p90"].append(None)
            continue
        out["mean"].append(round(float(vals.mean()), 3))
        out["median"].append(round(float(np.median(vals)), 3))
        out["p10"].append(round(float(np.percentile(vals, 10)), 3))
        out["p90"].append(round(float(np.percentile(vals, 90)), 3))
    return out


print("\nComputing derived statistics...")
for key in QOF_KEYS + PRESCRIBING_KEYS + ["frailty", "imd_health_en", "wimd_health_wa", "wimd_overall_wa", "pct65"]:
    add_percentiles(key)

print("Year-on-year change + z-score of change (QOF conditions + frailty):")
for key in TREND_KEYS:
    add_change_stats(key)

if pct65:
    print("Age-profile-adjusted ratio (QOF conditions only):")
    for key in QOF_KEYS:
        fit_age_adjustment(key)
    for key in QOF_KEYS:
        add_percentiles(f"{key}_adj")

print("National year-by-year aggregates (mean/median/p10/p90):")
national_trends = {}
for key in TREND_KEYS:
    nt = national_trend(key)
    if nt:
        national_trends[key] = nt
        print(f"  {key}: {len(nt['years'])} years, latest mean={nt['mean'][-1]}")

# ---------- 11. Clean up, then pack into a compact array format ----------
# A plain {"chd": 3.2, "chd_pctile": 62.4, ...} object per LSOA repeats every
# key name as literal text ~33,000 times — with ~70 derived fields per LSOA
# that overhead alone was pushing this file past 40MB. Instead, every LSOA's
# values are packed into a flat array in a fixed order (meta.json's "schema"
# lists what each position means), so a key name is only ever written once
# for the whole file, not once per LSOA.
final = {}
for code, rec in records.items():
    if "n" not in rec or "v" not in rec:
        continue
    final[code] = {"n": rec["n"], "la": rec.get("la", ""), "c": rec.get("c", code[0]), "v": rec["v"]}

print(f"\nTotal LSOAs in output: {len(final)}")

indicator_values = defaultdict(list)
for rec in final.values():
    for k, v in rec["v"].items():
        indicator_values[k].append(v)

ALL_BASE_KEYS_ORDER = QOF_KEYS + PRESCRIBING_KEYS + ["frailty", "imd_health_en", "wimd_health_wa", "wimd_overall_wa", "pct65"]
SUFFIXES_ORDER = ["", "_pctile", "_yoy", "_z", "_adj", "_adj_pctile"]
schema = [
    f"{base}{suf}"
    for base in ALL_BASE_KEYS_ORDER
    for suf in SUFFIXES_ORDER
    if f"{base}{suf}" in indicator_values
]
schema_index = {key: i for i, key in enumerate(schema)}

packed = {}
for code, rec in final.items():
    arr = [None] * len(schema)
    for k, v in rec["v"].items():
        arr[schema_index[k]] = v
    packed[code] = {"n": rec["n"], "la": rec["la"], "c": rec["c"], "v": arr}

with open(OUT / "lsoa_data.json", "w") as f:
    json.dump(packed, f, separators=(",", ":"))
print(f"Wrote lsoa_data.json ({(OUT/'lsoa_data.json').stat().st_size/1e6:.1f} MB, {len(schema)}-field schema)")

# ---------- 12. Write lazy-loaded trend files (one per indicator with history) ----------
for key in TREND_KEYS:
    if key not in time_series:
        continue
    years = sorted(time_series[key].keys(), key=lambda y: int(y))
    data = defaultdict(list)
    for y in years:
        year_vals = time_series[key][y]
        for code in final:
            data[code].append(year_vals.get(code))
    # drop LSOAs with no data at all across every year (keeps file smaller)
    data = {code: vals for code, vals in data.items() if any(v is not None for v in vals)}
    trend_path = OUT / f"trend_{key}.json"
    with open(trend_path, "w") as f:
        json.dump({"years": [int(y) for y in years], "data": data}, f, separators=(",", ":"))
    print(f"Wrote {trend_path.name} ({trend_path.stat().st_size/1e6:.1f} MB, {len(data)} LSOAs x {len(years)} years)")

# ---------- 13. Metadata ----------
def quantile_breaks(values, n=5):
    values = sorted(values)
    if not values:
        return []
    return [round(values[min(int(len(values) * i / n), len(values) - 1)], 3) for i in range(1, n)]


meta = {
    "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    "geography": "LSOA 2011 (England & Wales)",
    "reform_years": REFORM_YEARS,
    "schema": schema,
    "national_trends": national_trends,
    "indicators": {}
}

INDICATOR_META = {
    "chd": {"label": "Coronary heart disease", "group": "QOF conditions (England)", "unit": "% of registered patients", "source": "NHS QOF via PLDR (QOF_4_02)", "coverage": "England (+ partial border areas)"},
    "copd": {"label": "COPD", "group": "QOF conditions (England)", "unit": "% of registered patients", "source": "NHS QOF via PLDR (QOF_4_04)", "coverage": "England (+ partial border areas)"},
    "af": {"label": "Atrial fibrillation", "group": "QOF conditions (England)", "unit": "% of registered patients", "source": "NHS QOF via PLDR (QOF_4_07)", "coverage": "England (+ partial border areas)"},
    "stroke": {"label": "Stroke / TIA", "group": "QOF conditions (England)", "unit": "% of registered patients", "source": "NHS QOF via PLDR (QOF_4_10)", "coverage": "England (+ partial border areas)"},
    "ckd": {"label": "Chronic kidney disease", "group": "QOF conditions (England)", "unit": "% of registered patients", "source": "NHS QOF via PLDR (QOF_4_08)", "coverage": "England (+ partial border areas)"},
    "hf": {"label": "Heart failure", "group": "QOF conditions (England)", "unit": "% of registered patients", "source": "NHS QOF via PLDR (QOF_4_14)", "coverage": "England (+ partial border areas)"},
    "pad": {"label": "Peripheral arterial disease", "group": "QOF conditions (England)", "unit": "% of registered patients", "source": "NHS QOF via PLDR (QOF_4_16)", "coverage": "England (+ partial border areas)"},
    "osteo": {"label": "Osteoporosis", "group": "QOF conditions (England)", "unit": "% of registered patients (aged 50+ register)", "source": "NHS QOF via PLDR (QOF_4_19)", "coverage": "England (+ partial border areas)"},
    "statins": {"label": "Statins prescribing", "group": "Prescribing (England)", "unit": "items per 1,000 patients (rate)", "source": "NHSBSA via PLDR (P_1_08)", "coverage": "England (+ partial border areas)"},
    "oac": {"label": "Oral anticoagulants", "group": "Prescribing (England)", "unit": "items per 1,000 patients (rate)", "source": "NHSBSA via PLDR (P_1_18)", "coverage": "England (+ partial border areas)"},
    "anticoag": {"label": "Anti-coagulants (all)", "group": "Prescribing (England)", "unit": "items per 1,000 patients (rate)", "source": "NHSBSA via PLDR (P_1_11)", "coverage": "England (+ partial border areas)"},
    "clopidogrel": {"label": "Clopidogrel", "group": "Prescribing (England)", "unit": "items per 1,000 patients (rate)", "source": "NHSBSA via PLDR (P_1_15)", "coverage": "England (+ partial border areas)"},
    "prasugrel": {"label": "Prasugrel", "group": "Prescribing (England)", "unit": "items per 1,000 patients (rate)", "source": "NHSBSA via PLDR (P_1_16)", "coverage": "England (+ partial border areas)"},
    "ticagrelor": {"label": "Ticagrelor", "group": "Prescribing (England)", "unit": "items per 1,000 patients (rate)", "source": "NHSBSA via PLDR (P_1_17)", "coverage": "England (+ partial border areas)"},
    "frailty": {"label": "Moderate/severe frailty (65+)", "group": "Frailty", "unit": "% of population aged 65+", "source": "Small Area Frailty Index via PLDR (MSOA level, shown per LSOA)", "coverage": "England only"},
    "imd_health_en": {"label": "Health deprivation score (England)", "group": "Deprivation", "unit": "IMD2019 Health Domain score (higher = worse)", "source": "MHCLG English Indices of Deprivation 2019", "coverage": "England only"},
    "wimd_health_wa": {"label": "Health domain score (Wales)", "group": "Deprivation", "unit": "WIMD2019 Health Domain score (higher = worse)", "source": "Welsh Government, WIMD 2019", "coverage": "Wales only"},
    "wimd_overall_wa": {"label": "Overall deprivation score (Wales)", "group": "Deprivation", "unit": "WIMD2019 overall score (higher = worse)", "source": "Welsh Government, WIMD 2019", "coverage": "Wales only"},
    "pct65": {"label": "Population aged 65+", "group": "Population context", "unit": "% of usual residents", "source": "ONS mid-year LSOA population estimates by broad age band", "coverage": "England & Wales"},
}
STATIC_YEAR_FALLBACK = {"imd_health_en": "2019", "wimd_health_wa": "2019", "wimd_overall_wa": "2019", "pct65": "n/a"}

all_keys = set(indicator_values.keys())

# Base indicators (raw values) — everything else (_pctile, _yoy, _z, _adj) is
# a derived suffix of one of these and inherits its label/group/etc.
base_keys = [k for k in all_keys if not re.search(r"_(pctile|yoy|z|adj)$", k)]

for key in base_keys:
    m = dict(INDICATOR_META.get(key, {"label": key, "group": "Other", "unit": "", "source": "", "coverage": ""}))
    m["year"] = detected_years.get(key, STATIC_YEAR_FALLBACK.get(key, "unknown"))
    vals = indicator_values[key]
    m["n_lsoas"] = len(vals)
    m["min"] = round(min(vals), 3)
    m["max"] = round(max(vals), 3)
    m["breaks"] = quantile_breaks(vals, 5)

    modes = ["raw", "pctile"]
    if key in TREND_KEYS and f"{key}_yoy" in indicator_values:
        modes += ["yoy", "zscore"]
    if key in QOF_KEYS and f"{key}_adj" in indicator_values:
        modes.append("ageadj")
    m["modes"] = modes
    m["has_trend"] = key in TREND_KEYS and key in time_series

    for suffix, label_suffix in [("_yoy", None), ("_z", None), ("_adj", None), ("_adj_pctile", None)]:
        dk = f"{key}{suffix}"
        if dk in indicator_values:
            dvals = indicator_values[dk]
            m[f"breaks{suffix}"] = quantile_breaks(dvals, 5)
            m[f"min{suffix}"] = round(min(dvals), 3)
            m[f"max{suffix}"] = round(max(dvals), 3)

    meta["indicators"][key] = m

with open(OUT / "meta.json", "w") as f:
    json.dump(meta, f, indent=2)

print("Wrote meta.json")
print("\nIndicator summary:")
for k, m in sorted(meta["indicators"].items()):
    print(f"  {k:14s} year={str(m['year']):12s} n={m['n_lsoas']:6d}  modes={m['modes']}")
