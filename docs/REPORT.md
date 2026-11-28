# dsh-btw 验收报告

记录本插件「已验证」与「未验证」的边界。证据分两类：Host 探针（真实命令注册表 + 真实会话）和独立浏览器客户端（带 token 的 Web GUI，与用户桌面窗口隔离）。

## 1. Host：上下文继承 + 零污染（已验证）

探针插件 `plugins/dsh-btw-probe`（验收后已卸载）在 Host 进程内调用 `ctx.commands.execute(agent, '/btw …', [], signal)`，并在调用前后对 `session.deriveMessages()` 取快照。

隔离会话 `session-a7ea4abf…`（先只告诉它口令「<marker-a>」）：

| 断言 | 结果 |
|---|---|
| `/btw 我刚才让你记住的口令是什么？` | `success`，答案 `<marker-a>`，2239ms |
| `deriveMessages()` 摘要 | 前后一致：`9f9b1d47:44575`，7 条消息 |
| 追加事件 | 只有 `command/run`、`command/done`，`hasSurfaceOp: false` |
| 裸 `/btw` | `success`，返回用法，1ms |

长会话（257 条消息）+ 主轮次运行中（`session-65a5d5fe…`，即本次开发会话）：

| 断言 | 结果 |
|---|---|
| 首次实现 | `error`：`DeepSeek Messages tool calls need immediate results（INVALID_REQUEST）`，42ms |
| 加 `trimOpenTail()` 后 | `success`，7075ms，`contextUnchanged: true`，答案正确描述本插件 |
| 计费 | `deepseek-account/deepseek-flash · 161834 tokens`（长会话的全量上下文，已知代价） |

一次失败的侧问也验证了边界：让它回答「我刚才是怎么关闭这个面板的」时，模型答「对话里没有你关闭该面板的记录」——UI 动作确实不在上下文里。

## 2. Client：右侧页签（已验证，独立浏览器）

用探针写出的 `http://127.0.0.1:58473/?token=…` 在 headless Chrome（locale=zh-CN）里驱动，与用户桌面窗口互不影响：

| 断言 | 结果 |
|---|---|
| `sidebar.right.pane.tab` 占用者 | `dsh-btw/side-questions`，`active: true` |
| `conversation.chat.commandview` key `btw` | 已注册，对话流渲染为单行 chip |
| 新建会话后首次 `/btw` | 右侧面板**自动打开**，显示问题、`已答`、答案、用量、「复制问答」 |
| 空态 | 「还没有侧问 / 在输入框输入 /btw <问题>…」 |
| 「开始」页入口卡 | 出现「侧问」卡片，使用插件自带图标（`docs/screenshot-guide.png`） |
| 语言 | desktop（zh）显示中文；en-US 浏览器显示英文（走 Client locale 服务） |

截图：`docs/screenshot-panel.png`（新会话自动打开）、`docs/screenshot-list.png`（多条记录）、`docs/screenshot-guide.png`（开始页入口）。

## 3. 最终冒烟（所有改动落地后，已通过）

`plugins/dsh-btw-research/smoke_final.py` 在独立浏览器里新建会话跑完整路径，答案用「只出现在答案里」的字符串（提问让模型把 `<marker-b>` 倒序输出，期望 `1937-ARBEZ`），避免用户消息本身干扰断言：

| 断言 | 结果 |
|---|---|
| 新会话里没有侧问页 | 通过（`null`） |
| `/btw` 自动打开右侧页签 | 通过 |
| 页签里有答案 `1937-ARBEZ`、`已答`、「复制问答」 | 通过 |
| 答案没有出现在页签之外的任何地方（把面板子树剔除后全文检索） | 通过（无重复卡片、无 detached notice） |
| 对话流里有 chip | 通过 |

`FAILURES: []`，退出码 0。截图 `docs/screenshot-panel.png` 即这次运行的画面。

> 早前一次「answer leaked into the transcript」是断言写错：`main` 包含了右侧栏，且密钥本身就是首句用户消息（于是标题/气泡自然包含它）。换成倒序答案后断言才有意义。

## 4. 未验证 / 已知缺口

