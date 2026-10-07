import App from './App';
import ProjectOverview from './ProjectOverview';

export default function SiteRouter({ pathname }: { pathname: string }) {
  return pathname === '/about' || pathname === '/about/' ? <ProjectOverview /> : <App />;
}
