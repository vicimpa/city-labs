"""Road network: expand layout specs, clip, build interchanges, split at crossings,
cluster junction nodes and compute vertical profiles."""
import math
from collections import defaultdict

import numpy as np

from . import geom, layout as LY, terrain as T

SPACING = 4.0
SNAP = 30.0
CLUSTER = 12.0

# lanes = per direction (total for one-way), widths in metres
CLASSES = {
    "freeway":    dict(lanes=3, lane_w=3.7, shoulder=2.8, median=1.2, side=0.0, sigma=120, r=400, prio=6, corner=14),
    "ramp":       dict(lanes=1, lane_w=4.6, shoulder=1.6, median=0.0, side=0.0, sigma=35, r=80, prio=5, corner=10, oneway=True),
    "boulevard":  dict(lanes=3, lane_w=3.5, shoulder=0.6, median=7.0, side=5.0, sigma=80, r=200, prio=4, corner=12),
    "avenue":     dict(lanes=2, lane_w=3.4, shoulder=2.4, median=0.6, side=4.5, sigma=60, r=60, prio=3, corner=9),
    "street":     dict(lanes=1, lane_w=3.6, shoulder=2.3, median=0.3, side=3.5, sigma=45, r=30, prio=2, corner=7),
    "lane":       dict(lanes=1, lane_w=3.1, shoulder=0.4, median=0.0, side=2.2, sigma=25, r=15, prio=1, corner=5),
    "mountain":   dict(lanes=1, lane_w=3.6, shoulder=1.0, median=0.3, side=0.0, sigma=22, r=30, prio=2, corner=8),
    "industrial": dict(lanes=1, lane_w=4.2, shoulder=1.6, median=0.3, side=0.0, sigma=50, r=40, prio=2, corner=12),
    "rural":      dict(lanes=1, lane_w=3.6, shoulder=1.4, median=0.3, side=0.0, sigma=30, r=60, prio=2, corner=10),
    "raceway":    dict(lanes=1, lane_w=6.0, shoulder=2.0, median=0.0, side=0.0, sigma=40, r=40, prio=3, corner=12),
    "runway":     dict(lanes=1, lane_w=22.0, shoulder=0.0, median=0.0, side=0.0, sigma=200, r=500, prio=3, corner=12),
}


def hw(cls):
    c = CLASSES[cls]
    if c.get("oneway"):
        return c["lanes"] * c["lane_w"] / 2 + c["shoulder"]
    return c["lanes"] * c["lane_w"] + c["shoulder"] + c["median"] / 2


def hwt(cls):
    return hw(cls) + CLASSES[cls]["side"]


class Road:
    def __init__(self, name, cls, P, U=None, closed=False, split=True, attrs=None, spec=None):
        self.name = name
        self.cls = cls
        self.P = np.asarray(P, float)
        self.U = U if U is not None else np.linspace(0, 1, len(P))
        self.closed = closed
        self.split = split
        self.attrs = attrs or []
        self.spec = spec or {}
        self.end_mode = ["node", "node"]     # "node" | "merge"
        self.merge_host = [None, None]
        self.z = None
        self.recompute()

    def recompute(self):
        self.s = geom.cum_length(self.P)
        self.L = float(self.s[-1])

    def point_at(self, s):
        return np.array([np.interp(s, self.s, self.P[:, 0]), np.interp(s, self.s, self.P[:, 1])])

    def dir_at(self, s):
        a = self.point_at(max(0.0, s - 3))
        b = self.point_at(min(self.L, s + 3))
        return geom.unit(b - a)


class Node:
    def __init__(self, idx, pos):
        self.idx = idx
        self.pos = np.asarray(pos, float)
        self.edges = []        # list of (edge, end) end 0 = start, 1 = end
        self.z = None
        self.free = False


class Edge:
    def __init__(self, idx, road, P, s_road, n0, n1):
        self.idx = idx
        self.road = road
        self.cls = road.cls
        self.P = P
        self.s_road = s_road           # road arc-length of each sample
        self.n = [n0, n1]
        self.trim = [0.0, 0.0]
        self.z = None
        self.recompute()

    def recompute(self):
        self.s = geom.cum_length(self.P)
        self.L = float(self.s[-1])


# ------------------------------------------------------------------ expansion
def expand(spec):
    cls = spec["cls"]
    ctrl, attrs = [], []
    for p in spec["pts"]:
        ctrl.append((p[0], p[1]))
        attrs.append(p[2] if len(p) > 2 else {})
    radii = [a.get("r", CLASSES[cls]["r"]) for a in attrs]
    P, U = geom.fillet_path(ctrl, radii, closed=spec["closed"])
    P, U, _ = geom.resample(P, SPACING, U)
    return Road(spec["name"], cls, P, U, closed=spec["closed"], split=spec["split"], attrs=attrs, spec=spec)


def river_distance(P):
    R = T.river_path()[::5]
    d, _ = geom.dist_to_polyline_grid(P[:, 0:1], P[:, 1:2], R)
    return d[:, 0]


# ------------------------------------------------------------------ interchanges
def _rcw(v):
    return np.array([v[1], -v[0]])


def _crossing(host, cross):
    best = None
    for i in range(len(host.P) - 1):
        a, b = host.P[i], host.P[i + 1]
        lo = np.minimum(a, b) - 1
        hi = np.maximum(a, b) + 1
        cand = np.flatnonzero((np.minimum(cross.P[:-1], cross.P[1:]) <= hi).all(1) &
                              (np.maximum(cross.P[:-1], cross.P[1:]) >= lo).all(1))
        for j in cand:
            r = geom.seg_intersect(a, b, cross.P[j], cross.P[j + 1])
            if r:
                sh = host.s[i] + r[0] * (host.s[i + 1] - host.s[i])
                sc = cross.s[j] + r[1] * (cross.s[j + 1] - cross.s[j])
                best = (sh, sc, a + (b - a) * r[0])
    if best is None:
        raise RuntimeError(f"{host.name} does not cross {cross.name}")
    return best


def _frame_path(X, a, b, pts, radii):
    W = [X + p[0] * a + p[1] * b for p in pts]
    P, U = geom.fillet_path(W, radii)
    P, U, _ = geom.resample(P, SPACING, U)
    return P


def _dense(pts, radii):
    P, U = geom.fillet_path([np.asarray(p, float) for p in pts], radii)
    P, _, _ = geom.resample(P, SPACING, U)
    return P


def _lateral_point_on(road, s0, X, nrm, target, direction):
    """Walk along road from s0 until signed lateral (dot(p-X, nrm)) == target."""
    ss = np.arange(s0, road.L if direction > 0 else 0, SPACING * 0.25 * direction)
    for s in ss:
        p = road.point_at(s)
        if (np.dot(p - X, nrm) - target) * np.sign(target) >= 0:
            return p, s
    return road.point_at(ss[-1]), ss[-1]


