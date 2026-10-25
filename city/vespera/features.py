"""Infrastructure and eye-catchers placed before the blocks are built up: railway with stations,
power plant with transmission lines, airport around the runway, billboards along fast roads.

Every feature reports the ground it occupies so buildings.py keeps lots off it.
"""
import numpy as np
from shapely.affinity import rotate, scale
from shapely.geometry import LineString, Point, Polygon, box
from shapely.ops import unary_union

ADS = ["ad_red", "ad_yellow", "ad_blue", "ad_green", "ad_magenta", "ad_white"]


def _frame(a, b):
    t = np.asarray(b, float) - np.asarray(a, float)
    t /= np.linalg.norm(t) or 1
    return t, np.array([-t[1], t[0]])


def rect(c, t, length, width):
    """Oriented rectangle centred on c, `length` along t and `width` across it."""
    c, t = np.asarray(c, float), np.asarray(t, float)
    n = np.array([-t[1], t[0]])
    h, w = t * length / 2, n * width / 2
    return Polygon([c - h - w, c + h - w, c + h + w, c - h + w])


class Features:
    def __init__(self, G, roads, core, roads_u, urban):
        from .buildings import part
        self.G, self.part, self.roads, self.core = G, part, roads, np.asarray(core, float)
        self.roads_u, self.urban = roads_u, urban
        self.rng, self.height = G.rng, G.height
        self.blocked, self.rails, self.cables, self.wind = [], [], [], []
        from shapely import STRtree
        self._rl = [LineString(np.asarray(e["pts"])[:, :2]) for e in roads["edges"]]
        self._rS = [np.r_[0, np.cumsum(np.hypot(*np.diff(np.asarray(e["pts"])[:, :2], axis=0).T))] for e in roads["edges"]]
        self._rtree = STRtree(self._rl)
        self._level_x = {}

    # -------------------------------------------------------------- rail vertical profile
    @staticmethod
    def _grade_env(z, ds, grade, up):
        """Grade-limited envelope: `up` fills dips (raise only), else cuts crests (lower only)."""
        z = z.copy()
        op = max if up else min
        sgn = -1 if up else 1
        for i in range(1, len(z)):
            z[i] = op(z[i], z[i - 1] + sgn * grade * ds[i - 1])
        for i in range(len(z) - 2, -1, -1):
            z[i] = op(z[i], z[i + 1] + sgn * grade * ds[i])
        return z

    @staticmethod
    def pin(z, S, i, target, grade):
        """Force z[i] = target and blend the neighbourhood to it at no more than `grade`."""
        d = np.abs(S - S[i])
        return np.clip(z, target - grade * d, target + grade * d)

    def rail_profile(self, R, base=None, floors=(), grade=0.03, clear=7.5):
        """Rail grade built only from lower bounds, so three guarantees hold together: never below
        the ground (+0.3 m; the bridge deck `base` over water), `clear` metres over every road it
        crosses, slopes within `grade` (the max of grade cones is still within the grade).
        `floors` adds (index, z) lower bounds, e.g. joint levels."""
        cls = self.roads["classes"]
        S = np.r_[0, np.cumsum(np.hypot(*np.diff(R, axis=0).T))]
        g = self.height(R[:, 0], R[:, 1])
        ref = g + 0.3
        if base is not None:
            ref = np.where(g < 0.5, np.maximum(base, 1.0), ref)
        else:
            ref = np.maximum(ref, 1.0)
        I, V = list(range(len(R))), list(ref)
        under = []                                    # (i, road z): bridges the track passes beneath
        for i, p in enumerate(R):
            q = Point(p)
            for k in self._rtree.query(q.buffer(30)):
                e = self.roads["edges"][k]
                if self._rl[k].distance(q) <= cls[e["cls"]]["hwt"] + 3:
                    rz = float(np.interp(self._rl[k].project(q), self._rS[k], np.asarray(e["pts"])[:, 2]))
                    major = e["cls"].startswith(("fw", "ramp")) or e["cls"] in ("avenue", "boulevard", "raceway", "runway")
                    if major and rz - g[i] >= 7.0:            # road already on a bridge: run beneath it
                        under.append((i, rz))
                    elif major and rz + 2 > g[i]:            # road on the ground: overpass
                        I.append(i); V.append(rz + clear)
                    elif not major:
                        self._level_x.setdefault(k, (p, rz))
        for i, v in floors:
            I.append(int(i)); V.append(float(v))
        def solve(I, V):                              # z(s) = max_c (V_c - grade * |s - s_c|)
            I, V = np.asarray(I), np.asarray(V)
            z = np.full(len(R), -1e9)
            for c0 in range(0, len(I), 2048):
                Sc, Vc = S[I[c0:c0 + 2048]], V[c0:c0 + 2048]
                z = np.maximum(z, (Vc[None, :] - grade * np.abs(S[:, None] - Sc[None, :])).max(1))
            return z
        z = solve(I, V)
        for _ in range(4):                            # lifted into a bridge it meant to pass under: go over
            bad = [(i, rz) for i, rz in under if rz - z[i] < 6.5 and z[i] - rz < clear]
            if not bad:
                break
            for i, rz in bad:
                I.append(i); V.append(rz + clear)
            under = [u for u in under if u not in bad]
            z = solve(I, V)
        return z, g

    def level_crossings(self):
        """Barrier booms and warning posts where the final track meets a minor road at grade."""
        cls = self.roads["classes"]
        tracks = [np.asarray(r) for r in self.rails]
        for k, (p, rz) in self._level_x.items():
            e = self.roads["edges"][k]
            line = self._rl[k]
            for T in tracks:
                d = np.hypot(*(T[:, :2] - p).T)
                i = int(np.argmin(d))
                if d[i] > 6 or abs(T[i, 2] - rz) > 2.5:
                    continue
                s = line.project(Point(T[i, :2]))
                a, b = line.interpolate(max(s - 2, 0)), line.interpolate(min(s + 2, line.length))
                t, n = _frame((a.x, a.y), (b.x, b.y))
                w = cls[e["cls"]]["hw"]
                for sd in (-1, 1):
                    c = T[i, :2] + t * sd * 7 + n * sd * (w + 1.2)
                    z = float(self.height(*c))
                    self.item("level_crossing", [
                        self.part(Point(c).buffer(0.15, resolution=2), z, 3.2, "plaster_white"),
                        self.part(rect(c + n * -sd * w / 2, n, w, 0.25), z + 1.1, 0.25, "ad_red"),
                        self.part(rect(c + np.array([0, 0]), t, 0.9, 0.12), z + 2.4, 0.5, "ad_red")], "infra")
                break

    def rail_piers(self, R, Z, g, every=30.0):
        """Piers under elevated track, never standing on a carriageway (slid along to the next gap)."""
        cls = self.roads["classes"]
        S = np.r_[0, np.cumsum(np.hypot(*np.diff(R, axis=0).T))]
        last = -1e9
        for k in range(len(R)):
            if S[k] - last < every or Z[k] - g[k] < 3:
                continue
            t = R[min(k + 1, len(R) - 1)] - R[max(k - 1, 0)]
            t /= np.linalg.norm(t) or 1
            pier = rect(R[k], t, 2.2, 5.0)
            if any(pier.distance(self._rl[j]) < cls[self.roads["edges"][j]["cls"]]["hw"] + 0.8
                   for j in self._rtree.query(pier.buffer(30))):
                continue
            last = S[k]
            self.item("rail_pier", [self.part(pier, g[k] - 1, Z[k] - g[k] + 0.4, "concrete")])

    def emit_rail(self, R, Z, g):
        self.rails.append(np.round(np.column_stack([R, Z]), 2).tolist())
        self.blocked.append(LineString(R).buffer(9))
        self.rail_piers(R, Z, g)

    def item(self, typ, parts, zone="infra"):
        return self.G.add(typ, zone, parts)

    def edge(self, name):
        return next(e for e in self.roads["edges"] if e["name"] == name)

    # -------------------------------------------------------------- railway
    def railway(self, host, other, offset=34.0, emit=True):
        """Rail line running beside a freeway carriageway, on the outside, at the freeway's grade
        (so it inherits its bridges); piers wherever it rides above the ground."""
        e, o = self.edge(host), self.edge(other)
        P = np.asarray(e["pts"], float)
        O = LineString(np.asarray(o["pts"])[:, :2])
        T = np.gradient(P[:, :2], axis=0)
        T /= np.linalg.norm(T, axis=1)[:, None] + 1e-9
        N = np.column_stack([-T[:, 1], T[:, 0]])
        mid = len(P) // 2
        side = 1 if O.distance(Point(P[mid, :2] + N[mid] * 5)) > O.distance(Point(P[mid, :2])) else -1
        R = P[:, :2] + N * side * offset
        # smooth the offset line (it pinches on tight curves) and keep it monotone
        for _ in range(6):
            R[1:-1] = (R[:-2] + 2 * R[1:-1] + R[2:]) / 4
        Z, ground = self.rail_profile(R, P[:, 2])
        self.last_base = P[:, 2].copy()
        pts = np.column_stack([R, Z])
        if emit:
            self.emit_rail(R, Z, ground)
        else:
            self._pending = (R, ground)
        self.last_ground = ground
        return pts, T, N * side

    def station(self, pts, T, N, k, name_kind="station"):
        c = pts[k, :2]
        z = float(pts[k, 2])
        t, n = T[k], N[k]
        if rect(c + n * 24, t, 70, 40).intersects(self.roads_u):     # build on the side clear of roads
            n = -n
            if rect(c + n * 24, t, 70, 40).intersects(self.roads_u):
                return
        platform = rect(c + n * 6, t, 220, 7)
        building = rect(c + n * 24, t, 70, 22)
        canopy = rect(c + n * 6, t, 160, 9)
        parts = [self.part(platform, z - 0.5, 1.6, "concrete"),
                 self.part(canopy, z + 5, 0.6, "roof_white"),
                 self.part(building, z - 1, 14, "brick"),
                 self.part(rect(c + n * 24, t, 30, 24), z + 13, 6, "glass_teal"),
                 self.part(Point(c + n * 24 + t * 30).buffer(4, resolution=2), z, 32, "brick_dark")]   # clock tower
        for j in range(-3, 4):
            parts.append(self.part(Point(c + n * 6 + t * j * 24).buffer(0.3, cap_style="square"), z + 1, 4, "metal"))
        self.item(name_kind, parts, "landmark")
        plaza = rect(c + n * 52, t, 90, 34)
        self.G.ground(plaza, "plaza")
        self.G.scatter(plaza.buffer(-4), 1 / 250)
        self.blocked.append(unary_union([platform, building, plaza]).buffer(4))

    # -------------------------------------------------------------- power
    def power_plant(self):
        """Flat dry site 1.5-4 km from the core, clear of roads and town."""
        best = None
        for r in np.arange(1800, 4200, 200):
            for a in np.linspace(0, 2 * np.pi, 48, endpoint=False):
                c = self.core + r * np.array([np.cos(a), np.sin(a)])
                site = box(c[0] - 190, c[1] - 140, c[0] + 190, c[1] + 140)
                G = np.array(site.exterior.coords)
                xs = np.linspace(c[0] - 190, c[0] + 190, 7)
                ys = np.linspace(c[1] - 140, c[1] + 140, 5)
                X, Y = np.meshgrid(xs, ys)
                h = self.height(X.ravel(), Y.ravel())
                if h.min() < 2 or h.max() - h.min() > 10 or h.max() > 60:
                    continue
                if site.buffer(30).intersects(self.roads_u) or site.buffer(150).intersects(self.urban):
                    continue
                score = r + 30 * (h.max() - h.min())
                if best is None or score < best[0]:
                    best = (score, c, float(h.min()))
            if best is not None:
                break
        if best is None:
            return None
        _, c, z = best
        t, n = np.array([1.0, 0.0]), np.array([0.0, 1.0])
        parts = []
        for dx in (-110, -40):                       # hollow hyperboloid-ish cooling towers
            p = Point(c + t * dx + n * 40)
            zk = z - 1
            for r0, h in ((32, 30), (27, 25), (25, 12), (27, 13)):
                ring = p.buffer(r0, resolution=10).difference(p.buffer(r0 - 2.5, resolution=10))
                parts.append(self.part(ring, zk, h, "concrete"))
                zk += h
        parts.append(self.part(rect(c + t * 70 + n * 30, t, 130, 45), z - 1, 28, "metal_blue"))
        parts.append(self.part(rect(c + t * 70 + n * 70, t, 90, 30), z - 1, 18, "metal_roof"))
        for dx in (40, 100):
            ch = Point(c + t * dx + n * 85)
            for k in range(6):                       # red/white banded chimney
                parts.append(self.part(ch.buffer(4.5 - k * 0.3, resolution=4), z + k * 20 - 1, 20, "ad_red" if k % 2 else "plaster_white"))
        yard = rect(c - n * 70, t, 300, 90)
        self.G.ground(yard, "gravel")
        for i in range(8):
            for j in range(3):
                q = c - n * 70 + t * (-120 + i * 34) + n * (-25 + j * 25)
                parts.append(self.part(rect(q, t, 6, 5), z, 6, "metal"))
        self.item("power_plant", parts, "landmark")
        site = box(c[0] - 200, c[1] - 150, c[0] + 200, c[1] + 150)
        self.blocked.append(site)
        self.G.ground(site.difference(yard).difference(unary_union([Polygon(p["p"]) for p in parts])), "gravel")
        return c - n * 70, z

    def pylon(self, p, t, z, extra=0.0):
        n = np.array([-t[1], t[0]])
        z0 = z
        arms = np.array([p + n * 10.5, p - n * 10.5])
        side = float(self.height(arms[:, 0], arms[:, 1]).max())
        z = max(z, side - 6) + extra                   # cross-slope / tall tower: longer base section
        parts = [self.part(rect(p, t, 8, 8), z0 - 1, 14 + (z - z0), "steel"),
                 self.part(rect(p, t, 4, 4), z + 13, 14, "steel"),
                 self.part(rect(p, t, 2, 2), z + 27, 10, "steel"),
                 self.part(rect(p, t, 1.4, 22), z + 26, 1.2, "steel"),
                 self.part(rect(p, t, 1.4, 16), z + 32, 1.2, "steel")]
        self.item("pylon", parts)
        return [p + n * s for s in (-10.5, 10.5, -7.5, 7.5)], [z + 25.5, z + 25.5, z + 31.5, z + 31.5]

    def route(self, a, b, avoid):
        """Straight if clear of `avoid`, else one or two detour waypoints swung around it."""
        a, b = np.asarray(a, float), np.asarray(b, float)
        if not LineString([a, b]).intersects(avoid):
            return [a, b]
        t, n = _frame(a, b)
        L = np.linalg.norm(b - a)
        for off in (400, 800, 1300, 1900, 2600, 3400):
            for sd in (1, -1):
                for f in ((0.5,), (0.3, 0.7)):
                    W = [a] + [a + t * L * u + n * sd * off for u in f] + [b]
                    if not LineString(W).intersects(avoid):
                        return W
        return [a, b]

    def _site(self, line, s):
        """A pylon spot near arc length s, stepped off roads and water; None if there is none."""
        L = line.length
        for shift in (0, 25, -25, 50, -50, 80, -80, 120, -120):
            q = line.interpolate(min(max(s + shift, 0), L))
            p = np.array([q.x, q.y])
            z = float(self.height(p[0], p[1]))
            if z >= 0.5 and not Point(p).buffer(6).intersects(self.roads_u):
                return min(max(s + shift, 0), L), p, z
        return None

    def _clear(self, a, b, lo=25.5, sag=6.0, need=8.0):
        """Arc offset of the worst ground clash on the span a->b (cable at pylon height `lo`,
        parabolic sag), or None when the span keeps `need` metres over the terrain."""
        (sa, pa, za), (sb, pb, zb) = a, b
        u = np.linspace(0.04, 0.96, 24)
        xy = pa + (pb - pa) * u[:, None]
        d = np.linalg.norm(pb - pa)
        cz = za + lo + (zb - za) * u - sag * (d / 300) ** 2 * 4 * u * (1 - u)
        gap = cz - self.height(xy[:, 0], xy[:, 1])
        k = int(np.argmin(gap))
        return None if gap[k] >= need else sa + (sb - sa) * u[k]

    def power_line(self, waypoints, span=320.0, avoid=None):
        W = [np.asarray(w, float) for w in waypoints]
        if avoid is not None and len(W) == 2:
            W = self.route(W[0], W[1], avoid)
        line = LineString(W)
        L = line.length
        sites = [x for x in (self._site(line, s) for s in np.linspace(0, L, max(2, int(L // span) + 1))) if x]
        # split spans that would cut through a ridge, up to a few levels deep
        for _ in range(8):
            out, changed = [sites[0]], False
            for a, b in zip(sites, sites[1:]):
                s = self._clear(a, b)
                if s is not None and b[0] - a[0] > 40:
                    mid = self._site(line, s)
                    if mid and a[0] < mid[0] < b[0]:
                        out.append(mid)
                        changed = True
                out.append(b)
            sites = out
            if not changed:
                break
        # spans still too low get tall towers at both ends (+15 m)
        tall = set()
        for i, (a, b) in enumerate(zip(sites, sites[1:])):
            if self._clear(a, b) is not None:
                tall |= {i, i + 1}
        tips = []
        for i, (s, p, z) in enumerate(sites):
            q2, q1 = line.interpolate(min(s + 5, L)), line.interpolate(max(s - 5, 0))
            t, _ = _frame((q1.x, q1.y), (q2.x, q2.y))
            tips.append(self.pylon(p, t, z, extra=15.0 if i in tall else 0.0))
        for c in range(4):                           # cables with sag between pylons
            for (P0, Z0), (P1, Z1) in zip(tips, tips[1:]):
                u = np.linspace(0, 1, 12)
                xy = P0[c] + (P1[c] - P0[c]) * u[:, None]
                d = np.linalg.norm(P1[c] - P0[c])
                zz = Z0[c] + (Z1[c] - Z0[c]) * u - 6 * (d / 300) ** 2 * 4 * u * (1 - u)
                self.cables.append(np.round(np.column_stack([xy, zz]), 2).tolist())
        self.blocked.append(line.buffer(16))
        return len(tips)

    def distribution_poles(self, classes=("rural", "mountain"), every=48.0):
        """Wooden poles with two wires along country roads, on one side."""
        cls = self.roads["classes"]
        from shapely import STRtree
        lines = [LineString(np.asarray(e["pts"])[:, :2]) for e in self.roads["edges"]]
        tree = STRtree(lines)
        for e in self.roads["edges"]:
            if e["cls"] not in classes:
                continue
            P = np.asarray(e["pts"], float)
            line = LineString(P[:, :2])
            if line.length < 150:
                continue
            S = np.r_[0, np.cumsum(np.hypot(*np.diff(P[:, :2], axis=0).T))]
            off_grade = np.asarray(e["tunnel"], bool) | np.asarray(e["elev"], bool)
            side = 1 if e["id"] % 2 else -1
            prev = None
            for s in np.arange(20, line.length - 20, every):
                a, b = line.interpolate(s), line.interpolate(s + 2)
                t, n = _frame((a.x, a.y), (b.x, b.y))
                if off_grade[min(np.searchsorted(S, s), len(S) - 1)]:
                    prev = None
                    continue
                p = np.array([a.x, a.y]) + n * side * (cls[e["cls"]]["hwt"] + 3.5)
                z = float(self.height(p[0], p[1]))
                q = Point(p)
                if z < 0.5 or any(q.distance(lines[k]) < 2.5 + cls[self.roads["edges"][k]["cls"]]["hwt"]
                                  for k in tree.query(q.buffer(25))):
                    prev = None
                    continue
                self.item("pole", [self.part(Point(p).buffer(0.15, resolution=2), z - 0.5, 9.5, "wood"),
                                   self.part(rect(p + np.array([0, 0]), n, 2.4, 0.15), z + 8.2, 0.15, "wood")], "infra")
                tips = [p + n * 1.0, p - n * 1.0]
                if prev is not None:                     # drop a wire that would cut into a crest
                    u = np.linspace(0.05, 0.95, 12)
                    cz = prev[1] + (z + 8.35 - prev[1]) * u - 0.7 * 4 * u * (1 - u)
                    for c in range(2):
                        xy = prev[0][c] + (tips[c] - prev[0][c]) * u[:, None]
                        if (cz - self.height(xy[:, 0], xy[:, 1]) < 2.5).any():
                            prev = None
                            break
                if prev is not None:
                    for c in range(2):
                        u = np.linspace(0, 1, 6)
                        xy = prev[0][c] + (tips[c] - prev[0][c]) * u[:, None]
                        zz = prev[1] + (z + 8.35 - prev[1]) * u - 0.7 * 4 * u * (1 - u)
                        self.cables.append(np.round(np.column_stack([xy, zz]), 2).tolist())
                prev = (tips, z + 8.35)

    def substation(self, p):
        z = float(self.height(p[0], p[1]))
        t = np.array([1.0, 0.0])
        site = Point(p).buffer(35, cap_style="square")
        self.G.ground(site, "gravel")
        parts = [self.part(rect(p + np.array([dx, dy]), t, 5, 4), z, 5, "metal")
                 for dx in (-20, -8, 4, 16) for dy in (-12, 6)]
        parts.append(self.part(site.exterior.buffer(0.15), z, 2.5, "metal"))
        self.item("substation", parts)
        self.blocked.append(site.buffer(5))

    # -------------------------------------------------------------- airport
    def airport(self, name="Corsa Runway"):
        e = self.edge(name)
        P = np.asarray(e["pts"], float)
        a, b = P[0, :2], P[-1, :2]
        t, n = _frame(a, b)
        L = np.linalg.norm(b - a)
        mid = (a + b) / 2
        # terminal side: whichever side is drier and flatter
        def score(sd):
            q = mid + n * sd * 280
            X = q + t * np.linspace(-300, 300, 9)[:, None]
            h = self.height(X[:, 0], X[:, 1])
            return (h < 1).sum() * 100 + np.ptp(h)
        sd = 1 if score(1) <= score(-1) else -1
        n = n * sd
        z = float(np.median(P[:, 2]))
        taxi = rect(mid + n * 110, t, L - 60, 23)
        self.G.ground(taxi, "runway")
        for f in (-0.45, 0, 0.45):                   # connectors
            self.G.ground(rect(mid + t * f * L + n * 55, n, 90, 20), "runway")
        apron = rect(mid + n * 210 + t * 40, t, 560, 170)
        self.G.ground(apron, "apron")
        term_c = mid + n * 320 + t * 40
        parts = [self.part(rect(term_c, t, 340, 48), z - 1, 16, "glass_silver"),
                 self.part(rect(term_c, t, 360, 56), z + 15, 2, "roof_white")]
        for g in range(5):                           # jet bridges
            q = term_c - n * 24 + t * (-140 + g * 70)
            parts.append(self.part(rect(q - n * 18, n, 36, 4), z + 4, 4, "metal"))
        self.item("terminal", parts, "landmark")
        tw = mid + n * 300 + t * 280
        self.item("control_tower", [
            self.part(Point(tw).buffer(5, resolution=3), z - 1, 46, "concrete"),
            self.part(Point(tw).buffer(9, resolution=4), z + 45, 7, "glass_teal"),
            self.part(Point(tw).buffer(10, resolution=4), z + 52, 1.2, "metal")], "landmark")
        for h in range(3):
            hc = mid + n * 230 - t * (330 + h * 75)
            self.item("hangar", [self.part(rect(hc, t, 62, 55), z - 1, 18, "metal_roof"),
                                 self.part(rect(hc, t, 64, 57).difference(rect(hc, t, 60, 53)), z + 17, 3, "metal")])
            self.G.ground(rect(hc - n * 45, t, 62, 40), "apron")
        for g in range(4):                           # parked airliners
            c = term_c - n * 75 + t * (-105 + g * 70)
            ang = np.degrees(np.arctan2(n[1], n[0]))
            body = rotate(box(-20, -2, 20, 2), ang, origin=(0, 0))
            wing = rotate(Polygon([(-2, -17), (5, -17), (8, 17), (-2, 17)]), ang, origin=(0, 0))
            tail = rotate(box(-20, -6, -16, 6), ang, origin=(0, 0))
            off = lambda g_: Polygon(np.asarray(g_.exterior.coords) + c)  # noqa: E731
            self.item("airliner", [self.part(off(body), z + 2, 4, "plaster_white"),
                                   self.part(off(wing), z + 3, 0.6, "metal"),
                                   self.part(off(tail), z + 4, 0.5, "plaster_white"),
                                   self.part(Point(c - n * 18).buffer(0.6), z + 4, 7, "ad_blue")])
        park = rect(term_c + n * 90, t, 300, 100)
        self.G.ground(park, "parking")
        self.G.scatter(park, 1 / 900)
        self.blocked.append(unary_union([taxi, apron, rect(term_c + n * 40, t, 380, 220),
                                         rect(mid + n * 230 - t * 405, t, 260, 160)]).buffer(10))

    # -------------------------------------------------------------- billboards
    def billboards(self):
        cls = self.roads["classes"]
        for e in self.roads["edges"]:
            c = e["cls"]
            big = c.startswith("fw1")
            if not (big or c in ("avenue", "boulevard")):
                continue
            P = np.asarray(e["pts"], float)
            line = LineString(P[:, :2])
            gap = 420 if big else 260
            s = self.rng.uniform(80, gap)
            while s < line.length - 60:
                a, b2 = line.interpolate(s), line.interpolate(s + 2)
                t, n = _frame((a.x, a.y), (b2.x, b2.y))
                side = 1 if self.rng.random() < 0.5 else -1
                if big:
                    off, W, H, pole = cls[c]["hwt"] + 22, 14, 5, 11
                else:
                    off, W, H, pole = cls[c]["hwt"] - 0.6, 4, 2.4, 3
                p = np.array([a.x, a.y]) + n * side * off
                z = float(self.height(p[0], p[1]))
                s += gap * self.rng.uniform(0.7, 1.3)
                if z < 1:
                    continue
                if big and Point(p).buffer(8).intersects(self.roads_u.buffer(-14)):
                    continue
                board = rect(p, t, W, 0.5)
                parts = [self.part(Point(p).buffer(0.5 if big else 0.18, resolution=2), z - 0.5, pole + 0.5, "steel"),
                         self.part(board, z + pole, H, self.rng.choice(ADS))]
                if big:
                    parts.append(self.part(rect(p - n * side * 0.8, t, W, 1.2), z + pole - 0.6, 0.4, "steel"))
                self.item("billboard", parts, "ad")
                self.blocked.append(Point(p).buffer(W / 2 + 2))

    def rooftop_ads(self, share=0.08):
        for it in list(self.G.out):
            if it["zone"] not in ("downtown", "midtown") or self.rng.random() > share:
                continue
            top = max(it["parts"], key=lambda p: p["z"] + p["h"])
            fp = Polygon(top["p"])
            R = np.asarray(fp.minimum_rotated_rectangle.exterior.coords)[:3]
            t, _ = _frame(R[0], R[1])
            w = min(np.linalg.norm(R[1] - R[0]) * 0.8, 24)
            if w < 8:
                continue
            n = np.array([-t[1], t[0]])
            c = np.asarray(fp.centroid.coords[0])
            zt = top["z"] + top["h"]
            it["parts"] += [self.part(rect(c, t, w, 0.4), zt + 2, w * 0.3, self.rng.choice(ADS)),
                            self.part(rect(c - n * 0.6, t, w * 0.9, 0.3), zt, 2.2, "steel")]

    # -------------------------------------------------------------- coast: port, lighthouse
    def coast_points(self, step=42.0, extent=4400.0):
        """Shore samples (land 0.8-6 m with water within 70 m) and their seaward normals."""
        xs = np.arange(-extent, extent, step)
        X, Y = np.meshgrid(xs, xs)
        X, Y = X.ravel(), Y.ravel()
        h = self.height(X, Y)
        cand = (h > 0.8) & (h < 6)
        X, Y = X[cand], Y[cand]
        ang = np.linspace(0, 2 * np.pi, 16, endpoint=False)
        D = np.stack([np.cos(ang), np.sin(ang)], 1)
        hw = np.stack([self.height(X + 70 * dx, Y + 70 * dy) for dx, dy in D], 1)
        wet = hw < -1.5
        keep = wet.sum(1) >= 3
        n = (wet[keep, :, None] * D[None]).sum(1)
        n /= np.linalg.norm(n, axis=1)[:, None] + 1e-9
        return np.column_stack([X[keep], Y[keep]]), n

    def port(self):
        P, Nrm = self.coast_points()
        best = None
        for p, n in zip(P, Nrm):
            d = np.linalg.norm(p - self.core)
            if d < 900 or d > 4200:
                continue
            t = np.array([-n[1], n[0]])
            quay = rect(p + n * 60, t, 560, 140)
            yard = rect(p - n * 110, t, 560, 200)
            Q = np.array(quay.exterior.coords)
            qs = np.array([p + n * a + t * b for a in (20, 60, 110) for b in (-250, -120, 0, 120, 250)])
            ys = np.array([p - n * a + t * b for a in (30, 110, 190) for b in (-250, -120, 0, 120, 250)])
            hq, hy = self.height(qs[:, 0], qs[:, 1]), self.height(ys[:, 0], ys[:, 1])
            if (hq < -1).mean() < 0.6 or (hy > 0.5).mean() < 0.85 or hy.max() > 18:
                continue
            if yard.buffer(10).intersects(self.roads_u) or quay.intersects(self.roads_u):
                continue
            score = d + 300 * (hy.max() - hy.min())
            if best is None or score < best[0]:
                best = (score, p, n, t)
        if best is None:
            return None
        _, p, n, t = best
        zq = 3.0
        quay = rect(p + n * 60, t, 560, 140)
        yard = rect(p - n * 110, t, 560, 200)
        self.item("quay", [self.part(quay, -6, 6 + zq, "concrete")], "port")
        self.G.ground(yard, "apron")
        rng = self.rng
        cols = ["cont_orange", "cont_blue", "cont_green", "cont_red", "cont_grey", "cont_white"]
        # container yard: rows of stacks on the quay and in the yard
        for base, depth, zb in ((p + n * 40, 80, zq), (p - n * 60, 150, None)):
            for i in range(-11, 12):
                for j in range(int(depth // 14)):
                    if rng.random() < 0.18:
                        continue
                    c = base + t * i * 22 - n * j * 14 + n * (depth / 2 if zb else 0)
                    z0 = zb if zb is not None else float(self.height(c[0], c[1]))
                    k = int(rng.integers(1, 5))
                    self.item("containers", [self.part(rect(c + t * dx, t, 12.2, 2.45), z0 + lv * 2.6, 2.55, rng.choice(cols))
                                             for dx in (-3.8, 0, 3.8) for lv in range(k) if rng.random() < 0.85], "port")
        # ship-to-shore gantry cranes on the quay edge
        for i in range(5):
            c = p + n * 105 + t * (-220 + i * 110)
            col = "crane_red" if i % 2 else "crane_blue"
            parts = [self.part(rect(c + t * dx + n * dy, t, 2, 2), zq, 42, col) for dx in (-12, 12) for dy in (-14, 14)]
            parts += [self.part(rect(c + n * 25, n, 110, 4), zq + 42, 4, col),
                      self.part(rect(c - n * 22, t, 14, 10), zq + 46, 6, "plaster_white"),
                      self.part(rect(c + n * 14, n, 3, 26), zq + 38, 3, col)]
            self.item("gantry_crane", parts, "port")
        # moored ships
        for i, (L, W) in enumerate(((210, 32), (160, 26))):
            c = p + n * (150 + W / 2 + 4) + t * (-120 + i * 260)
            hull = Polygon([c - t * L / 2 - n * W / 2, c + t * (L / 2 - 20) - n * W / 2, c + t * L / 2,
                            c + t * (L / 2 - 20) + n * W / 2, c - t * L / 2 + n * W / 2])
            parts = [self.part(hull, -6, 12, "hull"), self.part(hull.buffer(-1), 6, 0.6, "deck_red"),
                     self.part(rect(c - t * (L / 2 - 16), t, 18, W - 4), 6, 18, "plaster_white"),
                     self.part(rect(c - t * (L / 2 - 20), t, 5, 5), 24, 8, "hull")]
            for k in range(int((L - 60) // 14)):
                q = c - t * (L / 2 - 40) + t * k * 14
                lv = int(rng.integers(1, 5))
                parts.append(self.part(rect(q, t, 12.2, W - 6), 6.6, lv * 2.6, rng.choice(cols)))
            self.item("ship", parts, "port")
        for i in range(3):                           # warehouses at the back of the yard
            c = p - n * 250 + t * (-180 + i * 180)
            if float(self.height(c[0], c[1])) > 0.8:
                z = float(self.height(c[0], c[1]))
                self.item("warehouse", [self.part(rect(c, t, 150, 50), z - 1, 14, "metal_roof")], "port")
        self.blocked.append(unary_union([quay, yard, rect(p - n * 250, t, 600, 90)]).buffer(10))
        return p

    def lighthouse(self):
        P, Nrm = self.coast_points()
        d = np.linalg.norm(P - self.core, axis=1)
        h = self.height(P[:, 0], P[:, 1])
        order = np.argsort(-d)
        for k in order:
            p = P[k] - Nrm[k] * 10
            if Point(p).buffer(30).intersects(self.roads_u) or d[k] > 4300:
                continue
            z = float(self.height(p[0], p[1]))
            parts = [self.part(Point(p).buffer(4.5 - i * 0.3, resolution=4), z - 1 + i * 6, 6, "ad_red" if i % 2 else "plaster_white")
                     for i in range(5)]
            parts += [self.part(Point(p).buffer(5.5, resolution=4), z + 29, 0.6, "metal"),
                      self.part(Point(p).buffer(2.6, resolution=4), z + 29.6, 3.5, "lamp"),
                      self.part(Point(p).buffer(3, resolution=4), z + 33.1, 1.5, "ad_red"),
                      self.part(rect(p - Nrm[k] * 12, np.array([-Nrm[k][1], Nrm[k][0]]), 10, 8), z - 1, 5, "plaster_white")]
            self.item("lighthouse", parts, "landmark")
            return p
        return None

    # -------------------------------------------------------------- hills: wind farm, TV tower
    def wind_farm(self, count=36, spacing=260.0):
        xs = np.arange(-4300, 4300, 60.0)
        X, Y = np.meshgrid(xs, xs)
        X, Y = X.ravel(), Y.ravel()
        h = self.height(X, Y)
        ring = np.stack([self.height(X + 200 * np.cos(a), Y + 200 * np.sin(a)) for a in np.linspace(0, 6.28, 8, endpoint=False)], 1)
        prom = h - ring.mean(1)
        ok = (h > 40) & (h < 420) & (prom > 6) & (np.hypot(X - self.core[0], Y - self.core[1]) > 2200)
        idx = np.flatnonzero(ok)[np.argsort(-prom[ok])]
        self.wind = []
        for k in idx:
            p = np.array([X[k], Y[k]])
            if any(np.hypot(*(p - q[:2])) < spacing for q in self.wind):
                continue
            if Point(p).buffer(45).intersects(self.roads_u):
                continue
            self.wind.append([round(p[0], 1), round(p[1], 1), round(float(h[k]) - 0.5, 1), 0.0])
            self.blocked.append(Point(p).buffer(30))
            if len(self.wind) >= count:
                break
        return self.wind

    def tv_tower(self, radius=3000.0):
        xs = np.arange(-4300, 4300, 30.0)
        X, Y = np.meshgrid(xs, xs)
        X, Y = X.ravel(), Y.ravel()
        near = np.hypot(X - self.core[0], Y - self.core[1]) < radius
        X, Y = X[near], Y[near]
        h = self.height(X, Y)
        for k in np.argsort(-h):
            p = np.array([X[k], Y[k]])
            if not Point(p).buffer(40).intersects(self.roads_u):
                break
        z = float(h[k]) - 1
        c = Point(p)
        parts = [self.part(c.buffer(16, resolution=3), z, 14, "concrete"),
                 self.part(c.buffer(5.5, resolution=6), z, 175, "plaster_white"),
                 self.part(c.buffer(16, resolution=8), z + 140, 4, "plaster_white"),
                 self.part(c.buffer(14, resolution=8), z + 144, 9, "glass_teal"),
                 self.part(c.buffer(12, resolution=8), z + 153, 4, "plaster_white"),
                 self.part(c.buffer(2, resolution=3), z + 175, 70, "ad_red")]
        for i in range(3):
            parts.append(self.part(c.buffer(3 - i * 0.6, resolution=3), z + 190 + i * 15, 2, "plaster_white"))
        self.item("tv_tower", parts, "landmark")
        self.blocked.append(c.buffer(40))
        return p

    # -------------------------------------------------------------- street furniture with presence
    def footbridges(self, every=650.0):
        """Pedestrian overpasses: a deck over the carriageway with stair towers on both kerbs."""
        cls = self.roads["classes"]
        for e in self.roads["edges"]:
            c = e["cls"]
            if not (c in ("avenue", "boulevard") or c.startswith("fw1")):
                continue
            P = np.asarray(e["pts"], float)
            if np.hypot(*(P[len(P) // 2, :2] - self.core)) > 2400:
                continue
            S = np.r_[0, np.cumsum(np.hypot(*np.diff(P[:, :2], axis=0).T))]
            off_grade = np.asarray(e["tunnel"], bool) | np.asarray(e["elev"], bool)
            for s in np.arange(every / 2 + self.rng.uniform(0, 200), S[-1] - 120, every):
                k = int(np.searchsorted(S, s))
                if k <= 0 or k >= len(P) - 1 or off_grade[max(k - 3, 0):k + 4].any():
                    continue
                t, n = _frame(P[k - 1, :2], P[k + 1, :2])
                z = float(P[k, 2])
                half = cls[c]["hwt"] + (6 if c.startswith("fw") else 1.5)
                a, b = P[k, :2] - n * half, P[k, :2] + n * half
                ga, gb = float(self.height(*a)), float(self.height(*b))
                if min(ga, gb) < 0.8:
                    continue
                deck = z + (6.2 if c.startswith("fw") else 5.6)
                span = LineString([a, b])
                parts = [self.part(span.buffer(1.8, cap_style="flat"), deck, 0.9, "concrete"),
                         self.part(span.buffer(1.8, cap_style="flat").exterior.buffer(0.12), deck + 0.9, 1.2, "glass_silver"),
                         self.part(span.buffer(2.1, cap_style="flat"), deck + 3.4, 0.3, "metal")]
                for p, g in ((a, ga), (b, gb)):
                    parts.append(self.part(rect(p, t, 6, 5), g - 0.5, deck - g + 3.8, "glass_teal"))
                self.item("footbridge", parts, "civic")
                self.blocked.append(unary_union([Point(a).buffer(8), Point(b).buffer(8)]))

    def metro(self, radius=1800.0):
        """Underground entrances: a glass canopy and an 'M' pylon at junction corners near the core."""
        cls = self.roads["classes"]
        deg = {}
        for e in self.roads["edges"]:
            for i in e["n"]:
                deg.setdefault(i, []).append(e)
        for nd in self.roads["nodes"]:
            es = deg.get(nd["id"], [])
            p = np.asarray(nd["p"][:2])
            if len(es) < 3 or np.hypot(*(p - self.core)) > radius or self.rng.random() > 0.55:
                continue
            if not all(e["cls"] in ("avenue", "boulevard", "street") for e in es):
                continue
            W = max(cls[e["cls"]]["hwt"] for e in es) + 9
            for ang in self.rng.choice(4, 2, replace=False) * np.pi / 2 + np.pi / 4:
                q = p + W * np.array([np.cos(ang), np.sin(ang)])
                if Point(q).buffer(3).intersects(self.roads_u.buffer(-3.5)):
                    continue
                z = float(self.height(*q)) - 0.3
                t = np.array([np.cos(ang + np.pi / 2), np.sin(ang + np.pi / 2)])
                self.item("metro", [self.part(rect(q, t, 7, 3.4).exterior.buffer(0.1), z, 1.1, "metal"),
                                    self.part(rect(q, t, 7.6, 4), z + 2.6, 0.25, "glass_teal"),
                                    self.part(rect(q, t, 7.6, 4).exterior.buffer(0.1), z, 2.6, "metal"),
                                    self.part(Point(q + t * 5).buffer(0.2), z, 4, "metal"),
                                    self.part(rect(q + t * 5, t, 1.4, 0.3), z + 4, 1.4, "metro_red")], "civic")
                self.blocked.append(Point(q).buffer(6))

    def arch(self):
        """Triumphal arch straddling the boulevard closest to the core."""
        cls = self.roads["classes"]
        best = None
        for e in self.roads["edges"]:
            if e["cls"] != "boulevard" or any(e["tunnel"]) or any(e["elev"]):
                continue
            P = np.asarray(e["pts"], float)
            d = np.hypot(*(P[:, :2] - self.core).T)
            k = int(np.clip(np.argmin(d), 3, len(P) - 4))
            if best is None or d[k] < best[0]:
                best = (d[k], e, P, k)
        if best is None:
            return
        _, e, P, k = best
        t, n = _frame(P[k - 2, :2], P[k + 2, :2])
        z = float(P[k, 2])
        half = cls["boulevard"]["hwt"] + 1
        parts = []
        for sd in (-1, 1):
            c = P[k, :2] + n * sd * (half + 6)
            parts.append(self.part(rect(c, t, 14, 12), z - 1, 30, "stone"))
            parts.append(self.part(rect(c, t, 16, 14), z - 1, 2, "stone"))
        span = rect(P[k, :2], t, 14, 2 * half + 24)
        parts += [self.part(span, z + 29, 8, "stone"), self.part(rect(P[k, :2], t, 15, 2 * half + 25), z + 37, 1.2, "stone"),
                  self.part(rect(P[k, :2], t, 6, 14), z + 38.2, 6, "bronze")]
        self.item("arch", parts, "landmark")
        self.blocked.append(unary_union([Point(P[k, :2] + n * sd * (half + 6)).buffer(14) for sd in (-1, 1)]))

    def ferris_wheel(self, near):
        """Big wheel on the shore close to `near` (waterfront promenade)."""
        P, Nrm = self.coast_points()
        d = np.hypot(*(P - near).T)
        for k in np.argsort(d):
            c = P[k] - Nrm[k] * 30
            site = Point(c).buffer(45)
            if site.intersects(self.roads_u) or any(site.intersects(b) for b in self.blocked):
                continue
            z = float(self.height(*c))
            if z < 1:
                continue
            t = np.array([-Nrm[k][1], Nrm[k][0]])           # wheel plane faces the water
            R, hub = 38.0, z + 44
            parts = [self.part(rect(c + t * dx, Nrm[k], 1.2, 1.2), z, hub - z, "steel") for dx in (-10, 10)]
            parts.append(self.part(rect(c, t, 22, 2), hub - 1, 2, "steel"))
            for i in range(40):
                a = 2 * np.pi * i / 40
                q = c + t * R * np.cos(a)
                parts.append(self.part(rect(q, t, 6.2, 1.0), hub + R * np.sin(a) - 0.5, 1.0, "wheel_white"))
                if i % 4 == 0:
                    parts.append(self.part(rect(q, t, 3, 3), hub + R * np.sin(a) - 3.5, 3, self.rng.choice(ADS)))
            for i in range(12):                                   # spokes as dotted rays
                a = 2 * np.pi * i / 12
                for f in np.linspace(0.15, 0.9, 6):
                    q = c + t * R * f * np.cos(a)
                    parts.append(self.part(rect(q, t, 0.7, 0.7), hub + R * f * np.sin(a) - 0.35, 0.7, "steel"))
            self.G.ground(site, "plaza")
            self.item("ferris_wheel", parts, "landmark")
            self.blocked.append(site.buffer(5))
            return c

    def masts(self, count=10, spacing=700.0):
        """Guyed radio / cell masts on prominent hilltops, banded red-white for aviation."""
        xs = np.arange(-4300, 4300, 80.0)
        X, Y = np.meshgrid(xs, xs)
        X, Y = X.ravel(), Y.ravel()
        h = self.height(X, Y)
        ring = np.stack([self.height(X + 300 * np.cos(a), Y + 300 * np.sin(a)) for a in np.linspace(0, 6.28, 8, endpoint=False)], 1)
        prom = h - ring.mean(1)
        idx = np.argsort(-prom)
        placed = [np.asarray(w[:2]) for w in self.wind]
        out = 0
        for k in idx[:4000]:
            p = np.array([X[k], Y[k]])
            if prom[k] < 10 or h[k] < 20 or any(np.hypot(*(p - q)) < spacing for q in placed):
                continue
            if Point(p).buffer(30).intersects(self.roads_u):
                continue
            z = float(h[k]) - 0.5
            H = float(self.rng.uniform(60, 110))
            seg = H / 8
            parts = [self.part(Point(p).buffer(1.0, cap_style="square"), z + i * seg, seg, "ad_red" if i % 2 else "plaster_white")
                     for i in range(8)]
            parts.append(self.part(rect(p, np.array([1.0, 0]), 4, 4), z, 3, "concrete"))
            for a in (0, 2.09, 4.19):                          # dish / panels at two heights
                q = p + 1.6 * np.array([np.cos(a), np.sin(a)])
                parts.append(self.part(Point(q).buffer(0.8, resolution=3), z + H * 0.55, 2.4, "plaster_white"))
                parts.append(self.part(Point(q).buffer(0.6, resolution=2), z + H * 0.8, 1.8, "metal"))
            self.item("mast", parts, "landmark")
            # guy wires down to three anchors
            for a in (0.5, 2.6, 4.7):
                g = p + H * 0.45 * np.array([np.cos(a), np.sin(a)])
                gz = float(self.height(*g))
                self.cables.append([[p[0], p[1], z + H * 0.75], [round(g[0], 1), round(g[1], 1), gz]])
            placed.append(p)
            out += 1
            if out >= count:
                break

    # -------------------------------------------------------------- rail network
    def spur(self, end, tangent, ring):
        """Connector from a line end (heading `tangent`) onto the ring railway: a cubic Hermite
        curve that leaves along the line and merges along the ring; grade blended, piers where high."""
        R = np.asarray(ring, float)
        a, za = np.asarray(end[:2], float), float(end[2])
        # join where the level difference fits the spur length at 3 %, preferring short spurs ahead
        d = np.hypot(*(R[:, :2] - a).T)
        ahead = (R[:, :2] - a) @ tangent > 0
        need = np.abs(R[:, 2] - za) / 0.03
        # long enough to bridge the loop freeway (+7.5 m) and come back down at 3 % (~250 m each way)
        cost = np.where(ahead & (d > 450), np.maximum(need + 500 - d, 0) * 5 + np.abs(d - 700), np.inf)
        k = int(np.argmin(cost))
        b, zb = R[k, :2], float(R[k, 2])
        tb = R[min(k + 1, len(R) - 1), :2] - R[max(k - 1, 0), :2]
        tb /= np.linalg.norm(tb) or 1
        if np.dot(tb, b - a) < 0:
            tb = -tb
        d = np.linalg.norm(b - a)
        u = np.linspace(0, 1, max(8, int(d / 4)))[:, None]
        h00, h10, h01, h11 = 2 * u**3 - 3 * u**2 + 1, u**3 - 2 * u**2 + u, -2 * u**3 + 3 * u**2, u**3 - u**2
        P = h00 * a + h10 * tangent * d * 1.2 + h01 * b + h11 * tb * d * 1.2
        Z, g = self.rail_profile(P)
        return P, Z, g, k

    def rail_network(self, lines, ring_host=("Meridian Loop A", "Meridian Loop B"), grade=0.03):
        """Ring railway around the loop freeway, every radial line tied into it at both ends.
        Joint levels are settled first, then every piece is re-profiled with them as fixed points.
        Returns (ring pts, train routes [(polyline, closed)])."""
        ring, _, _ = self.railway(*ring_host, emit=False)
        Rr, base_r = ring[:, :2], self.last_base
        Zr = ring[:, 2]
        pieces = []                                            # (line idx, side, spur P, ring k)
        L = []
        for li, (pts, base_l, ends) in enumerate(lines):
            P = np.asarray(pts, float)
            L.append([P, base_l, []])
            for side, (end, inner) in enumerate(((P[0], P[min(6, len(P) - 1)]), (P[-1], P[max(-7, -len(P))]))):
                if not ends[side]:                             # terminus: no connection at this end
                    continue
                t = end[:2] - inner[:2]; t /= np.linalg.norm(t) or 1
                Ps, Zs, gs, k = self.spur(end, t, ring)
                pieces.append((li, side, Ps, k))
        # joints: every pair of touching points is raised to their common maximum until stable
        fl_r, fl_l, fl_s = [], [[] for _ in L], [[] for _ in pieces]
        for _ in range(6):
            Zr, gr = self.rail_profile(Rr, base_r, floors=fl_r)
            Zl = [self.rail_profile(P[:, :2], base_l, floors=fl_l[i]) for i, (P, base_l, _) in enumerate(L)]
            Zs = [self.rail_profile(Ps, floors=fl_s[n]) for n, (_, _, Ps, _) in enumerate(pieces)]
            moved = False
            zc = max(Zr[0], Zr[-1])
            new_r, new_l, new_s = [(0, zc), (len(Rr) - 1, zc)], [[] for _ in L], [[] for _ in pieces]
            for n, (li, side, Ps, k) in enumerate(pieces):
                e = 0 if side == 0 else len(L[li][0]) - 1
                j0 = max(Zl[li][0][e], Zs[n][0][0])
                j1 = max(Zs[n][0][-1], Zr[k])
                new_l[li].append((e, j0)); new_s[n] += [(0, j0), (len(Ps) - 1, j1)]; new_r.append((k, j1))
                moved |= abs(Zl[li][0][e] - Zs[n][0][0]) > 0.01 or abs(Zs[n][0][-1] - Zr[k]) > 0.01
            moved |= abs(Zr[0] - Zr[-1]) > 0.01
            fl_r, fl_l, fl_s = new_r, new_l, new_s
            if not moved:
                break
        self.emit_rail(Rr, Zr, gr)
        self.lines = []
        for (P, _, _), (Z_, g_) in zip(L, Zl):
            self.emit_rail(P[:, :2], Z_, g_)
            self.lines.append(np.column_stack([P[:, :2], Z_]))
        final = []
        for (_, _, Ps, _), (Z_, g_) in zip(pieces, Zs):
            self.emit_rail(Ps, Z_, g_)
            final.append(np.column_stack([Ps, Z_]))
        ring = np.column_stack([Rr, Zr]); ring[-1] = ring[0]
        routes = [(ring, True)]
        for li in range(len(L)):
            mine = [(side, final[n]) for n, (lj, side, _, _) in enumerate(pieces) if lj == li]
            head = [f[::-1] for sd, f in mine if sd == 0]
            tail = [f for sd, f in mine if sd == 1]
            routes.append((np.vstack(head + [self.lines[li]] + tail), False))
        return ring, routes
