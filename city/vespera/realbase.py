"""Vespera Bay real-world base: OSM Vladivostok compressed into a game map.

Road and coastline data © OpenStreetMap contributors (ODbL).
Heights: AWS Terrain Tiles (terrarium; SRTM and other open sources).

Coordinates: real metres around ORIGIN are scaled by SXY horizontally and SZ
vertically; everything downstream (network, meshes) works in game metres.
"""
import math
from collections import defaultdict

import numpy as np

from . import geom, network as NW, osm, terrain as T

ORIGIN = (43.085, 131.935)
WIN = (-13000.0, -13000.0, 13000.0, 17500.0)   # real metres around ORIGIN
SXY = 0.45
SZ = 0.6
RIDGE_Y = 16300.0                               # real metres: northern mountain wall starts here
PAD = 1500.0                                    # game metres of sea / mountains around the window

KEEP = {"motorway", "trunk", "primary", "secondary", "tertiary", "unclassified",
        "motorway_link", "trunk_link", "primary_link", "secondary_link", "tertiary_link"}
BRIDGE_DECK = {"Золотой мост": 40.0, "Русский мост": 44.0}      # game metres above the water


def game_win():
    return tuple(v * SXY for v in WIN)


def to_game(lat, lon):
    x, y = osm.project(ORIGIN[0], ORIGIN[1], lat, lon)
    return np.asarray(x) * SXY, np.asarray(y) * SXY


# ------------------------------------------------------------------ data
def fetch(log=print):
    lat, lon = ORIGIN
    pad_r = PAD / SXY
    win = (WIN[0] - pad_r, WIN[1] - pad_r, WIN[2] + pad_r, WIN[3] + pad_r)
    roads = osm.fetch("vb_roads", lat, lon, WIN, f'way["highway"~"{osm.ROAD_RE}"]BBOX;', out="body geom")
    coast = osm.fetch("vb_coast", lat, lon, win, 'way["natural"="coastline"]BBOX;', out="geom")
    log(f"realbase: {len(roads['elements'])} road ways, {len(coast['elements'])} coastline ways")
    return roads, coast


