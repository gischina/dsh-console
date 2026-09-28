# DeepSeek Harness（DSH）安装、卸载与升级操作手册

本文按两部分说明：

- **DSH 本体**：命令行程序 `@deepseek-ai/dsh`，负责启动 Harness 服务、会话和插件。
- **DSH Console**：本仓库提供的控制台，通过浏览器连接 DSH 服务。它不是 DSH 本体，也不包含原生 Windows/macOS 桌面安装包。

Windows 命令以 **PowerShell** 为主。GeoScene Pro MCP 场景尤其要从 PowerShell 启动 `dsh web`，不要从 Git Bash 启动。macOS/Linux 命令在对应小节给出。

## 1. 前置检查

DSH Console 要求 Node.js 18 或更高版本；全局安装 DSH 也需要 Node.js 和 npm。PowerShell 中检查：

```powershell
node -v
npm -v
```

如果命令不存在，请先安装 Node.js LTS，再重新打开 PowerShell 验证。控制台自身没有 `package.json`，不需要对控制台执行 `npm install`。

## 2. 安装 DSH 本体

### 方式 A：全局安装（常用）

```powershell
npm install --global @deepseek-ai/dsh
dsh --version
Get-Command dsh
```

若 PowerShell 提示找不到 `dsh`，关闭并重新打开终端再试；仍找不到时检查 npm 全局可执行目录是否已加入 `PATH`：

```powershell
npm config get prefix
npm list --global --depth=0
```

### 方式 B：不做全局安装，使用 npx

每次启动时由 npm 按需取得 DSH：

```powershell
npx --yes @deepseek-ai/dsh web
```

指定使用最新发布版：

```powershell
npx --yes @deepseek-ai/dsh@latest web
```

`npx` 方式不会把 `dsh` 命令加入系统 `PATH`。它适合临时运行；如果需要在另一个终端长期管理插件或检查 DSH，推荐全局安装。控制台支持从常见 npm/npx 缓存位置查找 DSH CLI。

### 查看 CLI 帮助

```powershell
dsh --help
dsh web --help
dsh plugin --help
```

## 3. 启动与停止 DSH Web 服务

### 启动

在 PowerShell 中运行：

```powershell
dsh web
```

保持该窗口运行。DSH 通常监听本机 `127.0.0.1:3080`，启动输出中可能包含带 `?token=...` 的访问地址。首次连接控制台时，保存完整地址（包括令牌）；令牌相当于访问凭据，不要发给他人或提交到仓库。

未全局安装时：

```powershell
npx --yes @deepseek-ai/dsh web
```

确认服务是否监听（默认端口）：

```powershell
Test-NetConnection 127.0.0.1 -Port 3080
```

### 停止

在运行 `dsh web` 的窗口按 `Ctrl+C`。关闭浏览器不会停止 DSH 服务；关闭该终端或结束对应进程才会停止服务。

### macOS / Linux

```bash
dsh web
# 未全局安装时
npx --yes @deepseek-ai/dsh web
```

停止时在终端按 `Ctrl+C`。GeoScene Pro 的 Windows MCP 批处理场景不要用 Git Bash 启动 DSH。

## 4. 在 DSH 中安装或移除可选插件

控制台的知识库页面依赖可选插件 `dsh-knowledge`。在 DSH CLI 所在终端安装：

```powershell
dsh plugin --profile web add dsh-knowledge
```

如果使用 npx 启动、当前终端没有 `dsh` 命令，可先全局安装 DSH，或用 `dsh plugin --help` 查看当前版本支持的插件管理语法。插件安装后重启 `dsh web` 才会加载。

移除插件前先检查当前 CLI 的准确语法：

```powershell
dsh plugin --help
```

不同 DSH 版本的插件移除子命令可能不同；按本机帮助中列出的 `remove`/`delete` 等命令执行，不要直接手删 `~/.dsh` 下的整个目录。完成后重启 `dsh web`，再到控制台确认插件状态。

## 5. 安装并运行 DSH Console（Web 端）

### 方式 A：使用生产部署包

1. 从项目发布页取得 `dsh-console-<版本>.zip` 并解压到一个固定目录，例如 `D:\Apps\dsh-console`。
2. 确认目录内有 `start.cmd`、`check.cmd`、`server.cjs`、`public`、`LICENSE` 和 `NOTICE`。
3. 先在一个 PowerShell 窗口启动 DSH：

