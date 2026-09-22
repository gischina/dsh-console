# 更新日志

本项目的版本号写在根目录 `VERSION` 文件（如 `0.1.5-rc.2`），
格式遵循 [语义化版本](https://semver.org/lang/zh-CN/)；
生产包名与产物目录都带这个版本号（`dist.cmd` 打包时读取）。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [Unreleased]

### 新增
- `.github/PULL_REQUEST_TEMPLATE.md`：PR 自查清单（零依赖铁律、回归项、
  `.cmd` 编码、`app.js` 铁律、本机状态文件不得入库）
- `.github/ISSUE_TEMPLATE/config.yml`：关闭空白 Issue，把安全漏洞引导到
  `SECURITY.md` 的邮件通道（避免漏洞细节被公开贴在 Issue 里）
- `.github/workflows/ci.yml`：持续集成，只跑**不需要 DSH 就能判定**的检查
  （语法检查 / 打包完整性 / 无 DSH 起服务烟测 / 入库守卫）
- `.editorconfig`：`.cmd` 必须 CRLF、Markdown 保留行尾空格
- README 徽章：CI / 许可 / 版本 / Node 版本 / 零依赖

### 说明
- **CI 的覆盖边界**（实测得出，不是估计）：`render-all.mjs` 会把页面里的请求
  转发到 `127.0.0.1:3081`、`page-audit.mjs` 的端点探测要活的 DSH 会话、
  `test-api.mjs` 要真令牌、`cdp-chat-check.mjs` 要本机 Edge 的 CDP ——
  这四项都无法在 CI 里判定，发版前仍需在跑着 `dsh web` 的机器上完整跑一遍

### 变更
- 移除内部资料 `docs/chat-parity.md`（上游对话流对照）与 `tools/dump-endpoints.mjs`
  （DSH 端点导出），并加入 `.gitignore`，不再随仓库分发
- README 简介重写：先说清「DSH Console 是一个 DSH 控制台」与它能做什么，
  再说明它不是替代 DSH 而是 DSH 的增强（内容由 DSH 实时提供），
  最后落到用它把一个智能体应用从配置到跑起来的实际价值
- README「数据来源原则」措辞调整为「最后一次成功探测结果的落盘快照」

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
