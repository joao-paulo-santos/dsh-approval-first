/**
 * dsh-approval-first — diff-presentation parity tests.
 *
 * The shadows cannot import `dsh-tools`/`diff` (external plain-JS bundle,
 * link-installed — see lib/index.js header), so the contextual-hunk
 * projection is reimplemented in place. This suite pins it against the REAL
 * shipped algorithm: `structuredPatch(..., { context: 3 })` from the same
 * `diff` package version `tool-fs` depends on, mapped exactly like
 * `packages/fs/tool-fs/src/diff.ts` `computeHunkDiffs` maps it.
 *
 * Run: node test/diff-parity.test.mjs   (exit 0 = parity holds)
 */

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import * as plugin from '../lib/index.js'

const requireFromToolFs = createRequire('/home/ecila/dev/deepseek-harness/packages/fs/tool-fs/package.json')
const { structuredPatch } = requireFromToolFs('diff')

/** The shipped computeHunkDiffs mapping, copied verbatim from tool-fs/src/diff.ts. */
const oracleHunkDiffs = (path, before, after) => {
  const patch = structuredPatch('', '', before, after, undefined, undefined, { context: 3 })
  const diffs = []
  for (const hunk of patch.hunks) {
    const oldLines = []
    const newLines = []
    for (const line of hunk.lines) {
      if (line.startsWith('\\')) continue
      const text = line.slice(1)
      if (line.startsWith('-')) {
        oldLines.push(text)
      } else if (line.startsWith('+')) {
        newLines.push(text)
      } else {
        oldLines.push(text)
        newLines.push(text)
      }
    }
    diffs.push({ path, oldText: oldLines.length > 0 ? oldLines.join('\n') : null, newText: newLines.join('\n') })
  }
  return diffs
}

// Grab the edit shadow's presentationMeta — the same function production calls.
const editPresentationMeta = (() => {
  const registeredTools = new Map()
  const agentCtx = {
    tools: {
      register: (definition) => {
        registeredTools.set(definition.name, definition)
        return () => { registeredTools.delete(definition.name) }
      },
    },
  }
  const agent = { id: 'session-diff', session: { id: 'session-diff', header: { cwd: '/w' } }, ctx: agentCtx }
  const provided = {
    approval: { request: async () => 'rejected' },
    fs: { sandboxMode: 'read-only' },
    agents: { list: () => [agent] },
    sandboxPolicy: { resolve: () => ({ mode: 'read-only', workspaceRoot: '/w' }) },
    // No shipped globals in this harness: the drift check stays 'pending'
    // (inconclusive), which must not block activation — only drift does.
    tools: { get: () => undefined },
  }
  const declared = new Set(plugin.inject)
  const pluginCtx = {
    inject: plugin.inject,
    get: (name) => (declared.has(name) ? provided[name] : undefined),
    on: () => () => {},
    emit: () => {},
    waterfall: async (_type, _target, _exec, fallback) => fallback(),
  }
  for (const name of plugin.inject) {
    Object.defineProperty(pluginCtx, name, { get() { return provided[name] } })
  }
  plugin.apply(pluginCtx, { activeModes: ['read-only'] })
  return registeredTools.get('edit').output.presentationMeta
})()

const shadowHunkDiffs = (path, before, after) =>
  editPresentationMeta({ file_path: path }, { path, before, after }).diffs

/** Corpus builder: a deterministic pseudo-random edit over a base text. */
const buildScatteredCase = (seed) => {
  let state = seed
  const nextRandom = () => {
    state = (state * 1103515245 + 12345) % 2147483648
    return state / 2147483648
  }
  const beforeLines = []
  for (let index = 0; index < 120; index += 1) beforeLines.push('line-' + index)
  const afterLines = [...beforeLines]
  for (let editIndex = 0; editIndex < 6; editIndex += 1) {
    const targetIndex = Math.floor(nextRandom() * afterLines.length)
    if (nextRandom() < 0.5) {
      afterLines.splice(targetIndex, 1)
    } else {
      afterLines.splice(targetIndex, 0, 'inserted-' + editIndex)
    }
  }
  return [beforeLines.join('\n') + '\n', afterLines.join('\n') + '\n']
}

const CASES = [
  ['identical texts produce no hunks', 'a\nb\nc\n', 'a\nb\nc\n'],
  ['single mid-file replacement', 'alpha\nbeta\ngamma\n', 'alpha\nBETA\ngamma\n'],
  ['replacement in a one-line file', 'only\n', 'ONLY\n'],
  ['insertion at the start', 'b\nc\nd\n', 'a\nb\nc\nd\n'],
  ['insertion at the end', 'a\nb\nc\n', 'a\nb\nc\nd\n'],
  ['deletion in the middle', 'a\nb\nX\nc\nd\n', 'a\nb\nc\nd\n'],
  ['pure insertion into an empty file', '', 'first\nsecond\n'],
  ['delete everything', 'a\nb\nc\n', ''],
  ['trailing newline added', 'a\nb', 'a\nb\n'],
  ['trailing newline removed', 'a\nb\n', 'a\nb'],
  ['one side lacks the final newline mid-edit', 'x\ny', 'x\nY'],
  ['CRLF-styled content', 'a\r\nb\r\nc\r\n', 'a\r\nB\r\nc\r\n'],
  ['contiguous multi-line replacement', 'keep1\nold-a\nold-b\nold-c\nkeep2\n', 'keep1\nnew-a\nnew-b\nkeep2\n'],
  ['changes separated by exactly 6 context lines (merge boundary)', 'A\n1\n2\n3\n4\n5\n6\nB\n', 'A-\n1\n2\n3\n4\n5\n6\nB-\n'],
  ['changes separated by exactly 7 context lines (split boundary)', 'A\n1\n2\n3\n4\n5\n6\n7\nB\n', 'A-\n1\n2\n3\n4\n5\n6\n7\nB-\n'],
  ['changes separated by 12 context lines', 'A\n1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12\nB\n', 'A-\n1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12\nB-\n'],
  ['change at line 1 and line 2 (adjacent runs)', 'A\nB\nrest\n', 'A-\nB-\nrest\n'],
  ['change in last line only', '1\n2\n3\n4\nlast\n', '1\n2\n3\n4\nLAST\n'],
  ['duplicate lines replaced wholesale', 'same\nsame\nsame\n', 'same\nsame\nother\n'],
  ...Array.from({ length: 12 }, (_unused, index) => ['scattered deterministic case ' + index, ...buildScatteredCase(1000 + index * 7919)]),
]

let casesChecked = 0
let failures = 0
for (const [caseName, beforeText, afterText] of CASES) {
  const oracleResult = oracleHunkDiffs('f.txt', beforeText, afterText)
  const shadowResult = shadowHunkDiffs('f.txt', beforeText, afterText)
  try {
    assert.deepEqual(shadowResult, oracleResult)
    casesChecked += 1
    console.log('  ok - ' + caseName)
  } catch (mismatch) {
    failures += 1
    console.error('  FAIL - ' + caseName)
    console.error('    oracle: ' + JSON.stringify(oracleResult))
    console.error('    shadow: ' + JSON.stringify(shadowResult))
  }
}

if (failures > 0) {
  console.error('\ndiff-parity.test.mjs: ' + failures + ' FAILING case(s)')
  process.exit(1)
}
console.log('\ndiff-parity.test.mjs: ' + casesChecked + ' cases at parity with the shipped algorithm')
