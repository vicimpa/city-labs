"""Geometric design rules check (see docs/ROAD_STANDARDS.md §8). Run after every build.

Sources: AASHTO Green Book (min radius vs design speed/superelevation, K values),
FHWA / ITE / Iowa DOT (intersection angle >= 75 deg desirable, >= 60 acceptable),
TxDOT RDM 9.4.4 (speed-change lanes, parallel tapers), WSDOT 1360 / TxDOT 15.6
(interchange & ramp spacing). Values are compressed for an arcade map.
"""
import math
from collections import defaultdict

import numpy as np

from . import geom
from .network import CLASSES, MAX_GRADE, hw

# design radius (m) per class family; hairpins allowed only on mountain roads
MIN_R = {"freeway": 300, "fw1": 300, "ramp": 55, "boulevard": 90, "avenue": 70, "street": 35, "lane": 14,
         "rural": 45, "mountain": 16, "industrial": 40, "raceway": 20, "runway": 1e9}
# minimum vertical curve K (m of curve per % change of grade)
MIN_K = {"freeway": 60, "fw1": 60, "ramp": 18, "boulevard": 25, "avenue": 22, "street": 12, "lane": 6,
         "rural": 15, "mountain": 6, "industrial": 15, "raceway": 15, "runway": 100}
MIN_ANGLE = {"lane": 55.0}
DEFAULT_ANGLE = 60.0   # Iowa DOT: 60-75 acceptable, < 60 realign


def family(cls):
    for k in ("fw1", "ramp"):
        if cls.startswith(k):
            return k
    return cls


def _heading(P):
    d = np.diff(P, axis=0)
    return np.unwrap(np.arctan2(d[:, 1], d[:, 0]))


