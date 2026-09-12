# 参与贡献

## 这个项目最需要的是什么

**数据源覆盖度。** 代码本身很小（一个零依赖 Node 服务 + 一个单文件前端），
真正的价值在 [docs/data-sources.md](docs/data-sources.md)：每个 Agent 的用量到底存在哪、
字段叫什么、有哪些坑。所以最有价值的 PR 是：

1. 新增一个 Agent 适配器（流程见 [docs/adding-an-adapter.md](docs/adding-an-adapter.md)）；
2. 修正某个 Agent 在你机器上的路径差异（尤其是 macOS / Linux，以及桌面版与 CLI 版目录不同）；
3. 修正计量口径（缓存、推理是否已含在总量里，这类错误最隐蔽也最致命）。

## 开发

```bash
node server.js            # 起服务，http://127.0.0.1:3457
node server.js --once     # 命令行打印各源统计
node server.js --doctor   # 自检候选路径与读取结果
TOKEN_VIEWER_PORT=3458 node server.js   # 换端口
```

无构建步骤、无依赖安装、无 lint 配置。改完 `node --check server.js` 确认语法，
再跑 `--doctor` 和 `--once` 看数字有没有异常变化。

## 提交前请自查

- [ ] `node server.js --doctor` 里你改动的源仍是 `✓`
- [ ] `--once` 的合计与改动前对比，量级没有异常翻倍或暴跌（翻倍通常是重复计数）
- [ ] 没有引入任何 npm 依赖（这是本项目的硬约束：只用 Node 内置模块）
- [ ] 没有对用户的会话目录做任何写操作
- [ ] 同步更新了 `docs/data-sources.md` / `docs/units.md` / `README.md` 中受影响的部分

## 报告"某个 Agent 没数据"时请附上

```bash
node server.js --doctor
```

的完整输出。绝大多数"没数据"其实是路径问题（工具把数据放在目录名不含产品名的地方），
有了 doctor 输出就能直接定位。

## 边界

- 不做云端同步、不加遥测、不联网请求任何资源（前端图表全部手写 SVG，不加载 CDN）。
- 不猜测模型价格：单价一律由用户填写，未计价就显示未计价。
- 数据被工具自身清理导致无法回补的部分，宁可标注说明，也不编造数字。
