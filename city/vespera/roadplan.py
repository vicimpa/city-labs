"""Assemble every road of the city from the master plan (layout.py)."""
import hashlib
import math
import os
import pickle
import time

import numpy as np

from . import freeway as FW, geom, layout as LY, network as NW, paths, rural as RU, streets, terrain as T, touge


def _ctrl_road(name, cls, pts, closed=False, split=True, spec=None):
    spec = dict(spec or {})
    spec.update(name=name, cls=cls, pts=pts, closed=closed, split=split)
    return NW.expand(spec)


def _dense_road(name, cls, P, split=True, spec=None):
    P, U, _ = geom.resample(np.asarray(P, float), NW.SPACING)
    return NW.Road(name, cls, P, U, closed=False, split=split, spec=spec or {})


def meander(P, amp, wavelength, seed, closed=False):
    """Low-frequency sideways wander so hand-placed roads don't look drafted."""
    P = np.asarray(P, float)
    s = geom.cum_length(P)
    L = s[-1]
    rng = np.random.default_rng(seed)
    d = np.zeros(len(P))
    for k in range(4):
        wl = wavelength / (1.7 ** k)
        if closed:
            cyc = max(1, round(L / wl))
            d += rng.uniform(0.5, 1.0) * np.sin(2 * math.pi * cyc * s / L + rng.uniform(0, 6.3)) / (1.6 ** k)
        else:
            d += rng.uniform(0.5, 1.0) * np.sin(2 * math.pi * s / wl + rng.uniform(0, 6.3)) / (1.6 ** k)
    if not closed:
        d *= geom.smoothstep(0, 250, s) * geom.smoothstep(L, L - 250, s)
    N = geom.left_normal(geom.tangents(P, closed))
    return P + N * (d * amp)[:, None]


_route_cache = {}
_fw_state = {}


def _cached_route(a, b, grade, wiggle, seed):
    f = os.path.join(T.CACHE, "routes.pkl")
    if not _route_cache and os.path.exists(f):
        _route_cache.update(pickle.load(open(f, "rb")))
    tmt = os.path.getmtime(os.path.join(T.CACHE, "terrain.npz"))
    key = hashlib.md5(repr((a, b, grade, wiggle, seed, tmt)).encode()).hexdigest()
    if key not in _route_cache:
        _route_cache[key] = paths.route(a, b, max_grade=grade, wiggle=wiggle, seed=seed)
        pickle.dump(_route_cache, open(f, "wb"))
    return _route_cache[key]


