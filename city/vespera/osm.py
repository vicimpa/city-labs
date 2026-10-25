"""OpenStreetMap roads + open elevation tiles for a real-world base location.

Road data © OpenStreetMap contributors (ODbL). Elevation: AWS Terrain Tiles
(terrarium encoding; SRTM/GMTED and other open sources, see their attribution).
"""
import json
import math
import os
import ssl
import struct
import time
import urllib.parse
import urllib.request
import zlib

import numpy as np

CACHE = os.path.join(os.path.dirname(__file__), "..", "out", "cache", "osm")
UA = "vespera-citylab/0.1 (game level design research)"
OVERPASS = "https://overpass-api.de/api/interpreter"
ROAD_RE = "^(motorway|trunk|primary|secondary|tertiary|unclassified|residential)(_link)?$"


_CTX = ssl.create_default_context(cafile="/etc/ssl/cert.pem") if os.path.exists("/etc/ssl/cert.pem") else None


def _get(url, data=None, timeout=180):
    req = urllib.request.Request(url, data=data, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout, context=_CTX) as r:
        return r.read()


def bbox_of(lat, lon, size_m):
    dlat = size_m / 2 / 111320.0
    dlon = size_m / 2 / (111320.0 * math.cos(math.radians(lat)))
    return lat - dlat, lon - dlon, lat + dlat, lon + dlon


def window_bbox(lat0, lon0, win):
    """(x0, y0, x1, y1) metres around the origin -> (s, w, n, e) degrees."""
    x0, y0, x1, y1 = win
    k = 111320.0 * math.cos(math.radians(lat0))
    return lat0 + y0 / 110540.0, lon0 + x0 / k, lat0 + y1 / 110540.0, lon0 + x1 / k


def fetch_roads(name, lat, lon, size_m, regex=ROAD_RE, win=None):
    os.makedirs(CACHE, exist_ok=True)
    f = os.path.join(CACHE, f"{name}_roads.json")
    if os.path.exists(f):
        return json.load(open(f))
    if win is not None:
        s, w, n, e = window_bbox(lat, lon, win)
    else:
        s, w, n, e = bbox_of(lat, lon, size_m)
    q = f'[out:json][timeout:170];way["highway"~"{regex}"]({s},{w},{n},{e});out tags geom;'
    raw = _get(OVERPASS, urllib.parse.urlencode({"data": q}).encode())
    data = json.loads(raw)
    json.dump(data, open(f, "w"))
    return data


def project(lat0, lon0, lat, lon):
    x = (np.asarray(lon) - lon0) * 111320.0 * math.cos(math.radians(lat0))
    y = (np.asarray(lat) - lat0) * 110540.0
    return x, y


def roads_local(data, lat0, lon0):
    out = []
    for el in data.get("elements", []):
        g = el.get("geometry")
        if not g or len(g) < 2:
            continue
        x, y = project(lat0, lon0, [p["lat"] for p in g], [p["lon"] for p in g])
        t = el.get("tags", {})
        out.append(dict(P=np.stack([x, y], 1), hw=t.get("highway", ""), name=t.get("name", ""),
                        oneway=t.get("oneway") == "yes", bridge=t.get("bridge") == "yes",
                        tunnel=t.get("tunnel") == "yes", layer=int(t.get("layer", "0") or 0)
                        if str(t.get("layer", "0")).lstrip("-").isdigit() else 0, id=el["id"]))
    return out


