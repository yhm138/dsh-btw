/**
 * dsh-btw — Antigravity-style `/btw` side questions for DeepSeek Harness.
 *
 * A `/btw <question>` line asks one question "by the way" while a task is in
 * progress. It must not steer the main task, so this plugin does **not** write
 * anything the main conversation can see: the question starts one **forked
 * child agent** (seeded with the parent's completed turns, full tool set), the
 * child works in its own session, and its final answer comes back as the
 * command result. The child is disposed once it settles. The parent session
 * gains only the log-only `command/run` + `command/done` pair.
 *
 * Why a child agent instead of one bare model call: the side question is
 * allowed to *check things* — read a file, grep, run a command — using the
 * same tool pipeline, sandbox, and approval policy as the main conversation.
 * It therefore cannot answer from stale context alone, which is the whole
 * difference from a plain "ask about the transcript" feature.
 *
 * Design limits (documented in README.md):
 *  - the child is a real agent: every tool, its own turn, its own tokens;
 *  - results are delivered to this caller only (`delivery: 'caller'`), so no
 *    completion notice is injected into the parent conversation;
 *  - the child session persists (durable), the execution handle does not.
 *
 * @module dsh-btw
 */

/** Command name without the slash. */
const COMMAND_NAME = 'btw'

/** Command identity reported to clients that select first-party row faces. */
const DEFINITION_ID = '@local/dsh-btw'

/** Defaults for every tunable value; the bundle patch may override each one. */
const DEFAULTS = Object.freeze({
  maxQuestionChars: 8000,
  childProvider: 'fork',
  approvalPolicy: 'ask',
  sideAgentPreset: 'workspace-write',
  disposeChild: true,
  sideAgentTimeoutMs: 900000,
  answerMaxChars: 12000,
  maxThreadTurns: 20,
  maxThreadChars: 24000,
  streamProgress: true,
  progressTtlMs: 1800000,
})

/**
 * Machine-readable trailer that names the child session behind one answer.
 *
 * The Client half uses it to open that child's conversation in the right
 * Sidebar, which is where DSH renders the side agent's tool calls and its native
 * approval prompts. It is stripped from every rendered answer.
 */
const CHILD_MARKER = 'dsh-btw:child='

/** Matches the trailer and captures the child id. */
const CHILD_PATTERN = /\[\[dsh-btw:child=([^\]\s]+)\]\]/u

/** Route that streams one side question's live progress. */
const PROGRESS_ROUTE = '/api/dsh-btw/progress'

/** Cap on retained frames per run; the oldest are dropped past this. */
const PROGRESS_MAX_FRAMES = 4000

/** How much of a tool result is kept for the progress view. */
const PROGRESS_PREVIEW_CHARS = 240

/**
 * Live progress, keyed by `<parent session id>\0<command id>`.
 *
 * The command id is already the identity of one Chat row, so pairing it with the
 * parent session gives the Client a key it can subscribe to without learning
 * anything new. Entries outlive the run by `progressTtlMs` so reopening the panel
 * (or a page reload) still shows what the side agent did.
 */
const PROGRESS = new Map()

/** Build the buffer key for one run. */
function progressKey(parentId, commandId) {
  return `${String(parentId)}\u0000${String(commandId)}`
}

/** Get or create one run's buffer. */
function progressEntry(parentId, commandId) {
  const key = progressKey(parentId, commandId)
  let entry = PROGRESS.get(key)
  if (entry === undefined) {
    entry = { frames: [], firstId: 0, nextId: 0, done: false, touchedAt: Date.now(), listeners: new Set() }
    PROGRESS.set(key, entry)
  }
  return entry
}

/** Serialize one frame as an SSE message. */
function sseFrame(entry, frame) {
  const id = entry.nextId
  entry.nextId += 1
  entry.frames.push(frame)
  while (entry.frames.length > PROGRESS_MAX_FRAMES) {
    entry.frames.shift()
    entry.firstId += 1
  }
  return `id: ${id}\nevent: frame\ndata: ${JSON.stringify(frame)}\n\n`
}

/** Append one frame and fan it out to every open subscriber. */
function emitProgress(parentId, commandId, frame) {
  const entry = progressEntry(parentId, commandId)
  if (entry.done === true) return
  entry.touchedAt = Date.now()
  const payload = sseFrame(entry, frame)
  for (const listener of entry.listeners) {
    try {
      listener.write(payload)
    } catch {
      entry.listeners.delete(listener)
    }
  }
}

/** Close one run: record the last frame, tell subscribers, drop them. */
function finishProgress(parentId, commandId, frame) {
  const entry = progressEntry(parentId, commandId)
  if (entry.done === true) return
  entry.touchedAt = Date.now()
  const payload = sseFrame(entry, frame)
  entry.done = true
  for (const listener of entry.listeners) {
    try {
      listener.write(`${payload}event: end\ndata: {}\n\n`)
      listener.end()
    } catch {
      /* a subscriber that already left needs no closing frame */
    }
  }
  entry.listeners.clear()
}

