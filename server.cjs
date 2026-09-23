/* DSH Console — 本地服务
 * Copyright 2026 liwei (易智瑞西安) <liwei@geoscene.cn>
 * SPDX-License-Identifier: Apache-2.0
 *
 * 依据 Apache License 2.0 授权使用与分发；许可证全文见项目根目录 LICENSE，摘要见 NOTICE。
 */
/**
 * DSH Console 本地服务
 * - 静态托管 ./public
 * - /api/* 反向代理到 DSH 主机（默认 http://127.0.0.1:3080），解决浏览器跨域
 * 仅绑定 127.0.0.1，不对外暴露。
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const tls = require('node:tls');
const crypto = require('node:crypto');
const { execFileSync, spawnSync, spawn } = require('node:child_process');

/* 本工程刻意不装 node_modules —— 除 Node 内置模块外没有任何第三方依赖。
   原先这里从 DSH 的 profile 目录复用 ws，但那是写死的绝对路径，
   换台机器就 require 失败、进程起不来；现在改由本文件自己实现 WebSocket 桥接
   （见文末「WebSocket 双工桥接」），因此不再需要 ws。 */

// 运行环境自检：全局 fetch 与 node: 前缀模块都要求 Node 18+
const NODE_MAJOR = Number(process.versions.node.split('.')[0]);
if (NODE_MAJOR < 18) {
  console.error('需要 Node.js 18 或更高版本，当前为 ' + process.versions.node);
  process.exit(1);
}

const PORT = (() => {
  const n = Number(process.env.CONSOLE_PORT || 3081);
  return Number.isFinite(n) && n > 0 && n < 65536 ? n : 3081;
})();
const ROOT = path.join(__dirname, 'public');

/* ============ DSH 目标地址与访问令牌 ============
   DSH 的 Web 端口带浏览器会话鉴权：
     · `dsh web` 启动时会打印 http://127.0.0.1:3080/?token=<launchToken>
     · GET /?token=… 校验通过后回 303 + Set-Cookie: dsh-auth-<authority>=v1.…
       （HttpOnly / SameSite=Strict，并且 cookie 与 Host 绑定）
     · 此后 /api/* 的每个请求、以及实时流 WebSocket 的 upgrade 都必须带这个
       cookie，否则一律 401 unauthorized
   浏览器直连 DSH 时这一步由 DSH 自己完成；但控制台是另一个源上的反向代理，
   必须替浏览器把 token 换成 cookie，并在转发时带上它。

   配置来源优先级：
     环境变量 DSH_ORIGIN（可含 ?token=…）/ DSH_TOKEN
       > 本目录 dsh-config.json（页面「配置 DSH 主机」写入，连接成功才落盘）
       > 默认 http://127.0.0.1:3080

   无感启动（默认开启）：
     控制台起来后若探测不到可用的 DSH，会自动用本机 dsh / npx 拉起 `dsh web`，
     从启动日志里抓带 ?token=… 的地址并完成认证，再写入 dsh-config.json。
     关掉：DSH_AUTO_START=0；不自动打开浏览器：DSH_OPEN_BROWSER=0。

   ⚠️ dsh-config.json 里可能存着令牌，已加入 .gitignore，分发代码时不要带上。 */
const CONFIG_FILE = path.join(__dirname, 'dsh-config.json');
/* 控制台界面偏好（各页说明卡是否显示 / 对话显示 标准|紧凑 …）。
   为什么落在项目里而不是浏览器 localStorage：
   它描述的是"这个控制台项目长什么样"，属于项目级配置 —— 换浏览器、清缓存后应当还在；
   放 localStorage 会随缓存清空丢失，也无法随项目一起交付给别人。
   与 DSH 设置无关（那些写 ~/.dsh/settings.yaml，会影响会话行为），所以单独一个文件、单独一个接口。
   格式用 **YAML**（用户明确要求；键值只有 bool/string/number，自带一个极小的读写器，不引第三方依赖）。 */
const UI_PREFS_FILE = path.join(__dirname, 'ui-prefs.yaml');
const UI_PREFS_LEGACY = path.join(__dirname, 'ui-prefs.json');   // 旧格式；读到就迁移到 yaml
const DEFAULT_DSH = 'http://127.0.0.1:3080';

/** DSH 用户数据根目录（profile / 插件 / 凭据 / skills）。
 *  优先级：环境变量 DSH_HOME → 一体包 runtime/dsh-home → ~/.dsh */
function dshHomeDir() {
  const env = String(process.env.DSH_HOME || '').trim();
  if (env) return path.resolve(env);
  const bundled = path.join(__dirname, 'runtime', 'dsh-home');
  try {
    if (fs.statSync(path.join(bundled, 'profiles')).isDirectory()) return bundled;
  } catch { /* 没有一体包 profile */ }
  return path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh');
}

let DSH = DEFAULT_DSH;         // 目标 origin，如 http://127.0.0.1:3080
let DSH_TOKEN = '';            // 访问令牌（不需要认证的部署留空即可）
let DSH_SOURCE = 'default';    // env | config | default | ui | auto
let AUTH_COOKIE = '';          // 令牌换来的会话 cookie，形如 name=value
let AUTH_EXPIRES = 0;          // 该 cookie 的过期时间戳（ms）；0 表示未知
let AUTH_ERROR = '';           // 最近一次换令牌 / 校验失败的原因
let OWNED_DSH_CHILD = null;    // 本进程拉起的 dsh web（退出时一并结束）
let OWNED_DSH_PID = 0;         // 同上，单独记 PID（exit 时 child 句柄可能已不可用）
let OWNED_DSH_PORT = 0;        // 我们拉起的 DSH 监听端口（兜底按端口杀掉）
let OWNED_DSH_WATCHDOG = null; // 父进程被强杀时仍负责收尸的监护进程

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png' };

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const target = path.resolve(path.join(ROOT, rel));
  if (!target.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }
  fs.readFile(target, (err, buf) => {
    if (err) {
      // 部署时第二个常见的坑：只拷了 server.cjs，没拷 public/。
      // 首页这种情况下给一段能照着做的提示，而不是一句 not found。
      if (rel === '/index.html') {
        res.writeHead(500, { 'content-type': 'text/html; charset=utf-8' });
        return void res.end(
          '<meta charset="utf-8"><body style="font:14px/1.8 system-ui,\'Microsoft YaHei\',sans-serif;max-width:640px;margin:12vh auto">'
          + '<h2>⚠️ 前端文件缺失</h2>'
          + '<p>后端已启动，但找不到 <code>' + path.join(ROOT, 'index.html') + '</code>。</p>'
          + '<p>请把 <code>public/</code> 整个目录（index.html、app.js、style.css）与 <code>server.cjs</code> 放在同一层。</p>'
          + '<p>在本目录执行 <code>node server.cjs --check</code> 可做一次完整部署自检。</p></body>'
        );
      }
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found: ' + rel);
      return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(target)] || 'application/octet-stream' });
    res.end(buf);
  });
}

/* ============ DSH 目标：解析、持久化、令牌换 cookie、状态判定 ============
   这一段是"控制台能不能用"的前提，页面上的「配置 DSH 主机」弹窗就是它的前端。
   ==================================================================== */

/**
 * 把用户粘贴的内容解析成 { origin, token }。
 * 接受三种写法：① `dsh web` 打印的完整地址（可带 ?token=…）
 *              ② 只有令牌本身（一长串 base64url）
 *              ③ 不带协议的 127.0.0.1:3080
 */
function parseDshInput(input) {
  const raw = String(input || '').trim();
  if (!raw) return { error: '地址不能为空' };
  // ② 只有令牌：没有协议斜杠、没有点，且像 base64url
  if (!/[/:.]/.test(raw) && /^[A-Za-z0-9_-]{16,}$/.test(raw)) return { kind: 'token', origin: DSH, token: raw };
  let u;
  try { u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : 'http://' + raw); }
  catch { return { error: '地址无法解析：' + raw }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { error: '只支持 http / https 地址' };
  const token = u.searchParams.get('token') || '';
  u.searchParams.delete('token');
  const hadPath = u.pathname && u.pathname !== '/';
  u.pathname = hadPath ? u.pathname.replace(/\/+$/, '') : '';
  u.search = ''; u.hash = '';
  return { kind: 'url', origin: u.origin + (hadPath ? u.pathname : ''), token, hadPath };
}

/* ============ 跨平台小工具 ============ */

/** 子进程环境：Windows 上补 SystemRoot（部分工具依赖它），其它平台原样透传。
 *  不写死 'C:\Windows' 到非 Windows 环境里去。 */
function childEnv() {
  const env = { ...process.env };
  if (process.platform === 'win32' && !env.SystemRoot) env.SystemRoot = 'C:\\Windows';
  return env;
}

/** 临时目录：跟随平台约定（TMPDIR / TEMP / TMP → os.tmpdir()），绝不落到安装目录里 */
function tempDir() {
  return process.env.TMPDIR || process.env.TEMP || process.env.TMP || os.tmpdir();
}

/* ============ 找 dsh 命令行 ============
   **两种部署都要能用**：全局安装（dsh 在 PATH 上）和只用 npx（dsh 只存在于 npx 缓存里）。
   为什么不能只看 PATH：npx 只给它**自己那棵进程树**加 PATH，从资源管理器双击
   check.cmd / start.cmd 开的窗口里 PATH 上没有 dsh（实测就是这样），于是「插件」页的
   `dsh --dump-config` 会失败并回退快照。

   所以这里**枚举所有可用的拉起方式**，按可信度排序，逐个试到能行为止：
     ⓪ 一体包 runtime（DSH_CONSOLE_RUNTIME 或本目录 runtime/dsh）—— 离线包最优先
     ① 当前进程 PATH 里若带 `_npx\<hash>\node_modules\.bin` —— 这就是当前那棵 npx 进程树，最可信
     ② PATH 上的 dsh（全局安装 / nvm 等）
     ③ 已知的全局安装位置（%APPDATA%\npm、node.exe 同目录、/usr/local/bin、homebrew、~/.npm-global…）
     ④ npx 缓存（%LOCALAPPDATA%\npm-cache\_npx\* 与 ~/.npm/_npx/*，多份按修改时间新→旧）
   每个位置都按 `dsh.cmd` / `dsh` / `dsh.ps1` 依次找。结果缓存。 */
let DSH_CMDS;
function dshCandidates() {
  if (DSH_CMDS !== undefined) return DSH_CMDS;
  const out = [];
  const win = process.platform === 'win32';
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const add = (file, how) => { if (file && !out.some(x => x.file === file)) out.push({ file, how }); };
  // Windows 上没有扩展名的 `dsh` 是给 Git Bash 用的 POSIX 脚本，我们跑不了，不列它
  const shimNames = win ? ['dsh.cmd', 'dsh.exe', 'dsh.ps1'] : ['dsh'];
  const addDir = (dir, how) => { for (const n of shimNames) add(path.join(dir, n), how); };

  // ⓪ 离线一体包内置的 DSH（make-dist --offline → runtime/dsh）
  const bundledRoot = process.env.DSH_CONSOLE_RUNTIME
    ? path.resolve(String(process.env.DSH_CONSOLE_RUNTIME).trim())
    : path.join(__dirname, 'runtime');
  addDir(path.join(bundledRoot, 'dsh', 'node_modules', '.bin'), '一体包 runtime');
  addDir(path.join(bundledRoot, 'node_modules', '.bin'), '一体包 runtime');

  // ① 当前进程 PATH 里的 npx 目录（说明控制台就跑在那棵 npx 进程树里）
  const activeNpx = String(process.env.PATH || '').split(path.delimiter)
    .find(d => /[\\/]_npx[\\/]/.test(d) && /[\\/]\.bin[\\/]?$/i.test(d));
  if (activeNpx) addDir(activeNpx, '当前 npx 进程树');

  // ② PATH（全局安装最常见的情况）
  const fromPath = findExecutable('dsh');                 // 函数声明在后面，已提升
  if (fromPath) add(fromPath, 'PATH');

  // ③ 已知的全局安装位置
  addDir(path.dirname(process.execPath), 'node 安装目录');  // nvm-windows 的全局垫片就在 node.exe 旁边
  if (process.env.APPDATA) add(path.join(process.env.APPDATA, 'npm', win ? 'dsh.cmd' : 'dsh'), 'npm 全局目录');
  if (process.env.ProgramFiles) addDir(path.join(process.env.ProgramFiles, 'nodejs'), 'Program Files\\nodejs');
  add('/usr/local/bin/dsh', '全局安装');
  add('/opt/homebrew/bin/dsh', 'Homebrew');
  if (home) { add(path.join(home, '.npm-global', 'bin', 'dsh'), '全局安装'); add(path.join(home, '.local', 'bin', 'dsh'), '全局安装'); }

  // ④ npx 缓存（npm_config_cache 可改写缓存位置）
  const npxHits = [];
  const npxRoots = [
    process.env.npm_config_cache && path.join(process.env.npm_config_cache, '_npx'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'npm-cache', '_npx'),
    home && path.join(home, '.npm', '_npx'),
    home && path.join(home, '.cache', 'npm', '_npx'),
  ].filter(Boolean);
  for (const root of npxRoots) {
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      for (const n of shimNames) {
        const p = path.join(root, e.name, 'node_modules', '.bin', n);
        try { npxHits.push({ file: p, how: 'npx 缓存', mtime: fs.statSync(p).mtimeMs }); } catch { /* 没有这个垫片 */ }
      }
    }
  }
  npxHits.sort((a, b) => b.mtime - a.mtime);               // 多份历史缓存时用最新的那份
  for (const h of npxHits) add(h.file, h.how);

  DSH_CMDS = out.filter(c => { try { return fs.statSync(c.file).isFile(); } catch { return false; } });
  return DSH_CMDS;
}

