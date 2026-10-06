#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { installSkill, statusSkill } from '../lib/installer.mjs';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const descriptor = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const help = `Asset Studio Codex skill installer ${descriptor.version}

  npx @oocheol/asset-studio@latest install
  npx @oocheol/asset-studio@latest update
  npx @oocheol/asset-studio@0.1.11 install
  asset-studio-skill status [--json]

Options:
  --project <absolute-folder>  Install only for an existing project
  --json                      Print machine-readable results
  --version                   Print this npm package version
  --help                      Show this help

The default is install. Existing skills are preserved in a backup outside
the skill discovery folder. Updates install this npm package's bundled skill;
they do not fetch a different native runtime or change Codex login.
`;

try {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) process.stdout.write(help);
  else if (args.includes('--version') || args.includes('-v')) console.log(descriptor.version);
  else {
    let command = 'install';
    let project;
    let json = false;
    if (args[0] && !args[0].startsWith('-')) command = args.shift();
    while (args.length) {
      const option = args.shift();
      if (option === '--json') json = true;
      else if (option === '--project' && args[0] && !args[0].startsWith('-')) project = args.shift();
      else throw new Error(`Unknown or incomplete option: ${option}`);
    }
    if (!['install', 'update', 'status'].includes(command)) throw new Error(`Unknown command: ${command}`);
    const [major, minor] = process.versions.node.split('.').map(Number);
    if (major < 22 || major === 22 && minor < 20) throw new Error('Node.js 22.20 or newer is required');
    if (!(process.platform === 'win32' && process.arch === 'x64') &&
      !(process.platform === 'darwin' && process.arch === 'arm64')) throw new Error('Supported platforms: Windows x64 and Apple Silicon Mac with native ARM64 Node.js');
    const result = command === 'status' ? await statusSkill(packageRoot, { project }) : await installSkill(packageRoot, { project });
    if (json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`Asset Studio skill ${result.packageVersion}: ${result.operation || result.state}`);
      console.log(`Skill folder: ${result.skillPath}`);
      console.log(`Pinned runtime: Windows ${result.runtimeVersions['windows-x64']} / Mac ${result.runtimeVersions['macos-arm64']}`);
      if (result.backupPath) console.log(`Previous skill preserved: ${result.backupPath}`);
      if (result.modifiedFiles?.length) console.log(`Changed files: ${result.modifiedFiles.join(', ')}`);
      if (result.extraFiles?.length) console.log(`Additional files: ${result.extraFiles.join(', ')}`);
      if (command !== 'status') console.log('Start a new Codex task and request $asset-studio. Native tools and models are prepared on first use with consent.');
      if (result.duplicatePaths.length) console.warn(`Two skill locations exist; preserve and move the older copy outside skills before starting Codex: ${result.duplicatePaths.join(' / ')}`);
    }
  }
} catch (error) {
  console.error(`Asset Studio skill installer: ${error.message}`);
  process.exitCode = 1;
}
