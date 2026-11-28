"""Unit tests for the progress-frame reducer.

The reducer is what turns the Host's SSE frames into what the card draws, so it is
the piece that must not lose or duplicate information:

  * reasoning deltas concatenate and stay separate from answer text;
  * a tool call appears once, keeps the arguments that arrived with it, and is
    matched to its result even when the result arrives after the block ends;
  * an unknown result id is ignored rather than creating a phantom row;
  * a `done` phase ends the view without clearing what already streamed.
"""

import subprocess
import sys
from pathlib import Path

PLUGIN = Path(r"D:\ExplorerDownload\WorkBuddyWorkDirectory\plugins\dsh-btw")
CLIENT = PLUGIN / "client.js"

HARNESS = r"""
const fs = require('node:fs')
const source = fs.readFileSync(process.argv[2], 'utf8')
const lines = source.split(/\r?\n/)

function findLine(needle, from = 0) {
  for (let i = from; i < lines.length; i++) if (lines[i].includes(needle)) return i
  throw new Error('missing anchor: ' + needle)
}

/** Slice a block by its balanced braces, starting at the declaration line. */
function braceBlock(startLine) {
  let depth = 0
  let started = false
  let end = startLine
  for (let i = startLine; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') { depth++; started = true }
      else if (ch === '}') depth--
    }
    if (started && depth === 0) { end = i + 1; break }
  }
  return lines.slice(startLine, end).join('\n')
}

const applySrc = braceBlock(findLine('function applyFrame('))
const api = new Function(`${applySrc}\nreturn { applyFrame }`)()

let failures = 0
function check(name, condition, detail) {
  if (condition) console.log('ok   ' + name)
  else { console.log('FAIL ' + name + ' :: ' + detail); failures++ }
}

let v = null
v = api.applyFrame(v, { type: 'status', phase: 'started' })
v = api.applyFrame(v, { type: 'reasoning', text: '先看 ' })
v = api.applyFrame(v, { type: 'reasoning', text: '文件结构。' })
check('reasoning concatenates', v.reasoning === '先看 文件结构。', v.reasoning)
check('reasoning is not answer text', v.text === '', JSON.stringify(v.text))

v = api.applyFrame(v, { type: 'tool-start', id: 'c1', name: 'read' })
v = api.applyFrame(v, { type: 'tool-call', id: 'c1', name: 'read', arguments: '{"path":"a.js"}' })
check('tool appears once', v.tools.length === 1, JSON.stringify(v.tools))
check('tool keeps arguments', v.tools[0].args === '{"path":"a.js"}', JSON.stringify(v.tools[0]))
check('tool is pending', v.tools[0].done === false, JSON.stringify(v.tools[0]))

v = api.applyFrame(v, { type: 'tool-result', id: 'c1', name: 'read', isError: false, preview: 'ok' })
check('result attaches to the call', v.tools[0].result === 'ok' && v.tools[0].done === true, JSON.stringify(v.tools[0]))

v = api.applyFrame(v, { type: 'tool-start', id: 'c2', name: 'grep' })
v = api.applyFrame(v, { type: 'tool-result', id: 'c2', isError: true, preview: 'no match' })
check('error result is marked', v.tools[1].isError === true, JSON.stringify(v.tools[1]))
check('second tool kept in order', v.tools.map((t) => t.name).join(',') === 'read,grep', JSON.stringify(v.tools.map((t) => t.name)))

v = api.applyFrame(v, { type: 'tool-result', id: 'nope', preview: 'ghost' })
check('unknown result id is ignored', v.tools.length === 2, JSON.stringify(v.tools.length))

v = api.applyFrame(v, { type: 'text', text: '答案是 ' })
v = api.applyFrame(v, { type: 'text', text: '42。' })
check('answer text concatenates', v.text === '答案是 42。', v.text)
check('answer text stays out of reasoning', v.reasoning === '先看 文件结构。', v.reasoning)

v = api.applyFrame(v, { type: 'done', childId: 'x' })
check('done keeps the streamed content', v.text === '答案是 42。' && v.tools.length === 2, JSON.stringify({ t: v.text, n: v.tools.length }))
check('done sets the phase', v.phase === 'done', v.phase)

// replaying the same tool-start must not duplicate the row (Last-Event-ID replay)
const before = v.tools.length
v = api.applyFrame(v, { type: 'tool-start', id: 'c1', name: 'read' })
check('replayed tool-start does not duplicate', v.tools.length === before, String(v.tools.length))

console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURES')
process.exit(failures === 0 ? 0 : 1)
"""


def main() -> int:
    harness = PLUGIN / "test" / "_progress_harness.cjs"
    harness.write_text(HARNESS, encoding="utf-8")
    result = subprocess.run(["node", str(harness), str(CLIENT)], capture_output=True, text=True)
    print(result.stdout, end="")
    if result.stderr.strip():
        print(result.stderr.strip())
    return result.returncode


if __name__ == "__main__":
    sys.exit(main())
