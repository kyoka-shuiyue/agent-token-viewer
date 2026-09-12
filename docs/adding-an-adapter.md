# 如何新增一个数据源适配器

目标：让"再加一个 Agent"这件事不需要重新逆向一遍文件格式。

## 第一步：先定位数据在哪

按优先级尝试：

1. **看它自己的源码**。在工具的 `node_modules` 里找名字含
   `home-paths` / `storage` / `persistence` / `session` 的包，读它怎么 `join()` 出路径。
   注意 pnpm 用符号链接，`find` 要加 `-L`。
   ```bash
   find -L ~/.someagent/profiles/node_modules -maxdepth 2 -type d -name "*home-paths*"
   ```
2. **看环境变量**。很多工具支持覆盖数据目录（如 `DSH_HOME`、`CLAUDE_CONFIG_DIR`），
   桌面版还会把 home 指到 Electron 的 userData 目录（`%APPDATA%/<产品名>` 或 `<产品名>-desktop`）。
3. **搜特征文件名**，比搜目录名可靠得多：
   ```bash
   find ~ -maxdepth 6 -name "session.jsonl*" -o -name "*.ndjson" -o -name "usage-ledger" 2>/dev/null
   ```
4. **确认有没有用量字段**。有的工具只存消息文本，不存 token——那就只能估算，需要明确标注。

## 第二步：确认口径，别 double count

拿到字段后先做这三件事：

1. **total 的构成**：随机取若干条，验证
   `total == input + output` / `+ cacheRead` / `+ reasoning` 哪一种成立。
   这决定缓存和推理要不要单独加（见 [units.md](units.md)）。
2. **是否重复写**：同一轮是否有多条记录（如 `assistant` 与 `result`、流式 `chunk` 回声）。
   用唯一键（`uuid` / `message.id` / `seq`）去重，或只取其中一种类型。
3. **跨文件重复**：续聊/恢复是否会新开文件并重放历史。若会，必须按会话 id 去重，
   取累计值最大的一份，再把累计值差分回逐轮增量。

## 第三步：写适配器

在 `server.js` 的 `AGENT_DEFS` 数组里加一项：

```js
{
  id: 'my-agent',
  name: 'My Agent',
 color: '#D9541F',
  subtitle: '一句话说明数据来源',
  roots: [path.join(HOME, '.my-agent', 'sessions')],   // 用于判断"未安装"
  async scan(ctx) {
    // ctx.stats: { files, bytes, reused, parsed } —— 记得累加，UI 会显示
    const files = await walk(path.join(HOME, '.my-agent', 'sessions'),
      (p, n) => n.endsWith('.jsonl'), 0, 4);

    // 行级预过滤很重要：先 includes 再 JSON.parse，
    // 否则几百 MB 的流式噪声会把首次扫描拖死
    const records = await scanWithCache(files, (o, st) => {
      if (o.type !== 'assistant') return null;
      const u = o.usage; if (!u) return null;
      return norm({
        t: toMs(o.ts),                 // 一律毫秒
        m: u.model || 'unknown',
        i: num(u.input), o: num(u.output),
        cr: num(u.cacheRead), cw: num(u.cacheWrite),
        r: num(u.reasoning),           // 展示用；是否计入总量由 norm 决定
        c: u.costUsd,                  // 已知真实成本可选传，优先于单价折算
        s: o.sessionId || path.basename(st.file, '.jsonl'),
      });
    }, null, ctx.stats, hasAny('"usage"'));

    return { records, sessions: {}, note: '' };
    // note 用于说明口径妥协，例如"早期文件已清理，此处取自官方按天统计"，UI 会显式提示
  },
}
```

要点：

- **必须走 `norm()`**：它负责过滤 0 值、统一字段、保证"总量 = i + o + cr + cw"。
- **必须累加 `ctx.stats`**：非文件型数据源（SQLite、解压流）要手动 `stats.files++` / `stats.bytes +=`。
- **跨平台路径**用文件顶部已有的 `dataCandidates(name)`，别写死 `%APPDATA%`。
- **二进制/压缩格式**：Node 22 内置 `zlib.zstdDecompressSync`（多帧要按 magic 切帧）、
  `zlib.brotliDecompressSync`、`zlib.gunzipSync`；SQLite 用 `require('node:sqlite')` 的只读模式。
- **跨源重复**：如果同一个会话会被两个适配器都扫到，参考 Claude Desktop / Claude Code 的
  `collectClaims()` 做法——先收集被认领的会话 id，让另一个适配器排除。

## 第四步：自检与验证

```bash
node server.js --doctor    # 路径是否存在、各源读到多少条
node server.js --once      # 逐源统计 + 主要模型
```

对账建议：拿该工具自己显示的用量（如 Claude Code 的 `/stats`、各家面板）跟本项目对一次，
数量级差很多通常就是**重复计数**或**漏采目录**。

## 第五步：回来补文档

**这一步不能省。** 在 [data-sources.md](data-sources.md) 里补一节，至少写清：

- 所有已知路径（含跨平台变体、桌面版与 CLI 版差异、可覆盖的环境变量）
- 用量字段的确切 JSON 路径
- `total` 的构成（缓存/推理是否独立）
- 去重规则与踩过的坑
- 本机实测数字（便于回归对比）

并同步更新 `README.md` 的支持列表与 `docs/units.md` 的映射表。
