import {useEffect,useState} from 'react';
import {Download,ExternalLink,LoaderCircle,RefreshCw} from 'lucide-react';
import {isNative} from '../lib/bridge';
import {hasUpdateReview,updateFileSize} from '../lib/appUpdate';
import type {useAppUpdater} from '../lib/useAppUpdater';
import './AppUpdatePanel.css';

type Updater=ReturnType<typeof useAppUpdater>;
const STATE_LABELS={idle:'확인 전',checking:'확인 중',up_to_date:'최신 버전',available:'새 버전',downloading:'다운로드 중',installing:'설치 중',error:'확인 필요',unsupported:'지원되지 않음'};

export default function AppUpdatePanel({updater,workBlocked}:{updater:Updater;workBlocked:boolean}) {
  const {status,checking,transferring}=updater;
  const [approved,setApproved]=useState(false);
  const reviewable=hasUpdateReview(status);
  useEffect(()=>setApproved(false),[status.latestVersion,status.sha256,status.totalBytes,status.releaseUrl]);
  const percentage=status.totalBytes&&status.totalBytes>0?Math.max(0,Math.min(100,status.downloadedBytes/status.totalBytes*100)):null;
  const installDisabled=!isNative||!status.supported||status.state!=='available'||!reviewable||!approved||workBlocked||checking||transferring;
  return <div className="app-update-panel">
    <div className="app-update-heading"><strong>Asset Studio 업데이트</strong><span className={`status-tag ${status.state==='available'||status.state==='up_to_date'?'ready':'blocked'}`}>{!isNative?'데스크톱 전용':STATE_LABELS[status.state]}</span></div>
    <p className="app-update-message" role="status" aria-live="polite">{status.message}</p>
    <dl className="property-list environment-list app-update-properties">
      <div><dt>현재 버전</dt><dd>{status.currentVersion}</dd></div>
      <div><dt>새 버전</dt><dd>{status.latestVersion??'확인되지 않음'}</dd></div>
      <div><dt>설치 파일 크기</dt><dd>{updateFileSize(status.totalBytes)}</dd></div>
      <div><dt>출처</dt><dd>{reviewable?<a href={status.releaseUrl!} target="_blank" rel="noopener noreferrer">oocheol/masset GitHub 릴리스 <ExternalLink size={11}/></a>:'GitHub 공식 릴리스 / 확인 전'}</dd></div>
      <div><dt>SHA-256</dt><dd className="app-update-sha">{status.sha256??'확인되지 않음'}</dd></div>
      <div><dt>프로젝트 소스 라이선스</dt><dd><a href="https://github.com/oocheol/masset/blob/master/LICENSE" target="_blank" rel="noopener noreferrer">Apache License 2.0 <ExternalLink size={11}/></a></dd></div>
      <div><dt>최근 확인</dt><dd>{status.checkedAt?new Date(status.checkedAt).toLocaleString('ko-KR'):'아직 확인하지 않음'}</dd></div>
    </dl>
    {status.state==='downloading'&&<div className="app-update-progress"><label htmlFor="app-update-progress">다운로드 진행 {percentage!==null?`${percentage.toFixed(1)}%`:''}</label><progress id="app-update-progress" max={status.totalBytes&&status.totalBytes>0?status.totalBytes:1} value={status.totalBytes&&status.totalBytes>0?Math.min(status.downloadedBytes,status.totalBytes):undefined}/><span>{updateFileSize(status.downloadedBytes)} / {updateFileSize(status.totalBytes)}</span></div>}
    {status.state==='installing'&&<div className="inline-note"><LoaderCircle size={16} className="spin"/><span>업데이트를 설치 중입니다. 설치 과정에서 앱이 닫히거나 재시작될 수 있습니다. 프로젝트를 다시 열면 로컬 저장 상태를 사용합니다.</span></div>}
    <p className="app-update-help">Windows 설치형과 Apple Silicon Mac 앱에서 업데이트를 지원합니다. 설치 전에 파일 크기·SHA-256·업데이트 서명·서명된 버전을 검증하고, 제작 작업이 끝난 뒤 설치합니다. Mac 앱은 이전 앱을 백업하고 교체 후 재실행합니다.</p>
    <p className="app-update-help">Mac 0.1.3 이하와 Windows 0.1.0 포터블은 업데이트 기능이 있는 버전을 한 번 직접 설치해야 합니다. Mac 앱은 쓰기 가능한 ~/Applications에 설치해 주세요. 업데이트 서명은 Apple 공증과 별개입니다.</p>
    {status.state==='available'&&<label className="check-row approval"><input type="checkbox" checked={approved} onChange={event=>setApproved(event.target.checked)} disabled={!reviewable||checking||transferring}/><span>GitHub 출처, 버전, 크기, SHA-256과 소스 라이선스 고지를 확인했습니다.</span></label>}
    {status.state==='available'&&!reviewable&&<p className="app-update-help">출처·크기·해시 정보가 확인될 때까지 설치할 수 없습니다. 업데이트를 다시 확인하세요.</p>}
    {workBlocked&&isNative&&<p className="app-update-help">현재 작업이 끝난 뒤 업데이트를 확인하거나 설치할 수 있습니다.</p>}
    <div className="dialog-actions"><button type="button" className="button" onClick={()=>void updater.check()} disabled={!isNative||workBlocked||checking||transferring}>{checking?<LoaderCircle size={13} className="spin"/>:<RefreshCw size={13}/>}업데이트 확인</button><button type="button" className="button primary" onClick={()=>{if(!installDisabled)void updater.install();}} disabled={installDisabled}>{transferring?<LoaderCircle size={13} className="spin"/>:<Download size={13}/>}지금 업데이트</button></div>
  </div>;
}
