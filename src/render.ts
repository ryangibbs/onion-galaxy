import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { GalaxyData } from './types.ts'

// The viewer is pre-bundled by `npm run build:viewer` into dist/viewer/. This module runs either
// from dist/ (published) or from src/ (development via `node src/cli.ts`), so look in both places.
const viewerDir = ['./viewer/', '../dist/viewer/']
  .map(p => fileURLToPath(new URL(p, import.meta.url)))
  .find(dir => existsSync(`${dir}viewer.js`))

/** Inlines the bundled viewer plus the graph data into one self-contained HTML file. */
export function renderHtml(galaxy: GalaxyData): string {
  if (!viewerDir) throw new Error('Viewer bundle not found. Run `pnpm build:viewer` first.')
  const script = readFileSync(`${viewerDir}viewer.js`, 'utf8')
  const template = readFileSync(`${viewerDir}index.html`, 'utf8')
  // Inline content must not be able to end its <script> element early: every `<` in the JSON becomes
  // the equivalent `\u003c` escape, and `</script` in the bundle is escaped. Replacer functions stop
  // `$&`-style patterns in the data being interpreted by String#replace.
  return template
    .replace('__TITLE__', () => `${escapeHtml(galaxy.meta.project)} · Onion Galaxy`)
    .replace('/*__DATA__*/', () => JSON.stringify(galaxy).replaceAll('<', '\\u003c'))
    .replace('/*__SCRIPT__*/', () => script.replaceAll('</script', '<\\/script'))
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