/** 从 dsh 垫片路径反推它所在包的目录（<...>/node_modules/@deepseek-ai/dsh） */
function dshPackageDir(cmd) {
  const dir = path.dirname(cmd.file);                          // <...>/node_modules/.bin
  for (const rel of [['..', '@deepseek-ai', 'dsh'], ['..', '..', '@deepseek-ai', 'dsh'], ['@deepseek-ai', 'dsh']]) {
    const p = path.join(dir, ...rel);
    try { if (fs.statSync(path.join(p, 'package.json')).isFile()) return p; } catch { /* 试下一个 */ }
  }
  return null;
}

function loadDshConfig() {
  try {
    const j = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (j && j.origin) return { origin: String(j.origin), token: String(j.token || ''), at: j.at };
  } catch { /* 不存在或损坏都当没配 */ }
  return null;
}

function saveDshConfig(origin, token) {
  return writeJsonSafe(CONFIG_FILE, {
    note: 'DSH Console 的目标地址与访问令牌，由页面「配置 DSH 主机」写入。含敏感信息，不要分发给别人。',
    origin, token, at: new Date().toISOString(),
  });
}

function dropDshConfig() {
  try { fs.unlinkSync(CONFIG_FILE); return true; } catch { return false; }
}

/** 启动时确定目标：环境变量 > dsh-config.json > 默认 */
function initDshTarget() {
  const envOrigin = String(process.env.DSH_ORIGIN || '').trim();
  const envToken = String(process.env.DSH_TOKEN || '').trim();
  const cfg = loadDshConfig();
  if (envOrigin) {
    const p = parseDshInput(envOrigin);
    if (p.error) console.error('× DSH_ORIGIN 无法解析（' + p.error + '），改用默认 ' + DEFAULT_DSH);
    else {
      DSH = p.origin; DSH_TOKEN = envToken || p.token || ''; DSH_SOURCE = 'env';
      return { origin: DSH, token: DSH_TOKEN, source: DSH_SOURCE };
    }
  }
  if (envToken) {                                  // 只给了令牌，地址沿用配置或默认
    DSH = cfg?.origin || DEFAULT_DSH; DSH_TOKEN = envToken; DSH_SOURCE = 'env';
    return { origin: DSH, token: DSH_TOKEN, source: DSH_SOURCE };
  }
  if (cfg) { DSH = cfg.origin; DSH_TOKEN = cfg.token || ''; DSH_SOURCE = 'config'; return { origin: DSH, token: DSH_TOKEN, source: DSH_SOURCE }; }
  DSH = DEFAULT_DSH; DSH_TOKEN = ''; DSH_SOURCE = 'default';
  return { origin: DSH, token: '', source: DSH_SOURCE };
}

/** 读取一个 JSON 请求体（页面「配置 DSH 主机」用），失败返回 {} */
async function readJsonBody(req, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error('请求体过大');
    chunks.push(c);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return {}; }
}

/**
 * 用令牌换会话 cookie：GET /?token=… → 303 + Set-Cookie。
 * 成功时把 cookie 记进内存（后面所有代理请求与 WS 握手都用它）。
 * @returns { ok, status?, cookie?, expiresAt?, error? }
 */
async function exchangeToken(origin, token, timeoutMs = 6000) {
  if (!token) return { ok: false, error: '没有配置令牌' };
  try {
    const r = await fetch(origin + '/?token=' + encodeURIComponent(token), {
      method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
    });
    const setCookie = r.headers.get('set-cookie') || '';
    const m = /(dsh-auth-[^=;]+)=([^;]+)/.exec(setCookie);
    if (!m) {
      return {
        ok: false, status: String(r.status),
        error: (r.status === 401 || r.status === 403)
          ? '令牌被 DSH 拒绝（HTTP ' + r.status + '）—— 多半是令牌过期了，重新执行 dsh web 取新地址'
          : '该地址没有下发 DSH 会话 cookie（HTTP ' + r.status + '）—— 它可能不是 DSH，或版本较旧、不需要令牌',
      };
    }
    const maxAge = Number((/Max-Age=(\d+)/i.exec(setCookie) || [])[1] || 0);
    AUTH_COOKIE = m[1] + '=' + m[2];
    AUTH_EXPIRES = maxAge ? Date.now() + maxAge * 1000 : 0;
    AUTH_ERROR = '';
    return { ok: true, status: String(r.status), cookie: m[1], expiresAt: AUTH_EXPIRES || null };
  } catch (e) {
    return { ok: false, error: '连接 DSH 失败：' + e.message };
  }
}

/** 需要时（首次 / cookie 快过期 / 被 401 拒绝）刷新 cookie */
async function ensureDshAuth(force) {
  if (!DSH_TOKEN) { AUTH_COOKIE = ''; AUTH_EXPIRES = 0; return { ok: true, mode: 'no-token' }; }
  if (!force && AUTH_COOKIE && (!AUTH_EXPIRES || AUTH_EXPIRES - Date.now() > 60000)) return { ok: true, mode: 'cached' };
  const r = await exchangeToken(DSH, DSH_TOKEN);
  if (!r.ok) AUTH_ERROR = r.error || '换取会话 cookie 失败';
  return r;
}

/** 转发给 DSH 时要带的认证头（没配令牌就是空对象） */
function authHeaders() { return AUTH_COOKIE ? { cookie: AUTH_COOKIE } : {}; }

/**
 * 控制台**自己**要调一个 DSH Remote 端点时用它（页面上的请求仍然走 proxy 原样转发）。
 * 信封与浏览器一致：POST /api/<ns>/<method> + { payload:{ args } }，返回值解掉外层信封。
 * 令牌过期时（401）就地重换一次 cookie 再试，避免用户的图片/附件突然打不开。
 */
async function remoteCall(method, args) {
  const send = () => fetch(DSH + '/api/' + method, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ type: 'client-request', rpcId: 'local-' + Date.now(), method, payload: { args } }),
  });
  let r = await send();
  if (r.status === 401 && DSH_TOKEN) {
    const again = await ensureDshAuth(true);
    if (again.ok) r = await send();
  }
  const j = await r.json().catch(() => null);
  const result = j && j.result;
  if (!result) { const e = new Error('上游响应异常（HTTP ' + r.status + '）'); e.code = 'upstream'; throw e; }
  if (result.ok === false) {
    const d = result.error || {};
    const e = new Error(d.message || d.code || 'Remote 调用失败');
    e.code = d.code || 'remote-error';
    throw e;
  }
  return result.value;
}

/**
 * DSH 版本号。"系统状态"页要显示的版本只能从本机读：
 * 由 PATH 上的 dsh 垫片反推它所在的包目录，读 @deepseek-ai/dsh/package.json；
 * 推不出来再退回 `dsh --version`。结果缓存，都失败返回 '—'。
 */
let DSH_VERSION = null;
function dshVersion() {
  if (DSH_VERSION !== null) return DSH_VERSION;
  DSH_VERSION = '—';
  try {
    // 先从每个候选垫片反推它旁边的 @deepseek-ai/dsh/package.json
    for (const c of dshCandidates()) {
      const pkgDir = dshPackageDir(c);
      if (!pkgDir) continue;
      try {
        const j = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
        if (j.version) { DSH_VERSION = j.version; break; }
      } catch { /* 换下一个候选 */ }
    }
    // 都推不出来时真跑一次 CLI（这也是"这个 dsh 到底能不能用"的实测）
    if (DSH_VERSION === '—') {
      const m = /(\d+\.\d+\.\d+[^\s]*)/.exec(runDsh(['--version']).out || '');
      if (m) DSH_VERSION = m[1];
    }
  } catch { /* 保持 '—'，页面显示"未获取" */ }
  return DSH_VERSION;
}

/**
 * 判断某个地址上是不是 DSH、要不要令牌、当前是否已认证。
 * 只看 `GET /` 与响应特征，**不依赖任何 RPC 方法名**——方法名随版本变，
 * 而根路径的语义是稳定的（未认证恒为 401 + "dsh web authentication required"）。
 * @returns { ok, authed, needsToken, forbidden, status, server, ct, body }
 */
async function probeDshAt(origin, timeoutMs = 5000, cookie = AUTH_COOKIE) {
  try {
    const r = await fetch(origin + '/', {
      method: 'GET', redirect: 'manual',
      headers: cookie ? { cookie } : {}, signal: AbortSignal.timeout(timeoutMs),
    });
    const ct = r.headers.get('content-type') || '';
    // 注意：标记要在**完整响应**上匹配，只把摘要放进 body 里给页面显示
    const raw = await r.text().catch(() => '');
    const isDshPage = /__DSH_BOOT__|DeepSeek Harness/i.test(raw);
    const needsToken = r.status === 401 && /dsh web authentication required/i.test(raw);
    const forbidden = r.status === 403 && /forbidden/i.test(raw);
    const isDsh = needsToken || (r.status === 200 && isDshPage);
    // 运行实例的构建号（boot 载荷里的 "rev"）——本机可能装了多个版本，
    // 这是唯一能证明"此刻跑的是哪一版"的标识（注意别匹配到 URL 里的 &rev=）
    const rev = (/"rev"\s*:\s*"([0-9a-f]{6,})"/i.exec(raw) || [])[1] || '';
    return {
      ok: isDsh, authed: r.status === 200 && isDsh, needsToken, forbidden, reachable: true, rev,
      status: String(r.status), server: r.headers.get('server') || '—', ct,
      body: raw.replace(/\s+/g, ' ').trim().slice(0, 160),
    };
  } catch (e) {
    return { ok: false, authed: false, needsToken: false, forbidden: false, reachable: false,
             rev: '', status: '—', server: '—', ct: '', body: e.message };
  }
}

/**
 * 汇总目标状态给页面用（GET /api/local/dsh）。
 * state：ok 已连接 | need-token 需要令牌 | token-rejected 令牌无效
 *        | not-dsh 不是 DSH | forbidden Host 被拒 | unreachable 不可达
 */
async function dshStatus(timeoutMs = 5000) {
  const out = {
    origin: DSH, source: DSH_SOURCE, configured: DSH_SOURCE !== 'default',
    hasToken: !!DSH_TOKEN,
    tokenHint: DSH_TOKEN ? DSH_TOKEN.slice(0, 4) + '…' + DSH_TOKEN.slice(-4) : '',
    state: 'unknown', authed: false, reachable: false, httpStatus: '—',
    dshVersion: dshVersion(), dshRev: '',
    error: '', detail: '', configPath: CONFIG_FILE, at: new Date().toISOString(),
  };
  await ensureDshAuth(false);
  let p = await probeDshAt(DSH, timeoutMs);
  // 配了令牌却仍被拒 → 令牌可能刚轮换，强制换一次再判
  if (p.needsToken && DSH_TOKEN && AUTH_ERROR !== '') {
    await ensureDshAuth(true);
    p = await probeDshAt(DSH, timeoutMs);
  }
  out.reachable = p.reachable;
  out.httpStatus = p.status;
  out.authed = p.authed;
  out.dshRev = p.rev || '';
  if (p.authed) { out.state = 'ok'; out.detail = '已认证，控制台可用'; return out; }
  if (p.needsToken) {
    out.state = DSH_TOKEN ? 'token-rejected' : 'need-token';
    out.error = DSH_TOKEN ? (AUTH_ERROR || '令牌无效或已过期') : '';
    out.detail = DSH_TOKEN ? 'DSH 拒绝了当前令牌' : 'DSH 要求浏览器会话鉴权，请粘贴带 ?token=… 的地址';
    return out;
  }
  if (p.forbidden) { out.state = 'forbidden'; out.detail = 'DSH 拒绝了该 Host（只接受本机地址或 trustedHosts 中的地址）'; return out; }
  if (!p.reachable) { out.state = 'unreachable'; out.error = p.body; out.detail = '连不上该地址'; return out; }
  out.state = 'not-dsh';
  out.detail = '该地址有响应，但不像是 DSH（HTTP ' + p.status + '，Server: ' + p.server + '，Content-Type: ' + p.ct + '）';
  return out;
}

/* ============ 无感启动：探测 →（必要时）拉起 dsh web → 抓 token → 认证 ============
   用户只需双击 start.cmd / 跑 node server.cjs。控制台会尽量自己把 DSH 准备好。
   不会强杀别人已经开着的 dsh web（端口占用且令牌不对时只能提示手动处理）。
   ========================================================================== */

function envFlagOn(name, defaultOn) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === '') return !!defaultOn;
  const v = String(raw).trim().toLowerCase();
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  return !!defaultOn;
}

/** 从 dsh web 日志里抠带 ?token= 的启动地址 */
function extractLaunchUrl(text) {
  const m = /https?:\/\/[^\s"'<>]+[?&]token=[A-Za-z0-9_-]+[^\s"'<>]*/i.exec(String(text || ''));
  if (!m) return null;
  return m[0].replace(/[.,;:)\]}>]+$/g, '');
}

/** 子进程环境：保证能找到同目录的 node（npx / .cmd 垫片会调它） */
function dshSpawnEnv() {
  const env = childEnv();
  const nodeDir = path.dirname(process.execPath);
  if (nodeDir && !String(env.PATH || '').split(path.delimiter).includes(nodeDir)) {
    env.PATH = nodeDir + path.delimiter + (env.PATH || '');
  }
  return env;
}

function stopOwnedDsh() {
  const child = OWNED_DSH_CHILD;
  const pid = (child && child.pid) || OWNED_DSH_PID;
  const port = OWNED_DSH_PORT;
  OWNED_DSH_CHILD = null;
  OWNED_DSH_PID = 0;
  OWNED_DSH_PORT = 0;
  if (!pid && !port) return;

  try {
    if (pid) {
      if (process.platform === 'win32') {
        // /T 杀整棵进程树：shell:true 时 child.pid 往往是 cmd，真正的 dsh/node 在子孙里
        spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
      } else {
        try { process.kill(-pid, 'SIGTERM'); } catch {
          try { process.kill(pid, 'SIGTERM'); } catch { /* 已退出 */ }
        }
        // exit 钩子里 setTimeout 不会执行，用同步短等再强杀
        try { spawnSync('sh', ['-c', 'sleep 0.25'], { stdio: 'ignore' }); } catch { /* ignore */ }
        try { process.kill(-pid, 'SIGKILL'); } catch {
          try { process.kill(pid, 'SIGKILL'); } catch { /* 已退出 */ }
        }
      }
    }
  } catch { /* 退出清理，失败无所谓 */ }

  // 进程树没清干净时，按我们拉起时记下的端口再扫一遍（只动 OWNED_DSH_PORT，不误杀外来 DSH）
  if (port) killListenerOnPort(port);
}

