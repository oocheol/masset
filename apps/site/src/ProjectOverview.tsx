import { ArrowDownToLine, ArrowUpRight, Github, Mail, Terminal } from 'lucide-react';
import { TreesetMark } from './App';
import { projectContact, projectFacts, sourceUrl } from './content';
import { macReleases, release } from './release';
import { claudePublicationStatus, claudeWorkflowPath } from './claudeProof';
import LocalWorkflowCase from './LocalWorkflowCase';
import WorkshopTeaser from './workshop/WorkshopTeaser';
import SiteFooterLinks from './SiteFooterLinks';
import { ResearchTeaser } from './ResearchExamples';

const windowsDownload = `${sourceUrl}/releases/download/v${release.version}/${release.filename}`;

function EvidenceLink({ href, children }: { href: string; children: React.ReactNode }) {
  return <a className="text-link" href={href}>{children}<ArrowUpRight size={17} aria-hidden="true" /></a>;
}

export default function ProjectOverview() {
  const claudeStatus = claudePublicationStatus();
  return <div className="project-overview" lang="en">
    <a className="skip-link" href="#overview-main">Skip to content</a>
    <header className="overview-header page-width">
      <a className="wordmark" href="/" aria-label="Treeset home"><TreesetMark /><span>Treeset</span></a>
      <nav aria-label="Project navigation"><a href="#project">Project</a><a href="/play/workshop/en/">Play the example</a><a href="#developer">Developer</a><a href={claudeWorkflowPath}>Claude prototype</a><a href="/" lang="ko">한국어</a></nav>
    </header>
    <main id="overview-main">
      <section className="overview-hero page-width" aria-labelledby="overview-title" itemScope itemType="https://schema.org/SoftwareApplication">
        <div>
          <p className="overview-product" itemProp="name">Asset Studio by Treeset</p>
          <h1 id="overview-title">A local workbench<br />for game assets.</h1>
          <p className="overview-lead" itemProp="description">An open-source desktop app and Codex skill for independent game developers and small creative teams. Plan individual assets, use connected AI tools, refine images and 3D models, and keep the files in your own project.</p>
          <div className="overview-actions"><a className="button button-primary" href="/#download-skill"><Terminal size={19} aria-hidden="true" />Install the Codex skill</a><a className="button button-secondary" href="/#desktop"><ArrowDownToLine size={19} aria-hidden="true" />Download the app</a></div>
          <p className="overview-platforms" itemProp="operatingSystem">Windows x64 and Apple Silicon macOS</p>
          <meta itemProp="applicationCategory" content="DesignApplication" />
          <div className="overview-proof-links"><a className="text-link overview-source" href="/play/workshop/en/">Play without installing<ArrowUpRight size={17} aria-hidden="true" /></a><a className="text-link overview-source" href={sourceUrl}><Github size={18} aria-hidden="true" />Browse the source<ArrowUpRight size={17} aria-hidden="true" /></a></div>
        </div>
        <figure className="overview-render">
          <img src="/media/crate.png" width="512" height="512" alt="A wooden crate rendered from a real procedural Blender mesh" fetchPriority="high" />
          <figcaption>A real procedural Blender output.<br />Editable .blend source and GLB are public.</figcaption>
        </figure>
      </section>

      <WorkshopTeaser language="en" />
      <ResearchTeaser language="en" />
      <section id="developer" className="overview-section page-width overview-developer" aria-labelledby="developer-title">
        <div><p className="overview-product">Developer / maintainer</p><h2 id="developer-title">JEONG WOOCHEOL</h2><p className="overview-developer-background">Java developer in his fifth year.</p><EvidenceLink href="https://github.com/oocheol"><Github size={18} aria-hidden="true" />Public GitHub profile: oocheol</EvidenceLink></div>
        <div><p>I develop and maintain Treeset and Asset Studio. My current public work connects asset planning, local processing, version review and export in a game-development workflow.</p><p>You can inspect the source, downloadable releases and example artifacts. Each verification record identifies the platform and what was actually checked.</p><div className="overview-proof-links"><EvidenceLink href={sourceUrl}>Inspect Asset Studio</EvidenceLink><EvidenceLink href={`mailto:${projectContact}`}>Contact the developer</EvidenceLink></div></div>
      </section>

      <section id="project" className="overview-section page-width overview-project" aria-labelledby="project-title">
        <div><h2 id="project-title">The project behind the tools.</h2><p>Treeset is an independent creative-tools project. Asset Studio is its first product, with public source code, downloadable early releases, and reproducible output examples.</p><p>The project began in October 2026. Treeset is currently pre-incorporation and has not registered a business or received external investment. The project start date is not a legal incorporation date.</p><p>The public maintainer profile and domain email below identify who develops the project and where to get in touch.</p></div>
        <div className="overview-project-record"><dl>{projectFacts.map(fact => <div key={fact.label}><dt>{fact.labelEn}</dt><dd>{fact.href ? <a href={fact.href}>{fact.valueEn}<ArrowUpRight size={16} aria-hidden="true" /></a> : fact.valueEn}</dd></div>)}</dl><a className="overview-contact" href={`mailto:${projectContact}`}><Mail size={19} aria-hidden="true" />{projectContact}</a></div>
      </section>

      <section className="overview-section page-width" aria-labelledby="workflow-overview-title">
        <div className="overview-section-heading"><h2 id="workflow-overview-title">From a brief to individual files.</h2><p>Keep creative decisions and asset versions together, instead of moving between disconnected generators and folders.</p></div>
        <ol className="overview-workflow">
          <li><h3>Define the assets</h3><p>Connect a game folder, describe the art direction and review a production list with separate names, prompts and output requirements.</p></li>
          <li><h3>Create and refine</h3><p>Use the official Codex subscription route for image requests, or work locally with image editing, TripoSR image-to-3D and Blender tools. Account access and runtime requirements apply.</p></li>
          <li><h3>Inspect and export</h3><p>Review previews and versions, then export PNG, sprite atlases, GLB, textures and editable Blender files. Originals remain intact; each result becomes a new version.</p></li>
        </ol>
        <EvidenceLink href={`${sourceUrl}/blob/master/docs/game-production.md`}>Read the production workflow</EvidenceLink>
      </section>

      <section id="evidence" className="overview-evidence" aria-labelledby="evidence-title"><div className="page-width overview-section">
        <div className="overview-section-heading"><h2 id="evidence-title">Inspect the product yourself.</h2><p>The examples link to actual files and verification records. Screenshots and platform tests have separate scopes.</p></div>
        <figure className="overview-workspace"><img src="/media/workstation-browser-013.png" width="1500" height="960" loading="lazy" alt="Asset Studio browser UI preview showing an asset library, editing canvas, version comparison and job queue" /><figcaption>Browser UI preview. This screenshot is not evidence of native generation or a Claude integration.</figcaption></figure>
        <div className="overview-proof-list">
          <article><h3>Editable 3D examples</h3><p>The crate, table and shelf are real Blender procedural outputs, with mesh validation, GLB and .blend source files. They are not image-to-3D or AI-image-generation examples.</p><EvidenceLink href={`${sourceUrl}/tree/master/examples/procedural`}>Open the models and source files</EvidenceLink></article>
          <article><h3>Windows release {release.version}</h3><p>Native CLI output, file hashes, original preservation, reopening and export are recorded. Image-to-3D uses a locally prepared CPU runtime and Blender.</p><div className="overview-proof-links"><EvidenceLink href={windowsDownload}>Download Windows</EvidenceLink><EvidenceLink href={`${sourceUrl}/blob/master/docs/releases/v${release.version}-windows.md`}>Read the release verification</EvidenceLink></div></article>
          {macReleases[0] && <article><h3>Apple Silicon release {macReleases[0].version}</h3><p>The app, DMG and independent CLI are published. PNG CLI processing and package integrity were checked; GUI, fresh 3D generation and installer replacement were not checked for this release.</p><div className="overview-proof-links"><EvidenceLink href={macReleases[0].downloadUrl}>Download Mac</EvidenceLink><EvidenceLink href={`${sourceUrl}/blob/master/docs/releases/v${macReleases[0].version}-macos.md`}>Read the release verification</EvidenceLink></div></article>}
          <article><h3>Open development</h3><p>Read the implementation, installation guides and issue history. Current features, source experiments and platform limits are documented separately.</p><div className="overview-proof-links"><EvidenceLink href={sourceUrl}>Source repository</EvidenceLink><EvidenceLink href={`${sourceUrl}/issues`}>Issue tracker</EvidenceLink><EvidenceLink href="https://www.npmjs.com/package/@oocheol/asset-studio">npm package</EvidenceLink></div></article>
        </div>
      </div></section>

      <LocalWorkflowCase />

      <section id="claude-plan" className="overview-section page-width overview-roadmap" aria-labelledby="claude-plan-title">
        <div><h2 id="claude-plan-title">{claudeStatus.titleEn}</h2><p className="overview-plan-state">{claudeStatus.statusEn}</p><p>{claudeStatus.detailEn}</p><p>Source development is separate from the published product: 0.1.13 installers do not include Claude planning. The intended flow is brief → reviewable asset instructions → creator approval → specialized tools. Claude planning does not generate images or 3D models and never starts production automatically.</p><EvidenceLink href={claudeWorkflowPath}>Inspect the Claude planning prototype</EvidenceLink></div>
        <aside className="overview-roadmap-note"><h3>Development priorities</h3><ul><li>Keep the creator’s review in the workflow.</li><li>Connect instructions to inspectable files.</li><li>Make provider availability and limits visible.</li></ul><EvidenceLink href={`${sourceUrl}/issues`}>Follow development</EvidenceLink></aside>
      </section>

      <section className="overview-connect page-width" aria-labelledby="overview-contact-title"><div><h2 id="overview-contact-title">Build, try, or get in touch.</h2><p>Download an early release, inspect the examples or share a workflow you want to improve.</p></div><a className="button button-primary" href={`mailto:${projectContact}`}><Mail size={20} aria-hidden="true" />{projectContact}</a></section>
    </main>
    <footer className="overview-footer page-width"><a href="/">Treeset / Asset Studio</a><nav aria-label="More project links"><a href="/#guide">User guide</a><SiteFooterLinks language="en" /><a href={sourceUrl}>GitHub</a><a href="/third-party-notices.txt">Third-party notices</a><a href="/" lang="ko">한국어 사이트</a></nav></footer>
  </div>;
}
