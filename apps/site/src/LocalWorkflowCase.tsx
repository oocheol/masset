import { ArrowDownToLine, ArrowUpRight } from 'lucide-react';
import { localWorkflowProof } from './localWorkflow';
import { sourceUrl } from './content';

function EvidenceLink({ href, children }: { href: string; children: React.ReactNode }) {
  return <a className="text-link" href={href}>{children}<ArrowUpRight size={17} aria-hidden="true" /></a>;
}

export default function LocalWorkflowCase() {
  const proof = localWorkflowProof;
  if (!proof) return <section id="local-workflow" className="overview-section page-width overview-local-case" aria-labelledby="local-workflow-title">
    <div className="overview-section-heading"><h2 id="local-workflow-title">A real local workflow:<br />one editable prop at a time.</h2><p>Developer-run example. The crate, table and shelf were created by the local procedural Blender worker. This example does not use Claude or AI image generation.</p></div>
    <div className="overview-local-layout"><figure><img src="/media/crate.png" width="512" height="512" loading="lazy" alt="Actual rendered Oak Crate from the local Blender recipe" /><figcaption>Oak Crate / procedural Blender output</figcaption></figure><ol className="overview-local-steps"><li><h3>Specify the input</h3><p>A separate crate recipe sets the dimensions to 1.2 × 0.8 × 0.9 metres, color to #799993 and bevel to 0.012 metres. The table and shelf have their own recipe inputs.</p><EvidenceLink href={`${sourceUrl}/tree/master/examples/procedural/run-8fa3777b7c994505ba1c5592453a8543/input`}>Read the actual inputs</EvidenceLink></li><li><h3>Keep usable files</h3><p>The worker saves a GLB, editable .blend source, thumbnail and turntable renders for each prop. They are separate inspectable files, rather than a group illustration.</p><EvidenceLink href={`${sourceUrl}/tree/master/examples/procedural/run-8fa3777b7c994505ba1c5592453a8543/crate`}>Inspect the crate files</EvidenceLink></li><li><h3>Verify the artifact</h3><p>The Windows x64 record checks mesh dimensions and reopens the GLB and .blend files in fresh Blender processes with script auto-execution disabled. This worker run did not verify Tauri app integration or a game-engine import.</p><EvidenceLink href={`${sourceUrl}/blob/master/examples/procedural/run-8fa3777b7c994505ba1c5592453a8543/verification.json`}>Read the verification record</EvidenceLink></li></ol></div>
  </section>;

  return <section id="local-workflow" className="overview-section page-width overview-local-case" aria-labelledby="local-workflow-title">
    <div className="overview-section-heading"><h2 id="local-workflow-title">{proof.title}</h2><p>{proof.scenario}</p></div>
    <p className="workflow-input-label">A real developer-run local example. These procedural Blender outputs do not use Claude or AI image generation.</p>
    <div className="workflow-input-grid"><article><h3>Production brief</h3><p className="workflow-input-text">{proof.input.brief}</p></article><article><h3>Art direction</h3><p className="workflow-input-text">{proof.input.artDirection}</p></article></div>
    <div className="overview-local-outputs">{proof.outputs.map(output => <article key={output.name}><figure><img src={output.preview} width="512" height="512" loading="lazy" alt={`Actual local procedural Blender render of ${output.name}`} /></figure><h3>{output.name}</h3><p>{output.parameters}</p><div className="overview-proof-links">{output.files.map(file => <a className="text-link" href={file.href} download key={file.href}><ArrowDownToLine size={17} aria-hidden="true" />{file.label}</a>)}</div><details className="workflow-file-hashes"><summary>File hashes</summary>{output.files.map(file => <p key={file.href}>{file.label}<code>{file.sha256}</code></p>)}</details></article>)}</div>
    <dl className="workflow-run-facts"><div><dt>Verified</dt><dd>{proof.verifiedAt}</dd></div><div><dt>Platform</dt><dd>{proof.platform}</dd></div><div><dt>Local runtime</dt><dd>{proof.runtime}</dd></div></dl>
    <div className="workflow-check-list">{proof.checks.map(check => <article key={check.label}><div><h3>{check.label}</h3><span className={`status-label ${check.result === 'passed' ? 'verified' : 'limited'}`}>{check.result === 'passed' ? 'Passed' : 'Limited scope'}</span></div><p>{check.detail}</p></article>)}</div>
    <div className="workflow-artifacts" aria-label="Download the local input and verification files">{proof.artifacts.map(artifact => <article key={artifact.href}><a className="text-link" href={artifact.href} download><ArrowDownToLine size={18} aria-hidden="true" />{artifact.label}</a><p>SHA-256</p><code>{artifact.sha256}</code></article>)}</div>
    {proof.limitations.length > 0 && <aside className="workflow-scope-note"><h3>Verification scope</h3><ul>{proof.limitations.map(limit => <li key={limit}>{limit}</li>)}</ul></aside>}
  </section>;
}
