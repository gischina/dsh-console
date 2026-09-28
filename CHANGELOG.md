# 更新日志

本项目的版本号写在根目录 `VERSION` 文件（如 `0.1.5-rc.2`），
格式遵循 [语义化版本](https://semver.org/lang/zh-CN/)；
生产包名与产物目录都带这个版本号（`dist.cmd` 打包时读取）。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [Unreleased]

### 新增
- **Skills 管理页接入技能管理插件（@weibaohui/skills-management）**：页面改为四个页签
  「📦 已安装 / 🛍️ 市场 / 🗂️ 执行器 / ⚙️ 本机配置」——
  - **已安装**：DSH 用户库（`~/.dsh/skills`）技能清单，每张卡标注 ≈token 注入开销、
    文件数 / 体积、修改时间；详情弹窗含 SKILL.md 元数据 + 正文预览 + 依赖文件清单
  - **市场**：插件内置 ntd 技能市场（6400+）按来源（47 个）过滤 + 关键词搜索、分段渲染；
    一键安装（已存在时确认后覆盖）；顶部横条显示市场仓库状态（地址 / 分支 / 是否落后 /
    上次同步）并可手动同步
  - **执行器**：本机 17 个 coding agent 技能目录汇总（可自定义），点行下钻看全量技能，
    其他执行器的技能一键「收编到 DSH」，dsh / agents 根内可切「模型可调用」
    （写 dsh 原生 `disable-model-invocation` frontmatter 键）
  - 插件未安装时前三个页签不出现、给出安装引导（探测依据
    `GET /skills-management/api/market/status`），「本机配置」（原整页内容）照常可用
- `server.cjs` 新增 Skills 管理通道：`/api/skmg/<子路径>` 等价转发插件 API
  （GET/POST/PUT/DELETE 原样透传、query 与 JSON 体带过去、不设超时、401 就地重认证）、
  `GET /api/skmg-status` 可用性探测 —— 与 `/api/mcpc`、`/api/kb/*` 同一思路：
  控制台只铺通道与外壳，数据全部来自本机已装插件，不落第二份拷贝
- 「系统状态 → 全模块自检」新增 Skills 管理插件检查项（标 `opt`：未安装只提示不判死）
- **README 新增「Skills 管理（@weibaohui/skills-management 插件）」章节**
  （仿 MCP 连接器一节体例）：插件能力清单、安装方式（插件市场或
  `dsh plugin --profile web add @weibaohui/skills-management`）、四个页签用法、
  与「本机配置」的关系，附三张界面示例图
  （`docs/images/skills-{market,manager,executors}.png`）；顶部画廊、「功能页面」表、
  「控制台自有接口」表同步加了入口
- **MCP 服务页接入 MCP 连接器（dsh-mcp-connector 插件）**：页面改为四个页签
  「🔗 已连接 / 🛍️ 市场 / 🧰 工具 / ⚙️ 本机配置」——
  - **市场**：连接器目录按分类浏览 + 关键词搜索（卡片带图标、鉴权方式、连接状态；
    图标经控制台通道代理），免凭据一键「连接」、凭据型弹表单、OAuth 型交由插件拉起授权
  - **已连接**：每条连接可 🩺测活 / 🧰列工具（真实 tools/list）/ ✏️改名 / ⚙️编辑配置
    （敏感值以 `<KEEP>` 保留标记沿用，不回显）/ ⏸停用 / ✂️断开；顶部汇总正常/需处理/已停用
  - **➕ 添加连接**：导入 mcpServers JSON（格式化 + 示例）、手动配置（Streamable HTTP / stdio，
    鉴权 none / Bearer / API-Key、静态 headers、私网直连开关）、从 URL 安装连接器目录
  - **工具**：跨全部连接搜索工具（含参数 schema 详情、缓存时效标注、按连接筛选、分页）
  - 顶栏：➕添加连接 / 🩺全部测活 / 🔄刷新目录 / 📤导出脱敏配置；版本横条显示插件版本与
    「检查更新」；插件状态有 SSE 实时推送，连接变更自动刷新
  - 插件未安装时前三个页签不出现、给出安装引导（探测依据 `GET /mcp-connector/ui/`），
    「本机配置」（原整页内容：cordis.patch.yml 解析 + TCP 探测 + MCP 握手）照常可用
- `server.cjs` 新增 MCP 连接器通道：`POST /api/mcpc` 等价转发插件白名单 API（不设超时，
  OAuth 授权要等人操作）、`GET /api/mcpc-status` 可用性探测、`GET /api/mcpc-ui/*` 静态资源
  （市场卡片 svg 图标）、`GET /api/mcpc-events` SSE 状态流直通 —— 与 `/api/kb/*` 同一思路：
  控制台只铺通道与外壳，数据全部来自本机已装插件，不落第二份拷贝
- 「系统状态 → 全模块自检」新增 MCP 连接器检查项（标 `opt`：未安装只提示不判死）
- **内置默认本地 MCP（GeoScene Pro）**：页面内置与 DSH「MCP 选项 → Studio 连接配置方式」
  一致的默认模板 `{"mcpServers":{"GeoScenePro":{"command":"StartGeoSceneMcp"}}}` ——
  无连接时空状态给「🏠 启用默认本地 MCP」一键按钮，顶栏在默认连接缺失时也给同款入口，
  「添加连接 → 导入 JSON」附默认模板填充；清单中对 GeoScenePro 连接显示「默认」标
  （按 key/名称识别，改名后仍认得出）。添加仍走插件 `importJson`（导入即实测、失败不保存），
  控制台不落第二份配置
- **README 新增「MCP 连接器（dsh-mcp-connector 插件）」章节**（仿「知识库」一节体例）：
  插件能力清单、安装命令（`dsh plugin --profile web add dsh-mcp-connector` + 升级与重启须知）、
  控制台侧零配置的四个页签用法、默认本地 MCP 入口、两套 MCP 机制的关系，
  附四张界面示例图（`docs/images/mcp-{market,connected,tools,add}.png`，
  由 `tools/shot-page.mjs` 产出）；顶部画廊与「功能页面」表同步加了入口

### 修复
- **知识库集成（第三方插件 dsh-knowledge）**：DSH 装了该插件后，控制台多出
  「知识库」（`#/knowledge`）与「本地模型」（`#/knowledge/models`）两个页面，
  装载插件自带的管理界面（不维护第二份）；未装时显示引导卡，其余功能不受影响
- `server.cjs` 新增知识库通道：`/api/kb/*` 等价转发 DSH 的 `/knowledge/*`
  （请求体原样转发、不设超时、长任务中止可传递）、`/api/kb-status` 可用性探测、
  `/api/kb-client.js` 运行时取回插件界面代码、`/api/kb-react` 提供内置 React 运行时
- `public/react/`：构建期从 DSH 前端产物抽取的 React 运行时
  （`tools/extract-react-runtime.mjs` 生成、`tools/verify-react-runtime.mjs` 校验；
  打包脚本会把它带进生产包，缺失时报错）
- `tools/shot-page.mjs`：Edge headless + CDP 的页面截图工具（README / docs 的界面截图用它生成）
- README / `docs/deploy.md` 新增「知识库（dsh-knowledge 插件）」说明与知识库截图

### 修复
- `server.cjs` 解析 `--dump-config` 输出时丢掉**不带引号的插件名**——第三方插件层
  （如 `dsh-knowledge`）因此整层不可见；正则改为引号可选
- 知识库 / 本地模型页面反复重绘导致的「闪动」：首次探测结果回来后才画第二遍；
  插件挂载点 `#kbhost` 登记 `DOM_OWNED`，重绘不再拆掉插件已渲染的界面
- **知识库面板整屏覆盖、锁死控制台，且鼠标划过面板外区域整页闪**：插件面板根
  自带**内联** `position:fixed;inset:0` —— 那是原生 DSH 的浮层语义（面板从侧栏
  按钮调出、盖满整个视口），在控制台里直接内嵌就成了：进页面即被锁死
  （侧栏/顶栏全被面板盖住，✕ 是唯一出口），指针扫过面板底下仍在响应 `:hover`
  的外壳，过渡反复合成，看着就是整页在闪。宿主样式把面板根中和成
  `position:absolute;inset:0`（以页面舞台为包含块，舞台高度按
  「舞台顶→内容区底」实测校准，挂载后与窗口变化时都会重算）：
  面板恰好填满内容区，侧栏/顶栏恢复可见可点，闪动根源消除
- **知识库面板 ✕ 关闭后无法再进入**：✕ 会把整棵界面从宿主卸掉（实测
  `#kbhost` 变成 0 个子节点），而宿主 DOM 节点没换、重复点击同一侧栏链接
  又不触发重绘，页面从此空白。装载器现在对「宿主被清空」自愈重装，
  并支持在知识库页**再点一次侧栏「📚 知识库」**重新拉起面板
  （切到别的页再切回来同样有效）
- **本地模型页内容显示不全**：挂载点之前被写死高度并装进 `overflow:hidden` 的卡片里，
  插件设置块（实测约 1341px 高）被裁掉且无处滚动；改为舞台随内容长高、
  滚动交给内容区，全文可达
- **知识库页右上角「全部」下拉的选项文字不可见**：插件把选项写成
  「复选框 + `flex:1 1 0%` 的文字 span」，复选框在宿主环境里没有确定的主尺寸，
  文字 span 被算成 0 宽再被 `overflow:hidden` 裁掉。宿主侧给面板内的复选框
  补上确定的 `flex-basis`，选项文字恢复显示（颜色本就正确，是宽度问题）
- 知识库插件的**主题令牌桥接补齐**：插件用到的 `--dsw-alias-*` 令牌全部映射，
  插件界面不再深浅色混杂
- 知识库插件拿到的 `workspaces` 服务补上 `pickDirectory` / `openPath`
  （模型缓存目录选择、打开目录依赖它们）
- **知识库插件拿到的「当前目录」恒为空**：宿主把它当成控制台顶层状态里的
  一个字段来读，而那里根本没有这个字段（会话自带 `cwd`，宿主也带 `cwd`），
  于是永远取到 `undefined`；改为按控制台别处同一口径
  「会话 `cwd` → 宿主 `cwd`」取值
- **内容区顶部的「会话上下文条」占高**：原来是一条固定 43px 的独立横条，
  含「当前会话 / 智能体预设 / 工作目录 / 运行状态」四块，出现在 10 个页面上、
  占内容区约 5% 高度，而其中只有「当前会话」是这些页面正文没有的信息
  （预设与工作目录在各自页面的正文里已经写明）。改为只保留「当前会话」，
  并把它压进各页页头标题行右侧 —— 横条消失，内容区高度全部还给页面
- 「本地模型（用于知识库）」不再单列在侧栏「平台设置」下：它只服务于知识库，
  与对话模型并列容易误解。入口保留在知识库页右上角的「🧩 本地模型」按钮
  （路由仍在，只是不进侧栏与跳转列表）
- **各页常驻的「模块说明」提示条大幅收敛**：这类固定横条恒常驻、不受
  「显示本页说明」开关控制，而内容大多与「本页说明」卡重复，白占首屏。
  按「状态 / 报错 / 操作指引」与「纯解释性文案」区分：前者保留，后者把要点
  并进对应页的「本页说明」卡后删除。原 11 处收敛到 3 处 —— 保留下来的 3 处
  全部是**条件出现**的状态提示（地址非法已回首页、当前会话不属于任何工作空间、
  服务端检索未启用时「筛选在本地完成」），本来就不是常驻块；
  删掉的 8 处是智能体预设 / 大模型 / MCP / 凭据 / 设置 / 工作空间 / 交付物 / 工作流。
  说明卡默认收起、受开关统一管辖
- **知识库页不再显示插件自带的 ✕**：插件面板右上角那个 ✕ 是原生 DSH 的浮层
  退出语义（面板调出后关掉它）。控制台里知识库是一个**页面**，退出靠侧栏导航，
  面板内再放一个 ✕ 反而像"这是个弹窗"，点了还会清空面板。控制台侧用样式隐藏
  该按钮（面板内其余按钮不受影响，插件文件不改）

### 文档
- README 与 `docs/deploy.md` 同步代码现状：页面 / 自检 / 插件 / 端点等处不再写死
  会随版本过期的实测数字；目录结构与产物清单补 `public/react/` 与新增工具脚本

## [0.1.5-rc.3] - 2026-09-23

维护者配套与文档一致性修复。**本次不涉及代码改动**（`server.cjs` / `public/app.js` 未修改），
发这个版本是为了让「内置对接 GeoScene Pro」在**生产包内那份说明书**（源文件 `docs/deploy.md`）里也生效。

### 新增
- `.github/PULL_REQUEST_TEMPLATE.md`：PR 自查清单（零依赖铁律、回归项、
  `.cmd` 编码、`app.js` 铁律、本机状态文件不得入库）
- `.github/ISSUE_TEMPLATE/config.yml`：关闭空白 Issue，把安全漏洞引导到
  `SECURITY.md` 的邮件通道（避免漏洞细节被公开贴在 Issue 里）
- `.github/workflows/ci.yml`：持续集成，只跑**不需要 DSH 就能判定**的检查
  （语法检查 / 打包完整性 / 无 DSH 起服务烟测 / 入库守卫）
- `.editorconfig`：`.cmd` 必须 CRLF、Markdown 保留行尾空格
- README 徽章：CI / 许可 / Node 版本 / 零依赖；**版本徽章改为读取 GitHub Release**
  （含预发布），不再把版本号写死在链接里
- README 新增「内置 GeoScene Pro MCP 对接」一节：控制台侧零配置的对接方式
  （`StartGeoSceneMcp` 启动、`127.0.0.1:11000` 探测 + 真实 `initialize` / `tools/list` 握手、
  握手结果落盘与回退规则）、DSH 侧需要一次性加载 `mcp-geoscene` 客户端实例，
  以及实测可调用的 31 个 GeoScene Pro 工具清单（按能力分 6 组）
- README 新增「DSH 是什么、从哪来」说明；「全量回归」提升为独立小节并加入目录
- `CONTRIBUTING.md` 新增「没有 DSH 时能做什么」：列出不需要 DSH 也能跑的检查
  （语法检查 / `server.cjs --check` / 打包完整性 / 起服务烟测）
- `docs/deploy.md` 新增「内置 GeoScene Pro MCP 对接」一节（含 31 个工具清单），
  并补 GeoScene 排障条目 —— 它是**生产包内那份 README 的源文件**，此前完全没提到这项能力

### 说明
- **CI 的覆盖边界**（实测得出，不是估计）：`render-all.mjs` 会把页面里的请求
  转发到 `127.0.0.1:3081`、`page-audit.mjs` 的端点探测要活的 DSH 会话、
  `test-api.mjs` 要真令牌、`cdp-chat-check.mjs` 要本机 Edge 的 CDP ——
  这四项都无法在 CI 里判定，发版前仍需在跑着 `dsh web` 的机器上完整跑一遍

### 变更
- 移除内部资料 `docs/chat-parity.md`（上游对话流对照）与 `tools/dump-endpoints.mjs`
  （DSH 端点导出），并加入 `.gitignore`，不再随仓库分发
- README 简介重写：先说清「DSH Console 是一个 DSH 控制台」与它能做什么
  （含内置对接 GeoScene Pro MCP），再说明它不是替代 DSH 而是 DSH 的增强
  （控制台自己不存数据，内容全部来自 DSH 的实时接口），
  最后落到用它搭建一个时空智能体应用的实际价值
- README「关于 GeoScene（可选）」改为「关于 GeoScene」，口径由「不是必需的」
  统一为「内置对接」
- README「数据来源原则」措辞调整为「最后一次成功探测结果的落盘快照」

### 修复（文档一致性）
- 修正三处指向**不存在章节**的引用：`CONTRIBUTING.md`、`.github/workflows/ci.yml` 注释、
  `.github/PULL_REQUEST_TEMPLATE.md` 原先指向 README 的「回归与排障」与「改 app.js 的铁律」，
  实际章节名是「全量回归」与「前端渲染约定（改 app.js 前先看这条）」
- README「排障顺序」里 `test-api.mjs` 的项数由 94 更正为 97
- README 产物清单删去会持续过期的源码体积，只保留产物体积；zip 体积更正为实测值
- README「不含」里 `docs/` 的理由更新（`docs/chat-parity.md` 已移出仓库）
- `docs/deploy.md` 磁盘占用由「约 2 MB」更正为与本包实际体积一致
- `PULL_REQUEST_TEMPLATE.md` 自查清单补上 `test-api.mjs`，与 README 的五个回归脚本口径一致

## [0.1.5-rc.2] - 2026-09-22

首个公开预览版。基于 DSH 0.1.5-rc.2 开发与回归。

### 包含
- 18 个功能页：会话对话、历史、系统状态、插件、MCP、技能、工作目录、
  交付物、设置等（完整清单见 README「功能页面」一节）
- 与原生 DSH 对话页的逐项对齐
- 本地接口：DSH 状态 / plugins / mcp / skills / fs / 交付物下载 / 附件
- 部署自检（`check.cmd` / `node server.cjs --check`，8 项）
- 回归套件：test-api / page-audit / render-all / sandbox-render / cdp-chat-check
- 生产打包 `dist.cmd`：清空重建 + terser 压缩混淆 + 版本号命名 + 产物自检
  （防令牌与本机路径泄漏）

### 已知边界
- 混淆为「安全混淆」：不混淆顶层函数名（100+ 处 inline onclick 按名调用），
  定位是「不可读、不好改」，不是「不可逆向」
- 仅绑定 127.0.0.1，定位为本机工具，不提供多用户/公网部署能力
