"""Blender side: turn generator buffers into objects, materials and collections.

Collections follow the export layers: ROADS (exported whole) and the LOD layers
(TERRAIN, WATER, STRUCTURES, ...).
"""
import os

import bpy
import numpy as np

TEX = os.path.join(os.path.dirname(__file__), "..", "assets", "textures")
HDRI = os.path.join(os.path.dirname(__file__), "..", "assets", "hdri")


# ------------------------------------------------------------------ scene utils
def collection(name, parent=None):
    col = bpy.data.collections.get(name)
    if col is None:
        col = bpy.data.collections.new(name)
        (parent or bpy.context.scene.collection).children.link(col)
    return col


def clear_collection(name):
    col = bpy.data.collections.get(name)
    if not col:
        return
    for ob in list(col.all_objects):
        me = ob.data if ob.type == "MESH" else None
        bpy.data.objects.remove(ob, do_unlink=True)
        if me is not None and me.users == 0:
            bpy.data.meshes.remove(me)


def reset_scene():
    for ob in list(bpy.data.objects):
        bpy.data.objects.remove(ob, do_unlink=True)
    for me in list(bpy.data.meshes):
        if me.users == 0:
            bpy.data.meshes.remove(me)
    sc = bpy.context.scene
    sc.unit_settings.system = "METRIC"
    sc.render.engine = "BLENDER_EEVEE_NEXT"
    for a in bpy.context.screen.areas if bpy.context.screen else []:
        if a.type == "VIEW_3D":
            for sp in a.spaces:
                if sp.type == "VIEW_3D":
                    sp.clip_end = 20000
                    sp.clip_start = 0.5


def mesh_object(name, V, F, UV=None, mat_idx=None, mats=(), col=None, smooth=False):
    V = np.asarray(V, np.float32)
    me = bpy.data.meshes.new(name)
    me.vertices.add(len(V))
    me.vertices.foreach_set("co", V.ravel())
    if isinstance(F, np.ndarray) and F.ndim == 2:
        k = F.shape[1]
        nloops = F.size
        me.loops.add(nloops)
        me.loops.foreach_set("vertex_index", F.ravel().astype(np.int32))
        me.polygons.add(len(F))
        me.polygons.foreach_set("loop_start", (np.arange(len(F)) * k).astype(np.int32))
        flat = F.ravel()
    else:
        sizes = np.fromiter((len(f) for f in F), np.int32, len(F))
        flat = np.fromiter((i for f in F for i in f), np.int32, int(sizes.sum()))
        me.loops.add(len(flat))
        me.loops.foreach_set("vertex_index", flat)
        me.polygons.add(len(F))
        starts = np.concatenate([[0], np.cumsum(sizes)[:-1]]).astype(np.int32)
        me.polygons.foreach_set("loop_start", starts)
    if UV is not None:
        uv = me.uv_layers.new(name="UVMap")
        uv.data.foreach_set("uv", np.asarray(UV, np.float32)[flat].ravel())
    for m in mats:
        me.materials.append(m)
    if mat_idx is not None:
        me.polygons.foreach_set("material_index", np.asarray(mat_idx, np.int32))
    me.update(calc_edges=True)
    me.validate(clean_customdata=False)
    if smooth:
        me.polygons.foreach_set("use_smooth", np.ones(len(me.polygons), bool))
    ob = bpy.data.objects.new(name, me)
    (col or bpy.context.scene.collection).objects.link(ob)
    return ob


# ------------------------------------------------------------------ materials
def _img(name):
    path = os.path.abspath(os.path.join(TEX, name))
    im = bpy.data.images.get(os.path.basename(path))
    if im is None:
        im = bpy.data.images.load(path, check_existing=True)
    return im


