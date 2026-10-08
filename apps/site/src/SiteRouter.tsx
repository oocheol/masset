import App from './App';
import ProjectOverview from './ProjectOverview';
import ClaudeWorkflow from './ClaudeWorkflow';
import { claudeWorkflowPath } from './claudeProof';
import WorkshopPage from './workshop/WorkshopPage';
import WorkshopStory from './workshop/WorkshopStory';

export default function SiteRouter({ pathname }: { pathname: string }) {
  if (pathname === '/play/workshop' || pathname === '/play/workshop/') return <WorkshopPage />;
  if (pathname === '/play/workshop/en' || pathname === '/play/workshop/en/') return <WorkshopPage language="en" />;
  if (pathname === '/devlog/workshop' || pathname === '/devlog/workshop/') return <WorkshopStory />;
  if (pathname === '/about' || pathname === '/about/') return <ProjectOverview />;
  if (pathname === claudeWorkflowPath || pathname === claudeWorkflowPath.slice(0, -1)) return <ClaudeWorkflow />;
  return <App />;
}