/** 结束仍占用指定本地端口的 LISTENING 进程（Windows / Unix 兜底） */
function killListenerOnPort(port) {
  const p = Number(port);
  if (!p) return;
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8', windowsHide: true });
      const pids = new Set();
      for (const line of out.split(/\r?\n/)) {
        if (!/LISTENING/i.test(line)) continue;
        // 匹配 *:3080 / 127.0.0.1:3080 / [::]:3080
        if (!new RegExp(':' + p + '\\s').test(line)) continue;
        const m = /\s(\d+)\s*$/.exec(line);
        if (m && m[1] !== '0') pids.add(m[1]);
      }
      for (const id of pids) {
        spawnSync('taskkill', ['/pid', id, '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
      }
    } else {
      spawnSync('sh', ['-c',
        'pids=$(lsof -tiTCP:' + p + ' -sTCP:LISTEN 2>/dev/null); '
        + '[ -n "$pids" ] && kill -TERM $pids 2>/dev/null; sleep 0.3; '
        + 'pids=$(lsof -tiTCP:' + p + ' -sTCP:LISTEN 2>/dev/null); '
        + '[ -n "$pids" ] && kill -KILL $pids 2>/dev/null; true'],
        { stdio: 'ignore' });
    }
  } catch { /* 兜底失败就算了 */ }
}

/**
 * 监护进程：本控制台（父 PID）一旦不在，就杀掉我们拉起的 DSH 进程树。
 * 关 CMD 窗口时 Windows 常直接干掉 node，SIGINT/exit 钩子来不及跑；
 * 监护进程以 detached 方式存活，专门处理这种強杀。
 */
function armOwnedDshWatchdog(dshPid, dshPort) {
  const pid = Number(dshPid) || 0;
  if (!pid) return;
  OWNED_DSH_PID = pid;
  if (dshPort) OWNED_DSH_PORT = Number(dshPort) || OWNED_DSH_PORT;

  const parentPid = process.pid;
  const port = OWNED_DSH_PORT || 0;
  try {
    if (process.platform === 'win32') {
      // 父进程消失 → taskkill 整树；再按端口扫一遍，防止只杀掉了 cmd 垫片
      const ps = [
        '$ErrorActionPreference = \'SilentlyContinue\'',
        '$ppid = ' + parentPid,
        '$cpid = ' + pid,
        '$port = ' + port,
        'while (Get-Process -Id $ppid) { Start-Sleep -Milliseconds 500 }',
        'taskkill /PID $cpid /T /F | Out-Null',
        'if ($port -gt 0) {',
        '  netstat -ano | Select-String \':\'+$port+\'\\s\' | ForEach-Object {',
        '    if ($_ -match \'LISTENING\\s+(\\d+)\\s*$\') {',
        '      $lp = $Matches[1]',
        '      if ($lp -and $lp -ne \'0\') { taskkill /PID $lp /T /F | Out-Null }',
        '    }',
        '  }',
        '}',
      ].join('; ');
      OWNED_DSH_WATCHDOG = spawn('powershell.exe', [
        '-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-Command', ps,
      ], { detached: true, stdio: 'ignore', windowsHide: true });
    } else {
      const sh = [
        'while kill -0 ' + parentPid + ' 2>/dev/null; do sleep 0.5; done',
        'kill -TERM -' + pid + ' 2>/dev/null || kill -TERM ' + pid + ' 2>/dev/null',
        'sleep 0.4',
        'kill -KILL -' + pid + ' 2>/dev/null || kill -KILL ' + pid + ' 2>/dev/null',
        port ? (
          'pids=$(lsof -tiTCP:' + port + ' -sTCP:LISTEN 2>/dev/null); '
          + '[ -n "$pids" ] && kill -KILL $pids 2>/dev/null; true'
        ) : 'true',
      ].join('; ');
      OWNED_DSH_WATCHDOG = spawn('sh', ['-c', sh], { detached: true, stdio: 'ignore' });
    }
    if (OWNED_DSH_WATCHDOG) OWNED_DSH_WATCHDOG.unref();
  } catch (e) {
    console.warn('  无法启动 DSH 退出监护：' + e.message);
  }
}

function portFromUrl(urlOrOrigin) {
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(urlOrOrigin) ? urlOrOrigin : 'http://' + urlOrOrigin);
    if (u.port) return Number(u.port);
    return u.protocol === 'https:' ? 443 : 80;
  } catch { return 0; }
}

/** 把抓到的启动 URL / origin 应用到当前进程，成功则可选落盘 */
async function applyLaunchTarget(urlOrOrigin, source, persist) {
  const parsed = parseDshInput(urlOrOrigin);
  if (parsed.error) return { ok: false, error: parsed.error };
  const nextOrigin = parsed.kind === 'url' ? parsed.origin : DSH;
  const nextToken = parsed.token || (parsed.kind === 'url' ? '' : DSH_TOKEN);
  DSH = nextOrigin;
  DSH_TOKEN = nextToken;
  DSH_SOURCE = source;
  AUTH_COOKIE = '';
  AUTH_EXPIRES = 0;
  AUTH_ERROR = '';
  if (DSH_TOKEN) {
    const auth = await ensureDshAuth(true);
    if (!auth.ok) return { ok: false, error: auth.error || '换取会话 cookie 失败' };
  }
  const st = await dshStatus(6000);
  if (st.state !== 'ok') return { ok: false, error: st.error || st.detail, status: st };
  if (persist && DSH_SOURCE !== 'env') saveDshConfig(DSH, DSH_TOKEN);
  return { ok: true, status: st };
}

/**
 * 拉起一条 `dsh web`，从 stdout/stderr 抓启动 URL，并轮询端口是否就绪。
 * @returns {Promise<{ok, how?, url?, error?}>}
 */
function spawnDshWebAttempt(file, args, how, opts, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    let applying = false;
    let buf = '';
    console.log('  → 正在自动启动 DSH（' + how + '）…');
    let child;
    try {
      child = spawn(file, args, {
        env: dshSpawnEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        ...opts,
      });
    } catch (e) {
      return resolve({ ok: false, how, error: e.message });
    }
    OWNED_DSH_CHILD = child;
    OWNED_DSH_PID = child.pid || 0;

    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      // 只有真正拉起来并认证成功，才挂「父死子灭」监护；失败路径由 stopOwnedDsh 收尸
      if (result && result.ok && OWNED_DSH_CHILD && OWNED_DSH_CHILD.pid) {
        const port = portFromUrl(result.url || DSH) || portFromUrl(DEFAULT_DSH);
        if (port) OWNED_DSH_PORT = port;
        armOwnedDshWatchdog(OWNED_DSH_CHILD.pid, OWNED_DSH_PORT);
      }
      resolve(result);
    };

    const tryApplyUrl = (url) => {
      if (!url || applying || settled) return;
      applying = true;
      applyLaunchTarget(url, 'auto', true).then((r) => {
        if (r.ok) done({ ok: true, how, url, mode: 'started' });
        else done({ ok: false, how, url, error: r.error || '认证失败' });
      }, (e) => done({ ok: false, how, url, error: e.message }));
    };

    const onChunk = (chunk) => {
      const s = chunk.toString('utf8');
      buf += s;
      if (buf.length > 240000) buf = buf.slice(-120000);
      // 启动日志转发到本控制台，方便排障；每行加前缀避免和本进程日志糊在一起
      for (const line of s.split(/\r?\n/)) {
        if (line.trim()) console.log('  [dsh] ' + line);
      }
      tryApplyUrl(extractLaunchUrl(buf));
    };

    child.stdout.on('data', onChunk);
    child.stderr.on('data', onChunk);
    child.on('error', (e) => done({ ok: false, how, error: e.message }));
    child.on('exit', (code, signal) => {
      if (!settled) {
        OWNED_DSH_CHILD = null;
        done({ ok: false, how, error: 'dsh web 提前退出（code=' + code + (signal ? ' signal=' + signal : '') + '）' });
      }
    });

    // 有的版本日志格式变了抓不到 URL：轮询端口，无鉴权直接可用 / 仍缺 token 则继续等日志
    const poll = setInterval(async () => {
      if (settled) return;
      const p = await probeDshAt(DEFAULT_DSH, 800, '');
      if (p.authed) {
        const r = await applyLaunchTarget(DEFAULT_DSH, 'auto', true);
        done(r.ok ? { ok: true, how, url: DEFAULT_DSH, mode: 'started' } : { ok: false, how, error: r.error });
        return;
      }
      // 已在监听但还没打出 token：继续等；若配置目标本就是该端口也一并探
      if (DSH !== DEFAULT_DSH) {
        const p2 = await probeDshAt(DSH, 800, AUTH_COOKIE);
        if (p2.authed) done({ ok: true, how, url: DSH, mode: 'started' });
      }
    }, 1200);

    const timer = setTimeout(() => {
      const url = extractLaunchUrl(buf);
      if (url) { tryApplyUrl(url); return; }
      stopOwnedDsh();
      done({ ok: false, how, error: '等待 DSH 就绪超时（' + Math.round(timeoutMs / 1000) + 's）—— 未在启动日志里看到带 ?token= 的地址' });
    }, timeoutMs);
  });
}

/** 按候选垫片 / npx 依次尝试拉起 dsh web */
async function spawnDshWeb(timeoutMs) {
  const attempts = [];
  for (const c of dshCandidates()) {
    if (/\.ps1$/i.test(c.file)) {
      attempts.push({
        how: c.how + '（PowerShell）→ ' + c.file,
        file: 'powershell',
        args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', c.file, 'web'],
        opts: {},
        timeoutMs: Math.min(timeoutMs, 45000),
      });
    } else if (/\.cmd$/i.test(c.file) || /\.bat$/i.test(c.file)) {
      attempts.push({
        how: c.how + '（经 shell）→ ' + c.file,
        file: '"' + c.file + '" web',
        args: [],
        opts: { shell: true },
        timeoutMs: Math.min(timeoutMs, 45000),
      });
      attempts.push({
        how: c.how + ' → ' + c.file, file: c.file, args: ['web'], opts: { shell: true },
        timeoutMs: Math.min(timeoutMs, 45000),
      });
    } else {
      attempts.push({
        how: c.how + ' → ' + c.file, file: c.file, args: ['web'], opts: {},
        timeoutMs: Math.min(timeoutMs, 45000),
      });
    }
  }
  attempts.push({
    how: 'npx @deepseek-ai/dsh web',
    file: process.platform === 'win32' ? 'npx.cmd' : 'npx',
    args: ['-y', '@deepseek-ai/dsh', 'web'],
    opts: { shell: true },
    timeoutMs, // npx 首次下载可能较慢，给满额超时
  });

  let lastErr = '没有可用的启动方式';
  for (const a of attempts) {
    const r = await spawnDshWebAttempt(a.file, a.args, a.how, a.opts, a.timeoutMs || timeoutMs);
    if (r.ok) return r;
    lastErr = r.error || lastErr;
    console.error('  × 自动启动未成功（' + a.how + '）：' + lastErr);
    stopOwnedDsh();
  }
  return { ok: false, error: lastErr };
}

/**
 * 启动时确保 DSH 可用。已就绪则跳过；连不上则自动拉起并抓 token。
 * @returns {Promise<{ok?, skipped?, mode?, error?, detail?}>}
 */
async function ensureDshRunning() {
  if (!envFlagOn('DSH_AUTO_START', true)) {
    console.log('  自动启动 DSH 已关闭（DSH_AUTO_START=0）');
    return { skipped: true };
  }

  let st = await dshStatus(5000);
  if (st.state === 'ok') {
    console.log('✓ DSH 已就绪，跳过自动启动（' + DSH + '）');
    return { ok: true, mode: 'already' };
  }

  // 默认端口不对时，先扫一眼别处有没有已经在跑的 DSH
  if (st.state === 'unreachable' || st.state === 'not-dsh') {
    console.log('  → 正在常见端口上查找已运行的 DSH …');
    const hits = await discoverDsh();
    for (const h of hits) {
      const origin = 'http://127.0.0.1:' + h.port;
      console.log('  · 发现 ' + origin + (h.needsToken ? '（需要令牌）' : ''));
      if (!h.needsToken) {
        const r = await applyLaunchTarget(origin, 'auto', true);
        if (r.ok) {
          console.log('✓ 已改用已运行的 DSH：' + origin);
          return { ok: true, mode: 'discovered' };
        }
      } else if (DSH_TOKEN) {
        const r = await applyLaunchTarget(origin + '/?token=' + encodeURIComponent(DSH_TOKEN), DSH_SOURCE === 'env' ? 'env' : 'auto', DSH_SOURCE !== 'env');
        if (r.ok) {
          console.log('✓ 已改用已运行的 DSH 并用现有令牌完成认证：' + origin);
          return { ok: true, mode: 'discovered' };
        }
      }
    }
    st = await dshStatus(4000);
    if (st.state === 'ok') return { ok: true, mode: 'discovered' };
  }

  // 端口上已有 DSH 但令牌缺失/过期：不能安全地杀掉别人的进程，只能提示
  if (st.state === 'need-token' || st.state === 'token-rejected') {
    console.error('× DSH 已在运行，但访问令牌不可用（' + st.state + '）。');
    console.error('  自动启动不会强行结束已有的 dsh web。请任选其一：');
    console.error('    ① 关掉原来的 dsh web 窗口后重新启动本控制台（会自动拉起并抓令牌）');
    console.error('    ② 在页面状态栏粘贴 dsh web 打印的带 ?token=… 的地址');
    return { ok: false, mode: 'need-token', error: st.error || st.detail };
  }

  if (st.state !== 'unreachable') {
    return { ok: false, mode: st.state, error: st.error || st.detail };
  }

  // 真正没人听端口 → 拉起
  const timeoutMs = Number(process.env.DSH_AUTO_START_TIMEOUT_MS || 120000) || 120000;
  const started = await spawnDshWeb(timeoutMs);
  if (started.ok) {
    console.log('✓ 已自动启动 DSH 并完成认证（' + (started.url || DSH) + '）');
    return { ok: true, mode: 'started', how: started.how };
  }
  console.error('× 自动启动 DSH 失败：' + (started.error || '未知原因'));
  console.error('  可手动执行：dsh web   或   npx @deepseek-ai/dsh web');
  return { ok: false, mode: 'spawn-failed', error: started.error };
}

