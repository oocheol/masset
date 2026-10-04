import {afterEach,describe,expect,it} from 'vitest';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {packageMacUpdate} from '../../scripts/package-macos-update.mjs';

const roots=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
async function fixture(version='0.1.4') {
  const root=await mkdtemp(join(tmpdir(),'assetstudio-update-'));roots.push(root);
  const archive=join(root,'Asset Studio.app.tar.gz'),bytes=Buffer.alloc(4096,42);
  await writeFile(archive,bytes);
  await writeFile(`${archive}.sig`,Buffer.from(`untrusted comment: fixture\npayload\ntrusted comment: timestamp:1\tversion:${version}\nglobal`).toString('base64'));
  return {root,archive,bytes,output:join(root,'release')};
}
describe('Mac-only updater packaging',()=>{
  it('preserves the exact signed archive and uses the separate platform and canonical URL',async()=>{
    const f=await fixture();const result=await packageMacUpdate(f.archive,f.output,'0.1.4');
    expect(Object.keys(result.platforms)).toEqual(['darwin-aarch64']);
    const mac=result.platforms['darwin-aarch64'];
    expect(mac.url).toBe('https://github.com/oocheol/masset/releases/download/v0.1.4/AssetStudio_0.1.4_macos-arm64.app.tar.gz');
    expect(mac.sha256).toBe(createHash('sha256').update(f.bytes).digest('hex'));
    expect(await readFile(join(f.output,'AssetStudio_0.1.4_macos-arm64.app.tar.gz'))).toEqual(f.bytes);
    await expect(packageMacUpdate(f.archive,f.output,'0.1.4')).rejects.toMatchObject({code:'EEXIST'});
  });
  it('rejects an unsigned version substitution before creating release files',async()=>{
    const f=await fixture('0.1.3');await expect(packageMacUpdate(f.archive,f.output,'0.1.4')).rejects.toThrow('authenticated version');
    await expect(packageMacUpdate(f.archive,f.output,'0.1.4-beta')).rejects.toThrow('stable app version');
    await expect(readFile(join(f.output,'latest-macos.json'))).rejects.toMatchObject({code:'ENOENT'});
  });
});