```powershell
dsh web
```

4. 在控制台部署目录双击 `start.cmd`，或在 PowerShell 中运行：

```powershell
Set-Location 'D:\Apps\dsh-console'
node server.cjs
```

5. 浏览器访问 `http://127.0.0.1:3081`。首次运行若提示配置 DSH 主机，把 `dsh web` 输出的完整地址（含 `?token=...`）粘贴并保存。

部署自检：

```powershell
Set-Location 'D:\Apps\dsh-console'
node server.cjs --check
```

或双击 `check.cmd`。不要直接双击 `public\index.html`，控制台需要 Node 服务提供页面和 API 代理。

### 方式 B：从源码运行

```powershell
git clone https://github.com/gischina/dsh-console.git
Set-Location .\dsh-console
node server.cjs
```

打开 `http://127.0.0.1:3081`。如需从已有源码工作区更新，先查看并保留本地修改，再执行 `git pull`；源码版不需要 `npm install`。

### 修改控制台端口

默认端口为 3081。PowerShell 当前窗口临时改为 3082：

```powershell
$env:CONSOLE_PORT = '3082'
node server.cjs
```

之后访问 `http://127.0.0.1:3082`。新开终端后该环境变量不会保留。macOS/Linux：

```bash
CONSOLE_PORT=3082 node server.cjs
```

## 6. 桌面端使用

本仓库没有独立的 `.exe`、`.msi`、`.dmg` 桌面客户端。桌面使用方式是先运行 DSH 和 DSH Console，再用桌面浏览器访问本机控制台；可选用浏览器的“安装此网站为应用”功能，让它以独立窗口打开。

### 普通桌面浏览器

先分别启动 `dsh web` 和 `node server.cjs`（或双击 `start.cmd`），然后：

```powershell
Start-Process 'http://127.0.0.1:3081'
```

### Edge 应用窗口

```powershell
Start-Process msedge -ArgumentList '--app=http://127.0.0.1:3081'
```

### Chrome 应用窗口

```powershell
Start-Process chrome -ArgumentList '--app=http://127.0.0.1:3081'
```

若提示找不到浏览器命令，可在 Edge/Chrome 地址栏直接打开该 URL，再通过浏览器菜单选择安装/创建快捷方式。桌面窗口仍依赖两个后台服务；退出窗口本身不会自动安装或卸载 DSH。

macOS/Linux 可直接在浏览器打开 `http://127.0.0.1:3081`，或使用浏览器菜单创建应用快捷方式。原生桌面包若由其他发行渠道提供，应按该发行渠道的安装和更新说明操作，本文不提供未经项目验证的安装命令。

## 7. 升级 DSH 本体

升级前记录当前版本，并停止正在运行的 `dsh web`（在对应窗口按 `Ctrl+C`）：

```powershell
dsh --version
npm list --global @deepseek-ai/dsh
```

全局安装升级到 npm 当前最新版：

```powershell
npm install --global @deepseek-ai/dsh@latest
dsh --version
```

安装指定版本（将版本号替换为目标版本）：

```powershell
npm install --global @deepseek-ai/dsh@1.2.3
dsh --version
```

npx 方式升级时显式请求最新版：

```powershell
npx --yes @deepseek-ai/dsh@latest --version
npx --yes @deepseek-ai/dsh@latest web
```

升级后检查配置与插件是否仍可用；涉及配置文件变更或插件加载异常时，先查看 DSH 对应版本的升级说明。控制台目前主要按 DSH `0.1.5-rc.2` 开发和回归，其他版本未必完全兼容。

macOS/Linux 的 npm 命令相同：

```bash
npm install --global @deepseek-ai/dsh@latest
dsh --version
```

## 8. 升级 DSH Console

升级前停止旧控制台进程（运行窗口按 `Ctrl+C`），并备份运行配置。新版本生产包使用带版本号的目录，推荐并排解压、验证后再切换：

```powershell
$old = 'D:\Apps\dsh-console'
$backup = 'D:\Backup\dsh-console-config'
New-Item -ItemType Directory -Force -Path $backup | Out-Null
foreach ($name in @('dsh-config.json', 'ui-prefs.yaml', 'ui-prefs.json', 'plugins.json', 'mcp-tools.json')) {
	$path = Join-Path $old $name
	if (Test-Path -LiteralPath $path) { Copy-Item -LiteralPath $path -Destination $backup }
}
```

