/** Reopen a Blender test output through an independent loader.
 * Creates a new QA copy; this synthetic manifest is not proof of app export integration.
 */
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { verifyArtifacts } from '../../scripts/verify-artifacts.mjs';

const [inputArg, outputArg] = process.argv.slice(2);
if (!inputArg || !outputArg) throw new Error('Usage: node tests/artifact/inspect-blender.mjs <existing-worker-output> <fresh-QA-output>');
const input = await realpath(resolve(inputArg));
const output = resolve(outputArg);
const rel = relative(input, output);
if (!rel || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))) throw new Error('QA output must be outside worker output');
await mkdir(dirname(output), {recursive: true});
await mkdir(output); // Exclusive fresh directory.
const workerReport = JSON.parse(await readFile(resolve(input, 'validation.json'), 'utf8'));
const filenames = ['model.glb', 'source.blend', 'thumbnail.png', 'validation.json', ...Array.from({length: 4}, (_, i) => `turntable-${String(i).padStart(2,'0')}.png`)];
const files = [];
for (const filename of filenames) {
  const path = await realpath(resolve(input, filename));
  if (relative(input, path).startsWith('..') || !(await stat(path)).isFile()) throw new Error('Worker artifact escapes input directory');
  await copyFile(path, resolve(output, filename));
  const bytes = await readFile(resolve(output, filename));
  files.push({id: filename, path: filename, format: extname(filename).slice(1), role: filename.endsWith('.blend') ? 'source' : filename.endsWith('.json') ? 'metadata' : filename.endsWith('.png') ? 'thumbnail' : 'output', sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length});
}
const version = {id: 'qa-independent-v1', number: 1, source: 'procedural', requestedModel: null, confirmedModel: null, providerVersion: workerReport.blenderVersion, artifacts: files, settings: workerReport.parameters};
const manifest = {format: 'asset-studio-bundle', schemaVersion: 1, projectName: 'Independent QA copy of actual Blender test files', spec: {polygonBudget: 10000}, files, assets: [{id: 'qa-model', name: workerReport.parameters.name, kind: 'model', activeVersionId: version.id, versions: [version], mesh: workerReport.mesh}]};
await writeFile(resolve(output, 'manifest.json'), JSON.stringify(manifest, null, 2));
const verified = await verifyArtifacts(output);
verified.scope = 'Independent loader check of actual worker files with a synthetic QA manifest; not app export proof';
for (const artifact of verified.files) if (artifact.image?.empty) {
  artifact.valid = false;
  artifact.error = 'Procedural model thumbnail or turntable is fully transparent';
  verified.valid = false;
}
await writeFile(resolve(output, 'independent-verification.json'), JSON.stringify(verified, null, 2));
console.log(JSON.stringify({valid: verified.valid, output, files: verified.files.length, models: verified.files.filter(file => file.mesh).map(file => file.mesh)}, null, 2));
process.exitCode = verified.valid ? 0 : 1;