/** Forget finished runs past their TTL, and reap runs whose process is gone. */
function pruneProgress(config, now = Date.now()) {
  for (const [key, entry] of PROGRESS) {
    if (entry.done !== true && now - entry.touchedAt > config.sideAgentTimeoutMs) {
      entry.done = true
      for (const listener of entry.listeners) {
        try {
          listener.end()
        } catch {
          /* ignore */
        }
      }
      entry.listeners.clear()
    }
    if (now - entry.touchedAt > config.progressTtlMs) PROGRESS.delete(key)
  }
}

/** Clip one string for a progress frame. */
function clipProgress(value, max) {
  const text = typeof value === 'string' ? value : ''
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** Pull a short text preview out of a tool result message. */
function toolResultPreview(message) {
  const parts = []
  const content = Array.isArray(message?.content) ? message.content : []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return clipProgress(parts.join('\n').trim(), PROGRESS_PREVIEW_CHARS)
}


/**
 * Frame one side question, optionally continuing an earlier thread.
 *
 * A follow-up is a *new* child agent told what the thread already established.
 * Reusing the child session through `sendMessage` would be cheaper, but resuming
 * a child publishes a settlement notice into the parent conversation — the one
 * thing this feature must never do — and that notice is produced by the
 * subagent manager, so no tool restriction can suppress it.
 *
 * @param question - trimmed question.
 * @param turns - earlier question/answer pairs in this thread, oldest first.
 * @returns the task text handed to the child agent.
 */
function frameThread(question, turns) {
  const history = []
  for (const turn of turns) {
    history.push(`问：${turn.q}`)
    history.push(`答：${turn.a}`)
  }
  return [
    '【侧问】这是一次不打断主线任务的侧问。',
    ...(history.length === 0 ? [] : ['', '本侧问此前已经问过（仅供你理解上下文，不要重复回答）：', ...history]),
    '',
    `问题：${question}`,
    '',
    '要求：',
    '1. 只回答这一个问题。不要继续、改写或推进主线任务；不要修改与回答问题无关的文件。',
    '2. 需要事实依据就去查：读文件、搜索、跑只读命令都可以；不要凭印象猜。',
    '3. 不要调用 send_message，也不要给父会话发任何消息或状态通知——答案直接作为本轮的回复文本返回。',
    '4. 答案要短，直接给结论和依据；不要复述上面已经说过的整段对话。',
  ].join('\n')
}

/**
 * Rebuild one thread's earlier turns from the session log.
 *
 * `/btw` and each follow-up are `command/run` + `command/done` pairs: the run
 * carries the arguments (a bare question, or `--continue <childId> <question>`),
 * the done carries the answer. A follow-up names the child that answered the
 * preceding turn, so the chain is followed backwards from the child being
 * continued. This is the durable path: it works after a plugin reload or a Host
 * restart, where the in-memory map is empty by definition.
 *
 * @param parent - the parent session whose log holds the commands.
 * @param childId - the child id the new follow-up addresses.
 * @param config - normalized options supplying the thread budget.
 * @returns the turns, oldest first.
 */
function threadFromLog(parent, childId, config) {
  const events = typeof parent.snapshotEvents === 'function' ? parent.snapshotEvents() : []
  if (events.length === 0) return []

  // Index everything the log knows: run(args) by commandId, done(text) by commandId.
  const runs = new Map()
  const dones = new Map()
  for (const event of events) {
    const data = event?.data
    if (data === null || typeof data !== 'object') continue
    if (event.type === 'command/run' && typeof data.args === 'string' && data.name === 'btw') {
      runs.set(String(data.commandId), data.args)
    } else if (event.type === 'command/done' && typeof data.text === 'string') {
      dones.set(String(data.commandId), data.text)
    }
  }

  // child id -> the command that produced it. Every turn publishes its child id in
  // its own result, including follow-ups (they start a NEW child), so the chain is
  // walked from a child back to the turn that answered it, then to the child that
  // turn continued, and so on.
  const ownerOfChild = new Map()
  for (const [commandId, text] of dones) {
    const marker = CHILD_PATTERN.exec(text)
    if (marker !== null) ownerOfChild.set(marker[1], commandId)
  }

  const turns = []
  const seen = new Set()
  let cursor = childId
  while (cursor !== undefined && turns.length < config.maxThreadTurns && !seen.has(cursor)) {
    seen.add(cursor)
    const commandId = ownerOfChild.get(cursor)
    if (commandId === undefined) break
    const args = runs.get(commandId) ?? ''
    // Strip the whole trailer, not just its prefix: the marker is
    // `[[dsh-btw:child=<id>]]` and must not appear in a carried answer.
    const answer = (dones.get(commandId) ?? '')
      .replace(/\[\[dsh-btw:child=[^\]]*\]\]/gu, '')
      .trim()
    const follow = /^\s*--continue\s+(\S+)\s+([\s\S]+)$/u.exec(args)
    const question = follow === null ? args.trim() : follow[2].trim()
    if (question !== '' || answer !== '') turns.unshift({ q: question, a: answer })
    // Walk to the turn this one continued, if it was itself a follow-up.
    cursor = follow === null ? undefined : follow[1]
  }

  return turns
}

/** In-memory side-question threads, keyed by the child id the client knows. */
const THREADS = new Map()

/** Last write time per thread, for the idle TTL. */
const THREAD_TOUCHED = new Map()