然后解压新版本到新目录，运行 `check.cmd` 或 `node server.cjs --check`，再启动并验证页面与 DSH 连接。确认正常后，将需要保留的本机配置文件复制到新目录。至少要谨慎处理 `dsh-config.json`：其中可能含 DSH 访问令牌，不要公开或提交到 Git。

如果直接覆盖现有目录，必须先停止服务并备份上述本机配置；不要用新包覆盖后丢掉这些文件。升级控制台不等于升级 DSH，两者应分别操作。

源码工作区更新：

```powershell
Set-Location 'D:\path\to\dsh-console'
git status
git pull
```

先处理 `git status` 显示的本地修改，避免覆盖自己的工作。源码版更新完成后重新运行 `node server.cjs`。

## 9. 卸载

### 卸载全局 DSH CLI

先停止 `dsh web`，再执行：

```powershell
npm uninstall --global @deepseek-ai/dsh
Get-Command dsh -ErrorAction SilentlyContinue
```

若使用 npx 临时运行而未全局安装，不需要执行 npm uninstall；停止对应进程即可。npm 缓存可能保留下载文件，但不影响 DSH 是否已全局安装，通常不必清理。

### 卸载 DSH Console

先在控制台窗口按 `Ctrl+C`。生产部署包通常是解压目录，不写入系统级安装项；确认路径无误后删除该目录：

```powershell
Remove-Item -LiteralPath 'D:\Apps\dsh-console' -Recurse
```

如果要保留设置或访问令牌，先备份 `dsh-config.json`、`ui-prefs.yaml` 等运行时文件。源码安装则删除克隆目录，或按 Git 工作区管理方式保留/移走它。

### 是否删除 DSH 用户数据

卸载 npm 包**不会自动删除**用户配置、profile、会话或插件数据。Windows 通常位于 `$HOME\.dsh`，macOS/Linux 通常位于 `~/.dsh`。其中可能有重要配置和数据，建议卸载程序后先备份，不要为了卸载 CLI 直接删除整个 `.dsh` 目录。

如确定要彻底清除 DSH 用户数据，先确认备份并关闭 DSH，再人工核对路径：

```powershell
$dshData = Join-Path $HOME '.dsh'
Get-ChildItem -Force -LiteralPath $dshData
# 确认该目录内容确实全部可以删除后，再单独执行：
# Remove-Item -LiteralPath $dshData -Recurse
```

## 10. 常见问题速查

| 现象 | 检查方式 / 处理 |
|---|---|
| `dsh` 不是命令 | `Get-Command dsh`、`npm list --global --depth=0`；重新打开 PowerShell，检查 npm 全局目录是否在 `PATH`。也可用 `npx --yes @deepseek-ai/dsh web`。 |
| 控制台提示 DSH 不可用 | 确认 `dsh web` 窗口仍在运行；检查 `Test-NetConnection 127.0.0.1 -Port 3080`；令牌过期时重新启动 DSH 并在控制台更新完整地址。 |
| 浏览器页面空白 | 确认控制台服务正在运行，并访问 `http://127.0.0.1:3081`，不要打开 `index.html` 文件。 |
| 3081 端口被占用 | 临时设置 `$env:CONSOLE_PORT = '3082'` 后运行 `node server.cjs`，访问 3082。 |
| 知识库页面不可用 | 在 DSH 的 `web` profile 安装 `dsh-knowledge`，重启 `dsh web`；插件管理语法以 `dsh plugin --help` 为准。 |
| GeoScene Pro MCP 工具数为 0 | 确认 Pro 和 MCP 服务正常；Windows 下从 PowerShell 启动 DSH，不要从 Git Bash 启动。 |

## 11. 操作命令汇总

```powershell
# 安装 / 查看版本
npm install --global @deepseek-ai/dsh
dsh --version

# 启动 / 停止（停止是在运行窗口按 Ctrl+C）
dsh web

# 升级到最新版
npm install --global @deepseek-ai/dsh@latest

# 卸载全局 CLI
npm uninstall --global @deepseek-ai/dsh

# 启动控制台（在 dsh-console 目录执行；另需先启动 dsh web）
node server.cjs

# 控制台部署自检
node server.cjs --check
```