- **未在用户桌面窗口里逐帧验收**：桌面窗口当时正被真实使用（出现输入法候选与其它会话的实时输出），自动化会切走用户会话，因此改为独立浏览器客户端验收；两者共用同一 Host 与同一客户端产物。
- **不流式**：命令结果只能一次性返回，没有逐 token 更新。
- **页签历史依赖命令行事件**：日志被压缩后早期记录可能消失。
- **并发**：同一会话只允许一个侧问在飞；第二个被拒绝（未做排队）。
- **图标**：`docs/screenshot-guide.png` 里可见自定义图标；未单独做 16px 栅格微调。

## 5. 工具版重构：一次性子 agent（已验证）

按用户决定（工具全开 / 写操作要审批 / 直接升级 `/btw`）把「一次无工具模型调用」换成 `ctx.subagents.startActivation({ provider: 'fork', delivery: 'caller' })` 起的临时子 agent：fork 种子 = 父会话已完成轮次，子 agent 继承父 preset 与工具集，答完 `dispose()`。探针实测（`plugins/dsh-btw-probe`，验收后卸载）：

| 场景 | 结果 |
|---|---|
| 需要读文件的问题（问 `package.json` 里 `dsh` 字段的子字段） | `success`，11.9s；答案引用了 `plugins/dsh-btw/package.json:33-45` 的行号——**确实调了 `read` 工具** |
| 写文件（在 `danger-full-access` 继承策略下） | `success`，28.4s；文件已创建并回读校验 |
| 父会话 `deriveMessages()` 摘要 | 两种场景都**前后一致**（`parentContextUnchanged: true`） |
| 父会话新增事件 | 只有 `command/run` + `command/done`（log-only） |
| 子会话 | 每次 `/btw` 生成一个 `continuable` 子会话，label = 问题前 48 字 |

## 6. 审批缺口（已验证，阻塞「写操作弹审批」）

把子 agent 放进 `read-only` 权限包（`permissionPresets.set(childSession, 'read-only')`，审批策略 `ask`）后再问一次写操作：

| 观察 | 结果 |
|---|---|
| 命令是否返回 | **120s 超时无结果**（探针 abort 掉） |
| 文件是否创建 | 否 |
| 父会话上下文 | 仍未变 |

结论（**已在第 7 节被推翻并更正**）：当时的判断是「审批请求发出了、卡在没人回答」。后续实测证明不是——`read-only` 下写文件是**沙箱直接拒绝并很快返回答案**，页面从不出现审批 UI；那次 120 秒超时的确切原因（子 agent 多步/重试超出探针上限）没有查明，不能当作"在等审批"的证据。真实结论见第 7 节。

当前临时默认（避免挂起/静默写）：`sideAgentPreset: read-only` + `approvalPolicy: never` —— 需要审批的写操作被**立即拒绝**（审批服务的 `never` 在交互派发前确定性拒绝），子 agent 会回答"我没有写权限"。

### 补完审批的三条路（待用户选择）

| 方案 | 做法 | 代价 |
|---|---|---|
| A（最原生，推荐） | 把侧问子会话在右侧栏**作为子智能体页签打开**，DSH 自己的审批 UI 就会在子会话里弹出；「侧问」面板只做答案摘要 | 需要接 `sidebarRight` + 子智能体页签资源地址，客户端工作量中等 |
| B（最可控） | Host 给子 agent 装一个 answerer，把 pending 审批通过 `host.call` 轮询送到「侧问」面板，面板里渲染"允许一次 / 拒绝" | 需要打通 client→host IPC（`host.call` 的 host 侧注册 API 尚未验证） |
| C（现状） | 只读：写操作一律拒绝 | 已实现，但满足不了"弹审批" |

## 7. 方案 A（子会话页签 + 原生审批面）：已实现并实测

用户选定 A：侧问的子会话在右侧栏以**内置子智能体页签**打开，DSH 自己的审批 UI 就渲染在那个会话里。资源地址 `dsh-resource://subagentchat/session/<child>?parent=<parent>&mode=continuable`（由 `@deepseek-ai/dsh-client-ui-subagent` 注册），客户端用 `ctx.sidebarRight.openResource(...)` 打开；child id 由 Host 在答案尾部用 `[[dsh-btw:child=<id>]]` trailer 交给客户端，渲染前剥掉。

