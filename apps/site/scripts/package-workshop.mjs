import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import { defaultPlacements, exportScene } from '../src/workshop/state.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicRoot = path.join(root, 'public');
const output = path.join(publicRoot, 'examples/workshop');
await fs.mkdir(output, { recursive: true });
const scene = JSON.stringify(exportScene(defaultPlacements()), null, 2) + '\n';
const readme = `# Treeset workshop example\n\nDeveloper-made example, published October 8, 2026.\n\nPlay: https://treeset.win/play/workshop/en/\nStory: https://treeset.win/devlog/workshop/\nSource: https://github.com/oocheol/masset/tree/master/apps/site/src/workshop\n\n## Contents\n\nThree actual local procedural GLBs, editable Blender sources, rendered previews, native input and verification records, a default scene JSON and SHA-256 inventory. The GLBs are Y-up, in metres, with bottom-centre pivots. No image textures or animations are included.\n\n## Use the scene\n\nStart the web demo, choose Arrange the scene, then Open scene JSON and select scene.json. Select a prop and tap the floor to place it. Save scene JSON creates a new file with the layout and fixed model provenance. This archive contains assets and records; the full runnable web source is in the public repository.\n\nTo run the web example locally, use Node.js 24, clone the repository, run npm ci from its root, then npm run site:dev. Open http://127.0.0.1:4174/play/workshop/en/.\n\nIn another engine, use the asset id to find its models/<id>/model.glb file, preserve metre scale, set x and z from scene.json, and rotate around Y by rotation degrees. Some engines use another up axis; convert deliberately. This package does not certify any other engine import.\n\nThe original native SHA-256 record is kept under production/verification.json. manifest.json describes files in this package. Source .blend files should be opened with script auto-execution disabled. Generated text is not executed as an asset input.\n\n## Scope\n\nThe props were made and reopened by the Windows local Blender workflow. The web floor, robot, gameplay and placement logic are authored demo code. No Claude or image provider request was used for this example. This is not external customer evidence, texture-generation proof or new desktop/macOS verification.\n\nProject license: Apache-2.0, included in LICENSE.txt.\n`;
const zip = new JSZip(), inventory = [];
const date = new Date('2026-10-08T00:00:00Z');
function add(name, bytes) {
  const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  zip.file(name, data, { date });
  inventory.push({ file: name, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') });
}
add('scene.json', scene); add('README.md', readme);
for (const id of ['crate', 'table', 'shelf']) for (const file of ['model.glb', 'source.blend', 'thumbnail.png']) add(`models/${id}/${file}`, await fs.readFile(path.join(publicRoot, 'examples/local-prop-kit', id, file)));
for (const file of ['input.json', 'verification.json']) add(`production/${file}`, await fs.readFile(path.join(publicRoot, 'examples/local-prop-kit', file)));
add('LICENSE.txt', await fs.readFile(path.join(publicRoot, 'LICENSE.txt')));
const manifest = JSON.stringify({ schemaVersion: 1, title: 'Treeset developer workshop example', publishedDate: '2026-10-08', providerRequests: 0, externalUserCase: false, files: inventory }, null, 2) + '\n';
zip.file('manifest.json', manifest, { date });
zip.forEach((_name, file) => { file.date = date; });
await fs.writeFile(path.join(output, 'scene.json'), scene);
await fs.writeFile(path.join(output, 'README.md'), readme);
await fs.writeFile(path.join(output, 'manifest.json'), manifest);
const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
await fs.writeFile(path.join(publicRoot, 'examples/workshop-starter.zip'), bytes);
console.log(JSON.stringify({ examplePackage: 'workshop-starter.zip', files: inventory.length + 1, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }));