# ------------------------------------------------------------------ terrain
def build_terrain(coast, res=6.0, log=print):
    """Height field in game metres: DEM (scaled), OSM coastline, sea floor, northern ridge."""
    lat, lon = ORIGIN
    gx0, gy0, gx1, gy1 = game_win()
    win_r = ((gx0 - PAD) / SXY, (gy0 - PAD) / SXY, (gx1 + PAD) / SXY, (gy1 + PAD) / SXY)
    xr, yr, Hr = osm.elevation_grid(lat, lon, None, res=res / SXY, z=13, win=win_r)
    xs, ys = xr * SXY, yr * SXY
    X, Y = np.meshgrid(xs, ys)
    log(f"realbase: DEM {Hr.shape}")

    # signed distance to the coastline near the shore (OSM: land is left of the way)
    band = 70.0
    sd = np.where(Hr > 0.3, band, -band).astype(np.float64)
    best = np.full(X.shape, band)
    for el in coast["elements"]:
        g = el.get("geometry")
        if not g or len(g) < 2:
            continue
        px, py = to_game([p["lat"] for p in g], [p["lon"] for p in g])
        P = np.stack([px, py], 1)
        for i in range(len(P) - 1):
            a, b = P[i], P[i + 1]
            lo = np.minimum(a, b) - band
            hi = np.maximum(a, b) + band
            j0 = max(0, int((lo[0] - xs[0]) / res)); j1 = min(len(xs) - 1, int((hi[0] - xs[0]) / res) + 1)
            i0 = max(0, int((lo[1] - ys[0]) / res)); i1 = min(len(ys) - 1, int((hi[1] - ys[0]) / res) + 1)
            if j1 < j0 or i1 < i0:
                continue
            sx, sy = X[i0:i1 + 1, j0:j1 + 1], Y[i0:i1 + 1, j0:j1 + 1]
            ab = b - a
            L2 = max(ab @ ab, 1e-9)
            t = np.clip(((sx - a[0]) * ab[0] + (sy - a[1]) * ab[1]) / L2, 0, 1)
            qx, qy = a[0] + t * ab[0], a[1] + t * ab[1]
            d = np.hypot(sx - qx, sy - qy)
            side = np.sign(ab[0] * (sy - a[1]) - ab[1] * (sx - a[0]))     # +1 = left = land
            cur = best[i0:i1 + 1, j0:j1 + 1]
            m = d < cur
            cur[m] = d[m]
            sdv = sd[i0:i1 + 1, j0:j1 + 1]
            sdv[m] = (side * d)[m]
    sd = _resolve_far_side(sd, best < band, log)
    land = sd > 0
    log("realbase: coastline rasterised")

    H = np.where(land, np.maximum(Hr * SZ, 0.0), 0.0)
    shore = geom.smoothstep(0.0, 30.0, sd)
    H = np.where(land, 0.7 + (np.maximum(H, 0.7) - 0.7) * shore, H)
    depth = np.where(Hr < 0, -Hr * 0.4, 0.0)
    H = np.where(land, H, -2.0 - np.minimum(depth + np.maximum(-sd, 0) * 0.06, 25.0))

    # northern ridge + rim mountains wherever land runs off the window
    nz = T.Noise(41, 32)
    rough = nz.fbm(X, Y, 1 / 900.0, 5) * 0.5 + 0.5
    ry = RIDGE_Y * SXY
    ridge = geom.smoothstep(ry, ry + 1100, Y) * (260 + 160 * rough)
    out_x = np.maximum(np.maximum(gx0 - X, X - gx1), 0)
    out_y = np.maximum(gy0 - Y, 0)
    rim = geom.smoothstep(0, 700, np.maximum(out_x, out_y)) * (180 + 120 * rough)
    H = np.where(land, H + np.maximum(ridge, rim) * geom.smoothstep(0, 60, sd), H)
    T.set_grid(xs, ys, H, sd, land)
    log(f"realbase: terrain {H.shape}, {H.min():.0f}..{H.max():.0f} m")
    return xs, ys, H, sd


def _resolve_far_side(sd, near, log, k=4):
    """Cells far from any coastline get land/sea from the component they belong to:
    regions bounded by the shore band are labelled on a coarse grid and take the
    majority sign of the band cells around them (DEM bathymetry is too coarse)."""
    from collections import deque
    H, W = sd.shape
    h, w = H // k, W // k
    nb = near[:h * k, :w * k].reshape(h, k, w, k).any(axis=(1, 3))
    sgn = np.sign(sd[:h * k, :w * k].reshape(h, k, w, k).mean(axis=(1, 3)))
    lab = np.full((h, w), -1, np.int32)
    votes = []
    cur = 0
    for i0 in range(h):
        for j0 in range(w):
            if nb[i0, j0] or lab[i0, j0] >= 0:
                continue
            q = deque([(i0, j0)])
            lab[i0, j0] = cur
            v = 0.0
            while q:
                i, j = q.popleft()
                for a, b in ((i + 1, j), (i - 1, j), (i, j + 1), (i, j - 1)):
                    if 0 <= a < h and 0 <= b < w:
                        if nb[a, b]:
                            v += sgn[a, b]
                        elif lab[a, b] < 0:
                            lab[a, b] = cur
                            q.append((a, b))
            votes.append(v)
            cur += 1
    votes = np.array(votes)
    comp_sign = np.where(votes >= 0, 1.0, -1.0)
    big = np.zeros((H, W))
    full = np.where(lab >= 0, comp_sign[np.maximum(lab, 0)], 0.0)
    big[:h * k, :w * k] = np.repeat(np.repeat(full, k, 0), k, 1)
    far = ~near & (big != 0)
    out = sd.copy()
    out[far] = np.abs(sd[far]) * big[far]
    log(f"realbase: {cur} land/sea regions resolved")
    return out


# ------------------------------------------------------------------ roads
def _lanes(tags, default):
    try:
        return max(1, int(str(tags.get("lanes", default)).split(";")[0]))
    except ValueError:
        return default