| 验证 | 结果 |
|---|---|
| 答案落定后右侧出现子会话页签、渲染子会话完整对话（含工具调用与它自己的权限标签） | ✅（`docs/80-child-tab.png`） |
| 子 agent 在工作区内建文件 | ✅ `child-tab-test.txt` 内容 `ok` |
| 父会话 transcript | ✅ 只有 chip，上下文仍不变 |

### 「写操作弹审批」的平台事实（实测，推翻了我的预期）

| 子 agent 权限包 | 工作区内写 | 工作区外写 |
|---|---|---|
| `read-only` | `sandbox: file access denied under read-only mode` | 同左 |
| `workspace-write` | 允许 | 沙箱直接拒绝：`SetNamedSecurityInfoW failed (Win32 5)`，**没有审批弹窗** |
| `danger-full-access` | 允许 | 允许，静默 |

子 agent 自己的解释：「本会话是受限 subagent，审批被自动拒绝，无法提权」。

补充一条纠正：第一次跑工作区外写入的脚本报告出现「审批提示」，事后核对是**假阳性**——它匹配到了我自己注入给子 agent 的提示语里的「需要审批时等待审批」四个字，页面上并没有审批 UI。

结论：DSH 的文件写入没有 "ask-then-write" 通道，`approval` 只覆盖 `ask` 决策（如沙箱化 shell 升权）。因此「写操作弹审批」这个组合在当前 DSH 里**不可达**；可选的真实语义只有「只读 / 只能改工作区 / 全权」。当前默认取**只能改工作区**。

## 8. 发布（2026-11-17）

| 步骤 | 状态 |
|---|---|
| npm 包 | `@aspen138/dsh-btw@0.1.2`（registry `latest`；`repository.url`、`engines.dsh` 已核对） |
| GitHub | https://github.com/yhm138/dsh-btw（public、`main`、topics `dsh-plugin` + `deepseek-harness`、MIT LICENSE、`assets/icon-180.png`、`screenshots.json`） |
| awesome-dsh-plugin 收录 | 条目已写好并推到 fork 分支 `yhm138:add-dsh-btw`（`data/plugins/yhm138__dsh-btw.yml`，category `ui`）；**PR 已提交**：https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/16474 （2026-11-18 12:01 北京，仓库满 1 天后） |

### 发布过程中修掉的两个问题

1. **包名被占**：`dsh-btw` 在 npm 上已被他人占用（维护者 `iluluyu`，0.0.10），改用 scope `@aspen138/dsh-btw`。
2. **0.1.0 有缺陷，0.1.1 修复**：客户端模块 `window.__ModuleLoader__.load({ id })` 的 `id` **必须等于包名**。改包名后 0.1.0 里仍是旧 id，npm 装上的用户会注册不出右侧页签（本地重装时已复现：`sidebar.right.pane.tab` 的 occupant 消失）。0.1.1 已把 id 改成 `@aspen138/dsh-btw` 并复验 occupant 恢复。**`dsh-btw` 不要在 0.1.0 上使用。**

### v0.1.2：右上角常驻按钮（用户要求「关掉后能找回来」）

在 `conversation.session.header.utilities`（右对齐的工具按钮列表，已有 6 个占位者）里加了 `dsh-btw-header`：`◈ 侧问 N` 胶囊，只在本会话有侧问记录时渲染，点它打开/恢复「侧问」页签。

独立浏览器实测（`verify_header_button.py`）：

| 断言 | 结果 |
|---|---|
| 有记录时页签区出现按钮 | ✅ count=1 |
| 点按钮打开「侧问」页 | ✅ |
| 收起整个右栏后按钮仍在 | ✅（`docs/92-collapsed.png`） |
| 再点按钮把右栏恢复 | ✅（`docs/93-reopened.png`） |

（`docs/92-collapsed.png` 里能看到按钮位于「对话/轨迹/用量」那一行最右侧、导航按钮旁。）

## 9. v0.2.0：Markdown / 追问 / 设置页 / 不污染复验

四样都是用户直接要求的，且每一项都有对应的实测证据（`plugins/dsh-btw-research/verify_data.py`，`FAILURES: []`）。

