import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

export interface ModelViewportInfo {
  vertices: number;
  triangles: number;
  dimensions: [number, number, number];
}

export interface ModelViewportProps {
  url: string | null;
  wireframe: boolean;
  onInfo?: (info: ModelViewportInfo) => void;
}

type ViewStatus = 'empty' | 'loading' | 'ready' | 'error';
type WireMaterial = THREE.Material & { wireframe: boolean };

function disposeObject(object: THREE.Object3D | THREE.Object3D[]) {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  const images = new Set<object>();

  for (const root of Array.isArray(object) ? object : [object]) {
    root.traverse((child) => {
      const renderable = child as THREE.Mesh;
      if (renderable.geometry) geometries.add(renderable.geometry);
      if (renderable.material) {
        for (const material of Array.isArray(renderable.material) ? renderable.material : [renderable.material]) {
          materials.add(material);
        }
      }
    });
  }

  for (const material of materials) {
    for (const value of Object.values(material)) {
      if (value instanceof THREE.Texture) textures.add(value);
    }
    material.dispose();
  }
  for (const texture of textures) {
    const source = texture.source?.data as { close?: () => void } | undefined;
    texture.dispose();
    if (source && typeof source.close === 'function' && !images.has(source)) {
      source.close();
      images.add(source);
    }
  }
  for (const geometry of geometries) geometry.dispose();
}

function readModelInfo(model: THREE.Object3D): { info: ModelViewportInfo; bounds: THREE.Box3 } {
  let vertices = 0;
  let triangles = 0;
  model.updateMatrixWorld(true);
  model.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    const position = mesh.geometry.getAttribute('position');
    if (!position) return;
    const instances = (mesh as THREE.InstancedMesh).isInstancedMesh ? (mesh as THREE.InstancedMesh).count : 1;
    vertices += position.count * instances;
    triangles += Math.floor((mesh.geometry.index?.count ?? position.count) / 3) * instances;
  });
  const bounds = new THREE.Box3().setFromObject(model, true);
  const dimensions = bounds.getSize(new THREE.Vector3());
  if (bounds.isEmpty() || ![...dimensions.toArray(), ...bounds.min.toArray(), ...bounds.max.toArray()].every(Number.isFinite)) {
    throw new Error('모델에서 표시할 수 있는 유효한 3D 형상을 찾지 못했습니다.');
  }
  return { bounds, info: { vertices, triangles, dimensions: dimensions.toArray() as [number, number, number] } };
}

