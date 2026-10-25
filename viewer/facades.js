// Procedural facade textures (canvas), generated from the parameters in defs.facades. One tile =
// 8 bays × 8 floors, mapped in metres through the world-space UVs ExtrudeGeometry gives side walls
// (u along the wall, v = height). Colours are multiplied by the material colour, so light walls
// take the building's colour; the emissive map holds the lit windows.
import * as THREE from 'three';

const N = 8, PX = 64;
export const FACADE_STYLES = ['curtain', 'windows', 'brick', 'ribs'];
export const FACADE_DEFAULTS = { style: 'windows', bay: 4, floor: 3.3, window: [0.62, 0.56], wallColor: '#f2f0ea', frame: '#c9c6bf',
  glass: '#3c4a5a', lit: 0.38, warm: 0.75, shutters: false, sparse: 0, seed: 1 };

function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(String(hex ?? '#888888').slice(i, i + 2), 16) || 0);
const css = (c, k = 1) => `rgb(${c.map((v) => Math.max(0, Math.min(255, Math.round(v * k)))).join(',')})`;

/** Paint one facade: { color: canvas, emissive: canvas | null, params }. */
export function facadeCanvases(params, size = N * PX) {
  const p = { ...FACADE_DEFAULTS, ...params };
  const mk = () => { const c = typeof OffscreenCanvas !== 'undefined' && !globalThis.document ? new OffscreenCanvas(size, size) : document.createElement('canvas'); c.width = c.height = size; return c; };
  const color = mk(), emis = mk(), g = color.getContext('2d'), ge = emis.getContext('2d'), r = rng(p.seed * 977 + 13), px = size / N;
  ge.fillStyle = '#000'; ge.fillRect(0, 0, size, size);
  const wall = rgb(p.wallColor), frame = rgb(p.frame), glass = rgb(p.glass);
  const [ww, wh] = Array.isArray(p.window) ? p.window : [p.window, p.window];
  let lit = 0;
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const x = i * px, y = j * px;
    let win = null;                                   // window rect in the cell, for the lights
    if (p.style === 'curtain') {
      const k = 0.85 + r() * 0.25, grad = g.createLinearGradient(0, y, 0, y + px);
      grad.addColorStop(0, css(glass, k * 1.35)); grad.addColorStop(1, css(glass, k));
      g.fillStyle = grad; g.fillRect(x, y, px, px);
      g.fillStyle = css(frame); g.fillRect(x, y, px * 0.05, px); g.fillRect(x, y + px * 0.88, px, px * 0.12);
      win = [x + px * 0.05, y + px * 0.06, px * 0.9, px * 0.8];
    } else if (p.style === 'ribs') {
      for (let k = 0; k < px; k += px / 8) { g.fillStyle = css((k / (px / 8)) % 2 ? wall : frame); g.fillRect(x + k, y, px / 8, px); }
    } else {
      if (p.style === 'brick') {
        const bh = px / 10.5, bw = px / 4.5;
        for (let b = 0, row = 0; b < px; b += bh, row++) for (let a = (row % 2) * bw / 2 - bw; a < px + bw; a += bw) {
          g.fillStyle = css(wall, 0.86 + r() * 0.2); g.fillRect(x + a, y + b, bw - 1, bh - 1);
        }
      } else { g.fillStyle = css(wall); g.fillRect(x, y, px, px); }
      if (r() >= p.sparse) {
        const w = px * ww, h = px * wh, wx = x + (px - w) / 2, wy = y + px * 0.16;
        g.fillStyle = css(frame); g.fillRect(wx - 3, wy - 3, w + 6, h + 6);             // frame
        g.fillStyle = css(glass, 0.8 + r() * 0.45); g.fillRect(wx, wy, w, h);           // glass
        g.fillStyle = css(frame); g.fillRect(wx + w / 2 - 1, wy, 2, h);                 // mullion
        if (p.shutters) { g.fillStyle = '#7a5a40'; g.fillRect(wx - 3 - px * 0.08, wy, px * 0.08, h); g.fillRect(wx + w + 3, wy, px * 0.08, h); }
        g.fillStyle = css(frame, 0.92); g.fillRect(wx - 4, wy + h + 3, w + 8, 3);        // sill
        win = [wx, wy, w, h];
      }
    }
    if (win && r() < p.lit) {                         // lit window, warm or cool
      const k = 0.55 + r() * 0.45, warm = r() < p.warm;
      ge.fillStyle = warm ? `rgb(${255 * k | 0},${200 * k | 0},${120 * k | 0})` : `rgb(${190 * k | 0},${220 * k | 0},${255 * k | 0})`;
      ge.fillRect(...win); lit++;
    }
  }
  return { color, emissive: lit ? emis : null, params: p };
}

function toTexture(canvas, p, anisotropy) {
  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = anisotropy; t.colorSpace = THREE.SRGBColorSpace;
  t.repeat.set(1 / (N * p.bay), 1 / (N * p.floor));
  return t;
}

/** Textures for every facade in the registry: name -> { map, emissiveMap }. Pass `into` to update in place. */
export function facadeTextures(facades, anisotropy = 4, into = {}) {
  for (const [name, params] of Object.entries(facades ?? {})) {
    const c = facadeCanvases(params), cur = into[name];
    if (cur) {
      cur.map.image = c.color; cur.map.repeat.set(1 / (N * c.params.bay), 1 / (N * c.params.floor)); cur.map.needsUpdate = true;
      if (c.emissive) {
        if (cur.emissiveMap) { cur.emissiveMap.image = c.emissive; cur.emissiveMap.repeat.copy(cur.map.repeat); cur.emissiveMap.needsUpdate = true; }
        else cur.emissiveMap = toTexture(c.emissive, c.params, anisotropy);
      } else cur.emissiveMap = null;
    } else into[name] = { map: toTexture(c.color, c.params, anisotropy), emissiveMap: c.emissive ? toTexture(c.emissive, c.params, anisotropy) : null };
  }
  for (const name of Object.keys(into)) if (!facades?.[name]) delete into[name];
  return into;
}