function openConsoleBrowser() {
  if (!envFlagOn('DSH_OPEN_BROWSER', true)) return;
  const url = 'http://127.0.0.1:' + PORT;
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', url], { windowsHide: true, stdio: 'ignore', detached: true }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
    } else {
      spawn('xdg-open', [url], { stdio: 'ignore', detached: true }).unref();
    }
    console.log('  已尝试打开浏览器：' + url);
  } catch (e) {
    console.warn('  自动打开浏览器失败：' + e.message);
  }
}

/* ============ 本地接口：插件清单 ============
   通过 dsh --profile web --dump-config 拿到"合成后的插件树"，
   解析出每个插件的 id / 包名 / 来源层 / 是否禁用。
   dump 会重写 profile 的 cordis.yml（内容恒定的空模板），属只读语义。
   ============================================ */
let PLUGIN_CACHE = null;

/**
 * 把本机绝对路径压成末级文件名。
 * 插件清单里有两类值天生是绝对路径：`via`（实际调用的 dsh 垫片路径）与 `layer`
 * （`--dump-config` 的层标题就是补丁文件路径）。这份数据既会落盘成 plugins.json、
 * 也会显示在页面上 —— 带用户名与家目录既没必要，也不该跟着目录一起被拷走。
 * 例：C:\Users\<user>\.dsh\profiles\web\cordis.patch.yml → cordis.patch.yml
 */