/**
 * Drop threads nobody has touched for a while, and the least recently used ones
 * beyond the retention count.
 *
 * A thread only exists to seed the next follow-up, so keeping it forever is a
 * leak: the Host outlives any single conversation. Both bounds are advisory — a
 * pruned thread only means its next follow-up starts without history.
 *
 * @param config - normalized options supplying the bounds.
 * @param now - current time, injected for tests.
 */
function pruneThreads(config, now = Date.now()) {
  for (const [key, touchedAt] of THREAD_TOUCHED) {
    if (now - touchedAt <= config.threadTtlMs) continue
    THREAD_TOUCHED.delete(key)
    THREADS.delete(key)
  }
  while (THREADS.size > config.maxThreads) {
    const oldest = THREADS.keys().next()
    if (oldest.done === true) break
    THREADS.delete(oldest.value)
    THREAD_TOUCHED.delete(oldest.value)
  }
}

/** Character cost of one remembered turn, for the thread budget. */
function turnChars(turn) {
  return (turn.q?.length ?? 0) + (turn.a?.length ?? 0)
}

/**
 * Record one settled turn and return the thread's turns within budget.
 *
 * The cap is on **characters**, not turns: a thread of eight one-line exchanges
 * is cheap while three long ones can already dominate a prompt, and a fixed turn
 * count cannot tell those apart. The newest turns are always kept, oldest are
 * dropped first, and a single oversized turn is still kept (truncated) so a
 * follow-up never loses the answer it is following up on.
 *
 * @param key - the thread's child id.
 * @param question - the question that was just answered.
 * @param answer - its answer.
 * @param config - normalized options supplying the budgets.
 * @returns the turns to prepend to the next follow-up, oldest first.
 */
function rememberTurn(key, question, answer, config) {
  const turns = THREADS.get(key) ?? []
  turns.push({ q: question, a: answer })
  while (turns.length > config.maxThreadTurns) turns.shift()

  let used = 0
  const kept = []
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index]
    const cost = turnChars(turn)
    if (kept.length > 0 && used + cost > config.maxThreadChars) break
    if (kept.length === 0 && cost > config.maxThreadChars) {
      // Never drop the newest turn entirely: clip it instead.
      const room = Math.max(200, Math.floor(config.maxThreadChars / 2))
      kept.unshift({
        q: turn.q.length > room ? `${turn.q.slice(0, room)}…` : turn.q,
        a: turn.a.length > room ? `${turn.a.slice(0, room)}…` : turn.a,
      })
      used += room * 2
      continue
    }
    kept.unshift(turn)
    used += cost
  }

  // Re-inserting moves the key to the end of Map's iteration order, which is
  // what makes "front of the map" mean "least recently used".
  THREADS.delete(key)
  THREADS.set(key, turns)
  THREAD_TOUCHED.set(key, Date.now())
  pruneThreads(config)
  return kept
}


/**
 * Normalize the raw bundle config into the options this plugin understands.
 *
 * A plain Host bundle cannot import the Loader's schema package, so values are
 * read defensively instead of being validated by a `Config` export.
 *
 * @param raw - untrusted row config.
 * @returns normalized options.
 */
function normalizeConfig(raw) {
  const input = raw !== null && typeof raw === 'object' ? raw : {}
  const number = (value, fallback, min, max) =>
    typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : fallback
  const text = (value, fallback) => (typeof value === 'string' && value !== '' ? value : fallback)
  return {
    maxQuestionChars: number(input.maxQuestionChars, DEFAULTS.maxQuestionChars, 1, 100000),
    childProvider: text(input.childProvider, DEFAULTS.childProvider),
    approvalPolicy: input.approvalPolicy === 'inherit' ? 'inherit' : DEFAULTS.approvalPolicy,
    sideAgentPreset: text(input.sideAgentPreset, DEFAULTS.sideAgentPreset),
    disposeChild: typeof input.disposeChild === 'boolean' ? input.disposeChild : DEFAULTS.disposeChild,
    sideAgentTimeoutMs: number(input.sideAgentTimeoutMs, DEFAULTS.sideAgentTimeoutMs, 30000, 7200000),
    answerMaxChars: number(input.answerMaxChars, DEFAULTS.answerMaxChars, 200, 200000),
    maxThreadTurns: number(input.maxThreadTurns, DEFAULTS.maxThreadTurns, 1, 200),
    maxThreadChars: number(input.maxThreadChars, DEFAULTS.maxThreadChars, 0, 2000000),
    streamProgress: typeof input.streamProgress === 'boolean' ? input.streamProgress : DEFAULTS.streamProgress,
    progressTtlMs: number(input.progressTtlMs, DEFAULTS.progressTtlMs, 60000, 86400000),
    maxThreads: number(input.maxThreads, DEFAULTS.maxThreads, 1, 4096),
    threadTtlMs: number(input.threadTtlMs, DEFAULTS.threadTtlMs, 60000, 604800000),
    provider: typeof input.provider === 'string' ? input.provider : '',
    model: typeof input.model === 'string' ? input.model : '',
  }
}

/** Concatenate the text blocks of a child's final answer. */
function answerText(output) {
  if (!Array.isArray(output)) return ''
  const parts = []
  for (const block of output) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  return parts.join('\n').trim()
}

