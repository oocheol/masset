import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { zipFiles } from '../../scripts/package-native-cli.mjs';

const roots = [];
const loader = resolve('integrations/codex/skills/asset-studio/scripts/bootstrap.sh');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'assetstudio-mac-loader-')));
  roots.push(root);
  // Test mode verifies these bytes and prints commands; it never executes them.
  const files = [
    { path: 'asset-cli', content: Buffer.from('non-executable test payload'), executable: true },
    { path: 'resources/LICENSE', content: Buffer.from('Apache-2.0 fixture') },
    { path: 'resources/workers/blender/worker.py', content: Buffer.from('inert worker fixture') },
    { path: 'resources/docs/notice.txt', content: Buffer.from('nested resource inventory') },
  ];
  const archive = zipFiles(files), zip = join(root, 'runtime.zip'), manifest = join(root, 'runtime.json');
  await writeFile(zip, archive);
  await writeFile(manifest, JSON.stringify({ schemaVersion: 1, format: 'asset-studio-cli-runtime', packages: {
    'macos-arm64': { version: '0.1.13', url: 'https://github.com/oocheol/masset/releases/download/v0.1.13/runtime.zip',
      bytes: archive.length, sha256: sha(archive), license: 'Apache-2.0', cliPath: 'asset-cli', resourcePath: 'resources',
      files: files.map(file => ({ path: file.path, bytes: file.content.length, sha256: sha(file.content), executable: Boolean(file.executable) })) },
  } }));
  const run = () => {
    const result = spawnSync('/bin/bash', [loader, '--test-mode', '--package', zip, '--manifest', manifest,
      '--runtime-root', join(root, 'runtimes'), '--consent-downloads', '--print-command'], { encoding: 'utf8', timeout: 30_000 });
    return { ...result, report: JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)) };
  };
  return { run };
}

describe.skipIf(process.platform !== 'darwin' || process.arch !== 'arm64')('stock macOS native CLI loader', () => {
  it('unwraps Foundation file names through nested directories and rechecks an intact installation', async () => {
    const { run } = await fixture(), first = run();
    expect(first.status).toBe(0);
    expect(first.report).toMatchObject({ event: 'runtime_ready', version: '0.1.13', unchanged: false });
    expect((await stat(join(first.report.runtimePath, 'installation.json'))).mode & 0o777).toBe(0o600);
    expect(await readFile(join(first.report.resourcePath, 'docs/notice.txt'), 'utf8')).toBe('nested resource inventory');
    const again = run();
    expect(again.status).toBe(0);
    expect(again.report).toMatchObject({ event: 'runtime_ready', unchanged: true, cliPath: first.report.cliPath });
  });

  it('refuses an edited installed resource and preserves its bytes', async () => {
    const { run } = await fixture(), first = run();
    expect(first.status).toBe(0);
    const resource = join(first.report.resourcePath, 'docs/notice.txt');
    await writeFile(resource, 'user edited resource');
    const rejected = run();
    expect(rejected.status).toBe(1);
    expect(rejected.report).toMatchObject({ event: 'needs_attention', code: 'package_mismatch' });
    expect(await readFile(resource, 'utf8')).toBe('user edited resource');
  });
});