def check(net):
    issues = []

    def add(rule, where, msg, sev=1):
        issues.append(dict(rule=rule, p=[round(float(where[0])), round(float(where[1]))], msg=msg, sev=sev))

    for e in net.edges:
        if e.z is None or e.L < 12 or len(e.P) < 6:
            continue
        fam = family(e.cls)
        lo, hi = e.trim[0], e.L - e.trim[1]
        keep = (e.s[:-1] >= lo) & (e.s[:-1] <= hi)
        h = _heading(e.P)
        ds = np.maximum(np.diff(e.s), 1e-6)
        k = np.zeros_like(h)
        k[1:] = np.diff(h) / ds[1:]                       # curvature 1/m
        ks = geom.gaussian_smooth(k, e.s[:-1], 6.0)
        # R1 radius
        rmin = MIN_R.get(fam, 30)
        bad = keep & (np.abs(ks) > 1.0 / rmin)
        if bad.any():
            i = int(np.argmax(np.abs(ks) * bad))
            add("R1-radius", e.P[i], f"{e.road.name}: R={1 / max(abs(ks[i]), 1e-9):.0f} m < {rmin} ({e.cls})", 2)
        # R2 kinks: heading jump over one sample
        jump = np.abs(np.diff(h)) * 180 / math.pi
        kink = keep[1:] & (jump > (25 if fam in ("mountain", "lane") else 12))
        if kink.any():
            i = int(np.argmax(jump * kink)) + 1
            add("R2-kink", e.P[i], f"{e.road.name}: {jump[i - 1]:.0f} deg in one step", 2)
        # R3 wobble: curvature sign flips with significant curvature on both sides within 60 m
        sig = np.where(np.abs(ks) > 1.0 / (rmin * 4), np.sign(ks), 0)
        flips = 0
        last_sign, last_s = 0, -1e9
        for i in np.flatnonzero(keep & (sig != 0)):
            if sig[i] != last_sign:
                if last_sign != 0 and e.s[i] - last_s < 60 and fam not in ("mountain",):
                    flips += 1
                    if flips == 1:
                        add("R3-wobble", e.P[i], f"{e.road.name}: reverse curves {e.s[i] - last_s:.0f} m apart", 1)
                last_sign = sig[i]
            last_s = e.s[i]
        # V1/V2 grade and vertical curvature
        g = np.diff(e.z) / ds * 100
        gmax = MAX_GRADE.get(e.cls, 0.1) * 100 + 0.5
        if (np.abs(g[keep]) > gmax).any():
            i = int(np.argmax(np.abs(g) * keep))
            add("V1-grade", e.P[i], f"{e.road.name}: {abs(g[i]):.1f}% > {gmax - 0.5:.0f}%", 2)
        gs = geom.gaussian_smooth(g, e.s[:-1], 8.0)
        dg = np.abs(np.gradient(gs, e.s[:-1]))           # % per metre
        kmin = MIN_K.get(fam, 12)
        badk = keep & (dg > 1.0 / kmin)
        if badk.any():
            i = int(np.argmax(dg * badk))
            add("V2-vcurve", e.P[i], f"{e.road.name}: K={1 / max(dg[i], 1e-9):.0f} < {kmin}", 1)
        # J4 straight approach (first 20 m after the junction pad) — minor arms only;
        # the through road may cross a junction on a gentle curve
        for end in (0, 1):
            nd = e.n[end]
            if getattr(nd, "kind", "") != "junction" or len(nd.edges) < 3:
                continue
            if CLASSES[e.cls]["prio"] >= max(CLASSES[x.cls]["prio"] for x, _ in nd.edges):
                continue
            a = e.trim[end] if end == 0 else e.L - e.trim[end] - 20
            m = (e.s[:-1] >= a) & (e.s[:-1] <= a + 20)
            if m.any() and np.abs(ks[m]).max() > 1 / 120.0 and fam not in ("ramp", "fw1"):
                add("J4-approach", e.P[np.flatnonzero(m)[0]], f"{e.road.name}: curved approach to junction", 1)

    # junction rules
    for nd in net.nodes:
        arms = [(e, k) for e, k in nd.edges if e.L > 1]
        if getattr(nd, "kind", "") != "junction" or len(arms) < 3:
            continue
        if len(arms) > 4:
            add("J3-degree", nd.pos, f"{len(arms)}-arm junction (needs roundabout)", 2)
        dirs = []
        for e, k in arms:
            look = min(25.0, e.L * 0.5)
            q = e.P[np.searchsorted(e.s, look)] if k == 0 else e.P[np.searchsorted(e.s, e.L - look)]
            dirs.append((math.atan2(*(q - nd.pos)[::-1]), e))
        dirs.sort(key=lambda x: x[0])
        for i in range(len(dirs)):
            a1, e1 = dirs[i]
            a2, e2 = dirs[(i + 1) % len(dirs)]
            gap = math.degrees((a2 - a1) % (2 * math.pi))
            amin = min(MIN_ANGLE.get(e1.cls, DEFAULT_ANGLE), MIN_ANGLE.get(e2.cls, DEFAULT_ANGLE))
            if family(e1.cls) == "ramp" or family(e2.cls) == "ramp":
                amin = 45.0
            if gap < amin:
                add("J1-angle", nd.pos, f"arms {e1.road.name} / {e2.road.name} meet at {gap:.0f} deg", 2)
                break
    # J2 junction spacing along a road
    for e in net.edges:
        a, b = e.n
        if a is b or getattr(a, "kind", "") != "junction" or getattr(b, "kind", "") != "junction":
            continue
        if len(a.edges) < 3 or len(b.edges) < 3:
            continue
        need = 70.0 if CLASSES[e.cls]["prio"] >= 3 else 40.0
        if family(e.cls) in ("ramp", "fw1"):
            continue
        if e.L < need:
            add("J2-spacing", (a.pos + b.pos) / 2, f"{e.road.name}: junctions {e.L:.0f} m apart (< {need:.0f})", 1)

    # I1 merge / diverge spacing on each carriageway
    attach = defaultdict(list)
    for e in net.edges:
        if not family(e.cls) == "ramp":
            continue
        for k in (0, 1):
            host = e.road.merge_host[k] if hasattr(e.road, "merge_host") else None
            if host:
                attach[host].append(e.P[0] if k == 0 else e.P[-1])
    hosts = {e.road.name: e for e in net.edges if family(e.cls) == "fw1"}
    for name, pts in attach.items():
        h = hosts.get(name)
        if h is None:
            continue
        ss = sorted(float(h.s[geom.project_to_polyline(h.P, p)[1]]) for p in pts)
        for s1, s2 in zip(ss, ss[1:]):
            if 5 < s2 - s1 < 250:
                i = np.searchsorted(h.s, s1)
                add("I1-weave", h.P[min(i, len(h.P) - 1)], f"{name}: ramp ends {s2 - s1:.0f} m apart (< 250)", 1)
    return issues


