/** Independent, read-only export inspection. No app database or worker code is loaded. */
import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PNG } from 'pngjs';
import { Box3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const MAX_BYTES = 256 * 1024 * 1024;
const MAX_PIXELS = 64 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/i;
const fail = (message) => { throw new Error(message); };

// GLTFLoader uses these browser primitives for in-memory buffers and PNG textures.
// This decodes pixels without creating a WebGL context or fetching network resources.
globalThis.self ??= globalThis;
globalThis.ProgressEvent ??= class ProgressEvent {
  constructor(type, init = {}) { this.type = type; Object.assign(this, init); }
};
globalThis.createImageBitmap ??= async (blob) => {
  const bytes = Buffer.from(await blob.arrayBuffer());
  const decoded = decodePng(bytes);
  return { width: decoded.width, height: decoded.height, data: decoded.data, close() {} };
};

function checkPath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) fail('Artifact path is missing or contains NUL');
  if (isAbsolute(value) || /^[A-Za-z]:/.test(value) || /^[/\\]/.test(value) || value.includes(':')) fail('Artifact paths must be relative');
  const parts = value.replaceAll('\\', '/').split('/');
  if (parts.some((part) => part === '..' || part === '' || part === '.')) fail('Artifact path contains traversal or ambiguous segments');
  return parts.join(sep);
}

async function containedFile(root, value) {
  const safe = checkPath(value);
  const path = await realpath(resolve(root, safe));
  const rel = relative(root, path);
  if (rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) fail('Artifact resolves outside the export directory');
  const info = await stat(path);
  if (!info.isFile()) fail('Artifact must be a regular file');
  if (info.size === 0 || info.size > MAX_BYTES) fail('Artifact is empty or exceeds the 256 MiB verifier limit');
  return path;
}

function decodePng(bytes) {
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) fail('Invalid PNG signature');
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (!width || !height || width * height > MAX_PIXELS) fail('PNG exceeds the 64-megapixel verifier limit');
  return PNG.sync.read(bytes, { checkCRC: true, skipRescale: false });
}

function inspectPng(bytes) {
  const decoded = decodePng(bytes);
  let opaquePixels = 0, partialAlphaPixels = 0, transparentPixels = 0, borderPixels = 0;
  const visibleBounds = [decoded.width, decoded.height, -1, -1];
  for (let y = 0; y < decoded.height; y++) for (let x = 0; x < decoded.width; x++) {
    const alpha = decoded.data[(y * decoded.width + x) * 4 + 3];
    if (alpha === 0) transparentPixels++;
    else {
      if (alpha === 255) opaquePixels++; else partialAlphaPixels++;
      visibleBounds[0] = Math.min(visibleBounds[0], x); visibleBounds[1] = Math.min(visibleBounds[1], y);
      visibleBounds[2] = Math.max(visibleBounds[2], x); visibleBounds[3] = Math.max(visibleBounds[3], y);
      if (x === 0 || y === 0 || x === decoded.width - 1 || y === decoded.height - 1) borderPixels++;
    }
  }
  return {
    width: decoded.width, height: decoded.height, encodedColorType: bytes[25],
    alphaChannel: bytes[25] === 4 || bytes[25] === 6 || bytes.includes(Buffer.from('tRNS')),
    opaquePixels, partialAlphaPixels, transparentPixels, borderPixels,
    empty: opaquePixels + partialAlphaPixels === 0,
    visibleBounds: opaquePixels + partialAlphaPixels ? visibleBounds : null,
    decoded,
  };
}

function glbJson(bytes) {
  if (bytes.length < 28 || bytes.toString('ascii', 0, 4) !== 'glTF' || bytes.readUInt32LE(4) !== 2 || bytes.readUInt32LE(8) !== bytes.length) fail('Invalid GLB 2.0 container');
  let offset = 12, json = null;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) fail('Truncated GLB chunk header');
    const length = bytes.readUInt32LE(offset), type = bytes.readUInt32LE(offset + 4);
    if (length % 4 || length > MAX_BYTES || offset + 8 + length > bytes.length) fail('Invalid GLB chunk length');
    if (type === 0x4e4f534a) {
      if (json !== null || offset !== 12 || length > MAX_MANIFEST_BYTES) fail('Invalid GLB JSON chunk');
      json = JSON.parse(bytes.toString('utf8', offset + 8, offset + 8 + length).trim());
    }
    offset += 8 + length;
  }
  if (!json || json.asset?.version !== '2.0') fail('GLB lacks glTF 2.0 metadata');
  for (const buffer of json.buffers ?? []) if (buffer.uri) fail('Export GLB references an external buffer');
  for (const image of json.images ?? []) if (image.uri && !image.uri.startsWith('data:image/png;base64,')) fail('Export GLB references an external or unsupported texture');
  for (const mesh of json.meshes ?? []) for (const primitive of mesh.primitives ?? []) {
    if (!Number.isInteger(primitive.material) || primitive.material < 0 || primitive.material >= (json.materials ?? []).length) fail('GLB primitive has no valid declared material reference');
  }
  return json;
}

