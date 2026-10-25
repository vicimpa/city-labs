// Player car: keyboard-driven Rapier raycast vehicle + chase camera. Z-up, +X forward.
import * as THREE from 'three';

const G_WORLD = 0x0001, G_CAR = 0x0002;
const groups = (member, filter) => (member << 16) | filter;
const ENGINE = 5200, BRAKE = 60, STEER_MAX = 0.55;

export class PlayerCar {
  constructor(RAPIER, world, scene, roads, near) {
    Object.assign(this, { RAPIER, world, keys: {}, steer: 0 });
    this.mesh = carModel();
    scene.add(this.mesh);
    this.wheels = this.mesh.userData.wheels;
    this.edges = roads.edges.filter(e => e.pts.length > 4 && !['runway', 'raceway'].includes(e.cls) && !e.tunnel?.some(Boolean));
    this.create(near);
    addEventListener('keydown', (e) => { this.keys[e.code] = true; if (e.code === 'KeyR') this.reset(); });
    addEventListener('keyup', (e) => { this.keys[e.code] = false; });
  }

  // road point closest to `near` (x, y)
  spawnPoint(near) {
    let best = null, bd = Infinity;
    for (const e of this.edges) for (let k = 1; k + 1 < e.pts.length; k++) {
      const p = e.pts[k], d = Math.hypot(p[0] - near.x, p[1] - near.y);
      if (d < bd) { bd = d; best = [p, e.pts[k + 1]]; }
    }
    return best;
  }

  create(near) {
    const R = this.RAPIER, [p, q] = this.spawnPoint(near), yaw = Math.atan2(q[1] - p[1], q[0] - p[0]);
    if (this.body) { this.world.removeVehicleController(this.ctl); this.world.removeRigidBody(this.body); }
    this.body = this.world.createRigidBody(R.RigidBodyDesc.dynamic()
      .setTranslation(p[0], p[1], p[2] + 1.5)
      .setRotation({ x: 0, y: 0, z: Math.sin(yaw / 2), w: Math.cos(yaw / 2) })
      .setCanSleep(false).setAngularDamping(1.2).setAdditionalMass(0));
    // low centre of mass so it doesn't roll over in corners
    this.world.createCollider(R.ColliderDesc.cuboid(2.2, 0.95, 0.45).setTranslation(0, 0, 0.1).setDensity(240)
      .setCollisionGroups(groups(G_CAR, G_WORLD)), this.body);
    const ctl = this.ctl = this.world.createVehicleController(this.body);
    try { ctl.setIndexUpAxis?.(2); ctl.setIndexForwardAxis?.(0); } catch {}
    ctl.indexUpAxis = 2; ctl.setIndexForwardAxis = 0;
    for (const [x, y] of [[1.4, 0.82], [1.4, -0.82], [-1.4, 0.82], [-1.4, -0.82]])
      ctl.addWheel({ x, y, z: -0.25 }, { x: 0, y: 0, z: -1 }, { x: 0, y: 1, z: 0 }, 0.35, 0.36);
    for (let w = 0; w < 4; w++) {
      ctl.setWheelSuspensionStiffness(w, 45); ctl.setWheelFrictionSlip(w, w < 2 ? 2.6 : 2.3);
      ctl.setWheelSuspensionCompression?.(w, 2.6); ctl.setWheelSuspensionRelaxation?.(w, 3.2);
      ctl.setWheelSideFrictionStiffness?.(w, 1.0); ctl.setWheelMaxSuspensionTravel?.(w, 0.4);
    }
  }

  reset() { const p = this.body.translation(); this.create({ x: p.x, y: p.y }); }

  get speed() {
    const r = this.body.rotation(), v = this.body.linvel();
    return v.x * (1 - 2 * (r.y * r.y + r.z * r.z)) + v.y * 2 * (r.x * r.y + r.w * r.z);
  }

  // called before world.step()
  update(dt) {
    const k = this.keys, sp = this.speed;
    const up = k.KeyW || k.ArrowUp, down = k.KeyS || k.ArrowDown;
    const left = k.KeyA || k.ArrowLeft, right = k.KeyD || k.ArrowRight;
    const boost = k.ShiftLeft || k.ShiftRight ? 1.8 : 1;
    // steering eases in and narrows with speed
    const lim = STEER_MAX / (1 + Math.abs(sp) / 18);
    const want = (left ? lim : 0) - (right ? lim : 0);
    this.steer += (want - this.steer) * Math.min(1, dt * 8);
    let force = 0, brake = 0;
    if (up) force = sp < -1 ? 0 : ENGINE * boost, brake = sp < -1 ? BRAKE : 0;
    else if (down) { if (sp > 1) brake = BRAKE; else force = -ENGINE * 0.5; }
    else brake = 3;                                     // engine braking
    if (k.Space) brake = BRAKE * 1.5;
    if (Math.abs(sp) > 70 && force > 0) force = 0;      // ~250 km/h cap
    const c = this.ctl;
    for (const w of [0, 1]) c.setWheelSteering(w, this.steer);
    for (const w of [2, 3]) c.setWheelEngineForce(w, -force);   // +X forward needs negative force
    for (let w = 0; w < 4; w++) c.setWheelBrake(w, k.Space && w < 2 ? brake * 0.3 : brake);
    c.updateVehicle(dt, undefined, groups(G_CAR, G_WORLD));
    const p = this.body.translation();
    if (p.z < -30) this.reset();
  }

