# 内置模型价目 · Model Pricing

核验日期：**2026-11-01**。单位：美元 / 每百万 token。程序只内置各厂商**基础档**价格；你在「计价配置」里改过的数值永远优先。

## 取价口径

- 缓存写入取 **5 分钟缓存** 价；Anthropic 的 1 小时缓存写入更贵，需要时请手动改。
- 不含：长上下文加价（Claude Haiku 5.5 超过 100K 输入、GPT-6 / GPT-5.x 超过 272K、Gemini Pro 超过 200K、Grok 超过 200K）、Batch / Flex 折扣、区域加价。原因：部分来源的“用量记录”是按轮或按日汇总，单条记录的大小不等于单次请求的提示长度，按它判断档位会系统性多算。
- DeepSeek 有高峰时段（周一至周五 UTC 01:00–04:00、06:00–10:00，中国法定节假日除外），内置的是低谷价，高峰为 2 倍。
- 带时间限制的价格取**当前**价：Gemini 4 Argon 自 2026-12-01 起翻倍（输入 4、输出 20、缓存 0.20）；Gemini 3.8 / 3.7 / 3.6 Flash 自 2027-01-01 起翻倍。到期后请手动更新。
- 缓存写入没有单独收费的来源，字段留空（DeepSeek 按未命中输入价；Moonshot 的 K 系列按其官方缓存写入价）。
- 升级时：只替换仍与旧内置默认值逐项相同的条目；你改过的条目、自己添加的模型原样保留；缺失的新模型补入。升级前的配置会备份为 `pricing-config.json.before-2026-11-01.bak`。

## 价目

