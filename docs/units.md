# 统一计量口径 · Units

各家 Agent 的 `usage` 字段定义不一致，直接相加会算错。本项目把所有来源归一到同一套四类口径。

## 统一模型

逐请求日志通常一条记录对应一次模型请求；Cowork 台账可能按轮汇总，历史缓存按日汇总。界面计数统一称“用量记录”，不可将其直接当成 API 请求次数：

```
i  = 非缓存输入 token
o  = 输出 token（含推理，见下表）
cr = 缓存命中读取 token
cw = 缓存写入 token
r  = 推理 token（仅作展示，是否计入 o 见下表）
c  = 该请求已知的真实成本（美元，可选）

总量 = i + o + cr + cw
```

## 各家原始字段 → 统一字段的映射

| 来源 | 原始字段 | 是否含缓存 | 是否含推理 | 换算 |
| --- | --- | --- | --- | --- |
| Mirage / Claude Code / Cowork 逐请求日志 | `input_tokens` `output_tokens` `cache_read_input_tokens` `cache_creation_input_tokens` | 输入**不含**缓存 | 无推理字段 | 直接对应；`cw = cache_creation` |
| Claude Code / Cowork 台账（按 surface 分流） | `models[模型].inputTokens` `outputTokens` `cacheReadTokens` `cacheWriteTokens` | 输入**不含**缓存 | 未单独记录 | `i+o+cr+cw`；不能将重叠逐请求和台账再次相加 |
| Pi / oh-my-Pi | `input` `output` `cacheRead` `cacheWrite` `reasoning` `totalTokens` | 输入**不含**缓存 | 推理**已含在 output** | `r` 仅展示，不额外相加（`total = i+o+cr+cw`） |
| Codex | `input_tokens` `cached_input_tokens` `cache_write_input_tokens` `output_tokens` `reasoning_output_tokens` `total_tokens` | 输入**包含**缓存 | 推理**已含在 output** | `i = input - cached`，`cr = cached`，`cw = 0` |
| ZCode | `inputTokens` `outputTokens` `cacheReadTokens` `cacheWriteTokens` `totalTokens` | 输入**不含**缓存 | 无 | 直接对应 |
| DeepSeek Harness（官方桌面端 / CLI / 旧桌面版） | `inputTokens` `outputTokens` `cacheReadTokens` `cacheWriteTokens`（旧 `cacheCreationTokens`） `reasoningTokens` | 输入**不含**缓存 | 推理已含输出 | `total = i + o + cr + cw`，不额外相加推理；只累计正式消息与独立压缩请求的 usage，排除继承历史和流式回声 |
| OpenCode | `tokens.input` `tokens.output` `tokens.reasoning` `tokens.cache.read` `tokens.cache.write` `tokens.total` | 输入**不含**缓存 | 推理为**独立相加项** | `o = output + reasoning`，`r = reasoning`（`total = i+o+r+cr+cw`） |
| Qoder | **无**（`usage` 四个 token 字段恒为 0） | — | `thinking` 已含在输出文本里 | 文本长度估算：`i` = 本轮新增 + 历史重发，`o` = 本轮输出，`cr = cw = 0` |

## Claude 渠道与历史覆盖

Claude Code 包含 CLI 和桌面 Code 标签页，Claude Desktop 来源只显示可读取的 Cowork 用量。台账依 `surface` 分流，声明映射真实会话 id。逐请求/台账在同会话、自然日和模型的重叠桶选择覆盖更完整的一组，不相加；历史日缓存仅补已知实际用量后的正余额，四类估算整数合计严格守恒。普通 Chat 没有本地 usage 时不造 Token。

## 成本

总览「模型 Token 排名」跨全部 Agent 汇总，遵循顶部时间筛选，使用与摘要相同的 `i + o + cr + cw`。完全相同的原始模型标识合并，渠道前缀或不同版本保留，不因计价匹配而合并；来源按钮显示该模型出现在哪些 Agent。默认前 10 名可展开全部，覆盖率的分母是所选区间全部模型总量；没有 usage 的请求不补造 Token。

