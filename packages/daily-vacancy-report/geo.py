"""Places and distances for the commute filter (JOB_MAX_DISTANCE_KM).

The place data is GeoNames' country dump (https://download.geonames.org/export/dump/<CC>.zip, Creative Commons
Attribution 4.0, https://www.geonames.org): towns and cities with at least 500 people, plus every administrative
seat, cached in STATE_DIR/geo/<cc>.json.gz and refreshed every 180 days. The request names only the country.
GeoNames publishes no checksums, so a download is held to size caps, read as a stream and checked row by row
before it replaces the cached copy, and a failed refresh keeps the old one.
"""
from __future__ import annotations

import gzip
import io
import json
import math
import os
import re
import tempfile
import time
import unicodedata
import zipfile
from pathlib import Path
from typing import NamedTuple
from urllib.parse import urlsplit

import requests

from hermes_common import STATE_DIR, env, log

URL = "https://download.geonames.org/export/dump/{cc}.zip"
REFRESH_DAYS = 180
RETRY_AFTER = 24 * 3600
MAX_DOWNLOAD = 50 * 1024 * 1024
MAX_INFLATE = 300 * 1024 * 1024
MAX_CACHE = 64 * 1024 * 1024
MAX_LINE = 256 * 1024
MAX_ZIP_PARTS = 8
COLUMNS = 19
MIN_POPULATION = 500
# National capital and first- to fourth-level administrative seats are kept whatever their population.
SEATS = frozenset({"PPLC", "PPLA", "PPLA2", "PPLA3", "PPLA4", "PPLG"})
MAX_NAME_WORDS = 6
MAX_TEXT_WORDS = 60
EARTH_KM = 6371.0088
# Single words that name a place somewhere but, in a job's location line, almost never mean it.
GENERIC = frozenset({"remote", "hybrid", "office", "home", "based", "work", "working", "from", "anywhere", "flexible",
                     "county", "city", "centre", "center", "town", "area", "region", "north", "south", "east", "west",
                     "central", "greater", "the", "and", "of", "on", "in", "site", "uk", "usa", "head", "new"})


class GeoError(Exception):
    """The place data could not be had, or a place could not be found; the message says which, without details."""


class Place(NamedTuple):
    name: str
    lat: float
    lon: float
    admin1: str
    population: int


def folder() -> Path:
    """Shared by every recruit: next to the profiles folder, so a recruit's own state folder is not used."""
    profiles_dir = env("JOB_PROFILES_DIR")
    return (Path(profiles_dir).parent if profiles_dir else STATE_DIR) / "geo"


def country_code(value: str) -> str:
    cc = str(value or "").strip().lower()
    cc = "gb" if cc == "uk" else cc
    return cc if re.fullmatch(r"[a-z]{2}", cc) else ""


def norm(text: str) -> str:
    """Lower case without accents or punctuation, so "St. Helens", "Saint Helens" and "st helens" all match."""
    text = unicodedata.normalize("NFKD", str(text or ""))
    text = "".join(c for c in text if not unicodedata.combining(c)).lower().replace("&", " and ")
    words = re.sub(r"[^a-z0-9]+", " ", text).split()
    return " ".join("st" if w == "saint" else w for w in words)


def distance_km(a: Place, b: Place) -> float:
    """Haversine (great-circle) distance; the spherical earth is within about 0.5% at commute scale."""
    lat1, lat2 = math.radians(a.lat), math.radians(b.lat)
    dlat, dlon = lat2 - lat1, math.radians(b.lon - a.lon)
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 2 * EARTH_KM * math.asin(min(1.0, math.sqrt(h)))


# --------------------------------------------------------------------------- download, checks and cache

def download(cc: str, get=requests.get) -> bytes:
    """The country's zip, over HTTPS only and no larger than MAX_DOWNLOAD."""
    url = URL.format(cc=cc.upper())
    with get(url, stream=True, timeout=(15, 120), headers={"User-Agent": "HermitShell"}) as resp:
        resp.raise_for_status()
        if urlsplit(str(resp.url or url)).scheme != "https":
            raise GeoError("the place data was not served over HTTPS")
        if int(resp.headers.get("Content-Length") or 0) > MAX_DOWNLOAD:
            raise GeoError("the place data download is larger than allowed")
        data = bytearray()
        for chunk in resp.iter_content(64 * 1024):
            data += chunk
            if len(data) > MAX_DOWNLOAD:
                raise GeoError("the place data download is larger than allowed")
    return bytes(data)


def _row(cols: list[str], cc: str) -> list | None:
    """A kept place as [name, ascii name, lat, lon, admin1, population], None for one not kept; ValueError when
    the row is malformed."""
    if len(cols) != COLUMNS or cols[8].upper() != cc.upper():
        raise ValueError("bad row")
    lat, lon = float(cols[4]), float(cols[5])
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        raise ValueError("bad position")
    population = int(cols[14] or 0)
    if cols[6] != "P" or (population < MIN_POPULATION and cols[7] not in SEATS):
        return None
    return [cols[1][:120], cols[2][:120], round(lat, 4), round(lon, 4), cols[10][:20], population]


