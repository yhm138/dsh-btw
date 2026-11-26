// dsh-btw — Client half: the right-Sidebar "Side question" page and the
// compact transcript chip.
//
// Data source: the Chat layer's own command nodes. `/btw` is a Host command, so
// its lifecycle is already projected into the conversation as a `command` node
// (name 'btw', args = the question, outcome.text = the answer). This module
// reads those nodes through the `useChat` standard prop and renders them as a
// right-Sidebar page (`ctx.sidebarRightTabs` + `sidebar.right.pane.tab`), so the
// answer docks in the column the user already works in instead of floating over
// the composer. The generic command card is replaced with a one-line chip that
// reopens the page.
//
// Nothing here talks to the Host: no route, no RPC, no extra persistence. The
// page is a view over the same durable command records the Chat already has.

window.__ModuleLoader__.load({
  id: '@aspen138/dsh-btw',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    // ------------------------------------------------------------ markdown

    /** The Markdown renderer this bundle owns (see markdown.js for its tests). */

﻿    /** Split one line into inline tokens: code, bold, italic, links, plain. */
    function inline(text, keyPrefix) {
      const out = []
      let rest = text
      let index = 0
      const push = (type, value, extra) => {
        const key = `${keyPrefix}-${index}`
        index += 1
        if (type === 'code') out.push(h('code', { key, className: 'dshbtw-md-code' }, value))
        else if (type === 'strong') out.push(h('strong', { key }, value))
        else if (type === 'em') out.push(h('em', { key }, value))
        else if (type === 'link') out.push(h('a', { key, href: extra, target: '_blank', rel: 'noreferrer noopener', className: 'dshbtw-md-link' }, value))
        else out.push(value)
      }

      while (rest.length > 0) {
        const code = /^`([^`]+)`/u.exec(rest)
        if (code !== null) {
          push('code', code[1])
          rest = rest.slice(code[0].length)
          continue
        }
        const strong = /^\*\*([^*]+)\*\*/u.exec(rest) ?? /^__([^_]+)__/u.exec(rest)
        if (strong !== null) {
          push('strong', strong[1])
          rest = rest.slice(strong[0].length)
          continue
        }
        const link = /^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/u.exec(rest)
        if (link !== null) {
          push('link', link[1], link[2])
          rest = rest.slice(link[0].length)
          continue
        }
        const em = /^\*([^*\n]+)\*/u.exec(rest) ?? /^_([^_\n]+)_/u.exec(rest)
        if (em !== null) {
          push('em', em[1])
          rest = rest.slice(em[0].length)
          continue
        }
        // Plain run up to the next special character.
        const plain = /^[^`*_[\]]+/u.exec(rest)
        if (plain !== null) {
          // Bare URLs become links, which is the one autolink worth having.
          const url = /(https?:\/\/[^\s<>()]+)/u.exec(plain[0])
          if (url === null) {
            push('text', plain[0])
          } else {
            const before = plain[0].slice(0, url.index)
            if (before !== '') push('text', before)
            push('link', url[1], url[1])
            const after = plain[0].slice(url.index + url[1].length)
            if (after !== '') push('text', after)
          }
          rest = rest.slice(plain[0].length)
          continue
        }
        push('text', rest[0])
        rest = rest.slice(1)
      }
      return out
    }

    /** Render one paragraph-ish line with inline markup. */
    function line(text, key) {
      return h('div', { key, className: 'dshbtw-md-p' }, inline(text, key))
    }

    /**
     * Render Markdown source into React elements.
     *
     * Supported: fenced and indented code, ATX headings, bullet and ordered
     * lists (one level of nesting), blockquotes, horizontal rules, paragraphs,
     * and the inline subset above. Unknown syntax degrades to plain text.
     *
     * @param source - raw answer text.
     * @returns React children.
     */
    function renderMarkdown(source) {
      const text = typeof source === 'string' ? source : ''
      if (text === '') return null
      const lines = text.replace(/\r\n?/gu, '\n').split('\n')
      const blocks = []
      let index = 0
      let key = 0

      while (index < lines.length) {
        const current = lines[index]

        const fence = /^\s*(```+|~~~+)\s*([\w-]*)\s*$/u.exec(current)
        if (fence !== null) {
          const marker = fence[1][0]
          const body = []
          index += 1
          while (index < lines.length && !new RegExp(`^\\s*${marker}{3,}\\s*$`, 'u').test(lines[index])) {
            body.push(lines[index])
            index += 1
          }
          index += 1
          blocks.push(h('pre', { key: `k${key}`, className: 'dshbtw-md-pre' }, h('code', null, body.join('\n'))))
          key += 1
          continue
        }

        const heading = /^\s*(#{1,6})\s+(.*)$/u.exec(current)
        if (heading !== null) {
          const level = Math.min(6, heading[1].length)
          blocks.push(h(`h${level}`, { key: `k${key}`, className: 'dshbtw-md-h' }, inline(heading[2], `h${key}`)))
          key += 1
          index += 1
          continue
        }

        if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/u.test(current)) {
          blocks.push(h('hr', { key: `k${key}`, className: 'dshbtw-md-hr' }))
          key += 1
          index += 1
          continue
        }

        if (/^\s*>/u.test(current)) {
          const body = []
          while (index < lines.length && /^\s*>/u.test(lines[index])) {
            body.push(lines[index].replace(/^\s*>\s?/u, ''))
            index += 1
          }
          blocks.push(h('blockquote', { key: `k${key}`, className: 'dshbtw-md-quote' }, renderMarkdown(body.join('\n'))))
          key += 1
          continue
        }

        const bullet = /^(\s*)[-*+]\s+(.*)$/u.exec(current)
        const ordered = /^(\s*)\d+[.)]\s+(.*)$/u.exec(current)
        if (bullet !== null || ordered !== null) {
          const isOrdered = ordered !== null
          const items = []
          while (index < lines.length) {
            const match = isOrdered ? /^(\s*)\d+[.)]\s+(.*)$/u.exec(lines[index]) : /^(\s*)[-*+]\s+(.*)$/u.exec(lines[index])
            if (match === null) break
            items.push({ indent: match[1].length, text: match[2] })
            index += 1
          }
          const tag = isOrdered ? 'ol' : 'ul'
          const manyLevels = items.some((item) => item.indent > 0)
          if (!manyLevels) {
            blocks.push(
              h(
                tag,
                { key: `k${key}`, className: 'dshbtw-md-list' },
                items.map((item, at) => h('li', { key: at }, inline(item.text, `li${key}-${at}`))),
              ),
            )
          } else {
            // Keep the hierarchy readable without a full nested-list model.
            blocks.push(
              h(
                'ul',
                { key: `k${key}`, className: 'dshbtw-md-list is-flat' },
                items.map((item, at) =>
                  h(
                    'li',
                    { key: at, style: { marginLeft: `${Math.min(item.indent, 8) * 0.6}em` } },
                    inline(item.text, `li${key}-${at}`),
                  ),
                ),
              ),
            )
          }
          key += 1
          continue
        }

        if (current.trim() === '') {
          index += 1
          continue
        }

        // Paragraph: consume until a blank line or another block start.
        const paragraph = []
        while (index < lines.length) {
          const candidate = lines[index]
          if (candidate.trim() === '') break
          if (/^\s*(```|~~~|#{1,6}\s|>\s?|[-*+]\s|\d+[.)]\s)/u.test(candidate)) break
          paragraph.push(candidate)
          index += 1
        }
        if (paragraph.length === 0) {
          // Defensive: never loop forever on an unrecognized line.
          paragraph.push(lines[index])
          index += 1
        }
        blocks.push(
          h(
            'div',
            { key: `k${key}`, className: 'dshbtw-md-block' },
            paragraph.map((item, at) => line(item, `p${key}-${at}`)),
          ),
        )
        key += 1
      }

      return blocks
    }

    const md = { renderMarkdown }


    /** Implementation identity: unique in the tab system, and the body slot key. */
    const TYPE_ID = 'dsh-btw/side-questions'

    /** Page kind the navigation controller opens by name. */
    const KIND = 'btw'

    /** Set by `apply`; the transcript chip uses it to reveal the page. */
    const navigation = { open: undefined, openChild: undefined }

    /** Diagnostic surface for verification runs; never user-visible. */
    const debug = { tabs: false, right: false, lastError: null, open: undefined }
    try {
      if (typeof window !== 'undefined') window.__DSH_BTW__ = debug
    } catch {
      /* a read-only window is not worth breaking the plugin over */
    }

    // ---------------------------------------------------------------- strings

    const STRINGS = {
      zh: {
        badge: '侧问',
        badgeHint: '继承当前对话、不带工具，答案不进入主干上下文',
        typeLabel: '侧问',
        guideTitle: '侧问',
        guideDescription: '问一句小细节，不动主线任务',
        running: '正在回答…',
        done: '已答',
        failed: '失败',
        emptyQuestion: '（空问题）',
        emptyTitle: '还没有侧问',
        emptyHint: '在输入框输入 /btw <问题>，答案会出现在这里，且不进入模型上下文。',
        copy: '复制问答',
        copied: '已复制',
        followPlaceholder: '在这个侧问里继续追问…',
        followSend: '追问',
        followSent: '已填入输入框，回车发送',
        settingsTitle: '侧问',
        setLoading: '正在读取配置…',
        setLoadFailed: '读取配置失败',
        setSaving: '正在保存…',
        setSaved: '已保存，下一次侧问生效',
        setSaveFailed: '保存失败',
        setUnsupported: '当前 profile 没有 configEditor，配置只能手改 cordis.patch.yml',
        setSave: '保存',
        set_sideAgentPreset: '子 agent 权限',
        set_sideAgentPresetHint: '侧问起的临时 agent 能做什么。read-only 只读；workspace-write 只能改工作区；danger-full-access 不受限。',
        set_approvalPolicy: '审批策略',
        set_approvalPolicyHint: 'ask：需要审批的操作走审批通道；inherit：跟随会话默认。',
        set_answerMaxChars: '答案长度上限',
        set_answerMaxCharsHint: '超过这个字数的答案会被截断，避免撑爆面板。',
        set_maxThreadTurns: '追问保留轮数',
        set_maxThreadTurnsHint: '追问时会把这条侧问此前几轮问答拼进 prompt。轮数越多越连贯，也越贵。',
        set_maxThreadChars: '追问保留字数上限',
        set_maxThreadCharsHint: '更硬的约束：从最新一轮往回取，超出就丢最旧的。填 0 表示不限字数、只按轮数。',
        set_sideAgentTimeoutMs: '单次侧问超时',
        set_sideAgentTimeoutMsHint: '毫秒。超时后中止子 agent，不会一直挂着。',
        set_maxQuestionChars: '问题长度上限',
        set_maxQuestionCharsHint: '超过就直接拒绝，不浪费一次子 agent。',
        set_disposeChild: '答完释放子 agent',
        set_disposeChildHint: '关掉：保留执行句柄，便于继续追问（会占资源）。',
        "opt_read-only": '只读',
        "opt_workspace-write": '只能改工作区',
        "opt_danger-full-access": '不受限',
        "opt_inherit": '跟随会话',
        on: '开',
        off: '关',
        openChild: '查看子会话',
        openChildHint: '在右侧打开这条侧问的子会话：它的工具调用和审批都在那里',
        chipOpen: '在右侧打开这条侧问的子会话',
        questionPrefix: '问',
        answerPrefix: '答',
        degraded: '仅文本历史',
        count: (n) => `${n} 条`,
      },
      en: {
        badge: 'Side question',
        badgeHint: 'Inherits this conversation, no tools; never enters the main context',
        typeLabel: 'Side question',
        guideTitle: 'Side question',
        guideDescription: 'Ask one small thing without touching the task',
        running: 'Answering…',
        done: 'Answered',
        failed: 'Failed',
        emptyQuestion: '(empty question)',
        emptyTitle: 'No side questions yet',
        emptyHint: 'Type /btw <question> in the composer. Answers appear here and never enter the model context.',
        copy: 'Copy question and answer',
        copied: 'Copied',
        followPlaceholder: 'Ask a follow-up in this side question…',
        followSend: 'Follow up',
        followSent: 'Placed in the composer — press Enter',
        settingsTitle: 'Side question',
        setLoading: 'Loading configuration…',
        setLoadFailed: 'Could not load configuration',
        setSaving: 'Saving…',
        setSaved: 'Saved — applies to the next side question',
        setSaveFailed: 'Could not save',
        setUnsupported: 'This profile has no configEditor; edit cordis.patch.yml by hand',
        setSave: 'Save',
        set_sideAgentPreset: 'Side agent permissions',
        set_sideAgentPresetHint: 'What the disposable side agent may do. read-only reads; workspace-write edits this workspace; danger-full-access is unrestricted.',
        set_approvalPolicy: 'Approval policy',
        set_approvalPolicyHint: 'ask routes approval-gated operations through the approval flow; inherit follows the session default.',
        set_answerMaxChars: 'Answer length cap',
        set_answerMaxCharsHint: 'Longer answers are truncated so the panel stays readable.',
        set_maxThreadTurns: 'Follow-up turns kept',
        set_maxThreadTurnsHint: 'A follow-up prepends this thread\'s earlier Q&A. More turns stay coherent and cost more.',
        set_maxThreadChars: 'Follow-up character budget',
        set_maxThreadCharsHint: 'The harder bound: walks back from the newest turn and drops the oldest first. 0 = turns only.',
        set_sideAgentTimeoutMs: 'Side question timeout',
        set_sideAgentTimeoutMsHint: 'Milliseconds. The child is cancelled instead of hanging forever.',
        set_maxQuestionChars: 'Question length cap',
        set_maxQuestionCharsHint: 'Longer questions are refused before a child agent is spent.',
        set_disposeChild: 'Release the side agent after answering',
        set_disposeChildHint: 'Off keeps the execution handle for follow-ups, at the cost of resources.',
        "opt_read-only": 'Read only',
        "opt_workspace-write": 'Workspace writes only',
        "opt_danger-full-access": 'Unrestricted',
        "opt_inherit": 'Follow the session',
        on: 'On',
        off: 'Off',
        openChild: 'Open sub-session',
        openChildHint: "Open this side question's own session: its tool calls and approval prompts live there",
        chipOpen: "Open this side question's sub-session",
        questionPrefix: 'Q',
        answerPrefix: 'A',
        degraded: 'text history only',
        count: (n) => `${n} item${n === 1 ? '' : 's'}`,
      },
    }

    /** Language used when no locale service is mounted. */
    function documentLanguage() {
      try {
        const lang = String((typeof document !== 'undefined' && document.documentElement && document.documentElement.lang) || 'zh')
        return lang.toLowerCase().startsWith('zh') ? 'zh' : 'en'
      } catch {
        return 'zh'
      }
    }

    // -------------------------------------------------------------------- css

    const CSS = [
      '.dshbtw-page{display:flex;flex-direction:column;gap:10px;padding:12px 12px 24px;font-size:13px;line-height:20px;',
      'color:var(--dsw-alias-label-primary);overflow:auto;height:100%}',
      '.dshbtw-empty{display:flex;flex-direction:column;gap:6px;padding:28px 8px;color:var(--dsw-alias-label-secondary);text-align:center}',
      '.dshbtw-empty-title{font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.dshbtw-empty-hint{font-size:12px;line-height:18px}',
      '.dshbtw-card{display:flex;flex-direction:column;gap:6px;padding:10px 12px;border:0.5px solid var(--dsw-alias-border-l1);',
      'border-radius:10px;background:var(--dsw-alias-bg-layer-1)}',
      '.dshbtw-card-head{display:flex;align-items:flex-start;gap:6px}',
      '.dshbtw-q{flex:1;min-width:0;font-weight:600;white-space:pre-wrap;word-break:break-word}',
      '.dshbtw-state{flex:none;font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.dshbtw-state.is-error{color:var(--dsw-alias-state-error-primary)}',
      '.dshbtw-a{white-space:pre-wrap;word-break:break-word}',
      '.dshbtw-a.is-markdown{white-space:normal}',
      '.dshbtw-md-p{margin:0 0 2px}',
      '.dshbtw-md-block{margin:0 0 4px}',
      '.dshbtw-md-h{margin:10px 0 4px;font-size:13px;font-weight:600;line-height:18px}',
      '.dshbtw-md-h:first-child{margin-top:0}',
      '.dshbtw-md-list{margin:0 0 4px;padding-left:20px}',
      '.dshbtw-md-list.is-flat{list-style:disc}',
      '.dshbtw-md-list li{margin:1px 0}',
      '.dshbtw-md-pre{margin:4px 0;padding:8px 10px;overflow:auto;border-radius:6px;',
      'background:var(--dsw-alias-bg-layer-2);border:0.5px solid var(--dsw-alias-border-l1);',
      'font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:18px;white-space:pre}',
      '.dshbtw-md-code{padding:1px 4px;border-radius:4px;background:var(--dsw-alias-bg-layer-2);',
      'font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}',
      '.dshbtw-md-quote{margin:4px 0;padding:2px 0 2px 8px;border-left:2px solid var(--dsw-alias-border-l2);',
      'color:var(--dsw-alias-label-secondary)}',
      '.dshbtw-md-hr{margin:8px 0;border:0;border-top:0.5px solid var(--dsw-alias-border-l1)}',
      '.dshbtw-md-link{color:var(--dsw-alias-brand-primary);text-decoration:none}',
      '.dshbtw-md-link:hover{text-decoration:underline}',
      '.dshbtw-follow{display:flex;align-items:center;gap:6px;margin-top:4px}',
      '.dshbtw-follow-input{flex:1;min-width:0;height:24px;padding:0 8px;border:0.5px solid var(--dsw-alias-border-l1);',
      'border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px}',
      '.dshbtw-follow-input::placeholder{color:var(--dsw-alias-state-idle-primary)}',
      '.dshbtw-follow-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}',
      '.dshbtw-set{display:flex;flex-direction:column;gap:14px;padding:4px 2px 24px;font-size:13px;line-height:20px;',
      'color:var(--dsw-alias-label-primary)}',
      '.dshbtw-set-row{display:flex;flex-direction:column;gap:4px}',
      '.dshbtw-set-label{font-weight:600}',
      '.dshbtw-set-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
      '.dshbtw-set-field{display:flex;align-items:center;gap:8px}',
      '.dshbtw-set-input{width:120px;height:26px;padding:0 8px;border:0.5px solid var(--dsw-alias-border-l1);',
      'border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px}',
      '.dshbtw-set-select{height:26px;padding:0 6px;border:0.5px solid var(--dsw-alias-border-l1);border-radius:6px;',
      'background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px}',
      '.dshbtw-set-toggle{display:inline-flex;align-items:center;gap:8px;cursor:pointer}',
      '.dshbtw-set-save{align-self:flex-start;height:28px;padding:0 14px;border:0;border-radius:7px;',
      'background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base);font:inherit;font-size:13px;cursor:pointer}',
      '.dshbtw-set-save:disabled{opacity:.5;cursor:default}',
      '.dshbtw-set-status{font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.dshbtw-set-status.is-error{color:var(--dsw-alias-state-error-primary)}',
      '.dshbtw-set-status.is-ok{color:var(--dsw-alias-state-success-primary)}',
      '.dshbtw-a.is-error{color:var(--dsw-alias-state-error-primary)}',
      '.dshbtw-a.is-running{color:var(--dsw-alias-label-secondary);animation:dshbtw-pulse 1.4s ease-in-out infinite}',
      '@keyframes dshbtw-pulse{0%,100%{opacity:.55}50%{opacity:1}}',
      '@media(prefers-reduced-motion:reduce){.dshbtw-a.is-running{animation:none}}',
      '.dshbtw-actions{display:flex;align-items:center;gap:6px;margin-top:2px}',
      '.dshbtw-btn{display:inline-flex;align-items:center;justify-content:center;gap:4px;height:22px;padding:0 8px;',
      'border:0.5px solid var(--dsw-alias-border-l1);border-radius:6px;background:transparent;',
      'color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer}',
      '.dshbtw-btn:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
      '.dshbtw-meta{flex:1;min-width:0;font-size:11px;color:var(--dsw-alias-state-idle-primary);overflow:hidden;',
      'text-overflow:ellipsis;white-space:nowrap}',
      '.dshbtw-chip{display:flex;align-items:center;gap:6px;width:100%;max-width:100%;padding:2px 0;',
      'border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;',
      'line-height:18px;text-align:left;cursor:pointer}',
      '.dshbtw-chip:hover{color:var(--dsw-alias-label-primary)}',
      '.dshbtw-chip-mark{flex:none;color:var(--dsw-alias-brand-primary)}',
      '.dshbtw-chip-label{flex:none;font-weight:600}',
      '.dshbtw-chip-text{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dshbtw-chip-state{flex:none;color:var(--dsw-alias-state-idle-primary)}',
      '.dshbtw-chip-state.is-error{color:var(--dsw-alias-state-error-primary)}',
      '.dshbtw-hbtn{display:inline-flex;align-items:center;gap:4px;height:22px;padding:0 7px;',
      'border:0.5px solid var(--dsw-alias-border-l1);border-radius:999px;background:transparent;',
      'color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:1;cursor:pointer}',
      '.dshbtw-hbtn:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
      '.dshbtw-hbtn-mark{color:var(--dsw-alias-brand-primary)}',
      '.dshbtw-hbtn-count{min-width:10px;text-align:center;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
    ].join('')

    // ------------------------------------------------------------------ error

    /** Keep one crashing view from blanking the whole slot entry. */
    class Boundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }
      static getDerivedStateFromError(error) {
        return { error }
      }
      componentDidCatch(error) {
        try {
          console.error('[dsh-btw] view crashed', error)
        } catch {
          /* logging must never throw */
        }
      }
      render() {
        if (this.state.error !== null) return this.props.fallback === undefined ? null : this.props.fallback
        return this.props.children
      }
    }

    // ------------------------------------------------------------------- data

    const EMPTY = Object.freeze([])

    /**
     * Collect the `/btw` command nodes of the current Chat target.
     *
     * A command node is `{kind:'command', data:{commandId,name,args,outcome,…}}`.
     * `outcome === null` means the handler is still running; otherwise
     * `outcome.kind` is 'success' | 'error' and `outcome.text` may carry the
     * answer. The selector never throws: a slot entry that throws is removed by
     * the host, so every access is defensive.
     */
    function selectBtwRecords(snapshot) {
      try {
        const nodes = snapshot && snapshot.nodes
        if (!nodes || typeof nodes.values !== 'function') return EMPTY
        const records = []
        for (const node of nodes.values()) {
          if (!node || typeof node !== 'object') continue
          const data = node.data !== null && typeof node.data === 'object' ? node.data : node
          if (data.name !== 'btw') continue
          records.push(data)
        }
        if (records.length === 0) return EMPTY
        records.sort((left, right) => (Number(left.seq) || 0) - (Number(right.seq) || 0))
        return records
      } catch {
        return EMPTY
      }
    }

    /** Field-wise stability so a fresh array does not re-render on every snapshot. */
    function sameRecords(left, right) {
      if (left === right) return true
      if (!left || !right || left.length !== right.length) return false
      for (let index = 0; index < left.length; index += 1) {
        const a = left[index]
        const b = right[index]
        if (a === b) continue
        if (a.commandId !== b.commandId || a.args !== b.args || a.time !== b.time) return false
        const ao = a.outcome
        const bo = b.outcome
        if (ao === bo) continue
        if (!ao || !bo) return false
        if (ao.kind !== bo.kind || ao.text !== bo.text) return false
      }
      return true
    }

    /** Read the session's side-question records through the Chat hook. */
    function useBtwRecords(useChat) {
      const records = typeof useChat === 'function' ? useChat(selectBtwRecords, sameRecords) : EMPTY
      return Array.isArray(records) ? records : EMPTY
    }

    /** Trailer the Host appends to every answer to name its child session. */
    const CHILD_MARKER = /\[\[dsh-btw:child=([^\]\s]+)\]\]/u

    /** The internal follow-up form the panel writes into the composer. */
    const CONTINUE_FORM = /^--continue\s+(\S+)\s+([\s\S]+)$/u

    /**
     * Normalize one command record for rendering.
     *
     * Strips the child marker out of the visible answer, and keeps the child
     * session id when the Host published one: that id is what opens the side
     * agent's own conversation (tool calls and native approval prompts) in the
     * right Sidebar.
     */
    function viewOf(record) {
      const outcome = record.outcome !== null && typeof record.outcome === 'object' ? record.outcome : undefined
      const raw = outcome !== undefined && typeof outcome.text === 'string' ? outcome.text : ''
      const match = CHILD_MARKER.exec(raw)
      const args = typeof record.args === 'string' ? record.args.trim() : ''
      const follow = CONTINUE_FORM.exec(args)
      return {
        commandId: String(record.commandId ?? ''),
        question: follow === null ? args : follow[2].trim(),
        followUp: follow !== null,
        answer: raw.replace(CHILD_MARKER, '').replace(/\s+$/u, ''),
        childId: match === null ? (follow === null ? undefined : follow[1]) : match[1],
        running: record.outcome === null,
        failed: outcome !== undefined && outcome.kind === 'error',
      }
    }

    // ------------------------------------------------------------------ glyph

    /** Guide artwork for the "开始" page entry: a bubble with a question spark. */
    function BtwGlyph(props) {
      const size = props !== null && typeof props === 'object' && Number.isFinite(props.size) ? props.size : 20
      return h(
        'svg',
        { viewBox: '0 0 24 24', width: size, height: size, fill: 'none', 'aria-hidden': true },
        h('path', {
          d: 'M4 6.5A2.5 2.5 0 0 1 6.5 4h7A2.5 2.5 0 0 1 16 6.5v4A2.5 2.5 0 0 1 13.5 13H9l-3.2 2.9V13H6.5A2.5 2.5 0 0 1 4 10.5z',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'M18.6 10.2l.9 2 2 .9-2 .9-.9 2-.9-2-2-.9 2-.9z',
          fill: 'currentColor',
          opacity: 0.85,
        }),
      )
    }

    // ------------------------------------------------------------------- chip

    /**
     * Transcript chip registered on `conversation.chat.commandview` key 'btw'.
     *
     * It replaces the generic command card for `/btw` only: the answer belongs
     * to the right-Sidebar page, and the transcript keeps a single quiet line
     * that reveals it. A fresh question opens the page automatically; an old one
     * only opens when clicked, so reopening a session does not move the column.
     */
    function BtwChip(props) {
      const t = props.__btwStrings
      const data = props.node !== null && typeof props.node === 'object' ? props.node : {}
      const view = viewOf(data)
      const state = view.running ? t.running : view.failed ? t.failed : t.done

      // A fresh question reveals the side agent's own conversation: that is
      // where its tool calls and approval prompts live. The child id only
      // arrives with the settled answer, so this also fires on completion.
      React.useEffect(() => {
        if (view.childId === undefined) return
        const at = Number(data.time)
        const fresh = Number.isFinite(at) ? Date.now() - at < 300000 : false
        if (!fresh) return
        if (typeof navigation.openChild === 'function') navigation.openChild(view.childId, props.sessionId)
      }, [view.childId, data.time])

      return h(
        'button',
        {
          type: 'button',
          className: 'dshbtw-chip',
          'data-dshbtw': 'chip',
          'data-state': view.running ? 'running' : view.failed ? 'failed' : 'done',
          ...(view.childId === undefined ? {} : { 'data-child': view.childId }),
          title: t.chipOpen,
          onClick: () => {
            if (view.childId !== undefined && typeof navigation.openChild === 'function') {
              navigation.openChild(view.childId, props.sessionId)
              return
            }
            if (typeof navigation.open === 'function') navigation.open()
          },
        },
        h('style', { key: 'style' }, CSS),
        h('span', { key: 'mark', className: 'dshbtw-chip-mark', 'aria-hidden': true }, '◈'),
        h('span', { key: 'label', className: 'dshbtw-chip-label' }, t.badge),
        h('span', { key: 'text', className: 'dshbtw-chip-text' }, view.question === '' ? t.emptyQuestion : view.question),
        h('span', { key: 'state', className: view.failed ? 'dshbtw-chip-state is-error' : 'dshbtw-chip-state' }, state),
      )
    }

    // ---------------------------------------------------------------- header

    /**
     * Persistent "side question" button in the Session header utilities.
     *
     * Closing the right-Sidebar tab must never strand the history: this button
     * stays in the header whenever the session has side questions and reopens
     * the page. It renders nothing for a session that never used `/btw`.
     */
    function BtwHeaderButton(props) {
      const t = props.__btwStrings
      const records = useBtwRecords(props.useChat)
      if (records.length === 0) return null
      return h(
        'button',
        {
          type: 'button',
          className: 'dshbtw-hbtn',
          'data-dshbtw': 'header-button',
          'data-count': String(records.length),
          title: t.chipOpen,
          'aria-label': `${t.badge}（${records.length}）`,
          onClick: () => {
            if (typeof navigation.open === 'function') navigation.open()
          },
        },
        h('style', { key: 'style' }, CSS),
        h('span', { key: 'mark', className: 'dshbtw-hbtn-mark', 'aria-hidden': true }, '◈'),
        h('span', { key: 'label' }, t.badge),
        h('span', { key: 'count', className: 'dshbtw-hbtn-count' }, String(records.length)),
      )
    }

    // ------------------------------------------------------------------ page

    /**
     * Render one answer.
     *
     * Markdown comes from this bundle's own renderer (`markdown.js`), loaded as
     * a sibling client entry: a hand-written plugin must not require another
     * Harness Client package, and the answer text must never be injected as
     * HTML. A failed render degrades to plain pre-wrapped text.
     */
    function AnswerBody(props) {
      const t = props.strings
      const view = props.view
      if (view.running) {
        return h('div', { className: 'dshbtw-a is-running', 'data-dshbtw': 'answer', 'data-rendered': 'running' }, t.running)
      }
      const body = view.failed ? view.answer : view.answer
      let rendered = null
      if (!view.failed && typeof md.renderMarkdown === 'function') {
        try {
          rendered = md.renderMarkdown(body)
        } catch {
          rendered = null
        }
      }
      if (rendered !== null && (!Array.isArray(rendered) || rendered.length > 0)) {
        const blocks = Array.isArray(rendered) ? rendered.length : 0
        const lists = Array.isArray(rendered)
          ? rendered.filter(
              (node) => node !== null && typeof node === 'object' && (node.type === 'ul' || node.type === 'ol'),
            ).length
          : 0
        return h(
          'div',
          {
            className: 'dshbtw-a is-markdown',
            'data-dshbtw': 'answer',
            'data-rendered': 'markdown',
            'data-blocks': String(blocks),
            'data-lists': String(lists),
          },
          h('style', { key: 'style' }, CSS),
          rendered,
        )
      }
      return h(
        'div',
        {
          className: view.failed ? 'dshbtw-a is-error' : 'dshbtw-a',
          'data-dshbtw': 'answer',
          'data-rendered': 'text',
          'data-chars': String(body.length),
        },
        body,
      )
    }

    /** One side question: question, Markdown answer, copy, follow-up, sub-session. */
    function SideQuestionCard(props) {
      const t = props.strings
      const record = props.record
      const view = viewOf(record)
      const [copied, setCopied] = React.useState(false)
      const [draft, setDraft] = React.useState('')
      const [sent, setSent] = React.useState(false)

      const copy = () => {
        const text = `${t.questionPrefix}: ${view.question}\n\n${t.answerPrefix}: ${view.answer}`
        try {
          navigator.clipboard.writeText(text).then(
            () => setCopied(true),
            () => setCopied(false),
          )
        } catch {
          setCopied(false)
        }
      }

      const followUp = () => {
        const question = draft.trim()
        if (question === '' || view.childId === undefined) return
        if (typeof props.onFollowUp !== 'function') return
        const ok = props.onFollowUp(view.childId, question)
        if (ok !== false) {
          setDraft('')
          setSent(true)
          setTimeout(() => setSent(false), 3000)
        }
      }

      return h(
        'div',
        {
          className: 'dshbtw-card',
          'data-dshbtw': 'card',
          'data-command': view.commandId,
          'data-state': view.running ? 'running' : view.failed ? 'failed' : 'done',
          'data-followup': view.followUp ? 'true' : 'false',
          ...(view.childId === undefined ? {} : { 'data-child': view.childId }),
        },
        h(
          'div',
          { className: 'dshbtw-card-head' },
          h('div', { className: 'dshbtw-q' }, view.question === '' ? t.emptyQuestion : view.question),
          h(
            'span',
            { className: view.failed ? 'dshbtw-state is-error' : 'dshbtw-state' },
            view.running ? t.running : view.failed ? t.failed : t.done,
          ),
        ),
        h(AnswerBody, { key: 'a', view, strings: t }),
        view.running
          ? null
          : h(
              'div',
              { className: 'dshbtw-actions' },
              h(
                'button',
                { type: 'button', className: 'dshbtw-btn', onClick: copy },
                copied ? t.copied : t.copy,
              ),
              view.childId === undefined
                ? null
                : h(
                    'button',
                    {
                      type: 'button',
                      className: 'dshbtw-btn',
                      title: t.openChildHint,
                      onClick: () => {
                        if (typeof navigation.openChild === 'function') navigation.openChild(view.childId, props.sessionId)
                      },
                    },
                    t.openChild,
                  ),
            ),
        view.running || view.childId === undefined
          ? null
          : h(
              'div',
              { key: 'follow', className: 'dshbtw-follow' },
              h('input', {
                key: 'input',
                className: 'dshbtw-follow-input',
                'data-dshbtw': 'follow-input',
                type: 'text',
                value: draft,
                placeholder: t.followPlaceholder,
                onChange: (event) => setDraft(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    followUp()
                  }
                },
              }),
              h(
                'button',
                {
                  key: 'send',
                  type: 'button',
                  className: 'dshbtw-btn',
                  disabled: draft.trim() === '',
                  onClick: followUp,
                },
                sent ? t.followSent : t.followSend,
              ),
            ),
      )
    }

    /**
     * The right-Sidebar page body: newest side question first.
     *
     * Rendered through `sidebar.right.pane.tab` under this package's type id, so
     * the tab system owns the pane, the chip, the split and the floating form;
     * this component owns only the content.
     */
    function BtwPage(props) {
      const t = props.__btwStrings
      const records = useBtwRecords(props.useChat)
      const ordered = React.useMemo(() => [...records].reverse(), [records])
      const inputActions = props.inputActions

      /**
       * Prepare a follow-up in the composer.
       *
       * The panel deliberately does not submit: a follow-up runs the same
       * command the user could type, and submitting on their behalf would spend
       * a child-agent turn without a visible confirmation step. The draft lands
       * in the composer so Enter sends it.
       */
      const onFollowUp = React.useCallback(
        (childId, question) => {
          const line = `/btw --continue ${childId} ${question}`
          try {
            if (inputActions !== null && inputActions !== undefined && typeof inputActions.setDraft === 'function') {
              inputActions.setDraft(line)
              return true
            }
          } catch (error) {
            try {
              console.error('[dsh-btw] follow-up could not reach the composer', error)
            } catch {
              /* ignore */
            }
          }
          return false
        },
        [inputActions],
      )

      return h(
        'div',
        {
          className: 'dshbtw-page',
          role: 'region',
          'aria-label': t.badge,
          'data-dshbtw': 'page',
          'data-count': String(ordered.length),
        },
        h('style', { key: 'style' }, CSS),
        ordered.length === 0
          ? h(
              'div',
              { key: 'empty', className: 'dshbtw-empty' },
              h('div', { key: 'title', className: 'dshbtw-empty-title' }, t.emptyTitle),
              h('div', { key: 'hint', className: 'dshbtw-empty-hint' }, t.emptyHint),
            )
          : ordered.map((record) =>
              h(SideQuestionCard, {
                key: String(record.commandId ?? record.seq),
                record,
                strings: t,
                sessionId: props.sessionId,
                onFollowUp,
              }),
            ),
      )
    }

    // ------------------------------------------------------------------- set

    /** Same-origin route served by this bundle's Host half. */
    const SETTINGS_ROUTE = '/api/dsh-btw/settings'

    /** Read the plugin's editable settings from the Host. */
    async function loadSettings() {
      const response = await fetch(SETTINGS_ROUTE, { cache: 'no-store', credentials: 'same-origin' })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const value = await response.json()
      if (value === null || typeof value !== 'object' || value.ok !== true) {
        throw new Error(value?.error ?? 'settings unavailable')
      }
      return value
    }

    /** Write back the keys the user changed. */
    async function saveSettings(values) {
      const response = await fetch(SETTINGS_ROUTE, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(values),
      })
      const value = await response.json().catch(() => undefined)
      if (!response.ok || value === undefined || value.ok !== true) {
        throw new Error(value?.error ?? `HTTP ${response.status}`)
      }
      return value
    }

    /** One labelled row in the settings page. */
    function SettingRow(props) {
      return h(
        'div',
        { className: 'dshbtw-set-row' },
        h('div', { key: 'label', className: 'dshbtw-set-label' }, props.label),
        props.hint === undefined ? null : h('div', { key: 'hint', className: 'dshbtw-set-hint' }, props.hint),
        h('div', { key: 'field', className: 'dshbtw-set-field' }, props.children),
      )
    }

    /**
     * The plugin's settings page (`settings.section`).
     *
     * Writes go to the profile patch through the Host route, so a change
     * survives a restart and is visible in the plugin manager. The page reads
     * the effective values on mount instead of trusting a cached copy.
     */
    function BtwSettings(props) {
      const t = props.__btwStrings
      const [values, setValues] = React.useState(null)
      const [status, setStatus] = React.useState({ kind: 'idle', text: '' })
      const [saving, setSaving] = React.useState(false)
      const [dirty, setDirty] = React.useState(false)

      React.useEffect(() => {
        let alive = true
        loadSettings()
          .then((value) => {
            if (!alive) return
            setValues(value.values ?? {})
            setStatus(
              value.supported === false
                ? { kind: 'error', text: t.setUnsupported }
                : { kind: 'idle', text: '' },
            )
          })
          .catch((error) => {
            if (!alive) return
            setStatus({ kind: 'error', text: `${t.setLoadFailed}：${error.message}` })
          })
        return () => {
          alive = false
        }
      }, [t])

      const patch = (key, value) => {
        setValues((current) => ({ ...(current ?? {}), [key]: value }))
        setDirty(true)
      }

      const save = async () => {
        if (values === null) return
        setSaving(true)
        setStatus({ kind: 'idle', text: t.setSaving })
        try {
          await saveSettings(values)
          setDirty(false)
          setStatus({ kind: 'ok', text: t.setSaved })
        } catch (error) {
          setStatus({ kind: 'error', text: `${t.setSaveFailed}：${error.message}` })
        } finally {
          setSaving(false)
        }
      }

      if (values === null) {
        return h(
          'div',
          {
          className: 'dshbtw-set',
          role: 'region',
          'aria-label': t.settingsTitle,
          'data-dshbtw': 'settings',
        },
          h('style', { key: 'style' }, CSS),
          h('div', { className: 'dshbtw-set-status' }, status.text === '' ? t.setLoading : status.text),
        )
      }

      const numberField = (key, hint) =>
        h(SettingRow, {
          key,
          label: t[`set_${key}`] ?? key,
          hint,
        }, h('input', {
          className: 'dshbtw-set-input',
          type: 'number',
          value: values[key] ?? '',
          onChange: (event) => patch(key, event.target.value === '' ? '' : Number(event.target.value)),
        }))

      const selectField = (key, options, hint) =>
        h(
          SettingRow,
          { key, label: t[`set_${key}`] ?? key, hint },
          h(
            'select',
            {
              className: 'dshbtw-set-select',
              value: values[key] ?? '',
              onChange: (event) => patch(key, event.target.value),
            },
            options.map((option) => h('option', { key: option, value: option }, t[`opt_${option}`] ?? option)),
          ),
        )

      return h(
        'div',
        {
          className: 'dshbtw-set',
          role: 'region',
          'aria-label': t.settingsTitle,
          'data-dshbtw': 'settings',
        },
        h('style', { key: 'style' }, CSS),
        h(SettingRow, { key: 'preset', label: t.set_sideAgentPreset, hint: t.set_sideAgentPresetHint },
          h(
            'select',
            {
              className: 'dshbtw-set-select',
              value: values.sideAgentPreset ?? 'workspace-write',
              onChange: (event) => patch('sideAgentPreset', event.target.value),
            },
            ['read-only', 'workspace-write', 'danger-full-access', 'inherit'].map((option) =>
              h('option', { key: option, value: option }, t[`opt_${option}`] ?? option),
            ),
          )),
        h(SettingRow, { key: 'approval', label: t.set_approvalPolicy, hint: t.set_approvalPolicyHint },
          h(
            'select',
            {
              className: 'dshbtw-set-select',
              value: values.approvalPolicy ?? 'ask',
              onChange: (event) => patch('approvalPolicy', event.target.value),
            },
            ['ask', 'inherit'].map((option) => h('option', { key: option, value: option }, option)),
          )),
        numberField('answerMaxChars', t.set_answerMaxCharsHint),
        numberField('maxThreadTurns', t.set_maxThreadTurnsHint),
        numberField('maxThreadChars', t.set_maxThreadCharsHint),
        numberField('sideAgentTimeoutMs', t.set_sideAgentTimeoutMsHint),
        numberField('maxQuestionChars', t.set_maxQuestionCharsHint),
        h(SettingRow, { key: 'dispose', label: t.set_disposeChild, hint: t.set_disposeChildHint },
          h('label', { className: 'dshbtw-set-toggle' },
            h('input', {
              type: 'checkbox',
              checked: values.disposeChild !== false,
              onChange: (event) => patch('disposeChild', event.target.checked),
            }),
            h('span', null, values.disposeChild !== false ? t.on : t.off),
          )),
        h('button', { key: 'save', className: 'dshbtw-set-save', disabled: saving || !dirty, onClick: save },
          saving ? t.setSaving : t.setSave),
        status.text === ''
          ? null
          : h('div', {
              key: 'status',
              'data-dshbtw': 'settings-status',
              'data-kind': status.kind,
              className:
                status.kind === 'error' ? 'dshbtw-set-status is-error'
                  : status.kind === 'ok' ? 'dshbtw-set-status is-ok'
                    : 'dshbtw-set-status',
            }, status.text),
      )
    }

    // -------------------------------------------------------------- bootstrap

    /** Strings that may go into a locale dictionary (values must be plain text). */
    function stringsOnly(dict) {
      const out = {}
      for (const key of Object.keys(dict)) {
        if (typeof dict[key] === 'string') out[key] = dict[key]
      }
      return out
    }

    /** Active language id, preferring the locale service over the document. */
    function activeLanguage(ctx) {
      const locale = ctx.get('locale')
      if (locale !== null && locale !== undefined && typeof locale.getLocale === 'function') {
        try {
          const snapshot = locale.getLocale()
          // LocaleSnapshot is `{ active, locales, revision }`.
          const id = snapshot !== null && typeof snapshot === 'object' ? snapshot.active : undefined
          if (typeof id === 'string' && id !== '') return id.toLowerCase().startsWith('zh') ? 'zh' : 'en'
        } catch {
          /* fall through to the document language */
        }
      }
      return documentLanguage()
    }

    /** Resolve visible copy: the locale service when present, else `en`/`zh`. */
    function resolveStrings(ctx) {
      const base = STRINGS[activeLanguage(ctx)]
      const locale = ctx.get('locale')
      if (locale === null || locale === undefined || typeof locale.register !== 'function' || typeof locale.bind !== 'function') {
        return base
      }
      let translate
      try {
        ctx.effect(() => {
          const disposers = [
            locale.register('dsh-btw', 'zh', stringsOnly(STRINGS.zh)),
            locale.register('dsh-btw', 'en', stringsOnly(STRINGS.en)),
          ]
          return () => {
            for (const dispose of disposers) {
              try {
                dispose()
              } catch {
                /* a failed dictionary removal must not break unload */
              }
            }
          }
        }, 'dsh-btw locale')
        translate = locale.bind('dsh-btw')
      } catch {
        return base
      }
      if (typeof translate !== 'function') return base
      const merged = { ...base }
      for (const key of Object.keys(base)) {
        if (typeof base[key] !== 'string') continue
        try {
          const value = translate(key)
          if (typeof value === 'string' && value !== '') merged[key] = value
        } catch {
          /* keep the built-in copy for this key */
        }
      }
      // Pluralizing helpers stay language-specific closures.
      merged.count = base.count
      return merged
    }

    return {
      // Hard dependencies of the hand-written module: the slot seat, and the
      // right-Sidebar tab registry + navigation controller. Declaring them here
      // is what makes `ctx.get` resolve them; the transcript chip still renders
      // if the right column is absent from the composition.
      inject: ['slots', 'sidebarRightTabs', 'sidebarRight'],
      apply(ctx) {
        const strings = resolveStrings(ctx)
        const tabs = ctx.get('sidebarRightTabs')
        const right = ctx.get('sidebarRight')

        navigation.open = () => {
          try {
            if (right !== null && right !== undefined && typeof right.openTab === 'function') {
              right.openTab(KIND)
              debug.lastError = null
            } else {
              debug.lastError = 'sidebarRight.openTab unavailable'
            }
          } catch (error) {
            debug.lastError = error instanceof Error ? error.message : String(error)
            try {
              console.error('[dsh-btw] could not open the side-question page', error)
            } catch {
              /* ignore */
            }
          }
        }

        /**
         * Open one side agent's own conversation in the right Sidebar.
         *
         * This is the built-in subagent tab: it renders the child's live
         * conversation, so the side agent's tool calls and its **approval
         * prompts** appear exactly where DSH puts them. Falls back to the
         * side-question page when the address is rejected.
         */
        navigation.openChild = (childId, parentId) => {
          if (typeof childId !== 'string' || childId === '') {
            navigation.open()
            return
          }
          const address = `dsh-resource://subagentchat/session/${childId}?parent=${parentId ?? ''}&mode=continuable`
          try {
            if (right !== null && right !== undefined && typeof right.openResource === 'function') {
              right.openResource(address)
              debug.lastError = null
              return
            }
            debug.lastError = 'sidebarRight.openResource unavailable'
          } catch (error) {
            debug.lastError = error instanceof Error ? error.message : String(error)
          }
          navigation.open()
        }

        debug.tabs = tabs !== null && tabs !== undefined
        debug.right = right !== null && right !== undefined
        debug.open = navigation.open
        debug.openChild = navigation.openChild

        // The page type: a page (no resource patterns), opened by kind.
        if (tabs !== null && tabs !== undefined && typeof tabs.register === 'function') {
          ctx.effect(
            () =>
              tabs.register({
                id: TYPE_ID,
                kind: KIND,
                priority: 'extension',
                title: () => strings.typeLabel,
                guide: [
                  {
                    id: 'questions',
                    order: 20,
                    title: () => strings.guideTitle,
                    description: () => strings.guideDescription,
                    icon: BtwGlyph,
                  },
                ],
              }),
            'dsh-btw tab type',
          )

          ctx.slots.inject('sidebar.right.pane.tab', () =>
            ctx.slots.register(
              { name: 'sidebar.right.pane.tab', key: TYPE_ID },
              (props) => h(Boundary, { fallback: null }, h(BtwPage, { ...props, __btwStrings: strings })),
            ),
          )
        }

        // The transcript chip works even without the right-Sidebar registry.
        ctx.slots.inject('conversation.chat.commandview', () =>
          ctx.slots.register(
            { name: 'conversation.chat.commandview', key: 'btw' },
            (props) => h(Boundary, { fallback: null }, h(BtwChip, { ...props, __btwStrings: strings })),
          ),
        )

        // Always-present way back in: the header button reopens the page after
        // the user closes its tab.
        ctx.slots.inject('conversation.session.header.utilities', () =>
          ctx.slots.register(
            { name: 'conversation.session.header.utilities', id: 'dsh-btw-header', order: 30 },
            (props) => h(Boundary, { fallback: null }, h(BtwHeaderButton, { ...props, __btwStrings: strings })),
          ),
        )

        // The settings page: edits the same profile row the plugin patch owns.
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            { name: 'settings.section', id: 'dsh-btw-settings', order: 55, label: strings.settingsTitle },
            (props) => h(Boundary, { fallback: null }, h(BtwSettings, { ...props, __btwStrings: strings })),
          ),
        )
      },
    }
  },
})