  // called after world.step(): sync mesh and chase camera
  sync(camera, dt) {
    const p = this.body.translation(), r = this.body.rotation();
    this.mesh.position.set(p.x, p.y, p.z);
    this.mesh.quaternion.set(r.x, r.y, r.z, r.w);
    for (let w = 0; w < 4; w++) {
      const wm = this.wheels[w], susp = this.ctl.wheelSuspensionLength?.(w) ?? 0.36;
      wm.position.z = -0.25 - susp;
      wm.rotation.set(0, 0, w < 2 ? this.steer : 0);
      wm.children[0].rotation.y = (this.ctl.wheelRotation?.(w) ?? 0);
    }
    const fwd = new THREE.Vector3(1, 0, 0).applyQuaternion(this.mesh.quaternion);
    fwd.z = 0; fwd.normalize();
    const back = this.keys.KeyC ? -1 : 1;
    const dist = 9 + Math.abs(this.speed) * 0.05;
    const want = new THREE.Vector3(p.x - fwd.x * dist * back, p.y - fwd.y * dist * back, p.z + 3.2);
    camera.position.lerp(want, back < 0 ? 1 : Math.min(1, dt * 6));
    camera.lookAt(p.x + fwd.x * 4 * back, p.y + fwd.y * 4 * back, p.z + 1.2);
  }

  dispose(scene) {
    this.world.removeVehicleController(this.ctl); this.world.removeRigidBody(this.body);
    scene.remove(this.mesh);
  }
}

function carModel() {
  const g = new THREE.Group();
  const paint = new THREE.MeshPhongMaterial({ color: 0xd8262f, shininess: 90, specular: 0x666666 });
  const dark = new THREE.MeshPhongMaterial({ color: 0x15181c, shininess: 60 });
  const glass = new THREE.MeshPhongMaterial({ color: 0x223040, shininess: 120, specular: 0x99aabb });
  const box = (w, d, h, x, y, z, m) => { const b = new THREE.Mesh(new THREE.BoxGeometry(w, d, h), m); b.position.set(x, y, z); g.add(b); return b; };
  box(4.4, 1.85, 0.55, 0, 0, -0.05, paint);           // body
  box(2.2, 1.6, 0.5, -0.3, 0, 0.45, glass);            // cabin
  box(2.0, 1.62, 0.06, -0.35, 0, 0.72, paint);         // roof
  box(0.3, 1.7, 0.08, -2.1, 0, 0.35, dark);            // spoiler
  box(0.05, 0.4, 0.15, 2.2, 0.6, 0.05, new THREE.MeshBasicMaterial({ color: 0xfff6d8 }));
  box(0.05, 0.4, 0.15, 2.2, -0.6, 0.05, new THREE.MeshBasicMaterial({ color: 0xfff6d8 }));
  box(0.05, 0.4, 0.12, -2.2, 0.6, 0.05, new THREE.MeshBasicMaterial({ color: 0xff2020 }));
  box(0.05, 0.4, 0.12, -2.2, -0.6, 0.05, new THREE.MeshBasicMaterial({ color: 0xff2020 }));
  const head = new THREE.SpotLight(0xfff2d0, 60, 90, 0.5, 0.5, 1.2);
  head.position.set(2.2, 0, 0.1); head.target.position.set(20, 0, -2); g.add(head, head.target);
  const wheels = [];
  const tyre = new THREE.CylinderGeometry(0.35, 0.35, 0.28, 16);
  for (const [x, y] of [[1.4, 0.82], [1.4, -0.82], [-1.4, 0.82], [-1.4, -0.82]]) {
    const pivot = new THREE.Group(); pivot.position.set(x, y, -0.6);
    const t = new THREE.Mesh(tyre, dark);                 // cylinder axis is Y = axle
    t.add(new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.3, 0.1), new THREE.MeshPhongMaterial({ color: 0x999da3 })));
    pivot.add(t); g.add(pivot); wheels.push(pivot);
  }
  g.userData.wheels = wheels;
  return g;
}
