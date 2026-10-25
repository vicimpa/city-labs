"""Organic street grids from tensor-field streamlines (after Chen et al. 2008).

A district defines a direction field (sum of basis tensors: rotated grids,
radial centres, coast/contour/road alignment, noise). Streets are traced
along the field's major and minor eigen-directions with a target spacing,
so grids bend along the shore, terrain and arterials and blocks vary in size.
"""
import heapq
import math
from collections import defaultdict

import numpy as np

from . import geom, terrain as T


class Field:
    """Direction field sampled on a local lattice (doubled-angle vectors)."""

    def __init__(self, bbox, bases, res=12.0, noise=(0.0, 900.0), seed=1):
        x0, y0, x1, y1 = bbox
        self.x0, self.y0, self.res = x0, y0, res
        xs = np.arange(x0, x1 + res, res)
        ys = np.arange(y0, y1 + res, res)
        X, Y = np.meshgrid(xs, ys)
        self.shape = X.shape
        cx = np.zeros_like(X)
        cy = np.zeros_like(X)
        for b in bases:
            ang, w = _basis(b, X, Y)
            cx += w * np.cos(2 * ang)
            cy += w * np.sin(2 * ang)
        theta = 0.5 * np.arctan2(cy, cx)
        amp, freq = noise
        if amp:
            nz = T.Noise(seed, 24)
            theta = theta + nz.fbm(X, Y, 1.0 / freq, 3) * amp
        self.cx = np.cos(2 * theta)
        self.cy = np.sin(2 * theta)

    def theta(self, p):
        fx = (p[0] - self.x0) / self.res
        fy = (p[1] - self.y0) / self.res
        i0 = int(min(max(math.floor(fy), 0), self.shape[0] - 2))
        j0 = int(min(max(math.floor(fx), 0), self.shape[1] - 2))
        ty = min(max(fy - i0, 0.0), 1.0)
        tx = min(max(fx - j0, 0.0), 1.0)

        def bl(A):
            return ((A[i0, j0] * (1 - tx) + A[i0, j0 + 1] * tx) * (1 - ty) +
                    (A[i0 + 1, j0] * (1 - tx) + A[i0 + 1, j0 + 1] * tx) * ty)

        return 0.5 * math.atan2(bl(self.cy), bl(self.cx))

    def dir(self, p, family, prev=None):
        a = self.theta(p) + (math.pi / 2 if family else 0.0)
        d = np.array([math.cos(a), math.sin(a)])
        if prev is not None and d @ prev < 0:
            d = -d
        return d


def _basis(b, X, Y):
    kind = b[0]
    if kind == "grid":
        _, ang, cx, cy, rad, w = b
        wt = w * np.exp(-((X - cx) ** 2 + (Y - cy) ** 2) / (rad * rad))
        return np.full_like(X, math.radians(ang)), wt
    if kind == "radial":
        _, cx, cy, rad, w = b
        wt = w * np.exp(-((X - cx) ** 2 + (Y - cy) ** 2) / (rad * rad))
        return np.arctan2(Y - cy, X - cx), wt
    if kind == "coast":
        _, w, fall = b
        sd = T.coast_dist(X, Y)
        e = 6.0
        gx = T.coast_dist(X + e, Y) - T.coast_dist(X - e, Y)
        gy = T.coast_dist(X, Y + e) - T.coast_dist(X, Y - e)
        ang = np.arctan2(gy, gx) + math.pi / 2
        return ang, w * np.exp(-np.maximum(sd, 0) / fall)
    if kind == "contour":
        _, w = b
        e = 10.0
        gx = T.height(X + e, Y) - T.height(X - e, Y)
        gy = T.height(X, Y + e) - T.height(X, Y - e)
        s = np.hypot(gx, gy) / (2 * e)
        return np.arctan2(gy, gx) + math.pi / 2, w * np.clip(s / 0.06, 0, 1)
    if kind == "road":
        _, P, w, fall = b
        P = np.asarray(P, float)
        d, s = geom.dist_to_polyline_grid(X, Y, P)
        Tn = geom.tangents(P)
        sc = geom.cum_length(P)
        tx = np.interp(s, sc, Tn[:, 0])
        ty = np.interp(s, sc, Tn[:, 1])
        return np.arctan2(ty, tx), w * np.exp(-d / fall)
    raise ValueError(kind)