def build_interchanges(roads):
    by = {r.name: r for r in roads}
    ramps = []
    for ic in LY.INTERCHANGES:
        host = by[ic["host"]]
        cross = by[ic["cross"]]
        sh, sc, X = _crossing(host, cross)
        t = host.dir_at(sh)
        c = cross.dir_at(sc)
        latR = hw(host.cls) - hw("ramp") - 0.2
        latO = hw(cross.cls) - hw("ramp") - 0.2
        tag = ic["name"]
        if ic["kind"] == "diamond":
            for sg in (1, -1):
                a = t * sg
                b = _rcw(a)
                J, _ = _lateral_point_on(cross, sc, X, b, 78.0, 1 if np.dot(c, b) > 0 else -1)
                ja = float(np.dot(J - X, a))
                jb = float(np.dot(J - X, b))
                def on_host(ds):
                    sp = float(np.clip(sh + sg * ds, 0, host.L))
                    tt = host.dir_at(sp) * sg
                    return host.point_at(sp) + _rcw(tt) * latR

                K0 = J - a * 90.0
                K1 = J + a * 90.0
                off = np.vstack(_dense([on_host(-430), on_host(-340), K0, J], [0, 400, 300, 0]))
                on = np.vstack(_dense([J, K1, on_host(340), on_host(430)], [0, 300, 400, 0]))
                r1 = Road(f"{tag} off {sg:+d}", "ramp", off, split=False)
                r1.end_mode = ["merge", "node"]; r1.merge_host = [host.name, None]
                r2 = Road(f"{tag} on {sg:+d}", "ramp", on, split=False)
                r2.end_mode = ["node", "merge"]; r2.merge_host = [None, host.name]
                ramps += [r1, r2]
        elif ic["kind"] == "cloverleaf":
            Rc = 58.0
            for road_h, road_o, dirv in ((host, cross, t), (host, cross, -t), (cross, host, c), (cross, host, -c)):
                a = dirv
                b = _rcw(a)
                lr = hw(road_h.cls) - hw("ramp") - 0.2
                lo = hw(road_o.cls) - hw("ramp") - 0.2
                g_b = hwt(road_h.cls) + 14      # loop clearance from the road we leave
                g_a = hwt(road_o.cls) + 14      # ... and from the road we join
                ac, bc = g_a + Rc, g_b + Rc
                loop = [(hwt(road_o.cls) + 6, lr), (hwt(road_o.cls) + 40, lr), (ac - 6, g_b),
                        (ac + Rc, g_b), (ac + Rc, bc + Rc), (ac - Rc, bc + Rc),
                        (g_a, bc - 40), (lo, hwt(road_h.cls) + 40), (lo, hwt(road_h.cls) + 6)]
                Pl = _frame_path(X, a, b, loop, [0, 120, 80, Rc, Rc, Rc, 80, 120, 0])
                rl = Road(f"{tag} loop {road_h.name[:6]} {'+' if np.dot(dirv, t if road_h is host else c) > 0 else '-'}", "ramp", Pl, split=False)
                rl.end_mode = ["merge", "merge"]; rl.merge_host = [road_h.name, road_o.name]
                # outer connector (right turn) in the quadrant before the crossing
                q = g_a + 2 * Rc + 30
                outer = [(-q - 330, lr), (-q - 250, lr), (-q - 60, lr + 30), (-q, lr + 120),
                         (-q, g_b + 2 * Rc + 20), (-lo, g_b + 2 * Rc + 230), (-lo, g_b + 2 * Rc + 310)]
                Po = _frame_path(X, a, b, outer, [0, 300, 120, 120, 200, 300, 0])
                ro = Road(f"{tag} outer {road_h.name[:6]} {'+' if np.dot(dirv, t if road_h is host else c) > 0 else '-'}", "ramp", Po, split=False)
                ro.end_mode = ["merge", "merge"]; ro.merge_host = [road_h.name, road_o.name]
                ramps += [rl, ro]
    return ramps


# ------------------------------------------------------------------ profiles
def natural_along(P):
    return T.height(P[:, 0], P[:, 1])


def profile(road):
    c = CLASSES[road.cls]
    N = natural_along(road.P)
    road.N = N
    base = np.maximum(N, T.BANK_LEVEL)
    if road.closed:
        k = len(base)
        zs = geom.gaussian_smooth(np.concatenate([base, base, base]),
                                  np.arange(3 * k) * SPACING, c["sigma"])[k:2 * k]
    else:
        zs = geom.gaussian_smooth(base, road.s, c["sigma"])
    off = np.zeros(len(road.P))
    if road.attrs:
        n = len(road.attrs)
        cs, co = [], []
        for i, at in enumerate(road.attrs):
            j = int(np.argmin(np.abs(road.U - i)))
            if "z" in at:
                cs.append(road.s[j]); co.append(at["z"] - zs[j])
            elif "h" in at:
                cs.append(road.s[j]); co.append(at["h"])
        if cs:
            off = np.interp(road.s, cs, co)
            off = geom.gaussian_smooth(off, road.s, c["sigma"] * 0.8)
    z = grade_limit(zs + off, SPACING, MAX_GRADE.get(road.cls, 0.1), road.closed)
    # bridges arch gently over the river
    if road.spec.get("bridge"):
        rd = river_distance(road.P)
        z = z + 2.5 * geom.smoothstep(140, 30, rd)
    road.z = z


MAX_GRADE = {"raceway": 0.06, "runway": 0.01, "freeway": 0.05, "ramp": 0.07, "boulevard": 0.07, "avenue": 0.08, "street": 0.10,
             "lane": 0.12, "mountain": 0.115, "rural": 0.10, "industrial": 0.07}


def grade_limit(z, ds, g, closed=False):
    """Limit slope to g while staying as close as possible to z (cut/fill decided later)."""
    step = g * ds

    def sweep(a, rev):
        a = a.copy()
        rng = range(len(a) - 2, -1, -1) if rev else range(1, len(a))
        for i in rng:
            j = i + 1 if rev else i - 1
            a[i] = min(max(a[i], a[j] - step), a[j] + step)
        return a

    out = 0.5 * (sweep(z, False) + sweep(z, True))
    for _ in range(3):
        out = sweep(sweep(out, False), True)
    return out


K_MIN = {"freeway": 60, "fw1": 60, "ramp": 18, "boulevard": 25, "avenue": 22, "street": 12, "lane": 6,
         "rural": 15, "mountain": 6, "industrial": 15, "raceway": 15, "runway": 100}


def _fam(cls):
    for k in ("fw1", "ramp"):
        if cls.startswith(k):
            return k
    return cls


