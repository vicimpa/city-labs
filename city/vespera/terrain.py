"""Natural terrain height field, computed once on a grid and cached.

height(x, y) samples it bilinearly. Roads are carved into it later (ground.py).
"""
import math
import os

import numpy as np

from . import geom, world as W

RES = 8.0
WATER_LEVEL = 0.0
BANK_LEVEL = 3.0
CACHE = os.path.join(os.path.dirname(__file__), "..", "out", "cache")

_grid = {}


# ---------------------------------------------------------------- noise
class Noise:
    """Smooth gradient-like noise from a sum of random plane waves (fast, tileless)."""

    def __init__(self, seed, waves=64):
        rng = np.random.default_rng(seed)
        self.ang = rng.uniform(0, 2 * math.pi, waves)
        self.ph = rng.uniform(0, 2 * math.pi, waves)
        self.fr = np.exp(rng.uniform(-0.15, 0.15, waves))

    def __call__(self, X, Y, freq):
        out = np.zeros_like(X)
        n = len(self.ang)
        for a, p, f in zip(self.ang, self.ph, self.fr):
            out += np.sin((X * math.cos(a) + Y * math.sin(a)) * freq * f * 2 * math.pi + p)
        return out / math.sqrt(n / 2)

    def fbm(self, X, Y, base, octaves=5, gain=0.5, lac=2.07):
        out = np.zeros_like(X)
        amp, fr, tot = 1.0, base, 0.0
        for _ in range(octaves):
            out += amp * self(X, Y, fr)
            tot += amp
            amp *= gain
            fr *= lac
        return out / tot


def _ellipse_w(X, Y, cx, cy, rx, ry):
    return np.exp(-(((X - cx) / rx) ** 2 + ((Y - cy) / ry) ** 2) * 1.6)


def signed_dist_poly(X, Y, poly):
    """Signed distance to polygon outline, positive inside."""
    P = np.asarray(list(poly) + [poly[0]], float)
    d, _ = geom.dist_to_polyline_grid(X, Y, P, chunk=400000)
    inside = geom.point_in_poly(X, Y, poly)
    return np.where(inside, d, -d)


def compute(res=RES, log=print):
    E = W.EXTENT
    xs = np.arange(-E, E + res * 0.5, res)
    X, Y = np.meshgrid(xs, xs)               # Y rows, X cols
    nz_w = Noise(11)
    nz_w2 = Noise(12)
    nz_c = Noise(13)
    nz_h = Noise(14)
    nz_r = Noise(15)

    # ---- coastline: warped signed distance to the authored outline
    wx = nz_w.fbm(X, Y, 1 / 1400.0, 4) * 260 + nz_c.fbm(X, Y, 1 / 300.0, 3) * 45
    wy = nz_w2.fbm(X, Y, 1 / 1400.0, 4) * 260 + nz_c.fbm(X + 777, Y, 1 / 300.0, 3) * 45
    # sample at a coarser warped lattice for speed, then interpolate
    step = 4
    Xc, Yc = X[::step, ::step], Y[::step, ::step]
    sd = signed_dist_poly(Xc + wx[::step, ::step], Yc + wy[::step, ::step], W.MAINLAND)
    for isl in W.ISLANDS:
        sd = np.maximum(sd, signed_dist_poly(Xc + wx[::step, ::step] * 0.6, Yc + wy[::step, ::step] * 0.6, isl))
    sd = _upsample(sd, X.shape, step)
    log("terrain: coast done")

    # ---- elevation on land
    flat = np.zeros_like(X)
    for cx, cy, rx, ry, s in W.FLATS:
        flat = np.maximum(flat, s * _smooth_ellipse(X, Y, cx, cy, rx, ry))
    rough = 1.0 - 0.9 * flat

    base = 2.2 + 7.0 * (1 - np.exp(-np.maximum(sd, 0) / 350.0)) + np.maximum(sd, 0) * 0.0035
    mount = np.zeros_like(X)
    for cx, cy, rx, ry, h in W.MOUNTAINS:
        mount += h * _ellipse_w(X, Y, cx, cy, rx, ry)
    # ridged multifractal on warped coords: long ridges + branching valleys
    qx = X + nz_w.fbm(X, Y, 1 / 2600.0, 3) * 700
    qy = Y + nz_w2.fbm(X, Y, 1 / 2600.0, 3) * 700
    ridged = np.zeros_like(X)
    amp, fr, wgt, tot = 1.0, 1 / 2400.0, np.ones_like(X), 0.0
    for o in range(6):
        r = np.clip(1.0 - np.abs(nz_r(qx, qy, fr) * 0.9), 0, 1) ** 1.6
        r = r * wgt
        wgt = np.clip(r * 1.3, 0, 1)
        ridged += r * amp
        tot += amp
        amp *= 0.48
        fr *= 2.1
        qx, qy = qy * 0.98 + 13.7, qx * 0.98 - 7.1   # decorrelate octaves
    ridged /= tot
    hills = mount * (0.25 + 1.25 * ridged) * rough
    knolls = np.zeros_like(X)
    for cx, cy, rx, ry, h in W.KNOLLS:
        knolls += h * _ellipse_w(X, Y, cx, cy, rx, ry)
    detail = nz_h.fbm(X, Y, 1 / 1600.0, 4) * 22 * rough + nz_h.fbm(X, Y, 1 / 300.0, 3) * 2.0 * rough
    # play-area border: mountains close the open world on land sides
    rim = np.maximum(np.abs(X) * 0.97, Y) + nz_c.fbm(X, Y, 1 / 1800.0, 3) * 450
    edge = geom.smoothstep(W.PLAY - 200, W.PLAY + 800, rim) * 300
    h = base + hills + knolls + np.maximum(detail, -4) + edge * (sd > 0)
    h = np.where(sd > 0, np.maximum(h, 1.2), h)
    # soften the shoreline: beaches where flat, cliffs where mountains meet the sea
    shore = geom.smoothstep(0, 60, sd)
    h = 0.4 + (h - 0.4) * shore

    # ---- sea floor
    sea = -1.5 - 18 * (1 - np.exp(np.minimum(sd, 0) / 300.0))
    h = np.where(sd > 0, h, np.minimum(sea, -0.8))

    # ---- river valley + channel
    R = river_path()
    dr, _ = geom.dist_to_polyline_grid(X[::step, ::step], Y[::step, ::step], R[::4], chunk=400000)
    dr = _upsample(dr, X.shape, step)
    hw = W.RIVER_HALFWIDTH
    valley = geom.smoothstep(hw + 15, hw + 520, dr)
    bank = BANK_LEVEL + 2.0 + np.maximum(0, Y) * 0.004
    hv = bank + (h - bank) * valley
    h = np.where((sd > 0) & (dr < hw + 520), np.minimum(h, hv), h)
    h = np.where(dr < hw, -3.5 - 2 * geom.smoothstep(hw, 0, dr), h)
    land = (sd > 0) & (dr >= hw)
    log("terrain: elevation done")
    return xs, h.astype(np.float32), sd.astype(np.float32), land


