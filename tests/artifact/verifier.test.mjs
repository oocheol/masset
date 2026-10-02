import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve, sep } from 'node:path';
import { PNG } from 'pngjs';
import { verifyArtifacts } from '../../scripts/verify-artifacts.mjs';

const roots = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => {
    const target = resolve(root), rel = relative(resolve(tmpdir()), target);
    if (rel.startsWith(`..${sep}`) || rel === '..' || !basename(target).startsWith('asset-export-verifier-')) throw new Error('Unsafe fixture cleanup path');
    return rm(target, {recursive: true, force: true});
  }));
});
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

async function bundle(pngBytes, filePath = '한글 경로/icon.png') {
  const root = await mkdtemp(join(tmpdir(), 'asset-export-verifier-')); roots.push(root);
  await mkdir(join(root, '한글 경로'));
  await writeFile(join(root, '한글 경로', 'icon.png'), pngBytes);
  const manifest = {schemaVersion: 1, files: [{path: filePath, format: 'png', role: 'output', bytes: pngBytes.length, sha256: digest(pngBytes)}], assets: []};
  await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest));
  return {root, manifest};
}

function png(visible = true) {
  const image = new PNG({width: 3, height: 2});
  image.data.fill(0);
  if (visible) image.data.set([20, 80, 120, 255], 4);
  return PNG.sync.write(image);
}

function tetrahedronGlb(invalidIndex = false, invalidNormal = false) {
  const binary = Buffer.alloc(152);
  [0,0,0, 1,0,0, 0,1,0, 0,0,1].forEach((value, i) => binary.writeFloatLE(value, i * 4));
  [0,1,0, 0,1,0, 0,1,0, 0,1,0].forEach((value, i) => binary.writeFloatLE(value, 48 + i * 4));
  if (invalidNormal) binary.writeFloatLE(0.8, 52);
  [0,0, 1,0, 0,1, 1,1].forEach((value, i) => binary.writeFloatLE(value, 96 + i * 4));
  [0,2,1, 0,1,3, 0,3,2, 1,2,invalidIndex ? 7 : 3].forEach((value, i) => binary.writeUInt16LE(value, 128 + i * 2));
  const gltf = {
    asset: {version: '2.0', generator: 'QA fixture; not a production model provider'},
    scenes: [{nodes: [0]}], scene: 0, nodes: [{mesh: 0}],
    meshes: [{primitives: [{attributes: {POSITION: 0, NORMAL: 1, TEXCOORD_0: 2}, indices: 3, material: 0}]}],
    materials: [{pbrMetallicRoughness: {baseColorFactor: [0.3,0.5,0.7,1], metallicFactor: 0, roughnessFactor: 0.6}}],
    buffers: [{byteLength: binary.length}],
    bufferViews: [{buffer: 0, byteOffset: 0, byteLength: 48}, {buffer: 0, byteOffset: 48, byteLength: 48}, {buffer: 0, byteOffset: 96, byteLength: 32}, {buffer: 0, byteOffset: 128, byteLength: 24}],
    accessors: [{bufferView: 0, componentType: 5126, count: 4, type: 'VEC3', min: [0,0,0], max: [1,1,1]}, {bufferView: 1, componentType: 5126, count: 4, type: 'VEC3'}, {bufferView: 2, componentType: 5126, count: 4, type: 'VEC2'}, {bufferView: 3, componentType: 5123, count: 12, type: 'SCALAR'}],
  };
  const encoded = Buffer.from(JSON.stringify(gltf));
  const json = Buffer.alloc(Math.ceil(encoded.length / 4) * 4, 32); encoded.copy(json);
  const bytes = Buffer.alloc(12 + 8 + json.length + 8 + binary.length);
  bytes.write('glTF'); bytes.writeUInt32LE(2, 4); bytes.writeUInt32LE(bytes.length, 8);
  bytes.writeUInt32LE(json.length, 12); bytes.writeUInt32LE(0x4e4f534a, 16); json.copy(bytes, 20);
  bytes.writeUInt32LE(binary.length, 20 + json.length); bytes.writeUInt32LE(0x004e4942, 24 + json.length); binary.copy(bytes, 28 + json.length);
  return bytes;
}

async function add(root, manifest, name, bytes, format) {
  await writeFile(join(root, name), bytes);
  manifest.files.push({path: name, format, role: 'output', bytes: bytes.length, sha256: digest(bytes)});
  await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest));
}

