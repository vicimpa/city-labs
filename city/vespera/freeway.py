"""Freeways as twin one-way carriageways, with double-deck and tunnel sections and
real interchanges (freeway-to-freeway T junctions with flyovers, diamonds).

Right-hand traffic. A freeway is a centreline with a vertical profile; carriageway A
runs forward on the right of it, carriageway B runs backward on the left. Sections can
stack the carriageways (double deck) or sink them (tunnel). Connectors leave from the
right edge of one carriageway and merge into the right edge of another; left-turn
connectors get higher OSM-style layers so the level solver flies them over the rest.
"""
import math

import numpy as np

from . import geom, network as NW

DECK_GAP = 9.0        # surface-to-surface spacing of a double-deck viaduct
MEDIAN = 2.4


def _reg(lanes):
    name = f"fw1{lanes}"
    if name not in NW.CLASSES:
        NW.CLASSES[name] = dict(lanes=lanes, lane_w=3.6, shoulder=1.8, median=0.0, side=0.0, sigma=90, r=300,
                                prio=6, corner=12, oneway=True)
        NW.MAX_GRADE[name] = 0.06
    return name


def _reg_conn(lanes):
    name = f"ramp{lanes}"
    if name not in NW.CLASSES:
        NW.CLASSES[name] = dict(lanes=lanes, lane_w=3.8, shoulder=0.6, median=0.0, side=0.0, sigma=30, r=60,
                                prio=5, corner=10, oneway=True)
        NW.MAX_GRADE[name] = 0.07
    return name


class Freeway:
    def __init__(self, name, centre_road, lanes=3, sections=()):
        self.name = name
        self.C = centre_road            # NW.Road with P, s, z (profiled)
        self.closed = centre_road.closed
        self.lanes = lanes
        self.cls = _reg(lanes)
        self.hwc = NW.hw(self.cls)
        self.sections = list(sections)  # dicts: kind=deck|tunnel, s0, s1 (centre stations)
        self.trim = [0.0, 0.0]          # centre stations cut away at the ends (junction zones)
        self._shape()

    # ---- per-station lateral offset and vertical offsets of both carriageways
    def _shape(self):
        s = self.C.s
        off = np.full(len(s), MEDIAN / 2 + self.hwc)
        dza = np.zeros(len(s))
        dzb = np.zeros(len(s))
        tun = np.zeros(len(s), bool)
        for sec in self.sections:
            ramp = 220.0
            w = geom.smoothstep(sec["s0"] - ramp, sec["s0"], s) * (1 - geom.smoothstep(sec["s1"], sec["s1"] + ramp, s))
            if sec["kind"] == "deck":
                wl = geom.smoothstep(0.8, 1.0, w)          # close the gap only once vertically apart
                off = off * (1 - wl)
                dza += w * DECK_GAP / 2
                dzb -= w * DECK_GAP / 2
            elif sec["kind"] == "tunnel":
                tun |= (s >= sec["s0"]) & (s <= sec["s1"])
        self.off, self.dza, self.dzb, self.tun = off, dza, dzb, tun

    def station(self, s):
        """centre point, forward tangent, left normal, z at centre station s."""
        L = self.C.L
        s = s % L if self.closed else float(np.clip(s, 0, L))
        p = self.C.point_at(s)
        t = self.C.dir_at(s)
        return p, t, np.array([-t[1], t[0]]), float(np.interp(s, self.C.s, self.C.z))

    def lateral(self, s, cw):
        """Signed lateral offset of carriageway centre ('A' right / 'B' left)."""
        o = float(np.interp(s % self.C.L if self.closed else s, self.C.s, self.off))
        return -o if cw == "A" else o

    def dz(self, s, cw):
        arr = self.dza if cw == "A" else self.dzb
        return float(np.interp(s % self.C.L if self.closed else s, self.C.s, arr))

    def edge_point(self, s, cw, conn_hw):
        """Point on the right edge (relative to travel) of a carriageway, where connectors attach."""
        p, t, n, z = self.station(s)
        lat = self.lateral(s, cw)
        inset = self.hwc - conn_hw - 0.2
        lat += -inset if cw == "A" else inset
        travel = t if cw == "A" else -t
        return p + n * lat, travel, z + self.dz(s, cw)

    def surface(self, cw, Q):
        """Height of carriageway cw under points Q and their distance to its centreline."""
        if not hasattr(self, "_cw"):
            self._cw = {r.spec["cw"]: r for r in self.carriageways()}
        r = self._cw[cw]
        z = np.zeros(len(Q))
        d = np.zeros(len(Q))
        for i, q in enumerate(Q):
            dd, j, t, _ = geom.project_to_polyline(r.P, q)
            d[i] = dd
            z[i] = r.z[j] + (r.z[min(j + 1, len(r.z) - 1)] - r.z[j]) * t
        return z, d

    def carriageways(self):
        s = self.C.s
        lo, hi = self.trim[0], self.C.L - self.trim[1]
        m = (s >= lo) & (s <= hi) if not self.closed else np.ones(len(s), bool)
        out = []
        for cw in ("A", "B"):
            sign = -1.0 if cw == "A" else 1.0
            Tn = geom.tangents(self.C.P, self.closed)
            Nn = geom.left_normal(Tn)
            P = self.C.P + Nn * (sign * self.off)[:, None]
            z = self.C.z + (self.dza if cw == "A" else self.dzb)
            P, z, tun = P[m], z[m], self.tun[m]
            if cw == "B":
                P, z, tun = P[::-1], z[::-1], tun[::-1]
            dzv = (self.dza if cw == "A" else self.dzb)[m]
            if cw == "B":
                dzv = dzv[::-1]
            r = NW.Road(f"{self.name} {cw}", self.cls, P, closed=self.closed, split=False,
                        spec={"tunnel_mask": tun, "layer": (dzv > 2).astype(int), "freeway": self.name, "cw": cw})
            r.z = z
            r.N = NW.natural_along(P)
            r.end_mode = ["merge", "merge"] if not self.closed else ["node", "node"]
            out.append(r)
        return out


