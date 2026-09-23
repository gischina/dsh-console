# DSH 控制台 —— 离线一体包部署说明

> 这是**离线一体包**：已内置 Node.js、DSH，以及**构建机上的 DSH profile（已装插件）**。
> 目标机**不需要**预装 Node / `npm install` / 预先启动 `dsh web`。
> 构建机打包时需要联网（下 Node、装 `@deepseek-ai/dsh`）；**使用本包时可完全离线**（调外部模型 API 除外）。

---

## 1. 前置条件

| 项 | 要求 |
|---|---|
| **操作系统** | **Windows x64**（本包 runtime 为 win-x64） |
| **Node.js** | **不必安装**（使用 `runtime\node\`） |
| **DSH** | **不必安装**（使用 `runtime\dsh\`，启动时自动拉起） |
| **插件** | **已打进包内**（`runtime\dsh-home\profiles\<profile>\`） |
| 磁盘 | 约数百 MB（含 Node + DSH + 本机插件 node_modules） |

---

## 2. 启动

1. 解压本包到任意目录。
2. **双击 `start.cmd`**（会设置 `DSH_HOME=runtime\dsh-home`）。
3. 等待自动拉起 DSH 并打开浏览器：**http://127.0.0.1:3081**

> ⚠️ 不要直接双击 `public\index.html`。

---

## 3. 包里有哪些「本机插件」

DSH 的用户插件装在构建机的：

```text
%USERPROFILE%\.dsh\profiles\web\
  package.json          ← 插件依赖与 bundles 清单
  cordis.patch.yml      ← 补丁配置（含 MCP 等）
  node_modules\         ← 实际的 npm 插件包
```

`dist-offline.cmd` 默认把上述内容拷进：

```text
runtime\dsh-home\profiles\web\
```

并在启动时设置 `DSH_HOME`，让 DSH 读包内 profile，而不是目标机空的 `~/.dsh`。

**不会打进包的（避免泄密 / 脏数据）：**

- `settings.yaml`、`.credentials.yaml`（API Key 等）
- 会话、`storages/`、`cache/`

因此目标机首次使用仍需自行配置模型凭据；**插件与 MCP 补丁配置会带过去**。

若打包时不想带本机插件：

```bat
node tools\make-dist.mjs --offline --no-profile
```

---

## 4. 停止 / 自检

- **停止**：Ctrl+C 或关闭窗口（自动拉起的 DSH 会一并结束）。
- **自检**：双击 `check.cmd`。

---

## 5. 目录说明

```
server.cjs / public/     控制台（已压缩）
start.cmd / check.cmd    启动与自检（自动使用包内 Node + DSH_HOME）
runtime/
  node/                  官方 Node.js（win-x64）
  dsh/                   @deepseek-ai/dsh
  dsh-home/              本机构建时的 profile + 已装插件
  README.txt             捆绑说明
LICENSE / NOTICE         本控制台 Apache-2.0
```

---

## 6. 许可

- 本控制台：Apache-2.0（见 `LICENSE` / `NOTICE`）
- Node.js：见 `runtime\node\LICENSE`
- DSH / 第三方插件：见各自 `node_modules` 内声明；再分发前请自行确认许可允许捆绑
