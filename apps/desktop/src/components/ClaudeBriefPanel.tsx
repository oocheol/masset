import {useEffect, useState, type FormEvent} from 'react';
import {CheckCircle2, Copy, LoaderCircle, RefreshCw, Square} from 'lucide-react';
import type {ClaudeBriefResult, ClaudeBriefStatus} from '@local-assets/contracts';
import {claudeCancel, claudePlan, claudeStatus, isNative} from '../lib/bridge';
import './claude-brief.css';

export default function ClaudeBriefPanel({onBusyChange}:{onBusyChange:(busy:boolean)=>void}) {
  const [status,setStatus]=useState<ClaudeBriefStatus|null>(null);
  const [checking,setChecking]=useState(false);
  const [running,setRunning]=useState(false);
  const [brief,setBrief]=useState('');
  const [artDirection,setArtDirection]=useState('');
  const [assetCount,setAssetCount]=useState(3);
  const [approved,setApproved]=useState(false);
  const [result,setResult]=useState<ClaudeBriefResult|null>(null);
  const [error,setError]=useState('');
  const [notice,setNotice]=useState('');

  useEffect(()=>{
    let active=true;
    setChecking(true);
    void claudeStatus().then(value=>{if(active)setStatus(value);})
      .catch(reason=>{if(active)setError(String(reason));})
      .finally(()=>{if(active)setChecking(false);});
    return()=>{active=false;};
  },[]);

  async function checkStatus() {
    setChecking(true);setError('');
    try {setStatus(await claudeStatus());} catch(reason){setError(String(reason));}
    finally {setChecking(false);}
  }
  function changed() {setApproved(false);setResult(null);setNotice('');}
  async function submit(event:FormEvent) {
    event.preventDefault();
    if(!isNative||!status?.planningAvailable||!approved||running||checking)return;
    setRunning(true);onBusyChange(true);setError('');setNotice('');setResult(null);
    try {
      setResult(await claudePlan({brief:brief.trim(),artDirection:artDirection.trim(),assetCount,transmissionApproved:true}));
      setApproved(false);
    } catch(reason) {setError(String(reason));}
    finally {setRunning(false);onBusyChange(false);}
  }
  async function cancel() {
    try {
      const value=await claudeCancel();
      setNotice(value.cancelRequested?'로컬 요청 프로세스에 취소를 요청했습니다. 이미 전송한 요청의 구독 사용량은 발생할 수 있습니다.':'종료 중인 요청을 확인하고 있습니다.');
    } catch(reason) {setError(String(reason));}
  }
  async function copy() {
    if(!result)return;
    try {await navigator.clipboard.writeText(JSON.stringify(result,null,2));setNotice('검토할 계획을 JSON으로 복사했습니다.');}
    catch {setError('클립보드에 복사하지 못했습니다. CLI에서도 계획을 JSON으로 저장할 수 있습니다.');}
  }

  const valid=brief.trim().length>=10&&brief.length<=5000&&artDirection.trim().length>0&&artDirection.length<=1200&&Number.isInteger(assetCount)&&assetCount>=1&&assetCount<=12;
  return <div className="claude-brief">
    <div className="inline-note"><span><strong>개발 중 · 실제 Claude 실행 검증 대기</strong><br/>게임 설명을 개별 에셋 제작 지침과 검수 목록으로 정리합니다. 계획을 확인한 뒤 제작 도구에서 직접 사용하세요.</span></div>
    <section className="claude-brief-status" aria-label="Claude 연결 상태">
      <div><strong>공식 Claude Code</strong><span className={`status-tag ${status?.planningAvailable?'ready':'blocked'}`}>{checking?'확인 중':status?.planningAvailable?'구독 인증 확인':'연결 확인 필요'}</span></div>
      <p>{status?.reason??'설치된 CLI와 구독 인증을 확인합니다. 이 확인으로 계획 생성 요청을 보내지 않습니다.'}</p>
      <dl className="property-list"><div><dt>CLI 버전</dt><dd>{status?.cliVersion??'확인되지 않음'}</dd></div><div><dt>실제 계획 생성</dt><dd>{result?'응답 수신 · 구조 검증됨':'검증 대기'}</dd></div></dl>
      <button type="button" className="button" disabled={checking||running||!isNative} onClick={()=>void checkStatus()}><RefreshCw size={16}/>연결 다시 확인</button>
      {!status?.planningAvailable&&<p>설치된 Claude Code의 Pro 또는 Max 계정 인증이 필요합니다. CLI 설치나 로그인, 구독 결제는 자동으로 진행하지 않습니다.</p>}
    </section>
    <form onSubmit={submit}>
      <label className="field"><span>게임 설명</span><textarea rows={4} value={brief} maxLength={5000} disabled={running} placeholder="장르, 시점, 플레이 방식, 이번에 필요한 소품을 설명하세요." onChange={event=>{setBrief(event.target.value);changed();}} required/><small>10~5,000자. 프로젝트 파일과 이미지는 전송하지 않습니다.</small></label>
      <label className="field"><span>아트 방향</span><textarea rows={2} value={artDirection} maxLength={1200} disabled={running} placeholder="예: 등각 시점의 차분한 판타지. 읽기 쉬운 실루엣, 청록색과 모래색." onChange={event=>{setArtDirection(event.target.value);changed();}} required/></label>
      <label className="field"><span>에셋 수</span><input type="number" min={1} max={12} step={1} value={assetCount} disabled={running} onChange={event=>{setAssetCount(Number(event.target.value));changed();}}/><small>1~12개. 이름이 서로 다른 에셋과 개별 검수 기준을 요청합니다.</small></label>
      <label className="check-row approval"><input type="checkbox" checked={approved} disabled={running} onChange={event=>setApproved(event.target.checked)}/>입력한 설명과 아트 방향을 Anthropic에 전송합니다. 구독 사용량이 발생할 수 있습니다.</label>
      {error&&<p className="claude-brief-message error" role="alert">{error}</p>}
      {notice&&<p className="claude-brief-message" role="status">{notice}</p>}
      <div className="dialog-actions">{running?<button className="button" type="button" onClick={()=>void cancel()}><Square size={16}/>요청 취소</button>:null}<button className="button primary" type="submit" disabled={!valid||!approved||!isNative||!status?.planningAvailable||checking||running}>{running?<LoaderCircle size={16} className="spin"/>:<CheckCircle2 size={16}/>} {running?'계획 요청 중':'계획 요청'}</button></div>
    </form>
    {result&&<section className="claude-brief-result" aria-label="Claude 에셋 계획">
      <div className="claude-brief-result-title"><h3>{result.plan.summary}</h3><button type="button" className="button" onClick={()=>void copy()}><Copy size={16}/>JSON 복사</button></div>
      <p>{result.plan.artDirection}</p><p>응답 모델: {result.model??'응답에 모델 정보 없음'} · {Math.round(result.durationMs/1000)}초</p>
      <ol>{result.plan.assets.map(asset=><li key={asset.name}><h4>{asset.name} <span>{asset.kind}</span></h4><p>{asset.purpose}</p><p className="claude-brief-prompt">{asset.prompt}</p><ul>{asset.acceptanceChecks.map((check,index)=><li key={index}>{check}</li>)}</ul></li>)}</ol>
      <h3>전체 검수 목록</h3><ul>{result.plan.reviewChecklist.map((check,index)=><li key={index}>{check}</li>)}</ul>
      {result.plan.warnings.length>0&&<><h3>확인할 사항</h3><ul>{result.plan.warnings.map((warning,index)=><li key={index}>{warning}</li>)}</ul></>}
      <p>계획 응답만 검증했습니다. 실제 에셋의 형태·텍스처·게임 적용 품질은 제작 후 확인해야 합니다.</p>
    </section>}
  </div>;
}
