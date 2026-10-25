// Drive test: physical road world (Rapier) + N cars driving random routes over the road graph.
// Works in Node (tools/drive.mjs) and in the browser viewer. World is Z-up, metres.

const SOLID = ['asphalt', 'concrete', 'barrier', 'guardrail', 'curb', 'sidewalk', 'tunnel', 'grass', 'wall', 'metal'];
const G_WORLD = 0x0001, G_CAR = 0x0002;
const groups = (member, filter) => (member << 16) | filter;

export function buildWorld(RAPIER, roads, terrain, { terrainStep = 1 } = {}) {
  const world = new RAPIER.World({ x: 0, y: 0, z: -9.81 });
  const fixed = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  const worldGroups = groups(G_WORLD, G_WORLD | G_CAR);
  world.names = new Map();                     // collider handle -> material, for probes
  for (const name of SOLID) {
    const m = roads.mesh[name];
    if (!m || !m.i.length) continue;
    const cd = RAPIER.ColliderDesc.trimesh(new Float32Array(m.v), new Uint32Array(m.i)).setCollisionGroups(worldGroups);
    world.names.set(world.createCollider(cd, fixed).handle, name);
    // invisible containment above barriers: a car body sliding along a 0.85 m jersey must not ride over it
    if (name === 'barrier' || name === 'guardrail') {
      const up = Float32Array.from(m.v, (x, k) => (k % 3 === 2 ? x + 0.6 : x));
      world.names.set(world.createCollider(RAPIER.ColliderDesc.trimesh(up, new Uint32Array(m.i)).setCollisionGroups(worldGroups), fixed).handle, name);
    }
  }
  // terrain as a trimesh (downsampled)
  const { nx, ny, x0, y0, res, h } = terrain, s = terrainStep;
  const mx = Math.floor((nx - 1) / s) + 1, my = Math.floor((ny - 1) / s) + 1;
  const v = new Float32Array(mx * my * 3);
  for (let j = 0; j < my; j++) for (let i = 0; i < mx; i++) {
    const k = (j * mx + i) * 3;
    v[k] = x0 + i * s * res; v[k + 1] = y0 + j * s * res; v[k + 2] = h[(j * s) * nx + i * s];
  }
  const idx = new Uint32Array((mx - 1) * (my - 1) * 6);
  let n = 0;
  // no ground inside tunnel bores: a heightfield can't make a vertical portal face, so the
  // cell at the mouth would otherwise slope into the tube
  const bore = new Set((terrain.bore ?? []).map(k => (Math.floor(k / nx) / s | 0) * mx + ((k % nx) / s | 0)));
  for (let j = 0; j < my - 1; j++) for (let i = 0; i < mx - 1; i++) {
    const a = j * mx + i, b = a + 1, c = a + mx, d = c + 1;
    if (bore.has(a) || bore.has(b) || bore.has(c) || bore.has(d)) continue;
    idx.set([a, b, d, a, d, c], n); n += 6;
  }
  world.names.set(world.createCollider(RAPIER.ColliderDesc.trimesh(v, idx.subarray(0, n)).setCollisionGroups(worldGroups), fixed).handle, 'terrain');
  return world;
}