function shortPath(s) {
  return String(s == null ? '' : s)
    // 只认真正的绝对路径：Windows 盘符路径，或 Unix 家目录下的路径。
    // （不能见 "/" 就切：包名里的 @scope/pkg 也带斜杠，切了会把层名写坏）
    .replace(/[A-Za-z]:[\\/][^\s"',;]*|\/(?:Users|home|root)\/[^\s"',;]*/g,
      (m) => m.split(/[\\/]/).filter(Boolean).pop() || m);
}

/**
 * 执行 dsh CLI 并返回 stdout。
 *
 * 两种部署都要能用，所以这里做两件事：
 *  1) **逐个候选试**（dshCandidates()：当前 npx 进程树 / PATH / 全局目录 / npx 缓存），
 *     每个候选先"绝对路径 + 经 shell"，再"绝对路径直接跑"；最后才退回依赖 PATH 的老写法。
 *     为什么"经 shell"要在前面：Windows 上 dsh 是 .cmd 垫片，较新 Node 直接执行 .cmd/.bat
 *     会 EINVAL（CVE-2024-27980 之后的加固），而 npx 缓存里的垫片又不在 PATH 上 —— 两者缺一不可。
 *  2) **管道被禁时改用文件重定向**：受限环境里 Node 拿不到子进程管道的输出（EPERM）。
 *     这时把 stdout/stderr 重定向到临时文件再读回来（文件句柄，不是命名管道）。
 *
 * @returns { out, how }  how 会显示在「插件」页上，方便排查实际用的是哪条路径
 */
function runDsh(args) {
  const cmdline = ['dsh', ...args].join(' ');
  const argStr = args.join(' ');
  // shell 模式下把整条命令行作为单个字符串传入：Node 对「args 数组 + shell:true」只做拼接不转义，
  // 会触发 DEP0190 警告，这里避开它。参数都是本文件里的固定字面量，没有外部输入。
  const attempts = [];
  for (const c of dshCandidates()) {
    const quoted = '"' + c.file + '" ' + argStr;
    if (/\.ps1$/i.test(c.file)) {
      // .ps1 垫片不能经 cmd.exe 跑，得交给 PowerShell
      attempts.push({ how: c.how + '（PowerShell）→ ' + c.file,
                      file: 'powershell', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', c.file, ...args], opts: {} });
    }
    attempts.push({ how: c.how + '（经 shell）→ ' + c.file, file: quoted, args: [], opts: { shell: true } });
    attempts.push({ how: c.how + ' → ' + c.file, file: c.file, args, opts: {} });
  }
  attempts.push({ how: 'dsh（直接）', file: 'dsh', args, opts: {} });
  attempts.push({ how: 'dsh.cmd', file: 'dsh.cmd', args, opts: {} });
  attempts.push({ how: 'dsh（经 shell）', file: cmdline, args: [], opts: { shell: true } });

  // 子进程环境：保证 node 自己能找到（npx 的 .cmd 垫片内部会调 node）
  const env = childEnv();
  const nodeDir = path.dirname(process.execPath);
  if (nodeDir && !String(env.PATH || '').split(path.delimiter).includes(nodeDir)) {
    env.PATH = nodeDir + path.delimiter + (env.PATH || '');
  }

  const tried = [];
  for (const a of attempts) {
    const opts = { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, windowsHide: true, timeout: 30000, env, ...a.opts };
    try {
      return { out: execFileSync(a.file, a.args, opts), how: a.how };
    } catch (e) {
      tried.push(a.how.split(' →')[0] + ': ' + (e.code || oneLine(e.message, 80)));
      // 管道被拒（EPERM）时，同一条命令改用文件重定向再试
      if (e.code === 'EPERM' || /EPERM|pipe/i.test(String(e.message))) {
        const alt = runDshViaFile(a.file, a.args, a.opts.shell === true, env);
        if (alt.ok) return { out: alt.out, how: a.how + '（输出重定向到文件）' };
        tried.push('  ↳ 重定向也失败: ' + alt.error);
      }
    }
  }
  // 失败信息要有用但不刷屏：条目多时只留头几条 + 最后两条（最后的往往是真实原因）
  const shown = tried.length > 5 ? [...tried.slice(0, 3), '…共 ' + tried.length + ' 种方式…', ...tried.slice(-2)] : tried;
  throw new Error('dsh 调用失败（' + oneLine(shown.join('；'), 700) + '）');
}

/** 把多行错误压成一行（页面与自检都要显示它） */
function oneLine(s, max) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max) + '…' : t;
}

/** 从子进程 stderr 里挑出最有信息量的那行（Node 的报错通常在代码帧之后） */
function pickStderr(err) {
  const lines = String(err || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const hit = lines.find(l => /\b(EACCES|EPERM|ENOENT|EEXIST|Error:|throw )/.test(l)) || lines[lines.length - 1] || '';
  return oneLine(hit, 160);
}

/**
 * 受限环境下用不了管道时的兜底：把子进程的 stdout/stderr 重定向到临时文件再读回来。
 * 只用文件句柄，不碰命名管道，所以在禁止管道的沙箱里也能用。
 */
function runDshViaFile(file, args, useShell, env) {
  const dir = tempDir();
  const stamp = process.pid + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
  const outFile = path.join(dir, 'dsh-console-' + stamp + '.out');
  const errFile = path.join(dir, 'dsh-console-' + stamp + '.err');
  let outFd, errFd;
  try {
    outFd = fs.openSync(outFile, 'w');
    errFd = fs.openSync(errFile, 'w');
    const r = spawnSync(file, useShell ? [] : args, {
      shell: useShell, stdio: ['ignore', outFd, errFd], windowsHide: true, timeout: 30000, env,
    });
    fs.closeSync(outFd); fs.closeSync(errFd); outFd = errFd = null;
    const out = fs.readFileSync(outFile, 'utf8');
    const err = fs.readFileSync(errFile, 'utf8');
    if (r.error) return { ok: false, error: (r.error.code || oneLine(r.error.message, 80)) + (err ? ' / stderr: ' + pickStderr(err) : '') };
    if (r.status !== 0) return { ok: false, error: 'exit ' + r.status + (err ? ' / stderr: ' + pickStderr(err) : '') };
    return { ok: true, out };                                // 只取 stdout：stderr 里的告警不能混进 YAML
  } catch (e) {
    return { ok: false, error: e.code || e.message };
  } finally {
    for (const fd of [outFd, errFd]) { try { if (fd != null) fs.closeSync(fd); } catch {} }
    for (const f of [outFile, errFile]) { try { fs.unlinkSync(f); } catch {} }
  }
}

/** 安全写 JSON 快照：失败只记日志，绝不影响主流程 */
function writeJsonSafe(file, obj) {
  try {
    fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.warn('[console] 写快照失败 ' + file + '：' + e.message);
    return false;
  }
}

/** 读控制台界面偏好。文件不存在 / 坏了都当"没设置过"，交给前端用自己的默认值 ——
 *  这里**不写任何默认值**：默认值属于 UI（会随版本变），落盘只存用户显式改过的键。
 *  旧 ui-prefs.json 读到就顺手迁移成 ui-prefs.yaml（读迁移，写永远只写 yaml）。 */
function prefsToYaml(obj) {
  return Object.entries(obj).map(([k, v]) => {
    if (typeof v === 'boolean' || typeof v === 'number') return k + ': ' + String(v);
    const s = String(v);
    // 纯"安全"字符且不撞 YAML 关键字/数字 → 裸串；否则单引号（'' 转义）
    const plain = /^[A-Za-z0-9_][A-Za-z0-9_\-./@ ]*$/.test(s) && !/^(true|false|null|yes|no|on|off)$/i.test(s) && !/^\d+(?:\.\d+)?$/.test(s);
    return k + ': ' + (plain ? s : "'" + s.replace(/'/g, "''") + "'");
  }).join('\n') + '\n';
}
function prefsFromYaml(text) {
  const out = {};
  String(text).split(/\r?\n/).forEach(line => {
    if (/^\s*#/.test(line)) return;                       // 注释行
    const m = /^([A-Za-z0-9_-]+)\s*:\s*(.*?)\s*$/.exec(line);
    if (!m) return;
    const k = m[1]; let v = m[2];
    if (v === '' || v === 'null' || v === '~') return;    // 没设置过的键
    if (v === 'true') out[k] = true;
    else if (v === 'false') out[k] = false;
    else if (/^-?\d+(?:\.\d+)?$/.test(v)) out[k] = Number(v);
    else if (/^".*"$/s.test(v)) { try { out[k] = JSON.parse(v); } catch { out[k] = v.slice(1, -1); } }
    else if (/^'.*'$/s.test(v)) out[k] = v.slice(1, -1).replace(/''/g, "'");
    else out[k] = v;
  });
  return out;
}
function loadUiPrefs() {
  try {
    const p = prefsFromYaml(fs.readFileSync(UI_PREFS_FILE, 'utf8'));
    if (Object.keys(p).length) return p;
  } catch {}
  try {
    const j = JSON.parse(fs.readFileSync(UI_PREFS_LEGACY, 'utf8'));
    if (j && typeof j === 'object' && !Array.isArray(j) && Object.keys(j).length) {
      try { fs.writeFileSync(UI_PREFS_FILE, prefsToYaml(j), 'utf8'); } catch {}
      return j;
    }
  } catch {}
  return {};
}
/** 写界面偏好（yaml）。失败只记日志、返回 false，绝不影响主流程 */
function writeUiPrefs(obj) {
  try {
    fs.writeFileSync(UI_PREFS_FILE, prefsToYaml(obj), 'utf8');
    return true;
  } catch (e) {
    console.warn('[console] 写界面偏好失败 ' + UI_PREFS_FILE + '：' + e.message);
    return false;
  }
}

function loadPlugins(force) {
  if (PLUGIN_CACHE && !force) return PLUGIN_CACHE;
  const profile = process.env.DSH_PROFILE || 'web';
  let raw = '';
  let how = null;
  try {
    const r = runDsh(['--profile', profile, '--dump-config']);
    raw = r.out; how = r.how;
  } catch (e) {
    // 回退：读预导出的清单文件（server 进程在沙箱内无法 spawn dsh 时的常规路径）
    try {
      const fb = JSON.parse(fs.readFileSync(path.join(__dirname, 'plugins.json'), 'utf8'));
      // 旧快照里可能存着绝对路径（via / layer）：读进来时一并脱敏，避免继续显示与回写
      const fbLayers = {};
      for (const [k, v] of Object.entries(fb.layers || {})) fbLayers[shortPath(k)] = v;
      PLUGIN_CACHE = {
        source: 'snapshot-file',
        error: shortPath(String(e.message).slice(0, 200)),
        profile: fb.profile || profile,
        at: fb.at,
        layers: fbLayers,
        plugins: (fb.plugins || fb || []).map(p => ({ ...p, layer: shortPath(p.layer) })),
      };
      return PLUGIN_CACHE;
    } catch {
      PLUGIN_CACHE = { source: 'error', error: shortPath(String(e.message).slice(0, 200)), plugins: [] };
      return PLUGIN_CACHE;
    }
  }
  const lines = raw.split(/\r?\n/);
  const plugins = [];
  const layers = {};
  let layer = 'unknown';
  for (let i = 0; i < lines.length; i++) {
    const b = lines[i].match(/^# == (.+)$/);
    if (b) { layer = shortPath(b[1].trim()); layers[layer] = (layers[layer] || 0) + 1; continue; }
    const idm = lines[i].match(/^- id: (.+)$/);
    if (idm && lines[i + 1] && /^  name: '(.+)'$/.test(lines[i + 1])) {
      const name = lines[i + 1].match(/^  name: '(.+)'$/)[1];
      // 该行往后 6 行内若出现 disabled: true 则视为禁用
      let disabled = false;
      for (let k = i + 2; k < Math.min(i + 8, lines.length); k++) {
        if (/^- id: /.test(lines[k]) || /^# == /.test(lines[k])) break;
        if (/^\s*disabled:\s*true\s*$/.test(lines[k])) { disabled = true; break; }
      }
      const pkg = name.replace('@deepseek-ai/', '');
      plugins.push({ id: idm[1].trim(), name, pkg, layer: shortPath(layer), disabled });
    }
  }
  PLUGIN_CACHE = { source: 'dump-config', via: shortPath(how), profile, at: new Date().toISOString(), layers, plugins };
  // 实时 dump 成功 → 顺手回写快照。
  // 这样以后即使 dump 失败（受限环境 / dsh 不可用），兜底用的也是最近一次真实结果，
  // 而不是某一天的旧存档；快照的 at 语义因此是"最后一次成功探测时间"。
  writeJsonSafe(path.join(__dirname, 'plugins.json'), PLUGIN_CACHE);
  return PLUGIN_CACHE;
}

/* ============ 本地接口：MCP 服务清单 ============
   数据来源（全部真实，无写死）：
   1) ~/.dsh/profiles/<profile>/cordis.patch.yml —— 补丁层里的 mcp-client 实例
   2) 连接状态：探测 GeoScene Pro 进程 / 端口，或依据 DSH 是否加载成功

   ⚠️ 读取范围只有"补丁层"这一个文件。bundle 层（base / web-app）里自带的
   mcp-client 实例不在读取范围内——把服务配在 bundle 层，MCP 页会空着且不报错。
   ================================================= */
function readMcpServers() {
  const profile = process.env.DSH_PROFILE || 'web';
  const patchPath = path.join(dshHomeDir(), 'profiles', profile, 'cordis.patch.yml');
  const servers = [];
  const warnings = [];

  let yml = '';
  try { yml = fs.readFileSync(patchPath, 'utf8'); }
  catch (e) { warnings.push('读取补丁文件失败: ' + patchPath + ' (' + e.code + ')'); }

  if (yml) {
    /* 极简 YAML 解析：按"补丁条目"切分，只认条目里出现 dsh-mcp-client 且写了 serverName 的。
       条目边界取每个 `- id: xxx` 行（嵌套 insert 里的 `- id:` 缩进更深，同样算一个条目）。

       ⚠️ 不能按 /\n(?=\s*-?\s*id:\s*mcp)/ 切——那样只认 id 以 mcp 开头的行，有两个坑：
       ① 「非 mcp 命名」的条目会和它前面那条粘成一块，块里第一个 `id:` 被当成它的 id
          （实测夹具：id 被错认成前一个无关插件），于是 /api/local/mcp 的 loadedByDsh
          交叉校验对不上，页面误报"DSH 未加载"；
       ② 同一个块里的 transport / command 也可能被另一条配置顶掉。
       现在 id 与各字段都限定在该条目自己的文本里取，与 id 怎么起名无关。 */
    const lines = yml.split(/\r?\n/);
    const starts = [];
    lines.forEach((l, i) => { if (/^\s*-?\s*id:\s*\S/.test(l)) starts.push(i); });
    // 兼容没有 `id:` 行的异常文件：整份当一个条目看（保持旧行为）
    if (!starts.length && /dsh-mcp-client/.test(yml)) starts.push(0);

    for (let n = 0; n < starts.length; n++) {
      const from = starts[n];
      const to = n + 1 < starts.length ? starts[n + 1] : lines.length;
      const text = lines.slice(from, to).join('\n');
      if (!/dsh-mcp-client/.test(text)) continue;
      const pick = (k) => { const m = text.match(new RegExp('^\\s+' + k + ':\\s*(.+)$', 'm')); return m ? m[1].trim().replace(/^['"]|['"]$/g, '') : undefined; };
      const id = (lines[from].match(/id:\s*(\S+)/) || [])[1];
      const serverName = pick('serverName');
      const transport = pick('transport');
      if (!serverName) continue;
      servers.push({
        id, serverName, transport,
        target: transport === 'streamable-http' ? (pick('url') || '—') : (pick('command') || '—'),
        configured: true,
        source: 'cordis.patch.yml',
        _entryText: text,          // 供下面取展示元数据，返回前删掉
      });
    }
  }
  // 为每个服务补"展示元数据"——优先取配置里显式写的字段，否则从 serverName 推断
  for (const s of servers) {
    const raw = s._entryText || ''; delete s._entryText;
    const meta = (k) => { const m = raw.match(new RegExp('^\\s+' + k + ':\\s*(.+)$', 'm')); return m ? m[1].trim().replace(/^['"]|['"]$/g, '') : undefined; };
    // 也支持从配置行的注释里读描述：# desc: xxx / # note: xxx
    const cmt = (k) => { const m = raw.match(new RegExp('#\\s*' + k + '\\s*[:：]\\s*(.+)$', 'm')); return m ? m[1].trim() : undefined; };
    // ⚠️ 不要取 config.name —— 那是插件包名（@deepseek-ai/dsh-mcp-client），不是服务显示名
    s.displayName = meta('displayName') || cmt('name') || s.serverName;
    s.vendor = meta('vendor') || meta('provider') || '—';
    s.kind = s.transport === 'streamable-http' ? '服务器平台' : '桌面客户端';
    s.description = meta('description') || cmt('desc') || cmt('description') || '';
    s.note = meta('note') || cmt('note') || '';
    s.ns = 'mcp__' + s.serverName + '__*';
    // 分组：优先配置里声明的 groups；否则留空（页面不显示该区块）
    const gRaw = meta('groups');
    s.groups = gRaw ? gRaw.replace(/[\[\]]/g, '').split(',').map(x => x.trim()).filter(Boolean) : [];
  }
  return { servers, warnings, patchPath };
}

/** 最近一次成功握手数到的工具数（跨请求缓存） */
let MCP_TOOLS_CACHE = null;
/** 最近一次握手取到的工具名清单 */
let MCP_TOOLS_LIST = null;

/** 异步 TCP 端口探测（无需子进程，沙箱内可用） */
function probePort(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const net = require('node:net');
    const sock = net.connect({ host, port });
    let done = false;
    const fin = (v) => { if (!done) { done = true; try { sock.destroy(); } catch {} resolve(v); } };
    sock.setTimeout(timeoutMs);
    sock.on('connect', () => fin(true));
    sock.on('timeout', () => fin(null));
    sock.on('error', () => fin(false));
  });
}

/**
 * 真实 MCP 握手：启动 GeoScene MCP 服务端，发 initialize + tools/list，
 * 数出实际工具个数。失败返回 null（页面会显示"未探测"）。
 * 复用 DSH 的 mcp-client 同款启动方式：StartGeoSceneMcp（PATH 上的 .bat）。
 */
function handshakeToolCount() {
  return new Promise((resolve) => {
    let cp;
    try {
      cp = require('node:child_process').spawn('StartGeoSceneMcp', [], {
        stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, shell: true,
        env: childEnv(),
      });
    } catch { return resolve(null); }

    let buf = ''; let done = false;
    const fin = (v) => { if (done) return; done = true; try { cp.kill(); } catch {} resolve(v); };
    const t = setTimeout(() => fin(null), 15000);

    cp.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      // 逐行找 JSON-RPC 响应
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line.startsWith('{')) continue;
        try {
          const j = JSON.parse(line);
          if (j.id === 2 && j.result && Array.isArray(j.result.tools)) {
            clearTimeout(t);
            fin({ count: j.result.tools.length, names: j.result.tools.map(x => x.name) });
          }
        } catch {}
      }
    });
    cp.on('error', () => { clearTimeout(t); fin(null); });
    cp.on('close', () => { clearTimeout(t); fin(null); });

    const send = (o) => { try { cp.stdin.write(JSON.stringify(o) + '\n'); } catch {} };
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'dsh-console', version: '1.0' } } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  });
}

/**
 * 握手成功 → 把工具清单回写 mcp-tools.json 快照（保留原文件的说明字段）。
 * 与 plugins.json 同理：快照 = 最后一次成功握手的真实结果。
 */
function saveMcpSnapshot(serverName, n) {
  const file = path.join(__dirname, 'mcp-tools.json');
  let snap = {};
  try { snap = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  const servers = { ...(snap.servers || {}) };
  servers[serverName] = { tools: n.count, source: 'mcp-tools/list', toolNames: n.names };
  writeJsonSafe(file, {
    note: snap.note || '真实 MCP 握手结果（initialize + tools/list），由 GeoScene MCP 服务端返回',
    at: new Date().toISOString(),
    method: snap.method || 'stdio: StartGeoSceneMcp',
    servers,
  });
}

/** 探测每个 MCP 服务的实际可用性（不依赖 DSH 内部状态） */
async function probeMcp(server) {
  const out = { ...server, status: 'unknown', tools: null, toolsSource: null };
  if (/geoscenepro/i.test(server.serverName)) {
    // 桌面端：GeoScene Pro 进程 + MCP socket 端口（communication.config: 127.0.0.1:11000）
    // 首选 TCP 探测 GeoScene MCP 端口（communication.config: 127.0.0.1:11000）
    const portUp = await probePort('127.0.0.1', 11000);
    out.endpoint = '127.0.0.1:11000';
    out.portOpen = portUp;
    if (portUp === true) {
        out.status = 'connected';
        // 真握手：向 GeoScene MCP 服务发 initialize + tools/list，数工具个数
        // 握手（本环境可能因沙箱禁止 spawn 而失败）→ 缓存 → 回退到上次成功值
        const n = await handshakeToolCount();
        if (n && n.count != null) {
          MCP_TOOLS_CACHE = n.count;
          MCP_TOOLS_LIST = n.names;
          out.tools = n.count;
          out.toolNames = n.names;
          out.toolsSource = 'mcp-tools/list';
          saveMcpSnapshot(server.serverName, n);   // 实时握手成功 → 回写快照
        } else if (MCP_TOOLS_CACHE != null) {
          out.tools = MCP_TOOLS_CACHE;
          out.toolNames = MCP_TOOLS_LIST;
          out.toolsSource = 'mcp-tools/list(cached)';
        } else {
          // 回退：读离线握手快照（真实握手过，只是当前进程无法 spawn）
          try {
            const snap = JSON.parse(fs.readFileSync(path.join(__dirname, 'mcp-tools.json'), 'utf8'));
            const hit = snap.servers?.[server.serverName];
            out.tools = hit?.tools ?? null;
            out.toolNames = hit?.toolNames ?? null;
            out.toolsSource = hit ? 'snapshot(离线握手 ' + String(snap.at).slice(0, 10) + ')' : 'handshake-unavailable';
          } catch {
            out.tools = null;
            out.toolsSource = 'handshake-unavailable';
          }
        }
      }
    else if (portUp === false) { out.status = 'offline'; out.tools = 0; out.toolsSource = 'mcp-unreachable'; }
    else { out.status = 'unknown'; out.tools = null; out.toolsSource = null; }
  } else {
    out.status = server.configured ? 'configured' : 'available';
  }
  return out;
}

async function proxy(req, res, pathname, search) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  /* 浏览器断开（刷新 / 关标签 / 前端主动 abort）时把中止传给 DSH。
     为什么必须有：有些接口是"等人操作"的长请求 —— 最典型的是
     directoryPicker/pick（弹系统文件夹对话框）。DSH 收到中止会给对话框发 WM_CLOSE 把它关掉；
     不传的话，用户一刷新页面就留下一个点不掉的原生对话框，只能手动叉掉。
     注意 res 'close' 在正常结束也会触发，所以用 writableEnded 判一次。 */
  const ac = new AbortController();
  const onClose = () => { if (!res.writableEnded) ac.abort(); };
  res.on('close', onClose);
  // 令牌过期时 DSH 会在任意请求上回 401：就地换一次 cookie 再重发一次，
  // 免得用户看到"页面全空"却不知道只要重新认证一下。
  const send = () => fetch(DSH + pathname + (search || ''), {
    method: req.method,
    // 认证头必须带上：DSH 的 /api/* 需要令牌换来的会话 cookie
    headers: { 'content-type': req.headers['content-type'] || 'application/json', ...authHeaders() },
    body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
    signal: ac.signal,
  });
  try {
    let upstream = await send();
    if (upstream.status === 401 && DSH_TOKEN) {
      const again = await ensureDshAuth(true);
      if (again.ok) upstream = await send();
    }
    const headers = { 'content-type': upstream.headers.get('content-type') || 'application/json' };
    // 只转 content-disposition（下载文件名）。**不转 content-length**：
    // fetch 会自动解压 gzip，上游声明的长度是压缩后的，照抄会让响应长度对不上；
    // res.end(buf) 会按真实字节数自己补上正确的 Content-Length。
    const cd = upstream.headers.get('content-disposition');
    if (cd) headers['content-disposition'] = cd;
    // 会话日志导出是 ZIP：必须按字节转发，按文本解码会损坏二进制
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(upstream.status, headers);
    res.end(buf);
  } catch (e) {
    if (ac.signal.aborted) return;         // 客户端自己走了，没人在等这个响应
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'DSH 主机不可达: ' + e.message + ' （目标 ' + DSH + '）' }));
  } finally {
    res.off('close', onClose);
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const pathname = url.pathname;

  // 本地接口（不转发给 DSH）
  /* DSH 目标配置：地址 + 令牌。
     GET  → 当前状态（是否已配置、是否已认证、失败原因）
     POST → 保存并立即验证；连接成功才落盘到 dsh-config.json
            body: { url } | { url, keep:true }（keep=只保存不验证）| { clear:true }（恢复默认） */
  if (pathname === '/api/local/dsh') {
    if (req.method === 'GET') {
      const st = await dshStatus();
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      return void res.end(JSON.stringify(st));
    }
    if (req.method === 'POST') {
      let body = {};
      try { body = await readJsonBody(req); }
      catch (e) { res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, error: e.message })); return; }

      if (body.clear) {
        dropDshConfig();
        DSH = DEFAULT_DSH; DSH_TOKEN = ''; DSH_SOURCE = 'default';
        AUTH_COOKIE = ''; AUTH_EXPIRES = 0; AUTH_ERROR = '';
        const st = await dshStatus();
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        return void res.end(JSON.stringify({ ok: true, cleared: true, status: st }));
      }

      const parsed = parseDshInput(body.url);
      if (parsed.error) {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
        return void res.end(JSON.stringify({ ok: false, error: parsed.error }));
      }
      // 只给令牌时沿用当前地址；给了地址就完全按地址来（没有 ?token= 就是不使用令牌）
      const nextOrigin = parsed.kind === 'url' ? parsed.origin : DSH;
      const nextToken = parsed.token || (parsed.kind === 'url' ? '' : DSH_TOKEN);
      const prev = { DSH, DSH_TOKEN, DSH_SOURCE, AUTH_COOKIE, AUTH_EXPIRES, AUTH_ERROR };
      DSH = nextOrigin; DSH_TOKEN = nextToken; DSH_SOURCE = 'ui';
      AUTH_COOKIE = ''; AUTH_EXPIRES = 0; AUTH_ERROR = '';

      const st = await dshStatus();
      const good = st.state === 'ok';
      if (good || body.keep) {
        saveDshConfig(DSH, DSH_TOKEN);
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        return void res.end(JSON.stringify({ ok: true, saved: true, verified: good, status: st }));
      }
      // 验证不过 → 回滚到原来的目标，把失败原因交回页面（避免把错的地址存下来）
      ({ DSH, DSH_TOKEN, DSH_SOURCE, AUTH_COOKIE, AUTH_EXPIRES, AUTH_ERROR } = prev);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      return void res.end(JSON.stringify({ ok: false, saved: false, error: st.error || st.detail, status: st }));
    }
    res.writeHead(405, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'method not allowed' }));
    return;
  }

  if (pathname === '/api/local/mcp') {
    const inv = readMcpServers();
    const plugins = loadPlugins();
    // DSH 侧证据：插件树里实际加载了几个 mcp-client 实例
    const loaded = (plugins.plugins || []).filter(p => p.pkg.includes('mcp-client'));
    const enriched = await Promise.all(inv.servers.map(async (s) => {
      const p = await probeMcp(s);
      const inTree = loaded.some(x => x.id === s.id);
      return { ...p, loadedByDsh: inTree, pluginId: loaded.find(x => x.id === s.id)?.id };
    }));
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    return void res.end(JSON.stringify({
      source: 'cordis.patch.yml + dump-config',
      at: new Date().toISOString(),
      patchPath: inv.patchPath,
      warnings: inv.warnings,
      servers: enriched,
      loadedMcpPlugins: loaded.map(x => ({ id: x.id, pkg: x.pkg, disabled: x.disabled })),
    }));
  }
  if (pathname === '/api/local/skills') {
    // 项目根取「会话的工作目录」，而不是 console 进程自己的 cwd
    const projectRoot = url.searchParams.get('cwd') || process.env.DSH_SESSION_CWD || process.cwd();
    const home = process.env.USERPROFILE || process.env.HOME || '';
    const roots = [
      { scope: 'project', label: '项目级', path: path.join(projectRoot, '.dsh', 'skills'), rank: 100 },
      { scope: 'project-agents', label: '项目级(.agents)', path: path.join(projectRoot, '.agents', 'skills'), rank: 200 },
      { scope: 'user', label: '用户级', path: path.join(dshHomeDir(), 'skills'), rank: 400 },
      { scope: 'user-agents', label: '用户级(.agents)', path: path.join(home, '.agents', 'skills'), rank: 500 },
    ];
    const found = [];
    for (const root of roots) {
      let entries = [];
      try { entries = fs.readdirSync(root.path, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        let file = null;
        if (e.isDirectory()) {
          const cand = path.join(root.path, e.name, 'SKILL.md');
          if (fs.existsSync(cand)) file = cand;
        } else if (e.isFile() && e.name.endsWith('.md') && e.name !== 'README.md') {
          file = path.join(root.path, e.name);
        }
        if (!file) continue;
        // 解析 frontmatter
        const text = fs.readFileSync(file, 'utf8');
        const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
        const pick = (k) => { const m = fm && fm[1].match(new RegExp('^' + k + ':\\s*(.+)$', 'm')); return m ? m[1].trim().replace(/^['"]|['"]$/g, '') : undefined; };
        found.push({
          name: pick('name') || e.name.replace(/\.md$/, ''),
          description: pick('description'),
          whenToUse: pick('whenToUse'),
          scope: root.scope, scopeLabel: root.label, rank: root.rank,
          rootPath: root.path, file, bytes: Buffer.byteLength(text, 'utf8'),
        });
      }
    }
    found.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    return void res.end(JSON.stringify({
      source: 'filesystem-scan', at: new Date().toISOString(),
      cwd: projectRoot, processCwd: process.cwd(),
      roots: roots.map(x => ({ ...x, exists: fs.existsSync(x.path) })),
      skills: found,
    }));
  }
  if (pathname === '/api/local/plugins') {
    const force = url.searchParams.get('refresh') === '1';
    const data = loadPlugins(force);
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    return void res.end(JSON.stringify(data));
  }

  /* 本地建目录：DSH 的 directoryPicker/createDirectory 需要 browse 能力（本部署门控，
     与 /api/local/fs 绕过浏览门控同理，走本机文件系统）。
     POST body: { path, name } → 在 path 下创建 name 目录，成功返回 { ok:true, path } */
  if (pathname === '/api/local/mkdir' && req.method === 'POST') {
    let body = {};
    try { body = await readJsonBody(req); }
    catch (e) { res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, error: e.message })); return; }
    const parent = String(body.path || '');
    const name = String(body.name || '').trim();
    if (!parent || !name || /[\\/:*?"<>|]/.test(name) || name === '.' || name === '..') {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
      return void res.end(JSON.stringify({ ok: false, error: '父路径或目录名不合法' }));
    }
    try {
      const full = path.join(parent, name);
      fs.mkdirSync(full, { recursive: false });
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      return void res.end(JSON.stringify({ ok: true, path: full }));
    } catch (e) {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      return void res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  }

  /* 控制台界面偏好：GET 读、POST 合并写，落盘到项目内的 ui-prefs.yaml。
     与 DSH 设置完全无关（不改 ~/.dsh/settings.yaml、不影响任何会话）；
     放服务端是为了跨浏览器一致 + 不随缓存清理丢失。 */
  if (pathname === '/api/local/prefs') {
    const reply = (obj) => {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(obj));
    };
    if (req.method === 'POST') {
      let body = {};
      try { body = await readJsonBody(req); }
      catch (e) { res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' }); return void res.end(JSON.stringify({ ok: false, error: e.message })); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
        return void res.end(JSON.stringify({ ok: false, error: '请求体必须是一个 JSON 对象' }));
      }
      // 只接受布尔与字符串键值：这里存的是界面开关，不做通用配置存储
      const clean = {};
      for (const [k, v] of Object.entries(body)) {
        if (typeof v === 'boolean' || typeof v === 'string' || typeof v === 'number') clean[k] = v;
      }
      const next = { ...loadUiPrefs(), ...clean };
      const ok = writeUiPrefs(next);
      return reply({ ok, prefs: next, file: shortPath(UI_PREFS_FILE) });
    }
    return reply({ ok: true, prefs: loadUiPrefs(), file: shortPath(UI_PREFS_FILE) });
  }

  /* 本机凭据键名（只读键名，绝不读值）。
     DSH 的 credentials/describe **只能按名查询**：传 refs:[] 只会返回 {}，
     没有"列出全部键名"的能力 —— 所以页面上永远显示"还没有查到任何凭据"，
     而 ~/.dsh/.credentials.yaml 里其实早就有配好的 Key（这就是"凭据里面也没有显示"的根因）。
     这里只把 YAML 的 **键名**（refs / records 两段）解析出来交给页面，
     页面前端再拿这些名字去 credentials/describe 逐个确认状态 —— 状态仍以 DSH 为准。
     本接口在任何情况下都不读取、不返回凭据的值。 */
  if (pathname === '/api/local/credentials') {
    const file = path.join(dshHomeDir(), '.credentials.yaml');
    const out = { source: 'local-file', file, exists: false, refs: [], records: [], error: null, at: new Date().toISOString() };
    try {
      if (fs.existsSync(file)) {
        out.exists = true;
        const text = fs.readFileSync(file, 'utf8');
        let section = null;
        for (const raw of text.split(/\r?\n/)) {
          if (!raw.trim() || /^\s*#/.test(raw)) continue;
          const top = /^([A-Za-z_][\w-]*)\s*:\s*$/.exec(raw);        // 顶层段名（refs: / records: / version: 4 不算）
          if (top) { section = top[1]; continue; }
          const child = /^ {2}([^\s:#][^:]*?)\s*:/.exec(raw);        // 只取段的直接子键（缩进 2 空格），嵌套字段（缩进 4/6）不算
          if (child && (section === 'refs' || section === 'records')) {
            const name = child[1].replace(/^["']|["']$/g, '').trim();
            if (name) out[section].push(name);
          }
        }
      }
    } catch (e) { out.error = e.message; }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    return void res.end(JSON.stringify(out));
  }

  /* 本地目录浏览：DSH 本部署的 host.listDirectory 需要 browse 能力（当前只装了 native），
     所以 @ 文件引用 / 交付物面板改用本机文件系统直读——数据仍然是真的，不是写死的清单。
     返回结构与 host.listDirectory 对齐：{ path, home, crumbs[], entries[], truncated } */
  if (pathname === '/api/local/fs') {
    const home = process.env.USERPROFILE || process.env.HOME || process.cwd();
    const raw = url.searchParams.get('path') || home;
    const wantFiles = url.searchParams.get('files') !== '0';
    let target;
    try { target = path.resolve(raw); } catch { target = home; }
    const entries = [];
    const crumbs = [];
    let truncated = false;
    let error = null;
    try {
      const st = fs.statSync(target);
      if (!st.isDirectory()) { target = path.dirname(target); }
    } catch (e) { error = '目录不可读：' + e.message; }
    if (!error) {
      // 面包屑：从盘符/根到当前目录
      const parts = target.split(path.sep).filter(Boolean);
      let acc = '';
      for (const seg of parts) {
        acc = acc ? acc + path.sep + seg : seg + path.sep;
        crumbs.push({ name: seg, path: acc, hidden: seg.startsWith('.') });
      }
      let list = [];
      try { list = fs.readdirSync(target, { withFileTypes: true }); }
      catch (e) { error = '目录不可读：' + e.message; }
      const skip = new Set(['node_modules', '.git']);
      for (const e of list) {
        if (skip.has(e.name)) continue;
        let isDir = e.isDirectory();
        let size = 0, mtime = 0;
        try { const s = fs.statSync(path.join(target, e.name)); isDir = s.isDirectory(); size = s.size; mtime = s.mtimeMs; } catch {}
        if (!isDir && !wantFiles) continue;
        entries.push({ name: e.name, path: path.join(target, e.name), hidden: e.name.startsWith('.'), dir: isDir, size, mtime });
      }
      entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
      if (entries.length > 600) { entries.length = 600; truncated = true; }
    }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    return void res.end(JSON.stringify({
      source: 'local-filesystem', at: new Date().toISOString(),
      path: target, home, crumbs, entries, truncated, error,
    }));
  }

  /* 交付物：会话工作目录里"最近落盘"的成果文件（真实 stat，不写死清单） */
  if (pathname === '/api/local/deliverables') {
    const cwd = url.searchParams.get('cwd') || process.cwd();
    const limit = Math.min(Number(url.searchParams.get('limit') || 60) || 60, 300);
    const days = Number(url.searchParams.get('days') || 0) || 0;
    const EXT = new Set(['.md', '.json', '.jsonl', '.csv', '.txt', '.jpg', '.jpeg', '.png', '.webp', '.gif',
      '.svg', '.pdf', '.xlsx', '.xls', '.docx', '.doc', '.zip', '.shp', '.dbf', '.shx', '.prj', '.lyrx',
      '.aprx', '.gdb', '.kml', '.geojson', '.html', '.cjs', '.mjs', '.js', '.ts', '.py', '.yml', '.yaml', '.log']);
    const skipDir = new Set(['node_modules', '.git', '.dsh', 'public', 'dist', 'build', '__pycache__']);
    const out = [];
    const cutoff = days ? Date.now() - days * 86400000 : 0;
    function walk(dir, depth) {
      if (depth > 2 || out.length > 4000) return;
      let list = [];
      try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of list) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { if (skipDir.has(e.name) || e.name.startsWith('.')) continue; walk(full, depth + 1); continue; }
        if (e.name.startsWith('.')) continue;          // 隐藏文件不算交付物
        const ext = path.extname(e.name).toLowerCase();
        if (!EXT.has(ext)) continue;
        let st; try { st = fs.statSync(full); } catch { continue; }
        if (cutoff && st.mtimeMs < cutoff) continue;
        out.push({ name: e.name, path: full, rel: path.relative(cwd, full), ext: ext.slice(1),
          size: st.size, mtime: st.mtimeMs });
      }
    }
    walk(cwd, 0);
    out.sort((a, b) => b.mtime - a.mtime);
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    return void res.end(JSON.stringify({
      source: 'local-filesystem-walk', at: new Date().toISOString(),
      cwd, scanned: out.length, items: out.slice(0, limit),
    }));
  }

  /* 会话附件（session/attachment）：图片字节不在会话日志里，日志只记 attachmentId。
     这里替浏览器把字节取回来 —— 页面上就能直接 <img src="/api/local/attachment?…">，
     不必把 base64 塞进 HTML，也不会因为 <img> 带不上认证 cookie 而 401。
     只回图片（该端点的返回类型就是 ImageAttachmentRef）；文件块只有元信息，不给下载。 */
  if (pathname === '/api/local/attachment') {
    const sid = url.searchParams.get('sessionId') || '';
    const aid = url.searchParams.get('attachmentId') || '';
    const dl = url.searchParams.get('download') === '1';
    if (!sid || !aid) { res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: '需要 sessionId 与 attachmentId' })); return; }
    try {
      const v = await remoteCall('session/attachment', { request: { sessionId: sid, attachmentId: aid } });
      const att = (v && v.attachment) || {};
      const buf = Buffer.from(String((v && v.data) || ''), 'base64');
      if (!buf.length) throw Object.assign(new Error('附件内容为空'), { code: 'empty' });
      const name = att.name || (String(aid).replace(/^sha256:/, '').slice(0, 12) + '.bin');
      const head = {
        'content-type': att.mediaType || 'application/octet-stream',
        'content-length': String(buf.length),
        'cache-control': 'private, max-age=600',      // 内容寻址（attachmentId 是 sha256），可以放心缓存
      };
      if (dl) head['content-disposition'] = 'attachment; filename="' + name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '')
        + '"; filename*=UTF-8\'\'' + encodeURIComponent(name);
      res.writeHead(200, head);
      res.end(buf);
    } catch (e) {
      const code = e.code || 'error';
      // 附件不存在 / 不属于这个会话 / 该模型不支持图片 → 都是"要不到"，给 404 让前端显示清楚
      const miss = /not-referenced|invalid|not-found|MODEL_DOES_NOT_SUPPORT|empty/i.test(code + ' ' + (e.message || ''));
      res.writeHead(miss ? 404 : 502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: e.message, code }));
    }
    return;
  }

  /* 单文件下载：把交付物交回给浏览器（127.0.0.1 绑定，仅供本机控制台使用） */
  if (pathname === '/api/local/download') {
    const target = url.searchParams.get('path') || '';
    if (!target) { res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: '缺少 path 参数' })); return; }
    let st;
    try { st = fs.statSync(target); } catch (e) {
      res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: '文件不存在：' + e.message })); return;
    }
    if (!st.isFile()) { res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: '不是文件' })); return; }
    const name = path.basename(target);
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': String(st.size),
      // filename* 用 UTF-8 编码，避免中文文件名乱码
      'content-disposition': 'attachment; filename="' + name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '') + '"; filename*=UTF-8\'\'' + encodeURIComponent(name),
    });
    fs.createReadStream(target).pipe(res);
    return;
  }

  if (pathname.startsWith('/api/')) return void proxy(req, res, pathname, url.search);
  serveStatic(req, res, pathname);
});

