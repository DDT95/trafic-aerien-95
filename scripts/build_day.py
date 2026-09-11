#!/usr/bin/env python3
"""Build a compact Val-d'Oise daily dataset from an ADSB.lol globe_history tar."""
from __future__ import annotations

import argparse
import datetime as dt
import gzip
import io
import json
import math
import os
import sys
import tarfile
import urllib.request
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
WIDE = (1.25, 48.65, 2.80, 49.45)  # context kept around the department
MAX_DAYS = 14


class ConcatenatedHTTP(io.RawIOBase):
    def __init__(self, urls: list[str]):
        self.urls = iter(urls)
        self.current = None
        self.asset_no = 0

    def readable(self):
        return True

    def _next(self):
        url = next(self.urls, None)
        if not url:
            return False
        self.asset_no += 1
        print(f"Downloading archive part {self.asset_no}: {url.rsplit('/', 1)[-1]}", file=sys.stderr)
        req = urllib.request.Request(url, headers={"User-Agent": "DDT95-trafic-aerien/1.0"})
        self.current = urllib.request.urlopen(req, timeout=180)
        return True

    def readinto(self, b):
        while True:
            if self.current is None and not self._next():
                return 0
            chunk = self.current.read(len(b))
            if chunk:
                b[:len(chunk)] = chunk
                return len(chunk)
            self.current.close()
            self.current = None


def api_json(url: str):
    req = urllib.request.Request(url, headers={
        "Accept": "application/vnd.github+json",
        "User-Agent": "DDT95-trafic-aerien/1.0",
    })
    token = os.getenv("GITHUB_TOKEN")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(req, timeout=60) as response:
        return json.load(response)


def release_assets(day: str) -> list[str]:
    wanted = f"v{day}-planes-readsb-prod-0"
    releases_repo = f"globe_history_{day[:4]}"
    for page in range(1, 5):
        releases = api_json(f"https://api.github.com/repos/adsblol/{releases_repo}/releases?per_page=100&page={page}")
        for release in releases:
            if release.get("tag_name") == wanted:
                assets = [a for a in release.get("assets", []) if ".tar.a" in a["name"]]
                assets.sort(key=lambda a: a["name"])
                if not assets:
                    raise RuntimeError(f"Release {wanted} found without split tar assets")
                return [a["browser_download_url"] for a in assets]
        if len(releases) < 100:
            break
    raise RuntimeError(f"ADSB.lol release not found for {day}")


def rings_from_geojson(path: Path):
    source = json.loads(path.read_text(encoding="utf-8"))
    polygons = []
    for feature in source["features"]:
        geom = feature["geometry"]
        groups = [geom["coordinates"]] if geom["type"] == "Polygon" else geom["coordinates"]
        for rings in groups:
            outer = rings[0]
            xs = [p[0] for p in outer]
            ys = [p[1] for p in outer]
            polygons.append((min(xs), min(ys), max(xs), max(ys), rings))
    return polygons


def in_ring(x: float, y: float, ring) -> bool:
    inside = False
    j = len(ring) - 1
    for i, (xi, yi, *_) in enumerate(ring):
        xj, yj = ring[j][0], ring[j][1]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / ((yj - yi) or 1e-15) + xi:
            inside = not inside
        j = i
    return inside


def in_department(lon: float, lat: float, polygons) -> bool:
    for minx, miny, maxx, maxy, rings in polygons:
        if minx <= lon <= maxx and miny <= lat <= maxy and in_ring(lon, lat, rings[0]):
            if not any(in_ring(lon, lat, hole) for hole in rings[1:]):
                return True
    return False


def haversine_km(a, b) -> float:
    lat1, lon1, lat2, lon2 = map(math.radians, (a[1], a[2], b[1], b[2]))
    dlat, dlon = lat2 - lat1, lon2 - lon1
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 12742 * math.asin(math.sqrt(h))


def number(value):
    return float(value) if isinstance(value, (int, float)) and math.isfinite(value) else None


