"""Terrain-following rural / mountain roads by A* over a cost grid.

Steep ground is expensive (switchbacks appear by themselves on slopes),
water is forbidden, existing roads are slightly cheaper so routes merge.
The jagged grid path is smoothed, simplified and filleted afterwards.
"""
import heapq
import math

import numpy as np

from . import geom, terrain as T, world as W

CELL = 14.0
_cache = {}


def _grid():
    if "h" in _cache:
        return _cache
    E = W.EXTENT - 200
    xs = np.arange(-E, E + CELL, CELL)
    X, Y = np.meshgrid(xs, xs)
    h = T.height(X, Y)
    sd = T.coast_dist(X, Y)
    R = T.river_path()[::4]
    dr, _ = geom.dist_to_polyline_grid(X, Y, R)
    river = dr < 55
    blocked = ((sd < 12) | (h < 0.5)) & ~river
    _cache.update(xs=xs, h=h, blocked=blocked, river=river, bonus=np.zeros_like(h), avoid=np.zeros_like(h, bool),
                  pen=np.zeros_like(h, bool))
    _cache["label"] = _components(blocked)
    return _cache


def _components(blocked):
    """Label 4-connected passable regions (mainland, islands)."""
    from collections import deque
    lab = np.zeros(blocked.shape, np.int32)
    n0, n1 = blocked.shape
    cur = 0
    for i0 in range(0, n0, 8):
        for j0 in range(0, n1, 8):
            if blocked[i0, j0] or lab[i0, j0]:
                continue
            cur += 1
            q = deque([(i0, j0)])
            lab[i0, j0] = cur
            while q:
                a, b = q.popleft()
                for x, y in ((a + 1, b), (a - 1, b), (a, b + 1), (a, b - 1)):
                    if 0 <= x < n0 and 0 <= y < n1 and not blocked[x, y] and not lab[x, y]:
                        lab[x, y] = cur
                        q.append((x, y))
    return lab


def add_existing(P, bonus=0.0, avoid=False, radius=1, penalty=False):
    """Mark cells along an existing road: forbidden (avoid), or expensive to run
    alongside (penalty, keeps new roads from duplicating old ones)."""
    if penalty:
        radius = max(radius, 2)
    g = _grid()
    xs = g["xs"]
    for p in np.asarray(P):
        j = int(round((p[0] - xs[0]) / CELL))
        i = int(round((p[1] - xs[0]) / CELL))
        for di in range(-radius, radius + 1):
            for dj in range(-radius, radius + 1):
                ii, jj = i + di, j + dj
                if 0 <= ii < len(xs) and 0 <= jj < len(xs):
                    if avoid:
                        g["avoid"][ii, jj] = True
                    elif penalty:
                        g["pen"][ii, jj] = True
                    else:
                        g["bonus"][ii, jj] = max(g["bonus"][ii, jj], bonus)


DIRS = [(1, 0), (0, 1), (-1, 0), (0, -1), (1, 1), (-1, 1), (-1, -1), (1, -1),
        (2, 1), (1, 2), (-1, 2), (-2, 1), (-2, -1), (-1, -2), (1, -2), (2, -1)]


