#!/usr/bin/env python3
"""
Joins all downloaded source data into a single compact per-LSOA JSON file
plus a metadata file describing each indicator (source, units, year, breaks).
"""
import csv
import json
import zipfile
import io
from pathlib import Path
from collections import defaultdict

RAW = Path(__file__).resolve().parent.parent / "data" / "raw"
OUT = Path(__file__).resolve().parent.parent / "site" / "data"
OUT.mkdir(parents=True, exist_ok=True)

records = defaultdict(dict)   # lsoa_code -> {n, la, c, msoa, v:{...}}
LATEST_QOF_YEAR = "2024"

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

# LSOA names come from the England IMD file and Wales WIMD file (both have them)
with open(RAW / "england_imd" / "england_health_domain.csv") as f:
    for row in csv.DictReader(f):
        rec = get(row["lsoa11"])
        rec["n"] = row["lsoa_name"]
        rec.setdefault("v", {})["imd_health_en"] = round(float(row["health_deprivation_score"]), 3)

with open(RAW / "wales" / "wimd_2019_scores.csv") as f:
    for row in csv.DictReader(f):
        code = row["LSOA code"]
        rec = get(code)
        rec["n"] = row["LSOA name"]
        rec["la"] = row["Local Authority name "].strip()
        rec["c"] = "W"
        rec.setdefault("v", {})["wimd_health_wa"] = round(float(row["Health"]), 3)
        rec["v"]["wimd_overall_wa"] = round(float(row["WIMD 2019 "]), 3)

# ---------- 2. QOF disease-prevalence indicators (LSOA, latest year) ----------
QOF_FILES = {
    "chd": "CHD.csv",
    "copd": "COPD.csv",
    "af": "AF.csv",
    "stroke": "Stroke.csv",
    "ckd": "CKD.csv",
    "hf": "HeartFailure.csv",
    "pad": "PAD.csv",
    "osteo": "Osteoporosis.csv",
}
for key, fname in QOF_FILES.items():
    path = RAW / "qof" / fname
    found = 0
    with open(path) as f:
        for row in csv.DictReader(f):
            if row["year"] != LATEST_QOF_YEAR:
                continue
            code = row["lsoa11"]
            rate = row["p_rate"]
            if not rate or rate == "NA":
                continue
            rec = get(code)
            rec.setdefault("v", {})[key] = round(float(rate), 3)
            found += 1
    print(f"QOF {key}: {found} LSOAs @ {LATEST_QOF_YEAR}")

# ---------- 3. Prescribing indicators (latest quarter, items rate per 1,000) ----------
PRESCRIBING_LATEST = {
    "statins": "Statins_latest.csv",
    "oac": "OralAnticoagulants_latest.csv",
    "anticoag": "AntiCoagulants_latest.csv",
    "clopidogrel": "Clopidogrel_latest.csv",
    "prasugrel": "Prasugrel_latest.csv",
    "ticagrelor": "Ticagrelor_latest.csv",
}
for key, fname in PRESCRIBING_LATEST.items():
    path = RAW / "prescribing" / "extracted" / fname
    found = 0
    with open(path) as f:
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
    print(f"Prescribing {key}: {found} LSOAs (latest quarter)")

# ---------- 4. Frailty index (MSOA, latest year) broadcast to member LSOAs ----------
msoa_frailty = {}
with open(RAW / "frailty" / "2022.csv") as f:
    for row in csv.DictReader(f):
        msoa_frailty[row["msoa11"]] = float(row["mod_sev_pct"])

frailty_applied = 0
for code, rec in records.items():
    msoa = rec.get("msoa")
    if msoa in msoa_frailty:
        rec.setdefault("v", {})["frailty"] = round(msoa_frailty[msoa], 2)
        frailty_applied += 1
print(f"Frailty: broadcast to {frailty_applied} LSOAs from {len(msoa_frailty)} MSOAs")

# ---------- 5. Clean up & write ----------
final = {}
for code, rec in records.items():
    if "n" not in rec or "v" not in rec:
        continue
    final[code] = {
        "n": rec["n"],
        "la": rec.get("la", ""),
        "c": rec.get("c", code[0]),
        "v": rec["v"],
    }

print(f"\nTotal LSOAs in output: {len(final)}")

with open(OUT / "lsoa_data.json", "w") as f:
    json.dump(final, f, separators=(",", ":"))

size_mb = (OUT / "lsoa_data.json").stat().st_size / 1e6
print(f"Wrote lsoa_data.json ({size_mb:.1f} MB)")

# ---------- 6. Metadata: indicator definitions, sources, breaks ----------
def quantile_breaks(values, n=5):
    values = sorted(values)
    if not values:
        return []
    breaks = []
    for i in range(1, n):
        idx = int(len(values) * i / n)
        breaks.append(round(values[min(idx, len(values)-1)], 3))
    return breaks

all_keys = set()
for rec in final.values():
    all_keys.update(rec["v"].keys())

indicator_values = defaultdict(list)
for rec in final.values():
    for k, v in rec["v"].items():
        indicator_values[k].append(v)

meta = {
    "generated": "auto",
    "geography": "LSOA 2011 (England & Wales)",
    "indicators": {}
}