def build(log=print):
    t0 = time.time()
    T.load(log=log)
    roads = []

    # ---- freeways: centrelines -> twin carriageways, double decks, T junctions
    fws = {}
    for name, pts, closed in LY.FREEWAYS:
        c = _ctrl_road(name, "freeway", pts, closed=closed, split=False)
        if LY.MEANDER.get(name):
            c.P = meander(c.P, *LY.MEANDER[name], seed=len(name), closed=closed)
            c.recompute()
        NW.profile(c)
        secs = []
        for sec in LY.FW_SECTIONS.get(name, []):
            st = []
            for q in (sec["a"], sec["b"]):
                d, i, t, _ = geom.project_to_polyline(c.P, np.asarray(q, float))
                st.append(c.s[i] + t * (c.s[i + 1] - c.s[i]))
            secs.append(dict(kind=sec["kind"], s0=min(st), s1=max(st)))
        fws[name] = FW.Freeway(name, c, lanes=LY.FW_LANES.get(name, 2), sections=secs)
    # branches meet the main line square (a semi-directional T needs ~90 degrees)
    for main, branch, at_start, jname in LY.FW_JUNCTIONS:
        m, br = fws[main].C, fws[branch].C
        P = br.P if at_start else br.P[::-1]
        d, i, t, q = geom.project_to_polyline(m.P, P[0])
        tm = geom.unit(m.P[min(i + 1, len(m.P) - 1)] - m.P[i])
        nm = np.array([-tm[1], tm[0]])
        s_ = geom.cum_length(P)
        far = P[int(np.searchsorted(s_, 1100.0))]
        if np.dot(far - q, nm) < 0:
            nm = -nm
        k = int(np.searchsorted(s_, 1100.0))
        ctrl = [q, q + nm * 260.0, q + nm * 520.0 + geom.unit(far - q) * 150.0] + list(P[k::25]) + [P[-1]]
        D, _ = geom.catmull_rom(ctrl, NW.SPACING)
        br.P = D if at_start else D[::-1]
        br.recompute()
        NW.profile(br)
        fws[branch] = FW.Freeway(branch, br, lanes=fws[branch].lanes, sections=fws[branch].sections)
    conns = []
    for main, branch, at_start, jname in LY.FW_JUNCTIONS:
        conns += FW.t_junction(fws[main], fws[branch], at_start, name=jname)
    cws = [cw for f in fws.values() for cw in f.carriageways()]
    roads += cws
    # freeway corridor where it sits near the ground blocks streets; running alongside is expensive
    fw_block = streets.Hash(40.0)
    for r in cws:
        low = (r.z - r.N) < 6.5
        for p in r.P[low]:
            fw_block.add(p, (0, 0))
        paths.add_existing(r.P, penalty=True)
    _fw_state["fws"] = fws

    # ---- arterials
    arts = []
    for item in LY.ARTERIALS:
        name, cls, pts = item[:3]
        spec = item[3] if len(item) > 3 else {}
        r = _ctrl_road(name, cls, pts, spec=spec)
        if LY.MEANDER.get(name):
            r.P = meander(r.P, *LY.MEANDER[name], seed=len(name))
            r.recompute()
        arts.append(r)
    roads += arts
    for r in arts:
        paths.add_existing(r.P, penalty=True)
    log(f"roadplan: freeways+arterials {time.time() - t0:.1f}s")

    # ---- proving grounds (kept free of through roads)
    for name, cls, pts, opt in LY.SPECIAL:
        r = _ctrl_road(name, cls, pts, closed=opt.get("closed", False), split=opt.get("split", True),
                       spec={"keep_end": opt.get("keep_end", False)})
        roads.append(r)
        if cls in ("raceway", "runway"):
            paths.add_existing(r.P, avoid=True, radius=3)

    # ---- rural and mountain roads (A*)
    rural = []
    for name, cls, wps, opt in LY.RURAL:
        chain = []
        for k in range(len(wps) - 1):
            P = _cached_route(tuple(wps[k]), tuple(wps[k + 1]), opt.get("grade", 0.1),
                              opt.get("wiggle", 0.0), len(name) * 31 + k)
            chain.append(P if not chain else P[1:])
        P = paths.flow(np.vstack(chain), eps=16.0 if cls == "mountain" else 26.0)
        r = _dense_road(name, cls, P, spec={"keep_end": True})
        rural.append(r)
        paths.add_existing(r.P, penalty=True)
    roads += rural
    # switchback clusters (their open ends get tied in by the countryside web)
    for tg in LY.TOUGE:
        P = touge.switchbacks(tg["center"], tg["legs"], tg["leg_len"], tg["spacing"], tg["radius"], tg["seed"])
        r = _dense_road(tg["name"], "mountain", P)
        roads.append(r)
        paths.add_existing(r.P, penalty=True)
    log(f"roadplan: rural {time.time() - t0:.1f}s")

    # ---- district ring arterials (irregular, follow the district outline inside the mask)
    existing = [r.P for r in arts + rural]
    for d in LY.DISTRICTS:
        if not d.get("ring"):
            continue
        inset, cls = d["ring"]
        mask = streets.make_mask(np.asarray(d["poly"], float), blockers=[(fw_block, 34.0)])
        for k, P in enumerate(ring_paths(d["poly"], inset, mask)):
            r = _dense_road(f"{d['key']} ring {k}", cls, P)
            roads.append(r)
            existing.append(r.P)
            paths.add_existing(r.P, penalty=True)

    # ---- district street grids
    for d in LY.DISTRICTS:
        poly = np.asarray(d["poly"], float)
        pad = 200
        bbox = (poly[:, 0].min() - pad, poly[:, 1].min() - pad, poly[:, 0].max() + pad, poly[:, 1].max() + pad)
        field = streets.Field(bbox, d["bases"], noise=d.get("noise", (0, 1000)), seed=len(d["key"]) * 7)
        blockers = [(fw_block, 34.0)]
        mask = streets.make_mask(poly, blockers=blockers)
        if d.get("exclude"):
            base_mask = mask
            ex = [np.asarray(e, float) for e in d["exclude"]]

            def mask(p, loose=False, base_mask=base_mask, ex=ex):
                if not base_mask(p, loose):
                    return False
                return not any(geom.point_in_poly(np.array([p[0]]), np.array([p[1]]), e)[0] for e in ex)
            mask.band = base_mask.band
        cfg = dict(levels=d["levels"], seeds=d["seeds"], dtest=d.get("dtest", 0.5), stagger=d.get("stagger", False))
        lines = streets.trace_district(cfg, mask, field, existing=existing)
        for k, (P, cls, lvl) in enumerate(lines):
            if geom.cum_length(P)[-1] < 40:
                continue
            roads.append(_dense_road(f"{d['key']} {k}", cls, straighten(P)))
        log(f"roadplan: {d['key']}: {len(lines)} streets ({time.time() - t0:.1f}s)")
        for P, _c, _l in lines:
            paths.add_existing(P, penalty=True)

    # ---- countryside web between the districts
    polys = [d["poly"] for d in LY.DISTRICTS]
    for k, P in enumerate(RU.build(roads, polys, fw_block, log=log)):
        roads.append(_dense_road(f"country {k}", "rural", P))
    close_dead_ends(roads, log)
    # arterial interchanges on the carriageways, plus the freeway-to-freeway connectors
    by_name = {}
    for r in roads:
        by_name.setdefault(r.name, r)
    used = {name: [] for name in fws}
    for main, branch, at_start, jname in LY.FW_JUNCTIONS:
        f = fws[main]
        pb = fws[branch].C.P[0] if at_start else fws[branch].C.P[-1]
        d, i, t, _ = geom.project_to_polyline(f.C.P, pb)
        used[main].append(f.C.s[i])
    for ic in LY.INTERCHANGES:
        cross = by_name.get(ic["cross"])
        if cross is not None:
            try:
                sh = NW._crossing(fws[ic["host"]].C, cross)[0]
            except RuntimeError:
                sh = None
            L_ = fws[ic["host"]].C.L
            near = sh is not None and any(min(abs(sh - u), L_ - abs(sh - u)) < 1100 for u in used[ic["host"]])
            if near:
                log(f"roadplan: interchange {ic['name']} dropped: too close to another interchange (weaving)")
                continue
            if sh is not None:
                used[ic["host"]].append(sh)
        if cross is None:
            log(f"roadplan: interchange {ic['name']}: no road {ic['cross']}")
            continue
        try:
            roads += FW.diamond(fws[ic["host"]], cross, ic["name"])
        except RuntimeError as ex:
            log(f"roadplan: interchange {ic['name']} skipped: {ex}")
    roads += conns
    # cut streets that double back on themselves (a turn of > 50 deg within two samples)
    cut = []
    for r in roads:
        if not r.split or r.closed or family_of(r.cls) in ("mountain",) or len(r.P) < 8:
            cut.append(r)
            continue
        d = np.diff(r.P, axis=0)
        h = np.degrees(np.unwrap(np.arctan2(d[:, 1], d[:, 0])))
        turn = np.abs(h[2:] - h[:-2])
        bad = np.flatnonzero(turn > 50)
        if not len(bad):
            cut.append(r)
            continue
        pieces, start = [], 0
        for b in bad:
            if b + 1 - start >= 6:
                pieces.append(r.P[start:b + 1])
            start = b + 3
        if len(r.P) - start >= 6:
            pieces.append(r.P[start:])
        for k, Pp in enumerate(pieces):
            if geom.cum_length(Pp)[-1] > 40:
                cut.append(_dense_road(f"{r.name}~{k}", r.cls, Pp, spec=r.spec))
    roads = cut
    # horizontal fairing to each class's design radius (hand-built freeways and venues excluded)
    from .validate import MIN_R, family
    for r in roads:
        if r.cls in ("freeway", "raceway", "runway") or family(r.cls) in ("fw1",) or r.closed:
            continue
        if r.spec.get("connector"):
            continue
        if family(r.cls) not in ("mountain",) and len(r.P) > 8:
            tether = 6.0 if family(r.cls) in ("rural", "lane", "street") else 3.0
            r.P[1:-1] = geom.relax_to(r.P, iters=40, tether=tether)[1:-1]
        r.P = geom.fair(r.P, MIN_R.get(family(r.cls), 30) * 1.1)
        r.recompute()
    roads = [r for r in roads if r.name not in LY.REMOVED_ROADS]
    log(f"roadplan: total {len(roads)} roads ({time.time() - t0:.1f}s)")
    return roads


