# Token Viewer 项目约定

- 扫描服务和网页零运行依赖：服务端只用 Node 内置模块，前端单文件 HTML 与手写 SVG；不加载外部资源、遥测或 CDN。桌面构建使用 Electron 与 electron-builder，固定版本并提交 lockfile。
- 只读原始 Agent 会话和数据库；网页版缓存与计价配置写本项目目录，桌面版写 `%APPDATA%/Token Viewer`，禁止把本机缓存或计价配置打进分发包。
- server.js 负责数据源扫描、计量归一、缓存与 HTTP；index.html 负责聚合、图表和交互。
- Mirage 只读取 `~/.mirage`；不读取或合并 Proma / Proma Dev 数据。适配器 id 为 `mirage`。
- Codex 累计用量先按实际线程 id 分组，再跨文件选最大累计；忽略继承的父线程历史。标题优先读索引和只读状态库，缺失时用真实用户输入；无用户输入的子 Agent 用任务名与昵称，不显示宿主上下文。
- 保留暖白底、橙色强调、衬线数字的既有风格；读数和图表保持稳定，短动画仅用于状态与操作反馈，支持 prefers-reduced-motion。
- 修复数据源时同步 docs/data-sources.md 与 docs/units.md 的相关说明；不根据文本伪造官方用量。
- 验证：node --check server.js、node --test、node server.js --doctor、node server.js --once；前端改动还需检查脚本语法和浏览器实际画面。
- 本地日志含私人对话，调试输出仅汇总字段、数量与缺失情况，不复制对话正文。
- desktop/main.cjs 负责 Electron 窗口和专属后台子进程；UI 始终复用 index.html，后台复用 server.js。窗口关闭后必须退出后台；随机 loopback 端口与每次启动随机 API 凭证，渲染器不开启 Node。
- 桌面构建：npm ci、npm run build:desktop；scripts/prepare-runtime.cjs 从 Node.js 官方下载并校验 SHA-256，附 Node LICENSE。验收 unpacked 与实际安装版启动、完整 UI、配置持久化与关闭清理。

- 桌面标题栏用暖白原生窗口控件覆盖层，菜单经 sandbox preload 的唯一 openMenu 动作弹出；不暴露通用 IPC。内容区最大1800px，动效可中断，悬停仅精细指针开启。
- 760–1080px 是桌面紧凑布局：摘要与占比排名并列，指标2×2，首屏可见Agent明细。宽屏保留环图，390px不得横向溢出。
- Agent 卡按 data-agent-id 复用，重排用独立 translate 衔接当前帧；趋势仅淡入，数据源展开保留 details/summary 语义。新动效统一支持即时取消与减少动态效果。
- 页面图标内嵌PNG保持单文件可移植；桌面PNG与Windows多尺寸ICO对应同一折纸T设计。
- 启动默认今日；自然日与昨日同期按本地日历计算，不用固定24小时回溯。仅按日统计（claude-stats）计入日总量，但排除小时级同期比较；零基数显示无同期记录。
- 最近七天趋势独立于主筛选，今日为未结束的部分日期；预估成本仅计已计价记录。日期按钮支持键盘与按日筛选；图例与扇区联动，路由标题衔接须可取消并清理节点。
- DeepSeek 官方桌面端与 CLI 共用 `DSH_HOME` / `~/.dsh`；识别版本化会话 v0–v4，每目录选最高代际。排除继承前缀、流式回声与跨路径副本；zstd 帧先拼字节再解 UTF-8，缓存写入优先 cacheWriteTokens。
- 总览模型排名按原始模型标识跨 Agent 汇总，跟随主时间筛选，与摘要四类 Token 总量一致；前10名可展开全部，来源按钮可进入 Agent。模型行复用、重排/条形/数字动效可中断，减少动态效果立即完成。
- Claude Code按工作类型包含CLI和桌面Code；Claude Desktop来源为Cowork。两者共享一次只读扫描，不能因桌面声明排除主projects日志后又不读取；台账surface显式分流、同请求最大完整usage去重。重叠台账/逐请求按会话/日/model取更完整覆盖，旧stats-cache仅补正余额，整数拆分守恒并显示历史截止日期；记录计数不冒充请求次数。
- 模型排名头部保留稳定的展开与时间操作栏，时间入口共用 S.range；用户在排名处筛选后保持标题锚点与焦点。展开高度过渡从当前帧接续，支持中途反向及减少动态效果立即清理；宽屏、820/960和390px均验证按钮中心真实命中。
