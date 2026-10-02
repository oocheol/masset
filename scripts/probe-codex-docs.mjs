/** Public official-document evidence only; no provider inference or credentials. */
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const pages = [
  {
    url: 'https://learn.chatgpt.com/docs/image-generation.md',
    topics: ['Built-in image generation uses `gpt-image-2`', 'Describe the image in an interactive session', 'Attach an existing image'],
  },
  {
    url: 'https://developers.openai.com/codex/app-server.md',
    topics: ['You can generate a TypeScript schema', '`modelProvider/capabilities/read`', '**ChatGPT managed (`chatgpt`)**', '`turn/interrupt`'],
  },
  {
    url: 'https://developers.openai.com/codex/auth.md',
    topics: ['Sign in with ChatGPT for subscription access', 'Sign in with an API key for usage-based access'],
  },
  {
    url: 'https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations.md',
    topics: ['**Unsupported tools:** Image generation', 'These limits apply to ChatGPT plan usage'],
  },
  {
    url: 'https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference.md',
    topics: ['bundled or cached catalog', '**Supported endpoint:**', 'response.completed'],
  },
  {
    url: 'https://developers.openai.com/api/docs/guides/image-generation.md',
    topics: ['The API lets you generate and edit images from text prompts using `gpt-image-2.5-sunburst` and `gpt-image-2.5-flare`.', '### GPT Image 2.5 costs'],
  },
];
const sources = [];
for (const page of pages) {
  const host = new URL(page.url).hostname;
  if (!['developers.openai.com', 'learn.chatgpt.com'].includes(host)) throw new Error('Not an official documentation domain');
  const response = await fetch(page.url, { signal: AbortSignal.timeout(25_000) });
  if (!response.ok) throw new Error(`Official documentation fetch failed: ${response.status}`);
  const content = await response.text();
  const excerpts = page.topics.map((topic) => {
    const index = content.indexOf(topic);
    if (index < 0) return { topic, found: false, excerpt: null };
    return { topic, found: true, excerpt: content.slice(index, Math.min(content.indexOf('\n\n', index) > index ? content.indexOf('\n\n', index) : index + 650, index + 900)) };
  });
  sources.push({ url: page.url, retrievedAt: new Date().toISOString(), sha256: createHash('sha256').update(content).digest('hex'), excerpts });
}
const root = resolve(import.meta.dirname, '..');
await mkdir(resolve(root, 'tests/provider'), { recursive: true });
await writeFile(resolve(root, 'tests/provider/official-doc-evidence.json'), JSON.stringify({ clientDate: '2026-10-02', sources }, null, 2) + '\n');
console.log(JSON.stringify({ sourcesRead: sources.length, allTopicsFound: sources.every((source) => source.excerpts.every((excerpt) => excerpt.found)), file: 'tests/provider/official-doc-evidence.json' }));
