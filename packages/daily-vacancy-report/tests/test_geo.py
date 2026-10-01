"""Unit tests for geo.py and the commute filter: GeoNames parsing and its safety caps, the cache, place matching,
distances and how the scanner and doctor use them (fictional towns, no network)."""

import gzip
import io
import json
import sys
import zipfile
from pathlib import Path

import pytest
import requests

PACKAGE = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(PACKAGE), str(PACKAGE.parents[1] / "common")]

import geo  # noqa: E402
import job_scanner  # noqa: E402
import job_settings  # noqa: E402

DAY = 86400


def row(name, lat, lon, admin1="02", pop=1000, fcls="P", fcode="PPL", cc="GB", ascii_name=None):
    return "\t".join([str(abs(hash(name)) % 10**7), name, ascii_name or name, "", str(lat), str(lon), fcls, fcode, cc,
                      "", admin1, "", "", "", str(pop), "", "10", "Europe/London", "2024-01-01"])


TOWNS = [
    row("Kingsford", 54.60, -5.93, pop=300000),
    row("Ashby Vale", 54.51, -6.04, pop=45000),
    row("Ashby", 54.70, -5.80, pop=800),
    row("Ashby", 52.00, -1.00, admin1="05", pop=90000),
    row("Riverford upon Tyne", 55.00, -1.60, admin1="05", pop=300000),
    row("Riverford", 54.00, -6.00, pop=2000),
    row("St. Elsa", 54.62, -5.90, pop=600),
    row("Éclair", 54.55, -5.95, pop=700, ascii_name="Eclair"),
    row("Remote", 54.58, -5.91, pop=5000),
    row("Farhaven", 51.00, -2.00, admin1="05", pop=120000),
    row("Littlecot", 54.61, -5.92, pop=100),
    row("Shire Hall", 54.40, -6.10, pop=0, fcode="PPLA2"),
    row("Mount Gale", 54.65, -5.85, fcls="T", fcode="MT"),
]


def dump(lines=TOWNS, cc="GB", extra=None):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr(f"{cc}.txt", "\n".join(lines) + "\n")
        zf.writestr("readme.txt", "GeoNames country dump")
        for name, data in (extra or {}).items():
            zf.writestr(name, data)
    return buf.getvalue()


@pytest.fixture
def places():
    return geo.Places(geo.parse(dump(), "gb"))


# --------------------------------------------------------------------------- parsing and its caps

def test_parse_keeps_towns_of_500_or_more_and_every_seat(places):
    names = {p.name for found in places.index.values() for p in found}
    assert {"Kingsford", "Ashby", "St. Elsa", "Éclair", "Shire Hall"} <= names
    assert not {"Littlecot", "Mount Gale"} & names


@pytest.mark.parametrize("data, why", [
    (b"not a zip", "not a zip"),
    (dump(cc="IE"), "no list of places"),
    (dump(extra={f"x{i}.txt": "x" for i in range(8)}), "unexpected files"),
    (dump([row("Kingsford", 54.6, -5.9, cc="IE")] * 20), "malformed"),
    (dump([row("Kingsford", 95, -5.9)] * 20), "malformed"),
    (dump(["too\tfew\tcolumns"] * 20), "malformed"),
    (dump([row("Littlecot", 54.6, -5.9, pop=10)]), "no towns"),
])
def test_parse_refuses_files_that_are_not_a_country_dump(data, why):
    with pytest.raises(geo.GeoError, match=why):
        geo.parse(data, "gb")


def test_a_few_odd_rows_are_skipped_not_fatal():
    rows = geo.parse(dump(TOWNS + ["bad row"] + [row("Kingsford", 54.6, -5.9)] * 1000), "gb")
    assert rows and all(len(r) == 6 for r in rows)


def test_a_zip_bomb_is_stopped_while_it_is_read(monkeypatch):
    monkeypatch.setattr(geo, "MAX_INFLATE", 1024 * 1024)
    bomb = dump([row("Kingsford", 54.6, -5.9)] * 20000)
    assert len(bomb) < 200_000
    with pytest.raises(geo.GeoError, match="larger than allowed"):
        geo.parse(bomb, "gb")


def test_an_endless_line_is_refused(monkeypatch):
    monkeypatch.setattr(geo, "MAX_LINE", 1000)
    with pytest.raises(geo.GeoError, match="over-long line"):
        geo.parse(dump(["x" * 5000]), "gb")


# --------------------------------------------------------------------------- download

class Resp:
    def __init__(self, body=b"zip", url="https://download.geonames.org/export/dump/GB.zip", length=None, status=200):
        self.body, self.url, self.status = body, url, status
        self.headers = {"Content-Length": str(length if length is not None else len(body))}

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def raise_for_status(self):
        if self.status >= 400:
            raise requests.HTTPError(str(self.status))

    def iter_content(self, size):
        for i in range(0, len(self.body), size):
            yield self.body[i:i + size]