def family_of(cls):
    from .validate import family
    return family(cls)


def straighten(P, eps=7.0):
    """Streamline -> clean street: keep only real bends, spline through them."""
    P = np.asarray(P, float)
    if len(P) < 4:
        return P
    C = P[paths.rdp(P, eps)]
    if len(C) < 3:
        D, _, _ = geom.resample(C, NW.SPACING)
        return D
    return geom.catmull_rom(C, NW.SPACING)[0]


def ring_paths(poly, inset, mask):
    """Closed outline pulled inward and smoothed, split where the mask (water, slope) fails."""
    C = np.asarray(poly, float)
    P, _, _ = geom.resample(np.vstack([C, C[:1]]), 8.0)
    c = C.mean(0)
    v = c - P
    P = P + geom.unit(v) * np.minimum(inset, np.linalg.norm(v, axis=1, keepdims=True) * 0.5)
    k = len(P) - 1
    for _ in range(3):
        for ax in (0, 1):
            ext = np.concatenate([P[:-1, ax]] * 3)
            sm = geom.gaussian_smooth(ext, np.arange(len(ext)) * 8.0, 70.0)
            P[:-1, ax] = sm[k:2 * k]
        P[-1] = P[0]
    ok = np.array([mask(p) for p in P])
    out = []
    i = 0
    while i < len(P):
        if not ok[i]:
            i += 1
            continue
        j = i
        while j < len(P) and ok[j]:
            j += 1
        if (j - i) * 8.0 > 150:
            out.append(P[i:j])
        i = j
    if len(out) > 1 and ok[0] and ok[-1]:
        out[0] = np.vstack([out[-1], out[0][1:]])
        out.pop()
    return out


