import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const productionHost = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  const configuredUrl = loadEnv(mode, process.cwd(), '').VITE_SITE_URL
    || (productionHost ? `https://${productionHost}` : null);
  const siteUrl = configuredUrl && /^https?:\/\//.test(configuredUrl)
    ? `${configuredUrl.replace(/\/+$/, '')}/`
    : null;
  return {
    plugins: [react(), {
      name: 'asset-studio-site-metadata',
      transformIndexHtml() {
        if (!siteUrl) return [];
        return [
          { tag: 'link', attrs: { rel: 'canonical', href: siteUrl }, injectTo: 'head' as const },
          { tag: 'meta', attrs: { property: 'og:url', content: siteUrl }, injectTo: 'head' as const },
          { tag: 'meta', attrs: { property: 'og:image', content: `${siteUrl}media/workstation-browser.png` }, injectTo: 'head' as const },
          { tag: 'meta', attrs: { name: 'twitter:image', content: `${siteUrl}media/workstation-browser.png` }, injectTo: 'head' as const },
        ];
      },
      generateBundle() {
        if (!siteUrl) return;
        this.emitFile({ type: 'asset', fileName: 'sitemap.xml', source: `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${siteUrl}</loc></url></urlset>` });
      },
    }],
    server: { host: '127.0.0.1', port: 4174 },
    preview: { host: '127.0.0.1', port: 4174 },
  };
});