INDICATOR_META = {
    "chd": {"label": "Coronary heart disease", "group": "QOF conditions (England)", "unit": "% of registered patients", "source": "NHS QOF via PLDR (QOF_4_02)", "year": LATEST_QOF_YEAR, "coverage": "England (+ partial border areas)"},
    "copd": {"label": "COPD", "group": "QOF conditions (England)", "unit": "% of registered patients", "source": "NHS QOF via PLDR (QOF_4_04)", "year": LATEST_QOF_YEAR, "coverage": "England (+ partial border areas)"},
    "af": {"label": "Atrial fibrillation", "group": "QOF conditions (England)", "unit": "% of registered patients", "source": "NHS QOF via PLDR (QOF_4_07)", "year": LATEST_QOF_YEAR, "coverage": "England (+ partial border areas)"},
    "stroke": {"label": "Stroke / TIA", "group": "QOF conditions (England)", "unit": "% of registered patients", "source": "NHS QOF via PLDR (QOF_4_10)", "year": LATEST_QOF_YEAR, "coverage": "England (+ partial border areas)"},
    "ckd": {"label": "Chronic kidney disease", "group": "QOF conditions (England)", "unit": "% of registered patients", "source": "NHS QOF via PLDR (QOF_4_08)", "year": LATEST_QOF_YEAR, "coverage": "England (+ partial border areas)"},
    "hf": {"label": "Heart failure", "group": "QOF conditions (England)", "unit": "% of registered patients", "source": "NHS QOF via PLDR (QOF_4_14)", "year": LATEST_QOF_YEAR, "coverage": "England (+ partial border areas)"},
    "pad": {"label": "Peripheral arterial disease", "group": "QOF conditions (England)", "unit": "% of registered patients", "source": "NHS QOF via PLDR (QOF_4_16)", "year": LATEST_QOF_YEAR, "coverage": "England (+ partial border areas)"},
    "osteo": {"label": "Osteoporosis", "group": "QOF conditions (England)", "unit": "% of registered patients (aged 50+ register)", "source": "NHS QOF via PLDR (QOF_4_19)", "year": LATEST_QOF_YEAR, "coverage": "England (+ partial border areas)"},
    "statins": {"label": "Statins prescribing", "group": "Prescribing (England)", "unit": "items per 1,000 patients (rate)", "source": "NHSBSA via PLDR (P_1_08)", "year": "2025 Q4", "coverage": "England (+ partial border areas)"},
    "oac": {"label": "Oral anticoagulants", "group": "Prescribing (England)", "unit": "items per 1,000 patients (rate)", "source": "NHSBSA via PLDR (P_1_18)", "year": "2025 Q4", "coverage": "England (+ partial border areas)"},
    "anticoag": {"label": "Anti-coagulants (all)", "group": "Prescribing (England)", "unit": "items per 1,000 patients (rate)", "source": "NHSBSA via PLDR (P_1_11)", "year": "2025 Q4", "coverage": "England (+ partial border areas)"},
    "clopidogrel": {"label": "Clopidogrel", "group": "Prescribing (England)", "unit": "items per 1,000 patients (rate)", "source": "NHSBSA via PLDR (P_1_15)", "year": "2025 Q4", "coverage": "England (+ partial border areas)"},
    "prasugrel": {"label": "Prasugrel", "group": "Prescribing (England)", "unit": "items per 1,000 patients (rate)", "source": "NHSBSA via PLDR (P_1_16)", "year": "2025 Q4", "coverage": "England (+ partial border areas)"},
    "ticagrelor": {"label": "Ticagrelor", "group": "Prescribing (England)", "unit": "items per 1,000 patients (rate)", "source": "NHSBSA via PLDR (P_1_17)", "year": "2025 Q4", "coverage": "England (+ partial border areas)"},
    "frailty": {"label": "Moderate/severe frailty (65+)", "group": "Frailty", "unit": "% of population aged 65+", "source": "Small Area Frailty Index via PLDR (MSOA level, shown per LSOA)", "year": "2022", "coverage": "England only"},
    "imd_health_en": {"label": "Health deprivation score (England)", "group": "Deprivation", "unit": "IMD2019 Health Domain score (higher = worse)", "source": "MHCLG English Indices of Deprivation 2019", "year": "2019", "coverage": "England only"},
    "wimd_health_wa": {"label": "Health domain score (Wales)", "group": "Deprivation", "unit": "WIMD2019 Health Domain score (higher = worse)", "source": "Welsh Government, WIMD 2019", "year": "2019", "coverage": "Wales only"},
    "wimd_overall_wa": {"label": "Overall deprivation score (Wales)", "group": "Deprivation", "unit": "WIMD2019 overall score (higher = worse)", "source": "Welsh Government, WIMD 2019", "year": "2019", "coverage": "Wales only"},
}

for key in all_keys:
    m = dict(INDICATOR_META.get(key, {"label": key, "group": "Other", "unit": "", "source": "", "year": "", "coverage": ""}))
    vals = indicator_values[key]
    m["n_lsoas"] = len(vals)
    m["min"] = round(min(vals), 3)
    m["max"] = round(max(vals), 3)
    m["breaks"] = quantile_breaks(vals, 5)
    meta["indicators"][key] = m

with open(OUT / "meta.json", "w") as f:
    json.dump(meta, f, indent=2)

print("Wrote meta.json")
print("\nIndicator coverage summary:")
for k, m in sorted(meta["indicators"].items()):
    print(f"  {k:16s} n={m['n_lsoas']:6d}  range=[{m['min']}, {m['max']}]")
