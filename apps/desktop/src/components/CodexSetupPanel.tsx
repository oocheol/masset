import {useCallback, useEffect, useId, useRef, useState} from 'react';
import {Ban, CheckCircle2, Download, ExternalLink, Link2, LoaderCircle, RefreshCw} from 'lucide-react';
import type {CodexSetupStatus, ProviderConnection} from '@local-assets/contracts';
import {command, isNative} from '../lib/bridge';
import './CodexSetupPanel.css';

export interface CodexSetupPanelProps {
  connection: ProviderConnection | null;
  checking: 'status' | 'login' | null;
  busy: boolean;
  onCheck: () => void;
  onLogin: () => void;
}

const TRANSFERRING = new Set<CodexSetupStatus['state']>(['downloading', 'verifying', 'extracting']);
const STATE_LABELS: Record<CodexSetupStatus['state'], string> = {
  idle: '준비 전', downloading: '다운로드 중', verifying: '파일 검증 중',
  extracting: '압축 해제 중', ready: '준비 완료', cancelled: '다운로드 취소됨', error: '확인 필요',
};
const DEFAULT_VERSION = '0.160.0';
const DEFAULT_BYTES = 157444460;
const fileSize = (value: number) => `${(Math.max(0, value) / 1048576).toFixed(2)} MiB`;

// Native installer messages are safe Korean descriptions. Never render raw IPC errors or auth URLs.
function safeMessage(value: string | undefined, fallback: string): string {
  if (!value || !/[가-힣]/.test(value) || /https?:\/\/|(?:access|refresh)[_-]?token|authorization|bearer|api[_-]?key|[\u0000-\u0008\u000b\u000c\u000e-\u001f]/i.test(value)) return fallback;
  return value.slice(0, 600);
}

