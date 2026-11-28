
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

// --- the pieces of client.js the helper depends on ---------------------------
const markerLine = lines[findLine('const CHILD_MARKER')].trim()
const continueLine = lines[findLine('const CONTINUE_FORM')].trim()
const viewSrc = braceBlock(findLine('function viewOf('))

// The membership computation, lifted out of the component.
const threadStart = findLine('const thread = React.useMemo(() => {')
const threadBlock = braceBlock(threadStart)
const threadFn = threadBlock
  .replace('const thread = React.useMemo(() => {', 'function computeThread(records, wanted) {')
  .replace(/\},\s*\[records, wanted\]\)\s*$/, '}')

const api = new Function(
  [markerLine, continueLine, viewSrc, threadFn, 'return { computeThread }'].join('\n'),
)()
const computeThread = api.computeThread

let failures = 0
function check(name, condition, detail) {
  if (condition) console.log('ok   ' + name)
  else { console.log('FAIL ' + name + ' :: ' + detail); failures++ }
}

let seq = 0
function cmd(id, args, answer) {
  seq += 1
  return { commandId: id, args: args ?? '', seq, outcome: { kind: 'success', text: answer ?? '' } }
}
const answerWith = (child) => `答\n\n[[dsh-btw:child=${child}]]`

// Thread A: c1 -> A1, then two follow-ups chained A1 -> A2 -> A3.
// Thread B: c2 -> B1 with its own follow-up.
const records = [
  cmd('c1', ' 问题 A', answerWith('A1')),
  cmd('c2', ' 问题 B', answerWith('B1')),
  cmd('c3', ' --continue A1 A 的第一次追问', answerWith('A2')),
  cmd('c4', ' --continue B1 B 的追问', answerWith('B2')),
  cmd('c5', ' --continue A2 A 的第二次追问', answerWith('A3')),
]

let thread = computeThread(records, 'c1')
check('thread A includes its own follow-ups',
      thread.map((r) => r.commandId).join(',') === 'c1,c3,c5',
      JSON.stringify(thread.map((r) => r.commandId)))
check('thread A excludes thread B',
      !thread.some((r) => r.commandId === 'c2' || r.commandId === 'c4'),
      JSON.stringify(thread.map((r) => r.commandId)))

thread = computeThread(records, 'c2')
check('thread B is independent',
      thread.map((r) => r.commandId).join(',') === 'c2,c4',
      JSON.stringify(thread.map((r) => r.commandId)))

// Opening a follow-up shows it plus whatever continued *it*: it is a root for its
// own subtree, not a view backwards into the thread it came from.
thread = computeThread(records, 'c3')
check('opening a follow-up shows it and its continuations',
      thread.map((r) => r.commandId).join(',') === 'c3,c5',
      JSON.stringify(thread.map((r) => r.commandId)))
check('opening a follow-up does not reach backwards',
      !thread.some((r) => r.commandId === 'c1'),
      JSON.stringify(thread.map((r) => r.commandId)))

check('unknown root is safe', computeThread(records, 'zzz').length === 0, 'n/a')

const partial = [cmd('d1', ' q1', 'no child id here'), cmd('d2', ' --continue A1 x', answerWith('A2'))]
check('a missing child id matches nothing', computeThread(partial, 'd1').length === 1,
      JSON.stringify(computeThread(partial, 'd1').map((r) => r.commandId)))

// Two independent roots in one session must not see each other's follow-ups.
const twins = [
  cmd('e1', ' one', answerWith('X1')),
  cmd('e2', ' two', answerWith('Y1')),
  cmd('e3', ' --continue Y1 y-follow', answerWith('Y2')),
]
check('a second root stays clean', computeThread(twins, 'e1').map((r) => r.commandId).join(',') === 'e1',
      JSON.stringify(computeThread(twins, 'e1').map((r) => r.commandId)))

console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURES')
process.exit(failures === 0 ? 0 : 1)