| 能力 | 实现 | 证据 |
|---|---|---|
| **Markdown 渲染** | 自写渲染器嵌在 `client.js` 内（`dsh.client` 只允许一个浏览器入口，所以不能拆第二个 entry） | `{rendered: "markdown", lists: 1}`；单测 9 项全过（含 raw HTML 不生成元素） |
| **追问** | 面板卡片底部输入框 → 把 `/btw --continue <id> <问题>` 填进输入框 → 用户回车发送 | 答案 `<marker-c>`，且复述的依据是线程首条消息 → 线程上下文生效 |
| **设置页** | `settings.section` + `/api/dsh-btw/settings` + `configEditor.edit` | `HTTP 200 {ok:true}`；`answerMaxChars 12000→9000` 持久化 |
| **头按钮** | `conversation.session.header.utilities` 里的 `◈ 侧问 N` | `data-count` 从 `null`（未问过）到 `1` |
| **不污染主干** | 见下 | `settlement notice in parent: False` |

### 追问为什么不用 `sendMessage`（关键设计变更）

第一版追问用 `ctx.subagents.sendMessage()` 投给已存在的子会话。实测发现：**恢复子会话会让 subagent manager 往父会话推一条 settlement notice**（界面上显示为「子任务状态更新」），而这正是本功能要避免的污染。这条通知由 manager 生成，`tools.restrict()` 拦不住（restrict 只能移除子 agent 的工具）。

改成：**每轮追问新起一个子 agent**，把这条线程此前的问答拼进 prompt（最多 8 轮）。代价是每轮重新继承一次父会话上下文（token 更贵），换来父会话完全无感。

### 其它修正

- `ctx.tools.restrict()` 签名：只接受 `{ allow?, deny? }`，传谓词会抛「requires a scoped context」，传空对象是 no-op。子 agent 侧用 `{ deny: ['send_message','spawn_teammate','wait_agent','list_agents','interrupt_agent'] }`。
- `sideAgentTimeoutMs` 原 180s 会**掐死正常干活的子 agent**（表现为 `This operation was aborted`），改成 900s，并在配置注释里写明它是死锁兜底而非任务预算。
- `inFlight` 改为时间戳判定陈旧，避免一次卡死的侧问永久锁住该会话。
- 客户端组件加了 `data-dshbtw` / `data-state` / `data-followup` / `data-rendered` / `data-lists` / `data-count` 标记——验证脚本之前反复失败，多数是因为按文本/时序断言（曾把「本轮首条消息」误判为泄漏、把别的侧问卡片当成当前会话的）。

## 10. 市场维护者反馈：UTF-8 BOM（已修，等复验）

2026-11-18，awesome-dsh-plugin 的维护者在 PR #16474 上打了 `held: author` 标签并指出：

> npm 上的 `@aspen138/dsh-btw@0.1.2`（latest）的 `package.json` 开头带 UTF-8 BOM（`EF BB BF`）。DSH 读取 `package.json` 时不去 BOM，`JSON.parse` 会失败，装完识别不到 `dsh.bundle`。

**这是真缺陷，来源是我自己**：Windows 上 PowerShell 的 `Set-Content` / `Out-File` 默认写 BOM，我用它改过 `package.json`。这条评论最开始被漏看——只查了 PR 的 `state`，没查 comments/labels，20 小时后才在「看看有没有收录」时发现。

### 处置

| 版本 | 状态 |
|---|---|
| `0.1.2` | `package.json` 带 BOM（维护者核到的） |
| `0.2.0` | `package.json` 已无 BOM，但 `client.js` / `index.js` / `screenshots.json` 仍带 |
| `0.2.1` | 全包清干净 |
| `0.2.2` | 同上，并把防回归脚本 `scripts/check-no-bom.py` 发进包里 |

`0.2.2` 的发布物已逐字节复核：tarball 10 个文件**无一**带 `EF BB BF`，`package.json` 首字节 `123`（`{`）。

`scripts/check-no-bom.py` 做两件事：遍历所有文件剥 BOM；用**不带 BOM 容忍**的 `json.loads` 校验每个 `.json`，任一失败即非零退出。已写进 README 的「发布前必跑」。

