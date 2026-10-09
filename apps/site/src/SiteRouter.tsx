import App from './App';
import ProjectOverview from './ProjectOverview';
import ClaudeWorkflow from './ClaudeWorkflow';
import { claudeWorkflowPath } from './claudeProof';
import WorkshopPage from './workshop/WorkshopPage';
import WorkshopStory from './workshop/WorkshopStory';
import PolicyPage from './PolicyPage';
import ResearchExamples from './ResearchExamples';

export default function SiteRouter({ pathname }: { pathname: string }) {
  const normalized = pathname.endsWith('/') ? pathname : pathname + '/';
  if (normalized === '/terms/' || normalized === '/terms/en/') return <PolicyPage kind="terms" language={normalized.endsWith('/en/') ? 'en' : 'ko'} />;
  if (normalized === '/privacy/' || normalized === '/privacy/en/') return <PolicyPage kind="privacy" language={normalized.endsWith('/en/') ? 'en' : 'ko'} />;
  if (normalized === '/research/claude-scenarios/' || normalized === '/research/claude-scenarios/en/') return <ResearchExamples language={normalized.endsWith('/en/') ? 'en' : 'ko'} />;
  if (pathname === '/play/workshop' || pathname === '/play/workshop/') return <WorkshopPage />;
  if (pathname === '/play/workshop/en' || pathname === '/play/workshop/en/') return <WorkshopPage language="en" />;
  if (pathname === '/devlog/workshop' || pathname === '/devlog/workshop/') return <WorkshopStory />;
  if (pathname === '/about' || pathname === '/about/') return <ProjectOverview />;
  if (pathname === claudeWorkflowPath || pathname === claudeWorkflowPath.slice(0, -1)) return <ClaudeWorkflow />;
  return <App />;
}