# ------------------------------------------------------------------ connectors
def _track(fw, cw, s_a, s_b, lat_extra, n=None):
    """Points following a carriageway's right edge between centre stations s_a -> s_b,
    pushed outward by lat_extra(t) metres (t: 0..1 along the run)."""
    n = n or max(8, int(abs(s_b - s_a) / 3))
    out = []
    for t in np.linspace(0, 1, n):
        s = s_a + (s_b - s_a) * t
        p, travel, _ = fw.edge_point(s, cw, 0.0)
        right = np.array([travel[1], -travel[0]])
        out.append(p + right * lat_extra(t))
    return np.array(out)


def connector(name, src, s_src, cw_src, dst, s_dst, cw_dst, lanes=1, layer=1, run=380.0,
              src_side=1, dst_side=1):
    """Freeway-to-freeway connector: a run that peels off the source carriageway and a run
    that eases into the target carriageway, blended so both ends stay tangent."""
    cls = _reg_conn(lanes)
    chw = NW.hw(cls)
    sg_s = 1 if cw_src == "A" else -1
    sg_d = 1 if cw_dst == "A" else -1
    # lateral of the connector centre relative to the carriageway's right-edge track point:
    # side +1 = hug the right edge, -1 = hug the left edge (connectors tile the carriageway width)
    def off(fw, side):
        return -(chw - 0.2) if side > 0 else -(2 * fw.hwc - chw - 0.2)
    inset_s = -off(src, src_side)
    inset_d = -off(dst, dst_side)
    # peel away towards the side the connector hugs (left-huggers leave over the left edge)
    out_s = (inset_s + 30) if src_side > 0 else -(2 * src.hwc + 30 - inset_s)
    out_d = (inset_d + 30) if dst_side > 0 else -(2 * dst.hwc + 30 - inset_d)
    A = _track(src, cw_src, s_src, s_src + sg_s * run, lambda t: -inset_s + out_s * geom.smoothstep(0.4, 1, t))
    B = _track(dst, cw_dst, s_dst - sg_d * run, s_dst, lambda t: -inset_d + out_d * (1 - geom.smoothstep(0, 0.6, t)))
    m = max(len(A), len(B))
    A = geom.resample(A, 1.0)[0]
    B = geom.resample(B, 1.0)[0]
    tA = np.linspace(0, 1, len(A)); tB = np.linspace(0, 1, len(B))
    t = np.linspace(0, 1, m * 2)
    Ai = np.stack([np.interp(t, tA, A[:, 0]), np.interp(t, tA, A[:, 1])], 1)
    Bi = np.stack([np.interp(t, tB, B[:, 0]), np.interp(t, tB, B[:, 1])], 1)
    w = geom.smoothstep(0.2, 0.8, t)[:, None]
    P = Ai * (1 - w) + Bi * w
    P, _, _ = geom.resample(P, NW.SPACING)
    _, _, z0 = src.edge_point(s_src, cw_src, chw)
    _, _, z1 = dst.edge_point(s_dst, cw_dst, chw)
    r = NW.Road(name, cls, P, split=False, spec={"layer": np.full(len(P), layer), "connector": True})
    r.end_mode = ["merge", "merge"]
    r.merge_host = [f"{src.name} {cw_src}", f"{dst.name} {cw_dst}"]
    s = geom.cum_length(P)
    w = geom.smoothstep(90, s[-1] - 90, s)
    lift = 7.0 * (layer - 1) * np.sin(np.pi * np.clip(s / s[-1], 0, 1)) ** 0.6 if layer > 1 else 0.0
    z = z0 * (1 - w) + z1 * w + lift
    # wherever the connector still lies on a host carriageway it must stay on its surface
    for host, cw in ((src, cw_src), (dst, cw_dst)):
        hz, hd = host.surface(cw, P)
        on = hd < host.hwc + chw - 0.3
        z = np.where(on, hz - 0.04, z)
    pins = np.zeros(len(z), bool)
    for host, cw in ((src, cw_src), (dst, cw_dst)):
        hz, hd = host.surface(cw, P)
        pins |= hd < host.hwc + chw - 0.3
    z = NW.grade_limit_pinned(z, s, NW.MAX_GRADE.get(cls, 0.07), pins)
    r.z = z
    r.N = NW.natural_along(P)
    return r


