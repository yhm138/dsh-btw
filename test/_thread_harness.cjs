
const fs = require('node:fs')
const source = fs.readFileSync(process.argv[2], 'utf8')
const lines = source.split(/\r?\n/)

/** Line index (0-based) of the first line containing `needle`, from `from`. */
function findLine(needle, from = 0) {
  for (let i = from; i < lines.length; i++) if (lines[i].includes(needle)) return i
  throw new Error('missing anchor: ' + needle)
}

const from = findLine('const THREADS = new Map()')
let to = findLine('function rememberTurn(')
// walk forward to the closing brace of rememberTurn
let depth = 0, started = false
for (; to < lines.length; to++) {
  const line = lines[to]
  for (const ch of line) {
    if (ch === '{') { depth++; started = true }
    else if (ch === '}') { depth-- }
  }
  if (started && depth === 0) { to++; break }
}
if (to <= from) throw new Error('bad slice ' + from + '..' + to)
const block = lines.slice(from, to).join('\n')

const api = new Function(`${block}\nreturn { rememberTurn, pruneThreads, THREADS, THREAD_TOUCHED }`)()

let failures = 0
function check(name, condition, detail) {
  if (condition) console.log('ok   ' + name)
  else { console.log('FAIL ' + name + ' :: ' + detail); failures++ }
}
const cfg = (turns, chars) => ({ maxThreadTurns: turns, maxThreadChars: chars, maxThreads: 64, threadTtlMs: 21600000 })

// 1) under both caps: everything kept, oldest first
api.THREADS.clear()
for (let i = 1; i <= 3; i++) api.rememberTurn('k1', 'q' + i, 'a' + i, cfg(20, 24000))
let kept = api.rememberTurn('k1', 'q4', 'a4', cfg(20, 24000))
check('keeps all turns under budget',
      kept.length === 4 && kept[0].q === 'q1' && kept[3].q === 'q4', JSON.stringify(kept))

// 2) turn cap drops the oldest first
api.THREADS.clear()
for (let i = 1; i <= 6; i++) api.rememberTurn('k2', 'q' + i, 'a' + i, cfg(3, 0))
kept = api.THREADS.get('k2')
check('turn cap keeps the newest',
      kept.length === 3 && kept[2].q === 'q6' && kept[0].q === 'q4',
      JSON.stringify(kept.map((t) => t.q)))

// 3) character cap drops oldest, keeps newest
api.THREADS.clear()
const big = 'x'.repeat(400)
for (let i = 1; i <= 5; i++) api.rememberTurn('k3', 'q' + i, big, cfg(20, 1000))
kept = api.rememberTurn('k3', 'q6', big, cfg(20, 1000))
const chars = kept.reduce((n, t) => n + t.q.length + t.a.length, 0)
check('char cap bounds the payload', chars <= 1300, `chars=${chars} turns=${kept.length}`)
check('char cap keeps the newest turn',
      kept[kept.length - 1].q === 'q6', JSON.stringify(kept.map((t) => t.q)))

// 4) a single oversized turn is clipped but never dropped
api.THREADS.clear()
const huge = 'y'.repeat(5000)
kept = api.rememberTurn('k4', 'q-only', huge, cfg(20, 1000))
check('oversized newest turn is clipped, not dropped',
      kept.length === 1 && kept[0].a.length < huge.length && kept[0].a.endsWith('…'),
      `kept=${kept.length} len=${kept[0] && kept[0].a.length}`)

// 5) maxThreadChars = 0 disables only the char cap
api.THREADS.clear()
for (let i = 1; i <= 30; i++) api.rememberTurn('k5', 'q' + i, big, cfg(40, 0))
kept = api.THREADS.get('k5')
check('chars=0 keeps everything the turn cap allows', kept.length === 30, String(kept.length))

// 6) threads are isolated by key
api.THREADS.clear()
api.rememberTurn('a', 'qa', 'aa', cfg(20, 24000))
api.rememberTurn('b', 'qb', 'ab', cfg(20, 24000))
check('threads are isolated',
      api.THREADS.get('a')[0].q === 'qa' && api.THREADS.get('b')[0].q === 'qb',
      JSON.stringify([...api.THREADS.keys()]))

// 7) more than eight turns is allowed by default-ish config (the old hard cap)
api.THREADS.clear()
for (let i = 1; i <= 15; i++) api.rememberTurn('k7', 'q' + i, 'a', cfg(20, 24000))
check('more than 8 turns are kept', api.THREADS.get('k7').length === 15,
      String(api.THREADS.get('k7').length))

// 8) retention bounds: at most maxThreads threads survive
api.THREADS.clear(); api.THREAD_TOUCHED.clear()
for (let i = 1; i <= 80; i++) api.rememberTurn('t' + i, 'q', 'a', cfg(20, 24000))
check('thread count is bounded', api.THREADS.size <= 64, String(api.THREADS.size))
check('newest threads survive',
      api.THREADS.has('t80') && !api.THREADS.has('t1'),
      JSON.stringify([...api.THREADS.keys()].slice(0, 3)))

// 9) idle TTL drops stale threads
api.THREADS.clear(); api.THREAD_TOUCHED.clear()
api.rememberTurn('old', 'q', 'a', cfg(20, 24000))
api.THREAD_TOUCHED.set('old', Date.now() - 21600001)
api.pruneThreads(cfg(20, 24000))
check('idle thread is pruned', !api.THREADS.has('old'), JSON.stringify([...api.THREADS.keys()]))

// 10) a touched thread survives
api.THREADS.clear(); api.THREAD_TOUCHED.clear()
api.rememberTurn('live', 'q', 'a', cfg(20, 24000))
api.pruneThreads(cfg(20, 24000))
check('recent thread survives', api.THREADS.has('live'), JSON.stringify([...api.THREADS.keys()]))

console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURES')
process.exit(failures === 0 ? 0 : 1)