export async function inspectGlb(bytes) {
  const json = glbJson(bytes);
  const loader = new GLTFLoader();
  loader.manager.setURLModifier((uri) => {
    if (!uri.startsWith('blob:') && !uri.startsWith('data:image/png;base64,')) fail('GLTFLoader attempted external resource access');
    return uri;
  });
  const gltf = await loader.parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
  gltf.scene.updateMatrixWorld(true);
  const bounds = new Box3().setFromObject(gltf.scene);
  let meshes = 0, indexedMeshes = 0, vertices = 0, triangles = 0, degenerateTriangles = 0, maxNormalDeviation = 0;
  const materials = new Set();
  gltf.scene.traverse((object) => {
    if (!object.isMesh) return;
    meshes++;
    const geometry = object.geometry, position = geometry.getAttribute('position');
    const normal = geometry.getAttribute('normal'), uv = geometry.getAttribute('uv'), index = geometry.getIndex();
    if (!position || position.itemSize !== 3 || !position.count || !normal || normal.itemSize !== 3 || normal.count !== position.count || !uv || uv.itemSize !== 2 || uv.count !== position.count) fail('GLB mesh lacks matching positions, normals, or UVs');
    const faceVertexCount = index ? index.count : position.count;
    if (!faceVertexCount || faceVertexCount % 3 !== 0) fail('GLB mesh does not contain complete triangles');
    if (index) indexedMeshes++;
    for (const attribute of [position, normal, uv]) {
      const getters = ['getX', 'getY', 'getZ', 'getW'];
      for (let i = 0; i < attribute.count; i++) for (let component = 0; component < attribute.itemSize; component++) {
        if (!Number.isFinite(attribute[getters[component]](i))) fail('GLB attribute contains non-finite values');
      }
    }
    for (let i = 0; i < normal.count; i++) {
      const length = Math.hypot(normal.getX(i), normal.getY(i), normal.getZ(i));
      const deviation = Math.abs(length - 1);
      if (!Number.isFinite(length) || deviation > 1e-3) fail('GLB contains non-unit normal magnitudes');
      maxNormalDeviation = Math.max(maxNormalDeviation, deviation);
    }
    if (index) for (let i = 0; i < index.count; i++) { const value = index.getX(i); if (!Number.isInteger(value) || value < 0 || value >= position.count) fail('GLB index is outside its position array'); }
    for (let i = 0; i < faceVertexCount; i += 3) {
      const a = index ? index.getX(i) : i, b = index ? index.getX(i + 1) : i + 1, c = index ? index.getX(i + 2) : i + 2;
      const u = [position.getX(b) - position.getX(a), position.getY(b) - position.getY(a), position.getZ(b) - position.getZ(a)];
      const v = [position.getX(c) - position.getX(a), position.getY(c) - position.getY(a), position.getZ(c) - position.getZ(a)];
      if (Math.hypot(u[1]*v[2]-u[2]*v[1], u[2]*v[0]-u[0]*v[2], u[0]*v[1]-u[1]*v[0]) < 1e-12) degenerateTriangles++;
    }
    const slots = Array.isArray(object.material) ? object.material : [object.material];
    if (!slots.length || slots.some((material) => !material?.isMaterial)) fail('GLB mesh has no valid material');
    slots.forEach((material) => materials.add(material.uuid));
    vertices += position.count; triangles += faceVertexCount / 3;
  });
  const min = bounds.min.toArray(), max = bounds.max.toArray(), dimensions = max.map((value, i) => value - min[i]);
  if (!meshes || !triangles || min.concat(max).some((value) => !Number.isFinite(value)) || dimensions.some((value) => value <= 1e-6)) fail('GLB does not contain non-planar 3D geometry');
  if (degenerateTriangles === triangles) fail('GLB contains only degenerate triangles');
  const pivotDeclared = (json.nodes ?? []).some(node => node.extras?.assetStudioPivot === 'bottom-center');
  const tolerance = Math.max(...dimensions) * 1e-4;
  if (pivotDeclared && (Math.abs(min[1]) > tolerance || Math.abs(min[0]+max[0]) > tolerance || Math.abs(min[2]+max[2]) > tolerance)) fail('GLB bottom-center pivot declaration differs from its world-space bounds');
  return {loader: 'Three.js GLTFLoader', meshes, indexedMeshes, vertices, triangles, materials: materials.size, dimensions, boundsMin: min, boundsMax: max, axis: 'Y-up (glTF convention)', coordinateUnit: 'm (glTF convention)', pivot: pivotDeclared ? 'bottom-center verified' : 'no explicit pivot declaration', degenerateTriangles, maxNormalDeviation, images: (json.images ?? []).length};
}