def _cpt(fw, cw, s, lat):
    """Point `lat` metres right of carriageway cw's centre at centre station s, and travel dir."""
    p, t, n, _ = fw.station(s)
    centre = p + n * fw.lateral(s, cw)
    travel = t if cw == "A" else -t
    right = np.array([travel[1], -travel[0]])
    return centre + right * lat, travel


def _meet(p, d, q, e, reach=380.0):
    """Corner where the run-out of one road meets the run-in of the other. Only valid if it
    lies ahead of p and behind q within `reach`; otherwise None (use a plain spline)."""
    r = geom.line_intersect(p, d, q, e)
    if r is None or not (10 < r[0] < reach and -reach < r[1] < -10):
        return None
    return p + d * r[0]


def _ramp(name, ctrl, radii, cls, layer, hosts, end_modes=("merge", "merge")):
    keep = [k for k, c in enumerate(ctrl) if c is not None]
    ctrl = [ctrl[k] for k in keep]
    radii = [radii[k] for k in keep]
    if len(ctrl) == len(radii) and all(r > 0 for r in radii[1:-1]) and len(keep) == len(radii) and \
            any(r < 250 for r in radii[1:-1]):
        P, U = geom.fillet_path(ctrl, radii)
        P, _, _ = geom.resample(P, NW.SPACING, U)
    else:
        P, _ = geom.catmull_rom(ctrl, NW.SPACING)
    r = NW.Road(name, cls, P, split=False, spec={"layer": np.full(len(P), layer), "connector": True})
    r.end_mode = list(end_modes)
    r.merge_host = list(hosts)
    return r


