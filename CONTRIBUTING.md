# 贡献指南

感谢关注 DSH Console！欢迎 Issue 与 Pull Request。

## 提交 Issue

- 先搜一遍已有 Issue，避免重复。
- 报 Bug 请附上：`check.cmd`（或 `node server.cjs --check`）的完整输出、
  复现步骤、预期与实际行为。**不要**粘贴 `dsh-config.json`（含访问令牌）。
- 功能建议请说明使用场景，最好附上你期望的交互方式。

## 提交 Pull Request

1. 从 `main` 拉分支，一个 PR 只做一件事。
2. 本项目**零第三方依赖**：只用 Node 内置模块，不引入 `package.json`、
   不引入构建步骤。请保持这一约定。
3. 提交前请跑一遍回归（详见 README「回归与排障」一节）：
   ```powershell
   node server.cjs --check
   node tools/test-api.mjs
   node tools/page-audit.mjs
   node tools/render-all.mjs
   ```
   推上去之后 GitHub Actions 会自动跑**不需要 DSH 的那部分**（语法检查、渲染回归、
   打包校验、起服务烟测）。**CI 绿不等于全绿** —— `test-api.mjs` 与 `page-audit.mjs`
   的端点探测要真机上的 `dsh web`，CI 里跑不了，请自己确认末行是 `DONE fails=0`。
4. 两个 `.cmd` 必须保持**纯 ASCII + CRLF**（原因见 README 目录树一节的警告）。
5. 改动 `public/app.js` 的交互逻辑时，注意 README 里「改 app.js 的铁律」
   一节列出的约束（paintOnly 渲染、DOM_OWNED 登记等）。

## 许可

提交即表示你同意依 [Apache License 2.0](LICENSE) 授权你的贡献
（详见 LICENSE 第 5 条）。
