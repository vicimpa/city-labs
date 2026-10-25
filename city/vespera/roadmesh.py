"""Road geometry: carriageways, curbs, sidewalks, junction pads, markings,
barriers, piers and tunnels. Produces engine-agnostic mesh buffers."""
import math
from collections import defaultdict

import numpy as np

from . import geom, terrain as T
from .network import CLASSES, hw, hwt

CURB = 0.15
URBAN = {"boulevard", "avenue", "street", "lane"}


class MB:
    """Mesh buffer: vertices, polygons (index tuples), per-vertex uv, material per polygon."""

    def __init__(self):
        self.V = []
        self.UV = []
        self.F = []
        self.M = []
        self.n = 0

    def add(self, V, UV, faces, mat):
        V = np.asarray(V, np.float32).reshape(-1, 3)
        UV = np.asarray(UV, np.float32).reshape(-1, 2)
        base = self.n
        self.V.append(V)
        self.UV.append(UV)
        for f in faces:
            self.F.append(tuple(int(i) + base for i in f))
            self.M.append(mat)
        self.n += len(V)

    def strip(self, rows, uvs, mat, closed=False):
        """rows: (n, m, 3) grid of vertices ordered left->right; quads face up/out."""
        rows = np.asarray(rows, np.float32)
        n, m = rows.shape[:2]
        if n < 2 or m < 2:
            return
        idx = np.arange(n * m).reshape(n, m)
        a = idx[:-1, :-1].ravel()
        b = idx[:-1, 1:].ravel()
        c = idx[1:, 1:].ravel()
        d = idx[1:, :-1].ravel()
        self.add(rows.reshape(-1, 3), np.asarray(uvs).reshape(-1, 2), zip(a, b, c, d), mat)

    def arrays(self):
        if not self.V:
            return None
        return np.vstack(self.V), np.vstack(self.UV), self.F, self.M


class Layers(defaultdict):
    def __init__(self):
        super().__init__(MB)


# ------------------------------------------------------------------ helpers
def _sample_range(e, s0, s1):
    ss = e.s[(e.s > s0 + 0.3) & (e.s < s1 - 0.3)]
    ss = np.concatenate([[s0], ss, [s1]])
    P = np.stack([np.interp(ss, e.s, e.P[:, 0]), np.interp(ss, e.s, e.P[:, 1])], 1)
    z = np.interp(ss, e.s, e.z)
    Tn = _tangent_at(e, ss)
    flags = {k: np.interp(ss, e.s, getattr(e, k).astype(float)) > 0.5 for k in ("elev", "tunnel")}
    return ss, P, z, Tn, flags


def _tangent_at(e, ss):
    a = np.stack([np.interp(ss - 2.0, e.s, e.P[:, 0]), np.interp(ss - 2.0, e.s, e.P[:, 1])], 1)
    b = np.stack([np.interp(ss + 2.0, e.s, e.P[:, 0]), np.interp(ss + 2.0, e.s, e.P[:, 1])], 1)
    return geom.unit(b - a)


def _world_uv(V, scale):
    V = np.asarray(V)
    return V[..., :2] / scale


