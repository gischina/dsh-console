# DSH Console — Pull Request
# Copyright 2026 liwei (易智瑞西安) <liwei@geoscene.cn>
# SPDX-License-Identifier: Apache-2.0
#
# 提交前请先读 CONTRIBUTING.md。CI 会跑不需要 DSH 的那部分回归，清单里的项请自己确认。

## 这个 PR 做了什么

<!-- 一句话说清。一个 PR 只做一件事；做了两件事请拆成两个 PR。 -->

## 类型

- [ ] 修复 Bug
- [ ] 新增功能
- [ ] 文档 / 注释
- [ ] 重构 / 清理死代码
- [ ] 其他：

## 自查清单

- [ ] 从 `main` 拉的分支，PR 只做一件事
- [ ] **没有引入第三方依赖**：未新增 `package.json`、未加构建步骤、只用 Node 内置模块
- [ ] `node server.cjs --check` 全绿
- [ ] `node tools/test-api.mjs` 末行是 `DONE fails=0`（下面三项都要本机跑着 `dsh web`，CI 里跑不了）
- [ ] `node tools/render-all.mjs` 末行是 `DONE fails=0`
- [ ] `node tools/page-audit.mjs` 末行是 `DONE fails=0`
- [ ] 没有提交本机状态文件：`plugins.json` / `mcp-tools.json` / `dsh-config.json` / `ui-prefs.yaml`

### 按改动范围勾选

- [ ] **改了 `public/app.js` 的交互逻辑** → 已遵守 README「前端渲染约定（改 app.js 前先看这条）」
      （纯状态交互用 `paintOnly` 渲染；加载器直写的区域登记进 `DOM_OWNED`；输入框的值存进 `State`）
- [ ] **改了 `start.cmd` / `check.cmd`** → 仍是**纯 ASCII + CRLF**（`Get-Content -Raw` 或编辑器右下角确认）
- [ ] **改了页面文案 / 路由 / 自检项** → README 的目录树、功能清单与「数据来源」描述已同步
- [ ] **改了 `server.cjs` 的接口** → README 的端点表已同步，且 `tools/page-audit.mjs` 的探测仍通过
- [ ] **改了打包相关（`tools/make-dist.mjs` / `VERSION`）** → 已跑 `node tools/make-dist.mjs` 打包验证通过

## 关联 Issue

<!-- 例：Closes #12 -->

## 补充说明

<!-- 截图、取舍理由、"为什么没用另一种做法"。有行为变化的请写清前后差异。 -->
