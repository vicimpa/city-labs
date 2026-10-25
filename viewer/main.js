// Minimal viewer for the Vespera Bay world (city/data/vespera.vspb, see docs/VSPB.md).
import * as THREE from 'three';
import { MapControls } from 'three/examples/jsm/controls/MapControls.js';
import { World3D, heightAt } from './world3d.js';
import { loadWorld } from '../format/world.js';

const DATA = new URLSearchParams(location.search).get('world') ?? '/city/data/vespera.vspb';
const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0f14);
scene.fog = new THREE.Fog(0x0b0f14, 6000, 16000);
// Z up like the generator
THREE.Object3D.DEFAULT_UP.set(0, 0, 1);
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 1, 40000);
camera.up.set(0, 0, 1);
camera.position.set(0, -7000, 6000);
// GIS-style: LMB pans over the ground, RMB/Ctrl+LMB rotates & tilts, wheel zooms to cursor
const controls = new MapControls(camera, renderer.domElement);
controls.screenSpacePanning = false;               // pan along the ground plane, not the screen
controls.zoomToCursor = true;
controls.enableDamping = true;
controls.dampingFactor = 0.12;
controls.minDistance = 5;
controls.maxDistance = 25000;
controls.maxPolarAngle = Math.PI * 0.48;           // never look from below the horizon
controls.target.set(0, 0, 0);
controls.update();

const hemi = new THREE.HemisphereLight(0xcfd8e6, 0x2a2f25, 1.1);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xffe2c0, 1.6);
sun.position.set(-3000, -2000, 4000);
scene.add(sun);

const layers = {};
const NIGHT = { on: false };
const tickers = [];             // per-frame animations: fn(seconds)
function addLayer(name, obj) {
  layers[name] = obj;
  scene.add(obj);
  const l = document.createElement('label');
  l.innerHTML = `<input type="checkbox" checked> ${name}`;
  l.querySelector('input').onchange = (e) => { obj.visible = e.target.checked; };
  document.getElementById('layers').appendChild(l);
}

// ---------------------------------------------------------------- load
const status = document.getElementById('status');
let world = null;
try {
  const doc = await loadWorld(DATA);
  world = new World3D(doc, { anisotropy: renderer.capabilities.getMaxAnisotropy(), tickers }).buildAll();
  for (const name of ['terrain', 'roads', 'furniture', 'buildings']) addLayer(name, world.groups[name]);
  const { roads, terrain } = doc.layers;
  // physics takes the road mesh built from the graph (not stored in the file)
  Object.defineProperty(roads, 'mesh', { value: world.roadWorld.mesh(), configurable: true, writable: true });
  window.__roads = roads; window.__terrain = terrain;
  status.textContent = `${roads.edges.length} road edges`;
} catch (e) { status.textContent = String(e); console.error(e); }

// ---------------------------------------------------------------- drive test (100 physical cars)
let fleet = null, carMesh = null, physWorld = null, RAPIER = null, player = null;
async function getWorld(roads, terrain) {
  if (physWorld) return physWorld;
  RAPIER = (await import('@dimforge/rapier3d-compat')).default;
  await RAPIER.init();
  const { buildWorld } = await import('./sim.js');
  physWorld = buildWorld(RAPIER, roads, terrain);
  physWorld.timestep = 1 / 30;
  return physWorld;
}
async function startDrive(roads, terrain) {
  const world = await getWorld(roads, terrain);
  const { Fleet, clusterIssues } = await import('./sim.js');
  fleet = new Fleet(RAPIER, world, roads, { count: 100 });
  const g = new THREE.BoxGeometry(4.4, 1.9, 1.3);
  carMesh = new THREE.InstancedMesh(g, new THREE.MeshLambertMaterial({ color: 0xff3366 }), 100);
  scene.add(carMesh);
  const marks = new THREE.Group(); scene.add(marks);
  const mk = new THREE.MeshBasicMaterial({ color: 0xffee00 });
  let seen = 0;
  setInterval(() => {
    for (; seen < fleet.issues.length; seen++) {
      const it = fleet.issues[seen];
      const m = new THREE.Mesh(new THREE.ConeGeometry(2, 8, 6), mk);
      m.rotation.x = -Math.PI / 2; m.position.set(it.p[0], it.p[1], it.z + 6); marks.add(m);
    }
    status.textContent = `cars 100 · problems ${fleet.issues.length} (yellow cones)`;
    window.driveIssues = clusterIssues(fleet.issues);
  }, 1000);
}
const btn = document.createElement('button');
btn.textContent = 'Пустить 100 машин';
btn.style.marginTop = '6px';
document.getElementById('ui').appendChild(btn);
btn.onclick = async () => { btn.disabled = true; btn.textContent = 'запуск…';
  await startDrive(window.__roads, window.__terrain); btn.textContent = 'машины едут'; };
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _v = new THREE.Vector3(), _one = new THREE.Vector3(1, 1, 1);
// ---------------------------------------------------------------- player car (WASD)
const carBtn = document.createElement('button');
carBtn.textContent = 'Сесть в машину';
carBtn.style.cssText = 'margin-top:6px;display:block';
document.getElementById('ui').appendChild(carBtn);
carBtn.onclick = async () => {
  carBtn.blur();
  if (player) { player.dispose(scene); player = null; controls.enabled = true; carBtn.textContent = 'Сесть в машину';
    info.innerHTML = INFO_ORBIT; return; }
  carBtn.disabled = true; carBtn.textContent = 'загрузка физики…';
  const world = await getWorld(window.__roads, window.__terrain);
  const { PlayerCar } = await import('./player.js');
  player = new PlayerCar(RAPIER, world, scene, window.__roads, controls.target);
  controls.enabled = false; carBtn.disabled = false; carBtn.textContent = 'Выйти из машины';
  info.innerHTML = 'W/S — газ/тормоз-задний · A/D — руль · Shift — нитро · Space — ручник · C — назад · R — на дорогу · P — копировать координаты';
};
const info = document.getElementById('info'), INFO_ORBIT = info.innerHTML;
info.innerHTML += ' · P — копировать координаты';

