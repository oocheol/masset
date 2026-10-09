import { ArrowDownToLine, ArrowUpRight, FileText } from 'lucide-react';
import authoredData from '../public/examples/synthetic-claude/scenarios.json';
import { TreesetMark } from './App';
import { claudeWorkflowPath } from './claudeProof';
import { sourceUrl } from './content';
import SiteFooterLinks from './SiteFooterLinks';
import { parseSyntheticScenarios } from './syntheticScenarios';
import type { SiteLanguage } from './policies';
import './documents.css';

const examples = parseSyntheticScenarios(authoredData);
export const researchPath = '/research/claude-scenarios/';
const artifacts = '/examples/synthetic-claude/';

export function ResearchTeaser({ language = 'ko' }: { language?: SiteLanguage }) {
  return <section className="research-teaser page-width" aria-labelledby={`research-teaser-${language}`}>
    <div><p className="research-label">{language === 'ko' ? '가상 시나리오 · Claude 미실행' : 'Synthetic scenarios · Claude not executed'}</p><h2 id={`research-teaser-${language}`}>{language === 'ko' ? '서로 다른 작업을, 어떻게 기획할까요?' : 'How would different creators plan their assets?'}</h2></div>
    <div><p>{language === 'ko' ? '픽셀 게임·모바일 3D·기술 검수 등 여섯 가상 역할의 요청, 예시 계획과 검수 기준을 살펴보세요. 실제 사용자 후기나 Claude 실행 결과를 주장하지 않는 개발 설명 자료입니다.' : 'Explore requests, illustrative plans and review criteria for six fictional roles, from pixel games to mobile 3D and technical review. These development examples do not claim real user feedback or Claude execution.'}</p><a className="text-link" href={`${researchPath}${language === 'en' ? 'en/' : ''}`}>{language === 'ko' ? '가상 테스트 예시 읽기' : 'Read the synthetic examples'}<ArrowUpRight size={18} aria-hidden="true" /></a></div>
  </section>;
}

