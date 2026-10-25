// What the property panel says about a field: a readable label (locale key field.<name>, or
// field.<kind>.<name> where one kind means something else), whether it picks from the registry,
// whether it is derived (read only) and how it is shown (headings in degrees).
import { t, hasKey } from './i18n.js';

const DEG = { toView: (v) => Math.round((v * 180) / Math.PI * 10) / 10, fromView: (v) => Math.round((v * Math.PI) / 180 * 10000) / 10000, unit: '°' };
const SELECT = { select: true }, RO = { readonly: true };
const META = {
  'furniture.h': { label: 'field.heading', ...DEG },
  'furniture.p': { label: 'field.position' }, 'node.p': { label: 'field.position' },
  'building.type': SELECT, 'building.zone': SELECT, 'part.m': SELECT, 'surface.m': { label: 'field.cover', ...SELECT },
  'furniture.t': SELECT, 'edge.cls': SELECT, 'fpart.k': SELECT, 'materials.facade': SELECT, 'buildingTypes.wall': SELECT,
  'facades.style': SELECT,
  'edge.trim': RO, 'node.kind': RO, 'edge.id': RO, 'node.id': RO, 'roads.classes.hw': RO, 'roads.classes.hwt': RO,
  'roads.classes.r': { label: 'field.turnRadius' }, 'fpart.c': { label: 'field.color' }, 'fpart.at': { label: 'field.offset' },
};

export function fieldMeta(kind, key) {
  const m = META[`${kind}.${key}`] ?? META[key] ?? {};
  const k = m.label ?? (hasKey(`field.${kind}.${key}`) ? `field.${kind}.${key}` : `field.${key}`);
  return { ...m, label: hasKey(k) ? t(k) : key };
}