def t_junction(main, branch, at_start=True, D=520.0, B=360.0, name="Junction"):
    """Semi-directional T: every movement leaves on the right at grade; right turns stay low,
    left turns climb beside the road and fly over both carriageways on wide curves."""
    end_s = 0.0 if at_start else branch.C.L
    pb, tb, _, _ = branch.station(end_s)
    out_dir = tb if at_start else -tb
    d, i, t, q = geom.project_to_polyline(main.C.P, pb)
    s0 = main.C.s[i] + t * (main.C.s[min(i + 1, len(main.C.s) - 1)] - main.C.s[i])
    _, tm, nm, _ = main.station(s0)
    side = 1 if np.dot(out_dir, nm) > 0 else -1          # branch on main's left (+1) or right (-1)
    sb = B if at_start else branch.C.L - B
    if at_start:
        branch.trim[0] = B
    else:
        branch.trim[1] = B
    leave, arrive = ("A", "B") if at_start else ("B", "A")
    near, far = ("A", "B") if side == -1 else ("B", "A")
    sgn = {"A": 1, "B": -1}
    sgL = sgn[leave] * (1 if at_start else 1)
    cls = _reg_conn(1)
    chw = NW.hw(cls)
    mr = main.hwc - chw          # lateral of a lane hugging the right edge
    br = min(branch.hwc - chw, chw - 0.3)      # the two connectors tile the branch width, no gap
    conns = []

    def bst(cw, s):              # branch station moved along its own travel
        return s

    # --- main near -> branch (right turn, ground level)
    a0, dn = _cpt(main, near, s0 - sgn[near] * D, mr)
    a1, _ = _cpt(main, near, s0 - sgn[near] * (D - 140), mr + 9)
    b0, dl = _cpt(branch, leave, sb, br)
    b1, _ = _cpt(branch, leave, sb - sgn[leave] * 160, br + 9)
    c = _meet(a1, dn, b1, dl)
    conns.append(_ramp(f"{name} {main.name[:8]}{near}>{branch.name[:8]}", [a0, a1, c, b1, b0],
                       [0, 600, 320, 600, 0], cls, 1, (f"{main.name} {near}", f"{branch.name} {leave}")))
    # --- branch -> main near (right turn, ground level)
    a0, da = _cpt(branch, arrive, sb, br)
    a1, _ = _cpt(branch, arrive, sb + sgn[arrive] * 160, br + 9)
    b0, _ = _cpt(main, near, s0 + sgn[near] * D, mr)
    b1, _ = _cpt(main, near, s0 + sgn[near] * (D - 140), mr + 9)
    c = _meet(a1, da, b1, dn)
    conns.append(_ramp(f"{name} {branch.name[:8]}>{main.name[:8]}{near}", [a0, a1, c, b1, b0],
                       [0, 600, 320, 600, 0], cls, 1, (f"{branch.name} {arrive}", f"{main.name} {near}")))
    # --- main far -> branch (left turn): exit right, swing out, fly over both carriageways
    a0, df = _cpt(main, far, s0 - sgn[far] * D, mr)
    a1, _ = _cpt(main, far, s0 - sgn[far] * (D - 140), mr + 12)
    a2, _ = _cpt(main, far, s0 - sgn[far] * (D - 300), mr + 60)
    b0, _ = _cpt(branch, leave, sb, -br)
    b1, _ = _cpt(branch, leave, sb - sgn[leave] * 160, -br)
    c = _meet(a2, df, b1, dl)
    if c is None:                # no clean corner: keep running along the branch first, then swing
        c = b1 - dl * 260.0
    conns.append(_ramp(f"{name} {main.name[:8]}{far}>{branch.name[:8]}", [a0, a1, a2, c, b1, b0],
                       [0, 600, 600, 380, 600, 0], cls, 2, (f"{main.name} {far}", f"{branch.name} {leave}")))
    # --- branch -> main far (left turn): leave on the left half, fly over, swing in from the right
    a0, _ = _cpt(branch, arrive, sb, -br)
    a1, _ = _cpt(branch, arrive, sb + sgn[arrive] * 160, -br)
    b0, _ = _cpt(main, far, s0 + sgn[far] * D, mr)
    b1, _ = _cpt(main, far, s0 + sgn[far] * (D - 140), mr + 12)
    b2, _ = _cpt(main, far, s0 + sgn[far] * (D - 300), mr + 60)
    c = _meet(a1, da, b2, df)
    if c is None:
        c = a1 + da * 260.0
    conns.append(_ramp(f"{name} {branch.name[:8]}>{main.name[:8]}{far}", [a0, a1, c, b2, b1, b0],
                       [0, 600, 380, 600, 600, 0], cls, 3, (f"{branch.name} {arrive}", f"{main.name} {far}")))
    # the branch slab begins where every connector already lies fully on it (gore nose):
    # connectors stay side by side up to there, so no open slab end faces the gore
    entry = []
    for r in conns:
        for end, hn in enumerate(r.merge_host):
            if not hn.startswith(branch.name):
                continue
            Q = r.P if end == 1 else r.P[::-1]          # ... -> point on the branch
            best = None
            for q in Q[::-1]:
                d, i, t, _ = geom.project_to_polyline(branch.C.P, q)
                if d > branch.hwc - chw + 0.6:
                    break
                st = branch.C.s[i] if at_start else branch.C.L - branch.C.s[i]
                best = st if best is None else min(best, st)
            if best is not None:
                entry.append(best)
    if entry:
        t0 = max(entry) - 4.0
        if at_start:
            branch.trim[0] = t0
        else:
            branch.trim[1] = t0
    branch.__dict__.pop("_cw", None)
    zc = float(np.interp(s0, main.C.s, main.C.z))
    gc = float(NW.natural_along(main.C.point_at(s0)[None])[0])
    under = False
    for r in conns:
        if under and int(r.spec["layer"][0]) > 1:
            r.spec["layer"] = np.full(len(r.P), -1)
        _profile_conn(r, main, branch)
    return conns