export function ModelViewport({ url, wireframe, onInfo }: ModelViewportProps) {
  const canvasHost = useRef<HTMLDivElement>(null);
  const onInfoRef = useRef(onInfo);
  const wireframeRef = useRef(wireframe);
  const modelMaterials = useRef(new Map<WireMaterial, boolean>());
  const [status, setStatus] = useState<ViewStatus>(url ? 'loading' : 'empty');
  const [error, setError] = useState('');
  onInfoRef.current = onInfo;
  wireframeRef.current = wireframe;

  useEffect(() => {
    for (const [material, originalWireframe] of modelMaterials.current) {
      const next = wireframe || originalWireframe;
      if (material.wireframe !== next) {
        material.wireframe = next;
        material.needsUpdate = true;
      }
    }
  }, [wireframe]);

  useEffect(() => {
    const host = canvasHost.current;
    if (!host) return;
    let disposed = false;
    let contextLost = false;
    let renderFault = false;
    let modelLoaded = false;
    let additionalScenes: THREE.Object3D[] = [];
    let inView = true;
    let frame: number | null = null;
    const abort = new AbortController();
    const materials = new Map<WireMaterial, boolean>();
    modelMaterials.current = materials;
    setStatus(url ? 'loading' : 'empty');
    setError('');

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    } catch {
      setStatus('error');
      setError('WebGL을 초기화하지 못했습니다. 그래픽 드라이버와 하드웨어 가속 설정을 확인해 주세요.');
      return () => { disposed = true; abort.abort(); };
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.1;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.domElement.style.display = 'block';
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    renderer.domElement.style.touchAction = 'none';
    renderer.domElement.setAttribute('aria-label', '회전, 이동, 확대 가능한 3D 모델 뷰포트');
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x142025);
    // Local studio reflections keep metallic PBR materials legible without
    // downloading an HDR file or changing the imported asset's materials.
    const room = new RoomEnvironment();
    const pmrem = new THREE.PMREMGenerator(renderer);
    const studio = pmrem.fromScene(room, 0.04);
    scene.environment = studio.texture;
    room.dispose();
    pmrem.dispose();
    const camera = new THREE.PerspectiveCamera(38, 1, 0.01, 1000);
    camera.up.set(0, 1, 0);
    camera.position.set(7, 5, 8);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.screenSpacePanning = true;
    controls.target.set(0, 0.8, 0);
    controls.update();

    scene.add(new THREE.HemisphereLight(0xd9eee9, 0x263238, 2.3));
    const keyLight = new THREE.DirectionalLight(0xfff7e9, 3.3);
    keyLight.position.set(5, 9, 6);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(1024, 1024);
    keyLight.shadow.normalBias = 0.025;
    scene.add(keyLight, keyLight.target);
    const fillLight = new THREE.DirectionalLight(0xa7d9de, 1.2);
    fillLight.position.set(-6, 4, -5);
    scene.add(fillLight);
    let ground = new THREE.Group();

    const makeGround = (span: number) => {
      scene.remove(ground);
      disposeObject(ground);
      ground = new THREE.Group();
      const gridSize = span * 3.6;
      const floor = new THREE.Mesh(
        new THREE.PlaneGeometry(gridSize, gridSize),
        new THREE.MeshStandardMaterial({ color: 0x142025, roughness: 1, metalness: 0 }),
      );
      floor.rotation.x = -Math.PI / 2;
      floor.position.y = -span * 0.003;
      floor.receiveShadow = true;
      const grid = new THREE.GridHelper(gridSize, 36, 0x3d5757, 0x263b3e);
      const axes = new THREE.AxesHelper(span * 0.25);
      axes.position.set(-span * 0.8, 0, span * 0.8);
      ground.add(floor, grid, axes);
      scene.add(ground);
    };
    makeGround(3);

    const resize = () => {
      if (disposed) return;
      const width = Math.max(1, host.clientWidth);
      const height = Math.max(1, host.clientHeight);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height, false);
    };
    const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize);
    resizeObserver?.observe(host);
    window.addEventListener('resize', resize);
    resize();

    const render = () => {
      frame = null;
      if (disposed || contextLost || renderFault || document.hidden || !inView) return;
      try {
        controls.update();
        renderer.render(scene, camera);
      } catch {
        renderFault = true;
        setStatus('error');
        setError('3D 형상을 렌더링하지 못했습니다. 모델 파일을 확인하고 다시 선택해 주세요.');
        return;
      }
      frame = requestAnimationFrame(render);
    };
    const updateVisibility = () => {
      if (frame !== null) { cancelAnimationFrame(frame); frame = null; }
      if (!disposed && !contextLost && !renderFault && !document.hidden && inView) frame = requestAnimationFrame(render);
    };
    const intersectionObserver = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(([entry]) => {
      inView = entry?.isIntersecting ?? true;
      updateVisibility();
    });
    intersectionObserver?.observe(host);
    document.addEventListener('visibilitychange', updateVisibility);
    const loseContext = (event: Event) => {
      event.preventDefault();
      contextLost = true;
      updateVisibility();
      if (!disposed) { setStatus('error'); setError('그래픽 연결이 끊어졌습니다. 모델을 다시 선택하면 재시도할 수 있습니다.'); }
    };
    const restoreContext = () => {
      contextLost = false;
      renderFault = false;
      if (!disposed) { setStatus(url ? (modelLoaded ? 'ready' : 'loading') : 'empty'); setError(''); }
      updateVisibility();
    };
    renderer.domElement.addEventListener('webglcontextlost', loseContext);
    renderer.domElement.addEventListener('webglcontextrestored', restoreContext);
    updateVisibility();

    if (url) {
      const load = async () => {
        let loadedModel: THREE.Object3D | undefined;
        try {
          const response = await fetch(url, { signal: abort.signal });
          if (!response.ok) throw new Error(`모델 파일을 읽지 못했습니다 (HTTP ${response.status}).`);
          const data = await response.arrayBuffer();
          if (disposed) return;
          if (data.byteLength < 12) throw new Error('GLB 파일이 비어 있거나 헤더가 손상되었습니다.');
          const header = new DataView(data);
          if (header.getUint32(0, true) !== 0x46546c67 || header.getUint32(4, true) !== 2 || header.getUint32(8, true) !== data.byteLength) {
            throw new Error('유효한 GLB 2.0 파일이 아닙니다.');
          }
          let resourcePath = '';
          try { resourcePath = new URL('.', url).href; } catch { /* Embedded GLB resources do not need a base path. */ }
          let resourceError = false;
          const manager = new THREE.LoadingManager();
          manager.onError = () => { resourceError = true; };
          manager.setURLModifier((resourceUrl) => {
            if (/^(blob:|data:)/i.test(resourceUrl)) return resourceUrl;
            throw new Error('외부 파일을 참조하는 모델입니다. 텍스처가 포함된 GLB로 다시 내보내 주세요.');
          });
          const loader = new GLTFLoader(manager);
          const gltf = await loader.parseAsync(data, resourcePath);
          loadedModel = gltf.scene;
          if (disposed) { disposeObject(gltf.scenes); return; }
          additionalScenes = gltf.scenes.filter((item) => item !== loadedModel);
          if (resourceError) throw new Error('모델에 연결된 재질 또는 텍스처 파일을 읽지 못했습니다. 자체 포함된 GLB로 다시 내보내 주세요.');
          const { bounds, info } = readModelInfo(loadedModel);
          const size = new THREE.Vector3(...info.dimensions);
          const center = bounds.getCenter(new THREE.Vector3());
          const span = Math.max(size.x, size.y, size.z, 0.0001);
          const model = new THREE.Group();
          model.add(loadedModel);
          model.position.set(-center.x, -bounds.min.y, -center.z);
          loadedModel.traverse((child) => {
            const mesh = child as THREE.Mesh;
            if (!mesh.isMesh) return;
            mesh.castShadow = true;
            mesh.receiveShadow = true;
            for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
              const surface = material as WireMaterial;
              if (typeof surface.wireframe !== 'boolean' || materials.has(surface)) continue;
              materials.set(surface, surface.wireframe);
              surface.wireframe = wireframeRef.current || surface.wireframe;
            }
          });
          scene.add(model);
          makeGround(span);
          const target = new THREE.Vector3(0, size.y / 2, 0);
          const verticalFov = THREE.MathUtils.degToRad(camera.fov);
          const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * camera.aspect);
          const radius = Math.max(size.length() / 2, span * 0.5);
          const distance = radius / Math.sin(Math.min(verticalFov, horizontalFov) / 2) * 1.15;
          camera.near = Math.max(span / 10000, 0.000001);
          camera.far = Math.max(distance * 50, span * 100);
          camera.position.copy(target).add(new THREE.Vector3(1, 0.68, 1.25).normalize().multiplyScalar(distance));
          camera.updateProjectionMatrix();
          controls.target.copy(target);
          controls.minDistance = span * 0.04;
          controls.maxDistance = span * 30;
          controls.update();
          keyLight.position.copy(target).add(new THREE.Vector3(span * 1.8, span * 2.8, span * 2));
          keyLight.target.position.copy(target);
          keyLight.shadow.camera.left = -span * 2;
          keyLight.shadow.camera.right = span * 2;
          keyLight.shadow.camera.top = span * 2;
          keyLight.shadow.camera.bottom = -span * 2;
          keyLight.shadow.camera.near = Math.max(span / 100, 0.000001);
          keyLight.shadow.camera.far = span * 12;
          keyLight.shadow.normalBias = span * 0.005;
          keyLight.shadow.camera.updateProjectionMatrix();
          fillLight.position.copy(target).add(new THREE.Vector3(-span * 2, span * 1.5, -span * 2));
          modelLoaded = true;
          setStatus(contextLost || renderFault ? 'error' : 'ready');
          onInfoRef.current?.(info);
        } catch (cause) {
          if (disposed || abort.signal.aborted) return;
          if (loadedModel) { scene.remove(loadedModel.parent ?? loadedModel); disposeObject([loadedModel, ...additionalScenes]); }
          additionalScenes = [];
          modelLoaded = false;
          materials.clear();
          setStatus('error');
          setError(cause instanceof Error ? cause.message : '모델을 읽는 동안 오류가 발생했습니다.');
        }
      };
      void load();
    }

    return () => {
      disposed = true;
      abort.abort();
      if (frame !== null) cancelAnimationFrame(frame);
      document.removeEventListener('visibilitychange', updateVisibility);
      window.removeEventListener('resize', resize);
      resizeObserver?.disconnect();
      intersectionObserver?.disconnect();
      renderer.domElement.removeEventListener('webglcontextlost', loseContext);
      renderer.domElement.removeEventListener('webglcontextrestored', restoreContext);
      controls.dispose();
      disposeObject([scene, ...additionalScenes]);
      keyLight.shadow.dispose();
      materials.clear();
      if (modelMaterials.current === materials) modelMaterials.current = new Map();
      renderer.renderLists.dispose();
      studio.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    };
  }, [url]);

  return (
    <div className="model-viewport" style={{ position: 'relative', width: '100%', height: '100%', minHeight: 300, overflow: 'hidden' }}>
      <div className="model-viewport-canvas" ref={canvasHost} style={{ position: 'absolute', inset: 0 }} />
      {status !== 'ready' && (
        <div
          className={`model-viewport-state${status === 'error' ? ' model-viewport-error' : ''}`}
          role={status === 'error' ? 'alert' : 'status'}
          style={{ position: 'absolute', inset: 0, display: 'grid', placeContent: 'center', textAlign: 'center', padding: 24, pointerEvents: 'none', color: status === 'error' ? '#f4aaa4' : '#c7d8d7', background: 'linear-gradient(180deg, transparent, #14202599)' }}
        >
          <strong>{status === 'empty' ? '3D 모델을 선택해 주세요' : status === 'loading' ? 'GLB 모델 불러오는 중…' : '미리보기를 열지 못했습니다'}</strong>
          <span style={{ marginTop: 8, maxWidth: 420, fontSize: 13, lineHeight: 1.6 }}>
            {status === 'empty' ? 'GLB 파일을 가져오거나 에셋을 생성하면 여기에 표시됩니다.' : status === 'loading' ? '파일의 형상과 재질을 읽고 있습니다.' : error}
          </span>
        </div>
      )}
      {status === 'ready' && (
        <div className="model-viewport-help" style={{ position: 'absolute', bottom: 14, left: 16, right: 16, pointerEvents: 'none', display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', color: '#a9c0c4', fontSize: 13 }}>
          <span>왼쪽 드래그 회전 · 오른쪽 드래그 이동 · 휠 확대</span>
          <span>Y ↑ · X 빨강 · Y 초록 · Z 파랑</span>
        </div>
      )}
    </div>
  );
}

export default ModelViewport;
