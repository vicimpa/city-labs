// Transactional terrain callbacks operate on a scratch grid. A declared patch
// cannot silently write outside the region its undo command owns.
export function terrainPatch(t, box, fn) {
  if (!t?.base || !Array.isArray(box) || box.length !== 4 || !box.every(Number.isInteger) || box[0] < 0 || box[1] < 0 || box[2] >= t.nx || box[3] >= t.ny || box[0] > box[2] || box[1] > box[3]) throw new Error('invalid terrain edit bounds');
  const scratch = Float32Array.from(t.base), before = [], after = [];
  fn(scratch);
  for (let j = 0; j < t.ny; j++) for (let i = 0; i < t.nx; i++) {
    const k = j * t.nx + i, inside = i >= box[0] && i <= box[2] && j >= box[1] && j <= box[3];
    if (inside) {
      if (!Number.isFinite(scratch[k])) throw new Error('terrain edit produced a non-finite height');
      before.push(t.base[k]); after.push(scratch[k]);
    } else if (!Object.is(scratch[k], t.base[k])) throw new Error('terrain callback changed a cell outside its edit bounds');
  }
  const write = (values) => { let k = 0; for (let j = box[1]; j <= box[3]; j++) for (let i = box[0]; i <= box[2]; i++) t.base[j * t.nx + i] = values[k++]; };
  return { before: Float32Array.from(before), after: Float32Array.from(after), write };
}