/* ============ WebSocket 双工桥接（零依赖实现）============
   DSH 的 /api/events.mux 不是 SSE，而是 WebSocket（GET 会返回 426 upgrade required）。
   浏览器直连会被同源策略挡住，所以把 ws://127.0.0.1:3081/api/events.mux 桥到 DSH 上游。

   为什么不用 ws 库：本工程不装 node_modules。而**这个桥接本来就是透明字节管道**——
   浏览器发出的帧已按客户端规则掩码，上游作为服务端需要的正是掩码帧；上游回的帧未掩码，
   浏览器作为客户端需要的也正是不带掩码的帧。所以中间既不用解帧、也不用重新编码，
   只要「两侧握手都做对，然后双向 pipe 原始字节」即可，因此不需要任何库。

   安全边界：只代理 /api/ 下的路径，且服务只绑 127.0.0.1。
   ======================================================== */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const wsAccept = (key) => crypto.createHash('sha1').update(key + WS_GUID).digest('base64');

/** 桥接失败日志：同一原因 10 秒内只报一次（浏览器每 3 秒会自动重连，否则会刷屏） */
let wsLastMsg = '', wsLastAt = 0;
function wsLog(msg) {
  const now = Date.now();
  if (msg === wsLastMsg && now - wsLastAt < 10000) return;
  wsLastMsg = msg; wsLastAt = now;
  console.error('[console] 实时流桥接断开：' + msg);
}

