"""Automatic topology repair of the road network (run before finalize).

Detects and fixes, iterating until clean:
  G1 duplicate   — two unconnected edges running side by side
  G2 sliver      — tiny or very thin city blocks (planar faces)
  G3 loop        — short loops / hooks hanging off one node
  G4 gap         — a dead end that stops next to another road
"""
import math
from collections import defaultdict

import numpy as np

from . import geom
from .network import CLASSES, hwt

PROTECT = ("fw1", "ramp", "freeway", "raceway", "runway")


def _protected(e):
    return e.cls.startswith(PROTECT) or not e.road.split


def _remove(net, e):
    if e not in net.edges:
        return
    net.edges.remove(e)
    for nd in e.n:
        nd.edges = [(x, k) for x, k in nd.edges if x is not e]


def _cleanup(net):
    net._remove_dead_ends()
    net._collapse_short(14.0)
    net._compact()


def _minor(a, b):
    """Of two edges, the one to delete: lower class, then shorter."""
    ka = (CLASSES[a.cls]["prio"], a.L)
    kb = (CLASSES[b.cls]["prio"], b.L)
    return a if ka <= kb else b


# ---------------------------------------------------------------- G1 duplicates
def find_duplicates(net, min_run=60.0):
    cell = 30.0
    H = defaultdict(list)
    for e in net.edges:
        for i in range(0, len(e.P), 2):
            H[(int(e.P[i, 0] // cell), int(e.P[i, 1] // cell))].append((e, i))
    found = {}
    for e in net.edges:
        if e.L < 20:
            continue
        hits = defaultdict(int)
        for i in range(0, len(e.P), 2):
            p = e.P[i]
            gx, gy = int(p[0] // cell), int(p[1] // cell)
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    for f, j in H.get((gx + dx, gy + dy), ()):
                        if f is e or f in hits and hits[f] < 0:
                            continue
                        lim = hwt(e.cls) + hwt(f.cls) + 4.0
                        te = e.P[min(i + 1, len(e.P) - 1)] - e.P[max(i - 1, 0)]
                        tf = f.P[min(j + 1, len(f.P) - 1)] - f.P[max(j - 1, 0)]
                        c = abs(float(np.dot(geom.unit(te), geom.unit(tf))))
                        if c < 0.7:
                            continue        # a crossing, not a road running on top of another
                        if not _protected(e) and not _protected(f) and c > 0.9:
                            lim = hwt(e.cls) + hwt(f.cls) + 34.0     # thinner than a city block
                        if np.hypot(*(f.P[j] - p)) < lim:
                            # ignore the bits next to a shared node (normal at junctions)
                            if any(np.hypot(*(p - nd.pos)) < 45 for nd in e.n if nd in f.n):
                                continue
                            if abs(float(e.z[i] - f.z[j])) > 5.0 if (e.z is not None and f.z is not None) else False:
                                continue
                            hits[f] += 1
        for f, c in hits.items():
            if c * 8.0 / 2 >= min_run:          # every 2nd sample (4 m) counts 8 m / 2
                key = (min(id(e), id(f)), max(id(e), id(f)))
                found[key] = (e, f)
    return list(found.values())


# ---------------------------------------------------------------- G2 slivers (planar faces)
def faces(net):
    half = {}
    out = defaultdict(list)
    for e in net.edges:
        if e.n[0] is e.n[1] or _protected(e):
            continue
        for k in (0, 1):
            nd = e.n[k]
            P = e.P if k == 0 else e.P[::-1]
            q = P[min(3, len(P) - 1)]
            ang = math.atan2(q[1] - nd.pos[1], q[0] - nd.pos[0])
            out[nd.idx].append((ang, e, k))
    for v in out.values():
        v.sort(key=lambda a: a[0])
    used = set()
    res = []
    for nd_idx, lst in out.items():
        for ang, e, k in lst:
            if (id(e), k) in used:
                continue
            poly, cyc, cur = [], [], (e, k)
            ok = True
            for _ in range(200):
                ce, ck = cur
                if (id(ce), ck) in used:
                    break
                used.add((id(ce), ck))
                cyc.append(ce)
                P = ce.P if ck == 0 else ce.P[::-1]
                poly.append(P[:-1])
                nxt = ce.n[1 - ck]
                arr = out.get(nxt.idx, [])
                # arriving direction, take the next edge clockwise (keeps the face on the left)
                q = P[max(-4, -len(P))]
                back = math.atan2(q[1] - nxt.pos[1], q[0] - nxt.pos[0])
                cand = sorted(arr, key=lambda a: (back - a[0]) % (2 * math.pi))
                cand = [c for c in cand if not (c[1] is ce and c[2] == 1 - ck)] or cand
                _, ne, nk = cand[0]
                cur = (ne, nk)
                if cur == (e, k):
                    break
            else:
                ok = False
            if ok and poly:
                Q = np.vstack(poly)
                A = geom.poly_area(Q)
                if A > 0:
                    per = float(np.sum(np.linalg.norm(np.diff(np.vstack([Q, Q[:1]]), axis=0), axis=1)))
                    res.append((A, per, cyc, Q))
    return res


def find_slivers(net, min_area=6000.0, min_width=28.0):
    out = []
    for A, per, cyc, Q in faces(net):
        width = 2 * A / max(per, 1e-6)          # mean width of the block
        if A < min_area or width < min_width:
            if A > 4e6:
                continue
            out.append((A, width, cyc, Q))
    return out


# ---------------------------------------------------------------- G3 short loops
def find_loops(net, max_len=260.0):
    res = []
    for e in net.edges:
        if e.n[0] is e.n[1] and e.L < max_len and not _protected(e):
            res.append(e)
    # two edges between the same pair of nodes (a lens) — the shorter is redundant
    pair = defaultdict(list)
    for e in net.edges:
        if e.n[0] is not e.n[1]:
            pair[tuple(sorted((e.n[0].idx, e.n[1].idx)))].append(e)
    for lst in pair.values():
        if len(lst) > 1:
            lst.sort(key=lambda x: x.L)
            res += [x for x in lst[1:] if not _protected(x)] or ([lst[0]] if not _protected(lst[0]) else [])
    return res


# ---------------------------------------------------------------- G4 gaps
def find_gaps(net, reach=60.0):
    res = []
    for nd in net.nodes:
        if len(nd.edges) != 1 or nd.free:
            continue
        e, k = nd.edges[0]
        if _protected(e):
            continue
        best = None
        for f in net.edges:
            if f is e:
                continue
            d, i, t, q = geom.project_to_polyline(f.P, nd.pos)
            if d < reach and (best is None or d < best[0]):
                best = (d, f, q)
        if best:
            res.append((nd, e, best))
    return res


# ---------------------------------------------------------------- G5 crowded junctions
def find_crowded(net):
    """Two junctions so close that their pads touch."""
    res = []
    for e in net.edges:
        a, b = e.n
        if a is b or _protected(e) or len(a.edges) < 3 or len(b.edges) < 3:
            continue
        need = max(hwt(x.cls) for x, _ in a.edges) + max(hwt(x.cls) for x, _ in b.edges) + 30.0
        if e.L < need:
            res.append(e)
    return res


# ---------------------------------------------------------------- G6 U-bends
def find_ubends(net, window=170.0, max_turn=110.0):
    """City streets that turn back on themselves (hooks, U-bends)."""
    res = []
    for e in net.edges:
        if _protected(e) or e.cls in ("mountain",) or len(e.P) < 6:
            continue
        d = np.diff(e.P, axis=0)
        h = np.degrees(np.unwrap(np.arctan2(d[:, 1], d[:, 0])))
        s = e.s[:-1]
        j = 0
        for i in range(len(h)):
            while s[i] - s[j] > window:
                j += 1
            if np.ptp(h[j:i + 1]) > max_turn:
                res.append(e)
                break
    return res


# ---------------------------------------------------------------- helpers
def _connected_without(net, victim, a, b):
    """Is node b still reachable from node a if edge `victim` is removed?"""
    seen = {a.idx}
    st = [a]
    while st:
        u = st.pop()
        if u is b:
            return True
        for x, k in u.edges:
            if x is victim:
                continue
            v = x.n[1 - k]
            if v.idx not in seen:
                seen.add(v.idx)
                st.append(v)
    return False


def _safe_remove(net, e):
    if e in net.edges and _connected_without(net, e, e.n[0], e.n[1]):
        _remove(net, e)
        return True
    return False


# ---------------------------------------------------------------- G7 access spacing on arterials
SPACING_MIN = {"boulevard": 200.0, "avenue": 160.0, "street": 90.0, "lane": 70.0, "industrial": 120.0, "rural": 150.0}


def find_access(net):
    """Arterial stretches between two junctions shorter than the access-spacing minimum."""
    res = []
    for e in net.edges:
        need = SPACING_MIN.get(e.cls)
        a, b = e.n
        if not need or a is b or _protected(e) or len(a.edges) < 3 or len(b.edges) < 3:
            continue
        if e.L < need:
            res.append(e)
    return res


def fix_access(net, e):
    """Drop the weakest side street at one end of a too-short arterial stretch."""
    pr = CLASSES[e.cls]["prio"]
    cands = []
    for nd in e.n:
        for x, k in nd.edges:
            if x is e or _protected(x) or CLASSES[x.cls]["prio"] > pr:
                continue
            if CLASSES[x.cls]["prio"] == pr and x.road.name.split("#")[0] == e.road.name.split("#")[0]:
                continue                    # the arterial itself continues here
            cands.append(x)
    for x in sorted(cands, key=lambda x: (CLASSES[x.cls]["prio"], x.L)):
        if _safe_remove(net, x):
            return True
    return False


# ---------------------------------------------------------------- G8 S-bends (left then right)
def _reverse_curve(P, rmin, gap=90.0):
    d = np.diff(P, axis=0)
    if len(d) < 4:
        return False
    h = np.unwrap(np.arctan2(d[:, 1], d[:, 0]))
    s = geom.cum_length(P)[:-1]
    k = np.zeros_like(h)
    k[1:] = np.diff(h) / np.maximum(np.diff(s), 1e-6)
    k = geom.gaussian_smooth(k, s, 6.0)
    sig = np.where(np.abs(k) > 1.0 / (rmin * 3), np.sign(k), 0)
    last, last_s = 0, -1e9
    for i in np.flatnonzero(sig):
        if sig[i] != last and last != 0 and s[i] - last_s < gap:
            return True
        last, last_s = sig[i], s[i]
    return False


def find_sbends(net):
    from .validate import MIN_R, family
    res = []
    for e in net.edges:
        if _protected(e) or e.cls in ("mountain",) or e.L < 30:
            continue
        lo, hi = e.trim[0], e.L - e.trim[1]
        m = (e.s >= lo - 1) & (e.s <= hi + 1)
        if m.sum() > 4 and _reverse_curve(e.P[m], MIN_R.get(family(e.cls), 30)):
            res.append(e)
    return res


def fix_sbend(net, e):
    from .validate import MIN_R, family
    # 1) straighten: keep ends, drop the wiggle, spline through what remains
    P = e.P
    keep = [0, len(P) - 1]
    from .paths import rdp
    keep = sorted(set(rdp(P, 14.0).tolist()) | {0, len(P) - 1})
    C = P[keep]
    if len(C) >= 3:
        D, _ = geom.catmull_rom(C, 4.0)
    else:
        D, _, _ = geom.resample(C, 4.0)
    D[0], D[-1] = P[0], P[-1]
    if not _reverse_curve(D, MIN_R.get(family(e.cls), 30)):
        old = e.P
        e.P = D
        e.recompute()
        if e.z is not None:
            e.z = np.interp(np.linspace(0, 1, len(D)), np.linspace(0, 1, len(old)), e.z)
            e.N = np.interp(np.linspace(0, 1, len(D)), np.linspace(0, 1, len(old)), e.N)
        e.s_road = np.linspace(e.s_road[0], e.s_road[-1], len(D))
        return True
    # 2) a minor street that cannot be straightened goes, if the network stays connected
    if CLASSES[e.cls]["prio"] <= 2:
        return _safe_remove(net, e)
    return False


# ---------------------------------------------------------------- G9 class flicker
def find_flicker(net, max_len=250.0):
    """Short pieces whose class differs from the road continuing on both sides (or the
    only neighbour at a dead end)."""
    res = []
    for e in net.edges:
        if _protected(e) or e.L > max_len:
            continue
        neigh = []
        for nd in e.n:
            others = [x for x, _ in nd.edges if x is not e]
            if len(others) == 1 and not _protected(others[0]):
                neigh.append(others[0])
        if neigh and all(x.cls != e.cls for x in neigh):
            res.append((e, max(neigh, key=lambda x: x.L)))
    return res


# ---------------------------------------------------------------- G10 sharp corners at 2-way nodes
def _arm_dir(e, k, nd, look=25.0):
    look = min(look, e.L * 0.4)
    q = e.P[np.searchsorted(e.s, look)] if k == 0 else e.P[np.searchsorted(e.s, e.L - look)]
    return geom.unit(q - nd.pos)


def find_corners(net, max_defl=50.0):
    res = []
    for nd in net.nodes:
        if len(nd.edges) != 2 or nd.free:
            continue
        (a, ka), (b, kb) = nd.edges
        if a is b or _protected(a) or _protected(b):
            continue
        da, db = _arm_dir(a, ka, nd), _arm_dir(b, kb, nd)
        defl = 180.0 - math.degrees(math.acos(float(np.clip(np.dot(da, db), -1, 1))))
        if defl > max_defl:
            res.append((nd, defl))
    return res


def fix_corner(net, nd):
    from .validate import MIN_R, family
    (a, ka), (b, kb) = nd.edges
    da, db = _arm_dir(a, ka, nd), _arm_dir(b, kb, nd)
    phi = math.pi - math.acos(float(np.clip(np.dot(da, db), -1, 1)))
    R = max(MIN_R.get(family(a.cls), 30), MIN_R.get(family(b.cls), 30)) * 1.2
    T = min(R * math.tan(phi / 2), 0.45 * a.L, 0.45 * b.L)
    if T < 8:
        return False

    def cut(e, k):
        """Edge points kept (from the far end to distance T from the node), as node-ward list."""
        P = e.P if k == 1 else e.P[::-1]           # ends at the node
        s = geom.cum_length(P)
        keep = P[s <= s[-1] - T]
        return keep

    A = cut(a, ka)                 # far -> T before node
    B = cut(b, kb)[::-1]           # T after node -> far
    p0, p2 = A[-1], B[0]
    t = np.linspace(0, 1, max(6, int(2 * T / 3)))[:, None]
    bez = (1 - t) ** 2 * p0 + 2 * (1 - t) * t * nd.pos + t * t * p2
    mid = bez[len(bez) // 2]
    na = np.vstack([A, bez[1:len(bez) // 2 + 1]])
    nb = np.vstack([bez[len(bez) // 2:-1], B])

    def put(e, k, Pn):          # Pn runs far -> node for k==1 orientation
        Pn = Pn if k == 1 else Pn[::-1]
        old_s = e.s.copy()
        e.P = Pn
        e.recompute()
        if e.z is not None:
            u_old = old_s / max(old_s[-1], 1e-6)
            u_new = e.s / max(e.s[-1], 1e-6)
            e.z = np.interp(u_new, u_old, e.z)
            e.N = np.interp(u_new, u_old, e.N)
        e.s_road = np.linspace(e.s_road[0], e.s_road[-1], len(e.P))

    put(a, ka, na)
    put(b, kb, nb[::-1])
    nd.pos = mid.copy()
    return True


# ---------------------------------------------------------------- driver
def repair(net, log=print, rounds=10):
    total = defaultdict(int)
    for r in range(rounds):
        changed = 0
        for e, f in find_duplicates(net):
            if _protected(e) and _protected(f):
                continue
            victim = f if _protected(e) else e if _protected(f) else _minor(e, f)
            if victim in net.edges:
                _remove(net, victim)
                total["G1-duplicate"] += 1
                changed += 1
        for e in find_loops(net):
            if e in net.edges:
                _remove(net, e)
                total["G3-loop"] += 1
                changed += 1
        for A, w, cyc, Q in find_slivers(net):
            cands = [x for x in cyc if x in net.edges and not _protected(x)]
            if not cands:
                continue
            victim = min(cands, key=lambda x: (CLASSES[x.cls]["prio"], x.L))
            _remove(net, victim)
            total["G2-sliver"] += 1
            changed += 1
        for e in find_crowded(net):
            if e in net.edges:
                # drop the minor crossing street at the more crowded end, keep the through road
                a, b = e.n
                nd = a if len(a.edges) >= len(b.edges) else b
                base = lambda x: x.road.name.split("#")[0]
                names = [base(x) for x, _ in nd.edges]
                # a road continuing through the node is the through road, never the victim
                arms = [x for x, _ in nd.edges if x is not e and not _protected(x) and names.count(base(x)) < 2]
                if arms:
                    victim = min(arms, key=lambda x: (CLASSES[x.cls]["prio"], x.L))
                    _remove(net, victim)
                    total["G5-crowded"] += 1
                    changed += 1
        for e in find_ubends(net):
            if e in net.edges:
                _remove(net, e)
                total["G6-ubend"] += 1
                changed += 1
        for e in find_access(net):
            if e in net.edges and fix_access(net, e):
                total["G7-access"] += 1
                changed += 1
        for e in find_sbends(net):
            if e in net.edges and fix_sbend(net, e):
                total["G8-sbend"] += 1
                changed += 1
        for nd, defl in find_corners(net):
            if fix_corner(net, nd):
                total["G10-corner"] += 1
                changed += 1
        for e, ref in find_flicker(net):
            if e in net.edges:
                e.cls = ref.cls
                total["G9-flicker"] += 1
                changed += 1
        for nd, e, (d, f, q) in find_gaps(net):
            if e in net.edges:
                # a gap this small is a missed connection: drop the stub, the dead-end
                # pass removes the rest; real links come from the planner, not from here
                _remove(net, e)
                total["G4-gap"] += 1
                changed += 1
        _cleanup(net)
        if not changed:
            break
    log(f"repair: {dict(total)} in {r + 1} rounds")
    return dict(total)


def report(net):
    return {
        "G1-duplicate": len(find_duplicates(net)),
        "G2-sliver": len(find_slivers(net)),
        "G3-loop": len(find_loops(net)),
        "G4-gap": len(find_gaps(net)),
        "G5-crowded": len(find_crowded(net)),
        "G6-ubend": len(find_ubends(net)),
        "G7-access": len(find_access(net)),
        "G8-sbend": len(find_sbends(net)),
        "G9-flicker": len(find_flicker(net)),
        "G10-corner": len(find_corners(net)),
    }