PR 评论已回两次（先报 0.2.1，再更正为 0.2.2），等维护者复验合并。定时任务的提示词也改了，明确要求**必须读 comments 和 labels**。

## 11. 清理状态

- `dsh-btw-probe` 已从 desktop profile 卸载（bundle 记录已移除），源码保留在 `plugins/dsh-btw-probe/` 供复跑。
- 调研中间产物（asar 抽取、截图、脚本）在 `plugins/dsh-btw-research/`，不属于插件包。
- 验收用会话仍在：`session-a7ea4abf…`（`research/e2e`）、`session-1c580a06…`、以及浏览器「新建任务」产生的 `记住暗号：<marker-e>` 会话；本开发会话 `session-65a5d5fe…` 里也留有几条 `/btw` chip（log-only，未进入上下文）。需要清理可在「会话管理」里删除。

## 12. v0.3.0：线程预算可配置 + 从会话日志重建

用户问「不一定非得限制最多 8 轮」。顺着这个改，挖出两个真正的缺陷。

### 改了什么

| 项 | 之前 | 现在 |
|---|---|---|
| 追问轮数 | 硬编码 8 轮 | `maxThreadTurns`（默认 20） |
| 追问预算 | 只按轮数 | 再加 `maxThreadChars`（默认 24000 字），**按字符从新到旧取**，单个超长轮次截断而非丢弃 |
| 线程存储 | 只有内存 Map，**插件重载即丢** | 内存优先，**缺失时从父会话日志重建**（`command/run` 的 args + `command/done` 的 text，用 `--continue <childId>` 串链） |
| 内存占用 | Map 永不清理 | `maxThreads`（64）+ `threadTtlMs`（6h）双重淘汰，LRU 顺序；卸载时清空 |
| `DEFAULTS.sideAgentPreset` | `'read-only'`（与 patch 的 `workspace-write` 不一致，别人漏写配置就变只读） | `'workspace-write'` |

### 修掉的三个真 bug

1. **`CHILD_MARKER` 是字符串却被当正则用**（`CHILD_MARKER.exec(...)`）→ 直接 `TypeError`，追问必然失败。新增 `CHILD_PATTERN` 正则用于匹配，字符串保留给模板插值。
2. **追问链在日志重建时断在第二步**：`ownerOfChild` 构建时用 `continue` 跳过了所有 follow-up 的 run，而 follow-up 恰恰会产生新 child。改成「每个 `command/done` 都登记它产生的 child」。
3. **`agents` 在使用之后才声明**：日志回退分支引用了尚未赋值的 `const`，会 `ReferenceError`。把 `agents`/`parent` 的解析提到前面。

### 实测证据

会话日志（`session-33f4bbb0…`）：

```
seq=20 command/run  " 请记住标记：<marker-d>。只回复 ok。"
seq=22 command/done "ok"                          [[dsh-btw:child=a03c5b9e]]
seq=23 command/run  " --continue a03c5b9e 我刚才让你记住的标记是什么？"
seq=25 command/done "<marker-d>"                [[dsh-btw:child=1da17ab2]]   ✅
seq=26 command/run  " --continue a03c5b9e 再说一遍。"
seq=28 command/done "<marker-d>"                [[dsh-btw:child=f4c20b0d]]   ✅
```

两次追问都答出首轮标记，说明线程历史被带上了。

单测（全部 `ALL PASS`）：

- `test/markdown.test.py` —— 渲染器 10 项（含 raw HTML 不生成元素）
- `test/thread-budget.test.py` —— 轮数/字符双上限、超长轮次截断、`chars=0` 语义、线程隔离、`maxThreads` 上限、TTL 淘汰（12 项）
- `test/thread-from-log.test.py` —— 三轮链回溯、首轮无祖先、未知 child 安全、空日志安全、**环形日志不死循环**、失败轮次不抛（10 项）

### 一个过程中的错误

调试期间我误删了一大段代码（把 `if (result.stopReason ...)` 后面切多了），产生语法错误；已修复并复跑全部单测。另外几次浏览器端到端验证失败是**脚本定位错了会话**（侧栏 `.dcu-wb-session` 的第一个不是最新会话），不是功能问题——最终改以会话日志为准。