server.on('upgrade', (req, socket, head) => {
  const u = new URL(req.url, 'http://x');
  if (!u.pathname.startsWith('/api/')) { socket.destroy(); return; }

  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }

  const upstream = new URL(DSH);
  const isTls = upstream.protocol === 'https:';
  const upPort = Number(upstream.port) || (isTls ? 443 : 80);
  // DSH 配在子路径上时（如 http://host/dsh）要把前缀拼进请求行
  const upPrefix = upstream.pathname && upstream.pathname !== '/' ? upstream.pathname.replace(/\/+$/, '') : '';
  const up = isTls
    ? tls.connect({ host: upstream.hostname, port: upPort, servername: upstream.hostname })
    : net.connect({ host: upstream.hostname, port: upPort });
  up.setNoDelay(true);
  socket.setNoDelay(true);

  const upKey = crypto.randomBytes(16).toString('base64');
  let handshaken = false;          // 上游 101 是否已校验通过
  let dead = false;
  let hdrBuf = Buffer.alloc(0);
  let retriedAuth = false;         // 401 拒绝后只重换一次令牌，避免死循环
  const pending = [];              // 握手完成前先攒着浏览器发来的字节
  let clientHead = head && head.length ? head : null;

  const cleanup = () => {
    if (dead) return;
    dead = true;
    try { socket.destroy(); } catch {}
    try { up.destroy(); } catch {}
  };
  const fail = (why) => { if (!dead) wsLog(why); cleanup(); };

  // 先把两侧的监听都挂上，避免连接被重置时抛未捕获错误
  socket.on('data', (chunk) => {
    if (!handshaken) { pending.push(chunk); return; }
    if (!up.destroyed) up.write(chunk);
  });
  socket.on('error', cleanup);
  socket.on('close', cleanup);
  socket.on('end', cleanup);
  up.on('error', (e) => fail(e.message));
  up.on('close', cleanup);

  up.on('connect', () => {
    up.write(
      'GET ' + upPrefix + u.pathname + (u.search || '') + ' HTTP/1.1\r\n'
      + 'Host: ' + upstream.host + '\r\n'
      + 'Upgrade: websocket\r\n'
      + 'Connection: Upgrade\r\n'
      + 'Sec-WebSocket-Key: ' + upKey + '\r\n'
      + 'Sec-WebSocket-Version: 13\r\n'
      // 实时流 upgrade 也走浏览器会话鉴权，必须带上令牌换来的 cookie
      + (AUTH_COOKIE ? 'Cookie: ' + AUTH_COOKIE + '\r\n' : '')
      + '\r\n'
    );
  });

  /* 读上游的 101 响应头。只有上游握手校验通过，才回浏览器 101 ——
     这样 DSH 没起来时浏览器会直接连接失败（界面显示"实时流断开"），
     而不是先显示"已连接"再悄悄掉线。 */
  up.on('data', (chunk) => {
    if (handshaken) { if (!socket.destroyed) socket.write(chunk); return; }
    hdrBuf = Buffer.concat([hdrBuf, chunk]);
    const end = hdrBuf.indexOf('\r\n\r\n');
    if (end < 0) {
      if (hdrBuf.length > 16384) fail('上游握手响应异常（超过 16KB 仍未结束）');
      return;
    }
    const headText = hdrBuf.slice(0, end).toString('latin1');
    const rest = hdrBuf.slice(end + 4);
    if (!/^HTTP\/1\.1 101/.test(headText)) {
      const first = headText.split('\r\n')[0];
      // 令牌过期时上游会回 401：这里顺手换一次 cookie，浏览器 3 秒后的自动重连就能成功
      if (/\s(401|403)\s/.test(first) && DSH_TOKEN && !retriedAuth) {
        retriedAuth = true;
        ensureDshAuth(true).then((r) => {
          if (r.ok) wsLog('上游拒绝了实时流（' + first + '），已重新换取令牌，浏览器重连即可恢复');
          else fail('上游拒绝了实时流且重新认证失败：' + (r.error || first));
        });
        cleanup();
        return;
      }
      fail('上游未同意升级：' + first);
      return;
    }
    if ((headText.match(/sec-websocket-accept:\s*(\S+)/i) || [])[1] !== wsAccept(upKey)) {
      fail('上游 Sec-WebSocket-Accept 校验失败');
      return;
    }

    handshaken = true;
    if (socket.destroyed) { cleanup(); return; }

    // 上游已就绪 → 现在才答复浏览器，两侧从此是纯双向字节管道
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n'
      + 'Upgrade: websocket\r\n'
      + 'Connection: Upgrade\r\n'
      + 'Sec-WebSocket-Accept: ' + wsAccept(key) + '\r\n\r\n'
    );
    if (clientHead) { up.write(clientHead); clientHead = null; }
    while (pending.length) up.write(pending.shift());
    if (rest.length) socket.write(rest);
  });
});


/* ============ 部署自检（node server.cjs --check）============
   给别人部署时最需要的东西：一条命令把"环境缺什么"逐项列清楚，
   省得对着一张打不开的页面来回猜。输出是纯文本，可以直接粘贴给管理员。 */
function portFree(host, port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(port, host);
  });
}

/** 在 PATH 上查一个可执行文件。
 *  不用 where.exe / which：Windows 上 dsh 是 .cmd/.ps1 垫片，
 *  外部命令在不同 shell 里行为不一致（实测 where.exe 会返回空），自己按 PATHEXT 找最可靠。 */
function findExecutable(name) {
  const extList = process.platform === 'win32'
    ? String(process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).concat(['.ps1', ''])
    : [''];
  for (const dir of String(process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const ext of extList) {
      for (const e of ext ? [ext.toLowerCase(), ext.toUpperCase()] : ['']) {
        const p = path.join(dir, name + e);
        try { if (fs.statSync(p).isFile()) return p; } catch {}
      }
    }
  }
  return null;
}

/** 该端口上是不是"另一个控制台实例"。
 *  控制台会代理 /api，所以从外面看它和 DSH 的响应形状一样，扫描时必须排除，否则会建议错端口。 */
async function isConsoleInstance(port) {
  try {
    const r = await fetch('http://127.0.0.1:' + port + '/', { signal: AbortSignal.timeout(600) });
    return r.ok && /时空智能应用工作台/.test(await r.text());
  } catch { return false; }
}

/** 在常见端口上找"响应像 DSH"的服务。
 *  部署到别的机器时 DSH 常常不在默认 3080 上（3080 被别的程序或代理占了，
 *  表现就是所有请求都 401/403）。与其让人一个个试端口，不如直接扫一遍告诉他。
 *  注意：未认证时回的 401 也**算**找到 DSH —— 它只是还需要令牌。 */
async function discoverDsh() {
  const candidates = [];
  for (let p = 3080; p <= 3090; p++) candidates.push(p);
  candidates.push(3000, 3001, 4321, 5000, 5173, 8000, 8080, 8081, 8888, 9000, 10000);
  const nowPort = String(new URL(DSH).port || 80);
  const hits = [];
  await Promise.all(candidates.map(async (port) => {
    if (String(port) === nowPort) return;                  // 已经单独探过，别重复
    const r = await probeDshAt('http://127.0.0.1:' + port, 700, '');
    if (!r.ok) return;
    if (await isConsoleInstance(port)) return;             // 是另一个控制台实例，不是 DSH
    hits.push({ port, needsToken: r.needsToken });
  }));
  return hits.sort((a, b) => a.port - b.port);
}

/** 把"没找到 / 找到了"统一成一段可照做的提示 */
async function reportDshDiscovery(prefix) {
  console.log('      → 正在常见端口上查找 DSH …');
  const hits = await discoverDsh();
  if (hits.length) {
    const first = hits[0];
    console.log('      ✓ 在 127.0.0.1:' + first.port + ' 上找到了 DSH'
      + (hits.length > 1 ? '（另有 ' + hits.slice(1).map(h => h.port).join(', ') + '）' : '')
      + (first.needsToken ? '  ← 它要求访问令牌' : ''));
    console.log('      → 启动控制台前设置（PowerShell）：$env:DSH_ORIGIN = "http://127.0.0.1:' + first.port + '"');
    if (first.needsToken) {
      console.log('        该地址需要令牌时，把 dsh web 打印的地址整段贴进来（含 ?token=…）：');
      console.log('        $env:DSH_ORIGIN = "http://127.0.0.1:' + first.port + '/?token=<令牌>"');
      console.log('        也可以启动后在控制台页面里点状态栏，用弹窗填。');
    }
    console.log('        （默认 ' + (new URL(DSH).port || 80) + ' 上那个 ' + prefix + '，不是 DSH）');
  } else {
    console.log('      × 常见端口上也没找到 DSH —— 它很可能还没启动。');
    console.log('      → 另开一个 PowerShell 窗口运行：dsh web');
    console.log('        它会把带令牌的完整地址打印出来，复制那一段即可。');
  }
}

