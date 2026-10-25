"""Building footprints filling the city blocks, from the exported road and terrain layers.

    python3 -m vespera.buildings          (reads city/data/roads.json + terrain.json, writes buildings.json)

Blocks are the faces left between road corridors. Each block is split recursively across its
longest side into lots; a lot becomes a footprint if it is on dry, moderately flat ground.
Density (lot size, floors) falls off with distance from the downtown core, which is the
densest cluster of avenue/boulevard junctions. Rural roads get a sparse frontage of houses.
"""
import json
import os
import sys
from collections import Counter

import numpy as np
from shapely import STRtree
from shapely.affinity import rotate
from shapely.geometry import LineString, MultiPolygon, Point, Polygon, box
from shapely.ops import unary_union

DATA = os.path.join(os.path.dirname(__file__), "..", "data")

URBAN = {"boulevard", "avenue", "street", "lane", "industrial"}
SETBACK = 3.0            # kerb line -> block edge
CLEAR = 2.0
FLOOR = 3.3
MAX_SLOPE = 0.18
MIN_BLOCK, MAX_BLOCK = 1500.0, 400_000.0   # m²: slivers / open country
CORE_R = 2600.0          # density reaches its floor this far from the core
CORE_D = 0.28            # downtown radius as a fraction of CORE_R
LANDMARKS = 5            # tallest towers on the biggest lots nearest the core


def load(name):
    return json.load(open(os.path.join(DATA, name + ".json")))


def zone(d, industrial):
    """(lot area target m², floors range, inner setback) for normalised core distance d in [0, 1]."""
    if industrial:
        return 3500.0, (1, 2), 6.0, "industrial"
    if d < CORE_D:
        return 1600.0, (14, 45), 2.0, "downtown"
    if d < 0.45:
        return 700.0, (5, 14), 2.5, "midtown"
    if d < 0.7:
        return 350.0, (2, 5), 3.0, "residential"
    return 260.0, (1, 3), 3.5, "suburb"


GLASS = ["glass_blue", "glass_teal", "glass_dark", "glass_silver"]
MASONRY = ["brick", "brick_dark", "concrete", "plaster_beige", "plaster_white"]
PLASTER = ["plaster_white", "plaster_beige", "plaster_peach", "plaster_mint", "brick"]


def ring(poly):
    return np.round(np.asarray(poly.exterior.coords)[:-1], 1).tolist()


def part(poly, z, h, m):
    if not isinstance(poly, Polygon):          # clipped into pieces: keep the main one
        poly = max(polys(poly), key=lambda q: q.area)
    d = {"p": ring(poly), "z": round(float(z), 2), "h": round(float(h), 2), "m": m}
    if poly.interiors:
        d["holes"] = [np.round(np.asarray(i.coords)[:-1], 1).tolist() for i in poly.interiors]
    return d


def polys(g):
    return [q for q in getattr(g, "geoms", [g]) if isinstance(q, Polygon) and not q.is_empty]