function declarations(manifest) {
  const assets = manifest.assets ?? manifest.project?.assets ?? [];
  const entries = new Map();
  const foldedPaths = new Map();
  const add = (artifact, context = {}) => {
    if (!artifact || typeof artifact.path !== 'string') fail('Manifest contains an invalid artifact');
    const key = artifact.path.replaceAll('\\', '/');
    const folded = foldedPaths.get(key.toLowerCase());
    if (folded && folded !== key) fail('Manifest artifact paths collide by letter case');
    foldedPaths.set(key.toLowerCase(), key);
    const prior = entries.get(key);
    if (prior && (prior.sha256 !== artifact.sha256 || prior.bytes !== artifact.bytes)) fail('Manifest has conflicting artifact declarations');
    entries.set(key, {...artifact, ...prior, ...context});
  };
  for (const artifact of manifest.files ?? manifest.artifacts ?? []) add(artifact);
  for (const asset of assets) for (const version of asset.versions ?? []) for (const artifact of version.artifacts ?? []) {
    add(artifact, { asset, version, active: version.id === asset.activeVersionId });
  }
  if (entries.size === 0) fail('Manifest contains no files');
  if (entries.size > 20_000) fail('Manifest exceeds the verifier file limit');
  return [...entries.values()];
}

function atlasFrames(metadata) {
  if (Array.isArray(metadata.frames)) return metadata.frames.map((entry) => ({...entry, rect: entry.frame ?? entry.rect ?? entry}));
  if (metadata.frames && typeof metadata.frames === 'object') return Object.entries(metadata.frames).map(([name, entry]) => ({name, ...entry, rect: entry.frame ?? entry.rect ?? entry}));
  return [];
}

function findImage(reference, images, context) {
  if (typeof reference !== 'string') return null;
  const normalized = reference.replaceAll('\\', '/');
  if (images.has(normalized)) return images.get(normalized);
  const inVersion = context?.version?.artifacts?.filter((artifact) => artifact.path.replaceAll('\\', '/').endsWith(`/${normalized}`) && images.has(artifact.path.replaceAll('\\', '/'))) ?? [];
  if (inVersion.length === 1) return images.get(inVersion[0].path.replaceAll('\\', '/'));
  const candidates = [...images.entries()].filter(([path]) => path.endsWith(`/${normalized}`));
  return candidates.length === 1 ? candidates[0][1] : null;
}

function compareAtlas(metadata, images, context) {
  const atlasName = metadata.image ?? metadata.meta?.image ?? metadata.atlas;
  const atlas = findImage(atlasName, images, context);
  const frames = atlasFrames(metadata);
  if (!frames.length) return null;
  if (!atlas) fail('Atlas metadata has frames but its image is missing');
  let comparedPixels = 0, sourceFramesVerified = 0, sourceFramesUnavailable = 0;
  const rectangles = [];
  for (const frame of frames) {
    const rect = frame.rect;
    const x = rect.x, y = rect.y, width = rect.w ?? rect.width, height = rect.h ?? rect.height;
    if (![x,y,width,height].every(Number.isInteger) || x < 0 || y < 0 || width < 1 || height < 1 || x + width > atlas.width || y + height > atlas.height) fail('Atlas frame exceeds decoded image bounds');
    if (rectangles.some((other) => x < other.x + other.width && x + width > other.x && y < other.y + other.height && y + height > other.y)) fail('Atlas frames overlap');
    rectangles.push({x,y,width,height});
    const sourceName = frame.source ?? frame.sourcePath ?? frame.path ?? frame.file;
    const source = findImage(sourceName, images, null);
    if (source) {
      if (source.width !== width || source.height !== height || frame.rotated) fail('Atlas source dimensions or rotation do not match its frame');
      for (let row = 0; row < height; row++) {
        const actual = atlas.decoded.data.subarray(((y+row)*atlas.width+x)*4, ((y+row)*atlas.width+x+width)*4);
        const expected = source.decoded.data.subarray(row*width*4, (row+1)*width*4);
        if (!actual.equals(expected)) fail('Atlas coordinates do not match source pixels');
        comparedPixels += width;
      }
      sourceFramesVerified++;
    } else sourceFramesUnavailable++;
  }
  const status = sourceFramesUnavailable === 0 ? 'source-pixels-verified' : sourceFramesVerified ? 'source-pixels-partially-verified' : 'bounds-and-overlap-verified; source-pixels-unavailable';
  return {frames: frames.length, comparedPixels, sourceFramesVerified, sourceFramesUnavailable, status};
}

