"""One-off: export the generator's *source* data so the JS world builder can take over
(full-resolution road graph, class parameters, node levels, natural terrain).

    python3 -m vespera.export_source [outdir]      -> roads_src.json
"""
import json
import os
import sys
import time

import numpy as np

from . import network, repair, roadplan, terrain as T
from .network import CLASSES, K_MIN, MAX_GRADE, _fam

OUT = os.path.join(os.path.dirname(__file__), "..", "data")


def _r(a, k=2):
    return np.round(np.asarray(a, float), k).tolist()


def main(out=OUT):
    t = time.time()
    T._grid.clear()
    roads = roadplan.build(log=lambda *a: None)
    net = network.Network()
    net.build(roads, log=print)
    net.compute_trims()
    repair.repair(net, log=print)
    net.finalize(log=print)
    used = sorted({e.cls for e in net.edges})
    classes = {}
    for c in used:
        d = dict(CLASSES[c])
        d["oneway"] = bool(d.get("oneway"))
        d["max_grade"] = MAX_GRADE.get(c, 0.1)
        d["k_min"] = K_MIN.get(_fam(c), 12)
        classes[c] = d
    nodes = [{"id": n.idx, "p": _r([n.pos[0], n.pos[1], n.z if n.z is not None else 0.0]), "kind": getattr(n, "kind", ""),
              "grad": _r(getattr(n, "grad", np.zeros(2)), 5), "free": bool(n.free)} for n in net.nodes]
    edges = []
    for e in net.edges:
        if e.z is None:
            continue
        r = e.road
        edges.append({"id": e.idx, "name": r.name, "cls": e.cls, "n": [e.n[0].idx, e.n[1].idx], "trim": _r(e.trim, 3),
                      "pts": _r(np.column_stack([e.P, e.z]), 3), "elev": e.elev.astype(int).tolist(),
                      "tunnel": e.tunnel.astype(int).tolist(),
                      "merge": [h or "" for h in (getattr(r, "merge_host", None) or [None, None])]})
    # natural (uncarved) terrain on the same grid as terrain.json
    ter = json.load(open(os.path.join(out, "terrain.json")))
    xs = ter["x0"] + np.arange(ter["nx"]) * ter["res"]
    ys = ter["y0"] + np.arange(ter["ny"]) * ter["res"]
    X, Y = np.meshgrid(xs, ys)
    base = T.height(X, Y).astype(np.float32)
    src = {"layer": "roads_src", "classes": classes, "nodes": nodes, "edges": edges,
           "terrain_base": np.round(base, 2).ravel().tolist(), "bank_level": T.BANK_LEVEL}
    path = os.path.join(out, "roads_src.json")
    json.dump(src, open(path, "w"), separators=(",", ":"))
    print(f"roads_src.json {os.path.getsize(path) / 1e6:.1f} MB, {len(edges)} edges, {len(nodes)} nodes, {time.time() - t:.0f}s")


if __name__ == "__main__":
    main(*sys.argv[1:])
