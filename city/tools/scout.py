"""Scout real coastal cities from OSM at the same scale/style as the Vespera plan.

Usage: python3 scout.py OUTDIR [name ...]
"""
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import numpy as np

from vespera import font, osm, plan

CANDIDATES = {
    "vladivostok": (43.110, 131.905), "seattle": (47.605, -122.335), "sanfrancisco": (37.775, -122.430),
    "monaco": (43.735, 7.400), "marseille": (43.295, 5.375), "hongkong": (22.290, 114.170),
    "wellington": (-41.285, 174.780), "genoa": (44.415, 8.920), "sydney": (-33.850, 151.215),
    "valparaiso": (-33.040, -71.600), "rio": (-22.940, -43.210), "sandiego": (32.710, -117.170),
    "vancouver": (49.290, -123.120), "lisbon": (38.715, -9.160),
}
SIZE = 10000.0
SIZES = {"vladivostok_big": 26000.0}
WINDOWS = {"vespera_base": ((43.085, 131.935), (-13000.0, -13000.0, 13000.0, 17500.0))}
CANDIDATES["vladivostok_big"] = (43.085, 131.935)
STYLE = {"motorway": (1.0, 0.72, 0.25, 9), "trunk": (1.0, 0.72, 0.25, 7), "primary": (0.95, 0.95, 0.9, 5),
         "secondary": (0.85, 0.85, 0.8, 4), "tertiary": (0.7, 0.7, 0.68, 3),
         "unclassified": (0.45, 0.45, 0.45, 2), "residential": (0.42, 0.42, 0.42, 1.6)}


def render(name, out, mpp=10.0):
    if name in WINDOWS:
        (lat, lon), win = WINDOWS[name]
        size = max(win[2] - win[0], win[3] - win[1])
    else:
        lat, lon = CANDIDATES[name]
        size = SIZES.get(name, SIZE)
        win = (-size / 2, -size / 2, size / 2, size / 2)
    mpp = max(mpp, size / 1300)
    data = osm.fetch_roads(name, lat, lon, size, win=win)
    roads = osm.roads_local(data, lat, lon)
    xs, ys, H = osm.elevation_grid(lat, lon, size, res=mpp, z=12, win=win)
    cv = plan.Canvas(win, mpp)
    Hf = H[::-1][:cv.h, :cv.w]
    gy, gx = np.gradient(Hf, mpp)
    shade = np.clip(0.8 + (-gx * 0.7 - gy * 0.7) * 0.9, 0.3, 1.25)
    land = np.stack([0.11 + Hf * 0.0004, 0.13 + Hf * 0.0004, 0.12 + Hf * 0.0004], -1) * shade[..., None]
    water = Hf <= 0.3
    land[water] = (0.05, 0.09, 0.13)
    cv.img = land
    order = ["residential", "unclassified", "tertiary", "secondary", "primary", "trunk", "motorway"]
    km = {}
    for cls in order:
        for r in roads:
            base = r["hw"].replace("_link", "")
            if base != cls:
                continue
            c = STYLE[cls]
            cv.stroke(r["P"], c[3] * mpp / 4.0 if cls != "residential" else mpp * 0.6, c[:3])
            km[cls] = km.get(cls, 0) + float(np.sum(np.linalg.norm(np.diff(r["P"], axis=0), axis=1))) / 1000
    font.draw(cv.img, name.upper(), cv.w // 2, 16, 2, (1, 1, 1))
    for g in np.arange(-20000, 20001, 2000):
        cv.stroke(np.array([[g, win[1]], [g, win[3]]]), mpp * 0.6, (0.5, 0.6, 1.0), 0.35)
        cv.stroke(np.array([[win[0], g], [win[2], g]]), mpp * 0.6, (0.5, 0.6, 1.0), 0.35)
    for gx in np.arange(-20000, 20001, 4000):
        for gy in np.arange(-20000, 20001, 4000):
            q = cv.to_px(np.array([[gx, gy]], float))[0]
            font.draw(cv.img, f"{gx / 1000:.0f} {gy / 1000:.0f}", int(q[0]) + 3, int(q[1]) + 3, 1, (0.7, 0.8, 1.0), center=False)
    tot = sum(v for k, v in km.items() if k not in ("residential",))
    font.draw(cv.img, f"TERTIARY+ {tot:.0f} KM  RESIDENTIAL {km.get('residential', 0):.0f} KM", 8, cv.h - 14, 1,
              (0.9, 0.9, 0.9), center=False)
    cv.save(os.path.join(out, f"scout_{name}.png"))
    return km


if __name__ == "__main__":
    out = sys.argv[1]
    names = sys.argv[2:] or list(CANDIDATES)
    for n in names:
        t = time.time()
        try:
            km = render(n, out)
            print(n, {k: round(v) for k, v in km.items()}, f"{time.time() - t:.0f}s", flush=True)
        except Exception as ex:
            print(n, "FAILED", ex, flush=True)
        time.sleep(3)
