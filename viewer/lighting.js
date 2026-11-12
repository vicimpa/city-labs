import * as THREE from 'three';

// Procedural outdoor lighting: no remote textures, network or per-frame probes.
const skyFragment = `
varying vec3 vDirection;
uniform vec3 zenith, horizon, groundColor, sunDirection;
uniform float night;
void main() {
  vec3 d = normalize(vDirection);
  vec3 c = mix(horizon, zenith, smoothstep(-0.03, 0.85, d.z));
  c = mix(c, groundColor, 1.0 - smoothstep(-0.25, 0.0, d.z));
  float alignment = max(dot(d, sunDirection), 0.0);
  c += vec3(1.0, 0.83, 0.6) * (pow(alignment, 32.0) * 0.16 + smoothstep(0.99988, 0.99996, alignment) * 3.0) * (1.0 - night);
  c = mix(c, vec3(0.006, 0.012, 0.03) + vec3(0.012, 0.018, 0.032) * (1.0 - abs(d.z)), night);
  gl_FragColor = vec4(c, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export function cityLighting(renderer, scene) {
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  scene.background = new THREE.Color('#b7cadb');
  scene.fog = new THREE.FogExp2('#b7cadb', 0.000065);
  const hemi = new THREE.HemisphereLight('#c9e2ff', '#78694f', 1.8);
  const sun = new THREE.DirectionalLight('#fff0d6', 3.1), direction = new THREE.Vector3(-0.45, -0.5, 0.78).normalize();
  sun.position.copy(direction).multiplyScalar(1000);
  Object.assign(sun.shadow.camera, { left: -240, right: 240, top: 240, bottom: -240, near: 1, far: 1800 });
  sun.shadow.mapSize.set(2048, 2048); sun.shadow.normalBias = 0.18; sun.shadow.bias = -0.00015;
  scene.add(hemi, sun, sun.target);
  const uniforms = { zenith: { value: new THREE.Color('#779fc4') }, horizon: { value: new THREE.Color('#d6e0e6') },
    groundColor: { value: new THREE.Color('#727c70') }, sunDirection: { value: direction }, night: { value: 0 } };
  const environmentMaterial = new THREE.ShaderMaterial({ uniforms, vertexShader: 'varying vec3 vDirection; void main(){vDirection=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}', fragmentShader: skyFragment, side: THREE.BackSide });
  const environmentGeo = new THREE.SphereGeometry(30, 24, 12), environmentScene = new THREE.Scene();
  environmentScene.add(new THREE.Mesh(environmentGeo, environmentMaterial));
  const pmrem = new THREE.PMREMGenerator(renderer), environment = pmrem.fromScene(environmentScene, 0.04, 0.1, 100);
  environmentGeo.dispose(); environmentMaterial.dispose(); pmrem.dispose();
  scene.environment = environment.texture; scene.environmentIntensity = 0.7;
  const skyMaterial = new THREE.ShaderMaterial({ uniforms: { ...uniforms, inverseProjection: { value: new THREE.Matrix4() }, cameraWorld: { value: new THREE.Matrix4() } },
    vertexShader: `varying vec3 vDirection; uniform mat4 inverseProjection, cameraWorld;
      void main(){vec4 v=inverseProjection*vec4(position.xy,1.0,1.0); vDirection=mat3(cameraWorld)*v.xyz; gl_Position=vec4(position.xy,1.0,1.0);}`,
    fragmentShader: skyFragment, depthTest: false, depthWrite: false, fog: false });
  const skyGeo = new THREE.PlaneGeometry(2, 2), sky = new THREE.Mesh(skyGeo, skyMaterial);
  sky.frustumCulled = false; sky.renderOrder = -1000; sky.raycast = () => {}; sky.name = 'Atmosphere'; scene.add(sky);
  let quality = 'medium';
  return {
    hemi, sun,
    setNight(on) {
      uniforms.night.value = on ? 1 : 0; hemi.intensity = on ? 0.25 : 1.8; sun.intensity = on ? 0.13 : 3.1;
      scene.fog.color.set(on ? '#111e31' : '#b7cadb'); scene.environmentIntensity = on ? 0.09 : 0.7;
    },
    setQuality(q) {
      quality = q; renderer.shadowMap.enabled = q === 'high'; sun.castShadow = q === 'high';
      if (q !== 'high') { sun.shadow.map?.dispose(); sun.shadow.map = null; }
    },
    update(camera, target) {
      skyMaterial.uniforms.inverseProjection.value.copy(camera.projectionMatrixInverse);
      skyMaterial.uniforms.cameraWorld.value.copy(camera.matrixWorld);
      if (quality === 'high') { sun.target.position.copy(target); sun.position.copy(target).addScaledVector(direction, 1000); sun.target.updateMatrixWorld(); }
    },
    dispose() { scene.remove(sky, sun, sun.target, hemi); skyGeo.dispose(); skyMaterial.dispose(); environment.dispose(); sun.shadow.dispose(); scene.environment = null; },
  };
}
