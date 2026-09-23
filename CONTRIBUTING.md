# 贡献指南

感谢关注 DSH Console！欢迎 Issue 与 Pull Request。

## 提交 Issue

- 先搜一遍已有 Issue，避免重复。
- 报 Bug 请附上：`check.cmd`（或 `node server.cjs --check`）的完整输出、
  复现步骤、预期与实际行为。**不要**粘贴 `dsh-config.json`（含访问令牌）。
- 功能建议请说明使用场景，最好附上你期望的交互方式。

## 没有 DSH 时能做什么

18 个页面的数据全部来自 DSH，没有它很多功能验证不了。但下面这几件事**不需要 DSH**，
改完代码至少能先自证不炸：

```powershell
node --check server.cjs                         # 语法：两个入口文件能否被解析
node --check public/app.js
node server.cjs --check                         # 部署层前提自检（Node 版本 / 产物 / 端口 / DSH 可达性）
node tools/make-dist.mjs --no-mangle --no-zip   # 打包完整性（含令牌与本机路径泄漏守卫）
```

起服务烟测（无 DSH 时也应能启动，首页与本地接口都该回 200）：

```powershell
$env:CONSOLE_PORT = 3099; node server.cjs
```

这几项正是 GitHub Actions 在 CI 里跑的那部分。要跑完整回归（`test-api` / `render-all` /
`page-audit`），本机得先有 DSH —— 用 `npx @deepseek-ai/dsh web` 拉起即可，见 README 第 3 节。

## 提交 Pull Request

1. 从 `main` 拉分支，一个 PR 只做一件事。
2. 本项目**零第三方依赖**：只用 Node 内置模块，不引入 `package.json`、
   不引入构建步骤。请保持这一约定。
3. 提交前请跑一遍回归（详见 README 第 6 节「全量回归」）：
   ```powershell
   node server.cjs --check
   node tools/test-api.mjs
   node tools/page-audit.mjs
   node tools/render-all.mjs
   ```
   推上去之后 GitHub Actions 会自动跑**不需要 DSH 的那部分**（语法检查、
   打包完整性校验、起服务烟测、入库守卫）。
   **CI 绿不等于全绿** —— `test-api.mjs` / `page-audit.mjs` / `render-all.mjs`
   都要真机上跑着 `dsh web`（`render-all` 会把页面里的请求转发到 `127.0.0.1:3081`），
   CI 里跑不了，请自己确认末行是 `DONE fails=0`。
4. 两个 `.cmd` 必须保持**纯 ASCII + CRLF**（原因见 README 目录树一节的警告）。
5. 改动 `public/app.js` 的交互逻辑时，注意 README 里「前端渲染约定（改 app.js 前先看这条）」
   一节列出的五条约束（`paintOnly` 渲染、`DOM_OWNED` 登记、输入框的值存进 `State` 等）。

## 许可

提交即表示你同意依 [Apache License 2.0](LICENSE) 授权你的贡献
（详见 LICENSE 第 5 条）。
