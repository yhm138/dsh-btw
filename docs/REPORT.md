# dsh-btw 验收报告

记录本插件「已验证」与「未验证」的边界。证据分两类：Host 探针（真实命令注册表 + 真实会话）和独立浏览器客户端（带 token 的 Web GUI，与用户桌面窗口隔离）。

## 1. Host：上下文继承 + 零污染（已验证）

探针插件 `plugins/dsh-btw-probe`（验收后已卸载）在 Host 进程内调用 `ctx.commands.execute(agent, '/btw …', [], signal)`，并在调用前后对 `session.deriveMessages()` 取快照。

隔离会话 `session-a7ea4abf…`（先只告诉它口令「紫色雨伞-7391」）：

| 断言 | 结果 |
|---|---|
| `/btw 我刚才让你记住的口令是什么？` | `success`，答案 `紫色雨伞-7391`，2239ms |
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

`plugins/dsh-btw-research/smoke_final.py` 在独立浏览器里新建会话跑完整路径，答案用「只出现在答案里」的字符串（提问让模型把 `ZEBRA-7391` 倒序输出，期望 `1937-ARBEZ`），避免用户消息本身干扰断言：

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
| **追问** | 面板卡片底部输入框 → 把 `/btw --continue <id> <问题>` 填进输入框 → 用户回车发送 | 答案 `KOALA-6147`，且复述的依据是线程首条消息 → 线程上下文生效 |
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

## 10. 清理状态

- `dsh-btw-probe` 已从 desktop profile 卸载（bundle 记录已移除），源码保留在 `plugins/dsh-btw-probe/` 供复跑。
- 调研中间产物（asar 抽取、截图、脚本）在 `plugins/dsh-btw-research/`，不属于插件包。
- 验收用会话仍在：`session-a7ea4abf…`（`research/e2e`）、`session-1c580a06…`、以及浏览器「新建任务」产生的 `记住暗号：青鸟-9021` 会话；本开发会话 `session-65a5d5fe…` 里也留有几条 `/btw` chip（log-only，未进入上下文）。需要清理可在「会话管理」里删除。