def summary(issues):
    c = defaultdict(int)
    for it in issues:
        c[it["rule"]] += 1
    return dict(sorted(c.items()))


# ---------------------------------------------------------------- surface (mesh-level) checks
def _footprint(e, step=2.0):
    """Sample points covering the trimmed carriageway: (x, y, z, s)."""
    s0, s1 = e.trim[0], e.L - e.trim[1]
    if s1 - s0 < 1:
        return np.zeros((0, 4))
    ss = np.arange(s0, s1, step)
    P = np.stack([np.interp(ss, e.s, e.P[:, 0]), np.interp(ss, e.s, e.P[:, 1])], 1)
    a = np.stack([np.interp(ss - 1, e.s, e.P[:, 0]), np.interp(ss - 1, e.s, e.P[:, 1])], 1)
    b = np.stack([np.interp(ss + 1, e.s, e.P[:, 0]), np.interp(ss + 1, e.s, e.P[:, 1])], 1)
    t = geom.unit(b - a)
    n = np.stack([-t[:, 1], t[:, 0]], 1)
    z = np.interp(ss, e.s, e.z)
    W = hw(e.cls) - 0.5
    out = []
    for u in np.arange(-W, W + 0.01, step):
        q = P + n * u
        out.append(np.column_stack([q, z, ss]))
    return np.vstack(out)


