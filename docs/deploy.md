# DSH 控制台 —— 部署说明

> 这是**生产部署包**（构建产物，源码已压缩）。只需要 Node.js，不需要 `npm install`、不需要编译。

---

## 1. 前置条件

| 项 | 要求 |
|---|---|
| **Node.js** | ≥ 18（命令行执行 `node -v` 自查） |
| **DSH** | 已安装，且 `dsh web` 正在运行（本控制台是它的前端 + 反向代理，**没有 DSH 它没有内容可显示**） |
| **DSH 版本** | 本包基于 DSH **0.1.5-rc.2** 开发与回归；其他版本未测，异常时先核对 DSH 版本 |
| 操作系统 | Windows / macOS / Linux 都可以 |
| 磁盘 | 约 2 MB |

启动 DSH：
```powershell
dsh web
```
它会打印一行带 `?token=…` 的地址 —— **先不要关掉这个窗口**，控制台要用那个地址。

---

## 2. 启动

**Windows**：双击 `start.cmd`。

**其他系统 / 命令行**：
```bash
node server.cjs
```

启动后浏览器打开：**http://127.0.0.1:3081**

> ⚠️ 不要直接双击 `public/index.html` —— 那样样式和接口全都取不到，页面是空的。

换端口（默认 3081）：
```powershell
$env:CONSOLE_PORT = 8080; node server.cjs      # Windows PowerShell
```
```bash
CONSOLE_PORT=8080 node server.cjs              # macOS / Linux
```

### 首次启动要做的一件事

控制台默认连 `127.0.0.1:3080`。如果你的 DSH 在别的地址、或它要求鉴权，页面会**自动弹出配置窗**：

把 `dsh web` 打印的**整段地址**（含 `?token=…`）粘进去 → 保存。配置存在同目录的 `dsh-config.json` 里，下次不用再填。

---

## 3. 部署自检（出问题先跑这个）

**双击 `check.cmd`**，或：
```bash
node server.cjs --check
```

它逐项检查：Node 版本 / 前端产物是否齐 / 端口占用 / DSH 是否可达 / `dsh` 命令是否在 PATH / 是否已配置访问令牌，并给出中文结论。输出可以直接复制给人排查。

**首次部署时，下面这两项"报错"是正常的**，不是故障：

1. `dsh-config.json` 不存在 —— 还没配置过，填一次就好；
2. 「DSH 要求浏览器会话鉴权」—— 同上，把 `dsh web` 的地址粘进配置窗即可。

---

## 4. 停止 / 常驻

- **停止**：在运行窗口按 `Ctrl+C`。
- **后台常驻（Linux/macOS）**：
  ```bash
  nohup node server.cjs > console.log 2>&1 &
  ```
- **开机自启（Windows）**：把 `start.cmd` 放进「启动」文件夹，或用任务计划程序。

---

## 5. 目录里都是什么

```
server.cjs       唯一后端：静态页面 + 反向代理 + WebSocket 桥（零第三方依赖）
public/
  index.html     页面骨架
  app.js         界面全部逻辑（已压缩）
  style.css      样式
start.cmd        Windows 启动器（双击即用）
check.cmd        Windows 部署自检（双击即用）
README.md        本文件
LICENSE          Apache-2.0 许可证（随分发必须保留）
NOTICE           版权与归属声明（随分发必须保留）
```

**许可说明**：本软件以 Apache License 2.0 授权，
Copyright 2026 liwei (易智瑞西安) <liwei@geoscene.cn>。
可自由使用、修改、再分发（含商用），但再分发时须随附 LICENSE 与 NOTICE；
各文件头部的 SPDX 标记（Apache-2.0）与混淆产物内的版权横幅同属声明的一部分。

**运行时会自己生成这几个文件**（都是本机数据，换机器不用拷）：

| 文件 | 说明 |
|---|---|
| `dsh-config.json` | 你配的 DSH 地址与访问令牌（**含敏感信息，别外发**） |
| `plugins.json` | 最近一次探测到的插件清单 |
| `mcp-tools.json` | 最近一次握手到的 MCP 工具清单 |
| `ui-prefs.yaml` | 这台机器上的界面显示偏好 |

> 安装目录**需要可写**（要写上面这几个文件）。只读也能启动，但设置改不了、插件页会一直报错。

---

## 6. 常见问题

**页面打开是空白 / 一直在转圈**
先看 `check.cmd` 的第 [5] 项。多半是 DSH 没在跑，或没配置访问令牌。

**`[x] Node.js not found`**
装 Node ≥ 18：https://nodejs.org

**端口 3081 被占用**
换端口：`CONSOLE_PORT=3082 node server.cjs`（Windows 用 `$env:CONSOLE_PORT = 3082`）。

**插件页 / MCP 页显示「探测失败」**
这两页依赖 `dsh` 命令在 PATH 里，以及本机 DSH 的配置目录可读。`check.cmd` 的第 [6][7] 项能看出是哪一步断的。

**想恢复默认设置**
删掉对应的生成文件即可：删 `dsh-config.json` 回到默认地址；删 `ui-prefs.yaml` 界面全部回到默认显示。

---

## 7. 安全提示

- 控制台**只监听 `127.0.0.1`**，局域网内其他机器访问不到 —— 这是刻意的，它相当于 DSH 的完整控制面板，不要暴露到公网。
- `dsh-config.json` 里的访问令牌等同于 DSH 的操作权限，**不要把这个文件发给别人**、也不要提交到代码仓库。
- 本目录是构建产物：**`app.js` 已删除注释、压缩并混淆了局部变量名**。请注意这只是提高阅读门槛，JS 是明文运行的，**不构成加密**，不要把它当作可以存放密钥的地方。
