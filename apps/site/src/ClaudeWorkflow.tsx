import { ArrowDownToLine, ArrowUpRight, Github, Mail } from 'lucide-react';
import { TreesetMark } from './App';
import { claudeDevelopmentEvidence, claudeProof, claudePublicationStatus } from './claudeProof';
import { projectContact, sourceUrl } from './content';

function EvidenceLink({ href, children }: { href: string; children: React.ReactNode }) {
  return <a className="text-link" href={href}>{children}<ArrowUpRight size={17} aria-hidden="true" /></a>;
}

export default function ClaudeWorkflow() {
  const status = claudePublicationStatus();
  const proof = claudeProof;
  const development = claudeDevelopmentEvidence;
  const input = proof?.input ?? development?.input;

  return <div className="project-overview claude-workflow" lang="en">
    <a className="skip-link" href="#workflow-main">Skip to content</a>
    <header className="overview-header page-width">
      <a className="wordmark" href="/" aria-label="Treeset home"><TreesetMark /><span>Treeset</span></a>
      <nav aria-label="Workflow navigation"><a href="/about/">Project</a><a href="#input">Input</a><a href="#output">Asset plan</a><a href="#scope">Verification</a><a href="/" lang="ko">한국어</a></nav>
    </header>
    <main id="workflow-main">
      <section className="workflow-case-hero page-width" aria-labelledby="workflow-title">
        <p className="overview-product">Asset Studio / Claude asset planning</p>
        <h1 id="workflow-title">A game brief, ready<br />for asset production.</h1>
        <p className="overview-lead">A source prototype for turning a game description and art direction into individual asset instructions. Review the names, prompts and acceptance checks before creating any files.</p>
        <p className="workflow-case-status">{status.statusEn}</p>
        <p className="workflow-release-scope">Development preview. Published 0.1.13 installers do not include this feature.</p>
        {proof ? <p className="workflow-demo-label">A maintainer-run demonstration, not a customer case study.</p> : <p className="workflow-demo-label">A verified Claude example will appear here after a successful live run. There is no Claude output to download yet.</p>}
      </section>

      <section id="input" className="overview-section page-width" aria-labelledby="case-input-title">
        <div className="overview-section-heading"><h2 id="case-input-title">1. Describe the game.</h2><p>{proof ? proof.scenario : 'The creator supplies a game brief and an art direction. These explicit inputs define the task; asset generation starts only after the creator reviews the resulting plan.'}</p></div>
        {input ? <><p className="workflow-input-label">{proof ? 'Input supplied to the recorded Claude run.' : 'Developer-written request example. This input has not been submitted to Claude.'}</p><div className="workflow-input-grid"><article><h3>Game brief</h3><p className="workflow-input-text">{input.brief}</p></article><article><h3>Art direction</h3><p className="workflow-input-text">{input.artDirection}</p></article></div></> : <div className="workflow-pending"><h3>Live input and output pending</h3><p>{status.detailEn}</p><p>The intended output is a bounded list of up to 12 individual assets, with a purpose, production prompt and acceptance checks for each.</p></div>}
      </section>

      <section id="output" className="overview-evidence" aria-labelledby="case-output-title"><div className="overview-section page-width">
        <div className="overview-section-heading"><h2 id="case-output-title">2. Review individual instructions.</h2><p>{proof ? `${proof.title} — ${proof.plan.assets.length} separately named asset instructions from the recorded run. The full plan is available as JSON below.` : 'Claude is intended to organize the work. Images, meshes and Blender files are made later by specialized tools, after the creator checks the plan.'}</p></div>
        {proof ? <ol className="workflow-asset-list">{proof.plan.assets.map(asset => <li key={asset.name}><article><div className="workflow-asset-heading"><h3>{asset.name}</h3><span>{asset.kind}</span></div><p>{asset.purpose}</p><details><summary>Production prompt and checks</summary><p className="workflow-input-text">{asset.prompt}</p><h4>Acceptance checks</h4><ul>{asset.acceptanceChecks.map(check => <li key={check}>{check}</li>)}</ul></details></article></li>)}</ol> : <ol className="overview-workflow"><li><h3>Name each asset</h3><p>One asset per instruction, with its kind and purpose in the game.</p></li><li><h3>Set the production prompt</h3><p>Keep art direction and output requirements with the individual task.</p></li><li><h3>Define review checks</h3><p>Make the expected silhouette, appearance and use clear before production.</p></li></ol>}
        {proof && <div className="workflow-review-grid"><article><h3>Plan review checklist</h3><ul>{proof.plan.reviewChecklist.map(check => <li key={check}>{check}</li>)}</ul></article><article><h3>Warnings from the plan</h3>{proof.plan.warnings.length ? <ul>{proof.plan.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul> : <p>The plan returned no warnings. The creator still needs to review it.</p>}</article></div>}
      </div></section>

      <section id="scope" className="overview-section page-width" aria-labelledby="case-scope-title">
        <div className="overview-section-heading"><h2 id="case-scope-title">3. Check the evidence and scope.</h2><p>{proof ? 'The recorded files show a real provider response and the checks performed on this plan. They do not establish that the requested game assets were generated or imported into an engine.' : 'Source implementation, a live provider response and native platform support are separate checks. This page will identify the platform, CLI version, reported model and inspected files when those checks are complete.'}</p></div>
        {proof ? <>
          <dl className="workflow-run-facts"><div><dt>Verified</dt><dd>{proof.verifiedAt}</dd></div><div><dt>Platform</dt><dd>{proof.platform}</dd></div><div><dt>Provider route</dt><dd>Claude Code subscription</dd></div><div><dt>Claude Code version</dt><dd>{proof.cliVersion}</dd></div><div><dt>Reported model</dt><dd>{proof.model ?? 'Not reported by the provider'}</dd></div></dl>
          <div className="workflow-check-list">{proof.checks.map(check => <article key={check.label}><div><h3>{check.label}</h3><span className={`status-label ${check.result === 'passed' ? 'verified' : 'limited'}`}>{check.result === 'passed' ? 'Passed' : 'Limited scope'}</span></div><p>{check.detail}</p></article>)}</div>
          <div className="workflow-artifacts" aria-label="Download the recorded files">{proof.artifacts.map(artifact => <article key={artifact.href}><a className="text-link" href={artifact.href} download><ArrowDownToLine size={18} aria-hidden="true" />{artifact.label}</a><p>SHA-256</p><code>{artifact.sha256}</code></article>)}</div>
          {proof.limitations.length > 0 && <aside className="workflow-scope-note"><h3>Limits of this demonstration</h3><ul>{proof.limitations.map(limit => <li key={limit}>{limit}</li>)}</ul></aside>}
        </> : development ? <>
          <dl className="workflow-run-facts"><div><dt>Checked</dt><dd>{development.checkedAt}</dd></div><div><dt>Platform</dt><dd>{development.platform}</dd></div><div><dt>Claude Code version</dt><dd>{development.cliVersion}</dd></div><div><dt>Provider access</dt><dd>No available subscription authentication</dd></div></dl>
          <div className="workflow-pending"><h3>Request blocked before generation</h3><p>The local probe found no available Claude subscription authentication. The prototype did not submit a Claude request, did not receive a generated plan and did not switch to a paid API.</p></div>
          <div className="workflow-check-list">{development.checks.map(check => <article key={check.label}><div><h3>{check.label}</h3><span className={`status-label ${check.result === 'passed' ? 'verified' : 'limited'}`}>{check.result === 'passed' ? 'Passed' : 'Limited scope'}</span></div><p>{check.detail}</p></article>)}</div>
          <div className="workflow-artifacts" aria-label="Download the request specification and local verification record">{development.artifacts.map(artifact => <article key={artifact.href}><a className="text-link" href={artifact.href} download><ArrowDownToLine size={18} aria-hidden="true" />{artifact.label}</a><p>SHA-256</p><code>{artifact.sha256}</code></article>)}</div>
        </> : <div className="workflow-pending"><h3>Live verification pending</h3><p>No successful Claude response is claimed here. Source checks alone cannot establish provider availability or successful native execution.</p><EvidenceLink href={sourceUrl}>Inspect the project source</EvidenceLink></div>}
      </section>

      <section className="overview-section page-width workflow-next" aria-labelledby="case-next-title">
        <div className="overview-section-heading"><h2 id="case-next-title">4. Choose what to produce.</h2><p>The creator approves or edits the instructions. A planning response does not start image generation, model conversion, a build or a shell command.</p></div>
        <p>The published Asset Studio workflow uses official Codex for connected image requests and local tools for processing. Claude planning uses an existing Claude Code subscription account; access and usage limits apply. There is no paid API fallback. Neither this plan nor the page is an image or 3D generator.</p>
        <div className="overview-proof-links"><EvidenceLink href="/about/#local-workflow">Inspect a real local workflow</EvidenceLink><EvidenceLink href={`${sourceUrl}/blob/master/docs/claude-asset-planning.md`}>Read the prototype specification</EvidenceLink><EvidenceLink href="/#desktop">Download the published releases</EvidenceLink></div>
      </section>

      <section className="overview-connect page-width" aria-labelledby="case-contact-title"><div><h2 id="case-contact-title">Try the tools, or share a workflow.</h2><p>Developed by JEONG WOOCHEOL, a Java developer in his fifth year.</p></div><a className="button button-primary" href={`mailto:${projectContact}`}><Mail size={20} aria-hidden="true" />{projectContact}</a></section>
    </main>
    <footer className="overview-footer page-width"><a href="/about/">Treeset / Asset Studio</a><nav aria-label="More project links"><a href="https://github.com/oocheol"><Github size={17} aria-hidden="true" />Developer profile</a><a href={sourceUrl}>Source</a><a href="/third-party-notices.txt">Third-party notices</a><a href="/" lang="ko">한국어 사이트</a></nav></footer>
  </div>;
}