def _smooth_ellipse(X, Y, cx, cy, rx, ry):
    r = np.sqrt(((X - cx) / rx) ** 2 + ((Y - cy) / ry) ** 2)
    return 1 - geom.smoothstep(0.55, 1.0, r)


def _upsample(A, shape, step):
    """Bilinear upsample of a coarse lattice (every `step`) to full shape."""
    H, Wd = shape
    yi = np.arange(H) / step
    xi = np.arange(Wd) / step
    y0 = np.clip(np.floor(yi).astype(int), 0, A.shape[0] - 1)
    x0 = np.clip(np.floor(xi).astype(int), 0, A.shape[1] - 1)
    y1 = np.clip(y0 + 1, 0, A.shape[0] - 1)
    x1 = np.clip(x0 + 1, 0, A.shape[1] - 1)
    fy = (yi - y0)[:, None]
    fx = (xi - x0)[None, :]
    a = A[y0][:, x0]
    b = A[y0][:, x1]
    c = A[y1][:, x0]
    d = A[y1][:, x1]
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy


def river_path():
    if _grid.get("external"):
        return np.array([[1e7, 1e7], [1e7 + 1, 1e7]])
    if "river" not in _grid:
        P, _ = geom.fillet_path(W.RIVER, [500.0] * len(W.RIVER))
        P, _, _ = geom.resample(P, 6.0)
        _grid["river"] = P
    return _grid["river"]


def load(force=False, log=print):
    if "h" in _grid and (not force or _grid.get("external")):
        return _grid
    os.makedirs(CACHE, exist_ok=True)
    f = os.path.join(CACHE, "terrain.npz")
    src_m = max(os.path.getmtime(os.path.join(os.path.dirname(__file__), n)) for n in ("world.py", "terrain.py"))
    if not force and os.path.exists(f) and os.path.getmtime(f) > src_m:
        d = np.load(f)
        xs, h, sd, land = d["xs"], d["h"], d["sd"], d["land"]
    else:
        xs, h, sd, land = compute(log=log)
        np.savez(f, xs=xs, h=h, sd=sd, land=land)
    _grid.update(xs=xs, h=h, sd=sd, land=land)
    return _grid


def set_grid(xs, ys, h, sd, land=None, river=None):
    """Use an externally built height field (e.g. the real-world base) instead of world.py."""
    _grid.clear()
    _grid.update(xs=np.asarray(xs, float), ys=np.asarray(ys, float), h=np.asarray(h, np.float32),
                 sd=np.asarray(sd, np.float32), land=land if land is not None else sd > 0)
    _grid["river"] = river if river is not None else np.zeros((2, 2))
    _grid["external"] = True


def _bilinear(A, x, y):
    g = load()
    xs = g["xs"]
    ys = g.get("ys", xs)
    res = xs[1] - xs[0]
    resy = ys[1] - ys[0]
    fx = (np.asarray(x, float) - xs[0]) / res
    fy = (np.asarray(y, float) - ys[0]) / resy
    n = len(xs) - 1
    m = len(ys) - 1
    x0 = np.clip(np.floor(fx).astype(int), 0, n - 1)
    y0 = np.clip(np.floor(fy).astype(int), 0, m - 1)
    tx = np.clip(fx - x0, 0, 1)
    ty = np.clip(fy - y0, 0, 1)
    a = A[y0, x0]; b = A[y0, x0 + 1]; c = A[y0 + 1, x0]; d = A[y0 + 1, x0 + 1]
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty


def height(x, y):
    return _bilinear(load()["h"], x, y)


def coast_dist(x, y):
    return _bilinear(load()["sd"], x, y)


def slope(x, y, d=6.0):
    gx = (height(x + d, y) - height(x - d, y)) / (2 * d)
    gy = (height(x, y + d) - height(x, y - d)) / (2 * d)
    return np.hypot(gx, gy)