def _taper_zone(e, s, host_name, reach=200.0):
    """Is station s of edge e inside the diverge/merge zone that attaches it to host_name?"""
    mh = getattr(e.road, "merge_host", None) or []
    for end, hn in enumerate(mh):
        if hn == host_name and ((end == 0 and s <= reach) or (end == 1 and s >= e.L - reach)):
            return True
    return False


def _cone(e, s0, z0, sign):
    """Raise (sign=+1) or lower (-1) an edge towards z0 at s0: 12 m flat top, a parabolic
    vertical curve sized by the class K value, then the class grade."""
    g = MAX_GRADE.get(e.cls, 0.1) * 0.85
    K = K_MIN.get(_fam(e.cls), 12)
    half = max(K * g * 100, 20.0)                 # half of the crest/sag curve length
    d = np.maximum(np.abs(e.s - s0) - 12.0, 0.0)
    drop = np.where(d < half, g * d * d / (2 * half), g * (d - half / 2))
    cone = z0 - sign * drop
    e.z = np.maximum(e.z, cone) if sign > 0 else np.minimum(e.z, cone)


def vertical_fair(e):
    """Final vertical smoothing so grade changes respect the class K value."""
    if e.z is None or len(e.z) < 6 or e.road.spec.get("connector"):
        return
    K = K_MIN.get(_fam(e.cls), 12)
    sigma = max(6.0, K * 1.8)
    pins = np.zeros(len(e.z), bool)
    for k in (0, 1):
        ss = e.s if k == 0 else e.L - e.s
        pins |= ss <= e.trim[k]
    if e.n[0] is e.n[1] and e.road.closed:
        k = len(e.z)
        z = grade_limit(e.z, float(e.s[1] - e.s[0]), MAX_GRADE.get(e.cls, 0.1), closed=True)
        for _ in range(3):
            ext = np.concatenate([z[:-1], z[:-1], z[:-1]])
            z = geom.gaussian_smooth(ext, np.arange(len(ext)) * float(e.s[1] - e.s[0]), sigma)[k - 1:2 * k - 1]
        z[-1] = z[0]
        e.z = z
        return
    z = grade_limit_pinned(e.z, e.s, MAX_GRADE.get(e.cls, 0.1), pins)
    base = z.copy()
    for _ in range(3):
        z = geom.gaussian_smooth(z, e.s, sigma)
    # pull the smoothed profile back onto the pinned junction pads with a long, smooth fade
    for k in (0, 1):
        ss = e.s if k == 0 else e.L - e.s
        edge = e.trim[k]
        idx = int(np.searchsorted(e.s, edge)) if k == 0 else int(np.searchsorted(e.s, e.L - edge)) - 1
        idx = int(np.clip(idx, 0, len(z) - 1))
        delta = base[idx] - z[idx]
        fade = 1 - geom.smoothstep(edge, edge + 2.5 * sigma, ss)
        z = z + delta * fade
    z[pins] = base[pins]
    e.z = z


def grade_limit_pinned(z, s, g, pins):
    """Grade limit along an edge while pinned samples (junction pads) keep their level."""
    out = z.copy()
    ds = np.maximum(np.diff(s), 1e-6)
    for _ in range(4):
        for i in range(1, len(out)):
            if not pins[i]:
                st = g * ds[i - 1]
                out[i] = min(max(out[i], out[i - 1] - st), out[i - 1] + st)
        for i in range(len(out) - 2, -1, -1):
            if not pins[i]:
                st = g * ds[i]
                out[i] = min(max(out[i], out[i + 1] - st), out[i + 1] + st)
    return out


