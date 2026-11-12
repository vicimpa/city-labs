import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { t } from './i18n.js';
import { materialReferences } from '../format/validate.js';
import { facadeCanvases } from '../viewer/facades.js';

const controllers = new WeakMap();
const DEFAULTS = { color: '#c4cbd2', roughness: 0.7, metalness: 0, opacity: 1, emissive: '#000000', emissiveIntensity: 0, facade: '' };
const element = (tag, className, text) => {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
};
const colorHex = (value, fallback) => {
  try { return `#${new THREE.Color(value ?? fallback).getHexString()}`; } catch { return fallback; }
};
const number = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
// Match World3D's legacy Phong-to-PBR conversion without changing saved definitions.
const roughnessOf = (def) => def.roughness ?? Math.max(0.12, Math.min(1, Math.sqrt(2 / ((def.shininess ?? 5) + 2))));

/** Use the document boundary's dependency rules, including roof/trim and prefab slots. */
export function materialUsage(doc, id) {
  return doc?.layers ? materialReferences(doc, id).length : 0;
}

function preview(host) {
  let renderer, pmrem, environment, room, observer;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 30);
  camera.position.set(2.8, 1.8, 3.8); camera.lookAt(0, 0, 0);
  const material = new THREE.MeshStandardMaterial();
  const sphere = new THREE.SphereGeometry(0.95, 48, 32);
  const cube = new THREE.BoxGeometry(1.45, 1.45, 1.45);
  const mesh = new THREE.Mesh(sphere, material); scene.add(mesh);
  let facadeSignature = null, facadeMaps = [];
  const clearFacade = () => { facadeMaps.forEach((texture) => texture.dispose()); facadeMaps = []; };
  const updateFacade = (params) => {
    const signature = params ? JSON.stringify(params) : null;
    if (signature === facadeSignature) return;
    clearFacade(); facadeSignature = signature;
    material.map = material.emissiveMap = material.bumpMap = null;
    if (!params) return;
    const canvases = facadeCanvases(params);
    for (const [key, canvas, colorData] of [['map', canvases.color, true], ['emissiveMap', canvases.emissive, true], ['bumpMap', canvases.relief, false]]) {
      if (!canvas) continue;
      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = colorData ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
      // Procedural tile contains 8×8 bays; show three on each unit-UV face.
      texture.repeat.set(3 / 8, 3 / 8);
      texture.anisotropy = Math.min(4, renderer?.capabilities.getMaxAnisotropy() ?? 1);
      facadeMaps.push(texture); material[key] = texture;
    }
    material.bumpScale = 0.018;
  };
  let active = true;
  const render = () => {
    if (!active || !renderer || !host.clientWidth) return;
    const w = host.clientWidth, h = host.clientHeight || 170;
    renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
    renderer.render(scene, camera);
  };
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 1.5));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.domElement.setAttribute('aria-label', t('mat.preview'));
    renderer.domElement.setAttribute('role', 'img'); host.append(renderer.domElement);
    pmrem = new THREE.PMREMGenerator(renderer); room = new RoomEnvironment();
    environment = pmrem.fromScene(room, 0.04); scene.environment = environment.texture;
    room.dispose(); room = null; pmrem.dispose(); pmrem = null;
    observer = new ResizeObserver(render); observer.observe(host);
  } catch {
    host.replaceChildren(element('p', 'material-preview-fallback', t('mat.previewUnavailable')));
  }
  return {
    update(def, facadeParams) {
      updateFacade(facadeParams);
      material.color.set(colorHex(def.color, DEFAULTS.color));
      material.roughness = THREE.MathUtils.clamp(number(roughnessOf(def), 0.7), 0, 1);
      material.metalness = THREE.MathUtils.clamp(number(def.metalness, 0), 0, 1);
      material.opacity = THREE.MathUtils.clamp(number(def.opacity, 1), 0, 1);
      material.transparent = material.opacity < 1;
      material.depthWrite = !material.transparent;
      material.emissive.set(colorHex(def.emissive, def.glow ? def.color ?? DEFAULTS.color : material.emissiveMap ? '#ffffff' : '#000000'));
      material.emissiveIntensity = Math.max(0, number(def.emissiveIntensity, def.glow ?? 0));
      material.needsUpdate = true; render();
    },
    shape(box) { mesh.geometry = box ? cube : sphere; render(); },
    dispose() {
      active = false; observer?.disconnect(); clearFacade(); sphere.dispose(); cube.dispose(); material.dispose();
      room?.dispose(); pmrem?.dispose(); environment?.dispose(); renderer?.dispose(); renderer?.forceContextLoss();
    },
  };
}

/**
 * All document mutations go through undoable context callbacks.
 * Returns cleanup(), with cleanup.refresh() for external edits/selection/language changes.
 * Calling again on the same element updates context and refreshes the existing controller.
 */
