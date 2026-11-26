
const fs = require('node:fs')
const source = fs.readFileSync(process.argv[2], 'utf8')
const start = source.indexOf('// ------------------------------------------------------------ markdown')
if (start < 0) { console.log('FAIL no markdown section'); process.exit(2) }
const endMarker = 'const md = { renderMarkdown }'
const stop = source.indexOf(endMarker, start)
if (stop < 0) { console.log('FAIL no renderer binding'); process.exit(2) }
const section = source.slice(start, stop)
const h = (tag, props, ...children) => ({ tag, props, children: children.flat() })
const React = { createElement: h }
const factory = new Function('React', 'h', section + '\nreturn { renderMarkdown }')
const api = factory(React, h)
const cases = JSON.parse(process.argv[3])
let failures = 0
for (const [name, input, expected] of cases) {
  let nodes
  try { nodes = api.renderMarkdown(input) } catch (e) { console.log('FAIL ' + name + ': ' + e.message); failures++; continue }
  const tags = (nodes ?? []).map((n) => n.tag)
  if (!tags.includes(expected)) { console.log('FAIL ' + name + ': expected ' + expected + ' got ' + tags.join(',')); failures++ }
  else console.log('ok   ' + name + ': ' + tags.join(','))
}
const empty = api.renderMarkdown('')
if (empty !== null) { console.log('FAIL empty: expected null'); failures++ } else console.log('ok   empty: null')
const html = JSON.stringify(api.renderMarkdown('<img src=x onerror=alert(1)>'))
if (html.includes('"tag":"img"')) { console.log('FAIL raw-html became an element'); failures++ }
else console.log('ok   raw-html: text only')
console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURES')
process.exit(failures === 0 ? 0 : 1)
