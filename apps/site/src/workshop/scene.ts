import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { actionReady, assets, assetUrl, cells, freshGame, interact, movePlayer, replacePlacement, routeToGoal, type AssetId, type Notice, type Placement, type Point } from './state';

export type Snapshot = { loaded: number; delivered: number; carrying: boolean; notice: Notice; layout: Placement[]; actionReady?: boolean; failed?: boolean };
export type Workshop = {
  setMove(x: number, z: number): void; action(): void; guide(): void; setMode(mode: 'play' | 'edit'): void;
  select(id: AssetId): void; rotate(): void; reset(): void; restore(layout: Placement[]): void;
  view(): void; snapshot(): Snapshot; capture(): Promise<Blob>; dispose(): void;
};

export async function createWorkshop(host: HTMLElement, layout: Placement[], onChange: (s: Snapshot) => void, signal: AbortSignal): Promise<Workshop> {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'low-power' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.25;
  const canvas = renderer.domElement;
  canvas.setAttribute('aria-label', 'Playable workshop with real Blender GLB models');
  host.appendChild(canvas);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#10293b');
  const camera = new THREE.OrthographicCamera();
  camera.near = .1; camera.far = 80;
  let angle = Math.PI / 4;
  const geometry = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  const register = (object: THREE.Object3D) => object.traverse(o => {
    if (!(o instanceof THREE.Mesh)) return;
    geometry.add(o.geometry);
    for (const mat of Array.isArray(o.material) ? o.material : [o.material]) {
      materials.add(mat);
      for (const value of Object.values(mat)) if (value instanceof THREE.Texture) textures.add(value);
    }
  });
  function mesh(shape: THREE.BufferGeometry, color: string, position: [number, number, number], emissive = false) {
    const material = new THREE.MeshStandardMaterial({ color, roughness: .68, metalness: .12, ...(emissive ? { emissive: color, emissiveIntensity: 1.4 } : {}) });
    const object = new THREE.Mesh(shape, material);
    object.position.set(...position); object.castShadow = true; object.receiveShadow = true;
    scene.add(object); register(object); return object;
  }
  const fill = new THREE.HemisphereLight('#d8f2ff', '#446363', 2.3); scene.add(fill);
  const sun = new THREE.DirectionalLight('#fff0cf', 3.4);
  sun.position.set(-3, 9, 5); sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  Object.assign(sun.shadow.camera, { left: -7, right: 7, top: 7, bottom: -7, near: .5, far: 24 });
  sun.shadow.bias = -.0005; scene.add(sun);
  mesh(new THREE.BoxGeometry(10, .36, 10), '#33535f', [0, -.23, 0]);
  mesh(new THREE.BoxGeometry(9.7, .05, 9.7), '#718f92', [0, -.025, 0]);
  const grid = new THREE.GridHelper(9.5, 19, '#476d73', '#56797e');
  grid.position.y = .005; scene.add(grid);
  geometry.add(grid.geometry); materials.add(grid.material as THREE.Material);
  mesh(new THREE.BoxGeometry(10, .12, .12), '#90c5c8', [0, .02, -4.85], true);
  mesh(new THREE.BoxGeometry(.12, .12, 10), '#557580', [-4.85, .02, 0]);
  mesh(new THREE.BoxGeometry(.12, .12, 10), '#557580', [4.85, .02, 0]);
  mesh(new THREE.BoxGeometry(3.2, 2.15, .14), '#294e62', [0, 1.07, -4.5]);
  mesh(new THREE.BoxGeometry(2.5, .08, .18), '#77ced5', [0, 1.68, -4.38], true);
  mesh(new THREE.BoxGeometry(1.6, .04, .18), '#91aaa6', [0, .82, -4.38]);
  for (const x of [-4.2, 4.2]) {
    mesh(new THREE.BoxGeometry(.28, 1.5, .28), '#294e62', [x, .75, -3.5]);
    mesh(new THREE.BoxGeometry(.42, .12, .42), '#d3edf0', [x, 1.52, -3.5], true);
  }
  const robot = new THREE.Group(); scene.add(robot);
  const robotBody = mesh(new THREE.CapsuleGeometry(.18, .26, 4, 10), '#e2eee8', [0, .37, 0]);
  const visor = mesh(new THREE.BoxGeometry(.23, .11, .14), '#75dcf0', [0, .5, .17], true);
  const backpack = mesh(new THREE.BoxGeometry(.23, .25, .17), '#3a7787', [0, .4, -.19]);
  robot.add(robotBody, visor, backpack);
  const carried = mesh(new THREE.OctahedronGeometry(.14), '#ffda91', [0, .88, 0], true); robot.add(carried); carried.visible = false;
  const cellObjects = cells.map(p => {
    const group = new THREE.Group(); scene.add(group); group.position.set(p.x, 0, p.z);
    const core = mesh(new THREE.OctahedronGeometry(.17), '#ffda91', [0, .35, 0], true);
    const pad = mesh(new THREE.CylinderGeometry(.34, .34, .04, 20), '#355b63', [0, .02, 0]);
    group.add(core, pad); return { group, core, pad };
  });
  const marker = mesh(new THREE.RingGeometry(.15, .24, 24), '#bfe9eb', [0, .02, 0], true);
  marker.rotation.x = -Math.PI / 2; marker.visible = false;
  const rings = new Map<AssetId, THREE.Mesh>();
  for (const asset of assets) {
    const ring = mesh(new THREE.RingGeometry(.73, .78, 36), '#82c9d1', [0, .014, 0], true);
    ring.rotation.x = -Math.PI / 2; rings.set(asset.id, ring);
  }
  const props = new Map<AssetId, THREE.Group>();
  let disposed = false, frame = 0, lastTime = 0;
  let game = freshGame(), placements = layout.map(p => ({ ...p }));
  let mode: 'play' | 'edit' = 'play', selected: AssetId = 'table';
  let direction: Point = { x: 0, z: 0 }, target: Point | null = null;
  let waypoints: Point[] = [], wasActionReady = false;
  let notice: Notice = 'collect';
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  function snapshot(): Snapshot { return { loaded: props.size, delivered: game.delivered.length, carrying: game.carrying !== null, notice, layout: placements.map(p => ({ ...p })), actionReady: mode === 'play' && actionReady(game, placements) }; }
  function publish() { if (!disposed) onChange(snapshot()); }
  function applyPlacements() {
    for (const p of placements) {
      const prop = props.get(p.id);
      if (prop) { prop.position.set(p.x, 0, p.z); prop.rotation.y = p.rotation * Math.PI / 180; prop.updateMatrixWorld(true); }
      const ring = rings.get(p.id)!; ring.position.set(p.x, .014, p.z); ring.visible = mode === 'edit' && selected === p.id;
    }
  }
  function positionCamera() {
    camera.position.set(Math.sin(angle) * 11, 12.5, Math.cos(angle) * 11); camera.lookAt(0, 0, 0); camera.updateMatrixWorld();
  }
  function resize() {
    const width = Math.max(1, host.clientWidth), height = Math.max(1, host.clientHeight);
    const aspect = width / height, span = Math.max(11, 13.6 / aspect);
    camera.left = -span * aspect / 2; camera.right = span * aspect / 2; camera.top = span / 2; camera.bottom = -span / 2;
    camera.updateProjectionMatrix(); renderer.setSize(width, height);
  }
  const observer = new ResizeObserver(resize); observer.observe(host); positionCamera(); resize();
  function stopMove() { direction = { x: 0, z: 0 }; target = null; waypoints = []; marker.visible = false; }
  function dispose() {
    if (disposed) return; disposed = true; cancelAnimationFrame(frame); observer.disconnect();
    canvas.removeEventListener('pointerup', pointer); canvas.removeEventListener('webglcontextlost', contextLost);
    window.removeEventListener('blur', stopMove); document.removeEventListener('visibilitychange', visibility);
    signal.removeEventListener('abort', dispose);
    geometry.forEach(g => g.dispose()); materials.forEach(m => m.dispose()); textures.forEach(t => t.dispose());
    sun.shadow.dispose(); renderer.dispose(); canvas.remove();
  }
  signal.addEventListener('abort', dispose, { once: true });
  try {
    const loader = new GLTFLoader();
    // Sequential loading keeps allocation bounded and every model tied to its native record.
    for (const spec of assets) {
      const response = await fetch(assetUrl(spec.id), { signal });
      if (!response.ok) throw new Error(`Model HTTP ${response.status}`);
      const bytes = await response.arrayBuffer();
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), n => n.toString(16).padStart(2, '0')).join('');
      if (bytes.byteLength !== spec.bytes || digest !== spec.sha256) throw new Error('Model integrity check failed');
      const gltf = await loader.parseAsync(bytes, '/examples/local-prop-kit/');
      register(gltf.scene);
      if (disposed || signal.aborted) { dispose(); geometry.forEach(g => g.dispose()); materials.forEach(m => m.dispose()); throw new DOMException('Aborted', 'AbortError'); }
      gltf.scene.traverse(o => { if (o instanceof THREE.Mesh) { o.castShadow = true; o.receiveShadow = true; } });
      props.set(spec.id, gltf.scene); scene.add(gltf.scene);
    }
  } catch (error) { dispose(); throw error; }
  applyPlacements(); canvas.dataset.loadedAssets = String(props.size); publish();
  const raycaster = new THREE.Raycaster(), floor = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  function pointer(event: PointerEvent) {
    if (event.button !== 0 || disposed) return;
    const rect = canvas.getBoundingClientRect(), point = new THREE.Vector3();
    raycaster.setFromCamera(new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1), camera);
    if (!raycaster.ray.intersectPlane(floor, point)) return;
    if (mode === 'edit') {
      const next = replacePlacement(placements, selected, point);
      if (next) { placements = next; applyPlacements(); notice = 'placed'; } else notice = 'blocked';
      publish();
    } else if (Math.abs(point.x) < 4.45 && Math.abs(point.z) < 4.45) {
      waypoints = [];
      target = { x: point.x, z: point.z }; marker.position.set(point.x, .02, point.z); marker.visible = true;
    }
  }
  function contextLost(event: Event) { event.preventDefault(); stopMove(); onChange({ ...snapshot(), failed: true }); dispose(); }
  canvas.addEventListener('pointerup', pointer); canvas.addEventListener('webglcontextlost', contextLost);
  window.addEventListener('blur', stopMove);
  function visibility() { stopMove(); lastTime = 0; if (document.hidden) cancelAnimationFrame(frame); else if (!disposed) frame = requestAnimationFrame(tick); }
  document.addEventListener('visibilitychange', visibility);
  function tick(now: number) {
    if (disposed || document.hidden) return;
    const dt = lastTime ? (now - lastTime) / 1000 : 0; lastTime = now;
    if (mode === 'play') {
      if (target && Math.hypot(target.x - game.player.x, target.z - game.player.z) < .1) { target = waypoints.shift() ?? null; if (!target) marker.visible = false; }
      const input = target ? { x: target.x - game.player.x, z: target.z - game.player.z } : { x: direction.x * Math.cos(angle) + direction.z * Math.sin(angle), z: -direction.x * Math.sin(angle) + direction.z * Math.cos(angle) };
      const previous = game.player;
      const seconds = target ? Math.min(dt, Math.hypot(input.x, input.z) / 3.1) : dt;
      game.player = movePlayer(game.player, input, seconds, placements);
      if (Math.hypot(game.player.x - previous.x, game.player.z - previous.z) > .001) robot.rotation.y = Math.atan2(input.x, input.z);
    }
    robot.position.set(game.player.x, 0, game.player.z); carried.visible = game.carrying !== null;
    cellObjects.forEach(({ group, core }, id) => {
      group.visible = game.carrying !== id && !game.delivered.includes(id);
      core.rotation.y = reducedMotion ? 0 : now * .0008;
    });
    for (const [id, ring] of rings) {
      const index = assets.findIndex(a => a.id === id);
      ring.visible = mode === 'edit' ? id === selected : index < game.delivered.length;
      (ring.material as THREE.MeshStandardMaterial).color.set(mode === 'edit' ? '#82c9d1' : '#ffda91');
    }
    canvas.dataset.playerX = game.player.x.toFixed(3); canvas.dataset.playerZ = game.player.z.toFixed(3);
    const ready = mode === 'play' && actionReady(game, placements);
    if (ready !== wasActionReady) { wasActionReady = ready; publish(); }
    renderer.render(scene, camera); frame = requestAnimationFrame(tick);
  }
  frame = requestAnimationFrame(tick);
  return {
    setMove(x, z) { direction = { x, z }; target = null; waypoints = []; marker.visible = false; },
    action() { if (mode !== 'play') return; const result = interact(game, placements); game = result.game; notice = result.notice; publish(); },
    guide() { if (mode !== 'play') return; stopMove(); waypoints = routeToGoal(game, placements); const goal = waypoints[waypoints.length - 1]; target = waypoints.shift() ?? null; if (goal) { marker.position.set(goal.x, .02, goal.z); marker.visible = true; } },
    setMode(value) { mode = value; stopMove(); if (mode === 'edit') game.player = { ...freshGame().player }; applyPlacements(); publish(); },
    select(id) { selected = id; applyPlacements(); },
    rotate() { const p = placements.find(p => p.id === selected)!; const next = replacePlacement(placements, selected, p, true); if (next) { placements = next; notice = 'placed'; applyPlacements(); } else notice = 'blocked'; publish(); },
    reset() { game = freshGame(); stopMove(); notice = 'collect'; publish(); },
    restore(value) { placements = value.map(p => ({ ...p })); game = freshGame(); stopMove(); notice = 'restored'; applyPlacements(); publish(); },
    view() { angle = (angle + Math.PI / 2) % (Math.PI * 2); positionCamera(); },
    snapshot,
    async capture() { renderer.render(scene, camera); return new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Image unavailable')), 'image/png')); },
    dispose,
  };
}
