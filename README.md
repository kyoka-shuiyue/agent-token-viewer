# Agent Token Viewer

**本机 AI 编码 Agent 的 Token 用量总览。** 一个零依赖的本地服务，扫描你机器上各个 Agent 留下的会话文件，
在一页里看到总量、单个 Agent 明细、任意时间段的用量与预估成本。

一个本地 Node 服务 + 一个单文件网页。**不上传任何数据，不修改任何文件，不装任何依赖。**

> English: a local-first, zero-dependency token-usage dashboard that aggregates session logs from
> 9 AI coding agents (Proma, Pi, oh-my-Pi, Claude Code, Claude Desktop, Codex, ZCode, DeepSeek Harness,
> OpenCode) into one view — per-agent drill-down, all-time / custom time ranges, and cost estimation.
> Everything is read-only and stays on your machine.

---

## 30 秒上手

```bash
git clone <本仓库地址>
cd agent-token-viewer

node server.js          # 或：start.bat（Windows）/ ./start.sh（macOS · Linux）
```

浏览器会自动打开 <http://127.0.0.1:3457>。首次扫描约 5–15 秒（取决于历史体量），之后有缓存，秒开。

要求：**Node.js ≥ 22.15**（用到内置的 `node:sqlite` 与 `zlib.zstdDecompressSync`，因此无需任何第三方依赖）。

```bash
node server.js --once      # 只在命令行打印各源统计，不起服务
node server.js --doctor    # 自检：逐个列出候选路径是否存在、读到多少条
```

## 支持的数据源

| Agent | 数据在哪 | 用量字段 |
| --- | --- | --- |
| Proma | `~/.proma/agent-sessions/`、`~/.proma-dev/agent-sessions/` | `message.usage` |
| Pi | `~/.pi/agent/sessions/` | `message.usage` |
| oh-my-Pi | `~/.omp/agent/sessions/` | `message.usage` |
| Claude Code | `~/.claude/projects/` **+ `~/.claude/stats-cache.json`** | `usage` / `dailyModelTokens` |
| Claude Desktop | `%LOCALAPPDATA%/Claude-3p/.../usage-ledger/*.ndjson` | `models[模型].*Tokens` |
| Codex | `~/.codex/sessions/` + `~/.codex/archived_sessions/` | `total_token_usage` |
| ZCode | `~/.zcode/cli/db/db.sqlite` 表 `model_usage` | 独立列 |
| DeepSeek Harness | `%APPDATA%/dsh-desktop/harness/sessions/**/session.jsonl.zstd` | `data.usage` |
| OpenCode | `~/.local/share/opencode/opencode.db` 表 `message` | `tokens` |

完整的路径清单、字段路径、压缩格式、跨源去重规则和踩坑记录都在
**[docs/data-sources.md](docs/data-sources.md)**——新增数据源前请先读它，改完请回来补它。

## 功能

- **总览**：全 Agent 合计 Token、调用次数、会话数、缓存读取、预估成本，以及各 Agent 占比环图。
- **单 Agent 下钻**：点任意卡片 → 趋势图（按模型 / 按 Token 类型）、类型分布环图、模型明细、
  每日用量热力图（窗口内逐日连续，未使用的日子保留空白格）、会话明细表。
- **时间维度**：全部时间（从最早记录到现在）/ 近 30 天 / 近 7 天 / 今日 / 自定义日期区间，切换即时重算。
- **计价配置**：给每个模型填四类单价（美元 / 每百万 token），自动折算预估成本；存 `pricing-config.json`。
- **增量缓存**：按文件 mtime + size 缓存解析结果，只重扫变化的文件。
- **动效**：悬停 3D 倾斜 + 跟随高光 + 流光描边、错落入场、数字滚动、图表生长、顶部流动光带。
  全部走 `transform / opacity`，右下角可逐项关闭或整体减弱。

## 口径说明（重要）

各家 `usage` 定义不一致，直接相加会算错。本项目统一折算成四类可比指标：

```
总量 = 非缓存输入 + 输出 + 缓存读取 + 缓存写入
```

- Codex 的 `input_tokens` **包含**缓存命中 → 拆成 `input - cached` 与 `cached`；
- OpenCode 的 `reasoning` 是**独立相加项** → 并入输出并单独展示；
- Pi / Codex 的 `reasoning` **已含在 output 内** → 只展示不再加。

详见 **[docs/units.md](docs/units.md)**。

### 已知的防重复计数处理

| 情况 | 后果 | 处理 |
| --- | --- | --- |
| Proma 同时写 `assistant` 与 `result` | 翻倍 | 只取 `assistant` + 按 `uuid` 去重 |
| Codex 续聊重开文件并重放历史 | 严重翻倍 | 按 `session_id` 取最完整一份，再对累计值差分 |
| DeepSeek Harness 的 `assistant/chunk` 回声 | 翻倍 | 只取 `assistant/message` |
| Claude Desktop 账本与 Claude Code 同一会话 | 跨源重复 | 账本优先，被覆盖的 `cliSessionId` 从 Claude Code 排除 |

## 隐私

- 所有数据源**只读**，不写入、不删除、不上传；缓存与配置只写在本项目目录内。
- 服务只监听 `127.0.0.1`，不对外网开放。
- 会话标题会被读取用于展示；如果你不希望，注释掉各适配器里的 `sessions` 收集即可。

## 已知限制

1. **Claude Code 的历史会被它自己清理**：旧会话文件删除后无法回补。
   本项目改用它的 `stats-cache.json` 按天统计兜底（四类拆分按比例估算，UI 会明确标注），
   但 `lastComputedDate` 之后若文件已被删，那段仍然取不到。
2. **工具没产生本地记录时就显示"暂无数据"**（例如某些只走云端、或从未使用过的 Agent）。先跑 `--doctor` 看路径。
3. **单价需要你自行填写**：模型名常常是中转渠道自定义的名字，程序无法猜出真实价格；留空即按未计价处理。
4. 跨平台路径用候选列表探测，**新出现的桌面端目录名可能不在候选里**——遇到请补 `docs/data-sources.md` 并提 PR。

## 目录结构

```
server.js      扫描服务 + 9 个数据源适配器（零依赖）
index.html     界面（内联 CSS/JS，手写 SVG 图表，不加载任何 CDN）
docs/
  data-sources.md   数据源图谱：路径、格式、字段、坑（本项目的核心资产）
  units.md          统一计量口径与去重规则
  adding-an-adapter.md  如何新增一个 Agent
pricing.example.json  单价配置样例
start.bat / start.sh  一键启动
```

## 参与贡献

见 [CONTRIBUTING.md](CONTRIBUTING.md)。最有价值的贡献是**补全数据源**：
在你这台机器上发现某个 Agent 的用量存在别处，把它的路径、字段、格式写进 `docs/data-sources.md` 并实现适配器。

## 许可证

[MIT](LICENSE)