// coordinates HUD: car, camera and the ground point the camera looks at
const hud = document.createElement('div');
hud.style.cssText = 'position:fixed;top:10px;right:10px;background:rgba(12,16,22,.85);padding:8px 10px;border-radius:6px;font:12px ui-monospace,monospace;white-space:pre;color:#cfe3ff';
document.body.appendChild(hud);
const _dir = new THREE.Vector3();
const f1 = (v) => `${v.x.toFixed(1)}, ${v.y.toFixed(1)}, ${v.z.toFixed(1)}`;
let hudText = '', hudT = 0;
// ray-marched against the heightfield: a mesh raycast over ~7M triangles stalled every HUD tick
let _lookH = null;
function lookPoint() {
  if (!window.__terrain) return null;
  _lookH ??= heightAt(window.__terrain);
  camera.getWorldDirection(_dir);
  const o = camera.position, ground = (s) => o.z + _dir.z * s - Math.max(_lookH(o.x + _dir.x * s, o.y + _dir.y * s), 0);
  let prev = 0;
  for (let s = 4; s < 20000; s *= 1.04) {
    if (ground(s) <= 0) {
      let a = prev, b = s;
      for (let k = 0; k < 20; k++) { const m = (a + b) / 2; if (ground(m) > 0) a = m; else b = m; }
      return new THREE.Vector3(o.x + _dir.x * b, o.y + _dir.y * b, o.z + _dir.z * b);
    }
    prev = s;
  }
  return null;
}
function updateHud(ms) {
  if (ms - hudT < 150) return; hudT = ms;
  camera.getWorldDirection(_dir);
  const yaw = (Math.atan2(_dir.y, _dir.x) * 180 / Math.PI).toFixed(0), pitch = (Math.asin(_dir.z) * 180 / Math.PI).toFixed(0);
  const lp = lookPoint();
  let t = '';
  if (player) { const p = player.body.translation(); t += `car     ${f1(p)}  ${(Math.abs(player.speed) * 3.6).toFixed(0)} km/h\n`; }
  t += `camera  ${f1(camera.position)}\n`;
  t += `dir     yaw ${yaw}°  pitch ${pitch}°\n`;
  t += `look at ${lp ? f1(lp) : '—'}`;
  if (!player) t += `\ntarget  ${f1(controls.target)}`;
  hudText = t; hud.textContent = t;
}
addEventListener('keydown', (e) => {
  if (e.code !== 'KeyP') return;
  navigator.clipboard?.writeText(hudText);
  console.log(hudText);
  hud.style.color = '#7dff9a'; setTimeout(() => { hud.style.color = '#cfe3ff'; }, 300);
});

function stepDrive(ms) {
  updateHud(ms);
  const prev = stepDrive.last; stepDrive.last = ms;
  if (player) {
    if (!fleet) { const dt = Math.min((ms - (stepDrive.last ?? ms)) / 1000 || 1 / 60, 1 / 30);
      physWorld.timestep = dt; player.update(dt); physWorld.step(); }
    else player.update(1 / 30);
  }
  if (!fleet) { player?.sync(camera, Math.min((ms - (prev ?? ms)) / 1000 || 1 / 60, 0.1)); return; }
  fleet.step(1 / 30);
  player?.sync(camera, 1 / 60);
  fleet.cars.forEach((c, i) => {
    const p = c.body.translation(), r = c.body.rotation();
    _m.compose(_v.set(p.x, p.y, p.z), _q.set(r.x, r.y, r.z, r.w), _one); carMesh.setMatrixAt(i, _m);
  });
  carMesh.instanceMatrix.needsUpdate = true;
}

// day / night: dim the sky, light the windows and the signs
const nightBtn = document.createElement('button');
nightBtn.textContent = 'Ночь'; nightBtn.style.margin = '6px 0 0 6px';
document.getElementById('ui').appendChild(nightBtn);
function setNight(on) {
  NIGHT.on = on; nightBtn.textContent = on ? 'День' : 'Ночь';
  hemi.intensity = on ? 0.18 : 1.1; sun.intensity = on ? 0.08 : 1.6;
  scene.background.set(on ? 0x05070c : 0x0b0f14);
  world?.setNight(on);
}
nightBtn.onclick = () => setNight(!NIGHT.on);
window.viewer_setNight = setNight;

// double-click focuses the orbit target on the picked point
const ray = new THREE.Raycaster(), mouse = new THREE.Vector2();
renderer.domElement.addEventListener('dblclick', (ev) => {
  mouse.set(ev.clientX / innerWidth * 2 - 1, -(ev.clientY / innerHeight) * 2 + 1);
  ray.setFromCamera(mouse, camera);
  const hit = ray.intersectObjects(scene.children, true)[0];
  if (hit) { controls.target.copy(hit.point); controls.update(); }
});
// expose for scripted screenshots
window.viewer = { camera, controls, scene, setView(px, py, pz, tx, ty, tz) {
  camera.position.set(px, py, pz); controls.target.set(tx, ty, tz); controls.update(); } };

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight);
});
renderer.setAnimationLoop((ms) => { for (const f of tickers) f(ms / 1000); stepDrive(ms); if (!player) controls.update(); renderer.render(scene, camera); });
