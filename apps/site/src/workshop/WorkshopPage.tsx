import { useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowLeft, ArrowRight, ArrowUp, ArrowDown, Box, Camera, Check, Expand, FileUp, Github, Play, RotateCw } from 'lucide-react';
import { assets, defaultPlacements, exportScene, importScene, storageKey, type AssetId, type Notice } from './state';
import type { Snapshot, Workshop } from './scene';
import { sourceUrl } from '../content';
import './workshop.css';

const copy = {
  ko: { home: 'Treeset 홈', title: '만든 에셋으로,\n작은 세계를 켜보세요.', lead: '상자·작업대·선반이 하나의 게임 장면이 됩니다. 로봇을 움직여 빛나는 셀을 작업대로 옮기고, 소품의 배치를 바꿔보세요.', start: '데모 시작', loading: '3D 작업장을 여는 중…', play: '플레이', edit: '장면 편집', goal: '빛나는 셀 3개를 작업대로 옮기세요.', moving: 'WASD·방향키 또는 바닥 터치로 이동', action: '줍기 / 전달', keyboard: '셀이나 작업대 가까이에서 E 또는 Space', restart: '플레이 다시 시작', place: '소품을 고르고 바닥을 눌러 배치하세요.', rotate: '90° 회전', restore: '기본 배치', export: '장면 JSON 저장', import: '장면 JSON 열기', shot: '장면 PNG 저장', view: '시점 회전', complete: '작업장에 불이 켜졌습니다.', next: '이제 소품을 배치해 나만의 장면을 만드세요.', noInstall: '설치 없이 체험 · 샘플 사용 · 같은 사이트의 파일만 로드', ready: '실제 GLB 3개 로드 완료', storage: '배치는 이 브라우저에 저장됩니다. 원본 모델은 그대로 유지됩니다.', error: '3D 화면을 열지 못했습니다. WebGL을 지원하는 브라우저에서 다시 시도하거나 아래 모델 파일을 내려받으세요.', retry: '다시 시도', invalid: '이 데모에서 저장한 유효한 장면 JSON을 선택하세요.', saved: '새 파일로 저장했습니다.', help: '조작 가이드', example: '어떤 예시인가요?', exampleText: 'Asset Studio의 Windows 로컬 제작 경로로 만든 세 가지 절차형 GLB를 실제 웹 장면에서 사용합니다. 바닥·로봇·빛나는 셀은 데모용 코드로 구성했습니다. 개발자가 만든 예시이며 고객 사례나 Claude 생성 결과가 아닙니다.', files: '모델과 예제 내려받기', kit: '예제 파일 묶음', record: '제작 과정과 기록', native: '원본 제작·검증 기록', claude: 'Claude 기획 기능의 현재 상태', contact: '문제·개선 의견 남기기', arrow: ['위로 이동', '왼쪽으로 이동', '아래로 이동', '오른쪽으로 이동'], notices: { collect: '빛나는 셀을 찾아 가까이 이동하세요.', carrying: '셀을 들었습니다. 작업대로 옮겨주세요.', delivered: '전달했습니다. 다음 셀을 찾아보세요.', complete: '셀 3개를 모두 전달했습니다.', closer: '셀이나 작업대에 더 가까이 이동하세요.', placed: '배치를 바꿨습니다.', blocked: '소품·셀·출발지를 피해 다른 위치를 선택하세요.', saved: '새 파일로 저장했습니다.', restored: '배치를 불러왔습니다.' } },
  en: { home: 'Treeset home', title: 'Put the assets\ninto a small, playable world.', lead: 'A crate, workbench and shelf become a game scene. Move the robot, bring three glowing cells to the workbench, then arrange the props yourself.', start: 'Start the demo', loading: 'Opening the 3D workshop…', play: 'Play', edit: 'Arrange the scene', goal: 'Bring three glowing cells to the workbench.', moving: 'WASD, arrows or tap the floor to move', action: 'Pick up / deliver', keyboard: 'Press E or Space near a cell or the workbench', restart: 'Restart play', place: 'Choose a prop, then tap the floor to place it.', rotate: 'Rotate 90°', restore: 'Default layout', export: 'Save scene JSON', import: 'Open scene JSON', shot: 'Save scene PNG', view: 'Rotate view', complete: 'The workshop is lit.', next: 'Now arrange the props to make your own scene.', noInstall: 'No installation · sample assets · files load from this site only', ready: 'Three real GLBs loaded', storage: 'The layout stays in this browser. Original models remain unchanged.', error: 'The 3D scene could not open. Retry in a WebGL-capable browser, or download the model files below.', retry: 'Retry', invalid: 'Choose a valid scene JSON saved by this demo.', saved: 'Saved as a new file.', help: 'Controls', example: 'What is this example?', exampleText: 'This web scene loads three actual procedural GLBs made through the Asset Studio Windows local workflow. The floor, robot and glowing cells are demo code. This is a developer-made example, not a customer case study or a Claude-generated result.', files: 'Download the models and example', kit: 'Example file bundle', record: 'Production story and records', native: 'Original production and verification', claude: 'Claude planning status', contact: 'Report a problem or suggest an improvement', arrow: ['Move up', 'Move left', 'Move down', 'Move right'], notices: { collect: 'Find a glowing cell and move close to it.', carrying: 'You are carrying a cell. Bring it to the workbench.', delivered: 'Delivered. Find the next cell.', complete: 'All three cells delivered.', closer: 'Move closer to a cell or the workbench.', placed: 'Layout changed.', blocked: 'Choose another position, clear of props, cells and the start point.', saved: 'Saved as a new file.', restored: 'Layout loaded.' } },
};
const initial = (): Snapshot => ({ loaded: 0, delivered: 0, carrying: false, notice: 'collect', layout: defaultPlacements() });
function saveFile(blob: Blob, suffix: string) {
  const url = URL.createObjectURL(blob), anchor = document.createElement('a');
  anchor.href = url; anchor.download = `treeset-workshop-${new Date().toISOString().replace(/[:.]/g, '-')}.${suffix}`;
  document.body.append(anchor); anchor.click(); anchor.remove();
  return { url, filename: anchor.download };
}

