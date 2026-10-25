"""Write the city as JSON layers (one file per layer) for the web viewer.

    python3 -m vespera.export_json [outdir]
"""
import json
import os
import sys
import time

import numpy as np

from . import furniture, ground, network, repair, roadmesh, roadplan, terrain as T, validate
from .network import CLASSES, hw, hwt

OUT = os.path.join(os.path.dirname(__file__), "..", "data")


def _r(a, k=1):
    return np.round(np.asarray(a, float), k).tolist()


def terrain_layer(net, res=6.0, extent=4600.0):
    region = (-extent, -extent, extent, extent)
    bore = []
    xs, ys, H = ground.carve_engineered(net, res=res, region=region, log=lambda *a: None, bore_out=bore)
    return {"layer": "terrain", "x0": float(xs[0]), "y0": float(ys[0]), "res": res,
            "nx": len(xs), "ny": len(ys), "sea_level": 0.0,
            "h": np.round(H, 1).ravel().tolist(),
            "bore": np.flatnonzero(bore[0].ravel()).tolist()}


def roads_layer(net):
    classes = {}
    for e in net.edges:
        c = CLASSES[e.cls]
        classes[e.cls] = {"hw": round(hw(e.cls), 2), "hwt": round(hwt(e.cls), 2), "lanes": c["lanes"],
                          "oneway": bool(c.get("oneway")), "side": c["side"]}
    nodes = [{"id": n.idx, "p": _r([n.pos[0], n.pos[1], n.z if n.z is not None else 0.0]),
              "kind": getattr(n, "kind", "")} for n in net.nodes]
    edges = []
    for e in net.edges:
        if e.z is None:
            continue
        pts = np.column_stack([e.P, e.z])[::2]
        if len(e.P) % 2 == 0:
            pts = np.vstack([pts, np.r_[e.P[-1], e.z[-1]]])
        k = np.arange(0, len(e.P), 2)
        if k[-1] != len(e.P) - 1:
            k = np.append(k, len(e.P) - 1)
        edges.append({"id": e.idx, "name": e.road.name, "cls": e.cls, "n": [e.n[0].idx, e.n[1].idx],
                      "trim": _r(e.trim), "pts": _r(pts),
                      "elev": e.elev[k].astype(int).tolist(), "tunnel": e.tunnel[k].astype(int).tolist()})
    return {"layer": "roads", "classes": classes, "nodes": nodes, "edges": edges, "mesh": road_mesh(net)}


def road_mesh(net):
    """Full road geometry (carriageway, pads, curbs, sidewalks, markings, barriers, piers, walls)
    grouped by material: {material: {"v": [x,y,z,...], "i": [triangle indices]}}."""
    L = roadmesh.build_all(net, log=lambda *a: None)
    groups = {}
    for mb in L.values():
        arr = mb.arrays()
        if arr is None:
            continue
        V, _uv, F, M = arr
        for f, mat in zip(F, M):
            g = groups.setdefault(mat, {"v": [], "i": [], "map": {}})
            ids = []
            for vi in f:
                j = g["map"].get(vi)
                if j is None:
                    j = len(g["v"])
                    g["map"][vi] = j
                    g["v"].append(V[vi])
                ids.append(j)
            for k in range(1, len(ids) - 1):
                g["i"] += [ids[0], ids[k], ids[k + 1]]
        for g in groups.values():
            g["map"] = {}
    out = {}
    for mat, g in groups.items():
        out[mat] = {"v": np.round(np.asarray(g["v"], float), 2).ravel().tolist(), "i": g["i"]}
    return out


def main(out=OUT):
    os.makedirs(out, exist_ok=True)
    t = time.time()
    T._grid.clear()
    roads = roadplan.build(log=lambda *a: None)
    net = network.Network()
    net.build(roads, log=print)
    net.compute_trims()
    repair.repair(net, log=print)
    net.finalize(log=print)
    ter = terrain_layer(net)
    xs = ter["x0"] + np.arange(ter["nx"]) * ter["res"]
    ys = ter["y0"] + np.arange(ter["ny"]) * ter["res"]
    Hg = np.asarray(ter["h"], float).reshape(ter["ny"], ter["nx"])
    issues = validate.check(net) + validate.open_ends(net) + validate.surface_check(net) + validate.terrain_check(net, xs, ys, Hg)
    print("issues:", validate.summary(issues))
    layers = (("issues", {"layer": "issues", "items": issues}), ("roads", roads_layer(net)), ("furniture", {"layer": "furniture", "items": furniture.build(net)}),
              ("terrain", ter))
    for name, layer in layers:
        path = os.path.join(out, f"{name}.json")
        json.dump(layer, open(path, "w"), separators=(",", ":"))
        print(f"{name}.json {os.path.getsize(path) / 1e6:.1f} MB")
    print(f"export {time.time() - t:.0f}s")


if __name__ == "__main__":
    main(*sys.argv[1:])
