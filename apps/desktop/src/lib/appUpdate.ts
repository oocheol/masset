import type {AppUpdateStatus} from '@local-assets/contracts';
import {version} from '../../package.json';

export const APP_VERSION = version;

export function unsupportedUpdateStatus():AppUpdateStatus {
  return {
    supported:false,currentVersion:APP_VERSION,latestVersion:null,state:'unsupported',
    downloadedBytes:0,totalBytes:null,sha256:null,releaseUrl:null,checkedAt:null,
    message:'데스크톱 전용: 브라우저 미리보기에서는 업데이트를 확인하거나 다운로드하지 않습니다.',
  };
}

export function hasUpdateReview(status:AppUpdateStatus):boolean {
  if(!status.latestVersion||!status.releaseUrl||!status.sha256||!Number.isFinite(status.totalBytes)||!status.totalBytes||status.totalBytes<=0||!/^[a-f0-9]{64}$/i.test(status.sha256)) return false;
  try {
    const url=new URL(status.releaseUrl);
    return url.protocol==='https:'&&url.hostname==='github.com'&&!url.username&&!url.password&&url.pathname.startsWith('/oocheol/masset/releases/');
  } catch { return false; }
}

export function updateFileSize(value:number|null):string {
  if(value===null||!Number.isFinite(value)||value<0)return '확인되지 않음';
  return `${value.toLocaleString('ko-KR')} bytes (${(value/1_048_576).toFixed(2)} MiB)`;
}