export default function WorkshopPage({ language = 'ko' }: { language?: 'ko' | 'en' }) {
  const text = copy[language], host = useRef<HTMLDivElement>(null), stage = useRef<HTMLDivElement>(null), upload = useRef<HTMLInputElement>(null), engine = useRef<Workshop | null>(null);
  const keys = useRef(new Set<string>());
  const importRequest = useRef(0);
  const [started, setStarted] = useState(false), [attempt, setAttempt] = useState(0), [ready, setReady] = useState(false), [error, setError] = useState(false);
  const [mode, setMode] = useState<'play' | 'edit'>('play'), [selected, setSelected] = useState<AssetId>('table'), [snapshot, setSnapshot] = useState(initial), [fileStatus, setFileStatus] = useState('');
  const [download, setDownload] = useState<{ url: string; filename: string } | null>(null);
  useEffect(() => () => { if (download) URL.revokeObjectURL(download.url); }, [download]);
  function prepareFile(blob: Blob, suffix: string) {
    setDownload(saveFile(blob, suffix));
    setFileStatus(language === 'ko' ? '파일이 준비됐습니다. 자동 저장되지 않았다면 파일 내려받기를 누르세요.' : 'File ready. If it did not save automatically, use Download file.');
  }
  useEffect(() => {
    const clear = () => { keys.current.clear(); engine.current?.setMove(0, 0); };
    window.addEventListener('blur', clear); document.addEventListener('visibilitychange', clear);
    return () => { window.removeEventListener('blur', clear); document.removeEventListener('visibilitychange', clear); };
  }, []);
  useEffect(() => {
    if (!started || !host.current) return;
    const controller = new AbortController(); let instance: Workshop | null = null;
    setReady(false); setError(false); setMode('play'); setSelected('table'); keys.current.clear();
    let layout = defaultPlacements();
    try { const stored = localStorage.getItem(storageKey); if (stored) layout = importScene(stored); } catch { /* Keep unreadable original storage untouched. */ }
    import('./scene').then(async module => {
      if (controller.signal.aborted || !host.current) return;
      instance = await module.createWorkshop(host.current, layout, value => {
        if (controller.signal.aborted) return;
        setSnapshot(value);
        if (value.failed) { setError(true); setReady(false); }
        if (value.notice === 'placed' || value.notice === 'restored') {
          try { localStorage.setItem(storageKey, JSON.stringify(exportScene(value.layout))); } catch { /* JSON downloads still work when storage is unavailable. */ }
        }
      }, controller.signal);
      if (controller.signal.aborted) { instance.dispose(); return; }
      engine.current = instance; setReady(true); stage.current?.focus({ preventScroll: true });
    }).catch(() => { if (!controller.signal.aborted) { setError(true); setReady(false); } });
    return () => { importRequest.current++; controller.abort(); instance?.dispose(); engine.current = null; };
  }, [started, attempt]);
  function changeMode(value: 'play' | 'edit') { setMode(value); keys.current.clear(); engine.current?.setMode(value); }
  function movement() {
    const key = keys.current;
    engine.current?.setMove(Number(key.has('d') || key.has('arrowright')) - Number(key.has('a') || key.has('arrowleft')), Number(key.has('s') || key.has('arrowdown')) - Number(key.has('w') || key.has('arrowup')));
  }
  function keyEvent(event: React.KeyboardEvent<HTMLDivElement>, down: boolean) {
    if (event.target !== event.currentTarget || !ready || mode !== 'play') return;
    const key = event.key.toLowerCase();
    if (!['w', 'a', 's', 'd', 'arrowup', 'arrowleft', 'arrowdown', 'arrowright', 'e', ' '].includes(key)) return;
    event.preventDefault();
    if (key === 'e' || key === ' ') { if (down && !event.repeat) engine.current?.action(); return; }
    if (down) keys.current.add(key); else keys.current.delete(key); movement();
  }
  async function importFile(file?: File) {
    if (!file) return;
    const request = ++importRequest.current, instance = engine.current;
    if (!instance) return;
    try {
      if (file.size > 64000) throw new Error();
      const scene = importScene(await file.text());
      if (request !== importRequest.current || instance !== engine.current) return;
      instance.restore(scene); setFileStatus(text.notices.restored);
    } catch { if (request === importRequest.current && instance === engine.current) setFileStatus(text.invalid); }
    finally { if (request === importRequest.current && upload.current) upload.current.value = ''; }
  }
  return <div className="workshop-page" lang={language}>
    <a className="skip-link" href="#workshop-main">{language === 'ko' ? '본문으로 이동' : 'Skip to content'}</a>
    <header className="workshop-header page-width"><a className="wordmark" href="/">Treeset</a><nav aria-label={language === 'ko' ? '예제 메뉴' : 'Example navigation'}><a href="/about/">Asset Studio</a><a href="/devlog/workshop/">{text.record}</a><a href={language === 'ko' ? '/play/workshop/en/' : '/play/workshop/'} lang={language === 'ko' ? 'en' : 'ko'}>{language === 'ko' ? 'English' : '한국어'}</a></nav></header>
    <main id="workshop-main">
      <section className="workshop-intro page-width"><div><h1>{text.title}</h1><p>{text.lead}</p></div><div className="workshop-entry"><p>{text.noInstall}</p><a className="text-link" href="/#desktop"><ArrowDownToLine size={17} aria-hidden="true" />{language === 'ko' ? '전체 앱 내려받기' : 'Download the full app'}</a></div></section>
      <section className="workshop-console page-width" aria-label={language === 'ko' ? '작은 작업장 게임과 편집' : 'Playable workshop and scene arrangement'}>
        <div className="workshop-toolbar"><div role="group" aria-label={language === 'ko' ? '체험 모드' : 'Demo mode'}><button aria-pressed={mode === 'play'} disabled={!ready} onClick={() => changeMode('play')}><Play size={17} aria-hidden="true" />{text.play}</button><button aria-pressed={mode === 'edit'} disabled={!ready} onClick={() => changeMode('edit')}><Box size={17} aria-hidden="true" />{text.edit}</button></div><button disabled={!ready} onClick={() => engine.current?.view()}><RotateCw size={17} aria-hidden="true" />{text.view}</button></div>
        <div className="workshop-stage" ref={stage} tabIndex={0} role="group" aria-label={language === 'ko' ? '게임 화면. WASD 또는 방향키 이동, E 줍기와 전달' : 'Game stage. WASD or arrows to move, E to pick up and deliver'} onKeyDown={e => keyEvent(e, true)} onKeyUp={e => keyEvent(e, false)} onBlur={e => { keys.current.clear(); if (e.target === e.currentTarget || !(e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget))) engine.current?.setMove(0, 0); }} onPointerDown={e => { if (e.target instanceof HTMLCanvasElement) stage.current?.focus({ preventScroll: true }); }}>
          <div className="workshop-canvas" ref={host} />
          {!ready && <div className="workshop-launch"><img src="/media/crate.png" width="512" height="512" alt={language === 'ko' ? '실제 로컬 제작 상자' : 'Actual local procedural crate'} /><div><h2>{error ? text.error : started ? text.loading : language === 'ko' ? '작은 작업장이 기다립니다.' : 'A small workshop is waiting.'}</h2><p>{text.goal}</p>{(!started || error) && <button className="button button-primary" onClick={() => { setStarted(true); if (error) setAttempt(value => value + 1); }}><Play size={19} aria-hidden="true" />{error ? text.retry : text.start}</button>}</div></div>}
          {ready && <><div className="workshop-mission"><p>{mode === 'play' ? text.goal : text.place}</p>{mode === 'play' && <strong>{snapshot.delivered} / 3</strong>}</div>{mode === 'play' && snapshot.delivered < 3 && <button className="workshop-guide" onClick={() => { engine.current?.guide(); stage.current?.focus({ preventScroll: true }); }}>{language === 'ko' ? snapshot.carrying ? '작업대로 이동' : '다음 셀로 이동' : snapshot.carrying ? 'Go to the workbench' : 'Find the next cell'}</button>}{snapshot.delivered === 3 && mode === 'play' && <div className="workshop-finish"><Check size={24} aria-hidden="true" /><h2>{text.complete}</h2><p>{text.next}</p><button onClick={() => changeMode('edit')}>{text.edit}</button></div>}</>}
        </div>
        <div className="workshop-bottom"><div><p className="workshop-notice" aria-live="polite">{ready ? text.notices[snapshot.notice as Notice] : text.noInstall}</p><p className="workshop-ready">{ready ? text.ready : text.moving}</p></div>{ready && mode === 'play' && <div className="workshop-pad"><div className="workshop-directions">{[[0, -1], [-1, 0], [0, 1], [1, 0]].map(([x, z], index) => <button key={index} aria-label={text.arrow[index]} onPointerDown={e => { e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); keys.current.clear(); engine.current?.setMove(x, z); }} onPointerUp={() => engine.current?.setMove(0, 0)} onPointerCancel={() => engine.current?.setMove(0, 0)} onLostPointerCapture={() => engine.current?.setMove(0, 0)} onKeyDown={e => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); engine.current?.setMove(x, z); } }} onKeyUp={() => engine.current?.setMove(0, 0)} onBlur={() => engine.current?.setMove(0, 0)}>{[<ArrowUp />, <ArrowLeft />, <ArrowDown />, <ArrowRight />][index]}</button>)}</div><button className="workshop-action" disabled={!snapshot.actionReady} onClick={() => engine.current?.action()}>{text.action}<small>E / Space</small></button></div>}</div>
        {mode === 'edit' && ready && <div className="workshop-editor"><div className="workshop-picker">{assets.map(a => <button key={a.id} aria-pressed={selected === a.id} onClick={() => { setSelected(a.id); engine.current?.select(a.id); }}><img src={`/examples/local-prop-kit/${a.id}/thumbnail.png`} width="64" height="64" alt="" />{language === 'ko' ? a.name : a.english}</button>)}</div><div className="workshop-edit-actions"><button onClick={() => engine.current?.rotate()}><RotateCw size={17} aria-hidden="true" />{text.rotate}</button><button onClick={() => engine.current?.restore(defaultPlacements())}>{text.restore}</button></div><p>{text.storage}</p></div>}
        <div className="workshop-file-actions"><button disabled={!ready} onClick={() => { const value = engine.current?.snapshot(); if (value) prepareFile(new Blob([JSON.stringify(exportScene(value.layout), null, 2)], { type: 'application/json' }), 'json'); }}><ArrowDownToLine size={17} aria-hidden="true" />{text.export}</button><button disabled={!ready} onClick={() => upload.current?.click()}><FileUp size={17} aria-hidden="true" />{text.import}</button><button disabled={!ready} onClick={async () => { try { const blob = await engine.current?.capture(); if (blob) prepareFile(blob, 'png'); } catch { setFileStatus(text.error); } }}><Camera size={17} aria-hidden="true" />{text.shot}</button><button disabled={!ready} onClick={() => { engine.current?.reset(); stage.current?.focus({ preventScroll: true }); }}>{text.restart}</button><input ref={upload} type="file" accept=".json,application/json" className="workshop-file-input" onChange={e => void importFile(e.target.files?.[0])} />{download && <a className="workshop-ready-download" href={download.url} download={download.filename}><ArrowDownToLine size={17} aria-hidden="true" />{language === 'ko' ? '파일 내려받기' : 'Download file'}</a>}<span role="status">{fileStatus}</span></div>
      </section>
      <section className="workshop-notes page-width"><article><h2>{text.help}</h2><ul><li>{text.moving}</li><li>{language === 'ko' ? '목표로 이동 버튼이 소품을 피해 길을 찾아줍니다.' : 'The goal button finds a path around the props.'}</li><li>{text.keyboard}</li><li>{text.place}</li><li>{text.storage}</li></ul></article><article><h2>{text.example}</h2><p>{text.exampleText}</p><div className="workshop-links"><a href="/devlog/workshop/">{text.record}</a><a href="/about/#local-workflow">{text.native}</a><a href="/workflows/claude-asset-brief/">{text.claude}</a></div></article></section>
      <section className="workshop-downloads page-width"><h2>{text.files}</h2><div className="workshop-download-list">{assets.map(a => <article key={a.id}><h3>{language === 'ko' ? a.name : a.english}</h3><p>{a.triangles.toLocaleString('en-US')} triangles</p><a href={assetUrlFor(a.id)} download>GLB</a><a href={`/examples/local-prop-kit/${a.id}/source.blend`} download>Blender</a></article>)}<article><h3>{text.kit}</h3><p>GLB · .blend · scene.json · README</p><a href="/examples/workshop-starter.zip" download><ArrowDownToLine size={17} aria-hidden="true" />ZIP</a><a href="/examples/workshop/scene.json" download>Scene JSON</a></article></div></section>
    </main>
    <footer className="workshop-footer page-width"><a href="/">{text.home}</a><a href={`${sourceUrl}/tree/master/apps/site/src/workshop`}><Github size={17} aria-hidden="true" />{language === 'ko' ? '예제 소스' : 'Example source'}</a><a href={`${sourceUrl}/issues/new`}>{text.contact}</a><a href="mailto:oocheol@treeset.win">oocheol@treeset.win</a></footer>
  </div>;
}
function assetUrlFor(id: AssetId) { return `/examples/local-prop-kit/${id}/model.glb`; }