def close_dead_ends(roads, log=print, reach=220.0):
    """Extend a dangling street end straight to the nearest road ahead, if close."""
    cell = 40.0
    H = {}
    for ri, r in enumerate(roads):
        if r.cls == "freeway":
            continue
        for i, p in enumerate(r.P):
            H.setdefault((int(p[0] // cell), int(p[1] // cell)), []).append((ri, p))
    fixed = 0
    for ri, r in enumerate(roads):
        if not r.split or r.closed or r.spec.get("keep_end"):
            continue
        for end in (0, 1):
            p = r.P[0] if end == 0 else r.P[-1]
            q0 = r.P[min(3, len(r.P) - 1)] if end == 0 else r.P[max(-4, -len(r.P))]
            d = geom.unit(p - q0)
            best = None
            gx, gy = int(p[0] // cell), int(p[1] // cell)
            k = int(reach // cell) + 1
            near_own = False
            for dx in range(-k, k + 1):
                for dy in range(-k, k + 1):
                    for oj, q in H.get((gx + dx, gy + dy), ()):
                        v = q - p
                        dist = float(np.hypot(*v))
                        if oj == ri:
                            continue
                        if dist < 30:
                            near_own = True
                        if dist < reach and dist > 1 and np.dot(v, d) / dist > 0.82:
                            if best is None or dist < best[0]:
                                best = (dist, q)
            if near_own or best is None:
                continue
            q = best[1]
            seg = np.linspace(p, q, max(2, int(best[0] / 6)))
            if np.any(T.coast_dist(seg[:, 0], seg[:, 1]) < 5):
                continue
            Pw = r.P if end == 1 else r.P[::-1]
            sw = geom.cum_length(Pw)
            tail = Pw[sw > sw[-1] - 60.0]
            head = Pw[sw <= sw[-1] - 60.0]
            ctrl = np.vstack([tail[::max(1, len(tail) // 3)], q[None]])
            ext, _ = geom.catmull_rom(np.vstack([head[-1:], ctrl]) if len(head) else ctrl, 4.0)
            Pn = np.vstack([head, ext[1:]]) if len(head) else ext
            r.P = Pn if end == 1 else Pn[::-1]
            r.recompute()
            r.U = np.linspace(0, 1, len(r.P))
            fixed += 1
    log(f"roadplan: closed {fixed} dangling ends")