/** Trim one answer to the configured ceiling without cutting a word in half. */
function clip(text, maxChars) {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}\n\n…（答案过长，已截断到 ${maxChars} 字符）`
}

/** Human sentence for one failed child run. */
function failureText(result) {
  const diagnostic = result !== null && typeof result === 'object' && typeof result.diagnostic === 'string' ? result.diagnostic : ''
  const stop = result !== null && typeof result === 'object' && typeof result.stopReason === 'string' ? result.stopReason : 'error'
  if (diagnostic !== '') return `侧问失败（${stop}）：${diagnostic}`
  return `侧问失败（${stop}）：子 agent 没有产出答案。`
}

/**
 * Run one side question as a disposable forked child agent.
 *
 * The child is seeded from the parent's completed turns, inherits the parent's
 * preset (therefore the same tool set), and reports only to this caller. When
 * the configured approval policy is `ask`, write tools pause for the same
 * approval flow the main conversation uses instead of running unattended.
 *
 * @param ctx - Host plugin context.
 * @param invocation - the settled command invocation.
 * @param question - trimmed question.
 * @param config - normalized options.
 * @returns `{ text, childId }` on success.
 */

/**
 * Publish one side agent's live progress while it works.
 *
 * Returns a disposer. Every emit is best-effort: a subscriber that went away or a
 * frame the Client cannot parse must never break the run that is producing the
 * actual answer.
 *
 * @param ctx - Host plugin context.
 * @param parentId - the parent session id (part of the buffer key).
 * @param commandId - the Chat row's command id (the other half of the key).
 * @param childId - the child agent whose frames to follow.
 * @param config - normalized options.
 * @returns a disposer that detaches both listeners.
 */
function trackProgress(ctx, parentId, commandId, childId, config) {
  const emit = (frame) => {
    try {
      emitProgress(parentId, commandId, frame)
    } catch {
      /* progress is advisory; the run itself must not fail on it */
    }
  }
  if (config.streamProgress !== true) {
    emit({ type: 'status', phase: 'started' })
    return () => {}
  }

  const agents = ctx.get('agents')
  const child = agents !== null && agents !== undefined && typeof agents.get === 'function'
    ? agents.get(childId)
    : undefined
  if (child === undefined || child === null) return () => {}

  emit({ type: 'status', phase: 'started' })

  /** One tool call still streaming its arguments, by stream block index. */
  const openToolCalls = new Map()
  /** Tool call id -> name, so a result can name the tool that produced it. */
  const toolNames = new Map()

  const onStream = (payload) => {
    const frame = payload !== null && typeof payload === 'object' ? payload.frame : undefined
    if (frame === null || frame === undefined || frame.type !== 'chunk') return
    const chunk = frame.chunk
    if (chunk === null || typeof chunk !== 'object') return
    try {
      if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string' && chunk.text !== '') {
        emit({ type: 'reasoning', text: chunk.text })
        return
      }
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text !== '') {
        emit({ type: 'text', text: chunk.text })
        return
      }
      if (chunk.type === 'tool-call-delta') {
        const index = Number.isFinite(chunk.index) ? chunk.index : 0
        const open = openToolCalls.get(index) ?? { name: '', arguments: '', announced: false }
        if (typeof chunk.name === 'string' && chunk.name !== '') open.name = chunk.name
        if (typeof chunk.argumentsDelta === 'string') open.arguments += chunk.argumentsDelta
        openToolCalls.set(index, open)
        if (open.announced === false && open.name !== '') {
          open.announced = true
          if (chunk.id !== undefined) toolNames.set(String(chunk.id), open.name)
          emit({ type: 'tool-start', name: open.name, id: chunk.id === undefined ? undefined : String(chunk.id) })
        }
        return
      }
      if (chunk.type === 'block-end') {
        const block = chunk.block
        if (block !== null && typeof block === 'object' && block.type === 'tool-call') {
          const index = Number.isFinite(chunk.index) ? chunk.index : 0
          const open = openToolCalls.get(index) ?? { name: '', arguments: '', announced: false }
          const name = typeof block.name === 'string' && block.name !== '' ? block.name : open.name
          if (block.id !== undefined) toolNames.set(String(block.id), name)
          emit({
            type: 'tool-call',
            id: block.id === undefined ? undefined : String(block.id),
            name,
            arguments: clipProgress(typeof block.arguments === 'string' ? block.arguments : open.arguments, 400),
          })
          openToolCalls.delete(index)
        }
        return
      }
      if (chunk.type === 'finish') {
        emit({ type: 'status', phase: 'settling' })
      }
    } catch {
      /* a malformed chunk must not break the stream */
    }
  }

  const onSessionEvent = (session, event) => {
    try {
      if (session === null || session === undefined || String(session.id) !== String(childId)) return
      if (event.type === 'tool/result') {
        const data = event.data
        const callId = data?.message?.toolCallId
        const name = callId === undefined ? undefined : toolNames.get(String(callId))
        emit({
          type: 'tool-result',
          id: callId === undefined ? undefined : String(callId),
          name,
          isError: data?.error !== undefined || data?.message?.isError === true,
          preview: toolResultPreview(data?.message),
        })
      }
    } catch {
      /* ignore */
    }
  }

  const disposers = []
  try {
    if (typeof child.ctx?.on === 'function') {
      disposers.push(child.ctx.on('agent/assistant-stream', onStream))
      disposers.push(child.ctx.on('session/event', onSessionEvent))
    }
  } catch {
    /* a stale child cannot be followed; the command result still arrives */
  }

  return () => {
    for (const dispose of disposers) {
      try {
        if (typeof dispose === 'function') dispose()
      } catch {
        /* ignore */
      }
    }
  }
}

async function runSideAgent(ctx, invocation, question, config, threadKey) {
  const agents = ctx.get('agents')
  const subagents = ctx.get('subagents')
  if (subagents === null || subagents === undefined || typeof subagents.startActivation !== 'function') {
    throw new Error('当前 profile 没有 subagent 服务，/btw 无法运行子 agent。')
  }
  const parent = agents !== null && agents !== undefined && typeof agents.get === 'function'
    ? agents.get(invocation.agent.id)
    : undefined
  if (parent === undefined) throw new Error('当前会话不是本进程的活会话，/btw 无法继承上下文。')

  if (threadKey !== undefined) pruneThreads(config)
  let turns = threadKey === undefined ? [] : THREADS.get(threadKey) ?? []
  if (threadKey !== undefined && turns.length === 0) {
    // A reload or a Host restart empties the map, so fall back to the session
    // log, which still holds every earlier turn of this thread.
    turns = threadFromLog(parent.session, threadKey, config)
    if (turns.length > 0) {
      THREADS.set(threadKey, turns)
      THREAD_TOUCHED.set(threadKey, Date.now())
    }
  }

  const agentOptions = {}
  if (config.provider !== '' && config.model !== '') {
    agentOptions.provider = config.provider
    agentOptions.model = config.model
  }

  // One cancellation owning both the caller's signal and this plugin's ceiling:
  // a child whose approval never gets answered must not keep the command open
  // forever.
  const controller = new AbortController()
  const forwardAbort = () => controller.abort()
  const callerSignal = invocation.signal
  if (callerSignal !== undefined && callerSignal !== null) {
    if (callerSignal.aborted === true) controller.abort()
    else if (typeof callerSignal.addEventListener === 'function') callerSignal.addEventListener('abort', forwardAbort, { once: true })
  }
  const timer = setTimeout(() => controller.abort(), config.sideAgentTimeoutMs)

  let activation
  try {
    activation = await subagents.startActivation({
      provider: config.childProvider,
      label: `侧问：${question.slice(0, 48)}`,
      request: {
        prompt: [{ type: 'text', text: frameThread(question, turns) }],
        parent,
        ...(Object.keys(agentOptions).length === 0 ? {} : { agentOptions }),
      },
      signal: controller.signal,
      delivery: 'caller',
    })
  } catch (error) {
    clearTimeout(timer)
    if (callerSignal !== undefined && callerSignal !== null && typeof callerSignal.removeEventListener === 'function') {
      callerSignal.removeEventListener('abort', forwardAbort)
    }
    throw error
  }

  /**
   * The child inherits the parent's tool set, `send_message` included, and the
   * inherited fork guidance tells it to report back with that tool. For a side
   * question that would inject a status row into the main conversation — the
   * one thing this feature exists to avoid — so the tool is removed from this
   * child's scope before its first step.
   */
  restrictReportingTools(ctx, activation)

  // Follow this child's frames so the panel can show work in progress. The
  // recorded answer still arrives through the command result below.
  const stopTracking = trackProgress(
    ctx,
    invocation.agent.id,
    invocation.commandId,
    activation.childId,
    config,
  )

  try {
    // Apply the side agent's permission bundle before its first tool call can
    // settle. `read-only` / `workspace-write` carry approval: 'ask', which is
    // what turns a write into a permission request instead of a silent write.
    if (config.sideAgentPreset !== 'inherit') {
      const presets = ctx.get('permissionPresets')
      const sessions = ctx.get('sessions')
      const childSession = sessions !== null && sessions !== undefined && typeof sessions.get === 'function'
        ? sessions.get(activation.childId)
        : undefined
      if (presets !== null && presets !== undefined && typeof presets.set === 'function' && childSession !== undefined) {
        try {
          presets.set(childSession, config.sideAgentPreset)
        } catch {
          /* unknown preset or a child that already settled */
        }
      }
    }

    // Write tools ask, like the main conversation under an ask policy. The
    // child starts on activation, so this runs immediately after creation —
    // before its first tool call can settle.
    if (config.approvalPolicy === 'ask') {
      const approval = ctx.get('approval')
      const child = agents !== null && agents !== undefined && typeof agents.get === 'function'
        ? agents.get(activation.childId)
        : undefined
      if (approval !== null && approval !== undefined && typeof approval.setPolicy === 'function' && child !== undefined) {
        try {
          approval.setPolicy(child, 'ask')
        } catch {
          /* a child that already settled needs no policy */
        }
      }
    }

    const result = await activation.result
    if (result === null || typeof result !== 'object') throw new Error('子 agent 没有返回结果。')
    if (result.stopReason !== 'completed') throw new Error(failureText(result))
    const text = answerText(result.output)
    if (text === '') throw new Error('子 agent 没有产出正文。')
    const childId = String(activation.childId)
    // The client addresses the *new* child next time, so the thread is recorded
    // under this child's id; the previous id is migrated over so a chain of
    // follow-ups keeps one continuous history instead of restarting each time.
    const key = threadKey ?? childId
    if (threadKey !== undefined && threadKey !== childId) {
      THREADS.delete(threadKey)
      THREAD_TOUCHED.delete(threadKey)
    }
    rememberTurn(key, question, text, config)
    finishProgress(invocation.agent.id, invocation.commandId, { type: 'done', childId })
    return { text: clip(text, config.answerMaxChars), childId, threadKey: key }
  } finally {
    stopTracking()
    // A run that failed before its success path never settled the buffer; close
    // it so subscribers are not left holding an open stream.
    finishProgress(invocation.agent.id, invocation.commandId, { type: 'done', childId: undefined })
    clearTimeout(timer)
    if (callerSignal !== undefined && callerSignal !== null && typeof callerSignal.removeEventListener === 'function') {
      callerSignal.removeEventListener('abort', forwardAbort)
    }
    if (config.disposeChild) {
      try {
        await activation.dispose()
      } catch {
        /* the answer already exists; a failed release must not hide it */
      }
    }
  }
}

/**
 * Remove the reporting tools from one side agent's scope.
 *
 * `ctx.tools.restrict()` is the weakest tool mechanism the Harness offers: it can
 * only remove tools, it is scoped to one agent's context, and it keeps schema
 * presentation, lookup, and execution aligned. Removing `send_message` (and the
 * team tool that would page another agent) is what keeps a side answer from
 * arriving in the main conversation as a notice.
 *
 * @param ctx - Host plugin context.
 * @param activation - the freshly started side activation.
 */
function restrictReportingTools(ctx, activation) {
  const agents = ctx.get('agents')
  const child = agents !== null && agents !== undefined && typeof agents.get === 'function'
    ? agents.get(activation.childId)
    : undefined
  if (child === undefined || child === null || typeof child !== 'object') return
  const tools = toolsOf(child)
  if (tools === undefined || typeof tools.restrict !== 'function') return
  try {
    // `restrict` takes `{ allow?, deny? }` — a predicate is rejected, and an
    // empty filter is a no-op — and returns the effect disposer, which stays
    // owned by the child's own context lifetime.
    tools.restrict({ deny: ['send_message', 'spawn_teammate', 'wait_agent', 'list_agents', 'interrupt_agent'] })
  } catch {
    /* a child that already started keeps the prompt-level instruction instead */
  }
}

/**
 * Resolve the tool registry visible to one agent.
 *
 * A Cordis context hands out traceable proxies on access, so the registry is
 * read through the agent's own context rather than assumed to hang off a fixed
 * property name.
 *
 * @param child - the live child agent.
 * @returns the tool registry, or undefined when this build exposes none.
 */
function toolsOf(child) {
  const candidate = child.ctx
  if (candidate === null || candidate === undefined || typeof candidate !== 'object') return undefined
  if (typeof candidate.get === 'function') {
    const tools = candidate.get('tools')
    if (tools !== null && tools !== undefined) return tools
  }
  if (typeof candidate.tools === 'object' && candidate.tools !== null) return candidate.tools
  return undefined
}

/** Route that serves this plugin's own settings to its settings page. */
const SETTINGS_ROUTE = '/api/dsh-btw/settings'

/** The config keys the settings page may read and write. */
const EDITABLE_KEYS = Object.freeze([
  'maxQuestionChars',
  'childProvider',
  'approvalPolicy',
  'sideAgentPreset',
  'disposeChild',
  'sideAgentTimeoutMs',
  'answerMaxChars',
  'maxThreadTurns',
  'maxThreadChars',
  'streamProgress',
  'progressTtlMs',
  'provider',
  'model',
])

/** Coerce one submitted value to the type its config key expects. */
function coerce(key, value) {
  if (key === 'disposeChild') return value === true || value === 'true'
  if (key === 'streamProgress') return value === true || value === 'true'
  if (
    key === 'maxQuestionChars'
    || key === 'sideAgentTimeoutMs'
    || key === 'answerMaxChars'
    || key === 'maxThreadTurns'
    || key === 'maxThreadChars'
    || key === 'progressTtlMs'
  ) {
    const number = Number(value)
    return Number.isFinite(number) ? number : undefined
  }
  return typeof value === 'string' ? value : undefined
}


/**
 * Serve one side question's live progress over Server-Sent Events.
 *
 * The route is registered on the raw web server, which sits **before** DSH's
 * `/api` authentication fence, so the handler asks `ctx.connection` for the same
 * admission check the built-in routes get. Without it any web page could read a
 * session's side-question activity.
 *
 * `Last-Event-ID` replays from the buffer, which is what makes a page reload in
 * the middle of a run show the frames that already happened.
 *
 * @param ctx - Host plugin context.
 * @param config - normalized options.
 * @returns a disposer, or undefined when the Host has no web server.
 */
function mountProgressRoute(ctx, config) {
  const webServer = ctx.get('webServer')
  if (webServer === null || webServer === undefined || typeof webServer.register !== 'function') return undefined

  const handler = (req, res) => {
    const connection = ctx.get('connection')
    if (connection === null || connection === undefined || typeof connection.requestRejection !== 'function') {
      res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('connection service unavailable')
      return
    }
    let rejection
    try {
      rejection = connection.requestRejection({ headers: req.headers })
    } catch {
      rejection = 403
    }
    if (rejection !== undefined) {
      res.writeHead(rejection, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
      return
    }

    let url
    try {
      url = new URL(req.url ?? '/', 'http://dsh.invalid')
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('bad request')
      return
    }
    const parentId = url.searchParams.get('parent')
    const commandId = url.searchParams.get('command')
    if (parentId === null || parentId === '' || commandId === null || commandId === '') {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, error: 'parent and command are required' }))
      return
    }

    pruneProgress(config)

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })

    const entry = progressEntry(parentId, commandId)

    // Replay whatever the buffer already holds, then either close (run already
    // finished) or stay attached for the live frames.
    const lastEventId = Number(req.headers['last-event-id'])
    const from = Number.isFinite(lastEventId) && lastEventId >= 0 ? Math.max(0, Math.trunc(lastEventId) + 1) : entry.firstId
    for (let index = from; index < entry.nextId; index += 1) {
      const frame = entry.frames[index - entry.firstId]
      if (frame === undefined) continue
      res.write(`id: ${index}\nevent: frame\ndata: ${JSON.stringify(frame)}\n\n`)
    }

    if (entry.done === true) {
      res.write('event: end\ndata: {}\n\n')
      res.end()
      return
    }

    entry.touchedAt = Date.now()
    entry.listeners.add(res)

    /** Detach this subscriber; the run itself keeps going. */
    const detach = () => {
      entry.listeners.delete(res)
    }
    req.on('close', detach)
    req.on('aborted', detach)
    res.on('close', detach)
    res.on('error', detach)

    // Comment frames keep proxies and the browser from timing the stream out.
    const heartbeat = setInterval(() => {
      try {
        res.write(': keep-alive\n\n')
      } catch {
        clearInterval(heartbeat)
        detach()
      }
    }, 15000)
    if (typeof heartbeat.unref === 'function') heartbeat.unref()
    res.on('close', () => clearInterval(heartbeat))
  }

  return webServer.register({ kind: 'exact', path: PROGRESS_ROUTE, handler })
}

/**
 * Serve this plugin's editable settings over one same-origin route.
 *
 * A route registered on the raw web server sits *before* the `/api` fence, so
 * nothing authenticates it unless the handler asks. `ctx.connection
 * .requestRejection()` is that ask: it applies the Host/Origin checks and the
 * signed browser cookie exactly as the built-in routes get them, so a page from
 * another origin (or a browser that never logged in) is refused here. Without
 * this call any web page could rewrite the plugin's config.
 *
 * Reads report the effective config; writes go through `configEditor.edit`,
 * which persists to the profile patch and reconciles the Loader — the same path
 * the plugin manager uses.
 *
 * @param ctx - Host plugin context.
 * @param config - normalized options.
 * @returns a disposer, or undefined when the Host has no web server.
 */
function mountSettingsRoute(ctx, config) {
  const webServer = ctx.get('webServer')
  if (webServer === null || webServer === undefined || typeof webServer.register !== 'function') return undefined

  const readBody = (req) =>
    new Promise((resolve, reject) => {
      const chunks = []
      let size = 0
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > 64 * 1024) {
          reject(new Error('body too large'))
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', reject)
    })

  const reply = (res, status, value) => {
    const body = JSON.stringify(value)
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(body)
  }

  const currentConfig = () => {
    const editor = ctx.get('configEditor')
    if (editor === null || editor === undefined || typeof editor.configuration !== 'function') return undefined
    const rows = editor.configuration()
    const row = rows.find((item) => item.entry?.id === 'dsh-btw' || item.entry?.options?.id === 'dsh-btw')
    if (row === undefined) return undefined
    return { row, merged: { ...row.inherited, ...row.override } }
  }

  /** Refuse anything the Host would refuse, then serve. */
  const admit = (req, res) => {
    const connection = ctx.get('connection')
    if (connection === null || connection === undefined || typeof connection.requestRejection !== 'function') {
      // No connection service means no way to tell a real browser from a random
      // page; refusing is the only safe answer.
      reply(res, 503, { ok: false, error: 'connection service unavailable' })
      return false
    }
    let rejection
    try {
      rejection = connection.requestRejection({ headers: req.headers })
    } catch {
      rejection = 403
    }
    if (rejection === undefined) return true
    reply(res, rejection, { ok: false, error: rejection === 401 ? 'unauthorized' : 'forbidden' })
    return false
  }

  const handler = async (req, res) => {
    try {
      if (!admit(req, res)) return
      if (req.method === 'GET') {
        const found = currentConfig()
        const values = {}
        const merged = found === undefined ? { ...config } : found.merged
        for (const key of EDITABLE_KEYS) values[key] = merged[key] ?? config[key]
        reply(res, 200, { ok: true, values, editable: EDITABLE_KEYS, supported: found !== undefined })
        return
      }
      if (req.method === 'POST') {
        const raw = await readBody(req)
        let parsed
        try {
          parsed = JSON.parse(raw)
        } catch {
          reply(res, 400, { ok: false, error: 'invalid JSON' })
          return
        }
        const editor = ctx.get('configEditor')
        if (editor === null || editor === undefined || typeof editor.edit !== 'function') {
          reply(res, 503, { ok: false, error: 'configEditor unavailable in this profile' })
          return
        }
        const found = currentConfig()
        if (found === undefined) {
          reply(res, 409, { ok: false, error: 'plugin row not found in the profile patch' })
          return
        }
        const next = { ...found.merged }
        for (const key of EDITABLE_KEYS) {
          if (!(key in (parsed ?? {}))) continue
          const value = coerce(key, parsed[key])
          if (value !== undefined) next[key] = value
        }
        try {
          await editor.edit(found.row.entry, () => next)
        } catch (error) {
          reply(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
          return
        }
        reply(res, 200, { ok: true, values: next })
        return
      }
      reply(res, 405, { ok: false, error: 'method not allowed' })
    } catch (error) {
      try {
        reply(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
      } catch {
        /* the response may already be gone */
      }
    }
  }

  return webServer.register({ kind: 'exact', path: SETTINGS_ROUTE, handler })
}

/**
 * Register `/btw` for every composed human-command adapter.
 *
 * The handler settles the whole child run before returning, so the answer
 * arrives as the command result in the same lifecycle record that the Chat
 * layer already renders. Only one side question per parent session may run at
 * a time: a second one is refused rather than queued behind the first.
 *
 * @param ctx - Host plugin context.
 * @param rawConfig - raw bundle config from the Loader row.
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  /**
   * Side questions that are still settling, keyed by parent session.
   *
   * The entry records when it was taken. A child whose turn never settles (an
   * approval nobody answered, a provider that stalls) would otherwise block the
   * session forever, so an entry older than the configured timeout is treated as
   * stale and replaced instead of refusing the new question.
   */
  const inFlight = new Map()

  /** Whether a fresh side question may start for this parent. */
  const busy = (parentId) => {
    const since = inFlight.get(parentId)
    if (since === undefined) return false
    if (Date.now() - since < config.sideAgentTimeoutMs) return true
    inFlight.delete(parentId)
    return false
  }

  const handler = async (invocation) => {
    const raw = typeof invocation.rawInput === 'string' ? invocation.rawInput.trim() : ''

    // `/btw --continue <childId> <question>` continues an existing side
    // conversation. The Client builds this form from the panel's follow-up box.
    // `rawInput` arrives with the leading whitespace the user typed preserved,
    // so the marker is matched after trimming.
    const followUp = /^--continue\s+(\S+)\s+([\s\S]+)$/u.exec(raw)
    if (followUp !== null) {
      const childId = followUp[1]
      const question = followUp[2].trim()
      if (question === '') return { kind: 'error', text: '追问内容为空。' }
      const parentId = invocation.agent.id
      if (busy(parentId)) {
        return { kind: 'error', text: '上一个侧问还在跑，等它结束再问。' }
      }
      inFlight.set(parentId, Date.now())
      try {
        // A follow-up is a fresh child seeded with this thread's earlier turns:
        // resuming the old child would notify the parent conversation.
        const result = await runSideAgent(ctx, invocation, question, config, childId)
        return { kind: 'success', text: `${result.text}\n\n[[${CHILD_MARKER}${result.childId}]]` }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { kind: 'error', text: message }
      } finally {
        inFlight.delete(parentId)
      }
    }

    const question = raw
    if (question === '') {
      return {
        kind: 'success',
        text: '用法：/btw <问题>\n侧问会起一个继承当前上下文的临时子 agent（可用工具、写操作需审批），答案不进主干上下文。',
      }
    }
    if (question.length > config.maxQuestionChars) {
      return { kind: 'error', text: `问题过长（${question.length} 字符，上限 ${config.maxQuestionChars}）。` }
    }
    const sessionId = invocation.agent.id
    if (busy(sessionId)) {
      return { kind: 'error', text: '上一个侧问还在跑，等它结束再问。' }
    }
    inFlight.set(sessionId, Date.now())
    try {
      const result = await runSideAgent(ctx, invocation, question, config)
      // The trailer names the child session so the Client can open that
      // conversation (tool calls and native approval prompts) in the Sidebar.
      return { kind: 'success', text: `${result.text}\n\n[[${CHILD_MARKER}${result.childId}]]` }
    } catch (error) {
      if (invocation.signal !== undefined && invocation.signal !== null && invocation.signal.aborted === true) {
        return { kind: 'error', text: '侧问已取消。' }
      }
      const message = error instanceof Error ? error.message : String(error)
      return { kind: 'error', text: message }
    } finally {
      inFlight.delete(sessionId)
    }
  }

  ctx.effect(function* registerCommand() {
    yield () => {
      inFlight.clear()
      THREADS.clear()
      THREAD_TOUCHED.clear()
    }
    yield ctx.commands.register({
      definitionId: DEFINITION_ID,
      name: COMMAND_NAME,
      description: '侧问：起一个继承上下文、能用工具的临时子 agent，答案不进主干上下文',
      input: { hint: '<问题>' },
      handler,
    })
  }, 'dsh-btw command')

  ctx.effect(() => {
    const dispose = mountSettingsRoute(ctx, config)
    return () => {
      if (typeof dispose === 'function') dispose()
    }
  }, 'dsh-btw settings route')



  ctx.effect(() => {
    const dispose = mountProgressRoute(ctx, config)
    return () => {
      if (typeof dispose === 'function') dispose()
      PROGRESS.clear()
    }
  }, 'dsh-btw progress route')
}

export const inject = ['commands']
