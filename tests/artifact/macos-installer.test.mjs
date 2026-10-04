import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const roots = [];
const installer = resolve('scripts/install-macos.sh');
const run = args => spawnSync('/bin/bash', [installer, ...args], { encoding: 'utf8', timeout: 10_000 });
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'assetstudio-installer-test-'));
  roots.push(root);
  return root;
}

describe.skipIf(process.platform !== 'darwin' || process.arch !== 'arm64')('native trial installer failure boundaries', () => {
  it('refuses a different download before mounting or creating an installation', async () => {
    const root = await fixture(), dmg = join(root, 'wrong.dmg');
    await writeFile(dmg, 'different download');
    const result = run(['--yes', '--no-launch', '--destination', join(root, 'apps'), '--dmg', dmg]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('size or SHA-256 mismatch');
    expect(await readFile(dmg, 'utf8')).toBe('different download');
    await expect(readFile(join(root, 'apps/Asset Studio.app/Contents/Info.plist'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves an existing app and refuses to replace it', async () => {
    const root = await fixture(), destination = join(root, '한글 앱 경로'), app = join(destination, 'Asset Studio.app');
    await mkdir(app, { recursive: true });
    await writeFile(join(app, 'original.txt'), 'existing user app');
    const result = run(['--yes', '--destination', destination]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Existing app preserved');
    expect(await readFile(join(app, 'original.txt'), 'utf8')).toBe('existing user app');
    expect(result.stdout).not.toContain('Downloading');
  });

  it('rejects an unsafe destination before any download', () => {
    const result = run(['--yes', '--destination', '/']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('absolute directory');
    expect(result.stdout).not.toContain('Downloading');
  });
});
