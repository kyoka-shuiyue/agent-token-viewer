# 数据源图谱 · Data Source Map

这份文档是本项目存在的核心：**每个 Agent 的用量数据到底存在哪里、用什么字段、怎么解析、有哪些坑**。
新增或排查数据源时请先读这里，改完请回来补这里，避免"漏项"。

图例：`~` = 用户主目录；`%APPDATA%` = `~/AppData/Roaming`（Windows）；`%LOCALAPPDATA%` = `~/AppData/Local`。

---

## 速查表

| # | Agent | 主数据位置 | 格式 | 用量字段 | 状态 |
| --- | --- | --- | --- | --- | --- |
| 1 | Mirage | `~/.mirage/agent-sessions/*.jsonl`<br>`~/.mirage/conversations/*.jsonl` | JSONL | `type:"assistant"` → `message.usage` | 已接入 |
| 2 | Pi | `~/.pi/agent/sessions/**/*.jsonl` | JSONL | `type:"message"` + `message.role:"assistant"` → `message.usage` | 已接入 |
| 3 | oh-my-Pi | `~/.omp/agent/sessions/**/*.jsonl` | JSONL | 同 Pi | 已接入 |
| 4 | Claude Code（CLI / 桌面 Code） | `~/.claude/projects/**/*.jsonl`（支持 `CLAUDE_CONFIG_DIR`）<br>Code `usage-ledger` + 历史 `stats-cache.json` | JSONL / NDJSON / JSON | `message.usage` / `models` / 历史日余额 | 已接入 |
| 5 | Claude Desktop（Cowork） | `%APPDATA%/Claude/local-agent-mode-sessions/**`<br>兼容 `%LOCALAPPDATA%/Claude-3p/...` | NDJSON / 标准沙箱 JSONL | `surface:cowork` → `models` / `message.usage` | 已接入 |
| 6 | Codex | `~/.codex/sessions/**/rollout-*.jsonl`<br>`~/.codex/archived_sessions/*.jsonl` | JSONL | `event_msg`→`payload.info.total_token_usage` / `token_usage_record`→`payload.thread_token_usage` | 已接入 |
| 7 | ZCode | `~/.zcode/cli/db/db.sqlite` 表 `model_usage` | SQLite | 独立列 | 已接入（transcript 作回退） |
| 8 | DeepSeek Harness | 官方桌面端/CLI：`~/.dsh/sessions/**/session.v4.jsonl.zstd`（支持 `DSH_HOME`）<br>兼容旧桌面版 `%APPDATA%/dsh-desktop/harness/sessions/**` | 多帧 zstd / gzip / JSONL，v0–v4 | `assistant/message`、`compaction/summary` → `data.usage` | 已接入 |
| 9 | OpenCode | `~/.local/share/opencode/opencode.db`（+`opencode-local.db`）表 `message`/`session` | SQLite | `data.tokens` | 已接入 |
| 10 | Qoder | `~/.qoder/projects/**/*.jsonl`（子代理在其 `subagents/` 下） | JSONL | **无 token 字段** → 按消息文本估算 | 已接入（估算口径） |

---

## 1. Mirage

- **位置**：`~/.mirage/agent-sessions/*.jsonl`（每个会话一个文件）。仅扫描 `.mirage`，不读取 Proma 或 Proma Dev。
- **格式**：Claude Code 风格事件流。
- **用量**：`type:"assistant"` 行的 `message.usage`：
  `input_tokens` / `output_tokens` / `cache_read_input_tokens` / `cache_creation_input_tokens`
- **时间**：`_createdAt`（毫秒）优先，回退 `timestamp`。
- **模型**：`_channelModelId` 优先（渠道真实模型），回退 `message.model`。
- **会话**：`session_id`；标题在 `~/.mirage/agent-sessions.json` 的 `sessions` 里。
  **但索引条目有两套 id**：`id`（Mirage 内部 id，也等于会话文件名）与 `sdkSessionId`（SDK 会话 id）。
  会话文件里的 `session_id` 是 **`sdkSessionId`**，按 `id` 建索引会一条也匹不上（实测 0/245）。
