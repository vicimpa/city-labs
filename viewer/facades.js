// Procedural facade textures (canvas): one tile = 8 bays x 8 floors, mapped in metres through the
// world-space UVs ExtrudeGeometry gives side walls (u along the wall, v = height).
// The colour map is near-white so the material colour tints it; the emissive map holds lit windows.
import * as THREE from 'three';

const N = 8, PX = 64, FLOOR = 3.3;

function canvas() {
  const c = document.createElement('canvas'); c.width = c.height = N * PX;
  return [c, c.getContext('2d')];
}

function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

const STYLES = {
  // bay width (m), painter(ctx, cell x, cell y, rnd), window rect in cell px (for lights)
  curtain: { bay: 3.0, win: [3, 4, 61, 56], paint(g, x, y, r) {
    const k = 150 + r() * 40 | 0;
    const grad = g.createLinearGradient(0, y, 0, y + PX); grad.addColorStop(0, `rgb(${k + 50},${k + 60},${k + 70})`); grad.addColorStop(1, `rgb(${k},${k + 8},${k + 18})`);
    g.fillStyle = grad; g.fillRect(x, y, PX, PX);
    g.fillStyle = '#e8ecef'; g.fillRect(x, y, 3, PX); g.fillRect(x, y + 56, PX, 8);
  } },
  office: { bay: 4.0, win: [12, 12, 52, 48], paint(g, x, y, r) {
    g.fillStyle = '#f2f0ea'; g.fillRect(x, y, PX, PX);
    g.fillStyle = '#d9d6cf'; g.fillRect(x, y + 54, PX, 4);
    const k = 50 + r() * 30 | 0; g.fillStyle = `rgb(${k},${k + 12},${k + 26})`; g.fillRect(x + 12, y + 12, 40, 36);
    g.fillStyle = '#c9c6bf'; g.fillRect(x + 31, y + 12, 2, 36);
  } },
  brick: { bay: 3.6, win: [18, 12, 46, 46], paint(g, x, y, r) {
    for (let j = 0; j < PX; j += 6) for (let i = (j / 6 % 2) * 7; i < PX + 14; i += 14) {
      const k = 200 + r() * 45 | 0; g.fillStyle = `rgb(${k},${k - 25},${k - 35})`; g.fillRect(x + i - 7, y + j, 13, 5);
    }
    g.fillStyle = '#e6e1d8'; g.fillRect(x + 15, y + 8, 34, 4); g.fillRect(x + 16, y + 46, 32, 3);
    const k = 40 + r() * 25 | 0; g.fillStyle = `rgb(${k},${k + 10},${k + 18})`; g.fillRect(x + 18, y + 12, 28, 34);
    g.fillStyle = '#ddd'; g.fillRect(x + 31, y + 12, 2, 34); g.fillRect(x + 18, y + 27, 28, 2);
  } },
  house: { bay: 5.0, win: [16, 16, 48, 44], paint(g, x, y, r) {
    g.fillStyle = '#f6f4ef'; g.fillRect(x, y, PX, PX);
    if (r() < 0.75) {
      g.fillStyle = '#ffffff'; g.fillRect(x + 13, y + 13, 38, 34);
      const k = 55 + r() * 30 | 0; g.fillStyle = `rgb(${k},${k + 10},${k + 20})`; g.fillRect(x + 16, y + 16, 32, 28);
      g.fillStyle = '#7a5a40'; g.fillRect(x + 8, y + 16, 5, 28); g.fillRect(x + 51, y + 16, 5, 28);  // shutters
    }
  } },
  ribs: { bay: 2.0, win: null, paint(g, x, y) {
    for (let i = 0; i < PX; i += 8) { g.fillStyle = i % 16 ? '#ffffff' : '#d4d6d8'; g.fillRect(x + i, y, 8, PX); }
  } },
};

export function facadeTextures(anisotropy = 4) {
  const out = {};
  for (const [name, st] of Object.entries(STYLES)) {
    const [c, g] = canvas(), [ce, ge] = canvas(), r = rng(name.length * 977);
    ge.fillStyle = '#000'; ge.fillRect(0, 0, N * PX, N * PX);
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const x = i * PX, y = j * PX;
      st.paint(g, x, y, r);
      if (st.win && r() < 0.38) {                       // lit window, warm or cool
        const w = st.win, k = 0.55 + r() * 0.45, warm = r() < 0.75;
        ge.fillStyle = warm ? `rgb(${255 * k | 0},${200 * k | 0},${120 * k | 0})` : `rgb(${190 * k | 0},${220 * k | 0},${255 * k | 0})`;
        ge.fillRect(x + w[0], y + w[1], w[2] - w[0], w[3] - w[1]);
      }
    }
    const tex = (cv) => {
      const t = new THREE.CanvasTexture(cv);
      t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = anisotropy; t.colorSpace = THREE.SRGBColorSpace;
      t.repeat.set(1 / (N * st.bay), 1 / (N * FLOOR));
      return t;
    };
    out[name] = { map: tex(c), emissiveMap: st.win ? tex(ce) : null };
  }
  return out;
}