def parse(data: bytes, cc: str) -> list[list]:
    """The kept places from a downloaded zip. The text inside is read as a stream and held to MAX_INFLATE however
    large its header says it is; more than 1% malformed rows, or none kept, refuses the whole file."""
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as exc:
        raise GeoError("the place data is not a zip file") from exc
    with zf:
        if len(zf.infolist()) > MAX_ZIP_PARTS:
            raise GeoError("the place data has unexpected files in it")
        try:
            info = zf.getinfo(f"{cc.upper()}.txt")
        except KeyError as exc:
            raise GeoError("the place data has no list of places") from exc
        if info.file_size > MAX_INFLATE:
            raise GeoError("the place data is larger than allowed")
        rows, lines, bad, total = [], 0, 0, 0
        with zf.open(info) as raw:
            while line := raw.readline(MAX_LINE + 1):
                total += len(line)
                if total > MAX_INFLATE:
                    raise GeoError("the place data is larger than allowed")
                if len(line) > MAX_LINE:
                    raise GeoError("the place data has an over-long line")
                lines += 1
                try:
                    row = _row(line.decode("utf-8").rstrip("\r\n").split("\t"), cc)
                except (UnicodeDecodeError, ValueError):
                    bad += 1
                    continue
                if row:
                    rows.append(row)
    if bad > max(10, lines // 100):
        raise GeoError("the place data has too many malformed rows")
    if not rows:
        raise GeoError("the place data has no towns in it")
    return rows


def _read_cache(path: Path) -> dict | None:
    try:
        with gzip.open(path, "rb") as f:
            raw = f.read(MAX_CACHE + 1)
        data = json.loads(raw) if len(raw) <= MAX_CACHE else None
    except (OSError, EOFError, ValueError):
        return None
    ok = (isinstance(data, dict) and isinstance(data.get("at"), (int, float)) and isinstance(data.get("rows"), list)
          and all(isinstance(r, list) and len(r) == 6 for r in data["rows"]))
    return data if ok else None


def _write_atomic(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def load(country: str, *, where: Path | None = None, fetch=None, now: float | None = None) -> Places:
    """The country's places, downloading them when there is no copy or it is older than REFRESH_DAYS. A failed
    download is not tried again for a day, and a failed refresh keeps using the old copy."""
    cc = country_code(country)
    if not cc:
        raise GeoError("no country is set for the search")
    where = where or folder()
    now = time.time() if now is None else now
    path, failed = where / f"{cc}.json.gz", where / f"{cc}.failed"
    cached = _read_cache(path)
    if cached and now - cached["at"] < REFRESH_DAYS * 86400:
        return Places(cached["rows"])
    try:
        recent_failure = now - float(failed.read_text(encoding="utf-8")) < RETRY_AFTER
    except (OSError, ValueError):
        recent_failure = False
    if not recent_failure:
        try:
            rows = parse((fetch or download)(cc), cc)
            _write_atomic(path, gzip.compress(json.dumps({"cc": cc, "at": now, "rows": rows}).encode(), mtime=0))
            failed.unlink(missing_ok=True)
            log(f"Place data for {cc.upper()} saved ({len(rows)} places, GeoNames CC BY 4.0)")
            return Places(rows)
        except (GeoError, requests.RequestException, OSError) as exc:
            reason = str(exc) if isinstance(exc, GeoError) else f"download failed ({exc.__class__.__name__})"
            log(f"Place data for {cc.upper()}: {reason}" + ("; keeping the old copy" if cached else ""))
            try:
                _write_atomic(failed, str(now).encode())
            except OSError:
                pass
            if not cached:
                raise GeoError(reason) from exc
    if cached:
        return Places(cached["rows"])
    raise GeoError("the place data could not be downloaded recently; it is tried again after a day")


# --------------------------------------------------------------------------- finding places

class Places:
    def __init__(self, rows: list[list]):
        self.index: dict[str, list[Place]] = {}
        for name, ascii_name, lat, lon, admin1, population in rows:
            place = Place(str(name), float(lat), float(lon), str(admin1), int(population))
            for key in {norm(name), norm(ascii_name)} - {""}:
                if len(key.split()) <= MAX_NAME_WORDS:
                    self.index.setdefault(key, []).append(place)
        self.longest = max((len(k.split()) for k in self.index), default=0)

    def __len__(self) -> int:
        return len(self.index)

    def find(self, text: str, admin1: str = "") -> Place | None:
        """The place named in `text`, the longest name first ("Newcastle upon Tyne" before "Newcastle"). A name
        several places share means the one in `admin1` (the home town's region), else the most populous."""
        words = norm(text).split()[:MAX_TEXT_WORDS]
        for n in range(min(self.longest, len(words)), 0, -1):
            for i in range(len(words) - n + 1):
                key = " ".join(words[i:i + n])
                if n == 1 and (key in GENERIC or len(key) < 3 or key.isdigit()):
                    continue
                found = self.index.get(key)
                if found:
                    return max(found, key=lambda p: (bool(admin1) and p.admin1 == admin1, p.population))
        return None


class Reach:
    """Whether a job's location is within `max_km` of home, as the crow flies."""

    def __init__(self, places: Places, home: Place, max_km: int):
        self.places, self.home, self.max_km = places, home, max_km

    def check(self, location: str) -> tuple[bool | None, Place | None, float]:
        """(within reach, the place found, its distance in km); (None, None, 0) when no place is found."""
        place = self.places.find(location, self.home.admin1)
        if not place:
            return None, None, 0.0
        km = distance_km(self.home, place)
        return km <= self.max_km, place, km


def reach(country: str, home_town: str, max_km: int, **kwargs) -> Reach | None:
    """The commute filter, None when it is off (max_km 0); GeoError when it is on but cannot work."""
    if max_km <= 0:
        return None
    if not str(home_town or "").strip():
        raise GeoError("the recruit has no home town")
    places = load(country, **kwargs)
    home = places.find(home_town)
    if not home:
        raise GeoError("the home town was not found in the place data")
    return Reach(places, home, max_km)