# ------------------------------------------------------------------ network
class Network:
    def __init__(self):
        self.roads = []
        self.ramps = []
        self.nodes = []
        self.edges = []

    # -- spatial hash of split-road segments
    def _seg_hash(self, roads, cell=40.0):
        H = defaultdict(list)
        for ri, r in enumerate(roads):
            for i in range(len(r.P) - 1):
                a, b = r.P[i], r.P[i + 1]
                x0, y0 = np.floor(np.minimum(a, b) / cell).astype(int)
                x1, y1 = np.floor(np.maximum(a, b) / cell).astype(int)
                for gx in range(x0, x1 + 1):
                    for gy in range(y0, y1 + 1):
                        H[(gx, gy)].append((ri, i))
        return H

    def build(self, roads, log=print, interchanges=False):
        ramps = build_interchanges(roads) if interchanges else []
        self.ramps = ramps
        allr = roads + ramps
        splittable = [r for r in allr if r.split]

        # ---- endpoint snapping (T-junctions)
        H = self._seg_hash(splittable)
        cell = 40.0
        splits = defaultdict(list)       # road id -> list of (s, point)

        def nearest_on(p, exclude):
            best = None
            gx, gy = np.floor(p / cell).astype(int)
            seen = set()
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    for ri, i in H.get((gx + dx, gy + dy), ()):
                        if (ri, i) in seen:
                            continue
                        seen.add((ri, i))
                        r = splittable[ri]
                        if r is exclude:
                            continue
                        a, b = r.P[i], r.P[i + 1]
                        ab = b - a
                        tt = float(np.clip(np.dot(p - a, ab) / max(ab @ ab, 1e-9), 0, 1))
                        q = a + ab * tt
                        d = float(np.linalg.norm(q - p))
                        if d < SNAP and (best is None or d < best[0]):
                            best = (d, ri, r.s[i] + tt * (r.s[i + 1] - r.s[i]), q)
            return best

        for r in allr:
            if r.closed:
                continue
            for end in (0, 1):
                if r.end_mode[end] != "node":
                    continue
                p = r.P[0] if end == 0 else r.P[-1]
                hit = nearest_on(p, r)
                if not hit:
                    continue
                d, ri, s_hit, q = hit
                splits[id(splittable[ri])].append((s_hit, q))
                tip, prev = (r.P[0], r.P[1]) if end == 0 else (r.P[-1], r.P[-2])
                if d > 0.5 and np.dot(q - tip, tip - prev) < 0:
                    d = 0.0                 # the foot lies behind the tip: move the tip, don't double back
                if d > 0.5:
                    if end == 0:
                        r.P = np.vstack([q, r.P])
                    else:
                        r.P = np.vstack([r.P, q])
                    r.recompute()
                    if r.U is not None:
                        r.U = np.concatenate([[r.U[0]], r.U]) if end == 0 else np.concatenate([r.U, [r.U[-1]]])
                else:
                    if end == 0:
                        r.P[0] = q
                    else:
                        r.P[-1] = q

        # ---- crossings between split roads
        H = self._seg_hash(splittable)
        done = set()
        for key, items in H.items():
            for x in range(len(items)):
                ri, i = items[x]
                for y in range(x + 1, len(items)):
                    rj, j = items[y]
                    if ri == rj:
                        continue
                    k = (min((ri, i), (rj, j)), max((ri, i), (rj, j)))
                    if k in done:
                        continue
                    done.add(k)
                    A, B = splittable[ri], splittable[rj]
                    res = geom.seg_intersect(A.P[i], A.P[i + 1], B.P[j], B.P[j + 1])
                    if res:
                        tt, uu = res
                        q = A.P[i] + (A.P[i + 1] - A.P[i]) * tt
                        splits[id(A)].append((A.s[i] + tt * (A.s[i + 1] - A.s[i]), q))
                        splits[id(B)].append((B.s[j] + uu * (B.s[j + 1] - B.s[j]), q))

        # ---- profiles on whole roads (ramps later)
        for r in roads:
            if r.z is None or len(r.z) != len(r.P):
                profile(r)

        # ---- cluster split points into nodes
        pts = []    # (pos, road, s, free)
        for r in allr:
            for s, q in splits.get(id(r), []):
                pts.append((np.asarray(q, float), r, float(s), False))
            if not r.closed:
                pts.append((r.P[0].copy(), r, 0.0, r.end_mode[0] == "merge"))
                pts.append((r.P[-1].copy(), r, r.L, r.end_mode[1] == "merge"))
        parent = list(range(len(pts)))

        def find(i):
            while parent[i] != i:
                parent[i] = parent[parent[i]]
                i = parent[i]
            return i

        PH = defaultdict(list)
        for i, (q, r, s, free) in enumerate(pts):
            PH[tuple(np.floor(q / CLUSTER).astype(int))].append(i)
        for i, (q, r, s, free) in enumerate(pts):
            if free:
                continue
            gx, gy = np.floor(q / CLUSTER).astype(int)
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    for j in PH.get((gx + dx, gy + dy), ()):
                        if j <= i or pts[j][3]:
                            continue
                        if np.linalg.norm(pts[j][0] - q) < CLUSTER:
                            parent[find(j)] = find(i)
        groups = defaultdict(list)
        for i in range(len(pts)):
            groups[find(i)].append(i)
        node_of = {}
        for g, members in groups.items():
            n = Node(len(self.nodes), np.mean([pts[m][0] for m in members], 0))
            n.free = all(pts[m][3] for m in members)
            self.nodes.append(n)
            for m in members:
                node_of[m] = n

        # ---- edges
        per_road = defaultdict(list)
        for i, (q, r, s, free) in enumerate(pts):
            per_road[id(r)].append((s, node_of[i]))
        for r in allr:
            lst = sorted(per_road.get(id(r), []), key=lambda x: x[0])
            # dedupe consecutive same node
            ded = []
            for s, n in lst:
                if ded and ded[-1][1] is n:
                    continue
                ded.append((s, n))
            if r.closed:
                if not ded:
                    n = Node(len(self.nodes), r.P[0])
                    self.nodes.append(n)
                    ded = [(0.0, n)]
                if len(ded) > 1 and ded[0][1] is ded[-1][1]:
                    ded = ded[:-1]
                for k in range(len(ded)):
                    s0, n0 = ded[k]
                    s1, n1 = ded[(k + 1) % len(ded)]
                    if k == len(ded) - 1:
                        s1 = s1 + r.L
                    self._add_edge(r, s0, s1, n0, n1)
            else:
                for k in range(len(ded) - 1):
                    self._add_edge(r, ded[k][0], ded[k + 1][0], ded[k][1], ded[k + 1][1])
        self._collapse_short(14.0)
        self._collapse_short(25.0, only_split=True)
        self._prune_stubs(60.0)
        self._remove_dead_ends()
        self._limit_degree()
        self._square_junctions()
        self._compact()
        self.roads = roads
        log(f"network: {len(self.roads)} roads, {len(self.ramps)} ramps, "
            f"{len(self.nodes)} nodes, {len(self.edges)} edges")
        self.roads = roads
        self.all_roads = allr

    def _add_edge(self, r, s0, s1, n0, n1):
        L_ = r.L
        if s1 - s0 < 0.5:
            return
        ss = np.arange(s0, s1, SPACING)
        if s1 - ss[-1] < SPACING * 0.4 and len(ss) > 1:
            ss = ss[:-1]
        ss = np.concatenate([ss, [s1]])
        sw = np.mod(ss, L_) if r.closed else np.clip(ss, 0, L_)
        if r.closed:
            sw[-1] = s1 if s1 <= L_ else s1 - L_
        P = np.stack([np.interp(sw, r.s, r.P[:, 0]), np.interp(sw, r.s, r.P[:, 1])], 1)
        P[0] = n0.pos
        P[-1] = n1.pos
        # the node may sit a little past the neighbouring sample: drop samples the end would double back over
        keep = np.ones(len(P), bool)
        for i in range(1, len(P) - 1):
            if np.dot(P[i] - P[0], P[-1] - P[0]) <= 1.0 or np.dot(P[-1] - P[i], P[-1] - P[0]) <= 1.0:
                if np.hypot(*(P[i] - P[0])) < SPACING or np.hypot(*(P[i] - P[-1])) < SPACING:
                    keep[i] = False
        P, sw = P[keep], sw[keep]
        e = Edge(len(self.edges), r, P, sw, n0, n1)
        if r.z is not None:
            e.z = np.interp(sw, r.s, r.z)
            e.N = np.interp(sw, r.s, r.N)
        self.edges.append(e)
        n0.edges.append((e, 0))
        n1.edges.append((e, 1))

    def _collapse_short(self, minlen, only_split=False):
        changed = True
        while changed:
            changed = False
            for e in list(self.edges):
                if e.L >= minlen or e.n[0] is e.n[1]:
                    continue
                if only_split and (not e.road.split or any(not x.road.split for nd in e.n for x, _ in nd.edges)):
                    continue
                a, b = e.n
                if a.free or b.free:
                    continue
                a.pos = (a.pos + b.pos) / 2
                self.edges.remove(e)
                a.edges = [(x, k) for x, k in a.edges if x is not e]
                for x, k in b.edges:
                    if x is e:
                        continue
                    x.n[k] = a
                    a.edges.append((x, k))
                b.edges = []
                for x, k in a.edges:
                    x.P[0 if k == 0 else -1] = a.pos
                    x.recompute()
                changed = True
                break

    def _prune_stubs(self, maxlen):
        for _ in range(3):
            for n in self.nodes:
                if len(n.edges) == 1 and not n.free:
                    e, k = n.edges[0]
                    other = e.n[1 - k]
                    if e.road.split and e.L < maxlen and len(other.edges) >= 3:
                        self.edges.remove(e)
                        n.edges = []
                        other.edges = [(x, kk) for x, kk in other.edges if x is not e]

    def _remove_dead_ends(self):
        """Drop dangling branches back to the nearest junction (no arbitrary dead ends).
        Freeways, ramps and roads flagged keep_end are left alone."""
        removed = 0
        changed = True
        while changed:
            changed = False
            for n in self.nodes:
                if len(n.edges) != 1 or n.free:
                    continue
                e, k = n.edges[0]
                if e.road.cls in ("freeway", "ramp") or e.road.spec.get("keep_end"):
                    continue
                other = e.n[1 - k]
                if other is n:
                    continue
                self.edges.remove(e)
                n.edges = []
                other.edges = [(x, kk) for x, kk in other.edges if x is not e]
                removed += 1
                changed = True
        self.dead_removed = removed

    def _limit_degree(self, maxdeg=4):
        """Junctions with more than four arms lose their shortest minor arm."""
        for n in self.nodes:
            while len(n.edges) > maxdeg:
                cands = [(e.L, e, k) for e, k in n.edges if e.cls in ("street", "lane", "industrial", "rural")
                         and len(e.n[1 - k].edges) >= 3 and e.n[0] is not e.n[1]]
                if not cands:
                    break
                _, e, k = min(cands, key=lambda c: c[0])
                o = e.n[1 - k]
                self.edges.remove(e)
                n.edges = [(x, kk) for x, kk in n.edges if x is not e]
                o.edges = [(x, kk) for x, kk in o.edges if x is not e]

    def _square_junctions(self, min_angle=62.0, straight=25.0, blend=40.0):
        """Every arm (except freeway carriageways / ramps) leaves its junction on a straight
        line for `straight` metres, then eases back onto its own alignment over `blend` m.
        Minor arms that would meet the through road at less than min_angle are turned square."""
        cosmax = math.cos(math.radians(min_angle))
        for n in self.nodes:
            arms = [(e, k) for e, k in n.edges if e.L > 30]
            if len(arms) < 3:
                continue

            def d_out(e, k, look=30.0):
                q = e.P[np.searchsorted(e.s, min(look, e.L * 0.5))] if k == 0 else \
                    e.P[np.searchsorted(e.s, e.L - min(look, e.L * 0.5))]
                return geom.unit(q - n.pos)

            best = None
            for i in range(len(arms)):
                for j in range(i + 1, len(arms)):
                    c = float(np.dot(d_out(*arms[i]), d_out(*arms[j])))
                    pr = CLASSES[arms[i][0].cls]["prio"] + CLASSES[arms[j][0].cls]["prio"]
                    key = (pr, -c)
                    if best is None or key > best[0]:
                        best = (key, i, j)
            _, i, j = best
            tmain = geom.unit(d_out(*arms[i]) - d_out(*arms[j]))
            for m, (e, k) in enumerate(arms):
                if e.cls.startswith(("fw1", "ramp")) or not e.road.split or m in (i, j):
                    continue
                dv = d_out(e, k)
                if abs(float(np.dot(dv, tmain))) > cosmax:
                    nrm = np.array([-tmain[1], tmain[0]])
                    dv = nrm if np.dot(nrm, dv) > 0 else -nrm
                P = e.P if k == 0 else e.P[::-1]
                s = geom.cum_length(P)
                # current heading over the first metres vs the wanted one
                q = P[min(int(np.searchsorted(s, 15.0)), len(P) - 1)]
                theta = math.acos(float(np.clip(np.dot(geom.unit(q - P[0]), dv), -1, 1)))
                if theta < math.radians(4):
                    continue
                from .validate import MIN_R, family
                others = [x for x, _ in n.edges if x is not e]
                st = max(hwt(x.cls) for x in others) + CLASSES[e.cls]["corner"] + 22.0
                bl = max(30.0, 1.6 * MIN_R.get(family(e.cls), 30) * theta)
                if st + bl > e.L * 0.6:
                    # not enough room to turn it square: drop the arm if the network stays connected
                    o = e.n[1 - k]
                    if len(n.edges) >= 4 and len(o.edges) >= 3 and e.cls in ("street", "lane", "rural", "industrial"):
                        self.edges.remove(e)
                        n.edges = [(x, kk) for x, kk in n.edges if x is not e]
                        o.edges = [(x, kk) for x, kk in o.edges if x is not e]
                    continue
                L = st + bl
                cnt = int(np.searchsorted(s, L))
                if cnt < 3:
                    continue
                ss = s[:cnt + 1]
                target = P[0] + dv[None, :] * ss[:, None]
                w = geom.smoothstep(st, ss[-1], ss)[:, None]
                P = P.copy()
                P[:cnt + 1] = target * (1 - w) + P[:cnt + 1] * w
                e.P = P if k == 0 else P[::-1]
                e.recompute()

    def _compact(self):
        self.nodes = [n for n in self.nodes if n.edges]
        for i, n in enumerate(self.nodes):
            n.idx = i
        for i, e in enumerate(self.edges):
            e.idx = i

    # ------------------------------------------------------------- geometry
    def compute_trims(self):
        for e in self.edges:
            e.trim = [0.0, 0.0]
        for n in self.nodes:
            arms = []
            for e, k in n.edges:
                if e.L < 1:
                    continue
                look = min(16.0, e.L * 0.4)
                q = e.P[np.searchsorted(e.s, look)] if k == 0 else e.P[np.searchsorted(e.s, e.L - look)]
                d = geom.unit(q - n.pos)
                arms.append(dict(e=e, k=k, d=d, ang=math.atan2(d[1], d[0]),
                                 hw=hw(e.cls), hwt=hwt(e.cls), corner=CLASSES[e.cls]["corner"]))
            arms.sort(key=lambda a: a["ang"])
            n.arms = arms
            if len(arms) <= 1:
                n.kind = "end"
                continue
            if len(arms) == 2:
                a, b = arms
                dot = float(np.dot(a["d"], b["d"]))
                if dot < -0.94 and abs(a["hwt"] - b["hwt"]) < 0.01 and abs(a["hw"] - b["hw"]) < 0.01:
                    n.kind = "joint"
                    continue
                # class change or bend between two roads: one road bending, never a junction pad —
                # loft between the two end sections, longer for sharper bends and bigger width changes
                n.kind = "transition"
                bend = math.acos(max(-1.0, min(1.0, -dot)))
                t = min(45.0, 6.0 + 1.5 * abs(a["hwt"] - b["hwt"]) + max(a["hwt"], b["hwt"]) * math.tan(bend / 2) * 1.5)
                for arm in arms:
                    arm["e"].trim[arm["k"]] = min(t, arm["e"].L * 0.35)
                continue
            n.kind = "junction"
            m = len(arms)
            req = [0.0] * m
            for i in range(m):
                j = (i + 1) % m
                A, B = arms[i], arms[j]
                nA = geom.left_normal(A["d"])
                nB = geom.left_normal(B["d"])
                pA = n.pos + nA * A["hwt"]
                pB = n.pos - nB * B["hwt"]
                gap = (B["ang"] - A["ang"]) % (2 * math.pi)
                if gap > math.radians(165) or gap < 1e-3:
                    continue
                res = geom.line_intersect(pA, A["d"], pB, B["d"])
                if res is None:
                    continue
                ta, tb = res
                req[i] = max(req[i], ta)
                req[j] = max(req[j], tb)
            for i, A in enumerate(arms):
                base = max(req[i], max(o["hw"] for o in arms if o is not A) * 0.6)
                t = base + A["corner"]
                t = min(t, A["e"].L * 0.45, 90.0)
                A["e"].trim[A["k"]] = max(t, 0.0)

    def compute_node_z(self):
        for n in self.nodes:
            arms = [(e, k) for e, k in n.edges if e.z is not None]
            if not arms:
                continue
            fw = [e.z[0] if k == 0 else e.z[-1] for e, k in arms if e.cls == "freeway" or e.cls.startswith("fw1")]
            n.fixed = bool(fw)
            if fw:
                n.z = float(np.mean(fw))
                continue
            zs = [e.z[0] if k == 0 else e.z[-1] for e, k in arms]
            ws = [CLASSES[e.cls]["prio"] for e, k in arms]
            n.z = float(np.average(zs, weights=ws))
        # relax junction levels until every edge can respect its grade limit
        for it in range(200):
            worst = 0.0
            for e in self.edges:
                a, b = e.n
                if e.z is None or a is b or a.z is None or b.z is None:
                    continue
                leff = max(e.L - e.trim[0] - e.trim[1], 4.0)
                lim = MAX_GRADE.get(e.cls, 0.1) * 0.6 * leff
                d = b.z - a.z
                if abs(d) <= lim:
                    continue
                ex = (abs(d) - lim) * np.sign(d)
                fa, fb = getattr(a, "fixed", False), getattr(b, "fixed", False)
                if fa and fb:
                    continue
                wa = 0.0 if fa else (1.0 if fb else 0.5)
                a.z += ex * wa * 0.9
                b.z -= ex * (1 - wa) * 0.9
                worst = max(worst, abs(ex))
            if worst < 0.05:
                break
        # junction pads lie in a tilted plane following the arms' grades (not flat)
        for n in self.nodes:
            n.grad = np.zeros(2)
            arms = [(e, k) for e, k in n.edges if e.z is not None and e.L > 20]
            if n.z is None or len(arms) < 2:
                continue
            A, bvec, wv = [], [], []
            for e, k in arms:
                look = min(40.0, e.L * 0.5)
                i = int(np.searchsorted(e.s, look)) if k == 0 else int(np.searchsorted(e.s, e.L - look))
                i = int(np.clip(i, 0, len(e.P) - 1))
                d = e.P[i] - n.pos
                dist = float(np.linalg.norm(d))
                if dist < 5:
                    continue
                A.append(d / dist)
                bvec.append((e.z[i] - n.z) / dist)
                wv.append(CLASSES[e.cls]["prio"])
            if len(A) >= 2:
                W_ = np.sqrt(np.array(wv, float))[:, None]
                G, *_ = np.linalg.lstsq(np.array(A) * W_, np.array(bvec) * W_[:, 0], rcond=None)
                gn = float(np.linalg.norm(G))
                if gn > 0.06:
                    G = G * (0.06 / gn)
                n.grad = G
        for e in self.edges:
            if e.z is None:
                continue
            g = MAX_GRADE.get(e.cls, 0.1)
            raw = e.z.copy()
            z = raw.copy()
            ends = []
            for k in (0, 1):
                nd = e.n[k]
                if nd.z is None or nd.free:
                    ends.append(None)
                    continue
                ends.append(nd.z - (raw[0] if k == 0 else raw[-1]))
            inner = max(e.L - e.trim[0] - e.trim[1], 1.0)
            spans = [0.0, 0.0]
            for k in (0, 1):
                if ends[k] is not None:
                    spans[k] = min(max(abs(ends[k]) / (0.5 * g), 40.0, min(150.0, e.L * 0.5)), e.L)
            if ends[0] is not None and ends[1] is not None and e.L < 200:
                t = geom.smoothstep(e.trim[0], e.L - e.trim[1], e.s)
                z = e.n[0].z + (e.n[1].z - e.n[0].z) * t
            elif ends[0] is not None and ends[1] is not None and spans[0] + spans[1] > inner:
                t = geom.smoothstep(e.trim[0], e.L - e.trim[1], e.s)
                z = raw + ends[0] * (1 - t) + ends[1] * t
            else:
                for k in (0, 1):
                    if ends[k] is None:
                        continue
                    ss = e.s if k == 0 else e.L - e.s
                    z = z + ends[k] * (1 - geom.smoothstep(e.trim[k], e.trim[k] + spans[k], ss))
            pins = np.zeros(len(z), bool)
            for k in (0, 1):
                nd = e.n[k]
                if nd.z is None or nd.free:
                    continue
                ss = e.s if k == 0 else e.L - e.s
                f = 1 - geom.smoothstep(e.trim[k], e.trim[k] + 10, ss)
                plane = nd.z + (e.P - nd.pos) @ getattr(nd, "grad", np.zeros(2))
                z = z * (1 - f) + plane * f
                pins |= ss <= e.trim[k]
            e.z = grade_limit_pinned(z, e.s, g, pins)

    def ramp_profiles(self):
        host_edges = defaultdict(list)
        for e in self.edges:
            if e.z is not None:
                host_edges[e.road.name.split("#")[0]].append(e)

        def host_z(name, p):
            best = None
            for e in host_edges[name]:
                d, i, t, q = geom.project_to_polyline(e.P, p)
                if best is None or d < best[0]:
                    best = (d, e.z[i] + (e.z[min(i + 1, len(e.z) - 1)] - e.z[i]) * t)
            return best[1]

        for e in self.edges:
            if not e.road.cls.startswith("ramp") or e.z is not None:
                continue
            r = e.road
            zs = np.zeros(len(e.P))
            ends = []
            for k in (0, 1):
                if r.end_mode[k] == "merge":
                    ends.append(("merge", r.merge_host[k]))
                else:
                    ends.append(("node", e.n[k].z))
            hz = [np.array([host_z(ends[k][1], p) for p in e.P]) if ends[k][0] == "merge" else None
                  for k in (0, 1)]
            z0 = hz[0] if hz[0] is not None else np.full(len(e.P), ends[0][1])
            z1 = hz[1] if hz[1] is not None else np.full(len(e.P), ends[1][1])
            taper0 = 80.0 if ends[0][0] == "merge" else 10.0
            taper1 = 80.0 if ends[1][0] == "merge" else 10.0
            w = geom.smoothstep(taper0, e.L - taper1, e.s)
            zs = z0 * (1 - w) + z1 * w
            e.z = geom.gaussian_smooth(zs, e.s, 6.0)
            e.z[0] = zs[0]
            e.z[-1] = zs[-1]
            e.N = natural_along(e.P)
        for n in self.nodes:
            if n.z is None:
                zs = [e.z[0] if k == 0 else e.z[-1] for e, k in n.edges if e.z is not None]
                n.z = float(np.mean(zs)) if zs else 0.0

    def separate_levels(self, clearance=7.2, log=print, all_pairs=False):
        """Grade-separate crossings: the upper road humps up, the lower one dips down until the
        vertical clearance is met. By default only crossings involving freeways/ramps; with
        all_pairs every crossing of two edges that do not meet at a shared node (OSM topology).
        The upper road is chosen by OSM layer, then bridge flag, then current height."""
        def fast(e):
            return e.cls in ("freeway", "ramp") or e.cls.startswith(("fw1", "ramp"))

        H = defaultdict(list)
        cell = 40.0
        for e in self.edges:
            if e.z is None or not (all_pairs or fast(e)):
                continue
            for i in range(len(e.P) - 1):
                a, b = e.P[i], e.P[i + 1]
                for gx in range(int(min(a[0], b[0]) // cell), int(max(a[0], b[0]) // cell) + 1):
                    for gy in range(int(min(a[1], b[1]) // cell), int(max(a[1], b[1]) // cell) + 1):
                        H[(gx, gy)].append((e, i))
        fixes = 0
        for _ in range(3):
            changed = False
            for e in self.edges:
                if e.z is None:
                    continue
                for i in range(len(e.P) - 1):
                    a, b = e.P[i], e.P[i + 1]
                    seen = set()
                    for gx in range(int(min(a[0], b[0]) // cell), int(max(a[0], b[0]) // cell) + 1):
                        for gy in range(int(min(a[1], b[1]) // cell), int(max(a[1], b[1]) // cell) + 1):
                            for f, j in H.get((gx, gy), ()):
                                if f is e or (id(f), j) in seen:
                                    continue
                                seen.add((id(f), j))
                                if (all_pairs or fast(e)) and id(f) < id(e):
                                    continue        # each pair once
                                r = geom.seg_intersect(a, b, f.P[j], f.P[j + 1])
                                if not r:
                                    continue
                                q = a + (b - a) * r[0]
                                shared = [nd for nd in e.n if nd in f.n]
                                if any(np.hypot(*(q - nd.pos)) < 30.0 for nd in shared):
                                    continue        # they meet at a junction, not a crossing
                                se = e.s[i] + r[0] * (e.s[i + 1] - e.s[i])
                                sf = f.s[j] + r[1] * (f.s[j + 1] - f.s[j])
                                if _taper_zone(e, se, f.road.name) or _taper_zone(f, sf, e.road.name):
                                    continue        # a ramp on its own host's taper
                                ze = float(np.interp(se, e.s, e.z))
                                zf = float(np.interp(sf, f.s, f.z))
                                da = geom.unit(b - a)
                                db = geom.unit(f.P[j + 1] - f.P[j])
                                mh_e = getattr(e.road, "merge_host", None) or [None, None]
                                mh_f = getattr(f.road, "merge_host", None) or [None, None]
                                sib = any(mh_e[k] and mh_e[k] == mh_f[k] for k in (0, 1))
                                if sib and abs(float(np.dot(da, db))) > 0.93 and abs(ze - zf) < 1.2:
                                    continue        # siblings on one merge / diverge taper, not a crossing
                                le = int(getattr(e, "layer", np.zeros(len(e.P), int))[i])
                                lf = int(getattr(f, "layer", np.zeros(len(f.P), int))[j])
                                be = bool(getattr(e, "bridge", np.zeros(len(e.P), bool))[i])
                                bf = bool(getattr(f, "bridge", np.zeros(len(f.P), bool))[j])
                                if le != lf:
                                    e_up = le > lf
                                elif be != bf:
                                    e_up = be
                                else:
                                    e_up = ze >= zf
                                hi, lo = (e, f) if e_up else (f, e)
                                s_hi, s_lo = (se, sf) if e_up else (sf, se)
                                z_hi, z_lo = (ze, zf) if e_up else (zf, ze)
                                need = clearance + 1.7 - (z_hi - z_lo)
                                if need <= 0.05:
                                    continue
                                up = need * (0.6 if (fast(hi) or getattr(hi, "bridge", None) is not None) else 0.4)
                                _cone(hi, s_hi, z_hi + up, +1)
                                _cone(lo, s_lo, z_lo - (need - up), -1)
                                changed = True
                                fixes += 1
            if not changed:
                break
        log(f"levels: {fixes} grade separations")

    def _pin_to_hosts(self):
        """Ramps / connectors lying on their host carriageway take its final surface height;
        between the pinned stretches the grade limit re-shapes the profile."""
        by = defaultdict(list)
        for e in self.edges:
            by[e.road.name].append(e)
        for e in self.edges:
            hosts = [h for h in (getattr(e.road, "merge_host", None) or []) if h]
            if not hosts or e.z is None:
                continue
            z = e.z.copy()
            pins = np.zeros(len(z), bool)
            mh = getattr(e.road, "merge_host", None) or []
            for end, hn in enumerate(mh):
                if not hn:
                    continue
                # pin the whole stretch that still overlaps the host, walking in from this end
                order = range(len(e.P)) if end == 0 else range(len(e.P) - 1, -1, -1)
                for h in by.get(hn, []):
                    lim = hw(h.cls) + hw(e.cls) - 0.3
                    for i in order:
                        d, j, tt, _ = geom.project_to_polyline(h.P, e.P[i])
                        if d >= lim:
                            if min(e.s[i], e.L - e.s[i]) > 30.0:
                                break
                            continue
                        z[i] = h.z[j] + (h.z[min(j + 1, len(h.z) - 1)] - h.z[j]) * tt - 0.04
                        pins[i] = True
            if pins.any():
                e.z = grade_limit_pinned(z, e.s, MAX_GRADE.get(e.cls, 0.07), pins)

    def _open_merges(self, margin=40.0):
        """A ramp cannot merge inside a tunnel bore: where a connector still lies on its host
        carriageway, both run in an open cut instead."""
        by = defaultdict(list)
        for e in self.edges:
            by[e.road.name].append(e)
        for e in self.edges:
            for hn in [h for h in (getattr(e.road, "merge_host", None) or []) if h]:
                for h in by.get(hn, []):
                    if not h.tunnel.any():
                        continue
                    lim = hw(h.cls) + hw(e.cls) + 1.0
                    for i, p in enumerate(e.P):
                        d, j, _, _ = geom.project_to_polyline(h.P, p)
                        if d < lim:
                            h.tunnel[np.abs(h.s - h.s[j]) < margin] = False
                            e.tunnel[np.abs(e.s - e.s[i]) < margin] = False

    def _repin_pads(self):
        """Grade separation may have dipped or humped an arm inside its junction pad: put the
        arm back onto the pad plane and let the grade limit carry the change outward."""
        # a plain joint of two roads follows the lower arm: a dip for an underpass must survive
        for nd in self.nodes:
            if nd.z is None or nd.free or len(nd.edges) != 2:
                continue
            ends = [(e.z[0] if k == 0 else e.z[-1]) for e, k in nd.edges if e.z is not None]
            if len(ends) == 2 and all(e.trim[k] <= 0 for e, k in nd.edges):
                nd.z = float(min(min(ends), nd.z))
        for e in self.edges:
            if e.z is None:
                continue
            z = e.z.copy()
            pins = np.zeros(len(z), bool)
            for k in (0, 1):
                nd = e.n[k]
                if nd.z is None or nd.free:
                    continue
                ss = e.s if k == 0 else e.L - e.s
                on = ss <= e.trim[k]          # a plain joint (no pad) still pins its end sample
                # samples are ~8 m apart: the one just past the pad edge pins the seam too
                past = np.where(~on)[0]
                if len(past):
                    on[past[0] if k == 0 else past[-1]] = True
                plane = nd.z + (e.P - nd.pos) @ getattr(nd, "grad", np.zeros(2))
                z = np.where(on, plane, z)
                pins |= on
            if pins.any() and np.abs(z - e.z).max() > 0.02:
                e.z = grade_limit_pinned(z, e.s, MAX_GRADE.get(e.cls, 0.1), pins)

    def _pin_siblings(self):
        """Connectors whose surfaces overlap without clearance between them (forks, merges,
        ramps squeezed side by side) must form one surface: overlapping samples share a height."""
        con = [e for e in self.edges if e.z is not None and any(getattr(e.road, "merge_host", None) or [])]
        for a_i, a in enumerate(con):
            for b in con[a_i + 1:]:
                if a.road is b.road:
                    continue
                lo = np.maximum(a.P.min(0), b.P.min(0)) - 20
                hi = np.minimum(a.P.max(0), b.P.max(0)) + 20
                if (lo > hi).any():
                    continue
                lim = hw(a.cls) + hw(b.cls) - 0.3
                pa, pb = np.zeros(len(a.z), bool), np.zeros(len(b.z), bool)
                za, zb = a.z.copy(), b.z.copy()
                # siblings joining the same host at the same end run as one slab, whatever
                # their heights: walk in from that end while they still touch
                walk = np.zeros(len(a.P), bool)
                for end in (0, 1):
                    h = a.road.merge_host[end]
                    if h and h == b.road.merge_host[end]:
                        for i in (range(len(a.P)) if end == 0 else range(len(a.P) - 1, -1, -1)):
                            if geom.project_to_polyline(b.P, a.P[i])[0] >= lim + 0.6:
                                if min(a.s[i], a.L - a.s[i]) > 30.0:
                                    break
                                continue
                            walk[i] = True
                for i in range(len(a.P)):
                    d, j, tt, _ = geom.project_to_polyline(b.P, a.P[i])
                    j2 = min(j + 1, len(b.z) - 1)
                    zbi = b.z[j] + (b.z[j2] - b.z[j]) * tt
                    if not walk[i]:             # crossings stay grade-separated
                        continue
                    zm = 0.5 * (a.z[i] + zbi)
                    za[i] = zm; pa[i] = True
                    zb[j] = zb[j2] = zm; pb[j] = pb[j2] = True
                if pa.any():
                    a.z = grade_limit_pinned(za, a.s, MAX_GRADE.get(a.cls, 0.07), pa)
                    b.z = grade_limit_pinned(zb, b.s, MAX_GRADE.get(b.cls, 0.07), pb)

    def _assign_layers(self):
        for e in self.edges:
            if hasattr(e, "layer") and len(e.layer) == len(e.P):
                continue
            lay = e.road.spec.get("layer")
            e.layer = (np.round(np.interp(e.s_road, e.road.s, np.asarray(lay, float))).astype(int)
                       if lay is not None and len(lay) == len(e.road.P) else np.zeros(len(e.P), int))

    def finalize(self, log=print, all_pairs=True):
        self._assign_layers()
        self.compute_trims()
        self.compute_node_z()
        self.ramp_profiles()
        self.separate_levels(log=log, all_pairs=all_pairs)
        for e in self.edges:
            vertical_fair(e)
        self._pin_to_hosts()
        for _ in range(2):
            self.separate_levels(log=lambda *a: None, all_pairs=all_pairs)
            self._pin_to_hosts()
        self._repin_pads()
        self._pin_siblings()
        for e in self.edges:
            if not hasattr(e, "N"):
                e.N = natural_along(e.P)
            e.elev = (e.z - e.N) > 3.0
            tm = e.road.spec.get("tunnel_mask")
            forced = np.zeros(len(e.P), bool)
            if tm is not None and len(tm) == len(e.road.P):
                forced = np.interp(e.s_road, e.road.s, tm.astype(float)) > 0.5
            deep = (e.N - e.z) > 7.5
            # short dips under another road are underpasses in a cut, not tunnels
            run = np.zeros(len(deep), bool)
            i = 0
            while i < len(deep):
                if deep[i]:
                    j = i
                    while j < len(deep) and deep[j]:
                        j += 1
                    if e.s[j - 1] - e.s[i] > 80.0:
                        run[i:j] = True
                    i = j
                else:
                    i += 1
            e.tunnel = run | forced
        self._open_merges()

        self.report(log)

    def report(self, log=print):
        worst = []
        for e in self.edges:
            if e.L < 20:
                continue
            g = np.abs(np.diff(e.z)) / np.maximum(np.diff(e.s), 1e-6)
            g = geom.gaussian_smooth(g, e.s[1:], 8)
            worst.append((float(g.max()), e.road.name))
        worst.sort(reverse=True)
        log("steepest grades: " + ", ".join(f"{n} {g * 100:.1f}%" for g, n in worst[:10]))
        kinds = defaultdict(int)
        for n in self.nodes:
            kinds[getattr(n, "kind", "?")] += 1
        log(f"node kinds: {dict(kinds)}")