export function renderMaterialEditor(el, ctx) {
  const existing = controllers.get(el);
  if (existing) { existing.context = ctx; existing.cleanup.refresh(); return existing.cleanup; }
  const state = { context: ctx, selected: null, filter: '', preview: null, box: false, committing: false, disposed: false };
  const previewFacade = (def) => {
    const registry = state.context.getDoc()?.layers?.defs ?? {}, selection = state.context.getSelection?.();
    const type = selection?.kind === 'building' ? selection.rec?.type : null;
    const name = def.facade === 'wall' ? (registry.buildingTypes?.[type]?.wall ?? 'office') : def.facade;
    return name ? registry.facades?.[name] ?? null : null;
  };
  const defs = () => state.context.getDoc()?.layers?.defs?.materials ?? {};
  const chooseId = (base) => {
    const map = defs(); let id = base, suffix = 2;
    while (Object.hasOwn(map, id)) id = `${base}_${suffix++}`;
    return id;
  };
  const run = (fn) => {
    try { fn(); refresh(); } catch (error) {
      const status = el.querySelector('.material-status');
      if (status) { status.textContent = error.message; status.classList.add('error'); }
    }
  };
  const button = (key, fn, className = '') => {
    const b = element('button', className, t(key)); b.type = 'button'; b.onclick = fn; return b;
  };
  function refresh() {
    // setDef may synchronously notify the panel. Its scalar commit updates the
    // existing nodes below so native Tab/Shift+Tab/click navigation can finish.
    if (state.disposed || state.committing) return;
    el.replaceChildren(); el.classList.add('material-editor');
    const map = defs(), ids = Object.keys(map).sort((a, b) => a.localeCompare(b));
    if (!Object.hasOwn(map, state.selected)) state.selected = ids[0] ?? null;
    const header = element('div', 'material-heading');
    header.append(element('h2', '', t('mat.library')), element('span', 'material-count', String(ids.length)));
    const status = element('p', 'material-status'); status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    const controls = element('div', 'material-create');
    const name = element('input'); name.type = 'text'; name.placeholder = t('mat.newName');
    name.setAttribute('aria-label', t('mat.newName')); name.maxLength = 80;
    const create = () => run(() => {
      const input = name.value.trim();
      if (input && !/^[\p{L}\p{N}_-]+$/u.test(input)) throw new Error(t('mat.nameInvalid'));
      const id = chooseId(input || 'material'); state.selected = id; state.filter = '';
      state.context.setDef('materials', id, { ...DEFAULTS });
    });
    name.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); create(); } };
    controls.append(name, button('mat.create', create, 'primary'));
    const search = element('input', 'material-search'); search.type = 'search'; search.placeholder = t('mat.search');
    search.setAttribute('aria-label', t('mat.search')); search.value = state.filter;
    const list = element('div', 'material-list'); list.setAttribute('aria-label', t('mat.library'));
    function populateList() {
      list.replaceChildren();
      for (const id of ids.filter((id) => id.toLowerCase().includes(state.filter.toLowerCase()))) {
        const item = element('button', `material-item${id === state.selected ? ' on' : ''}`);
        item.type = 'button'; item.setAttribute('aria-pressed', String(id === state.selected));
        const swatch = element('span', 'material-swatch'); swatch.style.backgroundColor = colorHex(map[id].color, DEFAULTS.color);
        swatch.setAttribute('aria-hidden', 'true');
        const label = element('span', 'material-item-name', id);
        item.append(swatch, label); item.onclick = () => { state.selected = id; refresh(); };
        list.append(item);
      }
      if (!list.childElementCount) list.append(element('p', 'material-empty', t(ids.length ? 'mat.noMatches' : 'mat.empty')));
    }
    search.oninput = () => { state.filter = search.value; populateList(); }; populateList();
    el.append(header, controls, search, list, status);
    const id = state.selected; if (!id) return;
    const current = () => defs()[id];
    const def = current(), usage = materialUsage(state.context.getDoc(), id);
    const detail = element('section', 'material-detail');
    detail.append(element('h3', 'material-title', id), element('p', 'material-scope', t('mat.shared', { n: usage })));
    const previewBox = element('div', 'material-preview');
    const viewport = state.previewHost ??= element('div', 'material-preview-viewport'); previewBox.append(viewport);
    const shapes = element('div', 'material-preview-shapes');
    const sphereButton = button('mat.sphere', () => { state.box = false; state.preview?.shape(false); sphereButton.classList.add('on'); cubeButton.classList.remove('on'); });
    const cubeButton = button('mat.cube', () => { state.box = true; state.preview?.shape(true); cubeButton.classList.add('on'); sphereButton.classList.remove('on'); });
    (state.box ? cubeButton : sphereButton).classList.add('on'); shapes.append(sphereButton, cubeButton); previewBox.append(shapes);
    detail.append(previewBox, element('p', 'material-preview-note', t('mat.previewNote')));
    const actions = element('div', 'material-actions');
    const assign = button('mat.assign', () => run(() => state.context.assign(id)), 'primary');
    assign.disabled = !['building', 'furniture'].includes(state.context.getSelection?.()?.kind);
    assign.title = t(assign.disabled ? 'mat.selectBuilding' : 'mat.assignAll');
    const duplicate = button('mat.duplicate', () => run(() => {
      const clone = structuredClone(current()); const copyId = chooseId(`${id}_copy`);
      state.selected = copyId; state.filter = ''; state.context.setDef('materials', copyId, clone);
    }));
    actions.append(assign, duplicate); detail.append(actions);
    const write = (key, value) => {
      state.committing = true;
      try {
        const d = current(); if (!d) throw new Error(t('mat.missing'));
        if (!Object.is(d[key], value)) state.context.setDef('materials', id, { ...d, [key]: value });
        const updated = current();
        const swatch = list.querySelector('.material-item.on .material-swatch');
        if (swatch) swatch.style.backgroundColor = colorHex(updated.color, DEFAULTS.color);
        status.textContent = ''; status.classList.remove('error');
      } catch (error) {
        status.textContent = error.message; status.classList.add('error');
      } finally {
        state.committing = false;
        const updated = current(); if (updated) state.preview?.update(updated, previewFacade(updated));
      }
    };
    function group(key) {
      const g = element('fieldset', 'material-group'); g.append(element('legend', '', t(key))); detail.append(g); return g;
    }
    function field(parent, key, type, fallback, min, max, step) {
      const label = element('label', 'material-field'); label.append(element('span', '', t(`mat.${key}`)));
      const input = element('input'); input.type = type; input.dataset.materialField = key;
      input.value = type === 'color' ? colorHex(def[key], fallback) : +number(def[key], fallback).toFixed(4);
      if (min !== undefined) input.min = String(min);
      if (max !== undefined) input.max = String(max);
      if (step !== undefined) input.step = 'any';
      input.oninput = () => {
        if (input.validity.valid) { const draft = { ...current(), [key]: type === 'color' ? input.value : Number(input.value) }; state.preview?.update(draft, previewFacade(draft)); }
      };
      input.onchange = () => {
        if (!input.reportValidity() || input.value === '') return;
        write(key, type === 'color' ? input.value : Number(input.value));
      };
      label.append(input); parent.append(label);
    }
    const surface = group('mat.surface');
    field(surface, 'color', 'color', DEFAULTS.color);
    field(surface, 'roughness', 'number', roughnessOf(def), 0, 1, 0.05);
    field(surface, 'metalness', 'number', 0, 0, 1, 0.05);
    field(surface, 'opacity', 'number', 1, 0, 1, 0.05);
    const emission = group('mat.emission');
    field(emission, 'emissive', 'color', def.color ?? DEFAULTS.color);
    field(emission, 'emissiveIntensity', 'number', def.glow ?? 0, 0, 20, 0.1);
    const facadeGroup = group('mat.facadeGroup');
    const facadeLabel = element('label', 'material-field'); facadeLabel.append(element('span', '', t('mat.facade')));
    const facade = element('select'); facade.dataset.materialField = 'facade';
    const facadeIds = new Set(['', 'wall', ...Object.keys(state.context.getDoc()?.layers?.defs?.facades ?? {})]);
    if (def.facade) facadeIds.add(def.facade);
    for (const value of facadeIds) { const o = element('option', '', value || t('mat.noFacade')); o.value = value; facade.append(o); }
    facade.value = def.facade ?? ''; facade.onchange = () => write('facade', facade.value);
    facadeLabel.append(facade); facadeGroup.append(facadeLabel);
    const footer = element('div', 'material-footer');
    const del = button('mat.delete', () => run(() => {
      if (materialUsage(state.context.getDoc(), id)) throw new Error(t('mat.deleteBlocked'));
      state.context.setDef('materials', id, null);
    }), 'danger');
    del.disabled = usage > 0; del.title = t(usage ? 'mat.deleteBlocked' : 'mat.deleteUnused');
    footer.append(del);
    if (state.context.selectDef) footer.append(button('mat.advanced', () => state.context.selectDef('materials', id), 'link'));
    detail.append(footer); el.append(detail);
    state.preview ??= preview(viewport);
    viewport.querySelector('canvas')?.setAttribute('aria-label', t('mat.preview'));
    state.preview.shape(state.box); state.preview.update(def, previewFacade(def));
  }
  function cleanup() {
    state.disposed = true; state.preview?.dispose(); state.preview = null;
    controllers.delete(el); el.replaceChildren();
  }
  cleanup.refresh = refresh; state.cleanup = cleanup; controllers.set(el, state); refresh(); return cleanup;
}
