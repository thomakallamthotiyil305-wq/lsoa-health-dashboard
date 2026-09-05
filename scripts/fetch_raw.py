#!/usr/bin/env python3
"""
Downloads all raw source data into data/raw/, auto-discovering the latest
available period for each dataset instead of hardcoding years/quarters.
Designed to be re-run on a schedule (see .github/workflows/refresh-data.yml):
re-running it always pulls whatever is currently newest upstream.

Boundaries and the LSOA/MSOA/LAD lookup are NOT re-fetched here — 2011
Census geography is permanently frozen, so those are one-off assets already
committed at site/data/lsoa_2011.topojson. Run fetch_boundaries.py manually
if that ever needs regenerating.
"""
import csv
import http.client
import io
import json
import re
import sys
import time
import urllib.error
import urllib.request
import urllib.parse
import zipfile
from collections import defaultdict
from pathlib import Path

RAW = Path(__file__).resolve().parent.parent / "data" / "raw"
UA = {"User-Agent": "Mozilla/5.0 (lsoa-health-dashboard data-refresh bot)"}


def get(url, timeout=120, retries=3):
    """Fetch a URL, retrying with backoff on transient network failures.
    Some of these source files are 30-40MB; a slow connection can trip the
    socket timeout mid-read (IncompleteRead) well before the request itself
    would be considered hung, so this is a real, expected failure mode in
    CI, not just a hypothetical one — retry rather than aborting the whole
    weekly refresh over one flaky download.
    """
    last_err = None
    for attempt in range(1, retries + 1):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except (http.client.IncompleteRead, TimeoutError, ConnectionError, urllib.error.URLError) as e:
            last_err = e
            if attempt < retries:
                wait = 5 * attempt
                print(f"  [retry {attempt}/{retries}] {url} failed ({e}); waiting {wait}s")
                time.sleep(wait)
    raise last_err


def get_json(url):
    return json.loads(get(url))


def save(path: Path, data: bytes):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    print(f"  wrote {path.relative_to(RAW.parent.parent)} ({len(data)/1024:.0f} KB)")


# ---------------------------------------------------------------------------
# PLDR (CKAN-based) — QOF conditions, prescribing, frailty
# ---------------------------------------------------------------------------
PLDR_API = "https://pldr.org/api/action/package_show?id={}"

QOF_DATASETS = {
    "chd": "2kkd2", "copd": "23q1e", "af": "e1xjv", "stroke": "2gd02",
    "osteo": "2l6rm", "pad": "2o695", "hf": "2woln", "ckd": "vq1n2",
}
PRESCRIBING_DATASETS = {
    "statins": "24j52", "oac": "exzrv", "anticoag": "2jjd2",
    "clopidogrel": "2y3we", "prasugrel": "e5gwv", "ticagrelor": "2wky2",
}
FRAILTY_DATASET = "vqorl"


def pldr_resources(pkg_id):
    d = get_json(PLDR_API.format(pkg_id))
    return d["result"]["resources"]


def fetch_qof():
    print("\n== QOF disease-prevalence indicators (PLDR) ==")
    for key, pkg_id in QOF_DATASETS.items():
        resources = pldr_resources(pkg_id)
        lsoa_csv = next((r for r in resources if r["url"].endswith("_LSOA.csv")), None)
        if not lsoa_csv:
            print(f"  [WARN] {key}: no _LSOA.csv resource found, skipping")
            continue
        data = get(lsoa_csv["url"])
        save(RAW / "qof" / f"{key}.csv", data)


def fetch_frailty():
    print("\n== Small Area Frailty Index (PLDR) ==")
    resources = pldr_resources(FRAILTY_DATASET)
    year_re = re.compile(r"SAFI_65plus_mod_sev_(\d{4})_MSOA\.csv$")
    found = []
    for r in resources:
        m = year_re.search(r["url"])
        if m:
            found.append((int(m.group(1)), r["url"]))
    if not found:
        print("  [WARN] no frailty year files found")
        return
    for year, url in found:
        data = get(url)
        save(RAW / "frailty" / f"{year}.csv", data)
    print(f"  latest year available: {max(y for y, _ in found)}")


def _extract_year_snapshots(zip_bytes, out_dir, key):
    """
    Given a prescribing zip (either the historical "[Version X]" master
    archive, or a single "Quarterly <year>" archive), extract every CSV
    inside, group by year, and write one file per year using that year's
    last available quarter as its annual snapshot — e.g. p_1_08_2019_Q4_LSOA.csv
    becomes prescribing/extracted/statins_2019.csv. Using one consistent
    quarter (the last available each year) makes prescribing's annual
    series comparable year-to-year the same way QOF's genuinely-annual data
    is, rather than mixing quarters.
    Returns the set of years written.
    """
    by_year = defaultdict(list)  # year -> [(quarter_num, csv_name)]
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        for name in zf.namelist():
            if not name.lower().endswith(".csv"):
                continue
            m = re.search(r"(\d{4})_Q(\d)", name)
            if not m:
                continue
            by_year[int(m.group(1))].append((int(m.group(2)), name))

        written = set()
        for year, quarters in by_year.items():
            quarters.sort()
            _, csv_name = quarters[-1]  # last available quarter that year
            save(out_dir / f"{key}_{year}.csv", zf.read(csv_name))
            written.add(year)
    return written


