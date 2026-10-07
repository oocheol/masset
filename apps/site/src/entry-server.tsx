import React from 'react';
import { renderToString } from 'react-dom/server';
import SiteRouter from './SiteRouter';

export function render(pathname: string) {
  return renderToString(<React.StrictMode><SiteRouter pathname={pathname} /></React.StrictMode>);
}