def test_download_names_only_the_country_and_needs_https():
    asked = []
    data = geo.download("gb", lambda url, **kw: asked.append((url, kw)) or Resp(b"zipdata"))
    assert data == b"zipdata"
    assert asked[0][0] == "https://download.geonames.org/export/dump/GB.zip" and asked[0][1]["stream"] is True
    with pytest.raises(geo.GeoError, match="HTTPS"):
        geo.download("gb", lambda url, **kw: Resp(url="http://download.geonames.org/export/dump/GB.zip"))


def test_download_is_capped_whatever_the_server_says(monkeypatch):
    monkeypatch.setattr(geo, "MAX_DOWNLOAD", 1000)
    with pytest.raises(geo.GeoError, match="larger than allowed"):
        geo.download("gb", lambda url, **kw: Resp(b"x", length=5000))
    with pytest.raises(geo.GeoError, match="larger than allowed"):
        geo.download("gb", lambda url, **kw: Resp(b"x" * 5000, length=10))


# --------------------------------------------------------------------------- the cache

def test_load_downloads_once_and_caches_the_places(tmp_path):
    calls = []
    fetch = lambda cc: calls.append(cc) or dump()  # noqa: E731
    first = geo.load("uk", where=tmp_path, fetch=fetch, now=1000.0)
    again = geo.load("GB", where=tmp_path, fetch=fetch, now=1000.0 + 179 * DAY)
    assert calls == ["gb"] and len(first) == len(again) > 5
    saved = json.loads(gzip.decompress((tmp_path / "gb.json.gz").read_bytes()))
    assert saved["cc"] == "gb" and saved["at"] == 1000.0
    assert not [p for p in tmp_path.iterdir() if p.name.startswith(".")], "no temp file is left behind"


def test_a_failed_refresh_keeps_the_old_copy_and_waits_a_day(tmp_path):
    geo.load("gb", where=tmp_path, fetch=lambda cc: dump(), now=0.0)
    calls = []

    def broken(cc):
        calls.append(cc)
        raise requests.ConnectionError("offline")

    later = 181 * DAY
    assert len(geo.load("gb", where=tmp_path, fetch=broken, now=later)) > 5
    assert len(geo.load("gb", where=tmp_path, fetch=broken, now=later + 3600)) > 5
    assert calls == ["gb"], "not tried again within a day"
    geo.load("gb", where=tmp_path, fetch=lambda cc: dump(), now=later + 2 * DAY)
    assert not (tmp_path / "gb.failed").exists()
    assert json.loads(gzip.decompress((tmp_path / "gb.json.gz").read_bytes()))["at"] == later + 2 * DAY


def test_no_copy_and_no_download_is_an_error(tmp_path):
    with pytest.raises(geo.GeoError, match="download failed"):
        geo.load("gb", where=tmp_path, fetch=lambda cc: (_ for _ in ()).throw(requests.Timeout()), now=0.0)
    with pytest.raises(geo.GeoError, match="tried again after a day"):
        geo.load("gb", where=tmp_path, fetch=lambda cc: dump(), now=60.0)
    with pytest.raises(geo.GeoError, match="no country"):
        geo.load("", where=tmp_path)
    with pytest.raises(geo.GeoError, match="no country"):
        geo.load("../etc", where=tmp_path)


def test_a_damaged_cache_is_downloaded_again(tmp_path):
    (tmp_path / "gb.json.gz").write_bytes(gzip.compress(b'{"at": 1, "rows": [["only", "three", 1]]}'))
    assert len(geo.load("gb", where=tmp_path, fetch=lambda cc: dump(), now=10.0)) > 5
    (tmp_path / "gb.json.gz").write_bytes(b"not gzip")
    assert len(geo.load("gb", where=tmp_path, fetch=lambda cc: dump(), now=20.0)) > 5


def test_the_cache_is_shared_by_every_recruit(monkeypatch, tmp_path):
    monkeypatch.setenv("JOB_PROFILES_DIR", str(tmp_path / "state" / "profiles"))
    assert geo.folder() == tmp_path / "state" / "geo"


# --------------------------------------------------------------------------- finding places

def test_the_longest_name_wins(places):
    assert places.find("Riverford upon Tyne, England").name == "Riverford upon Tyne"
    assert places.find("Riverford").name == "Riverford"


def test_a_shared_name_prefers_the_home_region_then_the_bigger_town(places):
    assert places.find("Ashby", "02").population == 800
    assert places.find("Ashby", "07").population == 90000
    assert places.find("Ashby").population == 90000


def test_names_match_without_accents_case_or_saint(places):
    assert places.find("ECLAIR (hybrid)").name == "Éclair"
    assert places.find("Saint Elsa").name == "St. Elsa"
    assert places.find("st elsa, county down").name == "St. Elsa"


def test_generic_words_are_not_towns(places):
    assert places.find("Remote") is None
    assert places.find("Head office, UK") is None
    assert places.find("") is None