describe('independent export artifact verifier', () => {
  it('decodes a PNG and checks its pixels and digest without opening SQLite', async () => {
    const {root} = await bundle(png());
    const report = await verifyArtifacts(root);
    expect(report.valid).toBe(true);
    expect(report.files[0].image).toMatchObject({width: 3, height: 2, opaquePixels: 1, transparentPixels: 5, alphaChannel: true});
    expect(await readFile(join(root, '한글 경로', 'icon.png'))).toEqual(png());
  });

  it('rejects changed files even when their extension still looks correct', async () => {
    const {root} = await bundle(png());
    await writeFile(join(root, '한글 경로', 'icon.png'), png(false));
    const report = await verifyArtifacts(root);
    expect(report.valid).toBe(false);
    expect(report.files[0].error).toMatch(/SHA-256|byte count/);
  });

  it('rejects path traversal before reading a file outside the bundle', async () => {
    const {root} = await bundle(png(), '../private.png');
    const report = await verifyArtifacts(root);
    expect(report.valid).toBe(false);
    expect(report.files[0].error).toMatch(/traversal/);
  });

  it('rejects fake and fully transparent output PNGs', async () => {
    const fake = await bundle(Buffer.from('This is not a PNG'));
    const empty = await bundle(png(false));
    expect((await verifyArtifacts(fake.root)).files[0].error).toMatch(/PNG signature/);
    expect((await verifyArtifacts(empty.root)).files[0].error).toMatch(/fully transparent/);
  });

  it('rejects a truncated GLB despite a correct file digest', async () => {
    const {root, manifest} = await bundle(png());
    const bytes = Buffer.from('glTF');
    await writeFile(join(root, 'model.glb'), bytes);
    manifest.files.push({path: 'model.glb', format: 'glb', role: 'output', bytes: bytes.length, sha256: digest(bytes)});
    await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest));
    const report = await verifyArtifacts(root);
    expect(report.valid).toBe(false);
    expect(report.files.find(item => item.path === 'model.glb').error).toMatch(/GLB/);
  });

  it('reopens a real indexed 3D GLB and rejects invalid indices and non-unit normals', async () => {
    const good = await bundle(png());
    await add(good.root, good.manifest, 'model.glb', tetrahedronGlb(), 'glb');
    const verified = await verifyArtifacts(good.root);
    expect(verified.valid).toBe(true);
    expect(verified.files.find(item => item.path === 'model.glb').mesh).toMatchObject({loader: 'Three.js GLTFLoader', triangles: 4, dimensions: [1,1,1], materials: 1});
    const bad = await bundle(png());
    await add(bad.root, bad.manifest, 'model.glb', tetrahedronGlb(true), 'glb');
    expect((await verifyArtifacts(bad.root)).files.find(item => item.path === 'model.glb').error).toMatch(/index/);
    const normal = await bundle(png());
    await add(normal.root, normal.manifest, 'model.glb', tetrahedronGlb(false, true), 'glb');
    expect((await verifyArtifacts(normal.root)).files.find(item => item.path === 'model.glb').error).toMatch(/non-unit normal/);
  });

  it('compares atlas frame coordinates against decoded source pixels', async () => {
    const {root, manifest} = await bundle(png());
    const source = PNG.sync.read(png()), atlas = new PNG({width: 8, height: 8});
    atlas.data.fill(0);
    for (let y = 0; y < source.height; y++) source.data.copy(atlas.data, ((y + 1) * atlas.width + 1) * 4, y * source.width * 4, (y + 1) * source.width * 4);
    await add(root, manifest, 'atlas.png', PNG.sync.write(atlas), 'png');
    const metadata = {image: 'atlas.png', frames: [{file: 'icon.png', x: 1, y: 1, width: 3, height: 2}]};
    await add(root, manifest, 'atlas.json', Buffer.from(JSON.stringify(metadata)), 'json');
    const report = await verifyArtifacts(root);
    expect(report.valid).toBe(true);
    expect(report.atlases[0]).toMatchObject({frames: 1, comparedPixels: 6, status: 'source-pixels-verified'});
  });

  it('fails an atlas whose declared frame shifted away from its source pixels', async () => {
    const {root, manifest} = await bundle(png());
    const atlas = new PNG({width: 8, height: 8}); atlas.data.fill(0); atlas.data.set([20,80,120,255], ((1 * 8) + 2) * 4);
    await add(root, manifest, 'atlas.png', PNG.sync.write(atlas), 'png');
    await add(root, manifest, 'atlas.json', Buffer.from(JSON.stringify({image: 'atlas.png', frames: [{file: 'icon.png', x: 2, y: 1, width: 3, height: 2}]})), 'json');
    const report = await verifyArtifacts(root);
    expect(report.valid).toBe(false);
    expect(report.atlases[0].error).toMatch(/source pixels/);
  });

  it('does not certify every atlas source when only one frame source is available', async () => {
    const {root, manifest} = await bundle(png());
    const source = PNG.sync.read(png()), atlas = new PNG({width: 8, height: 8}); atlas.data.fill(0);
    for (let y = 0; y < source.height; y++) source.data.copy(atlas.data, ((y + 1) * atlas.width + 1) * 4, y * source.width * 4, (y + 1) * source.width * 4);
    atlas.data.set([10,20,30,255], ((4 * atlas.width) + 4) * 4);
    await add(root, manifest, 'atlas.png', PNG.sync.write(atlas), 'png');
    await add(root, manifest, 'atlas.json', Buffer.from(JSON.stringify({image:'atlas.png',frames:[{file:'icon.png',x:1,y:1,width:3,height:2},{file:'unavailable.png',x:4,y:4,width:1,height:1}]})), 'json');
    const report = await verifyArtifacts(root);
    expect(report.valid).toBe(true);
    expect(report.atlases[0]).toMatchObject({frames:2,sourceFramesVerified:1,sourceFramesUnavailable:1,status:'source-pixels-partially-verified'});
  });
});