- **坑**：
  - 同一轮会同时写 `type:"assistant"` 和 `type:"result"`，两者数值相同 → **只能取一种**，本项目取 `assistant` 并按 `uuid` 去重。
  - 缓存读/写**不在** `input_tokens` 内（Anthropic 口径），总量 = 四项相加。
  - 部分会话的 `sdkSessionId` **没写回索引**，只能靠“文件名 = `id`”反查条目；
    且**续聊/恢复会让一个文件出现多个 `session_id`**（本机实测某文件 1.4MB，第二个 id 出现在 18KB 之后），
    所以必须全文收集，不能只读头部。本项目用正则 `"session_id"\s*:\s*"([^"]+)"` 扫，避开整行 `JSON.parse`。

## 2 / 3. Pi 与 oh-my-Pi

- **位置**：`~/.pi/agent/sessions/<编码后的cwd>/<时间>_<uuid>.jsonl`；oh-my-Pi 在 `~/.omp/agent/sessions/`，**结构与 Pi 完全相同**（同一 SDK 家族）。
- **用量**：`type:"message"` 且 `message.role:"assistant"` → `message.usage`：
  `input` / `output` / `cacheRead` / `cacheWrite` / `reasoning` / `totalTokens` / `cost.total`
- **时间**：行首 `timestamp`（ISO）或 `message.timestamp`（毫秒）。
- **模型**：`message.model`（另有 `model_change` 事件记录切换过程）。
- **坑**：
  - `totalTokens = input + output + cacheRead + cacheWrite`，`reasoning` **已含在 output 内**，不要再加。
  - 出错请求会写 `usage` 全 0 → 过滤掉。
  - 会话 id 在首行 `type:"session"` 的 `id`，**但行级预过滤会跳过它**，所以要用文件名兜底。
  - **标题**：Pi 家族没有标题索引，取首条 `type:"message"` + `role:"user"` 的 `text` 作为标题（见下文「会话标题从哪来」）。

## 4. Claude Code（CLI 与桌面 Code 标签页）

- **归类**：CLI 与 Claude Desktop 的 Code 标签页使用同一 Code 引擎，统一计入 `claude-code`；Cowork 单独计入 `claude-desktop`。不按“哪个可执行程序打开了窗口”混合归类。
- **当前会话位置**：`~/.claude/projects/<项目>/<session>.jsonl`，包括标准 `subagents` 子会话。支持官方 `CLAUDE_CONFIG_DIR` 更改配置 home；不会读取凭据、settings 或插件来估算 Token。
- **桌面声明**：新版 `%APPDATA%/Claude/claude-code-sessions`，兼容旧 `%LOCALAPPDATA%/Claude-3p/claude-code-sessions` 等已有应用数据候选。`local_*.json` 的 `cliSessionId` 可能指向主 `~/.claude/projects`，声明不能让这些请求直接从扫描中消失。
- **逐请求字段**：`message.usage.{input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens}`。同一 `message.id` 在流式内容块、续接文件与副本中重复时，保留总量最大的完整用量，而非第一条。副本不重复累计。
- **台账兜底**：`usage-ledger/*.ndjson` 中 `surface:"code"` 的用量计入 Code。按会话、当地日期、模型比较逐请求与台账覆盖量，选覆盖更完整的一组；两份重叠账目不相加。
- **旧历史**：`stats-cache.json` 的 `dailyModelTokens[].tokensByModel` 是日总量；`dailyActivity` 不是 Token。按日与模型扣掉已识别用量，仅补正的历史余额，不再因为某日已有缓存就丢掉当天其他模型或新请求。四类拆分按 `modelUsage` 的全期比例估算，整数分配保证四项合计等于剩余总量。界面明确历史缓存截止日期，历史桶使用 `claude-stats` 标识，不参与精确到小时的同期比较。
- **标题**：优先桌面声明的新标题，回退真实用户输入；不展示宿主上下文。归属使用真实会话 id，源码与原始日志只读。

## 5. Claude Desktop（Cowork）

- **归类**：`claude-desktop` 展示本机可读取的 Cowork 台账/日志；普通 Chat 没有真实本地 usage 时不估算，也不声称已覆盖所有聊天用量。
- **位置**：新版 `%APPDATA%/Claude/local-agent-mode-sessions`，兼容旧 `%LOCALAPPDATA%/Claude-3p/local-agent-mode-sessions` 及跨平台应用目录；仅读取会话声明、`usage-ledger` 和标准沙箱 `.claude/projects` 日志，不把工作区里的任意 JSONL/NDJSON 当成用量。
- **按工作类型分流**：台账 `surface:"cowork"` 属于本来源，`surface:"code"` 属于 Claude Code。缺失 `surface` 时使用会话声明和拥有该日志的标准目录判断。
- **格式**：
  ```json
  {"v":1,"ts":1788608974402,"surface":"cowork","sessionId":"local_fixture",
   "models":{"fixture-model":{"inputTokens":33982,"outputTokens":94,
     "cacheReadTokens":0,"cacheWriteTokens":0,"cost":{"usd":0.0344}}}}
  ```