| 厂商 | 模型 | 输入 | 输出 | 缓存读取 | 缓存写入 | 发布 / 调价 | 来源与可信度 |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- |
| Anthropic | claude-fable-5-1 | 10 | 50 | 0.25 | 12.5 | 近期 | 官方价目页 |
| Anthropic | claude-fable-5 | 10 | 50 | 1 | 12.5 |  | 官方价目页 |
| Anthropic | claude-opus-5-5 | 4 | 20 | 0.20 | 5 | 2026-09-22 | 官方价目页 |
| Anthropic | claude-opus-5 / 4-8 / 4-7 / 4-6 / 4-5 | 5 | 25 | 0.50 | 6.25 |  | 官方价目页 |
| Anthropic | claude-opus-4-1 / claude-opus-4 | 15 | 75 | 1.5 | 18.75 | 已退役 | 官方价目页 |
| Anthropic | claude-sonnet-5-5 | 2 | 10 | 0.10 | 2.5 | 2026-09-28 | 官方价目页 |
| Anthropic | claude-sonnet-5 | 2 | 10 | 0.20 | 2.5 | 引入价已转为标准价 | 官方价目页 |
| Anthropic | claude-sonnet-4-6 / 4-5 / 4 | 3 | 15 | 0.3 | 3.75 |  | 官方价目页 |
| Anthropic | claude-haiku-5-5（≤100K） | 0.10 | 0.50 | 0.01 | 0.125 | 2026-10-07 | 官方价目页；超过 100K 为 0.50 / 2.50 / 0.05 / 0.625，未计入 |
| Anthropic | claude-haiku-4-5 | 1 | 5 | 0.1 | 1.25 |  | 官方价目页 |
| Anthropic | claude-haiku-3-5 | 0.8 | 4 | 0.08 | 1 | 已退役 | 官方价目页（旧内置值 1 / 5 有误，已更正） |
| OpenAI | gpt-6-astra | 10 | 50 | 1 | — | 2026-09-03 | 官方价目页 |
| OpenAI | gpt-6.1-sol | 2 | 10 | 0.10 | — | 2026-09-29 | 官方价目页 |
| OpenAI | gpt-6-sol | 2 | 10 | 0.20 | — | 2026-09-22 | 官方价目页 |
| OpenAI | gpt-6.1-terra | 1 | 5 | 0.05 | — | 2026-10-26 | 官方价目页 |
| OpenAI | gpt-6-luna | 0.10 | 0.50 | 0.01 | — | 2026-09-22 | 官方价目页 |
| OpenAI | gpt-5.6-sol / terra / luna | 4 / 2 / 0.2 | 20 / 12 / 1.2 | 0.4 / 0.2 / 0.02 | — |  | 官方价目页 |
| OpenAI | gpt-5.5 / gpt-5.5-pro | 5 / 30 | 30 / 180 | 0.5 / — | — |  | 官方价目页 |
| OpenAI | gpt-5.4 / -pro / -mini / -nano | 2.5 / 30 / 0.75 / 0.2 | 15 / 180 / 4.5 / 1.25 | 0.25 / — / 0.075 / 0.02 | — |  | 官方价目页 |
| OpenAI | gpt-5.3-codex、gpt-5.2、gpt-5.1、gpt-5、gpt-5-mini、gpt-5-nano、gpt-4.1 系列、gpt-4o 系列、o4-mini | 见代码 | | | | 旧模型 | 官方价目页 |
| Google | gemini-4-argon | 2 | 10 | 0.10 | — | 2026-10-13 GA | 官方价目页；12-01 起翻倍 |
| Google | gemini-3.8-flash / 3.7-flash / 3.6-flash | 0.75 | 3.75 | 0.075 | — | 3.8：2026-09-02 | 官方价目页；2027-01-01 起翻倍。3.7 的价格来自 Google Cloud 与 OpenRouter 页面 |
| Google | gemini-3.5-flash-lite | 0.30 | 2.5 | 0.03 | — |  | 官方价目页 |
| Google | gemini-omni-1.1-flash | 1.5 | 9 | — | — | 2026-08-27 | 官方价目页（视频另按秒计，未纳入） |
| Google | gemini-3.1-pro-preview（≤200K） | 2 | 12 | 0.2 | — |  | 官方价目页 |
| Google | gemini-3.1-flash-lite / 3-flash-preview / 2.5 系列 | 见代码 | | | | 旧模型 | 官方价目页 |
| xAI | grok-4.7 / grok-4.6 | 2 | 6 | 0.5 | — | 4.7：2026-09-21 | 官方文档（docs.x.ai）；≥200K 为 2 倍 |
| xAI | grok-4.5 / grok-4.3 / grok-build-0.1 | 2 / 1.25 / 1 | 6 / 2.5 / 2 | 0.3 / 0.2 / 0.2 | — |  | 官方文档 |
| DeepSeek | deepseek-v4-pro（0813） | 0.66 | 1.98 | 0.022 | 0.66 | 价格新 | 官方价目页，低谷价 |
| DeepSeek | deepseek-v4-flash / deepseek-v4.1-flash / deepseek-flash（1017） | 0.15 | 0.60 | 0.003 | 0.15 | 2026-09 / 10-17 | 官方价目页，低谷价 |
| Moonshot | kimi-k3.1-pro | 2 | 10 | 0.2 | 2 | 2026-10-23 | 第三方转载的官方价目页，国内价 ¥13 / ¥68 |
| Moonshot | kimi-k3.1-pro-highspeed | 4 | 20 | 0.2 | 4 | 2026-10-23 | 同上 |
| Moonshot | kimi-k3 | 3 | 15 | 0.3 | 3 | 2026-07-16 | 同上，国内价 ¥20 / ¥100 |
| Moonshot | kimi-k2.7-code / k2.6 / k2.5 | 0.95 / 0.95 / 0.6 | 4 / 4 / 3 | 0.19 / 0.16 / 0.1 | — |  | 第三方汇总，可信度中 |
| 智谱 Z.ai | glm-5.3 / 5.2 / 5.1 | 1.4 | 4.4 | 0.26 | — | 5.3：2026-08-14 | 官方价目页 |
| 智谱 Z.ai | glm-5.3-flash / flashx | 0.15 / 0.37 | 0.5 / 1.25 | 0.03 / 0.075 | — | 2026-08-26 | 官方价目页 |
| 智谱 Z.ai | glm-5 / 4.7 / 4.6 / 4.5；glm-4.7-flash | 1 / 0.6 / 0.6 / 0.6 / 0 | 3.2 / 2.2 / 2.2 / 2.2 / 0 | 0.2 / 0.11 | — | 旧模型 | 官方价目页 |
| 阿里 | qwen3.8-max | 2 | 6 | — | — | 2026-08-03（9 月 0902 快照） | OpenRouter 页面，可信度中 |
| 阿里 | qwen3.8-flash | 0.15 | 0.47 | 0.016 | — |  | 第三方汇总，可信度中 |
| MiniMax | minimax-m3.1-flash | 0.15 | 0.60 | 0.015 | — | 2026-10-19 | 第三方汇总，可信度中 |
| MiniMax | minimax-m3 | 0.30 | 1.20 | 0.06 | — | 2026-06-01 | 第三方汇总，可信度中 |
| 小米 | mimo-v2.6-pro / flash | 0.435 / 0.14 | 0.87 / 0.28 | 0.0036 / 0.0028 | — | 2026-09 | 第三方转载官方价，可信度中 |
| Meta | muse-wonder | 4 | 20 | — | — | 2026-10-12 | 单一第三方来源，可信度低 |
| Meta | muse-spark-open | 1.25 | 4.25 | — | — | 2026-10-15 | 单一第三方来源，可信度低 |
| 免费通道 | big-pickle、minimax-m3-free、deepseek-v4-flash-free、space-bunny-free、x-preview-f-free、ll-alpha-free、step-5-preview-free、nemotron-3-ultra-free | 0 | 0 | 0 | 0 |  | OpenCode 等渠道的限免 / 隐名测试模型 |
| Qoder | qfmodel | — | — | — | — |  | 不公开美元单价，按 credits 套餐计费 |

## 未收录

- Mistral Large 4（2026-10-06 预览）：仍是有限预览，未找到可核验的正式价格。
- Qwen 4 系列：2026-09-22 仅预告，截至核验日没有发布价格。
- 只按分钟、按字符、按图或按秒计费的语音、图像、视频模型，不属于按 token 计价，未纳入。

## 美元与人民币

价格与统计始终以美元记。「计价配置」里可把成本显示切到人民币：显示值 = 美元成本 × 汇率，默认汇率 6.7138（中国人民银行 2026-10-30 人民币对美元中间价），可自行修改，设置保存在浏览器 / 应用的本地存储里。国内厂商的人民币官方价与按此汇率换算的美元价会有小差异，需要精确时请直接以美元价目为准。

## 主要来源

- Anthropic：<https://platform.claude.com/docs/en/about-claude/pricing>
- OpenAI：<https://developers.openai.com/api/docs/pricing>
- Google：<https://ai.google.dev/gemini-api/docs/pricing>
- DeepSeek：<https://api-docs.deepseek.com/quick_start/pricing>
- xAI：<https://docs.x.ai/developers/pricing>
- 智谱：<https://docs.z.ai/guides/overview/pricing>
- Moonshot：<https://www.kimi.ai/resources/kimi-k3-1-pro-pricing>
- 汇率：中国人民银行授权中国外汇交易中心公布的 2026-10-30 中间价