// ---------------------------------------------------------------- road graph
export function buildGraph(roads) {
  const out = new Map();                       // node id -> [{edge, forward}]
  const deg = new Map();
  for (const e of roads.edges) {
    const c = roads.classes[e.cls];
    (out.get(e.n[0]) ?? out.set(e.n[0], []).get(e.n[0])).push({ e, fwd: true });
    if (!c.oneway) (out.get(e.n[1]) ?? out.set(e.n[1], []).get(e.n[1])).push({ e, fwd: false });
    for (const n of e.n) deg.set(n, (deg.get(n) ?? 0) + 1);
  }
  // ramps meet their carriageway mid-edge (lane merge, no shared node): link those taps so
  // routes really drive the diverges and merges
  out.diverge = new Map();                     // host edge id -> [{j, e}] ramps leaving at index j
  out.merge = new Map();                       // ramp edge id -> {h, j} host joined at index j
  const oneway = roads.edges.filter(e => roads.classes[e.cls].oneway);
  const tap = (e, k) => {
    const p = e.pts[k], q = e.pts[k ? k - 1 : 1];
    const td = k ? [p[0] - q[0], p[1] - q[1]] : [q[0] - p[0], q[1] - p[1]];
    let best = null;
    for (const h of oneway) {
      if (h === e) continue;
      const lim = roads.classes[h.cls].hw + roads.classes[e.cls].hw + 1;
      for (let j = 0; j < h.pts.length; j++) {
        const d = Math.hypot(h.pts[j][0] - p[0], h.pts[j][1] - p[1]);
        if (d > lim || Math.abs(h.pts[j][2] - p[2]) > 1.5 || (best && d >= best.d)) continue;
        const ja = h.pts[Math.max(j - 1, 0)], jb = h.pts[Math.min(j + 1, h.pts.length - 1)];
        const th = [jb[0] - ja[0], jb[1] - ja[1]];
        if (th[0] * td[0] + th[1] * td[1] < 0.8 * Math.hypot(...th) * Math.hypot(...td)) continue;
        best = { d, h, j };
      }
    }
    return best;
  };
  for (const e of oneway) {
    if (deg.get(e.n[0]) === 1) {
      const t = tap(e, 0);
      if (t) (out.diverge.get(t.h.id) ?? out.diverge.set(t.h.id, []).get(t.h.id)).push({ j: t.j, e });
    }
    if (deg.get(e.n[1]) === 1) {
      const t = tap(e, e.pts.length - 1);
      if (t) out.merge.set(e.id, { h: t.h, j: t.j });
    }
  }
  return out;
}

function lanePts(e, fwd, classes) {
  const c = classes[e.cls];
  let pts = fwd ? e.pts : [...e.pts].reverse();
  const off = c.oneway ? 0 : -Math.max(1.8, c.hw * 0.45);   // right-hand traffic
  return pts.map((p, i) => {
    const a = pts[Math.max(i - 1, 0)], b = pts[Math.min(i + 1, pts.length - 1)];
    let tx = b[0] - a[0], ty = b[1] - a[1]; const L = Math.hypot(tx, ty) || 1; tx /= L; ty /= L;
    return [p[0] - ty * off, p[1] + tx * off, p[2], e.name];
  });
}

function routeFrom(graph, roads, rng, startEdge, len = 3000) {
  let e = startEdge, fwd = startEdge.__fwd ?? true, i0 = 0, pts = [], total = 0;
  for (let k = 0; k < 40 && total < len; k++) {
    let lp = lanePts(e, fwd, roads.classes).slice(i0), next = null;
    // half the time take the first ramp that leaves this carriageway ahead
    const taps = fwd ? (graph.diverge.get(e.id) ?? []).filter(t => t.j > i0 + 2).sort((a, b) => a.j - b.j) : [];
    if (taps.length && rng() < 0.5) {
      lp = lp.slice(0, taps[0].j - i0 + 1);
      next = { e: taps[0].e, fwd: true, i0: 1 };
    }
    pts.push(...(pts.length ? lp.slice(1) : lp));
    for (let i = 1; i < lp.length; i++) total += Math.hypot(lp[i][0] - lp[i - 1][0], lp[i][1] - lp[i - 1][1]);
    if (!next) {
      const node = fwd ? e.n[1] : e.n[0];
      const opts = (graph.get(node) ?? []).filter(o => o.e !== e);
      const m = fwd && graph.merge.get(e.id);
      const tail = fwd && (graph.diverge.get(e.id) ?? []).find(t => t.j >= e.pts.length - 3);
      if (opts.length) { const o = opts[Math.floor(rng() * opts.length)]; next = { e: o.e, fwd: o.fwd, i0: 0 }; }
      else if (m) next = { e: m.h, fwd: true, i0: Math.min(m.j + 1, m.h.pts.length - 2) };
      else if (tail) next = { e: tail.e, fwd: true, i0: 1 };
      else break;
    }
    ({ e, fwd, i0 } = next);
  }
  return pts;
}