def route(a, b, max_grade=0.10, wiggle=0.0, bridge_ok=False, seed=0, avoid_roads=True):
    """A* from point a to b. Returns dense smooth polyline (Nx2)."""
    g = _grid()
    xs, h, blocked = g["xs"], g["h"], g["blocked"]
    n = len(xs)
    if "jit" not in g:
        nz = T.Noise(99, 16)
        X, Y = np.meshgrid(xs, xs)
        g["jit"] = (nz.fbm(X, Y, 1 / 500.0, 3) * 0.5 + 0.5).astype(np.float32)
    rng = np.random.default_rng(seed)
    oi, oj = (int(v) for v in rng.integers(0, n, 2))
    jit = g["jit"]

    def idx(p):
        return (int(round((p[1] - xs[0]) / CELL)), int(round((p[0] - xs[0]) / CELL)))

    want = [None]

    def valid(c):
        i, j = c
        if not (0 <= i < n and 0 <= j < n) or blocked[i, j] or g["avoid"][i, j]:
            return False
        return want[0] is None or g["label"][i, j] == want[0]

    def snap(c):
        if valid(c):
            return c
        for r in range(1, 40):
            for di in range(-r, r + 1):
                for dj in (-r, r) if abs(di) != r else range(-r, r + 1):
                    if valid((c[0] + di, c[1] + dj)):
                        return (c[0] + di, c[1] + dj)
        return c

    s = snap(idx(a))
    want[0] = g["label"][s]
    t = snap(idx(b))
    margin = max(45, int(0.45 * math.hypot(s[0] - t[0], s[1] - t[1])))
    wi0, wi1 = min(s[0], t[0]) - margin, max(s[0], t[0]) + margin
    wj0, wj1 = min(s[1], t[1]) - margin, max(s[1], t[1]) + margin
    INF = 1e18
    best = {s: 0.0}
    came = {}
    pq = [(0.0, s)]
    ti, tj = t
    while pq:
        f, cur = heapq.heappop(pq)
        if cur == t:
            break
        ci, cj = cur
        gc = best[cur]
        if f - math.hypot(ci - ti, cj - tj) * CELL > gc + 1e-6:
            continue
        hc = h[ci, cj]
        for dj, di in DIRS:
            ni, nj = ci + di, cj + dj
            if not (wi0 <= ni <= wi1 and wj0 <= nj <= wj1 and 0 <= ni < n and 0 <= nj < n):
                continue
            if g["avoid"][ni, nj] and (ni, nj) != t:
                continue
            if blocked[ni, nj] and not bridge_ok and (ni, nj) != t:
                continue
            L = math.hypot(di, dj) * CELL
            # intermediate cell for knight moves must be passable
            if abs(di) + abs(dj) == 3:
                mi, mj = ci + (di // 2 if abs(di) == 2 else 0), cj + (dj // 2 if abs(dj) == 2 else 0)
                if blocked[mi, mj] and not bridge_ok:
                    continue
            gr = abs(h[ni, nj] - hc) / L
            c = L * (1.0 + 30.0 * gr * gr + (400.0 * (gr - max_grade) ** 2 if gr > max_grade else 0.0))
            if gr > max_grade * 1.6:
                c *= 40.0
            if blocked[ni, nj]:
                c *= 6.0
            if g["river"][ni, nj]:
                c *= 10.0
                gr = 0.0
            c *= 1.0 - g["bonus"][ni, nj]
            if wiggle:
                c *= 1.0 + wiggle * jit[(ni + oi) % n, (nj + oj) % n]
            if avoid_roads and g["pen"][ni, nj] and abs(ni - s[0]) + abs(nj - s[1]) > 6 and abs(ni - ti) + abs(nj - tj) > 6:
                c *= 3.5
            ng = gc + c
            if ng < best.get((ni, nj), INF):
                best[(ni, nj)] = ng
                came[(ni, nj)] = cur
                heapq.heappush(pq, (ng + math.hypot(ni - ti, nj - tj) * CELL, (ni, nj)))
    if t not in came:
        raise RuntimeError(f"no route {a} -> {b}")
    path = [t]
    while path[-1] != s:
        path.append(came[path[-1]])
    path.reverse()
    P = np.array([[xs[j], xs[i]] for i, j in path], float)
    return P


def smooth(P, radius=35.0, eps=6.0, spacing=4.0):
    """Turn a grid path into a drivable curve: smooth, simplify, fillet."""
    P, _, s = geom.resample(np.asarray(P, float), 7.0)
    for _ in range(2):
        Q = P.copy()
        Q[1:-1, 0] = geom.gaussian_smooth(P[:, 0], s, 12.0)[1:-1]
        Q[1:-1, 1] = geom.gaussian_smooth(P[:, 1], s, 12.0)[1:-1]
        P = Q
    keep = rdp(P, eps)
    C = P[keep]
    D, U = geom.fillet_path(C, [radius] * len(C))
    D, _, _ = geom.resample(D, spacing)
    return D


def rdp(P, eps):
    keep = np.zeros(len(P), bool)
    keep[0] = keep[-1] = True
    stack = [(0, len(P) - 1)]
    while stack:
        a, b = stack.pop()
        if b <= a + 1:
            continue
        ab = P[b] - P[a]
        L = np.linalg.norm(ab) + 1e-9
        seg = P[a + 1:b] - P[a]
        d = np.abs(seg[:, 0] * ab[1] - seg[:, 1] * ab[0]) / L
        k = int(np.argmax(d))
        if d[k] > eps:
            m = a + 1 + k
            keep[m] = True
            stack += [(a, m), (m, b)]
    return np.flatnonzero(keep)


def despike(P, close=30.0, min_gap=90.0):
    """Cut out out-and-back detours: where the path returns within `close` metres of a
    point it passed at least `min_gap` metres earlier, skip the loop between them."""
    P, _, s = geom.resample(np.asarray(P, float), 6.0)
    out = [0]
    i = 0
    n = len(P)
    while i < n - 1:
        j_far = None
        lo = np.searchsorted(s, s[i] + min_gap)
        if lo < n:
            d = np.hypot(P[lo:, 0] - P[i, 0], P[lo:, 1] - P[i, 1])
            hit = np.flatnonzero(d < close)
            if len(hit):
                j_far = lo + int(hit[-1])
        i = j_far if j_far is not None else i + 1
        out.append(i)
    return P[sorted(set(out))]


def flow(P, eps=24.0, sigma=14.0, relax=4.0, spacing=4.0, water_check=True):
    """Grid path -> flowing road: smooth, keep a few control points, spline through them.
    Falls back to tighter control if the curve would cut into water."""
    P = despike(P)
    P, _, s = geom.resample(np.asarray(P, float), 6.0)
    if len(P) < 4:
        D, _, _ = geom.resample(P, spacing)
        return D
    Q = P.copy()
    for _ in range(2):
        Q[1:-1, 0] = geom.gaussian_smooth(Q[:, 0], s, sigma)[1:-1]
        Q[1:-1, 1] = geom.gaussian_smooth(Q[:, 1], s, sigma)[1:-1]
    for e in (eps, eps * 0.6, eps * 0.35):
        C = Q[rdp(Q, e)]
        D, _ = geom.catmull_rom(C, spacing)
        if relax:
            D[1:-1] = geom.relax_to(D, iters=12, tether=relax)[1:-1]
        if not water_check or (T.coast_dist(D[:, 0], D[:, 1]) > 4).all() or \
                (T.coast_dist(D[:, 0], D[:, 1]) > 4).mean() >= (T.coast_dist(Q[:, 0], Q[:, 1]) > 4).mean():
            return D
    return D


def t_approach(P, host_P, back=40.0, spacing=4.0):
    """Re-shape the end of P (which ends on host_P) so it meets the host at a right angle."""
    P = np.asarray(P, float)
    end = P[-1]
    d, i, t, q = geom.project_to_polyline(host_P, end)
    tan = host_P[min(i + 1, len(host_P) - 1)] - host_P[i]
    tan = tan / (np.linalg.norm(tan) + 1e-9)
    nrm = np.array([-tan[1], tan[0]])
    s = geom.cum_length(P)
    if s[-1] < back * 2.5:
        return P
    if np.dot(P[-1] - P[np.searchsorted(s, s[-1] - back)], nrm) < 0:
        nrm = -nrm
    approach = q - nrm * back
    keep = P[s < s[-1] - back * 2.2]
    C = np.vstack([keep[::max(1, len(keep) // 12)], keep[-1:], approach[None], q[None]])
    D, _ = geom.catmull_rom(C, spacing)
    return D
