# 数据源图谱 · Data Source Map

这份文档是本项目存在的核心：**每个 Agent 的用量数据到底存在哪里、用什么字段、怎么解析、有哪些坑**。
新增或排查数据源时请先读这里，改完请回来补这里，避免"漏项"。

图例：`~` = 用户主目录；`%APPDATA%` = `~/AppData/Roaming`（Windows）；`%LOCALAPPDATA%` = `~/AppData/Local`。

---

## 速查表

| # | Agent | 主数据位置 | 格式 | 用量字段 | 状态 |
| --- | --- | --- | --- | --- | --- |
| 1 | Proma | `~/.proma/agent-sessions/*.jsonl`<br>`~/.proma/conversations/*.jsonl`<br>`~/.proma-dev/agent-sessions/*.jsonl` | JSONL | `type:"assistant"` → `message.usage` | 已接入 |
| 2 | Pi | `~/.pi/agent/sessions/**/*.jsonl` | JSONL | `type:"message"` + `message.role:"assistant"` → `message.usage` | 已接入 |
| 3 | oh-my-Pi | `~/.omp/agent/sessions/**/*.jsonl` | JSONL | 同 Pi | 已接入 |
| 4 | Claude Code | `~/.claude/projects/**/*.jsonl`<br>**+ `~/.claude/stats-cache.json`** | JSONL + JSON | `message.usage` / `dailyModelTokens` | 已接入 |
| 5 | Claude Desktop | `%LOCALAPPDATA%/Claude-3p/local-agent-mode-sessions/**/usage-ledger/*.ndjson` | NDJSON | `models[模型].*Tokens` + `cost.usd` | 已接入 |
| 6 | Codex | `~/.codex/sessions/**/rollout-*.jsonl`<br>`~/.codex/archived_sessions/*.jsonl` | JSONL | `event_msg`→`payload.info.total_token_usage` | 已接入 |
| 7 | ZCode | `~/.zcode/cli/db/db.sqlite` 表 `model_usage` | SQLite | 独立列 | 已接入（transcript 作回退） |
| 8 | DeepSeek Harness | `%APPDATA%/dsh-desktop/harness/sessions/**/session.jsonl.zstd`<br>`~/.dsh/sessions/**` | 多帧 zstd + JSONL | `assistant/message` → `data.usage` | 已接入 |
| 9 | OpenCode | `~/.local/share/opencode/opencode.db`（+`opencode-local.db`）表 `message`/`session` | SQLite | `data.tokens` | 已接入 |

---

## 1. Proma

- **位置**：`~/.proma/agent-sessions/*.jsonl`（每个会话一个文件）。开发版实例在 `~/.proma-dev/agent-sessions/`，**容易漏**。
- **格式**：Claude Code 风格事件流。
- **用量**：`type:"assistant"` 行的 `message.usage`：
  `input_tokens` / `output_tokens` / `cache_read_input_tokens` / `cache_creation_input_tokens`
- **时间**：`_createdAt`（毫秒）优先，回退 `timestamp`。
- **模型**：`_channelModelId` 优先（渠道真实模型），回退 `message.model`。
- **会话**：`session_id`；标题在 `~/.proma/agent-sessions.json` 的 `sessions` 里。
- **坑**：
  - 同一轮会同时写 `type:"assistant"` 和 `type:"result"`，两者数值相同 → **只能取一种**，本项目取 `assistant` 并按 `uuid` 去重。
  - 缓存读/写**不在** `input_tokens` 内（Anthropic 口径），总量 = 四项相加。

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

## 4. Claude Code（最容易漏的一个）

- **位置 A**：`~/.claude/projects/<编码后的cwd>/<session>.jsonl`
- **位置 B（关键）**：`~/.claude/stats-cache.json` —— Claude Code 自己的统计缓存。
- **为什么必须用 B**：Claude Code 会**自动清理旧会话文件**。实测某台机器 `projects/` 只剩 5 个文件（约 340 万 tokens），
  而 `stats-cache.json` 里记着 `totalSessions: 52 / totalMessages: 7937`，`dailyModelTokens` 单月就有 5.98 亿。
  只扫文件会**少两个数量级**。