## 13. v0.3.1：设置路由缺鉴权（维护者指出，已修）

市场维护者在条目描述里加了一句警告：

> Its HTTP routes have no DSH access check, so a web page open in your browser could call them.

**这是真的，是我的疏漏。** 我在代码注释里写过「这条路由在 DSH 的鉴权栅栏内」——那句话是错的。`ctx.webServer.register()` 注册的裸路由**在 `/api` 栅栏之前**，任何在你浏览器里打开的第三方网页都能同源 `POST /api/dsh-btw/settings` 改配置。

### 修法

handler 的第一行调 `ctx.connection.requestRejection({ headers: req.headers })`——这是 DSH 提供给第三方路由做鉴权的官方入口，它施与内置路由完全相同的 Host/Origin 检查与签名 cookie 校验。拿不到 `connection` 服务时直接 `503` 拒绝（无法区分真浏览器与任意网页时，拒绝是唯一安全答案）。

### 实测

| 场景 | 结果 |
|---|---|
| 已登录的浏览器标签页 `GET /api/dsh-btw/settings` | `200 {"ok":true,...}` |
| 无 cookie、无 token 的全新浏览器上下文 | `401 {"ok":false,"error":"unauthorized"}` |

已验证在修完之后：`0.3.1` 发布物 10 个文件、无 BOM。

## 14. v0.4.0：侧问的运行进度（流式）

需求：侧问里要能看到「使用工具、思考、回答」，并且是流式的。

### 数据从哪来

DSH 已经把这三样都发布出来了，插件之前把它们丢掉了：

| 内容 | 事件 | 帧 |
|---|---|---|
| 思考 | `agent/assistant-stream` | `reasoning-delta` |
| 回答正文 | `agent/assistant-stream` | `text-delta` |
| 工具调用 | `agent/assistant-stream` | `tool-call-delta` + `block-end`（`block.type === 'tool-call'` 带完整 arguments） |
| 工具结果 | `session/event` | `tool/result`（含 `message.toolCallId`、`error`） |

`agent/assistant-stream` 是按 agent 作用域过滤的进程内事件：在**子 agent 自己的 ctx** 上订阅，就只会收到这个孩子的帧。所以跟踪器是在 `restrictReportingTools` 之后、用 `child.ctx.on(...)` 挂的，两条监听都在 `finally` 里摘掉。

### 传输

一个 SSE 路由，和设置路由共用同一套鉴权：

```
GET /api/dsh-btw/progress?parent=<父会话 id>&command=<command id>
```

键是 `<parent>\0<command>` —— `commandId` 本来就是 Chat 行（node）的标识，客户端不需要额外记账就能订阅。

缓冲区按 `progressTtlMs`（默认 30 分钟）保留已发帧，`Last-Event-ID` 从上次位置续发，所以**页面刷新后前面发生的过程能补回来**。缓冲区上限 4000 帧，超出丢最旧。

### 一个必须自己做的事

裸 `webServer.register()` 的路由在 DSH 的 `/api` 鉴权栅栏**之前**，所以 handler 第一条语句就得问 `ctx.connection.requestRejection()`。实测（未带凭据）：

```
GET /api/dsh-btw/settings                 -> 401 {"ok":false,"error":"unauthorized"}
GET /api/dsh-btw/progress?parent=a&command=b -> 401 unauthorized   （由本插件的 handler 写出）
GET /api/dsh-btw/not-a-route              -> 401 （无 content-type，来自 DSH 栅栏本身）
```

三者的响应形态不同，这正好把「handler 真跑起来了」和「被栅栏挡下」区分开——这也是本轮调试里排除误判的方法。

### 顺带修的一个配置陷阱

profile 的 `cordis.patch.yml` 里那一行 dsh-btw 是 **`id:` 覆盖**，它把整个 `config` 替换掉，于是新加的默认值（`maxThreadTurns` / `maxThreadChars` / `streamProgress` / `progressTtlMs`）全被吃掉，而 `sideAgentTimeoutMs` 还是旧的 180000。已把该行补全为包含全部键；这也解释了为什么之前「改了默认值却不生效」。

### 测试