# ------------------------------------------------------------------ elevation (terrarium PNG tiles)
def _png_rgb(raw):
    """Minimal decoder for 8-bit RGB/RGBA non-interlaced PNG."""
    assert raw[:8] == b"\x89PNG\r\n\x1a\n"
    pos, idat, w = 8, b"", None
    while pos < len(raw):
        ln = struct.unpack(">I", raw[pos:pos + 4])[0]
        typ = raw[pos + 4:pos + 8]
        chunk = raw[pos + 8:pos + 8 + ln]
        if typ == b"IHDR":
            w, h, depth, ctype = struct.unpack(">IIBB", chunk[:10])
            ch = {2: 3, 6: 4}[ctype]
        elif typ == b"IDAT":
            idat += chunk
        pos += 12 + ln
    data = np.frombuffer(zlib.decompress(idat), np.uint8)
    stride = w * ch
    img = np.zeros((h, stride), np.int32)
    prev = np.zeros(stride, np.int32)
    for y in range(h):
        f = data[y * (stride + 1)]
        line = data[y * (stride + 1) + 1:(y + 1) * (stride + 1)].astype(np.int32)
        if f == 0:
            cur = line
        elif f == 2:
            cur = (line + prev) & 255
        else:
            cur = np.zeros(stride, np.int32)
            for i in range(stride):
                a = cur[i - ch] if i >= ch else 0
                b = prev[i]
                c = prev[i - ch] if i >= ch else 0
                if f == 1:
                    p = a
                elif f == 3:
                    p = (a + b) >> 1
                else:
                    pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                    p = a if pa <= pb and pa <= pc else (b if pb <= pc else c)
                cur[i] = (line[i] + p) & 255
        img[y] = cur
        prev = cur
    return img.reshape(h, w, ch)[..., :3]


def _tile(z, x, y):
    os.makedirs(CACHE, exist_ok=True)
    f = os.path.join(CACHE, f"t{z}_{x}_{y}.png")
    if not os.path.exists(f):
        raw = _get(f"https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png")
        open(f, "wb").write(raw)
    rgb = _png_rgb(open(f, "rb").read()).astype(np.float64)
    return rgb[..., 0] * 256 + rgb[..., 1] + rgb[..., 2] / 256 - 32768


def elevation_grid(lat0, lon0, size_m, res=20.0, z=13, win=None):
    """Heights on a local grid around lat0/lon0 (rows = +y north).
    win=(x0, y0, x1, y1) in metres overrides the centred square of size_m."""
    if win is None:
        win = (-size_m / 2, -size_m / 2, size_m / 2, size_m / 2)
    xs = np.arange(win[0], win[2] + res * 0.5, res)
    ys = np.arange(win[1], win[3] + res * 0.5, res)
    X, Y = np.meshgrid(xs, ys)
    lat = lat0 + Y / 110540.0
    lon = lon0 + X / (111320.0 * math.cos(math.radians(lat0)))
    N = 2 ** z
    fx = (lon + 180) / 360 * N * 256
    lr = np.radians(lat)
    fy = (1 - np.log(np.tan(lr) + 1 / np.cos(lr)) / math.pi) / 2 * N * 256
    tx0, tx1 = int(fx.min() // 256), int(fx.max() // 256)
    ty0, ty1 = int(fy.min() // 256), int(fy.max() // 256)
    mos = np.zeros(((ty1 - ty0 + 1) * 256, (tx1 - tx0 + 1) * 256))
    for ty in range(ty0, ty1 + 1):
        for tx in range(tx0, tx1 + 1):
            mos[(ty - ty0) * 256:(ty - ty0 + 1) * 256, (tx - tx0) * 256:(tx - tx0 + 1) * 256] = _tile(z, tx, ty)
    px = np.clip(fx - tx0 * 256, 0, mos.shape[1] - 1.001)
    py = np.clip(fy - ty0 * 256, 0, mos.shape[0] - 1.001)
    i0, j0 = py.astype(int), px.astype(int)
    ty, tx_ = py - i0, px - j0
    H = (mos[i0, j0] * (1 - tx_) * (1 - ty) + mos[i0, j0 + 1] * tx_ * (1 - ty) +
         mos[i0 + 1, j0] * (1 - tx_) * ty + mos[i0 + 1, j0 + 1] * tx_ * ty)
    return xs, ys, H


def fetch(name, lat0, lon0, win, query_body, out="body geom"):
    """Generic cached Overpass fetch for a local window (x0, y0, x1, y1 metres)."""
    os.makedirs(CACHE, exist_ok=True)
    f = os.path.join(CACHE, f"{name}.json")
    if os.path.exists(f):
        return json.load(open(f))
    s, w, n, e = window_bbox(lat0, lon0, win)
    bb = f"({s},{w},{n},{e})"
    q = f"[out:json][timeout:170];({query_body.replace('BBOX', bb)});out {out};"
    data = json.loads(_get(OVERPASS, urllib.parse.urlencode({"data": q}).encode()))
    json.dump(data, open(f, "w"))
    return data