async function diagnose() {
  let bad = 0;
  const row = (state, label, detail) => {
    if (state === false) bad++;
    console.log('  ' + (state === true ? '✓' : state === false ? '×' : '·') + ' ' + label + (detail ? '   ' + detail : ''));
  };

  console.log('');
  console.log('========================================');
  console.log(' DSH Console 部署自检');
  console.log('========================================');
  console.log('  目录     : ' + __dirname);
  console.log('  Node     : ' + process.versions.node + '  平台 ' + process.platform + '/' + process.arch);
  console.log('  端口     : 控制台 ' + PORT + ' / 目标 ' + DSH);
  console.log('');

  console.log('[1] 运行环境');
  row(NODE_MAJOR >= 18, 'Node.js 版本', NODE_MAJOR >= 18 ? '满足 ≥18' : '需要 ≥18，请升级 Node.js');

  console.log('\n[2] 前端产物（必须与 server.cjs 同层）');
  for (const f of ['index.html', 'app.js', 'style.css']) {
    const p = path.join(ROOT, f);
    if (fs.existsSync(p)) row(true, 'public/' + f, Math.round(fs.statSync(p).size / 1024) + ' KB');
    else row(false, 'public/' + f, '缺失 —— 请把 public/ 整个目录一起拷贝');
  }

  console.log('\n[3] 本机状态文件（应当是本机生成的，不能是别人拷来的）');
  for (const f of ['plugins.json', 'mcp-tools.json']) {
    const p = path.join(__dirname, f);
    if (!fs.existsSync(p)) { row(true, f, '不存在（正常，首次成功探测后会自动生成）'); continue; }
    let at = '?'; try { at = JSON.parse(fs.readFileSync(p, 'utf8')).at || '?'; } catch {}
    row(null, f, '存在，at=' + at + '  ← 若是别人拷给你的，建议删掉');
  }
  {
    const cfg = loadDshConfig();
    if (cfg) {
      row(null, 'dsh-config.json', '存在：目标 ' + cfg.origin + '，令牌 ' + (cfg.token ? '已保存' : '无')
        + '（at=' + (cfg.at || '?') + '）← 含令牌，不要拷给别人');
    } else {
      row(null, 'dsh-config.json', '不存在（未在页面里配置过 DSH 地址；用的是默认或环境变量）');
    }
  }

  console.log('\n[4] 控制台端口');
  if (await portFree('127.0.0.1', PORT)) {
    row(true, '端口 ' + PORT, '可用（当前没有控制台在运行）');
  } else {
    // 端口被占用未必是故障 —— 更常见的情况是控制台本来就在跑，先确认一下是不是它自己
    let isOurConsole = false;
    try {
      const r = await fetch('http://127.0.0.1:' + PORT + '/');
      const t = await r.text();
      isOurConsole = r.ok && /时空智能应用工作台/.test(t);
    } catch {}
    if (isOurConsole) row(true, '端口 ' + PORT, '已被占用，但检测到控制台本身正在运行 —— 这是正常的');
    else row(false, '端口 ' + PORT, '被其他程序占用 —— 换端口：$env:CONSOLE_PORT = "9081"（PowerShell）');
  }

  console.log('\n[5] DSH 主机（硬前提：控制台是它的前端 + 反向代理）');
  const up = new URL(DSH);
  const st = await dshStatus(6000);
  const p = await probeDshAt(DSH, 6000);
  row(st.state === 'ok', 'GET / → HTTP ' + p.status,
    'Server: ' + p.server + ' / Content-Type: ' + p.ct
    + (p.status === '200' ? '（返回 DSH 应用页面）' : ''));
  row(st.hasToken, '访问令牌', st.hasToken
    ? '已配置 ' + st.tokenHint + '（来源：' + st.source + '）'
    : '未配置（需要认证的 DSH 会要求）');
  row(null, '地址来源', st.source === 'env' ? '环境变量 DSH_ORIGIN'
    : st.source === 'config' ? 'dsh-config.json（页面里填的）'
    : st.source === 'auto' ? '自动启动 / 自动发现'
    : st.source === 'ui' ? '页面「配置 DSH 主机」' : '默认 ' + DEFAULT_DSH);
  // 版本只能从本机读；这一行让自检能一眼看出当前装的是哪个版本
  row(null, 'DSH 版本', dshVersion() + '（本机 dsh 包读出的，与「系统状态」页显示一致）'
    + (st.dshRev ? ' · 运行实例构建号 ' + st.dshRev : ''));

  if (st.state === 'ok') {
    row(true, '结论：DSH 已连接且已认证，控制台可用', '');
  } else {
    row(false, '结论：' + st.detail, st.error || '');
    if (p.body) row(null, '响应原文', p.body);
    if (st.state === 'need-token' || st.state === 'token-rejected') {
      // 地址是对的（响应就是 DSH 的鉴权拒绝），不要再扫端口，直接给令牌的填法
      console.log('      → 需要访问令牌：把 dsh web 打印的地址整段交给控制台');
      console.log('        方式一：浏览器打开控制台后，点右上角状态栏，在弹窗里粘贴');
      console.log('        方式二（PowerShell）：$env:DSH_ORIGIN = "http://127.0.0.1:' + (up.port || 80) + '/?token=<令牌>"');
    } else {
      await reportDshDiscovery(p.status === '—' ? '不可达' : 'HTTP ' + p.status);
    }
  }

  console.log('\n[6] dsh 命令（插件页会调用它）');
  const dshCmds = dshCandidates();
  const onPath = !!findExecutable('dsh');
  if (dshCmds.length) {
    row(true, '找到 ' + dshCmds.length + ' 个可用的 dsh', dshCmds.length > 1 ? '执行时按顺序回退，能行为止' : '');
    const notes = {
      '当前 npx 进程树': '控制台就跑在那棵 npx 进程树里，它的垫片最可信',
      'PATH': 'PATH 上的 dsh（全局安装 / nvm 都算）',
      'node 安装目录': 'nvm-windows 之类把全局垫片放在 node.exe 旁边',
      'npm 全局目录': 'npm i -g 的默认落点',
      'Program Files\\nodejs': 'node 官方安装包的全局目录',
      'npx 缓存': '用 npx 拉起过来时留下的垫片 —— PATH 上没有 dsh 也能用',
    };
    for (const c of dshCmds.slice(0, 5)) row(null, '候选 ' + c.how, c.file + (notes[c.how] ? '   ← ' + notes[c.how] : ''));
    if (dshCmds.length > 5) row(null, '…', '另有 ' + (dshCmds.length - 5) + ' 个候选（都会依次尝试）');
    if (!onPath) {
      row(null, '注意', 'dsh 不在 PATH 上，控制台用绝对路径调用（功能不受影响）；'
        + '想让 `dsh` 在任何窗口都能直接敲，装个全局的：npm i -g @deepseek-ai/dsh');
    }
  } else {
    row(false, '没找到 dsh', 'PATH、全局目录、npx 缓存里都没有');
    console.log('      → 想让「插件」页实时探测（否则只显示上一次的快照），任选其一：');
    console.log('        ① 全局装一个：npm i -g @deepseek-ai/dsh');
    console.log('        ② 用 npx 跑一次（会在 npx 缓存里留下垫片，控制台就能自动找到）：');
    console.log('           npx @deepseek-ai/dsh --version');
  }

  console.log('\n[7] DSH profile');
  const dshHome = dshHomeDir();
  const prof = process.env.DSH_PROFILE || 'web';
  const patch = path.join(dshHome, 'profiles', prof, 'cordis.patch.yml');
  const profPkg = path.join(dshHome, 'profiles', prof, 'package.json');
  row(null, 'DSH_HOME', dshHome + (process.env.DSH_HOME ? '（环境变量）'
    : dshHome.includes(path.join('runtime', 'dsh-home')) ? '（一体包 runtime）' : '（默认 ~/.dsh）'));
  row(fs.existsSync(patch), 'profiles/' + prof + '/cordis.patch.yml',
    fs.existsSync(patch) ? '存在' : '不存在（「MCP 服务」页会显示未配置，属正常）');
  if (fs.existsSync(profPkg)) {
    let nDep = 0;
    try { nDep = Object.keys(JSON.parse(fs.readFileSync(profPkg, 'utf8')).dependencies || {}).length; } catch {}
    row(true, 'profiles/' + prof + '/package.json', '存在，dependencies ' + nDep + ' 个（用户插件清单）');
  } else {
    row(null, 'profiles/' + prof + '/package.json', '不存在');
  }

  console.log('\n[8] 打开方式');
  row(null, '正确地址：http://127.0.0.1:' + PORT);
  row(null, '不要直接双击 public/index.html —— 那样样式与接口全都取不到');

  console.log('');
  console.log(bad === 0
    ? '结果：未发现阻塞问题。若页面仍异常，请把浏览器 F12 → Network 里失败请求的状态码和响应内容发出来。'
    : '结果：发现 ' + bad + ' 项需要处理（上面标 × 的）。');
  console.log('');
  return bad;
}

/* 启动自检：把"能不能用"的前提在控制台里就说清楚，
   而不是让人打开浏览器只看到一条红条。 */
async function preflight() {
  if (!fs.existsSync(path.join(ROOT, 'index.html'))) {
    console.error('× 找不到前端文件：' + path.join(ROOT, 'index.html'));
    console.error('  请确认 public/ 目录与本文件在同一层。');
  }
  console.log('  目标来源   : ' + (DSH_SOURCE === 'env' ? '环境变量 DSH_ORIGIN'
    : DSH_SOURCE === 'config' ? 'dsh-config.json（页面里填的）'
    : DSH_SOURCE === 'auto' ? '自动启动 / 自动发现'
    : DSH_SOURCE === 'ui' ? '页面「配置 DSH 主机」' : '默认地址'));
  console.log('  访问令牌   : ' + (DSH_TOKEN ? '已配置 ' + DSH_TOKEN.slice(0, 4) + '…' + DSH_TOKEN.slice(-4)
    : '未配置（需要认证的 DSH 会要求）'));

  const st = await dshStatus(6000);
  if (st.state === 'ok') {
    console.log('✓ DSH 主机正常（' + DSH + '，已认证）');
    return;
  }
  console.error('× DSH 主机不可用：' + DSH + '（HTTP ' + st.httpStatus + '）—— ' + st.detail);
  if (st.error) console.error('  原因：' + st.error);
  if (st.state === 'need-token' || st.state === 'token-rejected') {
    console.error('  DSH 的 Web 端口带会话鉴权：需要一个 `dsh web` 打印出来的带令牌地址。');
    console.error('  两种填法：');
    console.error('    ① 浏览器打开 http://127.0.0.1:' + PORT + ' 后，点右上角状态栏，在弹窗里粘贴');
    console.error('    ② PowerShell 里设 $env:DSH_ORIGIN = "http://127.0.0.1:' + (new URL(DSH).port || 80) + '/?token=<令牌>" 后重启控制台');
    console.error('  若希望下次无感：先关掉已有的 dsh web，再启动本控制台（会自动拉起并抓令牌）。');
    return;
  }
  console.error('  本控制台是 DSH 的前端 + 反向代理，必须先有可用的 DSH。');
  console.error('  自动启动未成功时，请手动：dsh web   或   npx @deepseek-ai/dsh web');
  await reportDshDiscovery(st.httpStatus === '—' ? '不可达' : 'HTTP ' + st.httpStatus);
}

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error('× 端口 ' + PORT + ' 已被占用。换个端口再启动：');
    console.error('  $env:CONSOLE_PORT = "9081"; node server.cjs');
  } else {
    console.error('× 服务启动失败：' + e.message);
  }
  process.exit(1);
});

/* ---------- 入口：--check 只做部署自检，其余情况启动服务 ---------- */
initDshTarget();          // 环境变量 > dsh-config.json > 默认
if (process.argv.includes('--check')) {
  diagnose().then((bad) => {
    process.exitCode = bad > 0 ? 1 : 0;
    // 稍等再退出：立刻 process.exit() 会让 libuv 在还有句柄未收尾时报 async handle 断言
    setTimeout(() => process.exit(process.exitCode), 300);
  }, (e) => {
    console.error('自检本身出错：' + e.message);
    process.exit(1);
  });
} else {
  const onStop = () => { stopOwnedDsh(); };
  process.on('exit', onStop);
  process.on('SIGINT', () => { stopOwnedDsh(); process.exit(0); });
  process.on('SIGTERM', () => { stopOwnedDsh(); process.exit(0); });
  // Windows：Ctrl+Break / 部分控制台关闭路径会打到 SIGBREAK
  try { process.on('SIGBREAK', () => { stopOwnedDsh(); process.exit(0); }); } catch { /* 非 Windows 无此信号 */ }

  // 控制台端口必须先起来：后面自动拉起 DSH / 换 token 失败时，也不能把 3081 一起带走
  let consoleReady = false;
  const keepAliveOnError = (kind, err) => {
    const msg = (err && err.stack) ? err.stack : String(err && err.message ? err.message : err);
    console.error('× ' + kind + '：' + msg);
    if (consoleReady) {
      console.error('  控制台服务仍在运行：http://127.0.0.1:' + PORT);
      console.error('  （不会因为 DSH 自动启动失败而退出；可用 check.cmd 排查）');
      return;
    }
    process.exit(1);
  };
  process.on('uncaughtException', (err) => keepAliveOnError('未捕获异常', err));
  process.on('unhandledRejection', (err) => keepAliveOnError('未处理的 Promise 拒绝', err));

  server.listen(PORT, '127.0.0.1', async () => {
    consoleReady = true;
    console.log('');
    console.log('DSH Console 已启动');
    console.log('  控制台地址 : http://127.0.0.1:' + PORT);
    console.log('  代理目标   : ' + DSH);
    console.log('  实时流桥接 : ws://127.0.0.1:' + PORT + '/api/remote.mux → ' + DSH);
    if (process.env.DSH_HOME) console.log('  DSH_HOME   : ' + process.env.DSH_HOME);
    console.log('  （控制台端口已监听；正在检查 / 自动启动 DSH …）');
    console.log('');
    try {
      await ensureDshRunning();
      await preflight();
    } catch (e) {
      console.error('× 自动准备 DSH 时出错：' + (e && e.message ? e.message : e));
      if (e && e.stack) console.error(e.stack);
      console.error('  控制台本身已在 http://127.0.0.1:' + PORT + ' —— 可先打开页面，再手动配置 DSH');
    }
    console.log('');
    console.log('浏览器打开 http://127.0.0.1:' + PORT + ' 即可（Ctrl+C 或关闭窗口会停止控制台；若 DSH 由本进程拉起，会一并结束）');
    console.log('若仍提示需要配置 DSH：点右上角状态栏，把 dsh web 打印的地址整段填进去。');
    console.log('（部署排查：node server.cjs --check；关闭自动启动：DSH_AUTO_START=0）');
    try { openConsoleBrowser(); } catch (e) {
      console.warn('  自动打开浏览器失败：' + (e && e.message ? e.message : e));
    }
  });
}