export function mulberry(seed) {
  return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

// ---------------------------------------------------------------- driver
const V_TOP = 26, A_LAT = 4.5, A_BRAKE = 4.0;

// arc length and the curve speed limit at every route point (curvature from the circumcircle
// of points ~10 m apart, so 8 m sampling noise does not read as a bend)
function profile(R) {
  const rs = [0];
  for (let i = 1; i < R.length; i++) rs.push(rs[i - 1] + Math.hypot(R[i][0] - R[i - 1][0], R[i][1] - R[i - 1][1]));
  const vk = R.map((_, i) => {
    let a = i, c = i;
    while (a > 0 && rs[i] - rs[a] < 10) a--;
    while (c < R.length - 1 && rs[c] - rs[i] < 10) c++;
    if (a === i || c === i) return V_TOP;
    const A = R[a], B = R[i], C = R[c];
    const ab = Math.hypot(B[0] - A[0], B[1] - A[1]), bc = Math.hypot(C[0] - B[0], C[1] - B[1]), ca = Math.hypot(A[0] - C[0], A[1] - C[1]);
    const cross = Math.abs((B[0] - A[0]) * (C[1] - A[1]) - (B[1] - A[1]) * (C[0] - A[0]));
    const k = 2 * cross / Math.max(ab * bc * ca, 1e-6);
    return Math.min(V_TOP, Math.sqrt(A_LAT / Math.max(k, 1e-6)));
  });
  return { rs, vk };
}

// arc length of the point of the route nearest to (x, y), searched around waypoint wp
function nearestS(R, S, wp, x, y) {
  let best = Infinity, bs = S[wp];
  for (let i = Math.max(0, wp - 2); i < Math.min(R.length - 1, wp + 4); i++) {
    const ax = R[i][0], ay = R[i][1], dx = R[i + 1][0] - ax, dy = R[i + 1][1] - ay, L2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2));
    const d = Math.hypot(ax + dx * t - x, ay + dy * t - y);
    if (d < best) { best = d; bs = S[i] + t * (S[i + 1] - S[i]); }
  }
  return bs;
}

function routeAt(R, S, s) {
  let i = 1;
  while (i < R.length - 1 && S[i] < s) i++;
  const t = Math.max(0, Math.min(1, (s - S[i - 1]) / Math.max(S[i] - S[i - 1], 1e-6)));
  return [R[i - 1][0] + (R[i][0] - R[i - 1][0]) * t, R[i - 1][1] + (R[i][1] - R[i - 1][1]) * t];
}

// ---------------------------------------------------------------- cars
export class Fleet {
  constructor(RAPIER, world, roads, { count = 100, seed = 1 } = {}) {
    Object.assign(this, { RAPIER, world, roads, rng: mulberry(seed), cars: [], issues: [] });
    this.graph = buildGraph(roads);
    this.drivable = roads.edges.filter(e => e.pts.length > 4 && !['runway'].includes(e.cls));
    for (let i = 0; i < count; i++) this.cars.push(this.spawn());
  }

