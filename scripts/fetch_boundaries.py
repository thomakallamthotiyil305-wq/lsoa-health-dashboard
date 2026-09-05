#!/usr/bin/env python3
"""
One-off script to (re)build the geography assets committed at
site/data/lsoa_2011.topojson and data/static/lsoa_msoa_lad_lookup.csv.

Unlike fetch_raw.py, this is NOT run on a schedule — 2011 Census geography
is permanently frozen, so it never has new data to pick up. Run this only
if those committed files are ever lost/corrupted, or if a future maintainer
deliberately wants to move to a newer LSOA vintage (2021).

Requires: pip install requests  (stdlib urllib works too but requests
handles the paginated query loop more concisely)
Requires Node + mapshaper for the final simplify/convert step:
  npm install -g mapshaper   (or use npx, as below — no install needed)
"""
import json
import urllib.request
import urllib.parse
import csv
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
STATIC = ROOT / "data" / "static"
SITE_DATA = ROOT / "site" / "data"
UA = {"User-Agent": "Mozilla/5.0 (lsoa-health-dashboard boundary bot)"}

LSOA_BOUNDARY_QUERY_URL = (
    "https://services1.arcgis.com/ESMARspQHYMw9BZ9/arcgis/rest/services/"
    "LSOA_2011_Boundaries_Super_Generalised_Clipped_BSC_EW_V4/FeatureServer/0/query"
)
LOOKUP_QUERY_URL = (
    "https://services1.arcgis.com/ESMARspQHYMw9BZ9/arcgis/rest/services/"
    "OA11_LSOA11_MSOA11_LAD11_EW_LUv2_b3fe7c68f4b2420185eaff6284d4c125/FeatureServer/0/query"
)
LSOA11_TO_LSOA21_QUERY_URL = (
    "https://services1.arcgis.com/ESMARspQHYMw9BZ9/arcgis/rest/services/"
    "LSOA11_LSOA21_LAD22_EW_LU_v5/FeatureServer/0/query"
)
PAGE_SIZE = 2000


def query_all_pages(base_url, params, extract):
    """Paginate an ArcGIS FeatureServer query, yielding accumulated results.

    Advances the offset by however many records actually came back, not by
    the requested page size — some FeatureServer layers cap results below
    what you ask for (this one caps at 1000 even when 2000 is requested),
    and advancing by the requested size in that case would silently skip
    records.
    """
    results = []
    offset = 0
    while True:
        q = dict(params, resultOffset=offset, resultRecordCount=PAGE_SIZE)
        url = base_url + "?" + urllib.parse.urlencode(q)
        req = urllib.request.Request(url, headers=UA)
        with urllib.request.urlopen(req, timeout=60) as r:
            data = json.load(r)
        batch = extract(data)
        if not batch:
            break
        results.extend(batch)
        print(f"  fetched {len(results)} so far...")
        offset += len(batch)
    return results


def fetch_lsoa_boundaries():
    print("== Fetching LSOA 2011 boundaries (super-generalised, clipped) ==")
    features = query_all_pages(
        LSOA_BOUNDARY_QUERY_URL,
        {
            "where": "1=1",
            "outFields": "LSOA11CD,LSOA11NM,LSOA11NMW,LAT,LONG",
            "outSR": "4326",
            "f": "geojson",
        },
        extract=lambda d: d.get("features", []),
    )
    print(f"  total features: {len(features)}")
    RAW.mkdir(parents=True, exist_ok=True)
    out = RAW / "lsoa_2011_bsc.geojson"
    with open(out, "w") as f:
        json.dump({"type": "FeatureCollection", "features": features}, f)
    print(f"  wrote {out}")
    return out


def simplify_boundaries(raw_geojson_path):
    print("\n== Simplifying with mapshaper (this can take a minute) ==")
    SITE_DATA.mkdir(parents=True, exist_ok=True)
    out_path = SITE_DATA / "lsoa_2011.topojson"
    subprocess.run(
        [
            "npx", "--yes", "mapshaper",
            "-i", str(raw_geojson_path),
            "-simplify", "dp", "8%", "keep-shapes",
            "-clean",
            "-o", str(out_path), "format=topojson", "quantization=1e5",
        ],
        check=True,
    )
    print(f"  wrote {out_path}")


def fetch_lookup():
    print("\n== Fetching LSOA -> MSOA -> LAD lookup (2011, exact fit) ==")
    stats = '[{"statisticType":"count","onStatisticField":"OA11CD","outStatisticFieldName":"cnt"}]'
    rows = query_all_pages(
        LOOKUP_QUERY_URL,
        {
            "where": "1=1",
            "groupByFieldsForStatistics": "LSOA11CD,MSOA11CD,LAD11CD,LAD11NM",
            "outStatistics": stats,
            "f": "json",
        },
        extract=lambda d: [f["attributes"] for f in d.get("features", [])],
    )
    print(f"  total rows: {len(rows)}")
    STATIC.mkdir(parents=True, exist_ok=True)
    out = STATIC / "lsoa_msoa_lad_lookup.csv"
    with open(out, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["LSOA11CD", "MSOA11CD", "LAD11CD", "LAD11NM"])
        w.writeheader()
        for r in rows:
            w.writerow({k: r[k] for k in ["LSOA11CD", "MSOA11CD", "LAD11CD", "LAD11NM"]})
    print(f"  wrote {out}")


def fetch_lsoa11_to_lsoa21_lookup():
    print("\n== Fetching LSOA (2011) -> LSOA (2021) exact-fit lookup ==")
    print("   (needed to join 2021-geography population-by-age data onto")
    print("    the 2011-geography disease data used throughout this project)")
    rows = query_all_pages(
        LSOA11_TO_LSOA21_QUERY_URL,
        {"where": "1=1", "outFields": "LSOA11CD,LSOA21CD,CHGIND", "f": "json"},
        extract=lambda d: [f["attributes"] for f in d.get("features", [])],
    )
    print(f"  total rows: {len(rows)}")
    STATIC.mkdir(parents=True, exist_ok=True)
    out = STATIC / "lsoa11_to_lsoa21_lookup.csv"
    with open(out, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["LSOA11CD", "LSOA21CD", "CHGIND"])
        w.writeheader()
        for r in rows:
            w.writerow(r)
    print(f"  wrote {out}")


if __name__ == "__main__":
    raw_path = fetch_lsoa_boundaries()
    simplify_boundaries(raw_path)
    fetch_lookup()
    fetch_lsoa11_to_lsoa21_lookup()
    print("\nDone. site/data/lsoa_2011.topojson, data/static/lsoa_msoa_lad_lookup.csv "
          "and data/static/lsoa11_to_lsoa21_lookup.csv have all been regenerated.")