class RoadIndex:
    """Spatial lookup: is a point on top of some other road's carriageway?"""

    def __init__(self, net, cell=30.0):
        self.cell = cell
        self.H = defaultdict(list)
        for e in net.edges:
            if e.z is None:
                continue
            for i in range(0, len(e.P) - 1):
                p = e.P[i]
                self.H[(int(p[0] // cell), int(p[1] // cell))].append((e, i))

    def covering(self, p, z, exclude, margin=0.3, dz=1.6, shrink=0.0):
        gx, gy = int(p[0] // self.cell), int(p[1] // self.cell)
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for e, i in self.H.get((gx + dx, gy + dy), ()):
                    if e is exclude:
                        continue
                    a, b = e.P[i], e.P[i + 1]
                    ab = b - a
                    t = float(np.clip(np.dot(p - a, ab) / max(ab @ ab, 1e-9), 0, 1))
                    q = a + ab * t
                    if np.hypot(*(p - q)) < hw(e.cls) - margin - shrink and abs(e.z[i] - z) < dz:
                        return e
        return None

    def ground_road_near(self, p, z_top, extra=1.0):
        gx, gy = int(p[0] // self.cell), int(p[1] // self.cell)
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for e, i in self.H.get((gx + dx, gy + dy), ()):
                    if e.z[i] > z_top - 4:
                        continue
                    a, b = e.P[i], e.P[i + 1]
                    ab = b - a
                    t = float(np.clip(np.dot(p - a, ab) / max(ab @ ab, 1e-9), 0, 1))
                    q = a + ab * t
                    if np.hypot(*(p - q)) < hwt(e.cls) + extra:
                        return True
        return False


# ------------------------------------------------------------------ edges
def build_edge(e, L, idx):
    c = CLASSES[e.cls]
    s0 = e.trim[0]
    s1 = e.L - e.trim[1]
    if s1 - s0 < 0.5:
        return
    ss, P, z, Tn, fl = _sample_range(e, s0, s1)
    Nn = geom.left_normal(Tn)
    W = hw(e.cls)
    side = c["side"]
    n = len(ss)
    elev = fl["elev"]
    tun = fl["tunnel"]
    # z-fighting guard: a ramp sinks under its host where they overlap
    if e.cls == "ramp":
        for i in range(n):
            if idx.covering(P[i], z[i], e, margin=0.0, dz=1.0):
                z[i] -= 0.04

    def row(u, dz):
        return np.concatenate([P + Nn * u, (z + dz)[:, None]], 1)

    # carriageway
    rows = np.stack([row(W, 0), row(-W, 0)], 1)
    L["asphalt"].strip(rows, _world_uv(rows, 8.0), "asphalt")

    depth = np.where(elev, -1.7, -1.3)
    if side > 0:
        W2 = W + side
        for sg in (1, -1):
            pts = [row(sg * W, 0), row(sg * W, CURB)]
            curb = np.stack(pts if sg < 0 else pts[::-1], 1)
            uvc = np.stack([np.stack([ss / 2, np.zeros(n)], 1), np.stack([ss / 2, np.full(n, 0.15)], 1)], 1)
            L["curb"].strip(curb if sg > 0 else curb, uvc, "curb")
            walk = np.stack([row(W2, CURB), row(W, CURB)] if sg > 0 else [row(-W, CURB), row(-W2, CURB)], 1)
            L["sidewalk"].strip(walk, _world_uv(walk, 3.0), "sidewalk")
            outer = np.concatenate([P + Nn * (sg * W2), (z + depth)[:, None]], 1)
            sk = np.stack([outer, row(sg * W2, CURB)] if sg > 0 else [row(sg * W2, CURB), outer], 1)
            L["skirt"].strip(sk, np.stack([np.stack([ss / 3, z * 0 + depth / 3], 1), np.stack([ss / 3, z * 0 + 0.05], 1)], 1), "concrete")
            edge_u = sg * W2
    else:
        for sg in (1, -1):
            outer = np.concatenate([P + Nn * (sg * W), (z + depth)[:, None]], 1)
            sk = np.stack([outer, row(sg * W, 0)] if sg > 0 else [row(sg * W, 0), outer], 1)
            L["skirt"].strip(sk, np.stack([np.stack([ss / 3, depth / 3], 1), np.stack([ss / 3, z * 0], 1)], 1), "concrete")
    # deck underside on elevated parts
    if elev.any():
        Wd = W + side
        under = np.stack([row(-Wd, -1.7), row(Wd, -1.7)], 1)
        m = elev.copy()
        m[:-1] |= elev[1:]
        _strip_masked(L["skirt"], under, _world_uv(under, 6.0), "concrete", m)

    # boulevard planted median
    if e.cls == "boulevard":
        mh = c["median"] / 2
        for sg in (1, -1):
            pts = [row(sg * mh, 0), row(sg * mh, CURB)]
            L["curb"].strip(np.stack(pts if sg > 0 else pts[::-1], 1),
                            np.stack([np.stack([ss / 2, z * 0], 1), np.stack([ss / 2, z * 0 + 0.15], 1)], 1), "curb")
        top = np.stack([row(mh, CURB + 0.01), row(-mh, CURB + 0.01)], 1)
        L["grass"].strip(top, _world_uv(top, 4.0), "grass")

    _MASK['f'] = _marking_mask(e, idx, ss, P, z, Nn)
    markings(e, L, ss, P, z, Nn, s0, s1)
    _MASK.clear()
    barriers(e, L, idx, ss, P, z, Nn, elev, tun)
    if tun.any():
        tunnel(e, L, ss, P, z, Nn, tun)



def _strip_masked(mb, rows, uvs, mat, mask):
    """strip() but only over runs where mask is true."""
    mask = np.asarray(mask, bool)
    i = 0
    n = len(mask)
    while i < n:
        if not mask[i]:
            i += 1
            continue
        j = i
        while j < n and mask[j]:
            j += 1
        if j - i >= 2:
            mb.strip(rows[i:j], uvs[i:j], mat)
        i = j


# ------------------------------------------------------------------ markings
LINE_W = 0.15


_CUT = {}
_MASK = {}


def _marking_mask(e, idx, ss, P, z, Nn):
    """f(u) -> bool per sample: paint at lateral offset u is visible (not under/over another
    road's carriageway in a merge/diverge zone)."""
    cache = {}

    def f(u):
        key = round(u, 1)
        if key not in cache:
            m = np.ones(len(ss), bool)
            for i in range(len(ss)):
                q = P[i] + Nn[i] * u
                if idx.covering(q, z[i], e, margin=-0.3, dz=1.2):
                    m[i] = False
            cache[key] = m
        return cache[key]
    return f


def _line(L, ss, P, z, Nn, u, mat, dash=None, width=LINE_W, s_lo=None, s_hi=None):
    if s_lo is None and _CUT:
        s_lo, s_hi = _CUT["lo"], _CUT["hi"]
    if dash:
        on, off = dash
        ph = np.mod(ss - ss[0], on + off) < on
    else:
        ph = np.ones(len(ss), bool)
    if s_lo is not None:
        ph &= (ss >= s_lo) & (ss <= s_hi)
    if "f" in _MASK:
        ph &= _MASK["f"](u)
    a = np.concatenate([P + Nn * (u + width / 2), (z + 0.025)[:, None]], 1)
    b = np.concatenate([P + Nn * (u - width / 2), (z + 0.025)[:, None]], 1)
    rows = np.stack([a, b], 1)
    uv = np.zeros((len(ss), 2, 2))
    if dash:
        # resample dashes exactly so they have crisp ends
        d_rows, d_uv = [], []
        start = ss[0]
        k = 0
        while start + k * (on + off) < ss[-1]:
            t0 = start + k * (on + off)
            t1 = min(t0 + on, ss[-1])
            k += 1
            if s_lo is not None and (t0 < s_lo or t1 > s_hi):
                continue
            if "f" in _MASK:
                vis = _MASK["f"](u)
                i0, i1 = np.searchsorted(ss, t0), min(np.searchsorted(ss, t1), len(ss) - 1)
                if not vis[i0:i1 + 1].all():
                    continue
            tt = np.linspace(t0, t1, 3)
            Pp = np.stack([np.interp(tt, ss, P[:, 0]), np.interp(tt, ss, P[:, 1])], 1)
            Nq = geom.unit(np.stack([np.interp(tt, ss, Nn[:, 0]), np.interp(tt, ss, Nn[:, 1])], 1))
            zz = np.interp(tt, ss, z) + 0.025
            r = np.stack([np.concatenate([Pp + Nq * (u + width / 2), zz[:, None]], 1),
                          np.concatenate([Pp + Nq * (u - width / 2), zz[:, None]], 1)], 1)
            L["marking"].strip(r, np.zeros((3, 2, 2)), mat)
        return
    _strip_masked(L["marking"], rows, uv, mat, ph)


def markings(e, L, ss, P, z, Nn, s0, s1):
    c = CLASSES[e.cls]
    cls = e.cls
    _CUT.clear()
    if cls in URBAN:
        lo = s0 + (6.5 if getattr(e.n[0], "kind", "") == "junction" else 0.0)
        hi = s1 - (6.5 if getattr(e.n[1], "kind", "") == "junction" else 0.0)
        if hi > lo:
            _CUT.update(lo=lo, hi=hi)
    if c.get("oneway"):
        lanes, lw = c["lanes"], c["lane_w"]
        half = lanes * lw / 2
        for k in range(1, lanes):
            _line(L, ss, P, z, Nn, -half + k * lw, "paint_white", dash=(3.0, 9.0))
        _line(L, ss, P, z, Nn, half - 0.1, "paint_yellow" if cls.startswith(("fw1", "av1")) else "paint_white")
        _line(L, ss, P, z, Nn, -half + 0.1, "paint_white")
        return
    m = c["median"] / 2
    lanes, lw = c["lanes"], c["lane_w"]
    for sg in (1, -1):
        for k in range(1, lanes):
            _line(L, ss, P, z, Nn, sg * (m + k * lw), "paint_white", dash=(3.0, 9.0) if cls == "freeway" else (3.0, 6.0))
        if cls in ("freeway", "boulevard", "mountain", "rural", "industrial", "avenue"):
            _line(L, ss, P, z, Nn, sg * (m + lanes * lw + 0.1), "paint_white")
    if cls == "freeway":
        for sg in (1, -1):
            _line(L, ss, P, z, Nn, sg * (m + 0.2), "paint_yellow")
    elif cls in ("avenue", "street", "mountain"):
        for sg in (1, -1):
            _line(L, ss, P, z, Nn, sg * 0.14, "paint_yellow", width=0.12)
    elif cls in ("rural", "industrial") or cls.startswith("raceway"):
        _line(L, ss, P, z, Nn, 0.0, "paint_yellow", dash=(3.0, 6.0))
    # crosswalks + stop lines at junction approaches
    if cls in URBAN:
        Wc = hw(cls) - 0.3
        for k in (0, 1):
            nd = e.n[k]
            if getattr(nd, "kind", "") != "junction" or len(nd.edges) < 3:
                continue
            base = s0 if k == 0 else s1
            sgn = 1 if k == 0 else -1
            _saved = dict(_CUT)
            _CUT.clear()
            zebra(L, ss, P, z, Nn, base + sgn * 1.0, base + sgn * 4.0, Wc)
            _CUT.update(_saved)
            # stop line on the inbound half
            sl = base + sgn * 5.0
            i = int(np.clip(np.searchsorted(ss, sl), 0, len(ss) - 1))
            p, nrm, zz = P[i], Nn[i], z[i] + 0.025
            t = np.array([nrm[1], -nrm[0]]) * sgn * -1
            half = (1 if k == 0 else -1)
            u0, u1 = (-Wc, -0.2) if half > 0 else (0.2, Wc)
            quad = [np.r_[p + nrm * u0 - t * 0.2, zz], np.r_[p + nrm * u1 - t * 0.2, zz],
                    np.r_[p + nrm * u1 + t * 0.2, zz], np.r_[p + nrm * u0 + t * 0.2, zz]]
            L["marking"].add(quad, np.zeros((4, 2)), [(0, 3, 2, 1)] if k == 0 else [(0, 1, 2, 3)], "paint_white")


def zebra(L, ss, P, z, Nn, a, b, Wc):
    lo, hi = min(a, b), max(a, b)
    if lo < ss[0] or hi > ss[-1]:
        return
    tt = np.linspace(lo, hi, 2)
    Pp = np.stack([np.interp(tt, ss, P[:, 0]), np.interp(tt, ss, P[:, 1])], 1)
    Nq = geom.unit(np.stack([np.interp(tt, ss, Nn[:, 0]), np.interp(tt, ss, Nn[:, 1])], 1))
    zz = np.interp(tt, ss, z) + 0.026
    u = -Wc + 0.25
    while u + 0.5 < Wc:
        r = np.stack([np.concatenate([Pp + Nq * (u + 0.5), zz[:, None]], 1),
                      np.concatenate([Pp + Nq * u, zz[:, None]], 1)], 1)
        L["marking"].strip(r, np.zeros((2, 2, 2)), "paint_white")
        u += 1.1


# ------------------------------------------------------------------ barriers
JERSEY = [(0.12, 0.0), (0.12, 0.85), (-0.04, 0.85), (-0.12, 0.35), (-0.30, 0.1), (-0.30, 0.0)]


def _profile_sweep(L, ss, P, z, Nn, u0, sg, prof, mat, mask, layer="barrier"):
    """Sweep a (outward offset, height) profile along the edge on side sg."""
    rows = []
    for du, h in prof:
        rows.append(np.concatenate([P + Nn * (sg * (u0 + du)), (z + h)[:, None]], 1))
    rows = np.stack(rows if sg < 0 else rows[::-1], 1)
    m = len(prof)
    uv = np.stack([np.stack([ss / 2.0, np.full(len(ss), k / m)], 1) for k in range(m)], 1)
    _strip_masked(L[layer], rows, uv, mat, mask)


def barriers(e, L, idx, ss, P, z, Nn, elev, tun):
    c = CLASSES[e.cls]
    W = hw(e.cls)
    side = c["side"]
    n = len(ss)
    for sg in (1, -1):
        edge_u = W + side
        need = np.zeros(n, bool)
        kind = None
        if e.cls in ("freeway", "ramp") or e.cls.startswith(("fw1", "ramp")):
            need[:] = True
            kind = "jersey"
        elif e.cls in ("mountain", "rural", "industrial"):
            probe = P + Nn * (sg * (W + 6))
            drop = z - T.height(probe[:, 0], probe[:, 1])
            need = (drop > 2.5) | elev
            kind = "rail"
        else:
            need = elev.copy()
            kind = "parapet"
        need &= ~tun
        if not need.any():
            continue
        # gaps where another road joins (merges, junction pads)
        for i in range(n):
            if need[i]:
                q = P[i] + Nn[i] * (sg * (edge_u - 0.2))
                if idx.covering(q, z[i], e, margin=-0.5, dz=0.4):
                    need[i] = False
        need = _close_small_gaps(need, 3)
        if kind == "jersey":
            _profile_sweep(L, ss, P, z, Nn, edge_u, sg, JERSEY, "barrier", need)
        elif kind == "parapet":
            prof = [(0.1, -0.05), (0.1, 1.05), (-0.15, 1.05), (-0.15, 0.0)]
            _profile_sweep(L, ss, P, z + CURB, Nn, edge_u, sg, prof, "barrier", need)
        else:
            prof = [(0.35, 0.45), (0.35, 0.78), (0.25, 0.80), (0.25, 0.43)]
            _profile_sweep(L, ss, P, z, Nn, edge_u, sg, prof, "guardrail", need, layer="guardrail")
            # posts every 4 m
            for i in range(0, n, 1):
                if need[i] and int(ss[i] // 4) != int(ss[max(i - 1, 0)] // 4):
                    _post(L, P[i] + Nn[i] * (sg * (edge_u + 0.4)), z[i], Tn=np.array([Nn[i][1], -Nn[i][0]]))
    if e.cls == "freeway":
        mask = ~tun
        for i in range(n):
            if idx.covering(P[i], z[i], e, margin=0.0, dz=1.0):
                mask[i] = False
        prof = [(-0.30, 0.0), (-0.30, 0.1), (-0.12, 0.35), (-0.04, 0.85), (0.04, 0.85), (0.12, 0.35), (0.30, 0.1), (0.30, 0.0)]
        rows = np.stack([np.concatenate([P + Nn * du, (z + h)[:, None]], 1) for du, h in prof[::-1]], 1)
        uv = np.stack([np.stack([ss / 2.0, np.full(n, k / 8)], 1) for k in range(8)], 1)
        _strip_masked(L["barrier"], rows, uv, "barrier", mask)


def _close_small_gaps(m, k):
    m = m.copy()
    n = len(m)
    i = 0
    while i < n:
        if m[i]:
            i += 1
            continue
        j = i
        while j < n and not m[j]:
            j += 1
        if 0 < i and j < n and j - i <= k:
            m[i:j] = True
        i = j
    return m


def _post(L, p, z, Tn):
    s = 0.08
    nrm = np.array([-Tn[1], Tn[0]])
    corners = [p + Tn * s + nrm * s, p - Tn * s + nrm * s, p - Tn * s - nrm * s, p + Tn * s - nrm * s]
    V = [np.r_[c, z - 0.3] for c in corners] + [np.r_[c, z + 0.8] for c in corners]
    F = [(0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7), (4, 5, 6, 7)]
    L["guardrail"].add(V, np.zeros((8, 2)), F, "metal")


# ------------------------------------------------------------------ piers / tunnels
def piers(e, L, idx, ss, P, z, Nn, elev):
    W = hw(e.cls) + CLASSES[e.cls]["side"]
    spacing = 34.0 if e.cls == "freeway" else 28.0
    nxt = ss[0] + spacing * 0.5
    i = 0
    while i < len(ss):
        if ss[i] < nxt or not elev[i]:
            i += 1
            continue
        p, nrm, zz = P[i], Nn[i], z[i]
        g = float(T.height(p[0], p[1]))
        clear = zz - 1.7 - g
        if clear < 2.0:
            i += 1
            continue
        tdir = np.array([nrm[1], -nrm[0]])
        cols = [0.0] if W < 9 else [-(W - 4.0), (W - 4.0)] if W > 16 else [0.0]
        ok = True
        for u in cols:
            q = p + nrm * u
            if idx.ground_road_near(q, zz, extra=1.5):
                ok = False
        if not ok:
            i += 1
            continue
        top = zz - 1.7
        bot = min(g, T.height(p[0], p[1])) - 2.0
        if g < 0:
            bot = g - 1.0
        for u in cols:
            _box(L["pier"], p + nrm * u, tdir, nrm, 1.1 if W > 9 else 0.8, 1.1 if W > 9 else 0.8, bot, top - 1.2, "concrete")
        # cap beam
        _box(L["pier"], p, tdir, nrm, 1.0, W - 1.0, top - 1.3, top, "concrete")
        nxt = ss[i] + spacing
        i += 1


def _box(mb, c, t, nrm, ht, hn, z0, z1, mat):
    pts = [c + t * ht + nrm * hn, c - t * ht + nrm * hn, c - t * ht - nrm * hn, c + t * ht - nrm * hn]
    V = [np.r_[q, z0] for q in pts] + [np.r_[q, z1] for q in pts]
    F = [(0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7), (4, 5, 6, 7), (3, 2, 1, 0)]
    uv = [np.r_[q / 3.0] for q in pts] * 2
    mb.add(V, uv, F, mat)


def build_bents(net, L, idx, spacing=32.0):
    """Shared pier bents: at each station one cap beam spanning every elevated deck at that
    level (a widening gore deck gets one wide bent), columns every ~11 m under it."""
    decks = []
    for e in net.edges:
        if e.z is None or not e.elev.any():
            continue
        decks.append(e)
    # deck samples for lateral extent lookup
    pts = []
    for e in decks:
        for i in range(0, len(e.P), 2):
            if e.elev[i] and not e.tunnel[i]:
                pts.append((e.P[i, 0], e.P[i, 1], e.z[i], hw(e.cls) + CLASSES[e.cls]["side"], e))
    if not pts:
        return
    arr = np.array([(p[0], p[1], p[2], p[3]) for p in pts])
    cell = 25.0
    H = defaultdict(list)
    for k, (x, y, z, w) in enumerate(arr):
        H[(int(x // cell), int(y // cell))].append(k)
    placed = []          # (x, y) of bents already built
    order = sorted(decks, key=lambda e: -hw(e.cls))      # main carriageways first
    for e in order:
        s = e.trim[0] + spacing / 2
        while s < e.L - e.trim[1]:
            i = int(np.clip(np.searchsorted(e.s, s), 0, len(e.P) - 1))
            s += spacing
            if not e.elev[i] or e.tunnel[i]:
                continue
            p, zz = e.P[i], e.z[i]
            if any((p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 < (spacing * 0.6) ** 2 for q in placed[-400:]):
                continue
            t = geom.unit(e.P[min(i + 2, len(e.P) - 1)] - e.P[max(i - 2, 0)])
            n = np.array([-t[1], t[0]])
            # lateral extent: all deck samples near this cross line at the same level
            ivs = [(-hw(e.cls) - CLASSES[e.cls]["side"], hw(e.cls) + CLASSES[e.cls]["side"])]
            gx, gy = int(p[0] // cell), int(p[1] // cell)
            for dx in (-2, -1, 0, 1, 2):
                for dy in (-2, -1, 0, 1, 2):
                    for k in H.get((gx + dx, gy + dy), ()):
                        x, y, z, w = arr[k]
                        if abs(z - zz) > 2.5:
                            continue
                        v = np.array([x - p[0], y - p[1]])
                        along = float(v @ t)
                        if abs(along) > 4.0:
                            continue
                        u = float(v @ n)
                        if abs(u) > 45:
                            continue
                        ivs.append((u - w, u + w))
            # only decks that touch the one we stand on form a single structure
            ivs.sort()
            lo, hi = ivs[0]
            merged = []
            for a_, b_ in ivs[1:]:
                if a_ <= hi + 0.5:
                    hi = max(hi, b_)
                else:
                    merged.append((lo, hi))
                    lo, hi = a_, b_
            merged.append((lo, hi))
            lo, hi = next((m for m in merged if m[0] <= 0 <= m[1]), merged[0])
            g = float(T.height(p[0], p[1]))
            top = zz - 1.7
            if top - max(g, 0) < 2.5:
                continue
            bot = (g if g > 0 else g - 1.0) - 1.5
            mid = p + n * ((lo + hi) / 2)
            half = (hi - lo) / 2 - 0.8
            if ncol_hint := (hi - lo >= 12):
                _box(L["pier"], mid, t, n, 1.1, half, top - 1.4, top, "concrete")     # cap beam
            ncol = 1 if hi - lo < 12 else max(2, int(round((hi - lo) / 11.0)))
            for c in range(ncol):
                u = lo + (hi - lo) * (c + 0.5) / ncol
                q = p + n * u if ncol > 1 else mid
                if idx.ground_road_near(q, zz, extra=1.0):
                    continue
                cz = top - 1.4 if ncol > 1 else top
                _box(L["pier"], q, t, n, 0.9, 0.9, bot, cz, "concrete")
            placed.append(p)


def tunnel(e, L, ss, P, z, Nn, tun):
    W = hw(e.cls) + 0.8
    H = 7.0
    m = tun.copy()
    m[1:] |= tun[:-1]
    prof_left = [(W, 0.0), (W, H - 1.0), (W - 2.0, H), (0.0, H + 0.3)]
    rows = []
    for u, h in prof_left + [(-u, h) for u, h in prof_left[::-1][1:]]:
        rows.append(np.concatenate([P + Nn * u, (z + h)[:, None]], 1))
    rows = np.stack(rows[::-1], 1)
    uv = np.stack([np.stack([ss / 3.0, np.full(len(ss), k / 3.0)], 1) for k in range(rows.shape[1])], 1)
    _strip_masked(L["tunnel"], rows, uv, "tunnel", m)
    # ceiling light strip
    lamp = np.stack([np.concatenate([P + Nn * 0.4, (z + H + 0.25)[:, None]], 1),
                     np.concatenate([P - Nn * 0.4, (z + H + 0.25)[:, None]], 1)], 1)
    _strip_masked(L["tunnel"], lamp[:, ::-1], np.zeros((len(ss), 2, 2)), "tunnel_light", m)


# ------------------------------------------------------------------ junction pads
def _bez(a, c, b, k=8):
    t = np.linspace(0, 1, k)[:, None]
    return (1 - t) ** 2 * a + 2 * (1 - t) * t * c + t * t * b


def _fillet(A, dA, B, dB):
    r = geom.line_intersect(A, dA, B, dB)
    if r is not None and r[0] < -0.5 and r[1] < -0.5 and abs(r[0]) < 120 and abs(r[1]) < 120:
        X = A + dA * r[0]
        return _bez(A, X, B)
    return np.stack([A, B])


def build_transition(nd, L):
    """Two roads meeting end to end (class change or bend): loft between their end sections."""
    ends = []
    for e, k in nd.edges:
        if e.L < 0.5:
            continue
        s = e.trim[k] if k == 0 else e.L - e.trim[k]
        p = np.array([np.interp(s, e.s, e.P[:, 0]), np.interp(s, e.s, e.P[:, 1])])
        d = _tangent_at(e, np.array([s]))[0] * (1 if k == 0 else -1)   # pointing away from the node
        ends.append(dict(p=p, d=d, z=float(np.interp(s, e.s, e.z)), W=hw(e.cls), S=CLASSES[e.cls]["side"]))
    if len(ends) != 2:
        return
    A, B = ends
    L_ = max(np.linalg.norm(B["p"] - A["p"]), 1.0)
    t = np.linspace(0, 1, max(6, int(L_ / 3)))
    h00, h10, h01, h11 = 2 * t**3 - 3 * t**2 + 1, t**3 - 2 * t**2 + t, -2 * t**3 + 3 * t**2, t**3 - t**2
    m0, m1 = -A["d"] * L_, B["d"] * L_
    P = h00[:, None] * A["p"] + h10[:, None] * m0 + h01[:, None] * B["p"] + h11[:, None] * m1
    Tn = geom.tangents(P)
    Nn = geom.left_normal(Tn)
    # end sections must be exactly the arms' own sections, or slivers open along the seams
    for i, dd in ((0, -A["d"]), (-1, B["d"])):
        n_ = geom.left_normal(np.asarray(dd, float)[None])[0]
        Nn[i] = n_ if np.dot(n_, Nn[i]) >= 0 else -n_
    ts = t * t * (3 - 2 * t)
    W = A["W"] + (B["W"] - A["W"]) * ts
    S = A["S"] + (B["S"] - A["S"]) * ts
    z = A["z"] + (B["z"] - A["z"]) * ts

    def row(u, dz):
        return np.concatenate([P + Nn * u[:, None], (z + dz)[:, None]], 1)

    # left side of the loft is A's right side (A points away from the node), so mirror
    rows = np.stack([row(W, 0), row(-W, 0)], 1)
    L["asphalt"].strip(rows, _world_uv(rows, 8.0), "asphalt")
    for sg in (1, -1):
        if S.max() > 0.05:
            walk = np.stack([row(sg * (W + S), CURB), row(sg * W, CURB)] if sg > 0 else
                            [row(sg * W, CURB), row(sg * (W + S), CURB)], 1)
            L["sidewalk"].strip(walk, _world_uv(walk, 3.0), "sidewalk")
            curb = np.stack([row(sg * W, CURB), row(sg * W, 0)] if sg > 0 else [row(sg * W, 0), row(sg * W, CURB)], 1)
            L["curb"].strip(curb, np.zeros((len(t), 2, 2)), "curb")
        out = row(sg * (W + S), -1.3)
        top = row(sg * (W + S), CURB * (S > 0.05))
        sk = np.stack([out, top] if sg > 0 else [top, out], 1)
        L["skirt"].strip(sk, np.zeros((len(t), 2, 2)), "concrete")


def build_pad(nd, L):
    arms = []
    for e, k in nd.edges:
        if e.L < 0.5:
            continue
        t = e.trim[k]
        s = t if k == 0 else e.L - t
        p = np.array([np.interp(s, e.s, e.P[:, 0]), np.interp(s, e.s, e.P[:, 1])])
        d = _tangent_at(e, np.array([s]))[0] * (1 if k == 0 else -1)
        arms.append(dict(p=p, d=d, ang=math.atan2(*(p - nd.pos)[::-1]) if np.linalg.norm(p - nd.pos) > 0.5 else math.atan2(d[1], d[0]),
                         W=hw(e.cls), S=CLASSES[e.cls]["side"]))
    if len(arms) < 2:
        return
    arms.sort(key=lambda a: a["ang"])
    zc = nd.z
    poly = []
    corners = []
    for i, A in enumerate(arms):
        B = arms[(i + 1) % len(arms)]
        nA = geom.left_normal(A["d"])
        nB = geom.left_normal(B["d"])
        RA, LA = A["p"] - nA * A["W"], A["p"] + nA * A["W"]
        RB = B["p"] - nB * B["W"]
        curve = _fillet(LA, A["d"], RB, B["d"])
        poly.append(RA)
        poly.extend(curve)
        if A["S"] > 0 or B["S"] > 0:
            LAo = A["p"] + nA * (A["W"] + A["S"])
            RBo = B["p"] - nB * (B["W"] + B["S"])
            outer = _fillet(LAo, A["d"], RBo, B["d"])
            corners.append((curve, outer))
    poly = np.array(poly)
    G = getattr(nd, "grad", np.zeros(2))

    def zp(q):
        return zc + float(np.dot(np.asarray(q) - nd.pos, G))

    V = [np.r_[nd.pos, zc]] + [np.r_[q, zp(q)] for q in poly]
    F = [(0, i + 1, (i + 1) % len(poly) + 1) for i in range(len(poly))]
    L["asphalt"].add(V, _world_uv(np.array(V), 8.0), F, "asphalt")
    for inner, outer in corners:
        k = max(len(inner), len(outer))
        inner = _resample_n(inner, k)
        outer = _resample_n(outer, k)
        zi = np.array([zp(q) for q in inner])
        zo = np.array([zp(q) for q in outer])
        top_i = np.c_[inner, zi + CURB]
        top_o = np.c_[outer, zo + CURB]
        walk = np.stack([top_i, top_o], 1)
        L["sidewalk"].strip(walk, _world_uv(walk, 3.0), "sidewalk")
        face = np.stack([np.c_[inner, zi], top_i], 1)
        L["curb"].strip(face, np.zeros((k, 2, 2)), "curb")
        sk = np.stack([top_o, np.c_[outer, zo - 1.3]], 1)
        L["skirt"].strip(sk, np.zeros((k, 2, 2)), "concrete")


def _resample_n(C, k):
    C = np.asarray(C, float)
    s = geom.cum_length(C)
    if s[-1] < 1e-6:
        return np.repeat(C[:1], k, 0)
    t = np.linspace(0, s[-1], k)
    return np.stack([np.interp(t, s, C[:, 0]), np.interp(t, s, C[:, 1])], 1)


def build_all(net, log=print, region=None):
    idx = RoadIndex(net)
    L = Layers()

    def inside(P):
        if region is None:
            return True
        x0, y0, x1, y1 = region
        return bool(((P[:, 0] >= x0) & (P[:, 0] <= x1) & (P[:, 1] >= y0) & (P[:, 1] <= y1)).any())

    for e in net.edges:
        if e.z is None or not inside(e.P):
            continue
        build_edge(e, L, idx)
    build_bents(net, L, idx)
    for nd in net.nodes:
        if nd.z is None or not inside(nd.pos[None]):
            continue
        if getattr(nd, "kind", "") == "junction":
            build_pad(nd, L)
        elif getattr(nd, "kind", "") == "transition":
            build_transition(nd, L)
    log("roadmesh: " + ", ".join(f"{k}:{len(v.F)}" for k, v in L.items()))
    return L