def surface_check(net, cell=2.0):
    """M1 stacked: two road surfaces over the same spot with 0.3..5.5 m between them
    (neither one level nor a proper over/under). M2 clash: two unrelated roads at the same
    level overlapping (not a junction, not a merge taper)."""
    H = defaultdict(list)
    for e in net.edges:
        if e.z is None:
            continue
        F = _footprint(e)
        for x, y, z, s in F:
            H[(int(x // cell), int(y // cell))].append((e.idx, z, x, y))
    by = {e.idx: e for e in net.edges}

    def related(a, b):
        ea, eb = by[a], by[b]
        if set(map(id, ea.n)) & set(map(id, eb.n)):
            return True
        ra, rb = ea.road, eb.road
        hosts = set(getattr(ra, "merge_host", []) or []) | set(getattr(rb, "merge_host", []) or [])
        if rb.name in hosts or ra.name in hosts:
            return True
        # connectors sharing a host taper
        if set(filter(None, getattr(ra, "merge_host", []) or [])) & set(filter(None, getattr(rb, "merge_host", []) or [])):
            return True
        return False

    issues, seen = [], set()
    for key, items in H.items():
        if len(items) < 2:
            continue
        for i in range(len(items)):
            for j in range(i + 1, len(items)):
                a, za, x, y, sa = items[i]
                b, zb, _, _, sb = items[j]
                if a == b:
                    continue
                pair = (min(a, b), max(a, b))
                dz = abs(za - zb)
                if 0.3 < dz < 5.5 and not related(a, b, sa, sb):
                    rule = "M1-stacked"
                elif dz <= 0.3 and not related(a, b, sa, sb):
                    rule = "M2-clash"
                else:
                    continue
                k = (rule, pair, int(x // 40), int(y // 40))
                if k in seen:
                    continue
                seen.add(k)
                issues.append(dict(rule=rule, p=[round(float(x)), round(float(y))], z=round(float(max(za, zb)), 1),
                                   msg=f"{by[a].road.name} / {by[b].road.name}: dz={dz:.1f} m", sev=3))
    return issues


def terrain_check(net, xs, ys, H, step=4.0):
    """T1: terrain pokes above a ground-level carriageway."""
    issues = []
    res = xs[1] - xs[0]
    for e in net.edges:
        if e.z is None:
            continue
        F = _footprint(e, step)
        if not len(F):
            continue
        j = np.clip(((F[:, 0] - xs[0]) / res).astype(int), 0, len(xs) - 2)
        i = np.clip(((F[:, 1] - ys[0]) / res).astype(int), 0, len(ys) - 2)
        tx = (F[:, 0] - xs[j]) / res
        ty = (F[:, 1] - ys[i]) / res
        h = (H[i, j] * (1 - tx) * (1 - ty) + H[i, j + 1] * tx * (1 - ty) + H[i + 1, j] * (1 - tx) * ty
             + H[i + 1, j + 1] * tx * ty)
        tun = np.interp(F[:, 3], e.s, e.tunnel.astype(float)) > 0.5
        bad = (h > F[:, 2] + 0.05) & ~tun
        if bad.any():
            k = int(np.argmax((h - F[:, 2]) * bad))
            issues.append(dict(rule="T1-terrain", p=[round(float(F[k, 0])), round(float(F[k, 1]))],
                               z=round(float(F[k, 2]), 1),
                               msg=f"{e.road.name}: ground {h[k] - F[k, 2]:.2f} m above the road", sev=2))
    return issues


# ---------------------------------------------------------------- surface (mesh-level) checks
def _footprint(e, step=2.0):
    s0, s1 = e.trim[0], e.L - e.trim[1]
    if s1 - s0 < 1:
        return np.zeros((0, 4))
    ss = np.arange(s0, s1, step)
    P = np.stack([np.interp(ss, e.s, e.P[:, 0]), np.interp(ss, e.s, e.P[:, 1])], 1)
    a = np.stack([np.interp(ss - 1, e.s, e.P[:, 0]), np.interp(ss - 1, e.s, e.P[:, 1])], 1)
    b = np.stack([np.interp(ss + 1, e.s, e.P[:, 0]), np.interp(ss + 1, e.s, e.P[:, 1])], 1)
    t = geom.unit(b - a)
    n = np.stack([-t[:, 1], t[:, 0]], 1)
    z = np.interp(ss, e.s, e.z)
    W = hw(e.cls) - 0.5
    out = [np.column_stack([P + n * u, z, ss]) for u in np.arange(-W, W + 0.01, step)]
    return np.vstack(out)


def surface_check(net, cell=2.0):
    """M1 stacked: two surfaces over the same spot 0.3..5.5 m apart. M2 clash: unrelated
    roads overlapping at the same level."""
    H = defaultdict(list)
    for e in net.edges:
        if e.z is None:
            continue
        for x, y, z, s in _footprint(e):
            H[(int(x // cell), int(y // cell))].append((e.idx, z, x, y, s))
    by = {e.idx: e for e in net.edges}

    from .network import _taper_zone

    def related(a, b, sa, sb):
        ea, eb = by[a], by[b]
        if set(map(id, ea.n)) & set(map(id, eb.n)):
            return True
        if _taper_zone(ea, sa, eb.road.name) or _taper_zone(eb, sb, ea.road.name):
            return True
        # two ramps sharing a host, both inside their tapers on it
        ha = getattr(ea.road, "merge_host", None) or []
        hb = getattr(eb.road, "merge_host", None) or []
        return any(h and _taper_zone(ea, sa, h) and _taper_zone(eb, sb, h) for h in set(ha) & set(hb))

    issues, seen = [], set()
    for items in H.values():
        if len(items) < 2:
            continue
        for i in range(len(items)):
            for j in range(i + 1, len(items)):
                a, za, x, y, sa = items[i]
                b, zb, _, _, sb = items[j]
                if a == b:
                    continue
                dz = abs(za - zb)
                if 0.3 < dz < 5.5 and not related(a, b, sa, sb):
                    rule = "M1-stacked"
                elif dz <= 0.3 and not related(a, b, sa, sb):
                    rule = "M2-clash"
                else:
                    continue
                k = (rule, min(a, b), max(a, b), int(x // 40), int(y // 40))
                if k in seen:
                    continue
                seen.add(k)
                issues.append(dict(rule=rule, p=[round(float(x)), round(float(y))], z=round(float(max(za, zb)), 1),
                                   msg=f"{by[a].road.name} / {by[b].road.name}: dz={dz:.1f} m", sev=3))
    return issues


def terrain_check(net, xs, ys, H, step=4.0):
    issues = []
    res = xs[1] - xs[0]
    for e in net.edges:
        if e.z is None:
            continue
        F = _footprint(e, step)
        if not len(F):
            continue
        j = np.clip(((F[:, 0] - xs[0]) / res).astype(int), 0, len(xs) - 2)
        i = np.clip(((F[:, 1] - ys[0]) / res).astype(int), 0, len(ys) - 2)
        tx = np.clip((F[:, 0] - xs[j]) / res, 0, 1)
        ty = np.clip((F[:, 1] - ys[i]) / res, 0, 1)
        h = (H[i, j] * (1 - tx) * (1 - ty) + H[i, j + 1] * tx * (1 - ty) + H[i + 1, j] * (1 - tx) * ty
             + H[i + 1, j + 1] * tx * ty)
        tun = np.interp(F[:, 3], e.s, e.tunnel.astype(float)) > 0.5
        bad = (h > F[:, 2] + 0.05) & ~tun
        if bad.any():
            k = int(np.argmax((h - F[:, 2]) * bad))
            issues.append(dict(rule="T1-terrain", p=[round(float(F[k, 0])), round(float(F[k, 1]))],
                               z=round(float(F[k, 2]), 1),
                               msg=f"{e.road.name}: ground {h[k] - F[k, 2]:.2f} m above the road", sev=2))
    return issues


def open_ends(net, idx=None):
    """E1: a carriageway end that is neither a junction nor lying on another road's surface."""
    from .roadmesh import RoadIndex
    idx = idx or RoadIndex(net)
    out = []
    for nd in net.nodes:
        if len(nd.edges) != 1:
            continue
        e, k = nd.edges[0]
        if e.z is None:
            continue
        i = 0 if k == 0 else len(e.P) - 1
        step = 1 if k == 0 else -1
        # look 6 m inward from the end: something must be underneath / continuing
        j = int(np.clip(i + step * 2, 0, len(e.P) - 1))
        p, z = e.P[i], e.z[i]
        tg = geom.unit(e.P[j] - e.P[i]) if j != i else np.array([1.0, 0.0])
        nrm = np.array([-tg[1], tg[0]])
        probes = [p + nrm * u for u in (-hw(e.cls) * 0.5, 0.0, hw(e.cls) * 0.5)]
        if all(idx.covering(q, z, e, margin=0.2, dz=1.5) for q in probes[::2]) or \
                idx.covering(p, z, e, margin=0.5, dz=1.5):
            continue
        if e.cls in ("street", "lane", "rural", "mountain", "industrial", "avenue", "boulevard", "runway", "raceway"):
            continue        # dead-end streets are handled by the repair pass
        out.append(dict(rule="E1-open-end", p=[round(float(p[0])), round(float(p[1]))],
                        z=round(float(z), 1), msg=f"{e.road.name}: deck ends in the air", sev=3))
    return out
