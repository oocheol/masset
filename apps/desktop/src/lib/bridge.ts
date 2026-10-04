import {invoke, convertFileSrc} from '@tauri-apps/api/core';
import {open} from '@tauri-apps/plugin-dialog';
import type {Artifact, ProjectSnapshot, EnvironmentInfo, ProviderConnection, GameBundlePlan} from '@local-assets/contracts';
import {bootstrapBrowser, browserCommand, getBrowserArtifactUrl, importBrowserFiles} from './browser';

export const isNative = '__TAURI_INTERNALS__' in window;
export async function command<T = ProjectSnapshot>(request: Record<string, unknown>): Promise<T> {
  return (isNative ? await invoke('workspace_command', {request}) : await browserCommand(request)) as T;
}
export async function bootstrap():Promise<ProjectSnapshot> {
  return isNative ? command({action:'bootstrap'}) : bootstrapBrowser();
}
export async function environment():Promise<EnvironmentInfo> {
  return isNative ? command<EnvironmentInfo>({action:'environment'}) : {blenderPath:null,blenderVersion:null,platform:'browser',native:false};
}
export function providerStatus():Promise<ProviderConnection> {
  return command<ProviderConnection>({action:'provider_status'});
}
export function providerLogin():Promise<ProviderConnection> {
  return command<ProviderConnection>({action:'provider_login'});
}
export function planAssets(request: {action: 'plan_assets'; brief: string; output: GameBundlePlan['output']; mode: GameBundlePlan['mode']; count?: number; referenceAssetIds: string[]; referenceUploadApproved: boolean}):Promise<GameBundlePlan> {
  if (!isNative) return Promise.reject(new Error('게임 에셋 구성안은 데스크톱의 GPT 구독 연결에서 만들 수 있습니다.'));
  return command<GameBundlePlan>(request);
}
export async function chooseFolder(title:string):Promise<string|null> {
  if (!isNative) return null;
  const path = await open({directory:true,multiple:false,title});
  return typeof path === 'string' ? path : null;
}
export async function chooseImports():Promise<ProjectSnapshot|null> {
  if(!isNative) return null;
  const paths = await open({title:'참고 이미지·3D 모델 가져오기',multiple:true,filters:[{name:'이미지·3D 모델',extensions:['png','jpg','jpeg','webp','glb']}]});
  if(!paths) return null;
  return command({action:'import',paths:typeof paths === 'string'?[paths]:paths});
}
export const importFiles = importBrowserFiles;
export function nativeArtifactPath(root:string,path:string):string {
  const windows = /^[A-Za-z]:[\\/]|^\\\\/.test(root) || /^[A-Za-z]:[\\/]|^\\\\/.test(path);
  const normalize = (value:string) => windows ? value.replace(/\//g,'\\') : value;
  const absolute = /^[A-Za-z]:[\\/]|^\\\\|^\//.test(path);
  // Windows verbatim paths (\\?\) require backslashes, including relative artifact segments.
  return absolute ? normalize(path) : `${normalize(root).replace(/[\\/]$/,'')}${windows?'\\':'/'}${normalize(path)}`;
}
export function artifactUrl(snapshot:ProjectSnapshot, artifact?:Artifact) {
  if(!artifact) return '';
  if(!isNative) return getBrowserArtifactUrl(artifact.path);
  return convertFileSrc(nativeArtifactPath(snapshot.root,artifact.path));
}