def _principled(mat):
    return next(n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED")


def tex_material(name, tex, scale=1.0, tint=(1, 1, 1), rough_mul=1.0, spec=0.5):
    mat = bpy.data.materials.get(name)
    if mat:
        return mat
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = _principled(mat)
    uv = nt.nodes.new("ShaderNodeTexCoord")
    mp = nt.nodes.new("ShaderNodeMapping")
    mp.inputs["Scale"].default_value = (scale, scale, scale)
    nt.links.new(uv.outputs["UV"], mp.inputs["Vector"])
    d = nt.nodes.new("ShaderNodeTexImage")
    d.image = _img(f"{tex}_diff.jpg")
    nt.links.new(mp.outputs["Vector"], d.inputs["Vector"])
    mix = nt.nodes.new("ShaderNodeMix")
    mix.data_type = "RGBA"
    mix.blend_type = "MULTIPLY"
    mix.inputs["Factor"].default_value = 1.0
    nt.links.new(d.outputs["Color"], mix.inputs["A"])
    mix.inputs["B"].default_value = (*tint, 1)
    nt.links.new(mix.outputs["Result"], bsdf.inputs["Base Color"])
    r = nt.nodes.new("ShaderNodeTexImage")
    r.image = _img(f"{tex}_rough.jpg")
    r.image.colorspace_settings.name = "Non-Color"
    nt.links.new(mp.outputs["Vector"], r.inputs["Vector"])
    mul = nt.nodes.new("ShaderNodeMath")
    mul.operation = "MULTIPLY"
    mul.inputs[1].default_value = rough_mul
    nt.links.new(r.outputs["Color"], mul.inputs[0])
    nt.links.new(mul.outputs[0], bsdf.inputs["Roughness"])
    n = nt.nodes.new("ShaderNodeTexImage")
    n.image = _img(f"{tex}_nor.jpg")
    n.image.colorspace_settings.name = "Non-Color"
    nt.links.new(mp.outputs["Vector"], n.inputs["Vector"])
    nm = nt.nodes.new("ShaderNodeNormalMap")
    nt.links.new(n.outputs["Color"], nm.inputs["Color"])
    nt.links.new(nm.outputs["Normal"], bsdf.inputs["Normal"])
    return mat


def flat_material(name, color, rough=0.6, metal=0.0, emit=None, strength=1.0):
    mat = bpy.data.materials.get(name)
    if mat:
        return mat
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    b = _principled(mat)
    b.inputs["Base Color"].default_value = (*color, 1)
    b.inputs["Roughness"].default_value = rough
    b.inputs["Metallic"].default_value = metal
    if emit:
        b.inputs["Emission Color"].default_value = (*emit, 1)
        b.inputs["Emission Strength"].default_value = strength
    mat.diffuse_color = (*color, 1)
    return mat


def road_materials():
    return {
        "asphalt": tex_material("M_Asphalt", "asphalt_02", 1.0, (0.55, 0.55, 0.58), 0.85),
        "sidewalk": tex_material("M_Sidewalk", "concrete_pavement", 1.0, (0.8, 0.78, 0.75)),
        "curb": flat_material("M_Curb", (0.55, 0.54, 0.52), 0.7),
        "concrete": tex_material("M_Concrete", "concrete_floor_02", 0.5, (0.6, 0.6, 0.6)),
        "paint_white": flat_material("M_PaintWhite", (0.85, 0.85, 0.82), 0.5),
        "paint_yellow": flat_material("M_PaintYellow", (0.85, 0.62, 0.08), 0.5),
        "grass": tex_material("M_Grass", "sparse_grass", 0.5),
        "barrier": flat_material("M_Barrier", (0.62, 0.62, 0.6), 0.75),
        "guardrail": flat_material("M_Guardrail", (0.7, 0.72, 0.75), 0.35, 0.9),
        "metal": flat_material("M_Metal", (0.4, 0.42, 0.45), 0.4, 0.8),
        "tunnel": flat_material("M_Tunnel", (0.5, 0.5, 0.48), 0.6),
        "tunnel_light": flat_material("M_TunnelLight", (1, 0.85, 0.6), 0.5, emit=(1.0, 0.8, 0.55), strength=8.0),
    }


def terrain_material():
    mat = bpy.data.materials.get("M_Terrain")
    if mat:
        return mat
    mat = bpy.data.materials.new("M_Terrain")
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = _principled(mat)
    uv = nt.nodes.new("ShaderNodeTexCoord")
    layers = []
    for tex, sc in (("sparse_grass", 0.12), ("aerial_grass_rock", 0.03), ("coast_sand_01", 0.1), ("forest_ground_04", 0.08)):
        mp = nt.nodes.new("ShaderNodeMapping")
        mp.inputs["Scale"].default_value = (sc, sc, sc)
        nt.links.new(uv.outputs["UV"], mp.inputs["Vector"])
        t = nt.nodes.new("ShaderNodeTexImage")
        t.image = _img(f"{tex}_diff.jpg")
        nt.links.new(mp.outputs["Vector"], t.inputs["Vector"])
        layers.append(t)
    attr = nt.nodes.new("ShaderNodeAttribute")
    attr.attribute_name = "mask"            # r=rock, g=sand, b=forest
    sep = nt.nodes.new("ShaderNodeSeparateColor")
    nt.links.new(attr.outputs["Color"], sep.inputs["Color"])
    cur = layers[0].outputs["Color"]
    for lay, ch in ((layers[3], "Blue"), (layers[1], "Red"), (layers[2], "Green")):
        mx = nt.nodes.new("ShaderNodeMix")
        mx.data_type = "RGBA"
        nt.links.new(sep.outputs[ch], mx.inputs["Factor"])
        nt.links.new(cur, mx.inputs["A"])
        nt.links.new(lay.outputs["Color"], mx.inputs["B"])
        cur = mx.outputs["Result"]
    nt.links.new(cur, bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = 0.9
    mat.diffuse_color = (0.3, 0.35, 0.22, 1)
    return mat


def water_material():
    mat = bpy.data.materials.get("M_Water")
    if mat:
        return mat
    mat = bpy.data.materials.new("M_Water")
    mat.use_nodes = True
    nt = mat.node_tree
    b = _principled(mat)
    b.inputs["Base Color"].default_value = (0.01, 0.03, 0.045, 1)
    b.inputs["Roughness"].default_value = 0.06
    nz = nt.nodes.new("ShaderNodeTexNoise")
    nz.inputs["Scale"].default_value = 0.08
    nz.inputs["Detail"].default_value = 8
    bump = nt.nodes.new("ShaderNodeBump")
    bump.inputs["Strength"].default_value = 0.15
    coord = nt.nodes.new("ShaderNodeTexCoord")
    nt.links.new(coord.outputs["Object"], nz.inputs["Vector"])
    nt.links.new(nz.outputs["Fac"], bump.inputs["Height"])
    nt.links.new(bump.outputs["Normal"], b.inputs["Normal"])
    mat.diffuse_color = (0.02, 0.06, 0.09, 1)
    return mat


# ------------------------------------------------------------------ builders
def build_roads(L, col):
    mats = road_materials()
    objs = []
    for layer, mb in L.items():
        arr = mb.arrays()
        if arr is None:
            continue
        V, UV, F, M = arr
        names = sorted(set(M))
        lut = {n: i for i, n in enumerate(names)}
        idx = np.fromiter((lut[m] for m in M), np.int32, len(M))
        ob = mesh_object(f"ROAD_{layer}", V, F, UV, idx, [mats.get(n, mats["concrete"]) for n in names], col)
        objs.append(ob)
    return objs


def build_terrain(xs, H, col, step=1, ys=None):
    from . import terrain as T
    ys = xs if ys is None else ys
    xs = xs[::step]
    ys = ys[::step]
    H = H[::step, ::step]
    n = len(xs)
    m = len(ys)
    X, Y = np.meshgrid(xs, ys)
    V = np.stack([X, Y, H], -1).reshape(-1, 3)
    idx = np.arange(m * n).reshape(m, n)
    F = np.stack([idx[:-1, :-1], idx[:-1, 1:], idx[1:, 1:], idx[1:, :-1]], -1).reshape(-1, 4)
    UV = V[:, :2] / 4.0
    ob = mesh_object("TERRAIN", V, F, UV, None, [terrain_material()], col, smooth=True)
    # splat mask: rock on slopes, sand by the water, forest on wild rolling land
    gy, gx = np.gradient(H, ys[1] - ys[0], xs[1] - xs[0])
    slope = np.hypot(gx, gy)
    sd = T.coast_dist(X, Y)
    rock = np.clip((slope - 0.35) / 0.25, 0, 1)
    sand = np.clip(1 - (H - 0.5) / 3.0, 0, 1) * (sd < 120)
    forest = np.clip((H - 25) / 40, 0, 1) * (1 - rock)
    col_attr = ob.data.color_attributes.new("mask", "FLOAT_COLOR", "POINT")
    rgba = np.stack([rock, sand, forest, np.ones_like(rock)], -1).reshape(-1).astype(np.float32)
    col_attr.data.foreach_set("color", rgba)
    return ob


def build_water(col, size=24000.0):
    s = size / 2
    V = [(-s, -s, 0.0), (s, -s, 0.0), (s, s, 0.0), (-s, s, 0.0)]
    return mesh_object("WATER", V, [(0, 1, 2, 3)], None, None, [water_material()], col)


def world_dusk(strength=0.6, hdri="kloppenheim_02_puresky.hdr"):
    w = bpy.context.scene.world or bpy.data.worlds.new("World")
    bpy.context.scene.world = w
    w.use_nodes = True
    nt = w.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputWorld")
    bg = nt.nodes.new("ShaderNodeBackground")
    env = nt.nodes.new("ShaderNodeTexEnvironment")
    env.image = bpy.data.images.load(os.path.abspath(os.path.join(HDRI, hdri)), check_existing=True)
    nt.links.new(env.outputs["Color"], bg.inputs["Color"])
    bg.inputs["Strength"].default_value = strength
    nt.links.new(bg.outputs["Background"], out.inputs["Surface"])