export default function CodexSetupPanel({connection, checking, busy, onCheck, onLogin}: CodexSetupPanelProps) {
  const [status, setStatus] = useState<CodexSetupStatus | null>(null);
  const [loading, setLoading] = useState(isNative);
  const [starting, setStarting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [opening, setOpening] = useState(false);
  const [consented, setConsented] = useState(false);
  const [error, setError] = useState('');
  const mounted = useRef(true);
  const statusPending = useRef(false);
  const installPending = useRef(false);
  const cancelPending = useRef(false);
  const openPending = useRef(false);
  const readyReported = useRef(false);
  const onCheckRef = useRef(onCheck);
  onCheckRef.current = onCheck;
  const progressId = useId();
  const headingId = useId();

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const refreshStatus = useCallback(async (showLoading = false) => {
    if (!isNative || statusPending.current) return;
    statusPending.current = true;
    if (showLoading && mounted.current) setLoading(true);
    try {
      const next = await command<CodexSetupStatus>({action: 'provider_setup_status'});
      if (mounted.current) {
        setStatus(next);
        setError('');
      }
    } catch {
      if (mounted.current) setError('Codex 준비 상태를 확인하지 못했습니다. 잠시 후 다시 확인하세요.');
    } finally {
      statusPending.current = false;
      if (mounted.current && showLoading) setLoading(false);
    }
  }, []);

  useEffect(() => { if (isNative) void refreshStatus(true); }, [refreshStatus]);
  const transferring = !!status && TRANSFERRING.has(status.state);
  useEffect(() => {
    if (!isNative || (!transferring && !starting)) return;
    const timer = window.setInterval(() => void refreshStatus(), 1000);
    return () => window.clearInterval(timer);
  }, [refreshStatus, transferring, starting]);

  useEffect(() => {
    if (status?.state !== 'ready') {
      readyReported.current = false;
      return;
    }
    if (!readyReported.current && isNative) {
      readyReported.current = true;
      onCheckRef.current();
    }
  }, [status?.state]);
  useEffect(() => { setConsented(false); }, [status?.manifest.version, status?.manifest.sha256, status?.manifest.bytes]);

  const runtimeReady = isNative && !!(status?.runtimeDetected || connection?.available);
  const manifest = status?.manifest;
  const reviewable = !!manifest && !!manifest.version && Number.isSafeInteger(manifest.bytes) && manifest.bytes > 0 && /^[a-f0-9]{64}$/i.test(manifest.sha256);
  const installing = starting || transferring;
  const controlsBlocked = busy || checking !== null || installing || loading || cancelling;
  const installAllowed = isNative && !!status?.supported && !runtimeReady && reviewable && consented && !controlsBlocked && !opening && ['idle', 'cancelled', 'error'].includes(status.state);
  const version = manifest?.version ?? DEFAULT_VERSION;
  const downloadBytes = manifest?.bytes ?? DEFAULT_BYTES;
  const totalBytes = status?.totalBytes && status.totalBytes > 0 ? status.totalBytes : downloadBytes;
  const downloadedBytes = Math.max(0, status?.downloadedBytes ?? 0);
  const setupLabel = !isNative ? '데스크톱 전용' : loading ? '준비 상태 확인 중' : runtimeReady ? '준비 완료' : status ? STATE_LABELS[status.state] : '확인 필요';

  async function install() {
    if (!installAllowed || !manifest || installPending.current) return;
    installPending.current = true;
    setStarting(true);
    setError('');
    try {
      const next = await command<CodexSetupStatus>({
        action: 'provider_setup_install', consent: true,
        expectedVersion: manifest.version, expectedSha256: manifest.sha256,
      });
      if (mounted.current) setStatus(next);
    } catch {
      if (mounted.current) setError('Codex 준비를 시작하지 못했습니다. 설치 상태를 다시 확인한 뒤 시도하세요.');
    } finally {
      installPending.current = false;
      if (mounted.current) {
        setStarting(false);
        setConsented(false);
        void refreshStatus();
      }
    }
  }

  async function cancel() {
    if (!isNative || !installing || cancelPending.current) return;
    cancelPending.current = true;
    setCancelling(true);
    setError('');
    try {
      const next = await command<CodexSetupStatus>({action: 'provider_setup_cancel'});
      if (mounted.current) setStatus(next);
    } catch {
      if (mounted.current) setError('취소 요청을 확인하지 못했습니다. 현재 준비 상태를 다시 확인하세요.');
    } finally {
      cancelPending.current = false;
      if (mounted.current) {
        setCancelling(false);
        void refreshStatus();
      }
    }
  }

  async function openPage(page: 'source' | 'license' | 'guide') {
    if (!isNative || openPending.current) return;
    openPending.current = true;
    setOpening(true);
    setError('');
    try {
      await command<unknown>({action: 'provider_setup_open', page});
    } catch {
      if (mounted.current) setError('안내 페이지를 열지 못했습니다. 기본 브라우저 설정을 확인하세요.');
    } finally {
      openPending.current = false;
      if (mounted.current) setOpening(false);
    }
  }

  return <section className="codex-setup-panel" aria-labelledby={headingId}>
    <header className="codex-setup-header">
      <h2 id={headingId}>구독 연결 시작하기</h2>
      <p>Codex가 없어도 앱에서 준비할 수 있습니다. 이미 있으면 그대로 사용합니다.</p>
    </header>
    {!isNative && <p className="codex-setup-browser-note">이 연결은 데스크톱 앱에서 사용할 수 있습니다. 브라우저 미리보기에서는 설치하거나 로그인할 수 없습니다.</p>}
    <ol className="codex-setup-steps">
      <li>
        <span className={`codex-setup-number ${runtimeReady ? 'complete' : ''}`} aria-hidden="true">{runtimeReady ? <CheckCircle2 size={23}/> : '1'}</span>
        <div className="codex-setup-step-body">
          <div className="codex-setup-step-title"><h3>Codex 준비</h3><span className="codex-setup-state">{setupLabel}</span></div>
          {runtimeReady ? <p>준비된 Codex를 재사용합니다. 따로 다운로드할 필요가 없습니다.</p> : <>
            <p>OpenAI 공식 Codex {version} · {fileSize(downloadBytes)}<br/>앱 전용 공간에 준비하며, PATH 변경이나 Node.js·Rust 설치는 필요 없습니다.</p>
            {status && <p className="codex-setup-status" role="status" aria-live="polite">{safeMessage(status.message, status.state === 'error' ? 'Codex 준비 중 문제가 생겼습니다. 설치 상태를 다시 확인하세요.' : STATE_LABELS[status.state])}</p>}
            <details className="codex-setup-details">
              <summary>출처·파일 검증·라이선스</summary>
              <dl>
                <div><dt>다운로드 출처</dt><dd>OpenAI · openai/codex 공식 GitHub 릴리스</dd></div>
                <div><dt>버전</dt><dd>{version}</dd></div>
                <div><dt>파일 크기</dt><dd>{downloadBytes.toLocaleString('ko-KR')} bytes ({fileSize(downloadBytes)})</dd></div>
                <div><dt>SHA-256</dt><dd><code>{manifest?.sha256 ?? '데스크톱에서 설치 정보를 확인하면 표시됩니다.'}</code></dd></div>
                <div><dt>라이선스</dt><dd>{manifest?.license ?? 'Apache-2.0'}</dd></div>
              </dl>
              <p>SHA-256과 OpenAI 실행 파일 서명을 확인합니다. 공식 배포 묶음에 포함된 추가 구성 요소의 라이선스 고지도 확인하세요.</p>
              <div className="codex-setup-actions">
                <button type="button" onClick={() => void openPage('source')} disabled={!isNative || opening}><ExternalLink size={16} aria-hidden="true"/>공식 출처</button>
                <button type="button" onClick={() => void openPage('license')} disabled={!isNative || opening}><ExternalLink size={16} aria-hidden="true"/>라이선스 고지</button>
              </div>
            </details>
            {!installing && !loading && <label className="codex-setup-consent">
              <input type="checkbox" checked={consented} onChange={event => setConsented(event.target.checked)} disabled={!isNative || !status?.supported || !reviewable || busy || checking !== null || cancelling}/>
              <span>출처·버전·크기·SHA-256·라이선스 고지를 확인했고 다운로드에 동의합니다.</span>
            </label>}
            {installing && <div className="codex-setup-progress">
              {status?.state === 'downloading' ? <label htmlFor={progressId}>다운로드 중</label> : <strong>{starting && !transferring ? '다운로드 준비 중' : status ? STATE_LABELS[status.state] : '준비 중'}</strong>}
              {status?.state === 'downloading' && <>
                <progress id={progressId} max={totalBytes} value={Math.min(downloadedBytes, totalBytes)}/>
                <span>{fileSize(downloadedBytes)} / {fileSize(totalBytes)} · {(Math.min(100, downloadedBytes / totalBytes * 100)).toFixed(1)}%</span>
              </>}
              {(status?.state === 'verifying' || status?.state === 'extracting' || (starting && !transferring)) && <div className="codex-setup-working"><LoaderCircle size={18} className="spin" aria-hidden="true"/><span>{status?.state === 'verifying' ? '파일 해시를 확인합니다.' : status?.state === 'extracting' ? '앱 전용 공간에 압축을 풉니다.' : '준비 요청을 확인합니다.'}</span></div>}
              <button type="button" onClick={() => void cancel()} disabled={cancelling}>{cancelling ? <LoaderCircle size={16} className="spin" aria-hidden="true"/> : <Ban size={16} aria-hidden="true"/>}{cancelling ? '취소 요청 중' : '준비 취소'}</button>
            </div>}
            {!installing && <div className="codex-setup-actions">
              <button type="button" className="codex-setup-primary" onClick={() => void install()} disabled={!installAllowed}><Download size={17} aria-hidden="true"/>다운로드 준비</button>
              {isNative && (error || status?.state === 'error' || status?.state === 'cancelled') && <button type="button" onClick={() => void refreshStatus(true)} disabled={loading || busy || checking !== null}><RefreshCw size={16} aria-hidden="true"/>설치 상태 다시 확인</button>}
            </div>}
            {isNative && status && !status.supported && <p className="codex-setup-note">{safeMessage(status.message, '이 실행 환경에서는 Codex를 준비할 수 없습니다.')}</p>}
          </>}
        </div>
      </li>
      <li>
        <span className={`codex-setup-number ${isNative && connection?.authenticated ? 'complete' : ''}`} aria-hidden="true">{isNative && connection?.authenticated ? <CheckCircle2 size={23}/> : '2'}</span>
        <div className="codex-setup-step-body">
          <div className="codex-setup-step-title"><h3>구독 계정 연결</h3><span className="codex-setup-state">{!isNative ? '데스크톱 전용' : connection?.authenticated ? '인증됨' : checking === 'login' ? '연결 중' : '로그인 필요'}</span></div>
          <p>공식 로그인 페이지에서 구독 계정을 연결하세요. 앱에 API 키를 입력하지 않습니다.</p>
          <button type="button" className="codex-setup-primary" onClick={onLogin} disabled={!runtimeReady || controlsBlocked}>{checking === 'login' ? <LoaderCircle size={17} className="spin" aria-hidden="true"/> : <Link2 size={17} aria-hidden="true"/>}{connection?.authenticated ? '계정 다시 연결' : '공식 계정 연결'}</button>
        </div>
      </li>
      <li>
        <span className={`codex-setup-number ${isNative && connection?.ready ? 'complete' : ''}`} aria-hidden="true">{isNative && connection?.ready ? <CheckCircle2 size={23}/> : '3'}</span>
        <div className="codex-setup-step-body">
          <div className="codex-setup-step-title"><h3>앱에서 연결 확인</h3><span className="codex-setup-state">{!isNative ? '데스크톱 전용' : checking === 'status' ? '확인 중' : connection?.ready ? '연결 준비' : '확인 필요'}</span></div>
          <p>로그인을 마치고 돌아왔으면 연결을 확인하세요.</p>
          <button type="button" onClick={onCheck} disabled={!runtimeReady || controlsBlocked}>{checking === 'status' ? <LoaderCircle size={17} className="spin" aria-hidden="true"/> : <RefreshCw size={17} aria-hidden="true"/>}연결 확인</button>
          <p className="codex-setup-note">연결 준비는 모델 이용 권한이나 생성 성공을 확인한 상태가 아닙니다. 수신 이미지·파일 검증·응답 모델은 연결 정보에서 따로 확인합니다.</p>
        </div>
      </li>
    </ol>
    {error && <p className="codex-setup-error" role="alert">{error}</p>}
    <button type="button" className="codex-setup-guide" onClick={() => void openPage('guide')} disabled={!isNative || opening}><ExternalLink size={16} aria-hidden="true"/>공식 연결 가이드</button>
  </section>;
}