- **去重/覆盖**：`local-agent-mode-sessions` 声明的 Cowork 会话若使用共享 projects 日志，该请求也只计入 Cowork。声明别名映射到真实 CLI id；逐请求与台账按会话/自然日/模型选择覆盖较完整的一组，缺少逐请求时保留台账。完全相同的台账行或请求跨目录副本只计一次。`cost.usd` 为可用的记录成本。
- **记录次数**：台账行可能是一轮、历史缓存是一日，界面使用“用量记录”，不把所有归一化记录数都叫 API 调用次数。

官方依据（2026-10-17核验）：[桌面 Code 与 CLI](https://code.claude.com/docs/en/desktop#coming-from-the-cli)、[会话管理](https://code.claude.com/docs/en/sessions)、[配置目录覆盖](https://code.claude.com/docs/en/settings#find-or-create-your-settings-files)。文件格式与路径层级另以本机只读结构核验。

## 6. Codex

- **位置**：`~/.codex/sessions/YYYY/MM/DD/rollout-<时间>-<uuid>.jsonl`，以及被移出的 `~/.codex/archived_sessions/*.jsonl`（**两处都要扫**）。
- **格式**：事件流。用量在 `type:"event_msg"` 且 `payload.type:"token_count"`：
  `payload.info.total_token_usage`（会话累计）与 `payload.info.last_token_usage`（本轮）。
  字段：`input_tokens` / `cached_input_tokens` / `cache_write_input_tokens` / `output_tokens` / `reasoning_output_tokens` / `total_tokens`
- **模型**：`turn_context.payload.model`；会话 id：`session_meta.payload.id` 优先，兼容旧 `session_id`。
- **两个必须处理的坑**：
  1. **续聊重放**：一个会话续聊会新开 rollout 文件并**重放历史事件**，同一 `session_id` 会出现在多个文件里。
     直接累加所有文件的 `last_token_usage` 会**翻倍**（实测 22.8 亿 vs 真实 11.5 亿）。
     → 正确做法：**同一文件先按实际线程 id 分组，再跨文件去重**，每个线程取累计量最大的那份，再把累计快照 **逐条差分**成增量；相同累计值的新旧事件只计一次
     （差分之和恒等于末次累计，既保总量准确又保留时间分布）。
  2. **口径**：`input_tokens` **包含** `cached_input_tokens`，`output_tokens` 包含 `reasoning_output_tokens`；
     `total = input + output`。→ 本项目存 `i = input - cached`、`cr = cached`，避免重复计数。
- **新版用量**：兼容 `token_usage_record.payload.thread_token_usage` 的线程累计值，不把逐请求 `usage` 再相加。子 Agent 的 `subagent_history_start_ordinal` 之前是复制的父线程历史，不能计为新用量；旧式计数器以该边界前累计值为基线。
- **标题**：先读取 `session_index.jsonl`，再从只读 `state_*.sqlite` 的 `threads` 表补充或更新标题，最后回退会话文件里的真实用户输入。

## 7. ZCode

- **主库（首选）**：`~/.zcode/cli/db/db.sqlite`，表 `model_usage`（逐请求一行）：
  `session_id, turn_id, model_id, variant, agent, mode, task_type, started_at, completed_at,
  input_tokens, output_tokens, reasoning_tokens, cache_read_input_tokens, cache_creation_input_tokens,
  provider_total_tokens, computed_total_tokens, raw_usage_json`
  另有 `turn_usage`（按轮汇总）、`session`（含 `title`）、`message`、`part`、`tool_usage`。
- **回退源**：`~/.zcode/cli/agents/sess_*/agent_*/transcript.jsonl`（**只有 subagent**，`type:"model_complete"` →
  `payload.usage.{inputTokens, outputTokens, totalTokens, cacheReadTokens, cacheWriteTokens}`）
  与 `~/.zcode/cli/rollout/model-io-sess_*.jsonl`。
  只读 transcript 会**严重低估**（实测 1.36 亿 vs 主库 5.83 亿）。
- **坑**：transcript 里模型不在 `model_complete` 上，而在同一文件的 `model_request`（字符串 `providerId/modelId`）
  或 `model_network_status`（对象 `{providerId, modelId, ...}`）事件里，需要**按顺序携带**到后续用量行。
  transcript 还有几万行 `model_streaming` 噪声，务必做**行级预过滤**再 `JSON.parse`。

## 8. DeepSeek Harness

- **官方桌面端与 CLI**（2026-10-17 核验）：共用 `~/.dsh`，`DSH_HOME` 支持绝对路径和 `~/`，空白覆盖视为未设置。会话在 `sessions/<项目>/<会话>/session.v4.jsonl.zstd`。`profiles/desktop` 是桌面安装/配置目录，Electron 的 `%APPDATA%/@deepseek-ai/dsh-desktop` 不是会话目录。
- **旧桌面封装**：继续兼容 `%APPDATA%/dsh-desktop/harness/sessions`、`deepseek-harness-desktop` 等已有路径；与官方共用 `dsh` 来源，不把副本当成新 Agent。
- **格式**：事件溯源 JSONL；识别 `session.jsonl`、`session.vN.jsonl` 及 `.zstd` / `.gz`，每目录只选择最高代际文件。当前验证到 v4；未知更高版本不猜测解析，并显示未计入提示。
- **用量**：正式 `assistant/message` 与独立压缩请求 `compaction/summary` 的 `data.usage`。模型优先 `data.message.model`，然后 `data.message.source.model` 或 `data.model`。缓存写入兼容 `cacheWriteTokens` 与旧 `cacheCreationTokens`；推理已包含在输出，不另加。没有真实 usage 的标题/搜索事件不估算。
- **去重**：会话使用文件头的真实 id；跨路径按会话 + 消息 id / 事件 seq 去重；子会话最后一个 `session/end-seed` 之前的继承历史不计新用量。标题读取 `session/title`，不从对话正文伪造。
- **坑 1（重复计数）**：`assistant/chunk` 里还有 `data.chunk.usage`（数量几乎相同），那是流式回声，**不能一起加**。
- **坑 2（口径）**：实测 `totalTokens = inputTokens + outputTokens + cacheReadTokens` → 缓存读取是**独立项**，与 Anthropic 口径一致，不用减。
- **坑 3（压缩）**：文件是**多帧 zstd 追加写入**。整文件一次 `zlib.zstdDecompressSync` 只能解出第一帧
  （实测 537KB 只出 198 字符）。必须按 magic `28 B5 2F FD` 切帧逐段解压，拼接字节后再解 UTF-8，不能在帧间插入换行；尾部尚未写完的帧跳过，读取不修改源文件。
  Node ≥ 22.15 自带 `zlib.zstdDecompressSync`（本项目要求 Node 22+）。
- **官方依据**：[桌面端发布](https://www.deepseek.com/download/)、[共享 home](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/util/home-paths/src/index.ts)、[桌面路径](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/desktop/src/paths.ts)、[版本化日志](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/session/session-persistence-jsonl/src/format.ts)。

## 9. OpenCode

- **位置**：`~/.local/share/opencode/opencode.db`（新版 SQLite，可能上百 MB），旧版 `opencode-local.db`，
  更早的纯文件布局在 `~/.local/share/opencode/storage/session/...`。
- **表**：
  - `message(id, session_id, data)`：`data` 为 JSON，assistant 行含
    `tokens:{input, output, reasoning, cache:{read, write}, total}`、`cost`、`modelID`、`providerID`、`time.created`
  - `session(id, title, model, agent, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, cost, ...)`
- **口径**：`total = input + output + reasoning + cache.read (+ cache.write)` → `reasoning` 是**独立相加项**，
  与 Pi/Codex 不同。本项目把 `o = output + reasoning`，同时保留 `r` 作展示。
- **读取方式**：Node 内置 `node:sqlite`（`new DatabaseSync(path, { readOnly: true })`），避免任何依赖安装。
- **坑**：`opencode.db` 可能被运行中的 OpenCode 锁住 → 必须只读模式；表名在旧版可能是 `messages`，需回退尝试。

---

## 10. Qoder（唯一需要估算的源）

- **位置**：`~/.qoder/projects/<编码后的cwd>/<sessionId>.jsonl`，子代理会话在
  `~/.qoder/projects/<编码后的cwd>/<sessionId>/subagents/*.jsonl`。可用 `QODER_HOME` 覆盖根目录。
  格式是 **Claude Code 风格事件流**（`type` = `user` / `assistant` / `attachment` / `active-leaf` / `runtime-config` …）。
- **关键事实：本地不落 token 数**。`type:"assistant"` 行的 `message.usage` 里
  `input_tokens` / `output_tokens` / `cache_read_input_tokens` / `cache_creation_input_tokens` **恒为 0**，
  但 `credits`（本机 2026-09-19 合计约 65，含子代理）与 `context_usage_ratio` 有真值。桌面 App 的
  `chat_session_context_usage.snapshot_json` 里直接写着 `"tokenCountsAvailable": false`，
  逐请求日志 `~/.qoder/logs/sessions/**/segments/*.jsonl` 的 `model.response.completed` 事件也是 0。
  所以这个源是**文本长度估算**，不是官方口径。
- **估算规则**（`qoderLineHandler`）：
  - `o` = 本条 `message.content` 各部件（`text` / `thinking` / `tool_use.input` 的 JSON）的估算 token；
  - `i` = 本条之前新增的 `user` / `attachment` 文本 + 之前累积的上下文（多轮会话每轮重发历史）；
  - `cr` / `cw` 一律 0 —— Qoder 未上报缓存，不虚构命中率（详情页会显示“缓存命中率 0.0%”，这是事实）；
  - 换算：CJK / 假名 / 韩文按 1 字 = 1 token，其余 4 字符 = 1 token（`estTokens`）。
  - 校准依据：估算累计值与 Qoder 自己的 `context_usage_ratio` 在本机 544 个点上 log-log 相关系数 **0.94**。
  - `context_usage_ratio` 相比上一轮**回落** → 视为发生过上下文压缩，按回落比例收缩累积值（否则压缩后会把已丢掉的历史当输入一直叠加）。
- **会话标题**：只从 `chat_sessions` 取，**不取用量**（见下一个坑）；库不存在或 Node 不支持 `node:sqlite` 时，
  回退到通用的 `sessionMetaFromFiles`（读文件头部 64KB，取 `cwd` 与首条 `user` 文本，结果进 `headMetaCache`）。
- **坑（重要）**：
  1. **App 与 CLI 是同一批 session id**。`%APPDATA%/com.qoder.app.stable/main.sqlite` 的 `chat_sessions.session_id`
     与 `~/.qoder/projects/` 的文件名完全一致（App 只是 CLI 的前端壳）。两边都扫会重复计数，
     所以 App 库**只用于取标题**。它的 `chat_session_messages` 只存交互层消息（voice transcript / system / 最终文本），
     没有逐轮 `usage`，本来也不是用量源。
  2. **行级预过滤不能写 `"role":"user"`**。`user` / `attachment` 行不含 `usage`，靠它们累积输入；
     而紧凑写法在序列化带空格的版本上（`"role": "user"`）会漏匹配，导致 `i` 全部算成 0。
     现用 `['usage', '"user"', '"attachment"']`。
  3. **`~/.qoder-cli/ai-stats/`** 是代码采纳率统计（`aiAddedLines` / `aiDeletedLines` / `lineDetails`），
     **不含 token**，不要当用量源。
  4. **`~/.qoder/logs/`** 与 `projects/` 是同一批请求的两种记录，两处都扫会翻倍；且它也只有 0 值 token。
  5. **`~/.qoder/.models/<uid>/catalog-v6`** 是加密的（拿不到 `contextWindow` 与模型价），
     `runtime-config` 行的 `contextWindow` 也是 `null`（默认 auto）。
  6. `credits` 不是美元，**不能**当作已知真实成本传给 `norm()` 的 `c` 字段。
  7. 早期消息带 `[QODER_LIVE_VOICE_CONTEXT]` 前缀（语音会话的隐藏上下文），做标题时要跳过。
- **计价**：`qfmodel` 不公开美元单价，`pricing-config.json` 里四个字段均为 `null`（未计价），
  需用户按自己的 Qoder 套餐手填。
- **本机实测（2026-09-19）**：12 文件 / 13.0 MB → 567 条记录、5 个会话、约 26.9M tokens（估算），
  模型单一 `qfmodel`；其中 `o` 合计 11.7 万、`i` 合计 2680 万（多轮重发的历史占绝大头）。

---

## 本机已发现但**未纳入**的来源（供后续扩展）

| 位置 | 情况 |
| --- | --- |
| `~/.workbuddy/projects/**/*.jsonl` | 271 个文件、约 2.5GB。usage 挂在 `type:"function_call"` 行的 `message.usage.{input_tokens, output_tokens, total_tokens}`（**没有 cache 字段**），与 Claude Code 格式不同 |
| `~/.craft-agent/workspaces/*/sessions/*/session.jsonl` | 3 个文件含 usage，量小 |
| `~/.claude/cc-haha/traces/*.jsonl` | 16MB，但只有请求体，**无 usage 字段**，不是用量源 |
| `~/.cursor`、`~/.gemini`、`~/.trae-cn` | jsonl 里**没有 usage 字段**（Gemini/Cursor 用量不落本地） |
| `~/.zcode/v2/tasks-index.sqlite` | 116 个 task 的索引，**无 token 列** |
| `%APPDATA%/ai.opencode.desktop`、`%APPDATA%/ZCode` | Electron 壳数据（Cache/IndexedDB），用量不在这里 |
| `~/.qoder/logs/sessions/**/segments/*.jsonl` | 25MB 结构化事件日志，`model.response.completed` 有四个 token 字段但**恒为 0**，且与 `projects/` 同一批请求 |
| `~/.qoder-cli/ai-stats/projects/*/*.jsonl` | 代码采纳率统计（AI 增删行），无 token |
| `%APPDATA%/com.qoder.app.stable/main.sqlite` 表 `chat_session_messages` | App 交互层消息，无 `usage`；只用于取 `chat_sessions.title` |

## 会话标题从哪来（容易全部落空）

UI 的会话清单靠 `sessions[会话id] = {title, cwd}`，各家来源不同：

| 源 | 标题来源 | 匹配键 |
| --- | --- | --- |
| Mirage | `agent-sessions.json` 的 `sessions[].title` | **`sdkSessionId`**（主）+ `id`（别名）+ 文件名反查 |
| Claude Desktop | 账本自带 | 账本会话 id |
| Codex | `session_index.jsonl` + `state_*.sqlite` 的 `threads.title`，回退真实用户输入；无用户输入的子 Agent 显示任务名与昵称 | 实际线程 id |
| ZCode / OpenCode / DSH | 各自的库或事件流 | 会话 id |
| Qoder | 桌面 App `chat_sessions.title`，回退首条用户输入 | 会话 id（App 与 CLI 共用） |
| Claude Code / Pi / oh-my-Pi | **无索引** → 取首条真实用户输入 | 会话 id |

实现上共用 `sessionMetaFromFiles(files, {sidOf, userTextOf, skip})`：流式提取真实用户输入及显式重命名事件，
结果缓存在 `headMetaCache`，文件 mtime 或大小变化时重新读取，避免长上下文和后续重命名被漏掉。注意三个陷阱：

1. 匹配键必须与记录里的 `rec.s` 同一体系（Mirage 就是在这上面踩过一次：两套 id 导致全部匹不上）。
2. “首条用户输入”要排除工具回传（Claude Code / Qoder 的 `tool_result` 也挂在 `type:"user"` 上），
   以及隐藏上下文前缀（Qoder 的 `[QODER_LIVE_VOICE_CONTEXT]`）。
3. 一个文件可能对应多个会话 id（续聊/恢复），`sidOf` 允许返回数组。

---

## 通用注意事项（做跨机器适配时先看这段）

1. **别按关键字猜目录名**：`dsh-desktop`、`Claude-3p` 都不含产品名，靠 `DSH_HOME`/源码常量或特征文件名（`session.jsonl.zstd`、`usage-ledger`、`rollout-*.jsonl`）去找更可靠。
2. **读源码定路径**：解析不出来时，去该工具的 `node_modules` 里找 `*home-paths*`、`*storage*`、`*persistence*` 包，
   看它自己怎么 `join()` 出来的（pnpm 是符号链接，`find` 要加 `-L`）。
3. **行级预过滤**：先对原始行做 `line.includes('"usage"')` 再 `JSON.parse`，否则 Codex/ZCode 的几百 MB 会拖死首次扫描。
4. **口径必须归一**：见 `../docs/units.md`。各家 `total` 定义不同，直接相加会错。
5. **去重优先级**：会话级累计值 > 逐轮增量 > 流式回声；同一会话跨文件时按 session id 取最完整的一份。
6. **只读**：所有源都以只读方式访问，绝不写回用户目录；缓存与配置只写项目自己的目录。