- **字段**：
  - 文件：`message.usage.{input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens}`，按 `message.id` 去重。
  - 缓存：`dailyModelTokens: [{date, tokensByModel: {模型: 总量}}]`（只有日粒度总量）；
    `modelUsage: {模型: {inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens, costUSD}}`（全期四类总量）。
  - 本项目做法：以 `dailyModelTokens` 为主源，四类拆分按 `modelUsage` 的**全局比例估算**；
    文件记录只补 `stats-cache` 未覆盖的日期，避免重复计数。UI 会标注这一事实。
  - `stats-cache.json` 有 `lastComputedDate`，**它之后的数据要靠会话文件**；文件若已删则该段无法回补。
- **坑**：`~/.claude/stats-cache.json` 的 `dailyActivity` 只有消息数没有 token，别用错表。

## 5. Claude Desktop

- **位置**：`%LOCALAPPDATA%/Claude-3p/local-agent-mode-sessions/<账户>/<工作区>/usage-ledger/<日期>.ndjson`
  （`Claude-3p` 是新版带 Agent/Cowork 模式的桌面版；老版在 `%APPDATA%/Claude/`，通常只有壳数据）。
- **格式**：每行一轮，`models` 是按模型分组的字典：
  ```json
  {"v":1,"ts":1788608974402,"surface":"cowork","sessionId":"local_...",
   "models":{"claude-haiku-4-5[1m]":{"inputTokens":33982,"outputTokens":94,
     "cacheReadTokens":0,"cacheWriteTokens":0,"cost":{"usd":0.0344,"basis":"list"}}}}
  ```
- **优点**：自带美元成本（`cost.usd`），可直接用。
- **坑（重复计数）**：同一目录树下还有沙箱版 `.claude/projects/**/*.jsonl`，与账本指向同一会话；
  而且 `claude-code-sessions/**/local_*.json` 里的 `cliSessionId` 可能指向**主 `~/.claude/projects` 的文件**。
  → 本项目先收集这些 `cliSessionId`，从 Claude Code 扫描中排除，账本已覆盖的会话也不再读沙箱文件。

## 6. Codex

- **位置**：`~/.codex/sessions/YYYY/MM/DD/rollout-<时间>-<uuid>.jsonl`，以及被移出的 `~/.codex/archived_sessions/*.jsonl`（**两处都要扫**）。
- **格式**：事件流。用量在 `type:"event_msg"` 且 `payload.type:"token_count"`：
  `payload.info.total_token_usage`（会话累计）与 `payload.info.last_token_usage`（本轮）。
  字段：`input_tokens` / `cached_input_tokens` / `cache_write_input_tokens` / `output_tokens` / `reasoning_output_tokens` / `total_tokens`
- **模型**：`turn_context.payload.model`；会话 id：`session_meta.payload.session_id`。
- **两个必须处理的坑**：
  1. **续聊重放**：一个会话续聊会新开 rollout 文件并**重放历史事件**，同一 `session_id` 会出现在多个文件里。
     直接累加所有文件的 `last_token_usage` 会**翻倍**（实测 22.8 亿 vs 真实 11.5 亿）。
     → 正确做法：**按 session 去重**，取累计量最大的那份文件，再把该文件内的 `total_token_usage` **逐条差分**成增量
     （差分之和恒等于末次累计，既保总量准确又保留时间分布）。
  2. **口径**：`input_tokens` **包含** `cached_input_tokens`，`output_tokens` 包含 `reasoning_output_tokens`；
     `total = input + output`。→ 本项目存 `i = input - cached`、`cr = cached`，避免重复计数。
- **标题**：`~/.codex/session_index.jsonl` 每行 `{id, thread_name, updated_at}`，用来给会话列表显示真名。

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

