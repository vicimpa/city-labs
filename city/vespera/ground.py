"""Terrain conformed to the road network: cuttings, embankments, junction pads."""
import numpy as np

from . import geom, terrain as T
from .network import CLASSES, hw, hwt


def carve(net, res=8.0, extent=4600.0, log=print, region=None):
    """Return (xs, ys, H) — grid heights with roads carved in."""
    if region is None:
        region = (-extent, -extent, extent, extent)
    xs = np.arange(region[0], region[2] + res * 0.5, res)
    ys = np.arange(region[1], region[3] + res * 0.5, res)
    X, Y = np.meshgrid(xs, ys)
    N = T.height(X, Y).astype(np.float64)
    strength = np.zeros_like(N)
    target = N.copy()
    inside_min = np.full_like(N, np.inf)
    n = len(xs)
    m = len(ys)
    for e in net.edges:
        if e.z is None or e.L < 1:
            continue
        ground = ~(e.elev | e.tunnel)
        if not ground.any():
            continue
        w = hwt(e.cls)
        has_side = CLASSES[e.cls]["side"] > 0
        dz = np.abs(e.z - e.N)
        B = float(np.clip(22 + 1.6 * np.percentile(dz, 90), 22, 70))
        P = e.P
        lo = P.min(0) - w - B
        hi = P.max(0) + w + B
        j0 = max(0, int((lo[0] - xs[0]) / res))
        j1 = min(n - 1, int((hi[0] - xs[0]) / res) + 1)
        i0 = max(0, int((lo[1] - ys[0]) / res))
        i1 = min(m - 1, int((hi[1] - ys[0]) / res) + 1)
        if j1 <= j0 or i1 <= i0:
            continue
        sub = (slice(i0, i1 + 1), slice(j0, j1 + 1))
        step = max(1, int(12 / 4))
        Pc = P[::step] if len(P[::step]) > 1 else P
        if not np.allclose(Pc[-1], P[-1]):
            Pc = np.vstack([Pc, P[-1:]])
        d, s = geom.dist_to_polyline_grid(X[sub], Y[sub], Pc)
        # map arc length on coarse polyline back to the edge's own s
        sc = geom.cum_length(Pc)
        s = s * (e.L / max(sc[-1], 1e-6))
        zr = np.interp(s, e.s, e.z)
        gr = np.interp(s, e.s, ground.astype(float)) > 0.5
        lift = 0.12 if has_side else -0.06
        ins = (d <= w) & gr
        st = np.where(ins, 1.0, 1.0 - geom.smoothstep(w, w + B, d)) * gr
        tg = np.where(ins, zr - 0.35, zr + lift)
        cur_s = strength[sub]
        better = st > cur_s + 1e-6
        strength[sub] = np.where(better, st, cur_s)
        target[sub] = np.where(better, tg, target[sub])
        im = inside_min[sub]
        inside_min[sub] = np.where(ins, np.minimum(im, zr - 0.35), im)
    H = N * (1 - strength) + target * strength
    H = np.where(np.isfinite(inside_min), np.minimum(H, inside_min), H)
    log(f"ground: carved {n}x{m} grid")
    return xs, ys, H.astype(np.float32)


CUT_SLOPE = 1.25     # rise per metre of a cut face (about 51 degrees)
FILL_SLOPE = 0.6     # drop per metre of an embankment (about 31 degrees, 1:1.7)
TUNNEL_COVER = 8.0  # ground over a tunnel crown (bore is 7.3 m high)
VERGE = 1.2          # flat strip beyond the road edge before a slope starts