class Hash:
    def __init__(self, cell):
        self.cell = cell
        self.H = defaultdict(list)

    def add(self, p, tag):
        self.H[(int(p[0] // self.cell), int(p[1] // self.cell))].append((p[0], p[1], tag))

    def near(self, p, r, skip_tag=None, skip_recent=None):
        c = self.cell
        gx, gy = int(p[0] // c), int(p[1] // c)
        k = int(math.ceil(r / c))
        r2 = r * r
        for dx in range(-k, k + 1):
            for dy in range(-k, k + 1):
                for x, y, tag in self.H.get((gx + dx, gy + dy), ()):
                    if skip_tag is not None and tag[0] == skip_tag and (skip_recent is None or tag[1] > skip_recent):
                        continue
                    if (x - p[0]) ** 2 + (y - p[1]) ** 2 < r2:
                        return True
        return False


def trace_district(cfg, mask_fn, field, existing=(), log=print):
    """Trace streets for one district. Returns list of (polyline, level)."""
    levels = cfg["levels"]            # [(dsep, cls), ...] from coarse to fine
    step = cfg.get("step", 8.0)
    out = []
    hashes = [Hash(40.0), Hash(40.0)]
    anyhash = Hash(30.0)
    sid = [0]

    def add_line(P, fam, tag_id):
        for i, p in enumerate(P):
            hashes[fam].add(p, (tag_id, i))
            anyhash.add(p, (tag_id, i))

    # existing roads (arterials, boundary roads) count as obstacles for the family they align with
    for P in existing:
        P = np.asarray(P, float)
        sid[0] += 1
        for i, p in enumerate(P):
            if not field_inside(field, p):
                continue
            t = P[min(i + 1, len(P) - 1)] - P[max(i - 1, 0)]
            t = t / (np.linalg.norm(t) + 1e-9)
            d0 = field.dir(p, 0)
            fam = 0 if abs(t @ d0) > 0.707 else 1
            hashes[fam].add(p, (sid[0], i))
            anyhash.add(p, (sid[0], i))

    stagger = False
    major_other = [Hash(40.0), Hash(40.0)]

    def trace(seed, fam, dsep):
        dtest = dsep * cfg.get("dtest", 0.5)
        sid[0] += 1
        me = sid[0]
        halves = []
        for sgn in (1, -1):
            pts = [np.array(seed, float)]
            prev = field.dir(pts[0], fam) * sgn
            for it in range(cfg.get("max_steps", 900)):
                p = pts[-1]
                d1 = field.dir(p, fam, prev)
                pm = p + d1 * step * 0.5
                d2 = field.dir(pm, fam, d1)
                q = p + d2 * step
                if not mask_fn(q):
                    # pass under a freeway band if valid ground resumes right behind it
                    band = getattr(mask_fn, "band", None)
                    if band is None or not band(q):
                        break
                    jump = None
                    for k in range(2, 12):
                        q2 = p + d2 * step * k
                        if mask_fn(q2):
                            jump = k
                            break
                        if not band(q2):
                            break
                    if jump is None:
                        break
                    for k in range(1, jump):
                        pts.append(p + d2 * step * k)
                    q = p + d2 * step * jump
                if hashes[fam].near(q, dtest):
                    break
                # staggered blocks: fine streets end on the coarse ones (T-junctions)
                if stagger and it > 3 and major_other[fam].near(q, step * 0.8):
                    pts.append(q)
                    break
                # stop when we run into our own line (closed loop)
                if it > 20 and _near_list(halves, pts[:-15], q, step * 1.2):
                    break
                pts.append(q)
                prev = d2
            halves.append(pts)
        P = np.vstack([np.array(halves[1][::-1]), np.array(halves[0][1:])]) if len(halves[0]) > 1 else np.array(halves[1][::-1])
        return P, me

    for lvl, (dsep, cls) in enumerate(levels):
        stagger = bool(cfg.get("stagger")) and lvl > 0
        if lvl == 1:
            for P, _lv, fam in out:
                for p in P:
                    major_other[1 - fam].add(p, (0, 0))
        queue = []
        seeds = list(cfg["seeds"]) if lvl == 0 else []
        for k, s in enumerate(seeds):
            heapq.heappush(queue, (0, k, tuple(s), 0))
            heapq.heappush(queue, (0, k + 0.5, tuple(s), 1))
        if lvl == 0:
            # fallback lattice so districts cut by arterials still grow everywhere
            c0 = np.asarray(cfg["seeds"][0], float)
            gx = np.arange(field.x0, field.x0 + field.res * field.shape[1], dsep * 0.8)
            gy = np.arange(field.y0, field.y0 + field.res * field.shape[0], dsep * 0.8)
            lat = [np.array([x, y]) for x in gx for y in gy]
            lat.sort(key=lambda q: np.linalg.norm(q - c0))
            for k, q in enumerate(lat):
                heapq.heappush(queue, (5, k, tuple(q), k % 2))
        # seed finer levels from all lines traced so far
        if lvl > 0:
            cnt = 0
            seeds_from = [(o[0], o[1], o[2]) for o in out]
            for P in existing:
                P = np.asarray(P, float)
                ins = np.array([field_inside(field, p) and mask_fn(p) for p in P[::4]])
                if ins.any():
                    Q = P[::4][ins]
                    t = Q[min(1, len(Q) - 1)] - Q[0]
                    fam = 0 if abs(field.dir(Q[0], 0) @ (t / (np.linalg.norm(t) + 1e-9))) > 0.707 else 1
                    seeds_from.append((np.repeat(Q, 4, axis=0), -1, fam))
            for P, _lv, fam in seeds_from:
                for i in range(0, len(P), max(1, int(dsep / step))):
                    for side in (1, -1):
                        t = P[min(i + 1, len(P) - 1)] - P[max(i - 1, 0)]
                        t = t / (np.linalg.norm(t) + 1e-9)
                        nrm = np.array([-t[1], t[0]]) * side
                        heapq.heappush(queue, (1, cnt, tuple(P[i] + nrm * dsep), fam))
                        cnt += 1
                    heapq.heappush(queue, (2, cnt, tuple(P[i]), 1 - fam))
                    cnt += 1
        counter = 10 ** 6
        while queue:
            pri, _, s, fam = heapq.heappop(queue)
            s = np.array(s)
            if not mask_fn(s) or hashes[fam].near(s, dsep * 0.92):
                continue
            P, me = trace(s, fam, dsep)
            if len(P) < 3 or geom.cum_length(P)[-1] < cfg.get("min_len", dsep * 0.6):
                continue
            add_line(P, fam, me)
            out.append((P, lvl, fam))
            for i in range(0, len(P), max(1, int(dsep / step))):
                t = P[min(i + 1, len(P) - 1)] - P[max(i - 1, 0)]
                t = t / (np.linalg.norm(t) + 1e-9)
                for side in (1, -1):
                    nrm = np.array([-t[1], t[0]]) * side
                    counter += 1
                    heapq.heappush(queue, (3, counter, tuple(P[i] + nrm * dsep), fam))
                counter += 1
                heapq.heappush(queue, (4, counter, tuple(P[i]), 1 - fam))
    # extend dangling ends to the nearest street ahead (closes blocks)
    res = []
    allpts = Hash(20.0)
    for k, (P, lvl, fam) in enumerate(out):
        for i, p in enumerate(P):
            allpts.add(p, (k, i))
    reach = cfg.get("extend", max(130.0, levels[-1][0] * 1.15))
    for k, (P, lvl, fam) in enumerate(out):
        P = list(P)
        for end in (0, 1):
            seq = P if end == 1 else P[::-1]
            a, b = np.asarray(seq[-2]), np.asarray(seq[-1])
            d = b - a
            d = d / (np.linalg.norm(d) + 1e-9)
            q = b.copy()
            ext = []
            for _ in range(int(reach / step)):
                d = field.dir(q, fam, d)
                q = q + d * step
                if not mask_fn(q, loose=True):
                    break
                ext.append(q.copy())
                if allpts.near(q, step * 0.9, skip_tag=k):
                    break
            else:
                ext = []
            if ext and allpts.near(ext[-1], step * 0.9, skip_tag=k):
                seq = seq + ext
                P = seq if end == 1 else seq[::-1]
        res.append((np.asarray(P), levels[lvl][1], lvl))
    return res


def field_inside(field, p):
    return (field.x0 <= p[0] <= field.x0 + field.res * (field.shape[1] - 1) and
            field.y0 <= p[1] <= field.y0 + field.res * (field.shape[0] - 1))


def _near_list(halves, pts, q, r):
    r2 = r * r
    for P in list(halves) + [pts]:
        for p in P[::2]:
            if (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 < r2:
                return True
    return False


def make_mask(poly, min_coast=25.0, max_slope=0.16, blockers=()):
    """Mask predicate: inside polygon, on land, not too steep, away from blockers.

    blockers: list of (Hash, radius) of points the streets must not reach."""
    poly = np.asarray(poly, float)
    bb = (poly[:, 0].min(), poly[:, 1].min(), poly[:, 0].max(), poly[:, 1].max())
    river = T.river_path()[::3]

    def inside(p, loose=False):
        if not (bb[0] <= p[0] <= bb[2] and bb[1] <= p[1] <= bb[3]):
            return False
        if not geom.point_in_poly(np.array([p[0]]), np.array([p[1]]), poly)[0]:
            return False
        if T.coast_dist(p[0], p[1]) < (min_coast * (0.5 if loose else 1.0)):
            return False
        d, _, _, _ = geom.project_to_polyline(river, np.asarray(p))
        if d < 34 + 30:
            return False
        if not loose and T.slope(p[0], p[1]) > max_slope:
            return False
        for H, r in blockers:
            if H.near(p, r * (0.7 if loose else 1.0)):
                return False
        return True

    def band(p):
        return any(H.near(p, r) for H, r in blockers)

    inside.band = band
    return inside