- **CLI 默认 home**：`~/.dsh`（`DSH_HOME` 环境变量可覆盖 —— 见 `@deepseek-ai/dsh-home-paths` 的 `DSH_HOME_ENV`）。
  **只扫 `~/.dsh` 常常什么都没有**（`storages/workspace.json` 的 `workspaceIds` 为空）。
- **桌面版真实位置（关键）**：`%APPDATA%/dsh-desktop/harness/sessions/<编码后的cwd>/session-<uuid>/session.jsonl.zstd`
  —— 桌面版把 home 指到自己的 Electron 数据目录，目录名 `dsh-desktop` 不含 "deepseek" 字样，按关键字搜很容易漏。
- **格式**：事件溯源 JSONL，20216 条事件里用量只在
  `type:"assistant/message"` 的 `data.usage`：`{inputTokens, outputTokens, cacheReadTokens, totalTokens}`；
  模型在 `data.message.model`；标题在 `type:"session/title"` 的 `data.title`。
- **坑 1（重复计数）**：`assistant/chunk` 里还有 `data.chunk.usage`（数量几乎相同），那是流式回声，**不能一起加**。
- **坑 2（口径）**：实测 `totalTokens = inputTokens + outputTokens + cacheReadTokens` → 缓存读取是**独立项**，与 Anthropic 口径一致，不用减。
- **坑 3（压缩）**：文件是**多帧 zstd 追加写入**。整文件一次 `zlib.zstdDecompressSync` 只能解出第一帧
  （实测 537KB 只出 198 字符）。必须按 magic `28 B5 2F FD` 切帧逐段解压再拼接。
  Node ≥ 22.15 自带 `zlib.zstdDecompressSync`（本项目要求 Node 22+）。

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

## 本机已发现但**未纳入**的来源（供后续扩展）

| 位置 | 情况 |
| --- | --- |
| `~/.workbuddy/projects/**/*.jsonl` | 271 个文件、约 2.5GB。usage 挂在 `type:"function_call"` 行的 `message.usage.{input_tokens, output_tokens, total_tokens}`（**没有 cache 字段**），与 Claude Code 格式不同 |
| `~/.craft-agent/workspaces/*/sessions/*/session.jsonl` | 3 个文件含 usage，量小 |
| `~/.claude/cc-haha/traces/*.jsonl` | 16MB，但只有请求体，**无 usage 字段**，不是用量源 |
| `~/.cursor`、`~/.gemini`、`~/.trae-cn` | jsonl 里**没有 usage 字段**（Gemini/Cursor 用量不落本地） |
| `~/.zcode/v2/tasks-index.sqlite` | 116 个 task 的索引，**无 token 列** |
| `%APPDATA%/ai.opencode.desktop`、`%APPDATA%/ZCode` | Electron 壳数据（Cache/IndexedDB），用量不在这里 |

## 通用注意事项（做跨机器适配时先看这段）

1. **别按关键字猜目录名**：`dsh-desktop`、`Claude-3p`、`.proma-dev` 都不含产品名，靠 `DSH_HOME`/源码常量或特征文件名（`session.jsonl.zstd`、`usage-ledger`、`rollout-*.jsonl`）去找更可靠。
2. **读源码定路径**：解析不出来时，去该工具的 `node_modules` 里找 `*home-paths*`、`*storage*`、`*persistence*` 包，
   看它自己怎么 `join()` 出来的（pnpm 是符号链接，`find` 要加 `-L`）。
3. **行级预过滤**：先对原始行做 `line.includes('"usage"')` 再 `JSON.parse`，否则 Codex/ZCode 的几百 MB 会拖死首次扫描。
4. **口径必须归一**：见 `../docs/units.md`。各家 `total` 定义不同，直接相加会错。
5. **去重优先级**：会话级累计值 > 逐轮增量 > 流式回声；同一会话跨文件时按 session id 取最完整的一份。
6. **只读**：所有源都以只读方式访问，绝不写回用户目录；缓存与配置只写项目自己的目录。