def fetch_prescribing():
    print("\n== Prescribing indicators (PLDR) ==")
    out_dir = RAW / "prescribing" / "extracted"
    out_dir.mkdir(parents=True, exist_ok=True)
    quarterly_re = re.compile(r"Quarterly[%\s]+(\d{4})\.zip$", re.IGNORECASE)
    master_re = re.compile(r"%5BVersion", re.IGNORECASE)

    for key, pkg_id in PRESCRIBING_DATASETS.items():
        resources = pldr_resources(pkg_id)
        year_zip_urls = []
        master_url = None
        for r in resources:
            url = r["url"]
            if quarterly_re.search(urllib.parse.unquote(url)):
                year_zip_urls.append(url)
            elif master_re.search(url):
                master_url = url
        if not year_zip_urls and not master_url:
            print(f"  [WARN] {key}: no prescribing zips found, skipping")
            continue

        years_written = set()
        if master_url:
            years_written |= _extract_year_snapshots(get(master_url), out_dir, key)
        for url in year_zip_urls:
            years_written |= _extract_year_snapshots(get(url), out_dir, key)

        if years_written:
            print(f"  {key}: {len(years_written)} years retained ({min(years_written)}-{max(years_written)})")
        else:
            print(f"  [WARN] {key}: zips found but no year snapshots could be extracted")


# ---------------------------------------------------------------------------
# England — Indices of Deprivation (gov.uk Content API, best-effort discovery)
# ---------------------------------------------------------------------------
GOVUK_SEARCH = "https://www.gov.uk/api/search.json?q=English+Indices+of+Deprivation&order=-public_timestamp&filter_content_store_document_type=statistics"
FALLBACK_IMD_FILE5 = "https://assets.publishing.service.gov.uk/media/5d8b3b51ed915d036a455aa6/File_5_-_IoD2019_Scores.xlsx"


def fetch_england_imd():
    print("\n== England IMD Health Deprivation domain (gov.uk) ==")
    url = FALLBACK_IMD_FILE5
    try:
        results = get_json(GOVUK_SEARCH).get("results", [])
        for res in results:
            title = res.get("title", "")
            if "indices of deprivation" not in title.lower():
                continue
            content = get_json("https://www.gov.uk/api/content" + res["link"])
            attachments = content.get("details", {}).get("attachments", [])
            for att in attachments:
                if att.get("title", "").strip().lower().startswith("file 5"):
                    url = att["url"]
                    print(f"  auto-discovered: {title!r} -> {url}")
                    break
            break
    except Exception as e:
        print(f"  [WARN] discovery failed ({e}), using known-good fallback")
    data = get(url)
    save(RAW / "england_imd" / "File_5_scores.xlsx", data)


# ---------------------------------------------------------------------------
# Wales — WIMD domain scores (gov.wales, best-effort discovery)
# ---------------------------------------------------------------------------
FALLBACK_WIMD = "https://www.gov.wales/sites/default/files/statistics-and-research/2022-02/wimd-2019-index-and-domain-scores-by-small-area.ods"


def fetch_wales_wimd():
    print("\n== Wales WIMD domain scores (gov.wales) ==")
    url = FALLBACK_WIMD
    try:
        html = get("https://www.gov.wales/welsh-index-multiple-deprivation-full-index-update-ranks-2019").decode("utf-8", "ignore")
        candidates = re.findall(r'href="(https://www\.gov\.wales/sites/default/files/[^"]*index-and-domain-scores-by-small-area\.ods)"', html)
        if candidates:
            url = candidates[0]
            print(f"  confirmed current: {url}")
    except Exception as e:
        print(f"  [WARN] discovery failed ({e}), using known-good fallback")
    data = get(url)
    save(RAW / "wales" / "wimd_domain_scores.ods", data)


# ---------------------------------------------------------------------------
# Population by broad age band, per LSOA (for age-profile adjustment) — ONS
# ---------------------------------------------------------------------------
FALLBACK_AGE_POP = (
    "https://www.ons.gov.uk/file?uri=/peoplepopulationandcommunity/populationandmigration/"
    "populationestimates/datasets/lowersuperoutputareamidyearpopulationestimatesnationalstatistics/"
    "mid2011tomid2022/sapelsoabroadage20112022.xlsx"
)


def fetch_age_population():
    print("\n== Population by broad age band, per LSOA (ONS) ==")
    url = FALLBACK_AGE_POP
    try:
        html = get(
            "https://www.ons.gov.uk/peoplepopulationandcommunity/populationandmigration/"
            "populationestimates/datasets/lowersuperoutputareamidyearpopulationestimatesnationalstatistics/previous"
        ).decode("utf-8", "ignore")
        candidates = re.findall(r'href="(/file\?uri=[^"]*sapelsoabroadage[^"]*\.xlsx)"', html)
        if candidates:
            # first hit is the most recently published edition on that page
            url = "https://www.ons.gov.uk" + candidates[0]
            print(f"  confirmed current: {url}")
    except Exception as e:
        print(f"  [WARN] discovery failed ({e}), using known-good fallback")
    data = get(url)
    save(RAW / "age_pop" / "sapelsoabroadage.xlsx", data)


# ---------------------------------------------------------------------------
if __name__ == "__main__":
    fetch_qof()
    fetch_prescribing()
    fetch_frailty()
    fetch_england_imd()
    fetch_wales_wimd()
    fetch_age_population()
    print("\nDone. Run scripts/build_data.py next to rebuild site/data/*.json.")
