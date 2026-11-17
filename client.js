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
      return {
        commandId: String(record.commandId ?? ''),
        question: typeof record.args === 'string' ? record.args.trim() : '',
        answer: raw.replace(CHILD_MARKER, '').replace(/\s+$/u, ''),
        childId: match === null ? undefined : match[1],
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

    // ------------------------------------------------------------------ page

    /** One side question: question, answer, and its copy / sub-session actions. */
    function SideQuestionCard(props) {
      const t = props.strings
      const record = props.record
      const view = viewOf(record)
      const [copied, setCopied] = React.useState(false)

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

      return h(
        'div',
        { className: 'dshbtw-card' },
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
        h(
          'div',
          { className: view.running ? 'dshbtw-a is-running' : view.failed ? 'dshbtw-a is-error' : 'dshbtw-a' },
          view.running ? t.running : view.answer,
        ),
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

      return h(
        'div',
        { className: 'dshbtw-page', role: 'region', 'aria-label': t.badge },
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
              }),
            ),
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
      },
    }
  },
})