def classify(tags):
    """OSM highway tags -> Vespera road class (registers lane-count variants on demand)."""
    hw = tags.get("highway", "")
    base = hw.replace("_link", "")
    oneway = tags.get("oneway") in ("yes", "1", "-1") or hw in ("motorway", "motorway_link")
    if hw.endswith("_link"):
        n = min(_lanes(tags, 1), 2)
        return _register("ramp", n, oneway=True) if oneway else "street"
    if base in ("motorway", "trunk"):
        if oneway:
            return _register("fw1", min(_lanes(tags, 2), 4), oneway=True)
        return "freeway" if _lanes(tags, 4) >= 4 else "avenue"
    if base == "primary":
        if oneway:
            return _register("av1", min(_lanes(tags, 2), 4), oneway=True)
        return "boulevard" if _lanes(tags, 2) >= 6 else "avenue"
    if base == "secondary":
        if oneway:
            return _register("av1", min(_lanes(tags, 2), 3), oneway=True)
        return "avenue" if _lanes(tags, 2) >= 4 else "street"
    if base == "tertiary":
        return "street"
    return "rural"


def _register(kind, n, oneway=True):
    name = f"{kind}{n}"
    if name not in NW.CLASSES:
        if kind == "fw1":
            NW.CLASSES[name] = dict(lanes=n, lane_w=3.6, shoulder=1.8, median=0.0, side=0.0, sigma=90, r=300,
                                    prio=6, corner=12, oneway=True)
            NW.MAX_GRADE[name] = 0.07
        elif kind == "av1":
            NW.CLASSES[name] = dict(lanes=n, lane_w=3.4, shoulder=0.5, median=0.0, side=3.0, sigma=50, r=60,
                                    prio=4, corner=9, oneway=True)
            NW.MAX_GRADE[name] = 0.13
        elif kind == "ramp":
            NW.CLASSES[name] = dict(lanes=n, lane_w=4.0, shoulder=1.4, median=0.0, side=0.0, sigma=30, r=60,
                                    prio=5, corner=10, oneway=True)
            NW.MAX_GRADE[name] = 0.09
    return name


# Vladivostok streets are steep; compression makes them steeper still
STEEP = {"street": 0.17, "avenue": 0.13, "boulevard": 0.11, "rural": 0.16, "lane": 0.18}


def build_network(roads_data, log=print):
    NW.MAX_GRADE.update(STEEP)
    """Junctions come from shared OSM nodes; crossings without a shared node are grade-separated."""
    lat0, lon0 = ORIGIN
    ry = RIDGE_Y * SXY
    ways = []
    for el in roads_data["elements"]:
        t = el.get("tags", {})
        if t.get("highway") not in KEEP or not el.get("geometry") or "nodes" not in el:
            continue
        if t.get("area") == "yes":
            continue
        gx, gy = to_game([p["lat"] for p in el["geometry"]], [p["lon"] for p in el["geometry"]])
        P = np.stack([gx, gy], 1)
        keep = P[:, 1] < ry + 250
        if keep.sum() < 2:
            continue
        nodes = el["nodes"]
        # cut at the ridge (roads beyond become tunnel portals / dead ends)
        idx = np.flatnonzero(keep)
        runs = np.split(idx, np.flatnonzero(np.diff(idx) > 1) + 1)
        for run in runs:
            if len(run) < 2:
                continue
            ways.append(dict(nodes=[nodes[i] for i in run], P=P[run], tags=t, cls=classify(t),
                             bridge=t.get("bridge", "no") not in ("no",), tunnel=t.get("tunnel", "no") not in ("no",),
                             layer=int(t["layer"]) if str(t.get("layer", "")).lstrip("-").isdigit() else 0,
                             name=t.get("name", ""), cut=len(run) < len(nodes)))
    use = defaultdict(int)
    for w in ways:
        for k, nd in enumerate(w["nodes"]):
            use[nd] += 2 if k in (0, len(w["nodes"]) - 1) else 1
    junction = {nd for nd, c in use.items() if c >= 2}

    # split ways into pieces between junction nodes
    pieces = []
    for w in ways:
        cut = [0] + [k for k in range(1, len(w["nodes"]) - 1) if w["nodes"][k] in junction] + [len(w["nodes"]) - 1]
        for a, b in zip(cut, cut[1:]):
            if b <= a:
                continue
            pieces.append(dict(n0=w["nodes"][a], n1=w["nodes"][b], P=w["P"][a:b + 1], cls=w["cls"],
                               bridge=np.full(b - a + 1, w["bridge"]), tunnel=np.full(b - a + 1, w["tunnel"]),
                               layer=np.full(b - a + 1, w["layer"]), name=w["name"]))
    log(f"realbase: {len(ways)} ways -> {len(pieces)} pieces, {len(junction)} junction nodes")

    pieces = _merge_chains(pieces)
    pieces = _prune(pieces, log)
    return _to_network(pieces, log)


