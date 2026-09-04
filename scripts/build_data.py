#!/usr/bin/env python3
"""
Joins all downloaded source data into a single compact per-LSOA JSON file
plus a metadata file describing each indicator (source, units, year, breaks).

Fully dynamic: every "latest year / latest quarter" is auto-detected from
whatever files fetch_raw.py most recently downloaded — nothing here is
hardcoded to a specific year, so re-running fetch_raw.py + build_data.py
after new data is published upstream picks it up automatically.
"""
import csv
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from collections import defaultdict

import pandas as pd

RAW = Path(__file__).resolve().parent.parent / "data" / "raw"
OUT = Path(__file__).resolve().parent.parent / "site" / "data"
OUT.mkdir(parents=True, exist_ok=True)

records = defaultdict(dict)   # lsoa_code -> {n, la, c, msoa, v:{...}}
detected_years = {}            # indicator key -> year/period string actually used

def get(code):
    return records[code]

# ---------- 1. LSOA -> MSOA -> LAD lookup (name/LA/country backbone) ----------
with open(RAW / "lsoa_msoa_lad_lookup.csv") as f:
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

# ---------- 4. QOF disease-prevalence indicators — latest year auto-detected per file ----------
# Keys must match fetch_raw.py's QOF_DATASETS keys exactly (it writes
# "qof/<key>.csv") — see the note on PRESCRIBING_KEYS above re: case-sensitive
# filesystems masking a mismatch here on macOS but not on Linux CI runners.
QOF_KEYS = ["chd", "copd", "af", "stroke", "ckd", "hf", "pad", "osteo"]
for key in QOF_KEYS:
    path = RAW / "qof" / f"{key}.csv"
    if not path.exists():
        print(f"QOF {key}: file missing, skipped")
        continue
    rows_by_lsoa_year = {}
    years_seen = set()
    with open(path) as f:
        for row in csv.DictReader(f):
            yr = row["year"]
            rate = row["p_rate"]
            if not rate or rate == "NA":
                continue
            years_seen.add(yr)
            rows_by_lsoa_year[(row["lsoa11"], yr)] = rate
    if not years_seen:
        continue
    latest = max(years_seen)
    detected_years[key] = latest
    found = 0
    for (code, yr), rate in rows_by_lsoa_year.items():
        if yr != latest:
            continue
        rec = get(code)
        rec.setdefault("v", {})[key] = round(float(rate), 3)
        found += 1
    print(f"QOF {key}: {found} LSOAs @ {latest} (auto-detected latest year)")

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

# ---------- 6. Frailty index (MSOA, latest year auto-detected) broadcast to member LSOAs ----------
frailty_dir = RAW / "frailty"
frailty_files = sorted(frailty_dir.glob("*.csv")) if frailty_dir.exists() else []
year_files = [(int(p.stem), p) for p in frailty_files if p.stem.isdigit()]
if year_files:
    latest_year, latest_path = max(year_files, key=lambda t: t[0])
    detected_years["frailty"] = str(latest_year)
    msoa_frailty = {}
    with open(latest_path) as f:
        for row in csv.DictReader(f):
            msoa_frailty[row["msoa11"]] = float(row["mod_sev_pct"])
    frailty_applied = 0
    for code, rec in records.items():
        msoa = rec.get("msoa")
        if msoa in msoa_frailty:
            rec.setdefault("v", {})["frailty"] = round(msoa_frailty[msoa], 2)
            frailty_applied += 1
    print(f"Frailty: broadcast to {frailty_applied} LSOAs from {len(msoa_frailty)} MSOAs @ {latest_year} (auto-detected latest year)")

# ---------- 7. Clean up & write ----------
final = {}
for code, rec in records.items():
    if "n" not in rec or "v" not in rec:
        continue
    final[code] = {"n": rec["n"], "la": rec.get("la", ""), "c": rec.get("c", code[0]), "v": rec["v"]}

print(f"\nTotal LSOAs in output: {len(final)}")

with open(OUT / "lsoa_data.json", "w") as f:
    json.dump(final, f, separators=(",", ":"))

size_mb = (OUT / "lsoa_data.json").stat().st_size / 1e6
print(f"Wrote lsoa_data.json ({size_mb:.1f} MB)")

# ---------- 8. Metadata: indicator definitions, sources, breaks (years auto-filled) ----------
def quantile_breaks(values, n=5):
    values = sorted(values)
    if not values:
        return []
    return [round(values[min(int(len(values) * i / n), len(values) - 1)], 3) for i in range(1, n)]

indicator_values = defaultdict(list)
for rec in final.values():
    for k, v in rec["v"].items():
        indicator_values[k].append(v)

meta = {
    "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    "geography": "LSOA 2011 (England & Wales)",
    "indicators": {}
}

# Static fields (label/group/unit/source/coverage never change); "year" is
# filled from detected_years at build time, falling back to this default
# only for indicators that don't have a detectable "latest period" concept.
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
}
STATIC_YEAR_FALLBACK = {"imd_health_en": "2019", "wimd_health_wa": "2019", "wimd_overall_wa": "2019"}

all_keys = set(indicator_values.keys())
for key in all_keys:
    m = dict(INDICATOR_META.get(key, {"label": key, "group": "Other", "unit": "", "source": "", "coverage": ""}))
    m["year"] = detected_years.get(key, STATIC_YEAR_FALLBACK.get(key, "unknown"))
    vals = indicator_values[key]
    m["n_lsoas"] = len(vals)
    m["min"] = round(min(vals), 3)
    m["max"] = round(max(vals), 3)
    m["breaks"] = quantile_breaks(vals, 5)
    meta["indicators"][key] = m

with open(OUT / "meta.json", "w") as f:
    json.dump(meta, f, indent=2)

print(f"Wrote meta.json (generated {meta['generated']})")
print("\nIndicator coverage summary:")
for k, m in sorted(meta["indicators"].items()):
    print(f"  {k:16s} year={m['year']:12s} n={m['n_lsoas']:6d}  range=[{m['min']}, {m['max']}]")
