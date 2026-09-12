# 统一计量口径 · Units

各家 Agent 的 `usage` 字段定义不一致，直接相加会算错。本项目把所有来源归一到同一套四类口径。

## 统一模型

一条记录 = 一次模型请求：

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
| Proma / Claude Code / Claude Desktop | `input_tokens` `output_tokens` `cache_read_input_tokens` `cache_creation_input_tokens` | 输入**不含**缓存 | 无推理字段 | 直接对应；`cw = cache_creation` |
| Pi / oh-my-Pi | `input` `output` `cacheRead` `cacheWrite` `reasoning` `totalTokens` | 输入**不含**缓存 | 推理**已含在 output** | `r` 仅展示，不额外相加（`total = i+o+cr+cw`） |
| Codex | `input_tokens` `cached_input_tokens` `cache_write_input_tokens` `output_tokens` `reasoning_output_tokens` `total_tokens` | 输入**包含**缓存 | 推理**已含在 output** | `i = input - cached`，`cr = cached`，`cw = 0` |
| ZCode | `inputTokens` `outputTokens` `cacheReadTokens` `cacheWriteTokens` `totalTokens` | 输入**不含**缓存 | 无 | 直接对应 |
| DeepSeek Harness | `inputTokens` `outputTokens` `cacheReadTokens` `totalTokens` | 输入**不含**缓存 | 无 | 实测 `total = i + o + cr`，缓存为独立项 |
| OpenCode | `tokens.input` `tokens.output` `tokens.reasoning` `tokens.cache.read` `tokens.cache.write` `tokens.total` | 输入**不含**缓存 | 推理为**独立相加项** | `o = output + reasoning`，`r = reasoning`（`total = i+o+r+cr+cw`） |

## 成本

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
- 无时间戳的记录会被丢弃（实测各源均为 0 条缺失）。

## 去重与防重复计数（重要）

| 场景 | 后果 | 处理 |
| --- | --- | --- |
| Proma 同一轮同时写 `assistant` 与 `result` | 翻倍 | 只取 `assistant`，并按 `uuid` 去重 |
| Claude Code 流式重复写同一 `message.id` | 偏大 | 按 `message.id` 去重 |
| Codex 续聊重开文件并重放历史 | 严重翻倍 | 按 `session_id` 取累计量最大的文件，再对累计值做差分 |
| DeepSeek Harness 的 `assistant/chunk` 回声 | 翻倍 | 只取 `assistant/message` |
| Claude Desktop 账本 vs Claude Code 主目录同一会话 | 跨源重复 | 账本优先，被账本覆盖的 `cliSessionId` 从 Claude Code 中排除 |