def _merge_chains(pieces):
    """Join pieces through nodes that only connect two pieces of the same class."""
    by_node = defaultdict(list)
    for i, p in enumerate(pieces):
        by_node[p["n0"]].append(i)
        by_node[p["n1"]].append(i)
    alive = [True] * len(pieces)
    for nd in list(by_node):
        lst = [i for i in by_node[nd] if alive[i]]
        if len(lst) != 2:
            continue
        i, j = lst
        if i == j:
            continue
        a, b = pieces[i], pieces[j]
        if a["cls"] != b["cls"]:
            continue
        # orient a to end at nd, b to start at nd
        if a["n1"] != nd:
            a = _rev(a)
        if b["n0"] != nd:
            b = _rev(b)
        if a["n1"] != nd or b["n0"] != nd:
            continue
        m = dict(n0=a["n0"], n1=b["n1"], P=np.vstack([a["P"], b["P"][1:]]), cls=a["cls"],
                 bridge=np.concatenate([a["bridge"], b["bridge"][1:]]),
                 tunnel=np.concatenate([a["tunnel"], b["tunnel"][1:]]),
                 layer=np.concatenate([a["layer"], b["layer"][1:]]), name=a["name"] or b["name"])
        pieces[i] = m
        alive[j] = False
        for x in (m["n0"], m["n1"]):
            by_node[x] = [i if k == j else k for k in by_node[x]]
    return [p for p, ok in zip(pieces, alive) if ok]


def _rev(p):
    return dict(n0=p["n1"], n1=p["n0"], P=p["P"][::-1], cls=p["cls"], bridge=p["bridge"][::-1],
                tunnel=p["tunnel"][::-1], layer=p["layer"][::-1], name=p["name"])


def _prune(pieces, log, min_dead=420.0):
    """Remove short dead-end spurs repeatedly (minor roads only)."""
    removed = 0
    while True:
        deg = defaultdict(int)
        for p in pieces:
            deg[p["n0"]] += 1
            deg[p["n1"]] += 1
        keep = []
        changed = False
        for p in pieces:
            L = float(geom.cum_length(p["P"])[-1])
            dead = deg[p["n0"]] == 1 or deg[p["n1"]] == 1
            minor = p["cls"] in ("rural", "street", "lane")
            if dead and minor and L < min_dead:
                changed = True
                removed += 1
                continue
            keep.append(p)
        pieces = keep
        if not changed:
            break
    log(f"realbase: pruned {removed} dead-end spurs, {len(pieces)} pieces left")
    return pieces


