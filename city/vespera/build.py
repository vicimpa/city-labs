"""Stage-by-stage city build inside Blender (live or background).

    import sys; sys.path.insert(0, ".../race-game/city")
    from vespera import build
    build.stage_plan(); build.stage_terrain(); build.stage_roads(); build.save()

State between calls lives in bpy.app.driver_namespace so modules can be reloaded.
"""
import os
import time

import bpy

from . import bl, ground, network, roadmesh, roadplan

OUT = os.path.join(os.path.dirname(__file__), "..", "out")


def _state():
    return bpy.app.driver_namespace.setdefault("vespera", {})


def _log(*a):
    print("[vespera]", *a, flush=True)


def stage_plan():
    t = time.time()
    roads = roadplan.build(log=_log)
    net = network.Network()
    net.build(roads, log=_log)
    net.finalize(log=_log)
    _state()["net"] = net
    _log(f"plan ready {time.time() - t:.1f}s")
    return net


def stage_terrain(step=1, region=None, res=8.0):
    t = time.time()
    net = _state()["net"]
    if _state().get("engineered", True) and region is not None:
        xs, ys, H = ground.carve_engineered(net, res=res, log=_log, region=region)
    else:
        xs, ys, H = ground.carve(net, res=res, log=_log, region=region)
    _state()["ground"] = (xs, ys, H)
    bl.clear_collection("TERRAIN")
    bl.clear_collection("WATER")
    bl.build_terrain(xs, H, bl.collection("TERRAIN"), step=step, ys=ys)
    bl.build_water(bl.collection("WATER"))
    _log(f"terrain {time.time() - t:.1f}s")


def stage_real_plan():
    """Real-world base (OSM Vladivostok, compressed) instead of the procedural plan."""
    from . import realbase as RB
    t = time.time()
    roads, coast = RB.fetch(log=_log)
    RB.build_terrain(coast, log=_log)
    net = RB.build_network(roads, log=_log)
    net.finalize(log=_log, all_pairs=True)
    RB.post_flags(net)
    _state()["net"] = net
    _log(f"real plan ready {time.time() - t:.1f}s")
    return net


def stage_roads(region=None):
    t = time.time()
    net = _state()["net"]
    L = roadmesh.build_all(net, log=_log, region=region)
    bl.clear_collection("ROADS")
    bl.build_roads(L, bl.collection("ROADS"))
    _log(f"roads {time.time() - t:.1f}s")


def setup_look():
    bl.world_dusk(0.5, "qwantani_dusk_2_puresky.hdr")
    sc = bpy.context.scene
    sun = bpy.data.objects.get("Sun")
    if sun is None:
        ld = bpy.data.lights.new("Sun", "SUN")
        sun = bpy.data.objects.new("Sun", ld)
        sc.collection.objects.link(sun)
    sun.data.energy = 2.5
    sun.data.color = (1.0, 0.75, 0.55)
    sun.rotation_euler = (1.2, 0.0, 2.4)


def save(name="vespera_greybox.blend"):
    os.makedirs(OUT, exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(os.path.join(OUT, name)), compress=True)


def cam_on_edge(e, frac=0.5, back=60.0, side=35.0, up=22.0, ahead=40.0, lens=28.0):
    """Place the scene camera relative to a road edge (for inspection shots)."""
    import mathutils
    import numpy as np
    i = int(len(e.P) * frac)
    i = min(max(i, 1), len(e.P) - 2)
    p = e.P[i]
    t = e.P[min(i + 5, len(e.P) - 1)] - e.P[max(i - 5, 0)]
    t = t / np.linalg.norm(t)
    n = np.array([-t[1], t[0]])
    sc = bpy.context.scene
    cam = bpy.data.objects.get("CAM")
    if cam is None:
        cam = bpy.data.objects.new("CAM", bpy.data.cameras.new("CAM"))
        sc.collection.objects.link(cam)
    cam.data.clip_end = 30000
    cam.data.lens = lens
    loc = np.r_[p - t * back + n * side, e.z[i] + up]
    cam.location = loc.tolist()
    tgt = np.r_[p + t * ahead, e.z[i]]
    cam.rotation_euler = mathutils.Vector((tgt - loc).tolist()).to_track_quat("-Z", "Y").to_euler()
    sc.camera = cam
    return cam