export async function verifyArtifacts(input) {
  const path = resolve(input);
  const inputInfo = await stat(path);
  const manifestPath = inputInfo.isDirectory() ? resolve(path, 'manifest.json') : path;
  const root = await realpath(dirname(manifestPath));
  const manifestInfo = await stat(manifestPath);
  if (!manifestInfo.isFile() || manifestInfo.size > MAX_MANIFEST_BYTES) fail('Manifest must be a regular file of at most 16 MiB');
  const manifestBytes = await readFile(manifestPath);
  if (manifestBytes.length > MAX_MANIFEST_BYTES) fail('Manifest exceeds 16 MiB');
  const manifest = JSON.parse(manifestBytes.toString('utf8').replace(/^\uFEFF/, ''));
  if (manifest.schemaVersion !== 1) fail('Unsupported export schema version');
  const entries = declarations(manifest), images = new Map(), metadata = [];
  const report = {schemaVersion: 1, checkedAt: new Date().toISOString(), manifest: manifestPath, valid: true, files: [], warnings: [], atlases: []};
  for (const entry of entries) {
    const item = {path: entry.path, format: entry.format, valid: true, checks: []};
    try {
      if (!HASH.test(entry.sha256 ?? '') || !Number.isSafeInteger(entry.bytes) || entry.bytes < 1) fail('Manifest lacks a valid SHA-256 or byte count');
      const file = await containedFile(root, entry.path), bytes = await readFile(file);
      if (bytes.length !== entry.bytes || createHash('sha256').update(bytes).digest('hex') !== entry.sha256.toLowerCase()) fail('Artifact byte count or SHA-256 differs from manifest');
      item.checks.push('path-contained', 'sha256', 'byte-count');
      const format = (entry.format ?? extname(entry.path).slice(1)).toLowerCase();
      if (format === 'png') {
        const image = inspectPng(bytes), {decoded, ...metrics} = image;
        images.set(entry.path.replaceAll('\\', '/'), image);
        item.image = metrics; item.checks.push('png-decoded', 'png-crc', 'pixel-content');
        if (image.empty && entry.role === 'output') fail('Output image is fully transparent');
        if (entry.active && entry.role === 'output' && entry.asset?.kind !== 'model' && entry.asset?.width && entry.asset?.height && (image.width !== entry.asset.width || image.height !== entry.asset.height)) fail('Active output dimensions differ from asset metadata');
        if (image.borderPixels && entry.role === 'output' && entry.asset?.kind !== 'model') report.warnings.push(`${entry.path}: visible border pixels; inspect intentional tiling/crop separately`);
      } else if (format === 'glb') {
        const model = await inspectGlb(bytes); item.mesh = model; item.checks.push('independent-gltf-loader', 'triangle-nonplanar-geometry', 'indices-checked-when-present', 'finite-normals-uv', 'materials');
        const declared = entry.active ? entry.asset?.mesh : null;
        if (declared && declared.triangles !== model.triangles) fail('GLB triangle count differs from asset metadata');
        if (declared?.dimensions && model.dimensions.some((value, i) => Math.abs(value-declared.dimensions[i]) > Math.max(...declared.dimensions)*1e-4)) fail('GLB dimensions differ from asset metadata');
        if (manifest.spec?.polygonBudget && model.triangles > manifest.spec.polygonBudget) fail('GLB exceeds the export polygon budget');
        if (model.degenerateTriangles) report.warnings.push(`${entry.path}: ${model.degenerateTriangles} degenerate triangles`);
      } else if (format === 'json') {
        if (bytes.length > MAX_MANIFEST_BYTES) fail('Metadata exceeds 16 MiB');
        metadata.push({path: entry.path, value: JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')), context: entry}); item.checks.push('json-decoded');
      } else if (format === 'blend') {
        // Blender may zstd-compress its native file. Fresh Blender round-trip is a separate test.
        item.checks.push('digest-only; native-blender-round-trip-required');
        report.warnings.push(`${entry.path}: editable source digest verified; reopening requires Blender test`);
      } else {
        item.checks.push('digest-only'); report.warnings.push(`${entry.path}: ${format} decoding is outside this verifier; see native pipeline tests`);
      }
    } catch (error) { item.valid = false; item.error = error.message; report.valid = false; }
    report.files.push(item);
  }
  for (const entry of metadata) {
    try { const atlas = compareAtlas(entry.value, images, entry.context); if (atlas) report.atlases.push({path: entry.path, ...atlas}); }
    catch (error) { report.valid = false; report.atlases.push({path: entry.path, valid: false, error: error.message}); }
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const input = process.argv[2];
  if (!input) { console.error('Usage: node scripts/verify-artifacts.mjs <export-directory-or-manifest.json>'); process.exitCode = 2; }
  else {
    try { const report = await verifyArtifacts(input); console.log(JSON.stringify(report, null, 2)); process.exitCode = report.valid ? 0 : 1; }
    catch (error) { console.error(JSON.stringify({valid: false, error: error.message})); process.exitCode = 1; }
  }
}