def parse_aircraft(raw: bytes, polygons, day_start: float):
    try:
        payload = json.loads(gzip.decompress(raw))
    except (OSError, json.JSONDecodeError, UnicodeDecodeError):
        return []
    base = number(payload.get("timestamp")) or day_start
    flight = None
    candidates = []
    west, south, east, north = WIDE
    for row in payload.get("trace", []):
        if len(row) < 6:
            continue
        offset, lat, lon = number(row[0]), number(row[1]), number(row[2])
        if offset is None or lat is None or lon is None or not (south <= lat <= north and west <= lon <= east):
            continue
        sec = int(round(base + offset - day_start))
        if not (0 <= sec <= 90000):
            continue
        alt = number(row[3])
        speed = number(row[4])
        track = number(row[5])
        rate = number(row[7]) if len(row) > 7 else None
        extra = row[8] if len(row) > 8 and isinstance(row[8], dict) else None
        if extra and extra.get("flight"):
            flight = str(extra["flight"]).strip()
        candidates.append([sec, round(lat, 5), round(lon, 5), round(alt) if alt is not None else None,
                           round(speed, 1) if speed is not None else None,
                           round(track, 1) if track is not None else None,
                           round(rate) if rate is not None else None])
    if not candidates:
        return []
    candidates.sort(key=lambda p: p[0])
    chunks, current = [], []
    for point in candidates:
        if current and (point[0] - current[-1][0] > 1200 or haversine_km(current[-1], point) > 100):
            chunks.append(current); current = []
        current.append(point)
    if current:
        chunks.append(current)

    tracks = []
    for sequence in chunks:
        inside = [p for p in sequence if in_department(p[2], p[1], polygons)]
        if len(inside) < 2:
            continue
        # Keep one point every 20 s, while preserving ends, for a light web payload.
        kept, last = [], -10_000
        for p in sequence:
            if p[0] - last >= 20:
                kept.append(p); last = p[0]
        if kept[-1] != sequence[-1]:
            kept.append(sequence[-1])
        altitudes = [p[3] for p in inside if p[3] is not None]
        speeds = [p[4] for p in inside if p[4] is not None]
        if not altitudes:
            continue
        tracks.append({
            "hex": str(payload.get("icao", "unknown")).lstrip("~"),
            "flight": flight,
            "reg": payload.get("r"),
            "type": payload.get("t"),
            "desc": payload.get("desc"),
            "operator": payload.get("ownOp"),
            "first": inside[0][0], "last": inside[-1][0],
            "min_alt": round(min(altitudes)), "max_alt": round(max(altitudes)),
            "max_speed": round(max(speeds), 1) if speeds else None,
            "points": kept,
        })
    return tracks


def build(day: str, urls: list[str]):
    polygons = rings_from_geojson(DATA / "communes95.geojson")
    day_start = dt.datetime.fromisoformat(day).replace(tzinfo=dt.timezone.utc).timestamp()
    tracks, files_seen = [], 0
    stream = io.BufferedReader(ConcatenatedHTTP(urls), buffer_size=1024 * 1024)
    with tarfile.open(fileobj=stream, mode="r|") as archive:
        for member in archive:
            if not member.isfile() or "/trace_full_" not in member.name:
                continue
            files_seen += 1
            extracted = archive.extractfile(member)
            if extracted:
                tracks.extend(parse_aircraft(extracted.read(), polygons, day_start))
            if files_seen % 10000 == 0:
                print(f"Scanned {files_seen:,} aircraft files; retained {len(tracks):,} passages", file=sys.stderr)

    for i, track in enumerate(sorted(tracks, key=lambda t: (t["first"], t["hex"]))):
        track["id"] = f"{track['hex']}-{i + 1}"
    tracks.sort(key=lambda t: t["first"])
    hourly = Counter(min(23, max(0, t["first"] // 3600)) for t in tracks)
    positions = sum(len(t["points"]) for t in tracks)
    stats = {
        "passages": len(tracks),
        "aircraft": len({t["hex"] for t in tracks}),
        "low": sum(1 for t in tracks if t["min_alt"] < 5000),
        "positions": positions,
        "peak_hour": max(range(24), key=lambda h: hourly[h]) if tracks else 0,
        "hourly": [hourly[h] for h in range(24)],
    }
    output = {
        "date": day,
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "source": "ADSB.lol globe_history · ODbL 1.0",
        "stats": stats,
        "tracks": tracks,
    }
    days_dir = DATA / "days"
    days_dir.mkdir(exist_ok=True)
    target = days_dir / f"{day}.json.gz"
    encoded = json.dumps(output, ensure_ascii=False, separators=(",", ":")).encode()
    with target.open("wb") as fh:
        with gzip.GzipFile(fileobj=fh, mode="wb", compresslevel=9, mtime=0) as zipped:
            zipped.write(encoded)
    update_index(day, stats, target)
    print(f"Built {target}: {len(tracks):,} passages, {positions:,} positions, {target.stat().st_size:,} bytes", file=sys.stderr)


def update_index(day: str, stats: dict, target: Path):
    index_path = DATA / "index.json"
    try:
        index = json.loads(index_path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        index = {"days": []}
    entry = {"date": day, "label": dt.date.fromisoformat(day).strftime("%d/%m/%Y"),
             "file": f"data/days/{target.name}", "stats": stats}
    days = [d for d in index.get("days", []) if d.get("date") != day] + [entry]
    days.sort(key=lambda d: d["date"], reverse=True)
    days = days[:MAX_DAYS]
    keep = {d["date"] for d in days}
    for old in (DATA / "days").glob("*.json.gz"):
        if old.stem.replace(".json", "") not in keep:
            old.unlink()
    index.update({"updated_at": dt.datetime.now(dt.timezone.utc).isoformat(), "latest": days[0]["date"], "days": days, "status": "ready"})
    index_path.write_text(json.dumps(index, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--date", help="UTC day YYYY-MM-DD; defaults to yesterday")
    parser.add_argument("--url", action="append", help="Override archive URL; repeat for split parts")
    args = parser.parse_args()
    day = args.date or (dt.datetime.now(dt.timezone.utc).date() - dt.timedelta(days=1)).isoformat()
    urls = args.url or release_assets(day)
    build(day, urls)


if __name__ == "__main__":
    main()
