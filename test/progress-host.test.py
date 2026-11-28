"""Unit tests for the Host-side progress producer (`trackProgress`).

The reducer tests cover the Client. This covers the other half: given the frames
DSH actually publishes, does the plugin emit the right progress frames?

Driven with a fake `ctx` whose `agents.get()` returns a child exposing `ctx.on`,
which is exactly the surface `trackProgress` uses. No browser, no child agent.
"""

import subprocess
import sys
from pathlib import Path

PLUGIN = Path(r"D:\ExplorerDownload\WorkBuddyWorkDirectory\plugins\dsh-btw")
INDEX = PLUGIN / "index.js"

HARNESS = r"""
const fs = require('node:fs')
const source = fs.readFileSync(process.argv[2], 'utf8')
const lines = source.split(/\r?\n/)

function findLine(needle, from = 0) {
  for (let i = from; i < lines.length; i++) if (lines[i].includes(needle)) return i
  throw new Error('missing anchor: ' + needle)
}
function braceBlock(startLine) {
  let depth = 0, started = false, end = startLine
  for (let i = startLine; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') { depth++; started = true }
      else if (ch === '}') depth--
    }
    if (started && depth === 0) { end = i + 1; break }
  }
  return lines.slice(startLine, end).join('\n')
}

// The buffer helpers and the tracker, in their real order.
const progressConsts = lines
  .filter((l) => l.startsWith('const PROGRESS_MAX_FRAMES') || l.startsWith('const PROGRESS_PREVIEW_CHARS') || l.startsWith('const PROGRESS ='))
  .join('\n')
const pieces = [
  'const PROGRESS_ROUTE = "x"',
  progressConsts,
  braceBlock(findLine('function progressKey(')),
  braceBlock(findLine('function progressEntry(')),
  braceBlock(findLine('function sseFrame(')),
  braceBlock(findLine('function emitProgress(')),
  braceBlock(findLine('function finishProgress(')),
  braceBlock(findLine('function pruneProgress(')),
  braceBlock(findLine('function clipProgress(')),
  braceBlock(findLine('function toolResultPreview(')),
  braceBlock(findLine('function trackProgress(')),
].join('\n')

const api = new Function(`${pieces}
return { trackProgress, finishProgress, PROGRESS, progressKey }
`)()

let failures = 0
function check(name, condition, detail) {
  if (condition) console.log('ok   ' + name)
  else { console.log('FAIL ' + name + ' :: ' + detail); failures++ }
}

// --- fake ctx / child -------------------------------------------------------
const handlers = { 'agent/assistant-stream': [], 'session/event': [] }
const child = {
  id: 'child-1',
  ctx: {
    on(event, fn) {
      handlers[event].push(fn)
      return () => {
        const at = handlers[event].indexOf(fn)
        if (at >= 0) handlers[event].splice(at, 1)
      }
    },
  },
}
const ctx = { get: (name) => (name === 'agents' ? { get: () => child } : undefined) }
const config = { streamProgress: true, sideAgentTimeoutMs: 900000, progressTtlMs: 1800000 }

function framesOf(parent, command) {
  const entry = api.PROGRESS.get(api.progressKey(parent, command))
  return entry === undefined ? [] : entry.frames
}
function stream(frame) {
  for (const fn of [...handlers['agent/assistant-stream']]) fn({ agent: child, frame })
}
function sessionEvent(event) {
  for (const fn of [...handlers['session/event']]) fn({ id: 'child-1' }, event)
}

// --- 1) reasoning and text deltas become their own frames --------------------
const stop = api.trackProgress(ctx, 'p1', 'c1', 'child-1', config)
stream({ type: 'start', attemptId: 'a', revision: 1, turn: 1, step: 1 })
stream({ type: 'chunk', attemptId: 'a', revision: 1, index: 0, time: 0, chunk: { type: 'reasoning-delta', index: 0, text: '想一想' } })
stream({ type: 'chunk', attemptId: 'a', revision: 1, index: 1, time: 0, chunk: { type: 'text-delta', index: 1, text: '答：42' } })

let frames = framesOf('p1', 'c1')
check('status frame first', frames[0] && frames[0].type === 'status', JSON.stringify(frames[0]))
check('reasoning frame emitted', frames.some((f) => f.type === 'reasoning' && f.text === '想一想'), JSON.stringify(frames))
check('text frame emitted', frames.some((f) => f.type === 'text' && f.text === '答：42'), JSON.stringify(frames))

// --- 2) a tool call is announced once, then summarised at block-end ---------
stream({ type: 'chunk', attemptId: 'a', revision: 1, index: 2, time: 0, chunk: { type: 'tool-call-delta', index: 2, id: 'call-a', name: 'read', argumentsDelta: '{"pa' } })
stream({ type: 'chunk', attemptId: 'a', revision: 1, index: 2, time: 0, chunk: { type: 'tool-call-delta', index: 2, id: 'call-a', argumentsDelta: 'th":"a.js"}' } })
frames = framesOf('p1', 'c1')
const starts = frames.filter((f) => f.type === 'tool-start')
check('tool-start emitted once', starts.length === 1 && starts[0].name === 'read', JSON.stringify(starts))

stream({ type: 'chunk', attemptId: 'a', revision: 1, index: 2, time: 0, chunk: { type: 'block-end', index: 2, block: { type: 'tool-call', id: 'call-a', name: 'read', arguments: '{"path":"a.js"}' } } })
frames = framesOf('p1', 'c1')
const calls = frames.filter((f) => f.type === 'tool-call')
check('tool-call carries full arguments', calls.length === 1 && calls[0].arguments === '{"path":"a.js"}', JSON.stringify(calls))

// --- 3) a tool result from the session log names its tool ------------------
sessionEvent({ type: 'tool/result', data: { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'call-a', content: [{ type: 'text', text: 'file contents here' }] } } })
frames = framesOf('p1', 'c1')
const results = frames.filter((f) => f.type === 'tool-result')
check('tool-result emitted', results.length === 1, JSON.stringify(results))
check('tool-result resolves the tool name', results[0].name === 'read', JSON.stringify(results[0]))
check('tool-result keeps a preview', results[0].preview === 'file contents here', JSON.stringify(results[0]))
check('tool-result is not an error', results[0].isError === false, JSON.stringify(results[0]))

// --- 4) events from another session are ignored ----------------------------
const before = framesOf('p1', 'c1').length
for (const fn of handlers['session/event']) fn({ id: 'someone-else' }, { type: 'tool/result', data: { message: { content: [] } } })
check('foreign session events ignored', framesOf('p1', 'c1').length === before, String(framesOf('p1', 'c1').length))

// --- 5) finish closes the buffer and marks it done -------------------------
api.finishProgress('p1', 'c1', { type: 'done' })
const entry = api.PROGRESS.get(api.progressKey('p1', 'c1'))
check('buffer marked done', entry.done === true, String(entry.done))
check('done frame appended', entry.frames[entry.frames.length - 1].type === 'done', JSON.stringify(entry.frames.slice(-1)))

// --- 6) a late frame after finish is dropped ------------------------------
const settled = entry.frames.length
stream({ type: 'chunk', attemptId: 'a', revision: 1, index: 3, time: 0, chunk: { type: 'text-delta', index: 3, text: 'late' } })
check('frames after done are dropped', entry.frames.length === settled, String(entry.frames.length))

// --- 7) stopTracking unhooks both listeners -------------------------------
stop()
check('listeners removed', handlers['agent/assistant-stream'].length === 0 && handlers['session/event'].length === 0,
      JSON.stringify({ s: handlers['agent/assistant-stream'].length, e: handlers['session/event'].length }))

// --- 8) streamProgress=false emits only the status frame ------------------
api.PROGRESS.clear()
const stop2 = api.trackProgress(ctx, 'p2', 'c2', 'child-1', { ...config, streamProgress: false })
stream({ type: 'chunk', attemptId: 'a', revision: 1, index: 0, time: 0, chunk: { type: 'text-delta', index: 0, text: 'x' } })
const off = framesOf('p2', 'c2')
check('disabled streaming emits one status frame', off.length === 1 && off[0].type === 'status', JSON.stringify(off))
stop2()

console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURES')
process.exit(failures === 0 ? 0 : 1)
"""


def main() -> int:
    harness = PLUGIN / "test" / "_progress_host_harness.cjs"
    harness.write_text(HARNESS, encoding="utf-8")
    result = subprocess.run(["node", str(harness), str(INDEX)], capture_output=True, text=True)
    print(result.stdout, end="")
    if result.stderr.strip():
        print(result.stderr.strip())
    return result.returncode


if __name__ == "__main__":
    sys.exit(main())
