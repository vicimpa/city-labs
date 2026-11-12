// Dispose shared resources once within a release operation. Cached materials are
// excluded for a tile rebuild and included when their owning World3D is closed.
export function disposeRenderObjects(roots, { materials = true, textures = false, extra = [] } = {}) {
  const resources = new Set(extra.filter(Boolean)), mats = new Set();
  for (const root of roots.filter(Boolean)) root.traverse((o) => {
    if (o.geometry) resources.add(o.geometry);
    if (o.isInstancedMesh || o.isBatchedMesh) resources.add(o);
    if (materials && o.material) for (const m of Array.isArray(o.material) ? o.material : [o.material]) mats.add(m);
  });
  for (const r of resources) if (r?.isMaterial) mats.add(r);
  for (const m of mats) {
    resources.add(m);
    for (const t of m.userData?.ownedTextures ?? []) resources.add(t);
    if (textures) for (const v of Object.values(m)) if (v?.isTexture) resources.add(v);
  }
  for (const r of resources) r.dispose?.();
}