class Generator:
    """Turns blocks and lots into building parts, ground surfaces and trees."""

    def __init__(self, rng, height, out, surf, trees):
        self.rng, self.height, self.out, self.surf, self.trees = rng, height, out, surf, trees

    def flat(self, poly):
        Q = np.asarray(poly.exterior.coords)
        hz = self.height(Q[:, 0], Q[:, 1])
        if hz.min() < 1.0 or (hz.max() - hz.min()) / max(np.sqrt(poly.area), 8.0) > MAX_SLOPE:
            return None
        return float(hz.min()) - 0.5   # sink the plinth into the slope

    def add(self, typ, zone, parts):
        self.out.append({"type": typ, "zone": zone, "parts": parts})
        return self.out[-1]

    def ground(self, poly, m, cell=24.0):
        """Flat surfaces, diced into grid cells so the viewer can drape them on the terrain."""
        if poly.area > cell * cell * 2:
            x0, y0, x1, y1 = poly.bounds
            cells = [box(x, y, x + cell, y + cell) for x in np.arange(x0, x1, cell) for y in np.arange(y0, y1, cell)]
            poly = [q for c in cells for q in polys(poly.intersection(c))]
        else:
            poly = polys(poly)
        for q in poly:
            if q.area > 2:
                d = {"p": ring(q), "m": m}
                if q.interiors:
                    d["holes"] = [np.round(np.asarray(i.coords)[:-1], 1).tolist() for i in q.interiors]
                self.surf.append(d)

    def scatter(self, poly, per_m2, jitter=True):
        n = int(poly.area * per_m2 * self.rng.uniform(0.6, 1.2))
        if n <= 0:
            return
        x0, y0, x1, y1 = poly.bounds
        P = self.rng.uniform([x0, y0], [x1, y1], (n * 3, 2))
        from shapely import contains_xy
        P = P[contains_xy(poly, P[:, 0], P[:, 1])][:n]
        if len(P):
            z = self.height(P[:, 0], P[:, 1])
            self.trees.extend(np.column_stack([P, z])[z > 0.8].tolist())

    def yard(self, lot):
        if self.rng.random() < 0.5:
            self.scatter(lot.buffer(-3), 1 / 180)

    def park(self, poly, density=1.0):
        for q in polys(poly):
            self.ground(q, "grass")
            pond = None
            if q.area > 15000 and self.rng.random() < 0.5:
                c = q.representative_point()
                pond = c.buffer(self.rng.uniform(15, min(45, np.sqrt(q.area) * 0.18)), resolution=8)
                pond = pond.intersection(q.buffer(-10))
                self.ground(pond, "pond")
            if q.area > 25000 and pond is None:
                zc = self.flat(q.representative_point().buffer(16))
                if zc is not None:
                    self.fountain(q.representative_point(), zc, 9)
            paths = q.buffer(-8)
            self.scatter(q.difference(pond) if pond is not None else q, density / 220)
            if not paths.is_empty and paths.area > 2000:
                self.ground(paths.exterior.buffer(1.6) if isinstance(paths, Polygon) else paths.boundary.buffer(1.6), "path")

    def plaza(self, poly):
        """Paved square: lawns, tree rows, a fountain in the middle (big ones) or a pavilion."""
        self.ground(poly, "plaza")
        c = poly.centroid
        inner = poly.buffer(-12)
        if poly.area > 9000 and isinstance(inner, Polygon):
            lawns = inner.difference(c.buffer(30)).difference(
                unary_union([LineString([c.coords[0], q]).buffer(5) for q in inner.exterior.coords[::max(1, len(inner.exterior.coords) // 4)]]))
            self.ground(lawns, "grass")
            self.scatter(lawns.buffer(-3), 1 / 350)
            z = self.flat(c.buffer(20))
            if z is not None:
                self.fountain(c, z)
                for q in lawns.buffer(-8).exterior.coords[:: max(1, len(lawns.buffer(-8).exterior.coords) // 3)] if isinstance(lawns.buffer(-8), Polygon) else []:
                    self.add("statue", "downtown", [part(Point(q).buffer(1.6, cap_style="square"), z, 2.5, "concrete"),
                                                    part(Point(q).buffer(0.7, resolution=3), z + 2.5, 3, "bronze")])
            return
        self.scatter(poly.buffer(-6), 1 / 400)
        z = self.flat(c.buffer(12))
        if z is not None:
            self.add("pavilion", "downtown", [part(c.buffer(10, resolution=6), z, 7, "glass_teal")])

    def fountain(self, c, z, r=14):
        self.ground(c.buffer(r, resolution=12), "pond")
        parts = [part(c.buffer(r + 1, resolution=12).difference(c.buffer(r, resolution=12)), z, 1.2, "concrete"),
                 part(c.buffer(r * 0.3, resolution=8), z, 1.8, "concrete"),
                 part(c.buffer(r * 0.15, resolution=6), z + 1.8, 1.5, "concrete"),
                 part(c.buffer(0.6, resolution=4), z + 3.3, 4, "spray")]
        if r > 10 and self.rng.random() < 0.5:     # obelisk behind the basin
            parts.append(part(c.buffer(1.8, cap_style="square"), z + 3.3, 26, "plaster_white"))
            parts.append(part(c.buffer(0.9, cap_style="square"), z + 29.3, 3, "bronze"))
        return self.add("fountain", "civic", parts)

    # -------------------------------------------------------------- civic & special lots
    def construction(self, fp, lot, z, floors, kind):
        """Half-built tower with a tower crane."""
        self.ground(lot, "gravel")
        done = max(3, int(floors * self.rng.uniform(0.25, 0.6)))
        core = fp.buffer(-np.sqrt(fp.area) * 0.18, join_style="mitre")
        parts = [part(fp, z, done * FLOOR, "concrete")]
        for k in range(3):                              # bare slabs above the finished part
            parts.append(part(fp, z + (done + k) * FLOOR, 0.4, "deck"))
        if isinstance(core, Polygon):
            parts.append(part(core, z + done * FLOOR, 3 * FLOOR, "concrete"))
        R = np.asarray(fp.minimum_rotated_rectangle.exterior.coords)[:3]
        t = (R[1] - R[0]) / (np.linalg.norm(R[1] - R[0]) or 1)
        m = np.asarray(fp.exterior.interpolate(0.15, normalized=True).coords[0]) + (np.asarray(fp.centroid.coords[0]) - R[0]) * 0.0
        top = z + (done + 8) * FLOOR + 15
        mast = Point(m).buffer(1.2, cap_style="square")
        jib = LineString([m - t * 18, m + t * 55]).buffer(0.9, cap_style="flat")
        parts += [part(mast, z, top - z, "crane_yellow"), part(jib, top, 1.6, "crane_yellow"),
                  part(LineString([m - t * 18, m - t * 10]).buffer(2, cap_style="flat"), top - 2, 2, "concrete"),
                  part(Point(m + t * 3).buffer(1.4, cap_style="square"), top - 3, 3, "plaster_white"),
                  part(Point(m).buffer(0.5), top + 1.6, 7, "crane_yellow")]
        return self.add("construction", kind, parts)

    def church(self, fp, z, kind):
        R = np.asarray(fp.minimum_rotated_rectangle.exterior.coords)[:4]
        a, b = R[0], R[1]
        if np.linalg.norm(R[1] - R[0]) < np.linalg.norm(R[2] - R[1]):
            a, b = R[1], R[2]
        t = (b - a) / np.linalg.norm(b - a)
        c = np.asarray(fp.centroid.coords[0])
        n = np.array([-t[1], t[0]])
        L, W = min(np.linalg.norm(b - a) * 0.8, 40), min(np.sqrt(fp.area) * 0.45, 16)
        nave = Polygon([c - t * L / 2 - n * W / 2, c + t * L / 2 - n * W / 2, c + t * L / 2 + n * W / 2, c - t * L / 2 + n * W / 2])
        tw = c - t * (L / 2 + 3)
        mat = self.rng.choice(["brick", "plaster_white", "plaster_beige"])
        parts = [part(nave, z, 12, mat), part(nave.buffer(-1.5, join_style="mitre"), z + 12, 3, "roof_grey"),
                 part(nave.buffer(-4, join_style="mitre"), z + 15, 2.5, "roof_grey")]
        zt = z
        for k, (r, h) in enumerate(((4, 22), (3, 6), (2, 6), (1.2, 6), (0.5, 8))):   # stepped spire
            parts.append(part(Point(tw).buffer(r, cap_style="square"), zt, h, mat if k == 0 else "roof_grey"))
            zt += h
        return self.add("church", kind, parts)

    def school(self, fp, lot, z, kind):
        R = np.asarray(fp.minimum_rotated_rectangle.exterior.coords)[:4]
        half = Polygon([R[0], (R[0] + R[1]) / 2, (R[3] + R[2]) / 2, R[3]]).intersection(fp)
        field = Polygon([(R[0] + R[1]) / 2, R[1], R[2], (R[3] + R[2]) / 2]).intersection(fp).buffer(-3)
        if not isinstance(half, Polygon) or half.area < 300:
            return None
        self.ground(field, "track")
        self.ground(field.buffer(-6), "pitch")
        wing = half.buffer(-np.sqrt(half.area) * 0.25, join_style="mitre")
        parts = [part(half.difference(wing) if isinstance(wing, Polygon) else half, z, 3 * FLOOR, self.rng.choice(["brick", "plaster_peach"]))]
        self.scatter(wing, 1 / 120) if isinstance(wing, Polygon) else None
        return self.add("school", kind, parts)

    def hospital(self, fp, z, floors, kind):
        c = fp.centroid
        R = np.asarray(fp.minimum_rotated_rectangle.exterior.coords)[:4]
        t = (R[1] - R[0]) / np.linalg.norm(R[1] - R[0])
        n = np.array([-t[1], t[0]])
        a, b = np.linalg.norm(R[1] - R[0]) * 0.8, np.linalg.norm(R[2] - R[1]) * 0.8
        cc = np.asarray(c.coords[0])
        bar1 = Polygon([cc - t * a / 2 - n * 9, cc + t * a / 2 - n * 9, cc + t * a / 2 + n * 9, cc - t * a / 2 + n * 9]).intersection(fp)
        bar2 = Polygon([cc - n * b / 2 - t * 9, cc + n * b / 2 - t * 9, cc + n * b / 2 + t * 9, cc - n * b / 2 + t * 9]).intersection(fp)
        H = max(floors, 6) * FLOOR
        parts = [part(bar1, z, H, "plaster_white"), part(bar2, z, H * 0.7, "plaster_white"),
                 part(c.buffer(8, resolution=8), z + H, 0.4, "helipad"),
                 part(LineString([cc - t * a / 2, cc + t * a / 2]).buffer(0.6), z + H * 0.55, 1.2, "ad_red")]
        return self.add("hospital", kind, parts)

    def water_tower(self, fp, z, kind):
        c = fp.centroid
        return self.add("water_tower", kind, [part(c.buffer(1.5, resolution=3), z, 26, "concrete"),
                                              part(c.buffer(8, resolution=8), z + 26, 9, self.rng.choice(["plaster_white", "metal_blue"])),
                                              part(c.buffer(5, resolution=8), z + 35, 2, "metal")])

    def mall(self, block):
        lot = block.buffer(-4)
        if not isinstance(lot, Polygon):
            return False
        mrr = lot.minimum_rotated_rectangle
        from shapely.affinity import scale
        R = np.asarray(mrr.exterior.coords)[:3]
        k = min(0.55, 200.0 / max(np.hypot(*(R[1] - R[0])), np.hypot(*(R[2] - R[1]))))
        body = scale(mrr, k, k).intersection(lot.buffer(-25))
        body = max(polys(body), key=lambda q: q.area, default=None)
        if body is None or body.area < 2500:
            return False
        z = self.flat(body)
        if z is None:
            return False
        body = body.simplify(1)
        parts = [part(body, z, self.rng.uniform(11, 15), "plaster_white")]
        # anchor store and entrance canopy
        R = np.asarray(body.minimum_rotated_rectangle.exterior.coords)[:4]
        anchor = Polygon([R[0], R[0] + (R[1] - R[0]) * 0.3, R[3] + (R[2] - R[3]) * 0.3, R[3]])
        anchor = anchor.intersection(body).buffer(-1)
        if not isinstance(anchor, Polygon) or anchor.is_empty:
            anchor = body.buffer(-body.area ** 0.5 * 0.3)
        parts.append(part(anchor, z, self.rng.uniform(17, 22), self.rng.choice(["glass_teal", "brick"])))
        parts.append(part(body.centroid.buffer(14, resolution=4), z + 12, 6, "glass_silver"))
        self.add("mall", "commercial", parts)
        lotp = lot.difference(body.buffer(2))
        self.ground(lotp, "parking")
        for q in polys(lotp):          # tree islands across the lot
            self.scatter(q, 1 / 900)
        return True

    def stadium(self, field):
        c = field.representative_point()
        from shapely.affinity import scale
        outer = scale(c.buffer(1, resolution=24), 135, 105)
        if not field.buffer(-40).contains(outer):
            return None
        z = self.flat(outer)
        if z is None:
            return None
        pitch = scale(c.buffer(1, resolution=24), 78, 50)
        self.add("stadium", "landmark", [
            part(outer.difference(pitch.buffer(6)), z, 22, "concrete"),
            part(outer.difference(scale(c.buffer(1, resolution=24), 105, 78)), z + 22, 4, "roof_white"),
        ])
        self.ground(pitch.buffer(6), "pitch")
        self.ground(outer.buffer(60).difference(outer).intersection(field), "parking")
        return outer.buffer(60)

    def stepped(self, it, fp, z, floors, tiers=3, mat="glass_blue"):
        cur, base = fp, z
        for k in range(tiers):
            f = floors * [0.45, 0.3, 0.15, 0.1][k] if tiers == 4 else floors / tiers
            it["parts"].append(part(cur, base, f * FLOOR, mat))
            base += f * FLOOR
            nxt = cur.buffer(-max(3.0, np.sqrt(cur.area) * 0.12), join_style="mitre")
            if not isinstance(nxt, Polygon) or nxt.area < 120:
                break
            cur = nxt

    def lot(self, kind, fp, lot, z, floors, front):
        rng, r, sp = self.rng, self.rng.random(), self.rng.random()
        H = floors * FLOOR
        if kind == "downtown" and sp < 0.06:
            return self.construction(fp, lot, z, floors, kind)
        if kind == "midtown":
            if sp < 0.012 and fp.area > 1200:
                return self.hospital(fp, z, floors, kind)
            if sp < 0.03 and fp.area > 800 and self.school(fp, lot, z, kind):
                return
            if sp < 0.045 and fp.area > 500:
                return self.church(fp, z, kind)
            if sp < 0.06:
                return self.construction(fp, lot, z, floors + 4, kind)
        if kind in ("residential", "suburb"):
            if sp < 0.015 and fp.area > 400:
                return self.church(fp, z, kind)
            if sp < 0.03 and fp.area > 500 and self.school(fp, lot, z, kind):
                return
            if sp < 0.04 and kind == "suburb":
                return self.water_tower(fp, z, kind)
        if kind == "downtown":
            mat = rng.choice(GLASS) if rng.random() < 0.75 else rng.choice(MASONRY)
            if r < 0.30:
                pod = rng.integers(3, 6) * FLOOR
                tower = fp.buffer(-rng.uniform(5, 9), join_style="mitre")
                parts = [part(fp, z, pod, rng.choice(MASONRY))]
                if isinstance(tower, Polygon) and tower.area > 150:
                    parts.append(part(tower, z + pod, max(H - pod, 3 * FLOOR), mat))
                return self.add("podium_tower", kind, parts)
            if r < 0.50:
                it = self.add("stepped", kind, [])
                return self.stepped(it, fp, z, floors, 3, mat)
            if r < 0.60:
                c = fp.centroid
                rad = min(np.sqrt(fp.area / np.pi), fp.exterior.distance(c)) * 0.95
                if rad > 8:
                    return self.add("round_tower", kind, [part(c.buffer(rad, resolution=6), z, H, mat)])
            if r < 0.66:
                self.ground(lot, "plaza")
                self.scatter(lot.buffer(-4), 1 / 300)
                return
            if r < 0.72:
                return self.garage(fp, z, rng.integers(5, 9), kind)
            return self.add("tower", kind, [part(fp, z, H, mat)])
        if kind == "midtown":
            mat = rng.choice(MASONRY) if rng.random() < 0.8 else rng.choice(GLASS)
            if r < 0.25 and fp.area > 900:
                court = fp.buffer(-rng.uniform(9, 13), join_style="mitre")
                if isinstance(court, Polygon) and court.area > 120:
                    self.scatter(court.buffer(-2), 1 / 150)
                    return self.add("courtyard", kind, [part(fp.difference(court), z, H, mat)])
            if 0.25 <= r < 0.30:
                return self.garage(fp, z, rng.integers(3, 6), kind)
            if r < 0.32 and front and fp.area > 500:
                return self.gas_station(fp, lot, z, kind)
            if r < 0.50:
                R = np.asarray(fp.minimum_rotated_rectangle.exterior.coords)[:4]
                cut = Polygon([R[2], R[2] + (R[3] - R[2]) * 0.5, (R[0] + R[2]) / 2, R[2] + (R[1] - R[2]) * 0.5])
                L = fp.difference(cut.buffer(1))
                if isinstance(L, Polygon):
                    self.ground(cut.intersection(lot), "parking")
                    return self.add("l_block", kind, [part(L, z, H, mat), part(L.buffer(-1.5), z + H, 3, "metal")])
            parts = [part(fp, z, H, mat)]
            if rng.random() < 0.4:   # rooftop plant room
                parts.append(part(fp.centroid.buffer(min(6, np.sqrt(fp.area) * 0.2), resolution=2), z + H, 3.5, "metal"))
            return self.add("block", kind, parts)
        if kind == "industrial":
            parts = [part(fp, z, H + 4, rng.choice(["metal_roof", "concrete", "metal_blue"]))]
            if rng.random() < 0.3:     # silo / chimney
                c = fp.exterior.interpolate(rng.random(), normalized=True)
                parts.append(part(c.buffer(rng.uniform(3, 6), resolution=4), z, rng.uniform(15, 35), "concrete"))
            self.ground(lot.difference(fp), "parking")
            return self.add("warehouse", kind, parts)
        # residential / suburb: smaller house on the lot, rest is yard
        if r < 0.015 and front and fp.area > 400:
            return self.gas_station(fp, lot, z, kind)
        if r < 0.12 and front and fp.area > 300:   # corner shop with its lot
            shop = fp.buffer(-np.sqrt(fp.area) * 0.18, join_style="mitre")
            if isinstance(shop, Polygon):
                self.ground(fp.difference(shop), "parking")
                return self.add("shop", kind, [part(shop, z, 4.5, rng.choice(PLASTER)),
                                               part(shop.buffer(1.2).difference(shop), z + 3.2, 0.5, "canopy_red")])
        house = fp.buffer(-np.sqrt(fp.area) * rng.uniform(0.08, 0.2), join_style="mitre")
        if not isinstance(house, Polygon) or house.area < 50:
            house = fp
        yard = lot.difference(house.buffer(2))
        if yard.area > 120 and rng.random() < 0.2:          # backyard pool
            far = max(polys(yard), key=lambda q: q.area).representative_point()
            pool = far.buffer(rng.uniform(2.5, 4), cap_style="square").intersection(yard)
            self.ground(pool, "pool")
            yard = yard.difference(pool.buffer(1.5))
        self.scatter(yard, 1 / 160)
        roof_m = rng.choice(["roof_red", "roof_grey", "roof_brown"])
        parts = [part(house, z, H, rng.choice(PLASTER)), part(house.buffer(0.5, join_style="mitre"), z + H, 0.35, roof_m)]
        step = np.sqrt(house.area) * 0.11                   # hip roof as shrinking tiers
        for k in range(1, 5):
            tier = house.buffer(-step * k, join_style="mitre")
            if not isinstance(tier, Polygon) or tier.area < 6:
                break
            parts.append(part(tier, z + H + 0.35 + (k - 1) * 0.9, 0.9, roof_m))
        if rng.random() < 0.35:                             # chimney
            parts.append(part(house.buffer(-step).exterior.interpolate(rng.random(), normalized=True).buffer(0.5, cap_style="square"),
                              z + H, 4.5, "brick_dark"))
        return self.add("house", kind, parts)

    def garage(self, fp, z, levels, kind):
        parts = [part(fp, z + k * 3.0, 0.6, "deck") for k in range(int(levels) + 1)]
        core = fp.exterior.interpolate(0.1, normalized=True).buffer(4, cap_style="square").intersection(fp)
        parts.append(part(core, z, levels * 3.0 + 3, "concrete"))
        parts.append(part(fp.buffer(-0.3).exterior.buffer(0.3), z, 1.1, "concrete"))
        return self.add("garage", kind, parts)

    def gas_station(self, fp, lot, z, kind):
        self.ground(lot, "parking")
        R = np.asarray(fp.minimum_rotated_rectangle.exterior.coords)[:4]
        shop = Polygon([R[0], R[0] + (R[1] - R[0]) * 0.35, R[3] + (R[2] - R[3]) * 0.35, R[3]]).buffer(-1)
        canopy = fp.centroid.buffer(min(11, np.sqrt(fp.area) * 0.3), cap_style="square")
        parts = [part(shop, z, 4.2, "plaster_white"), part(canopy, z + 5, 0.9, "canopy_red")]
        for p in np.asarray(canopy.buffer(-2.5, join_style="mitre").exterior.coords)[:4]:
            parts.append(part(Point(p).buffer(0.35, cap_style="square"), z, 5, "metal"))
        return self.add("gas_station", kind, parts)


def carve(block, L, W, rng):
    """A street-side L x W site cut out of a big block -> (site, rest or None).
    Blocks already about that size are used whole."""
    if block.area < L * W * 1.6:
        return block, []
    for _ in range(6):
        site, rest = _carve_once(block, L, W, rng)
        if site is not None:
            return site, rest
    return None, []


def _carve_once(block, L, W, rng):
    ring_ = block.exterior
    s = rng.uniform(0, ring_.length)
    a, b = ring_.interpolate(s), ring_.interpolate(s + 2)
    t = np.array([b.x - a.x, b.y - a.y]); t /= np.linalg.norm(t) or 1
    n = np.array([-t[1], t[0]])
    c = np.array([a.x, a.y])
    if not block.contains(Point(c + n * 5)):
        n = -n
    m = c + n * W / 2
    site = Polygon([m - t * L / 2 - n * W / 2, m + t * L / 2 - n * W / 2, m + t * L / 2 + n * W / 2, m - t * L / 2 + n * W / 2])
    site = site.intersection(block)
    site = max(polys(site), key=lambda q: q.area, default=None)
    if site is None or site.area < L * W * 0.45:
        return None, []
    rest = sorted(polys(block.difference(site.buffer(6))), key=lambda q: -q.area)
    return site, rest


def split(poly, target, rng, out, depth=0):
    """Recursive cut across the longest side of the minimum rotated rectangle."""
    if poly.area <= target * 1.6 or depth > 14:
        out.append(poly)
        return
    R = np.asarray(poly.minimum_rotated_rectangle.exterior.coords)[:4]
    e0, e1 = R[1] - R[0], R[2] - R[1]
    long_ = e0 if np.hypot(*e0) >= np.hypot(*e1) else e1
    ang = np.degrees(np.arctan2(long_[1], long_[0]))
    c = poly.centroid
    p = rotate(poly, -ang, origin=c)
    x0, y0, x1, y1 = p.bounds
    t = rng.uniform(0.4, 0.6)
    xm = x0 + (x1 - x0) * t
    for half in (box(x0 - 1, y0 - 1, xm, y1 + 1), box(xm, y0 - 1, x1 + 1, y1 + 1)):
        g = rotate(p.intersection(half), ang, origin=c)
        for q in (g.geoms if isinstance(g, MultiPolygon) else [g]):
            if isinstance(q, Polygon) and q.area > 40:
                split(q, target, rng, out, depth + 1)


def build(roads, ter, seed=7):
    rng = np.random.default_rng(seed)
    nx, ny, x0, y0, res = ter["nx"], ter["ny"], ter["x0"], ter["y0"], ter["res"]
    H = np.asarray(ter["h"], float).reshape(ny, nx)

    def height(x, y):
        i = np.clip(((np.asarray(x) - x0) / res).astype(int), 0, nx - 1)
        j = np.clip(((np.asarray(y) - y0) / res).astype(int), 0, ny - 1)
        return H[j, i]

    cls = roads["classes"]
    corr, urban_pts, core_pts = [], [], []
    for e in roads["edges"]:
        P = np.asarray(e["pts"])[:, :2]
        if len(P) < 2:
            continue
        w = cls[e["cls"]]["hwt"] + SETBACK + (14.0 if e["cls"].startswith(("fw", "ramp")) else 0.0)
        corr.append(LineString(P).buffer(w, resolution=4))
        if e["cls"] in URBAN:
            urban_pts.append(P)
        if e["cls"] in ("avenue", "boulevard"):
            core_pts.append(P[[0, -1]])
    roads_u = unary_union(corr)

    # downtown core: the point with the most avenue/boulevard edge ends within 700 m
    C = np.vstack(core_pts)
    D = np.hypot(*(C[:, None] - C[None]).transpose(2, 0, 1))
    core = C[np.argmax((D < 700).sum(1))]

    # blocks: everything between corridors inside the urban footprint
    U = np.vstack(urban_pts)
    area = unary_union([LineString(P).buffer(450, resolution=4) for P in urban_pts])
    faces = area.difference(roads_u)
    blocks = [g for g in getattr(faces, "geoms", [faces]) if MIN_BLOCK < g.area < MAX_BLOCK]
    ind_lines = [LineString(np.asarray(e["pts"])[:, :2]) for e in roads["edges"] if e["cls"] == "industrial"]
    ind_tree = STRtree(ind_lines) if ind_lines else None
    roads_tree = STRtree(list(getattr(roads_u, "geoms", [roads_u])))

    out, surf, trees = [], [], []
    G = Generator(rng, height, out, surf, trees)

    # infrastructure first; lots and parks stay off whatever it occupies
    from .features import Features
    F = Features(G, roads, core, roads_u, area)
    lines = []
    for host, other in (("Bay Route A", "Bay Route B"), ("Sunset Expressway A", "Sunset Expressway B")):
        pts, _, _ = F.railway(host, other, emit=False)
        base = F.last_base
        # rail can't follow a freeway over a mountain pass: stop at a terminus before the climb
        high = np.flatnonzero(base > base[:40].min() + 45) if base[0] < base[-1] else np.flatnonzero(base > base[-40:].min() + 45)
        if len(high):
            if base[0] < base[-1]:
                cut = max(high[0] - 30, 50)
                pts, base, ends = pts[:cut], base[:cut], (True, False)
            else:
                cut = min(high[-1] + 30, len(pts) - 50)
                pts, base, ends = pts[cut:], base[cut:], (False, True)
        else:
            ends = (True, True)
        lines.append((pts, base, ends))
    ring, routes = F.rail_network(lines)
    F.level_crossings()
    for pts in F.lines:                  # stations only where the final line runs at grade over dry land
        T_ = np.gradient(pts[:, :2], axis=0); T_ /= np.linalg.norm(T_, axis=1)[:, None] + 1e-9
        N_ = np.column_stack([-T_[:, 1], T_[:, 0]])          # station() picks the side clear of roads
        gz = height(pts[:, 0], pts[:, 1])
        ok = (gz > 2.0) & (np.abs(pts[:, 2] - gz) < 1.5)
        ok[:20] = ok[-20:] = False
        if not ok.any():
            continue
        dc = np.where(ok, np.hypot(*(pts[:, :2] - core).T), np.inf)
        near = int(np.argmin(dc))
        F.station(pts, T_, N_, near)
        far_d = np.where(ok, np.abs(np.arange(len(pts)) - near), -1)
        if far_d.max() > 150:
            F.station(pts, T_, N_, int(np.argmax(far_d)))
    Tr = np.gradient(ring[:, :2], axis=0); Tr /= np.linalg.norm(Tr, axis=1)[:, None] + 1e-9
    Nr = np.column_stack([-Tr[:, 1], Tr[:, 0]])
    Nr *= np.sign(np.einsum("ij,ij->i", Nr, ring[:, :2] - core))[:, None]      # platforms on the outer side
    gz = height(ring[:, 0], ring[:, 1])
    ok = np.flatnonzero((gz > 2) & (np.abs(ring[:, 2] - gz) < 1.5))
    for k in ok[np.linspace(0, len(ok) - 1, 3).astype(int)] if len(ok) > 3 else []:
        F.station(ring, Tr, Nr, int(k))
    plant = F.power_plant()
    grid_nodes = []                      # where transmission lines start / end
    if plant is not None:
        src, _ = plant
        grid_nodes.append(src)
        edge = np.asarray(area.exterior.coords if isinstance(area, Polygon) else max(area.geoms, key=lambda g: g.area).exterior.coords)
        dist = np.hypot(*(edge - src).T)
        for k in np.argsort(dist)[:: max(1, len(edge) // 9)][:3]:
            sub = src + (edge[k] - src) * (1 - 60 / max(dist[k], 61))
            F.substation(sub)
            F.power_line([src, sub])
            grid_nodes.append(sub)
    F.airport()
    port = F.port()
    F.lighthouse()
    wind = F.wind_farm()
    tv = F.tv_tower()
    F.billboards()
    F.footbridges()
    F.metro()
    F.arch()
    F.ferris_wheel(port if port is not None else core)
    F.masts()
    taken_by = unary_union(F.blocked)
    blocks = [q for b in blocks for q in polys(b.difference(taken_by)) if q.area > MIN_BLOCK]
    faces = faces.difference(taken_by)

    # stadium: the biggest open field close to the core (too big to be a block)
    fields = [g for g in getattr(faces, "geoms", [faces]) if g.area >= MAX_BLOCK]
    fields = [g for g in fields if np.hypot(*(np.array(g.centroid.coords[0]) - core)) < 0.6 * CORE_R]
    taken = None
    for g in fields:
        taken = G.stadium(g)
        if taken is not None:
            break
    for g in fields:
        G.park(g.buffer(-6).difference(taken) if taken is not None else g.buffer(-6), density=0.4)

    for b in blocks:
        b = b.simplify(1.0)
        c = np.array(b.centroid.coords[0])
        d = min(1.0, np.hypot(*(c - core)) / CORE_R)
        industrial = ind_tree is not None and len(ind_tree.query(b.buffer(40)))
        target, fl, inset, kind = zone(d, industrial)
        r = rng.random()
        if kind in ("midtown", "residential", "suburb") and b.area > 12000 and r < 0.10:
            G.park(b.buffer(-2))
            continue
        # big blocks host a few special sites cut from their street edge, one roll per ~50 000 m²
        if kind in ("midtown", "residential", "suburb"):
            for _ in range(1 + int(b.area // 50000)):
                if b is None or b.area < 6000:
                    break
                q = rng.random()
                if q < 0.05:
                    site, rest = carve(b, 170, 120, rng)
                    z = G.flat(site) if site is not None else None
                    ok = z is not None and G.hospital(site.buffer(-8), z, 9, kind)
                    if ok:                               # campus: lawn, front car park, tree belt
                        G.ground(site.difference(site.buffer(-14)), "parking")
                        G.ground(site.buffer(-14), "grass")
                        G.scatter(site.buffer(-16).difference(site.buffer(-40)), 1 / 200)
                elif q < 0.17:
                    site, rest = carve(b, 170, 120, rng)
                    z = G.flat(site) if site is not None else None
                    ok = z is not None and G.school(site.buffer(-5), site.buffer(-2), z, kind)
                elif q < 0.27:
                    site, rest = carve(b, 330, 230, rng)
                    ok = site is not None and G.mall(site)
                else:
                    continue
                if ok:
                    blocks.extend(q for q in rest[1:] if q.area > MIN_BLOCK)
                    b = rest[0] if rest else None
            if b is None:
                continue
        if kind in ("downtown", "midtown") and b.area > 6000 and r < (0.07 if kind == "downtown" else 0.03):
            G.plaza(b.buffer(-2))
            continue
        lots = []
        split(b, target, rng, lots)
        for lot in lots:
            fp = lot.buffer(-inset, join_style="mitre")
            if fp.is_empty or not isinstance(fp, Polygon) or fp.area < 60:
                continue
            fp = fp.simplify(0.8)
            if fp.area / fp.minimum_rotated_rectangle.area < 0.6:
                G.yard(lot)
                continue
            front = lot.distance(roads_u) <= 4.0
            if kind in ("residential", "suburb") and not front:
                G.yard(lot)
                continue
            z = G.flat(fp)
            if z is None:
                continue
            f = fl[0] + (fl[1] - fl[0]) * rng.random() ** (1.4 if kind == "downtown" else 1.6)
            if kind == "downtown":
                f = max(f * (1.0 - 0.45 * d / CORE_D), 10)
            G.lot(kind, fp, lot, z, int(round(f)), front)

    # landmarks: big downtown towers closest to the core get 50-70 floors and a crown
    dt = [it for it in out if it["zone"] == "downtown" and it["type"] in ("tower", "podium_tower", "stepped")]
    score = lambda it: Polygon(it["parts"][0]["p"]).area / (200.0 + np.hypot(*(np.mean(it["parts"][0]["p"], 0) - core)))
    for it in sorted(dt, key=score, reverse=True)[:LANDMARKS]:
        fp, z = Polygon(it["parts"][0]["p"]), it["parts"][0]["z"]
        it["parts"] = []
        G.stepped(it, fp, z, int(rng.integers(50, 71)), tiers=4, mat=rng.choice(GLASS))
        top = max(p["z"] + p["h"] for p in it["parts"])
        it["parts"].append(part(fp.centroid.buffer(2.5, resolution=3), top, rng.uniform(25, 45), "metal"))
        it["type"], it["zone"] = "landmark", "landmark"

    F.rooftop_ads()

    # rural frontage: a house every ~150 m on alternating sides
    for e in roads["edges"]:
        if e["cls"] != "rural" or any(e["tunnel"]) or any(e["elev"]):
            continue
        line = LineString(np.asarray(e["pts"])[:, :2])
        s, side = rng.uniform(20, 120), 1
        while s < line.length - 20:
            a, bpt = line.interpolate(s), line.interpolate(s + 1)
            t = np.array([bpt.x - a.x, bpt.y - a.y]); t /= np.linalg.norm(t) or 1
            n = np.array([-t[1], t[0]]) * side
            p0 = np.array([a.x, a.y]) + n * (cls["rural"]["hwt"] + 12)
            w, dpt = rng.uniform(9, 14), rng.uniform(8, 11)
            Q = np.array([p0, p0 + t * w, p0 + t * w + n * dpt, p0 + n * dpt])
            poly = Polygon(Q)
            hz = height(Q[:, 0], Q[:, 1])
            if hz.min() > 1.0 and (hz.max() - hz.min()) / w < MAX_SLOPE and \
                    not any(poly.intersects(roads_tree.geometries[k]) for k in roads_tree.query(poly)):
                out.append({"type": "house", "zone": "rural", "parts": [
                    part(poly, float(hz.min()) - 0.5, int(rng.integers(1, 3)) * FLOOR + 0.5, rng.choice(PLASTER))]})
            s += rng.uniform(110, 260); side = -side
    # transmission grid: plant + substations feed far consumers along a minimum spanning tree
    targets = []
    if port is not None:
        targets.append(port - (port - core) / np.linalg.norm(port - core) * 260)
    targets.append(tv + np.array([60.0, 0]))
    W = np.asarray(wind)[:, :2] if len(wind) else np.zeros((0, 2))
    if len(W):
        ang = np.arctan2(*(W - core).T[::-1])
        for a0 in np.linspace(-np.pi, np.pi, 4, endpoint=False):     # one feeder per wind cluster
            sel = W[(ang >= a0) & (ang < a0 + np.pi / 2)]
            if len(sel):
                targets.append(sel[np.argmin(np.hypot(*(sel - core).T))] + np.array([0, 40.0]))
    rur = [np.asarray(e["pts"])[:, :2] for e in roads["edges"] if e["cls"] in ("rural", "mountain")]
    if rur:
        R = np.vstack(rur)
        d = np.hypot(*(R - core).T)
        ang = np.arctan2(*(R - core).T[::-1])
        for a0 in np.linspace(-np.pi, np.pi, 6, endpoint=False):     # farthest settled road in each sector
            m = (ang >= a0) & (ang < a0 + np.pi / 3)
            if m.any():
                k = np.flatnonzero(m)[np.argmax(d[m])]
                if d[k] > 1800:
                    q = R[k] + (core - R[k]) / d[k] * 60
                    targets.append(q)
                    F.substation(q)
    if grid_nodes:
        avoid = area.buffer(60)
        done, todo = list(grid_nodes), [np.asarray(t, float) for t in targets]
        while todo:
            i, j = min(((i, j) for i in range(len(todo)) for j in range(len(done))),
                       key=lambda ij: np.linalg.norm(todo[ij[0]] - done[ij[1]]))
            F.power_line([done[j], todo[i]], avoid=avoid)
            done.append(todo.pop(i))
    F.distribution_poles()
    routes = [{"pts": np.round(r, 2).tolist(), "closed": c} for r, c in routes]
    return out, surf, trees, core, F.rails, F.cables, F.wind, routes


def main():
    roads, ter = load("roads"), load("terrain")
    items, surf, trees, core, rails, cables, wind, routes = build(roads, ter)
    path = os.path.join(DATA, "buildings.json")
    json.dump({"layer": "buildings", "core": np.round(core, 1).tolist(), "items": items, "surfaces": surf,
               "trees": np.round(trees, 1).tolist(), "rails": rails, "cables": cables, "wind": wind, "trains": routes}, open(path, "w"), separators=(",", ":"))
    print(len(items), "buildings", dict(Counter(i["type"] for i in items)), len(surf), "surfaces", len(trees), "trees",
          "core", np.round(core).tolist(), f"{os.path.getsize(path) / 1e6:.1f} MB")


if __name__ == "__main__":
    main(*sys.argv[1:])