export default function ResearchExamples({ language = 'ko' }: { language?: SiteLanguage }) {
  const ko = language === 'ko';
  const labels = ko ? ['가상 요청', '작성된 계획 예시', '가상 후속 요청'] : ['Simulated request', 'Authored plan example', 'Simulated follow-up'];
  return <div className="project-overview research-page" lang={language}>
    <a className="skip-link" href="#research-main">{ko ? '본문으로 이동' : 'Skip to content'}</a>
    <header className="overview-header page-width"><a className="wordmark" href="/"><TreesetMark /><span>Treeset</span></a><nav aria-label={ko ? '예시 메뉴' : 'Example navigation'}><a href={ko ? '/' : '/about/'}>Asset Studio</a><a href={claudeWorkflowPath}>{ko ? 'Claude 기능 상태' : 'Claude prototype status'}</a><a href={`${researchPath}${ko ? 'en/' : ''}`} lang={ko ? 'en' : 'ko'}>{ko ? 'English' : '한국어'}</a></nav></header>
    <main id="research-main" className="page-width">
      <section className="research-hero"><p className="research-label">{ko ? '가상 테스트 예시' : 'Synthetic evaluation examples'}</p><h1>{ko ? '여섯 가지 역할로 살펴보는\n에셋 제작 계획.' : 'Six fictional roles.\nDifferent asset-planning needs.'}</h1><p className="overview-lead">{ko ? '하나의 큰 요청을 개별 에셋 지침과 검수 기준으로 나누는 방법을 설명합니다. 게임마다 다른 요구와 수정 요청까지 함께 읽어보세요.' : 'See how a broad request could become individual asset instructions and review criteria. Explore different game constraints and follow-up requests.'}</p>
        <aside className="research-disclosure" aria-labelledby="research-disclosure-title"><h2 id="research-disclosure-title">{ko ? '가상 역할과 작성된 예시입니다. Claude를 호출하지 않았습니다.' : 'Fictional roles and authored examples. Claude was not called.'}</h2><p>{examples.notice[language]}</p><div className="research-boundaries"><span>{ko ? '실제 참여자 없음' : 'No real participants'}</span><span>{ko ? '측정된 성능·비용 없음' : 'No measured performance or cost'}</span><span>{ko ? '예시 JSON 형식만 로컬 검증' : 'Local checks cover example JSON only'}</span></div></aside>
        <div className="research-files"><a href={`${artifacts}scenarios.json`} download><ArrowDownToLine size={18} aria-hidden="true" />{ko ? '가상 시나리오 JSON' : 'Synthetic scenario JSON'}</a><a href={`${artifacts}README.md`}><FileText size={18} aria-hidden="true" />{ko ? '작성 방식·검증 범위' : 'Provenance and scope'}</a><a href={`${artifacts}static-verification.json`}>{ko ? '로컬 형식 검증 기록' : 'Local format-check record'}<ArrowUpRight size={17} aria-hidden="true" /></a></div>
        <dl className="document-metadata"><div><dt>{ko ? '작성일' : 'Authored'}</dt><dd><time dateTime={examples.authoredOn}>{examples.authoredOn}</time></dd></div><div><dt>{ko ? '작성 방식' : 'Method'}</dt><dd>{ko ? '개발자가 AI 도움으로 구성한 예시' : 'AI-assisted examples authored for development'}</dd></div><div><dt>{ko ? '기록 범위' : 'Scope'}</dt><dd>{ko ? '가상 역할 6개 · 실측 결과 없음' : '6 fictional roles · no observations'}</dd></div></dl>
      </section>
      <section className="research-method" aria-labelledby="research-method-title"><div><h2 id="research-method-title">{ko ? '실제 평가에서 확인할 항목' : 'What a real evaluation would check'}</h2><p>{ko ? '아래 수치와 검수 항목은 목표 조건입니다. 계획된 파일이 실제로 생성되거나 검수를 통과했다는 뜻이 아닙니다.' : 'The constraints and checks below are evaluation targets. They do not establish that a planned file was generated or passed inspection.'}</p></div><ol><li>{ko ? '기획서의 조건이 각 에셋 지침에 빠짐없이 반영되는지 확인합니다.' : 'Check that individual instructions preserve the brief’s requirements.'}</li><li>{ko ? '실제 생성 후 파일 규격·메시·재질·게임 엔진의 결과를 별도로 검수합니다.' : 'Inspect actual generated files, meshes, materials and engine behavior separately.'}</li><li>{ko ? '동의한 실제 사용자의 피드백과 제공자·모델·시간·비용 기록을 별도 자료로 남깁니다.' : 'Keep consented real-user feedback and provider, model, timing and cost records in separate evidence.'}</li></ol></section>
      <div className="research-record-list">{examples.cases.map((scenario, index) => <details key={scenario.id} id={scenario.id} className="research-record" open={index === 0}>
        <summary><span className="research-record-id">{scenario.id}</span><div><h2>{scenario.title[language]}</h2><p>{scenario.persona.role[language]}</p></div></summary>
        <div className="research-record-body"><span className="research-record-status">{ko ? '가상 시나리오 · 작성된 계획 · Claude 미실행' : 'Synthetic scenario · authored plan · Claude not executed'}</span><p className="research-record-context">{scenario.persona.context[language]}</p>
          <section className="research-input"><h3>{ko ? '입력 기획서 예시' : 'Illustrative input brief'}</h3><p>{scenario.input.brief[language]}</p></section>
          <div className="research-dialogue">{scenario.dialogue.map((turn, turnIndex) => <section key={turn.speaker}><h3>{labels[turnIndex]}</h3><p>{turn.text[language]}</p></section>)}</div>
          <div className="research-plan"><h3>{ko ? '예상 제작 계획' : 'Illustrative production plan'}</h3><p>{ko ? `요청 조건: 에셋 최대 ${scenario.input.assetLimit}개. 아래 파일명은 제작 목표이며 실제 파일이 아닙니다.` : `Requested limit: ${scenario.input.assetLimit} assets. Filenames below are proposed outputs, not actual files.`}</p><p>{scenario.input.artDirection[language]}</p><ol>{scenario.plan.assets.map(asset => <li key={asset.name}><h4><code>{asset.filename}</code></h4><p>{asset.purpose[language]}</p><p>{asset.instruction[language]}</p><ul>{asset.acceptanceChecks.map((check, checkIndex) => <li key={checkIndex}>{check[language]}</li>)}</ul></li>)}</ol></div>
          <div className="research-review"><section><h3>{ko ? '제작 후 검수 항목' : 'Post-production review checklist'}</h3><ul>{scenario.plan.reviewChecklist.map((check, checkIndex) => <li key={checkIndex}>{check[language]}</li>)}</ul></section><section><h3>{ko ? '검수 기준' : 'Evaluation criteria'}</h3><ul>{scenario.evaluationCriteria.map((criterion, criterionIndex) => <li key={criterionIndex}>{criterion[language]}</li>)}</ul></section><section><h3>{ko ? '예상되는 확인 질문' : 'Questions to investigate'}</h3><ul>{scenario.concerns.map((concern, concernIndex) => <li key={concernIndex}>{concern[language]}</li>)}</ul></section></div>
          <section className="research-revision"><h3>{ko ? '후속 요청을 반영할 방향' : 'Proposed response to the follow-up'}</h3><p>{scenario.revisionNote[language]}</p></section>
          <p className="research-empty-results">{ko ? '관측 결과·사용자 만족도·처리 시간·토큰 비용: 측정하지 않음. 실제 사용자 테스트나 Claude 실행 증빙으로 사용할 수 없습니다.' : 'Observed results, satisfaction, processing time and token cost: not measured. This record cannot establish real user testing or Claude execution.'}</p>
        </div>
      </details>)}</div>
    </main>
    <footer className="overview-footer page-width"><a href="/">Treeset / Asset Studio</a><nav aria-label={ko ? '관련 안내' : 'Related information'}><SiteFooterLinks language={language} /><a href={sourceUrl}>GitHub</a><a href="mailto:oocheol@treeset.win">oocheol@treeset.win</a></nav></footer>
  </div>;
}