  spawn(car) {
    const R = this.RAPIER;
    const e = this.drivable[Math.floor(this.rng() * this.drivable.length)];
    e.__fwd = this.roads.classes[e.cls].oneway ? true : this.rng() < 0.5;
    const route = routeFrom(this.graph, this.roads, this.rng, e);
    const p = route[1], q = route[3] ?? route[route.length - 1];
    const yaw = Math.atan2(q[1] - p[1], q[0] - p[0]);
    if (car) { this.world.removeVehicleController(car.ctl); this.world.removeRigidBody(car.body); }
    const body = this.world.createRigidBody(R.RigidBodyDesc.dynamic()
      .setTranslation(p[0], p[1], p[2] + 1.2)
      .setRotation({ x: 0, y: 0, z: Math.sin(yaw / 2), w: Math.cos(yaw / 2) })
      .setCanSleep(false).setAngularDamping(1.5));
    this.world.createCollider(R.ColliderDesc.cuboid(2.2, 0.95, 0.5).setDensity(220)
      .setCollisionGroups(groups(G_CAR, G_WORLD)), body);
    const ctl = this.world.createVehicleController(body);
    ctl.indexUpAxis = 2; ctl.setIndexForwardAxis = 0;
    try { ctl.setIndexUpAxis?.(2); ctl.setIndexForwardAxis?.(0); } catch {}
    for (const [x, y] of [[1.4, 0.82], [1.4, -0.82], [-1.4, 0.82], [-1.4, -0.82]]) {
      ctl.addWheel({ x, y, z: -0.25 }, { x: 0, y: 0, z: -1 }, { x: 0, y: 1, z: 0 }, 0.35, 0.36);
    }
    for (let w = 0; w < 4; w++) {
      ctl.setWheelSuspensionStiffness(w, 40); ctl.setWheelFrictionSlip(w, 2.2);
      ctl.setWheelSuspensionCompression?.(w, 2.5); ctl.setWheelSuspensionRelaxation?.(w, 3.0);
      ctl.setWheelSideFrictionStiffness?.(w, 0.8);
      ctl.setWheelMaxSuspensionTravel?.(w, 0.4);
    }
    const { rs, vk } = profile(route);
    return { body, ctl, route, rs, vk, wp: 2, best: 0, lastProgressT: 0, t: 0, backT: 0, routeName: e.name };
  }

  report(car, kind, p, note) {
    this.issues.push({ rule: `D-${kind}`, p: [Math.round(p.x), Math.round(p.y)], z: Math.round(p.z * 10) / 10,
      msg: `${car.route[Math.min(car.wp, car.route.length - 1)][3]}: ${note}`, sev: 3 });
  }

