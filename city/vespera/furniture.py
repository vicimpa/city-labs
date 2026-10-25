"""Roadside furniture placed by the rules in docs/ROAD_STANDARDS.md.

Output: list of instances {t: type, p: [x, y, z], h: heading_rad, s: scale(optional)}.
"""
import math

import numpy as np

from . import geom
from .network import CLASSES, hw, hwt

URBAN = ("boulevard", "avenue", "street", "lane")
LAMP_RULE = {"boulevard": (38, "both"), "avenue": (38, "stagger"), "street": (45, "one"), "lane": (30, "one"),
             "industrial": (55, "one")}


def _walk(e, spacing, start=None):
    """Stations every `spacing` m inside the trimmed part of an edge."""
    s0, s1 = e.trim[0] + 6, e.L - e.trim[1] - 6
    if s1 <= s0:
        return []
    return list(np.arange(s0 + (start if start is not None else spacing / 2), s1, spacing))


def _frame(e, s):
    p = np.array([np.interp(s, e.s, e.P[:, 0]), np.interp(s, e.s, e.P[:, 1])])
    a = np.array([np.interp(s - 2, e.s, e.P[:, 0]), np.interp(s - 2, e.s, e.P[:, 1])])
    b = np.array([np.interp(s + 2, e.s, e.P[:, 0]), np.interp(s + 2, e.s, e.P[:, 1])])
    t = geom.unit(b - a)
    return p, t, np.array([-t[1], t[0]]), float(np.interp(s, e.s, e.z))


def _flag(e, arr, s):
    return np.interp(s, e.s, arr.astype(float)) > 0.5


def build(net):
    out = []

    def add(t, p, z, h, **kw):
        out.append(dict(t=t, p=[round(float(p[0]), 2), round(float(p[1]), 2), round(float(z), 2)],
                        h=round(float(h), 3), **kw))

    for e in net.edges:
        if e.z is None:
            continue
        c = CLASSES[e.cls]
        cls = e.cls
        base = "freeway" if cls.startswith("fw1") or cls == "freeway" else ("ramp" if cls.startswith("ramp") else cls)
        side = c["side"]
        W, WT = hw(cls), hwt(cls)
        # ---- street lights and trees in the amenity zone (curb side of the sidewalk)
        if base in LAMP_RULE:
            sp, mode = LAMP_RULE[base]
            for k, s in enumerate(_walk(e, sp)):
                if _flag(e, e.tunnel, s):
                    continue
                p, t, n, z = _frame(e, s)
                sides = (1, -1) if mode == "both" else ((1 if k % 2 else -1),) if mode == "stagger" else (1,)
                for sg in sides:
                    u = W + (0.6 if side > 0 else 1.2)
                    add("lamp", p + n * sg * u, z + (0.15 if side > 0 else 0), math.atan2(-n[1] * sg, -n[0] * sg),
                        hgt=11.0 if base in ("boulevard", "avenue") else 8.0)
            if base in ("boulevard", "avenue") and side >= 4:
                for s in _walk(e, 11.0, 5.5):
                    if _flag(e, e.tunnel, s) or _flag(e, e.elev, s):
                        continue
                    p, t, n, z = _frame(e, s)
                    for sg in (1, -1):
                        add("tree", p + n * sg * (W + 1.0), z + 0.15, 0.0)
            if base == "boulevard":
                for s in _walk(e, 12.0):
                    p, t, n, z = _frame(e, s)
                    add("tree", p, z + 0.3, 0.0)
            if base == "avenue":
                for s in _walk(e, 420.0, 200.0):
                    p, t, n, z = _frame(e, s)
                    add("bus_stop", p - n * (WT - 1.2), z + 0.15, math.atan2(t[1], t[0]))
        # ---- freeways: high-mast lights on the outer edge, sign gantries before exits
        if base == "freeway":
            for s in _walk(e, 60.0):
                if _flag(e, e.tunnel, s):
                    continue
                p, t, n, z = _frame(e, s)
                add("highmast", p + n * (W + 0.6), z, math.atan2(-n[1], -n[0]))
            for s in _walk(e, 600.0, 300.0):
                if _flag(e, e.tunnel, s):
                    continue
                p, t, n, z = _frame(e, s)
                add("gantry", p, z, math.atan2(t[1], t[0]), span=round(2 * W + 2, 1))
        # ---- rural / mountain: delineators, chevrons on tight bends
        if base in ("rural", "mountain"):
            for s in _walk(e, 50.0):
                p, t, n, z = _frame(e, s)
                for sg in (1, -1):
                    add("delineator", p + n * sg * (W + 0.8), z, 0.0)
            tan = geom.tangents(e.P)
            ang = np.unwrap(np.arctan2(tan[:, 1], tan[:, 0]))
            curv = np.abs(np.gradient(ang, e.s, edge_order=1))
            for s in _walk(e, 20.0):
                kappa = float(np.interp(s, e.s, curv))
                if kappa > 1 / 80.0:
                    p, t, n, z = _frame(e, s)
                    turn = np.sign(float(np.interp(s, e.s, np.gradient(ang, e.s))))
                    outer = -turn
                    add("chevron", p + n * outer * (W + 1.5), z, math.atan2(t[1], t[0]) + math.pi)
    # ---- junction control
    for nd in net.nodes:
        if getattr(nd, "kind", "") != "junction" or nd.z is None:
            continue
        arms = [(e, k) for e, k in nd.edges if e.cls in URBAN or e.cls == "industrial"]
        if len(arms) < 3:
            continue
        prio = sorted((CLASSES[e.cls]["prio"] for e, _ in arms), reverse=True)
        signal = prio[0] >= 3 and prio[1] >= 3
        for e, k in arms:
            s = e.trim[k] + 7.0 if k == 0 else e.L - e.trim[k] - 7.0
            if not (0 < s < e.L):
                continue
            p, t, n, z = _frame(e, s)
            inbound = -t if k == 0 else t          # direction of traffic arriving at the node
            right = np.array([inbound[1], -inbound[0]])
            pos = p + right * (hw(e.cls) + 0.7)
            head = math.atan2(-inbound[1], -inbound[0])
            if signal:
                add("signal", pos, z + 0.15, head, reach=round(hw(e.cls) * 0.9, 1))
            elif CLASSES[e.cls]["prio"] < prio[0]:
                add("stop_sign", pos, z + 0.15, head)
    return out