优先级：

1. 记录自带成本（Pi `usage.cost.total`、OpenCode `cost`、Claude Desktop `cost.usd`）→ 直接用；
2. 否则按 `pricing-config.json` 的单价折算：
   ```
   cost = (i·单价.input + o·单价.output + cr·单价.cacheRead + cw·单价.cacheCreation) / 1e6
   ```
   单价单位：美元 / 每百万 token。留空 = 未计价（按 0 计入总额，UI 会提示"多少个模型未计价"）；填 0 = 免费。
3. 模型名匹配会先去掉 `[渠道前缀]`、`provider/` 前缀，再尝试去掉 `-thinking` / `-high` / `-free` 等后缀，最后做最长前缀匹配。

## 时间

- 一律归一到**毫秒时间戳**；秒与微秒会被识别（>1e14 视为微秒，>1e9 视为秒）。
- 日/月桶按**本地时区**分桶（`dayKey`），与用户日历一致。
- 首页默认展示今日；近七天包含今天及之前六个自然日，空日补零，今天只统计到本次扫描时刻。近七天迷你图独立于主时间筛选。
- “较昨日同期”仅比较两天当地00:00至相同本地时刻的有时间戳记录，按日历回溯以适应夏令时；昨日基数为零时显示“无记录”，不生成无限百分比。这个对比基于当前可读取的本机记录，历史缺失不等于实际未使用。
- `claude-stats` 的中午时间戳只用于标记所属日期。首页和详情按整天归属计入此类记录，即使当天尚未到中午；它们不参与精确到小时的同期对比，界面会注明。
- 七天成本图继续采用现有单价与记录内成本口径，未计价部分不计入；它是估算，不能替代实际账单。
- 无时间戳的记录会被丢弃（实测各源均为 0 条缺失）。

## 哪些数字是估算的

只有两个源不是直接拿官方上报的 token：

| 源 | 估算方式 | 影响 |
| --- | --- | --- |
| Claude Code | 旧会话文件被自动清理后，改用 `stats-cache.json` 的按天总量，四类拆分按模型全局比例估算 | 总量准确，四类拆分是比例值 |
| Qoder | 官方**不落 token**（`tokenCountsAvailable:false`），全部四类均为文本长度估算 | 总量与拆分都是估算；UI 卡片副标题与详情页 `⚠` 备注都会写明 |

横向比较时请先把这两个源当成量级参考，不要当成账单数字。

## 去重与防重复计数（重要）

| 场景 | 后果 | 处理 |
| --- | --- | --- |
| Mirage 同一轮同时写 `assistant` 与 `result` | 翻倍 | 只取 `assistant`，并按 `uuid` 去重 |
| Mirage 多份日志包含同一请求 | 翻倍 | 跨文件按请求 id 去重，保留最完整用量 |
| Codex 同时写新旧格式用量 | 翻倍 | 读取线程累计值，相同或回退的累计快照不再产生增量 |
| Claude Code 流式重复写同一 `message.id` | 偏大 | 按 `message.id` 去重 |
| Codex 续聊重开文件并重放历史 | 严重翻倍 | 文件内先按实际线程 `id` 分组，跨文件取累计量最大的那份，排除子 Agent 继承的历史，再对累计值做差分 |
| DeepSeek Harness 的 `assistant/chunk` 回声 | 翻倍 | 只取 `assistant/message` |
| Claude Desktop 账本 vs Claude Code 主目录同一会话 | 跨源重复 | 账本优先，被账本覆盖的 `cliSessionId` 从 Claude Code 中排除 |
| Qoder 桌面 App 的 `main.sqlite` 与 CLI 的 `projects/` 共用同一批 session id | 翻倍 | App 库**只取会话标题**，不取用量 |
| Qoder `logs/sessions/**` 与 `projects/` 是同一批请求 | 翻倍 | 只扫 `projects/` |
| Qoder 流式中间块（`thinking` / `content_block_start`）无 `usage` | 偏大 | 只取带 `usage` 的 `assistant` 行，并按 `uuid` 去重 |