- `test/progress.test.py`（14 项）：客户端折叠器——思考/正文分别累加、工具只出现一次、结果按 id 归属、未知 id 忽略、`done` 不清空已streamed内容、重放不产生重复行。
- `test/progress-host.test.py`（16 项）：Host 产出器——用假 `ctx`/假子 agent 喂真实帧形状，验证 tool-start 只发一次、`block-end` 带全参数、`tool/result` 能解析工具名、**其他会话的事件被忽略**、`finish` 之后不再收帧、`streamProgress: false` 只发一个状态帧、disposer 真能摘掉监听。

全部 `ALL PASS`；连同原有三套（Markdown / 线程预算 / 日志重建）共五套。

### 验证限制（如实记录）

本轮的浏览器端到端验证**没能完成**：DSH 桌面进程的 GUI token 只存在于它自己的启动 URL 里，外部拿不到；尝试过独立探针 bundle（`Config.listConfigs` 报 `absent`，没加载）、插件内临时写文件（`apply` 里的 effect 没执行到）、IPC/leveldb 搜 token（无）、复用 CDP（`9230` 是 Host inspector 目标，`Browser.setDownloadBehavior` 不存在，Playwright 连不上）。所以本轮的证据是：**路由确已注册（401 响应形态可区分）+ 五套单测全绿**，而不是「我在界面上看见进度条在动」。

## 15. v0.5.0：一条侧问一个窗口 + 回车即打开 + 线程隔离

三个需求：回车后主动在右侧打开、不同侧问是独立窗口、同一侧问里能多次追问。

### 做法

| 需求 | 机制 |
|---|---|
| 回车即打开 | chip 一挂载就调 `navigation.openQuestion()`；它用 `right.openTab(KIND, { params, revealIfOpened: true })`，面板会自己展开 |
| 一条一问 | tab 类型声明 `multiple: true`。`placeTab()` 的实现是 `pageAddress(kind) + '/' + randomUUID()`，所以每次都是独立实例（终端同机制） |
| 页签名 = 问题 | 注册 `sidebar.right.pane.tab.title` 席位。`openTab` 只读「placement + params」，**不接受 open-time title**，chip 文本来自 `definition.title(address)` 捕获值；要跟内容走就必须占这个 title 席位 |
| 同窗口多次追问 | 追问框已经按卡片的 `view.childId` 生成 `--continue`；新版页签按线程过滤，所以追问留在同一个窗口 |

### 修掉的一个真 bug（隔离失效）

第一版 `BtwQuestionPage` 的线程归属算法把**会话里所有 child id** 都作为初始集合：

```js
for (const record of records) {
  const view = viewOf(record)
  if (view.childId !== undefined) childIds.add(view.childId)   // ← 全塞进去了
}
```

后果是任何一条 `--continue <任意 child>` 都能命中集合，于是**每条追问都会出现在每条侧问的窗口里**，正好把"独立窗口"这个需求做废。已改为只用根节点的 child 作种子，单测守着。

### 顺手删掉的一个死参数

`right.openTab(kind, { title })` 里的 `title` 是无效的：`place()` 只透传 `paneId` / `replaceTab` / `preferNewPane` / `revealIfOpened` 和 `params`，标题由 `definition.title(address)` 决定。留着会让人以为能用，改成注释说明 + 走 title 席位。

### 避免的一个副作用

页面上每一条历史 `/btw` 都有一个 chip，如果一律自动打开，**每次打开应用都会冒出一排页签**。所以加了新鲜度判断：只在 `running === true` 或 `Date.now() - time < 120000` 时打开。

### 运行时证据

`cordis_inspect_query` 的 `Slots.listSubTree` 显示 `dsh-btw/side-questions` 同时占据：

- `sidebar.right.pane.tab`（页签主体）
- `sidebar.right.pane.tab.title`（页签标题）

后者是本轮新增的席位，它出现在 occupants 里说明注册确实生效。**注意这只能证明注册成功，不能证明交互观感**——和 0.4.0 一样，浏览器端到端仍未完成（GUI token 拿不到，见第 14 节）。

### 测试

- 新增 `test/thread-membership.test.py`（8 项）：两条独立线程互不串台、链式追问归属、把追问当根、未知 id、缺 child id 不误匹配。
- 六套单测全部 `ALL PASS`。