def carve_engineered(net, res=4.0, region=None, log=print, bore_out=None):
    """Grade the terrain like a civil engineer: a flat verge along every road, then a cut
    face or embankment at a constant slope until it meets the natural ground. The terrain
    is clamped between the highest fill line and the lowest cut line of all nearby roads."""
    xs = np.arange(region[0], region[2] + res * 0.5, res)
    ys = np.arange(region[1], region[3] + res * 0.5, res)
    X, Y = np.meshgrid(xs, ys)
    N = T.height(X, Y).astype(np.float64)
    upper = np.full_like(N, np.inf)      # cut limit
    lower = np.full_like(N, -np.inf)     # fill limit
    under = np.full_like(N, np.inf)      # terrain below the carriageway
    roof = np.full_like(N, -np.inf)      # terrain cover over a tunnel bore
    bored = np.zeros(N.shape, bool)      # grid nodes inside a tunnel bore
    nearest = np.full_like(N, np.inf)
    near_z = np.zeros_like(N)
    n, m = len(xs), len(ys)
    for e in net.edges:
        if e.z is None or e.L < 1:
            continue
        ground = ~(e.elev | e.tunnel)
        deck = ~e.tunnel                 # bridges too: no ground may poke up through the deck
        if e.tunnel.any() and deck.any():
            # set the portal face back into the hill, past the grid cell straddling the mouth
            so = e.s[deck]
            gap = np.min(np.abs(e.s[:, None] - so[None, :]), axis=1)
            deck = deck | (gap <= max(10.0, res * 1.6))
        if not deck.any():
            continue
        w = hwt(e.cls) + VERGE
        reach = w + 120.0
        P = e.P
        lo = P.min(0) - reach
        hi = P.max(0) + reach
        j0 = max(0, int((lo[0] - xs[0]) / res)); j1 = min(n - 1, int((hi[0] - xs[0]) / res) + 1)
        i0 = max(0, int((lo[1] - ys[0]) / res)); i1 = min(m - 1, int((hi[1] - ys[0]) / res) + 1)
        if j1 <= j0 or i1 <= i0:
            continue
        sub = (slice(i0, i1 + 1), slice(j0, j1 + 1))
        Pc = P[::3]
        if not np.allclose(Pc[-1], P[-1]):
            Pc = np.vstack([Pc, P[-1:]])
        d, s = geom.dist_to_polyline_grid(X[sub], Y[sub], Pc)
        s = s * (e.L / max(geom.cum_length(Pc)[-1], 1e-6))
        zr = np.interp(s, e.s, e.z)
        # inside a transition loft the paved width is that of the wider road it blends into
        wide = np.zeros(len(e.s))
        for k in (0, 1):
            nd = e.n[k]
            if getattr(nd, "kind", "") == "transition" and e.trim[k] > 0:
                other = max(hwt(x.cls) for x, _ in nd.edges)
                ss = e.s if k == 0 else e.L - e.s
                wide = np.maximum(wide, (other - hwt(e.cls)) * (1 - np.clip(ss / e.trim[k], 0, 1)))
        xw = np.interp(s, e.s, wide)
        gr = np.interp(s, e.s, ground.astype(float)) > 0.5
        dk = np.interp(s, e.s, deck.astype(float)) > 0.5
        wb = hw(e.cls) + 0.8 + res
        bore = ~dk & (d <= wb)
        bored[sub] |= bore
        # bury the tube: full cover over the bore, then an embankment slope down to the hillside,
        # so the shell never sticks out of a shallow flank
        cover = np.where(~dk & (d < reach), zr + TUNNEL_COVER - FILL_SLOPE * np.maximum(d - wb, 0.0), -np.inf)
        roof[sub] = np.maximum(roof[sub], cover)
        # beyond the ends of the edge the junction pads take over: no slope constraints there
        endish = (s <= 0.5) | (s >= e.L - 0.5)
        act = gr & (d < reach)
        dd = np.maximum(d - w - xw, 0.0)
        up = np.where(act, zr + 0.12 + CUT_SLOPE * dd, np.inf)
        dn = np.where(act & ~endish, zr - 0.05 - FILL_SLOPE * dd, -np.inf)
        dn = np.where(act & endish & (d < w + xw), zr - 0.05, dn)
        upper[sub] = np.minimum(upper[sub], up)
        lower[sub] = np.maximum(lower[sub], dn)
        # a full grid cell beyond the edge, so bilinear interpolation never lifts a cut face over the asphalt
        ins = dk & (d <= hwt(e.cls) + xw + max(2.5, res * 1.5))
        # 0.6 m below the carriageway, rising to a verge flush with the asphalt edge (no lip to fall off)
        flush = geom.smoothstep(hw(e.cls) + xw - 1.0, hwt(e.cls) + xw, d)
        under[sub] = np.where(ins, np.minimum(under[sub], zr - 0.6 + 0.52 * flush), under[sub])
        closer = act & (d < nearest[sub])
        nearest[sub] = np.where(closer, d, nearest[sub])
        near_z[sub] = np.where(closer, zr, near_z[sub])
    conflict = lower > upper
    H = np.clip(N, lower, upper)
    H = np.where(conflict, near_z - 0.05, H)
    # the cover's flanks give way to the cut faces of open roads alongside; only the bore core is fixed
    roof = np.where(bored, roof, np.minimum(roof, upper))
    H = np.minimum(np.maximum(H, roof), under)
    if bore_out is not None:         # grid nodes inside a tunnel bore: physics cuts the ground open there
        bore_out.append(bored)
    log(f"ground: engineered grading {n}x{m}, {int(conflict.sum())} conflict cells")
    return xs, ys, H.astype(np.float32)