def test_haversine_matches_a_known_distance():
    london, paris = geo.Place("a", 51.5074, -0.1278, "", 0), geo.Place("b", 48.8566, 2.3522, "", 0)
    assert 341 < geo.distance_km(london, paris) < 346
    assert geo.distance_km(london, london) == 0


def test_reach_measures_from_home(places, tmp_path):
    reach = geo.reach("gb", "Kingsford", 20, fetch=lambda cc: dump(), where=tmp_path)
    near, place, km = reach.check("Ashby Vale, County Antrim")
    assert near is True and place.name == "Ashby Vale" and 5 < km < 20
    near, place, km = reach.check("Farhaven")
    assert near is False and km > 300
    assert reach.check("Nowhere Special") == (None, None, 0.0)


def test_reach_is_off_or_says_why_it_cannot_work(tmp_path):
    assert geo.reach("gb", "Kingsford", 0) is None
    with pytest.raises(geo.GeoError, match="no home town"):
        geo.reach("gb", " ", 10, where=tmp_path, fetch=lambda cc: dump())
    with pytest.raises(geo.GeoError, match="home town was not found"):
        geo.reach("gb", "Atlantis", 10, where=tmp_path, fetch=lambda cc: dump())


# --------------------------------------------------------------------------- the scanner and settings

@pytest.mark.parametrize("value, kept", [("30", "30"), ("0", "0"), ("500", "500"), ("501", "0"), ("-1", "0"),
                                         ("2.5", "0"), ("1e3", "0"), ("ten", "0"), (None, "0"), ("", "0")])
def test_distance_is_a_whole_number_up_to_500(value, kept):
    assert job_settings.distance_km(value) == kept
    assert job_settings.clean_form({"max_km": value})["max_km"] == kept


def test_the_distance_is_saved_with_the_search():
    form = job_settings.clean_form({"max_km": "25", "region": "Kingsford"})
    assert job_settings.env_updates(form, {}.get)["JOB_MAX_DISTANCE_KM"] == "25"
    assert job_settings.form_values({"JOB_MAX_DISTANCE_KM": "999"}.get)["max_km"] == "0"


def test_remote_hybrid_and_unknown_places_go_by_the_region(places):
    reach = geo.Reach(places, places.find("Kingsford"), 20)
    assert job_scanner.within_reach(reach, "Farhaven", "Hybrid") == (None, None, 0.0)
    assert job_scanner.within_reach(reach, "Farhaven", "Remote") == (None, None, 0.0)
    assert job_scanner.within_reach(reach, "", None) == (None, None, 0.0)
    assert job_scanner.within_reach(None, "Farhaven", None) == (None, None, 0.0)
    assert job_scanner.within_reach(reach, "Farhaven", "On-site")[0] is False
    assert job_scanner.within_reach(reach, "Ashby Vale", None)[0] is True


def test_the_scan_falls_back_to_the_region_when_the_filter_cannot_work(monkeypatch):
    logged = []
    monkeypatch.setattr(job_scanner, "log", logged.append)
    monkeypatch.setenv("JOB_MAX_DISTANCE_KM", "15")
    monkeypatch.setenv("JOB_HOME_TOWN", "Kingsford")
    monkeypatch.setattr(job_scanner.geo, "load", lambda cc: (_ for _ in ()).throw(geo.GeoError("offline")))
    assert job_scanner.commute_reach() is None
    assert "Distance filter off" in logged[0] and "Kingsford" not in logged[0]
    monkeypatch.setenv("JOB_MAX_DISTANCE_KM", "0")
    assert job_scanner.commute_reach() is None and len(logged) == 1


def test_doctor_warns_when_a_recruits_distance_filter_cannot_work(monkeypatch, tmp_path):
    import doctor
    import profiles
    recruits = [{"id": "sam-lee-1", "name": "Sam Lee", "location": "Kingsford"},
                {"id": "riley-chen-2", "name": "Riley Chen", "location": "Atlantis"},
                {"id": "casey-quinn-3", "name": "Casey Quinn", "location": "Kingsford"}]
    km = {"sam-lee-1": "20", "riley-chen-2": "15", "casey-quinn-3": "0"}
    monkeypatch.setattr(profiles, "active_extra", lambda: recruits)
    monkeypatch.setattr(profiles, "profile_getter", lambda p: {"JOB_MAX_DISTANCE_KM": km[p["id"]],
                                                               "JOB_SEARCH_COUNTRY": "gb"}.get)
    real = geo.reach
    monkeypatch.setattr(geo, "reach", lambda cc, town, n: real(cc, town, n, where=tmp_path, fetch=lambda c: dump()))
    report = doctor.Report(as_json=True)
    doctor.check_commute(report, False)
    assert [(i["status"], i["message"].split(":")[0]) for i in report.items] == [("ok", "Sam Lee"), ("warn", "Riley Chen")]
    assert "home town was not found" in report.items[1]["message"] and "geonames" in report.items[1]["fix"]
