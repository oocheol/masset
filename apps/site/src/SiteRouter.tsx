import App from './App';
import ProjectOverview from './ProjectOverview';
import ClaudeWorkflow from './ClaudeWorkflow';
import { claudeWorkflowPath } from './claudeProof';

export default function SiteRouter({ pathname }: { pathname: string }) {
  if (pathname === '/about' || pathname === '/about/') return <ProjectOverview />;
  if (pathname === claudeWorkflowPath || pathname === claudeWorkflowPath.slice(0, -1)) return <ClaudeWorkflow />;
  return <App />;
}