def _to_network(pieces, log):
    net = NW.Network()
    nodes = {}

    def node(osm_id, pos):
        if osm_id not in nodes:
            n = NW.Node(len(net.nodes), pos)
            nodes[osm_id] = n
            net.nodes.append(n)
        return nodes[osm_id]

    for k, p in enumerate(pieces):
        P = p["P"]
        s0 = geom.cum_length(P)
        if s0[-1] < 1.0:
            continue
        D, U, s = geom.resample(P, NW.SPACING)
        if len(D) > 4:
            D[1:-1] = geom.relax_to(D, iters=8, tether=1.2)[1:-1]
        fl = {}
        for key in ("bridge", "tunnel", "layer"):
            fl[key] = np.asarray(p[key])[np.clip(np.searchsorted(s0, s), 0, len(s0) - 1)]
        road = NW.Road(p["name"] or f"road {k}", p["cls"], D, closed=False, split=True,
                       spec={"bridge_mask": fl["bridge"].astype(bool), "tunnel_mask": fl["tunnel"].astype(bool),
                             "layer": fl["layer"].astype(int), "osm_name": p["name"]})
        _profile(road)
        n0 = node(p["n0"], D[0])
        n1 = node(p["n1"], D[-1])
        e = NW.Edge(len(net.edges), road, D.copy(), road.s.copy(), n0, n1)
        e.z = road.z.copy()
        e.N = road.N.copy()
        e.layer = fl["layer"].astype(int)
        e.bridge = fl["bridge"].astype(bool)
        net.edges.append(e)
        n0.edges.append((e, 0))
        n1.edges.append((e, 1))
    net._collapse_short(16.0)
    _drop_small_components(net, log)
    net._compact()
    net.roads = [e.road for e in net.edges]
    net.all_roads = net.roads
    log(f"realbase: network {len(net.nodes)} nodes, {len(net.edges)} edges")
    return net


def _profile(road):
    """Ground-following profile; bridge and tunnel spans are bridged between their ends."""
    c = NW.CLASSES[road.cls]
    N = T.height(road.P[:, 0], road.P[:, 1])
    road.N = N
    base = np.maximum(N, 0.8)
    span = road.spec["bridge_mask"] | road.spec["tunnel_mask"]
    if span.any() and not span.all():
        good = ~span
        base = np.interp(road.s, road.s[good], base[good])
    elif span.all():
        base = np.full(len(N), max(float(base[0]), float(base[-1])))
    zs = geom.gaussian_smooth(base, road.s, c["sigma"] * 0.6)
    # decks over water keep their navigation clearance
    deck = BRIDGE_DECK.get(road.spec.get("osm_name", ""), 14.0)
    wet = road.spec["bridge_mask"] & (N < 0.5)
    if wet.any():
        need = np.where(wet, deck, -1e9)
        reach = 400.0
        k = np.zeros(len(zs))
        for i in np.flatnonzero(wet):
            k = np.maximum(k, need[i] - NW.MAX_GRADE.get(road.cls, 0.08) * np.abs(road.s - road.s[i]))
        zs = np.maximum(zs, k)
    road.z = NW.grade_limit(zs, NW.SPACING, NW.MAX_GRADE.get(road.cls, 0.1))


def _drop_small_components(net, log, min_km=1.5):
    """Remove road islands that are not connected to the main network."""
    seen = {}
    comps = []
    for n in net.nodes:
        if n.idx in seen or not n.edges:
            continue
        stack = [n]
        seen[n.idx] = len(comps)
        members = []
        while stack:
            u = stack.pop()
            members.append(u)
            for e, k in u.edges:
                v = e.n[1 - k]
                if v.idx not in seen:
                    seen[v.idx] = len(comps)
                    stack.append(v)
        comps.append(members)
    lengths = []
    for members in comps:
        es = {id(e): e for u in members for e, _ in u.edges}
        lengths.append(sum(e.L for e in es.values()) / 1000)
    dead = {i for i, L in enumerate(lengths) if L < min_km}
    before = len(net.edges)
    net.edges = [e for e in net.edges if seen.get(e.n[0].idx) not in dead]
    for n in net.nodes:
        n.edges = [(e, k) for e, k in n.edges if seen.get(e.n[0].idx) not in dead]
    net._compact()
    log(f"realbase: dropped {before - len(net.edges)} edges in {len(dead)} small islands")


def post_flags(net):
    """Tunnels only where OSM says so (deep cuts are graded, not tunnelled)."""
    for e in net.edges:
        tm = e.road.spec.get("tunnel_mask")
        e.tunnel = tm.copy() if tm is not None and len(tm) == len(e.P) else np.zeros(len(e.P), bool)
