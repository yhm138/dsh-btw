"""Smoke test for the Markdown renderer as embedded in client.js.

The renderer lives inside the client bundle (dsh.client allows one browser entry
per package), so the test extracts that section and exercises it with a stub
React, keeping the assertions that matter: block/inline support and the
guarantee that raw HTML never becomes an element.
"""

import json
import re
import subprocess
import sys
from pathlib import Path

PLUGIN = Path(r"D:\ExplorerDownload\WorkBuddyWorkDirectory\plugins\dsh-btw")
CLIENT = PLUGIN / "client.js"

CASES = [
    ("inline", "**bold** and `code` and *em* and [link](https://example.com)", "div"),
    ("bullets", "- a\n- b\n- c", "ul"),
    ("ordered", "1) one\n2) two", "ol"),
    ("headings", "## Title\n\ntext", "h2"),
    ("fence", "```js\nconst x = 1\n```", "pre"),
    ("quote", "> quoted line", "blockquote"),
    ("plain", "just text", "div"),
]

HARNESS = r"""
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
"""


def main() -> int:
    harness = PLUGIN / "test" / "_markdown_harness.cjs"
    harness.write_text(HARNESS, encoding="utf-8")
    result = subprocess.run(
        ["node", str(harness), str(CLIENT), json.dumps(CASES)],
        capture_output=True,
        text=True,
    )
    print(result.stdout, end="")
    if result.stderr.strip():
        print(result.stderr.strip())
    return result.returncode


if __name__ == "__main__":
    sys.exit(main())
