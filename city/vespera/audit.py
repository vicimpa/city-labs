"""Road-network statistics and route-redundancy audit."""
from collections import defaultdict, deque

import numpy as np

from . import geom, layout as LY

NAMES = {
    "downtown": "Meridian", "midtown": "Midtown", "oldtown": "Old Quarter", "northgate": "Northgate",
    "eastside": "Eastside", "beach": "Sunset Coast", "port": "Saltwater Docks", "industrial": "Foundry Flats",
    "westwood": "Westwood", "island": "Isla Corsa", "lighthouse": "Lighthouse Point",
    "riverbend": "Riverbend", "villas": "Crown Heights",
}
ZONES = {"Varna Canyons": (-2900, 2700), "Highlands": (2900, 2500), "Corsa Airfield": (2800, -560),
         "Vespera Bay": (-1500, -1000)}


def stats(net):
    km = defaultdict(float)
    for e in net.edges:
        km[e.cls] += e.L / 1000
    deg = defaultdict(int)
    for n in net.nodes:
        deg[len(n.edges)] += 1
    dead = sum(1 for n in net.nodes if len(n.edges) == 1 and not n.free
               and n.edges[0][0].cls not in ("freeway", "ramp"))
    urban = sum(km[c] for c in ("avenue", "street", "lane", "boulevard", "industrial"))
    rural = sum(km[c] for c in ("rural", "mountain"))
    return dict(km={k: round(v, 1) for k, v in sorted(km.items())}, total_km=round(sum(km.values()), 1),
                urban_km=round(urban, 1), rural_km=round(rural, 1),
                junctions_3=deg[3], junctions_4=deg[4], junctions_5plus=sum(v for k, v in deg.items() if k >= 5),
                dead_ends=dead)


def _maxflow(adj, S, Tset, cap_limit=8):
    """Edge-disjoint paths between node sets (unit capacities, undirected)."""
    cap = defaultdict(int)
    nbr = defaultdict(set)
    for a, bs in adj.items():
        for b in bs:
            cap[(a, b)] += 1
            nbr[a].add(b)
    for s in S:
        cap[("S", s)] = 99
        nbr["S"].add(s)
        nbr[s].add("S")
    for t in Tset:
        cap[(t, "T")] = 99
        nbr[t].add("T")
        nbr["T"].add(t)
    flow = 0
    while flow < cap_limit:
        prev = {"S": None}
        q = deque(["S"])
        while q and "T" not in prev:
            u = q.popleft()
            for v in nbr[u]:
                if v not in prev and cap[(u, v)] > 0:
                    prev[v] = u
                    q.append(v)
        if "T" not in prev:
            break
        v = "T"
        while prev[v] is not None:
            u = prev[v]
            cap[(u, v)] -= 1
            cap[(v, u)] += 1
            v = u
        flow += 1
    return flow


def _freeway_links(net, adj):
    """Freeways are single edges without junction nodes: chain every ramp merge and
    freeway end that touches them in order along the freeway."""
    fws = [e for e in net.edges if e.cls == "freeway" or e.cls.startswith("fw1")]
    for f in fws:
        att = []
        for n in net.nodes:
            near = n.free or any(x is f for x, _ in n.edges)
            if not near:
                continue
            d, i, t, q = geom.project_to_polyline(f.P, n.pos)
            if d < 25:
                att.append((f.s[i] + t * (f.s[i + 1] - f.s[i]), n.idx))
        att.sort()
        for (s0, a), (s1, b) in zip(att, att[1:]):
            if a != b:
                adj[a].append(b)
                adj[b].append(a)
        if f.road.closed and len(att) > 2:
            adj[att[-1][1]].append(att[0][1])
            adj[att[0][1]].append(att[-1][1])


def redundancy(net):
    adj = defaultdict(list)
    for e in net.edges:
        a, b = e.n[0].idx, e.n[1].idx
        if a != b and e.cls != "freeway" and not e.cls.startswith("fw1"):
            adj[a].append(b)
            adj[b].append(a)
    _freeway_links(net, adj)
    pos = np.array([n.pos for n in net.nodes])
    out = {}
    for d in LY.DISTRICTS:
        poly = np.asarray(d["poly"], float)
        inside = geom.point_in_poly(pos[:, 0], pos[:, 1], poly)
        c = poly.mean(0)
        far = np.hypot(pos[:, 0] - c[0], pos[:, 1] - c[1]) > 2500
        S = set(np.flatnonzero(inside).tolist())
        Tn = set(np.flatnonzero(far & ~inside).tolist())
        if not S or not Tn:
            continue
        out[d["key"]] = _maxflow(adj, S, Tn)
    return out
