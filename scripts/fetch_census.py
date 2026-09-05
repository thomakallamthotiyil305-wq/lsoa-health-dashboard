#!/usr/bin/env python3
"""
One-off fetch of self-reported general health from the 2011 and 2021
Censuses, at LSOA level, via the Nomis API. Like fetch_boundaries.py, this
is NOT run on a schedule — a Census happens once a decade, so there's
nothing new to pick up between now and 2031's census.

Sources (Open Government Licence v3.0):
  2021: Census 2021, table TS037 "General health", ONS via Nomis
        https://www.nomisweb.co.uk/datasets/c2021ts037
  2011: Census 2011, table KS301EW "Health and provision of unpaid care", ONS via Nomis
        https://www.nomisweb.co.uk/census/2011/ks301ew

Both censuses ask (near-identically worded) "How is your health in
general?" with the same five-point scale (Very good / Good / Fair / Bad /
Very bad), which is what makes a 2011-to-2021 comparison meaningful here —
unlike deprivation indices, this is the same question asked the same way a
decade apart, not a re-designed composite index.
"""
import csv
import time
import urllib.request
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw" / "census"
STATIC = ROOT / "data" / "static"
UA = {"User-Agent": "Mozilla/5.0 (lsoa-health-dashboard census bot)"}
PAGE_SIZE = 25000

HEALTH_CATEGORIES = {"Very good health", "Good health", "Fair health", "Bad health", "Very bad health"}


def fetch_nomis_csv(dataset_id, geography_type, extra_params, out_path, category_col="cell_name"):
    RAW.mkdir(parents=True, exist_ok=True)
    rows = []
    offset = 0
    header = None
    while True:
        url = (
            f"https://www.nomisweb.co.uk/api/v01/dataset/{dataset_id}.data.csv"
            f"?geography=TYPE{geography_type}&{extra_params}"
            f"&select=geography_code,geography_name,{category_col},obs_value"
            f"&recordoffset={offset}"
        )
        req = urllib.request.Request(url, headers=UA)
        with urllib.request.urlopen(req, timeout=60) as r:
            text = r.read().decode("utf-8")
        lines = text.splitlines()
        if header is None:
            header = lines[0]
        body = lines[1:]
        if not body:
            break
        rows.extend(body)
        print(f"  {dataset_id}: fetched {len(rows)} rows so far...")
        if len(body) < PAGE_SIZE:
            break
        offset += PAGE_SIZE
        time.sleep(1)  # be polite to Nomis between pages

    with open(out_path, "w") as f:
        f.write(header + "\n")
        f.write("\n".join(rows) + "\n")
    print(f"  wrote {out_path} ({len(rows)} rows)")


def summarise(raw_csv_path, category_col):
    """Collapse the 5 health categories per LSOA into a single % bad/very bad health."""
    totals = defaultdict(lambda: defaultdict(float))
    with open(raw_csv_path) as f:
        for row in csv.DictReader(f):
            cat = row[category_col.upper()].strip('"')
            if cat not in HEALTH_CATEGORIES:
                continue
            code = row["GEOGRAPHY_CODE"].strip('"')
            totals[code][cat] += float(row["OBS_VALUE"])

    pct_bad = {}
    for code, cats in totals.items():
        total = sum(cats.values())
        if total <= 0:
            continue
        bad = cats.get("Bad health", 0) + cats.get("Very bad health", 0)
        pct_bad[code] = bad / total * 100
    return pct_bad


def main():
    print("== Census 2021: TS037 General health (2021 LSOAs) ==")
    census2021_path = RAW / "ts037_2021.csv"
    fetch_nomis_csv("NM_2055_1", 151, "c2021_health_6=0...5&measures=20100", census2021_path, category_col="c2021_health_6_name")
    pct_2021_by_lsoa21 = summarise(census2021_path, category_col="c2021_health_6_name")
    print(f"  {len(pct_2021_by_lsoa21)} LSOA21 areas summarised")

    print("\n== Census 2011: KS301EW Health and unpaid care (2011 LSOAs) ==")
    census2011_path = RAW / "ks301ew_2011.csv"
    fetch_nomis_csv("NM_617_1", 298, "rural_urban=0&measures=20100", census2011_path, category_col="cell_name")
    pct_2011_by_lsoa11 = summarise(census2011_path, category_col="cell_name")
    print(f"  {len(pct_2011_by_lsoa11)} LSOA11 areas summarised")

    print("\n== Crosswalking 2021 figures onto 2011 LSOA geography ==")
    lookup_path = STATIC / "lsoa11_to_lsoa21_lookup.csv"
    lsoa11_to_21 = defaultdict(list)
    with open(lookup_path) as f:
        for row in csv.DictReader(f):
            lsoa11_to_21[row["LSOA11CD"]].append(row["LSOA21CD"])

    pct_2021_by_lsoa11 = {}
    for lsoa11, lsoa21_list in lsoa11_to_21.items():
        vals = [pct_2021_by_lsoa21[c] for c in lsoa21_list if c in pct_2021_by_lsoa21]
        if vals:
            pct_2021_by_lsoa11[lsoa11] = sum(vals) / len(vals)
    print(f"  {len(pct_2021_by_lsoa11)} LSOA11 areas matched to 2021 figures")

    out_path = STATIC / "census_general_health.csv"
    with open(out_path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["LSOA11CD", "pct_bad_health_2011", "pct_bad_health_2021"])
        all_codes = set(pct_2011_by_lsoa11) | set(pct_2021_by_lsoa11)
        for code in sorted(all_codes):
            w.writerow([
                code,
                round(pct_2011_by_lsoa11[code], 3) if code in pct_2011_by_lsoa11 else "",
                round(pct_2021_by_lsoa11.get(code, float("nan")), 3) if code in pct_2021_by_lsoa11 else "",
            ])
    print(f"\nWrote {out_path} ({len(all_codes)} LSOAs)")


if __name__ == "__main__":
    main()