  step(dt) {
    for (let i = 0; i < this.cars.length; i++) {
      const car = this.cars[i], b = car.body, p = b.translation(), rot = b.rotation();
      car.t += dt;
      // heading from quaternion (rotate +X)
      const fx = 1 - 2 * (rot.y * rot.y + rot.z * rot.z), fy = 2 * (rot.x * rot.y + rot.w * rot.z);
      const upz = 1 - 2 * (rot.x * rot.x + rot.y * rot.y);
      // advance waypoint
      // track the nearest route point in a window ahead, so a waypoint passed wide is not chased back
      let wp = car.wp, best = Infinity;
      for (let k = car.wp; k < Math.min(car.wp + 8, car.route.length - 1); k++) {
        const d = Math.hypot(car.route[k][0] - p.x, car.route[k][1] - p.y);
        if (d < best) { best = d; wp = k; }
      }
      while (wp < car.route.length - 1 && Math.hypot(car.route[wp][0] - p.x, car.route[wp][1] - p.y) < 9) wp++;
      car.wp = wp;
      const tgt = car.route[Math.min(wp + 1, car.route.length - 1)];
      const dz = p.z - tgt[2];
      // checks
      if (wp > car.best) { car.best = wp; car.lastProgressT = car.t; }
      let bad = null;
      if (upz < 0.3) bad = ['flip', 'car flipped'];
      else if (dz < -4) bad = ['fall', `fell ${(-dz).toFixed(1)} m below the road`];
      else if (dz > 6) bad = ['air', `${dz.toFixed(1)} m above the road`];
      else if (car.t - car.lastProgressT > 8) bad = ['stuck', 'no progress for 8 s'];
      if (bad || wp >= car.route.length - 2) {
        if (bad) this.report(car, bad[0], p, bad[1]);
        this.cars[i] = this.spawn(car);
        continue;
      }
      // Stanley steering: heading of the lane a little ahead + a pull back onto the lane line
      const v = b.linvel(), speed = v.x * fx + v.y * fy, R = car.route, S = car.rs;
      const s0 = nearestS(R, S, wp, p.x, p.y);
      const Ld = Math.max(7, Math.min(30, 5 + 0.7 * Math.abs(speed)));
      const c0 = routeAt(R, S, s0), ahead = 2 + 0.35 * Math.max(speed, 0);
      const h0 = routeAt(R, S, s0 + ahead), h1 = routeAt(R, S, s0 + ahead + 4);
      const th = Math.atan2(h1[1] - h0[1], h1[0] - h0[0]);
      const t0 = routeAt(R, S, s0 + 1);
      const tx = t0[0] - c0[0], ty = t0[1] - c0[1], tl = Math.hypot(tx, ty) || 1;
      const ect = (tx * (p.y - c0[1]) - ty * (p.x - c0[0])) / tl;          // + = left of the lane line
      const herr = Math.atan2(Math.sin(th - Math.atan2(fy, fx)), Math.cos(th - Math.atan2(fy, fx)));
      const a = herr + Math.atan2(-1.5 * ect, Math.max(speed, 0) + 3);
      // speed: lateral-acceleration limit on every bend ahead, reachable with comfortable braking
      let vdes = V_TOP;
      for (let k = wp; k < R.length - 1 && S[k] - s0 < 120; k++) {
        const d = Math.max(0, S[k] - s0);
        vdes = Math.min(vdes, Math.sqrt(car.vk[k] ** 2 + 2 * A_BRAKE * d));
      }
      if (Math.abs(a) > 0.6) vdes = Math.min(vdes, 6);
      car.dbg = { vdes: +vdes.toFixed(1), a: +a.toFixed(2), speed: +speed.toFixed(1), wp, n: R.length, vkMin: +Math.min(...car.vk.slice(wp, wp + 15)).toFixed(1) };
      // never ask for more steering than the tyres hold at this speed (a car at 25 m/s rolls on 0.6 rad)
      const smax = Math.min(0.6, Math.atan(2.8 * 1.4 * A_LAT / Math.max(speed * speed, 1)));
      let steer = Math.max(-smax, Math.min(smax, a));
      let force = Math.max(-1500, Math.min(2600, (vdes - speed) * 900));
      // blocked (kerb, barrier, nose in a wall): back out with the wheel turned the other way
      if (car.backT > 0) { car.backT -= dt; force = speed > -3 ? -2200 : 0; steer = -steer; }
      else if (Math.abs(speed) < 0.4 && vdes > 3) { if ((car.slowT = (car.slowT ?? 0) + dt) > 2) { car.backT = 1.6; car.slowT = 0; } }
      else car.slowT = 0;
      if (car.backT > 0) {
        for (const w of [0, 1]) car.ctl.setWheelSteering(w, steer);
        for (const w of [2, 3]) car.ctl.setWheelEngineForce(w, 2200);
        for (const w of [0, 1, 2, 3]) car.ctl.setWheelBrake(w, 0);
        car.ctl.updateVehicle(dt, undefined, groups(G_CAR, G_WORLD));
        continue;
      }
      for (const w of [0, 1]) car.ctl.setWheelSteering(w, steer);
      for (const w of [2, 3]) car.ctl.setWheelEngineForce(w, force > 0 ? -force : 0);   // +X forward needs negative force
      for (const w of [0, 1, 2, 3]) car.ctl.setWheelBrake(w, force < 0 ? -force / 1500 * 30 : 0);
      car.ctl.updateVehicle(dt, undefined, groups(G_CAR, G_WORLD));
    }
    this.world.step();
  }
}

export function clusterIssues(list, cell = 25) {
  const m = new Map();
  for (const it of list) {
    const k = `${it.rule}:${Math.floor(it.p[0] / cell)}:${Math.floor(it.p[1] / cell)}`;
    const o = m.get(k);
    if (o) o.count++; else m.set(k, { ...it, count: 1 });
  }
  return [...m.values()].sort((a, b) => b.count - a.count);
}
