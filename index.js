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
  sideAgentPreset: 'read-only',
  disposeChild: true,
  sideAgentTimeoutMs: 180000,
  answerMaxChars: 12000,
})

/**
 * Machine-readable trailer that names the child session behind one answer.
 *
 * The Client half uses it to open that child's conversation in the right
 * Sidebar, which is where DSH renders the side agent's tool calls and its native
 * approval prompts. It is stripped from every rendered answer.
 */
const CHILD_MARKER = 'dsh-btw:child='

/**
 * Wrap one raw question into the child's task text.
 *
 * The child inherits the parent conversation as its seed, so this prompt only
 * has to state the side-question contract: answer this one thing, do not take
 * over the main task, and prefer checking the workspace over guessing.
 *
 * @param question - trimmed user question.
 * @returns the task text handed to the child agent.
 */
function frameQuestion(question) {
  return [
    '【侧问】这是一次不打断主线任务的侧问。',
    '',
    `问题：${question}`,
    '',
    '要求：',
    '1. 只回答这一个问题。不要继续、改写或推进主线任务；不要修改与回答问题无关的文件。',
    '2. 需要事实依据就去查：读文件、搜索、跑只读命令都可以；不要凭印象猜。',
    '3. 如果确实需要写操作（改文件、执行有副作用的命令），先说明你要做什么；需要审批时等待审批。',
    '4. 答案要短，直接给结论和依据；不要复述上面已经说过的整段对话。',
  ].join('\n')
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
    sideAgentTimeoutMs: number(input.sideAgentTimeoutMs, DEFAULTS.sideAgentTimeoutMs, 5000, 3600000),
    answerMaxChars: number(input.answerMaxChars, DEFAULTS.answerMaxChars, 200, 200000),
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
async function runSideAgent(ctx, invocation, question, config) {
  const agents = ctx.get('agents')
  const subagents = ctx.get('subagents')
  if (subagents === null || subagents === undefined || typeof subagents.startActivation !== 'function') {
    throw new Error('当前 profile 没有 subagent 服务，/btw 无法运行子 agent。')
  }
  const parent = agents !== null && agents !== undefined && typeof agents.get === 'function'
    ? agents.get(invocation.agent.id)
    : undefined
  if (parent === undefined) throw new Error('当前会话不是本进程的活会话，/btw 无法继承上下文。')

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
        prompt: [{ type: 'text', text: frameQuestion(question) }],
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
    return { text: clip(text, config.answerMaxChars), childId: String(activation.childId) }
  } finally {
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
  const inFlight = new Map()

  const handler = async (invocation) => {
    const question = typeof invocation.rawInput === 'string' ? invocation.rawInput.trim() : ''
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
    if (inFlight.has(sessionId)) {
      return { kind: 'error', text: '上一个侧问还在跑，等它结束再问。' }
    }
    inFlight.set(sessionId, invocation.commandId)
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
    }
    yield ctx.commands.register({
      definitionId: DEFINITION_ID,
      name: COMMAND_NAME,
      description: '侧问：起一个继承上下文、能用工具的临时子 agent，答案不进主干上下文',
      input: { hint: '<问题>' },
      handler,
    })
  }, 'dsh-btw command')
}

export const inject = ['commands']
