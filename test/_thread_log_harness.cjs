
const fs = require('node:fs')
const source = fs.readFileSync(process.argv[2], 'utf8')
const lines = source.split(/\r?\n/)

function findLine(needle, from = 0) {
  for (let i = from; i < lines.length; i++) if (lines[i].includes(needle)) return i
  throw new Error('missing anchor: ' + needle)
}

// Pull out the marker regex, the rebuild helper, and the budget helper.
const markerLine = findLine("const CHILD_MARKER")
const markerLineEnd = findLine('*', markerLine) // not needed; take the const line only
const rebuildFrom = findLine('function threadFromLog(')
const budgetFrom = findLine('function turnChars(')
const budgetTo = findLine('function rememberTurn(')
const rememberFrom = findLine('function rememberTurn(')

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

const patternLine = findLine('const CHILD_PATTERN')
const markerSrc = lines[markerLine].trim() + '\n' + lines[patternLine].trim()
const rebuildSrc = braceBlock(rebuildFrom)
const budgetSrc = braceBlock(budgetFrom)
const rememberSrc = braceBlock(rememberFrom)

const api = new Function(`
${markerSrc}
${rebuildSrc}
${budgetSrc}
${rememberSrc}
return { threadFromLog }
`)()

let failures = 0
function check(name, condition, detail) {
  if (condition) console.log('ok   ' + name)
  else { console.log('FAIL ' + name + ' :: ' + detail); failures++ }
}

const cfg = { maxThreadTurns: 20, maxThreadChars: 24000 }
const MARK = '[[dsh-btw:child='

/** Build a fake parent session whose snapshotEvents returns these events. */
function sessionOf(events) {
  return { snapshotEvents: () => events }
}

// A three-turn thread:
//   t1: plain question          -> child A
//   t2: --continue A            -> child B
//   t3: --continue B            -> child C
const thread = [
  { type: 'command/run', data: { commandId: 'c1', name: 'btw', args: ' 请记住 <marker-d>' } },
  { type: 'command/done', data: { commandId: 'c1', kind: 'success', text: 'ok\n\n' + MARK + 'A]]' } },
  { type: 'command/run', data: { commandId: 'c2', name: 'btw', args: ' --continue A 标记是什么？' } },
  { type: 'command/done', data: { commandId: 'c2', kind: 'success', text: '<marker-d>\n\n' + MARK + 'B]]' } },
  { type: 'command/run', data: { commandId: 'c3', name: 'btw', args: ' --continue B 再说一遍？' } },
  { type: 'command/done', data: { commandId: 'c3', kind: 'success', text: '还是 <marker-d>\n\n' + MARK + 'C]]' } },
]

// 1) continuing C recovers both earlier turns
let turns = api.threadFromLog(sessionOf(thread), 'C', cfg)
// C's own turn is included, plus the two it continued.
check('rebuilds the chain', turns.length === 3, JSON.stringify(turns))
check('oldest turn first', turns[0] && turns[0].q.includes('请记住 <marker-d>'), JSON.stringify(turns[0]))
check('carries the marker answer',
      turns[2] && turns[2].a.includes('<marker-d>'), JSON.stringify(turns[2]))
check('drops the child marker from answers',
      turns.every((t) => !t.a.includes('dsh-btw:child=')), JSON.stringify(turns.map((t) => t.a)))
check('follow-up question text is clean',
      turns[1] && turns[1].q === '标记是什么？', JSON.stringify(turns[1] && turns[1].q))

// 2) continuing A recovers nothing (it is the first turn)
turns = api.threadFromLog(sessionOf(thread), 'A', cfg)
// A is the first turn: it has its own exchange and nothing before it.
check('first child has only its own turn',
      turns.length === 1 && turns[0].q.includes('<marker-d>'), JSON.stringify(turns))

// 3) an unknown child yields nothing rather than throwing
turns = api.threadFromLog(sessionOf(thread), 'nope', cfg)
check('unknown child is safe', turns.length === 0, JSON.stringify(turns))

// 4) no events at all
turns = api.threadFromLog(sessionOf([]), 'C', cfg)
check('empty log is safe', turns.length === 0, JSON.stringify(turns))

// 5) a broken/cyclic log terminates
const cyclic = [
  { type: 'command/run', data: { commandId: 'x1', name: 'btw', args: ' --continue B q1' } },
  { type: 'command/done', data: { commandId: 'x1', kind: 'success', text: 'a1\n\n' + MARK + 'A]]' } },
  { type: 'command/run', data: { commandId: 'x2', name: 'btw', args: ' --continue A q2' } },
  { type: 'command/done', data: { commandId: 'x2', kind: 'success', text: 'a2\n\n' + MARK + 'B]]' } },
]
turns = api.threadFromLog(sessionOf(cyclic), 'A', cfg)
check('cyclic log terminates', Array.isArray(turns) && turns.length <= 20, String(turns.length))

// 6) errors are skipped, not carried as answers
const withError = [
  { type: 'command/run', data: { commandId: 'y1', name: 'btw', args: ' q' } },
  { type: 'command/done', data: { commandId: 'y1', kind: 'error', text: '侧问失败\n\n' + MARK + 'Z]]' } },
]
turns = api.threadFromLog(sessionOf(withError), 'Z', cfg)
check('failed turns still reconstruct without throwing', Array.isArray(turns), JSON.stringify(turns))

console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURES')
process.exit(failures === 0 ? 0 : 1)
