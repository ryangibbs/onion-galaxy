import assert from 'node:assert/strict'
import { test } from 'node:test'
import { renderHtml } from '../src/render.ts'
import type { GalaxyData } from '../src/types.ts'

// Needs the viewer bundle: run `pnpm build:viewer` (or `pnpm build`) first
const galaxy = (project: string): GalaxyData => ({
  meta: {
    root: '/tmp/x',
    project,
    generatedAt: '',
    clusterDepth: 1,
    files: 0,
    imports: 0,
    cycles: 0,
    filesInCycles: 0,
    orphans: 0,
    unresolved: 0,
    hasChurn: false,
    history: 'disabled',
    historyCommits: 0,
    bulkCommits: 0,
    rankedHotspots: 0,
    topHotspots: 0,
    typeCycles: false,
    cuts: 0,
  },
  clusters: [],
  nodes: [],
  links: [],
  cycles: [],
  view: { layout: 'spiral', editor: 'vscode' },
})

test('produces one self-contained page', () => {
  const html = renderHtml(galaxy('demo'))
  assert.match(html, /<title>demo · Onion Galaxy<\/title>/)
  assert.ok(!html.includes('/*__DATA__*/') && !html.includes('/*__SCRIPT__*/'), 'placeholders replaced')
  assert.ok(!/<script[^>]+src=/.test(html), 'no external scripts')
})

test('escapes data that could break out of the page', () => {
  const html = renderHtml(galaxy('<script>alert(1)</script> $& $1'))
  assert.ok(!html.includes('<script>alert(1)'), 'project name is HTML-escaped in the title')
  const data = html.slice(html.indexOf('id="galaxy-data"'))
  assert.ok(!data.slice(0, data.indexOf('</script>')).includes('</'), 'no closing tag inside inline JSON')
  assert.ok(html.includes('$&'), 'replacement patterns in data are kept literally')
})
