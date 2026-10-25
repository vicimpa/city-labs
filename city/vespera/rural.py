"""Countryside road web: loops every few hundred metres between the districts.

Junction points are scattered by Poisson-disk sampling over open land, joined
by a relative-neighbourhood graph (plus a few extra chords for loops) together
with the dangling street ends of the districts, and every link is routed over
the terrain by A*. The result is the dense, curvy, loop-rich rural mesh the
reference maps have between their urban blobs.
"""
import math
from collections import defaultdict

import numpy as np

from . import geom, paths, terrain as T, world as W


def poisson(mask_fn, bbox, r, seed=3, tries=30):
    rng = np.random.default_rng(seed)
    x0, y0, x1, y1 = bbox
    cell = r / math.sqrt(2)
    grid = {}
    pts = []
    active = []
    for _ in range(400):
        p = np.array([rng.uniform(x0, x1), rng.uniform(y0, y1)])
        if mask_fn(p):
            pts.append(p); active.append(p)
            grid[(int(p[0] // cell), int(p[1] // cell))] = p
            break
    while active:
        k = rng.integers(len(active))
        base = active[k]
        found = False
        for _ in range(tries):
            a = rng.uniform(0, 2 * math.pi)
            d = rng.uniform(r, 2 * r)
            q = base + d * np.array([math.cos(a), math.sin(a)])
            if not (x0 <= q[0] <= x1 and y0 <= q[1] <= y1) or not mask_fn(q):
                continue
            gx, gy = int(q[0] // cell), int(q[1] // cell)
            ok = True
            for dx in range(-2, 3):
                for dy in range(-2, 3):
                    o = grid.get((gx + dx, gy + dy))
                    if o is not None and np.hypot(*(o - q)) < r:
                        ok = False
            if ok:
                pts.append(q); active.append(q)
                grid[(gx, gy)] = q
                found = True
                break
        if not found:
            active.pop(k)
    return pts


def rng_graph(P, max_len):
    """Relative neighbourhood graph (connected, sparse, planar-ish)."""
    P = np.asarray(P)
    n = len(P)
    D = np.hypot(P[:, None, 0] - P[None, :, 0], P[:, None, 1] - P[None, :, 1])
    E = []
    for i in range(n):
        for j in range(i + 1, n):
            d = D[i, j]
            if d > max_len:
                continue
            if np.any(np.maximum(D[i], D[j]) < d - 1e-6):
                continue
            E.append((i, j))
    return E, D


def build(existing_roads, district_polys, freeway_block, log=print, spacing=750.0, seed=5):
    """existing_roads: list of Road (split ones are anchor sources)."""
    # dangling street ends become anchors so the countryside closes the city's dead ends
    hashp = {}
    cell = 40.0
    for r in existing_roads:
        for p in r.P[::2]:
            hashp.setdefault((int(p[0] // cell), int(p[1] // cell)), []).append((id(r), p))

    def near_other(p, rid, rad):
        gx, gy = int(p[0] // cell), int(p[1] // cell)
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for oid, q in hashp.get((gx + dx, gy + dy), ()):
                    if oid != rid and np.hypot(*(q - p)) < rad:
                        return True
        return False

    def near_any(p, rad):
        k = int(math.ceil(rad / cell))
        gx, gy = int(p[0] // cell), int(p[1] // cell)
        for dx in range(-k, k + 1):
            for dy in range(-k, k + 1):
                for _, q in hashp.get((gx + dx, gy + dy), ()):
                    if np.hypot(*(q - p)) < rad:
                        return True
        return False

    anchors = []
    for r in existing_roads:
        if not r.split or r.closed or r.cls == "freeway":
            continue
        for end in (0, -1):
            p = r.P[end]
            if not near_other(p, id(r), 32.0):
                anchors.append(p.copy())

    polys = [np.asarray(p, float) for p in district_polys]

    def in_district(p):
        return any(geom.point_in_poly(np.array([p[0]]), np.array([p[1]]), q)[0] for q in polys)

    def open_land(p):
        if T.coast_dist(p[0], p[1]) < 60:
            return False
        if max(abs(p[0]) * 0.97, p[1]) > W.PLAY - 280:
            return False
        if T.slope(p[0], p[1]) > 0.5:
            return False
        if freeway_block.near(p, 70.0):
            return False
        if near_any(p, 110.0):
            return False
        d, _, _, _ = geom.project_to_polyline(T.river_path()[::3], p)
        return d > 90

    E_ = W.PLAY
    pois = poisson(open_land, (-E_, -E_, E_, E_), spacing, seed=seed)
    pts = [np.asarray(p) for p in pois] + anchors
    is_anchor = [False] * len(pois) + [True] * len(anchors)
    log(f"rural: {len(pois)} junction points, {len(anchors)} street ends")
    edges, D = rng_graph(pts, spacing * 1.9)
    # extra chords so the web has loops, not a tree
    rng = np.random.default_rng(seed)
    have = set(edges)
    n = len(pts)
    for i in range(n):
        if is_anchor[i]:
            continue
        order = np.argsort(D[i])
        for j in order[1:4]:
            e = (min(i, j), max(i, j))
            if e not in have and D[i, j] < spacing * 1.5 and rng.random() < 0.2:
                edges.append(e)
                have.add(e)
    raw = []
    for i, j in edges:
        a, b = pts[i], pts[j]
        if is_anchor[i] and is_anchor[j]:
            continue
        mid = (a + b) / 2
        if in_district(mid) and (is_anchor[i] or is_anchor[j]):
            continue
        try:
            P = paths.route(tuple(a), tuple(b), max_grade=0.10, wiggle=0.35, seed=i * 131 + j,
                            avoid_roads=True)
        except RuntimeError:
            continue
        L = geom.cum_length(P)[-1]
        if L > 2.3 * np.hypot(*(b - a)) + 200:
            continue
        P[0], P[-1] = a, b
        raw.append([i, j, P])
        paths.add_existing(P, penalty=True)

    # chain links through junction points: the straightest pair runs through, others T in
    inc = defaultdict(list)
    for k, (i, j, P) in enumerate(raw):
        inc[i].append((k, 0))
        inc[j].append((k, 1))

    def out_dir(k, end):
        P = raw[k][2]
        Q = P if end == 0 else P[::-1]
        s = geom.cum_length(Q)
        q = Q[min(np.searchsorted(s, 60.0), len(Q) - 1)]
        return geom.unit(q - Q[0])

    pair = {}
    for pnt, lst in inc.items():
        if is_anchor[pnt] or len(lst) < 2:
            continue
        best = None
        for x in range(len(lst)):
            for y in range(x + 1, len(lst)):
                c = float(np.dot(out_dir(*lst[x]), out_dir(*lst[y])))
                if best is None or c < best[0]:
                    best = (c, lst[x], lst[y])
        if best[0] < -0.35:              # within ~70 degrees of straight
            pair[best[1]] = best[2]
            pair[best[2]] = best[1]
    used = set()
    chains = []
    for k in range(len(raw)):
        if k in used:
            continue
        # walk back to a chain start
        cur, end = k, 0
        seen = {k}
        while (cur, end) in pair:
            nk, ne = pair[(cur, end)]
            if nk in seen:
                break
            seen.add(nk)
            cur, end = nk, 1 - ne
        # now walk forward from (cur, end) = start end of chain
        seq = []
        c, e = cur, end
        while True:
            used.add(c)
            P = raw[c][2] if e == 0 else raw[c][2][::-1]
            seq.append(P if not seq else P[1:])
            far = (c, 1 - e)
            if far not in pair:
                break
            c, e = pair[far]
            if c in used:
                break
        chains.append(np.vstack(seq))
    flowed = [paths.flow(C, eps=26.0) for C in chains]
    # drop near-duplicates that mostly run alongside an existing road
    occ = {}
    cell2 = 30.0

    def occ_add(P):
        for q in P[::2]:
            occ.setdefault((int(q[0] // cell2), int(q[1] // cell2)), []).append(q)

    def near_frac(P, rad=60.0):
        hits = 0
        Q = P[::3]
        for q in Q:
            gx, gy = int(q[0] // cell2), int(q[1] // cell2)
            found = False
            for dx in (-2, -1, 0, 1, 2):
                for dy in (-2, -1, 0, 1, 2):
                    for o in occ.get((gx + dx, gy + dy), ()):
                        if (o[0] - q[0]) ** 2 + (o[1] - q[1]) ** 2 < rad * rad:
                            found = True
                            break
                    if found:
                        break
                if found:
                    break
            hits += found
        return hits / max(len(Q), 1)

    for r in existing_roads:
        occ_add(r.P)
    kept = []
    for D in sorted(flowed, key=lambda D: -geom.cum_length(D)[-1]):
        # ignore the first/last 80 m: they legitimately approach other roads
        s_ = geom.cum_length(D)
        core = D[(s_ > 80) & (s_ < s_[-1] - 80)]
        if len(core) > 4 and near_frac(core) > 0.4:
            continue
        kept.append(D)
        occ_add(D)
    flowed = kept
    # T-approach: chain ends that stop on another chain meet it square
    out = []
    for k, D in enumerate(flowed):
        for end in (0, 1):
            p = D[0] if end == 0 else D[-1]
            for m, H in enumerate(flowed):
                if m == k:
                    continue
                d, _, _, _ = geom.project_to_polyline(H, p)
                if d < 30:
                    D = paths.t_approach(D if end == 1 else D[::-1], H)
                    D = D if end == 1 else D[::-1]
                    break
        out.append(D)
    log(f"rural: {len(raw)} links -> {len(out)} flowing roads")
    return out