def _profile_conn(r, main, branch):
    """Ends sit on the hosts (pinned later); the middle rises to its level above both roads."""
    s = geom.cum_length(r.P)
    L = s[-1]
    z_ends = []
    for host_name in r.merge_host:
        fw = main if host_name.startswith(main.name) else branch
        cw = host_name.split()[-1]
        hz, _ = fw.surface(cw, r.P[[0]] if not z_ends else r.P[[-1]])
        z_ends.append(float(hz[0]))
    base = z_ends[0] + (z_ends[1] - z_ends[0]) * geom.smoothstep(0, L, s)
    lay = int(r.spec["layer"][0])
    if lay < 0:
        ground = NW.natural_along(r.P) + 0.3
        g = NW.MAX_GRADE.get(r.cls, 0.07) * 0.9
        reach = np.minimum(s - 80.0, L - 80.0 - s) * g
        base = np.maximum(base - np.maximum(reach, 0.0), ground)
    elif lay > 1:
        top = max(z_ends) + 8.5 * (lay - 1)
        g = NW.MAX_GRADE.get(r.cls, 0.07) * 0.9
        # climb right after the gore: flyovers of a T braid near the branch and need the height there
        rise = np.minimum(np.minimum(s - 70.0, L - 70.0 - s) * g, top - base)
        base = base + np.maximum(rise, 0.0)
    r.z = base
    r.N = NW.natural_along(r.P)


def diamond(fw, cross, name, D=420.0, term=55.0):
    """Arterial diamond: each ramp runs in the freeway's own frame — a parallel speed-change
    lane, an easy taper out to `term` metres from the carriageway edge, then straight on to
    the cross road, which it meets square at the ramp terminal."""
    sh, sc, X = NW._crossing(fw.C, cross)
    ramps = []
    # a freeway deep under a hill has no business with a diamond: the ramps would dive into the
    # mountain in their own tunnels; the cross road simply passes over the bore
    over = float(NW.natural_along(np.asarray(X, float)[None])[0]) - float(np.interp(sh, fw.C.s, fw.C.z))
    if over > 12.0:
        return ramps
    cls = _reg_conn(1)
    chw = NW.hw(cls)
    for cw, sg in (("A", 1), ("B", -1)):
        inset = fw.hwc - chw - 0.2
        # where does the offset line (edge + term) meet the cross road? search both sides
        def terminal(direction):
            # closest approach of the offset line to the cross road (a curving cross road may never
            # be hit exactly); returns the station and the point on the cross road
            best = None
            for ds in np.arange(0, 260, 2.0):
                s = sh + direction * ds
                p, travel, _ = fw.edge_point(s, cw, 0.0)
                right = np.array([travel[1], -travel[0]])
                q = p + right * term
                d, i, t, cq = geom.project_to_polyline(cross.P, q)
                if best is None or d < best[0]:
                    best = (d, s, np.asarray(cq, float))
                if d < 2.5:
                    break
            return best
        d_in, s_in, q_in = terminal(-sg)          # terminal before the crossing (off-ramp)
        d_out, s_out, q_out = terminal(sg)        # terminal after it (on-ramp)
        off = _track(fw, cw, sh - sg * D, s_in,
                     lambda t: -inset + (inset + term) * geom.smoothstep(0.3, 0.85, t))
        on = _track(fw, cw, s_out, sh + sg * D,
                    lambda t: -inset + (inset + term) * (1 - geom.smoothstep(0.15, 0.7, t)))
        # run on to the cross road itself when the offset line only passes near it
        def lead_in(track, q, at_end):
            # drop the first ~45 m of the parallel track and spline from the cross road onto it
            T = track[::-1] if at_end else track
            k = int(np.searchsorted(geom.cum_length(T), 45.0))
            ctrl = [q] + list(T[k::max(1, (len(T) - k) // 6)]) + [T[-1]]
            P, _ = geom.catmull_rom(np.array(ctrl), NW.SPACING)
            return P[::-1] if at_end else P
        if d_in > 2.5:
            off = lead_in(off, q_in, True)
        if d_out > 2.5:
            on = lead_in(on, q_out, False)
        off = geom.resample(off, NW.SPACING)[0]
        on = geom.resample(on, NW.SPACING)[0]
        r1 = NW.Road(f"{name} off {cw}", cls, off, split=False, spec={"layer": np.zeros(len(off), int)})
        r1.end_mode = ["merge", "node"]
        r1.merge_host = [f"{fw.name} {cw}", None]
        r2 = NW.Road(f"{name} on {cw}", cls, on, split=False, spec={"layer": np.zeros(len(on), int)})
        r2.end_mode = ["node", "merge"]
        r2.merge_host = [None, f"{fw.name} {cw}"]
        ramps += [r1, r2]
    return ramps
