import React from 'react';
import { createRoot, hydrateRoot } from 'react-dom/client';
import SiteRouter from './SiteRouter';
import './style.css';
import './overview.css';

const root = document.getElementById('root')!;
const page = <React.StrictMode><SiteRouter pathname={window.location.pathname} /></React.StrictMode>;
if (root.hasChildNodes()) hydrateRoot(root, page);
else createRoot(root).render(page);
