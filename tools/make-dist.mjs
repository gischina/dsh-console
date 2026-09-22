/* DSH Console — 工具脚本 make-dist.mjs
 * Copyright 2026 liwei (易智瑞西安) <liwei@geoscene.cn>
 * SPDX-License-Identifier: Apache-2.0
 *
 * 依据 Apache License 2.0 授权使用与分发；许可证全文见项目根目录 LICENSE，摘要见 NOTICE。
 */
/* 生产打包：把控制台打成一包「可直接部署、源码已压缩混淆」的产物。
 *
 * 用法：node tools/make-dist.mjs        （Windows 上直接双击项目根目录的 dist.cmd）
 *   --no-mangle   跳过混淆，产物保留明文源码（仅供内部对比排查，**不要**对外交付）
 *   --no-zip      只出目录，不打包 zip
 *
 * 产物（每次运行先清空 dist/ 再重建；名字带版本号，版本读项目根的 VERSION 文件）：
 *   <项目根>/dist/dsh-console-<版本>/        可直接拷到生产机
 *   <项目根>/dist/dsh-console-<版本>.zip     同一个东西的压缩包（解压即得同名目录）
 *
 * 版本号来源（优先级从高到低）：
 *   1. 命令行 --version=1.2.3    临时打一个别的版本（不改 VERSION 文件）
 *   2. 项目根 VERSION 文件       日常发布改这一个文件即可，一行纯文本
 *
 * 为什么只放这几个文件：这是给生产部署用的，不是给人改代码的。
 * 所以只带运行必需的 server.cjs + public/ + 两个 .cmd + 部署说明 + LICENSE/NOTICE
 * （Apache-2.0 第 4(a)/4(d) 条要求再分发时附带许可证与归属声明）；
 * 不带 tools/（回归脚本，里面的函数名清单等于把内部结构交出去）、
 * 不带 docs/（上游对照文档写满了实现细节）、
 * 不带任何本机运行状态文件（plugins.json / mcp-tools.json / dsh-config.json / ui-prefs.yaml）。
 *
 * 混淆用 terser（Node 生态的标准压缩器，构建期通过 npx 调用，不进项目依赖、不写 package.json）：
 *   compress —— 去注释、压空白、常量折叠、死代码消除
 *   mangle   —— 函数内局部变量 / 参数名混淆
 *   ⚠️ **故意不开顶层名混淆**：页面有 100+ 处 inline onclick="fn()" 按名调用顶层函数，
 *      顶层改名会让这些按钮全部点不动（要开得先把交互层重构成事件委托，那是另一件事）。
 *      所以产物的定位是「不可读 / 不好改」，而不是「不可逆向」—— JS 明文运行，没有真正的加密。
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(fileURLToPath(new URL('../', import.meta.url)));   // 项目根
const DIST = path.join(ROOT, 'dist');                                        // 每次重建
const NO_MANGLE = process.argv.includes('--no-mangle');
const NO_ZIP = process.argv.includes('--no-zip');

/* ============ 版本号：--version= 参数 > 根目录 VERSION 文件 ============ */
function readVersion() {
  const fromArg = (process.argv.find(a => a.startsWith('--version=')) || '').split('=')[1];
  let raw = fromArg;
  if (raw === undefined) {
    try { raw = fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8'); }
    catch { return { error: '找不到项目根的 VERSION 文件（也没有 --version= 参数）。' }; }
  }
  const v = String(raw).trim();
  // 放宽校验：数字开头的「主.次.修订」+ 可选预发布段（如 0.1.5-rc.2），防止打出怪名字的文件
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(v)) {
    return { error: '版本号「' + v + '」不符合 x.y.z 或 x.y.z-预发布（如 0.1.5-rc.2）格式。' + (fromArg ? '' : '（来自 VERSION 文件）') };
  }
  return { v };
}
const VER = readVersion();
if (VER.error) { console.log('!! ' + VER.error); process.exit(1); }
const NAME = 'dsh-console-' + VER.v;
const OUT = path.join(DIST, NAME);
const ZIP = path.join(DIST, NAME + '.zip');

const say = s => console.log(s);
const mb = n => Math.round(n / 1024) + ' KB';
let bad = 0;

/* ============ 0. 清空 dist（用户要求：重新打包时删掉重来） ============ */
fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'public'), { recursive: true });

/* ============ 1. 找 terser ============
 * 优先用 npm 的 npx 缓存（跑过一次就在本地，无需联网）；没有再去拉一次。 */
const npxCaches = [
  process.env.npm_config_cache && path.join(process.env.npm_config_cache, '_npx'),
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'npm-cache', '_npx'),
  path.join(os.homedir(), '.npm', '_npx'),
].filter(Boolean);

function findTerser() {
  for (const cache of npxCaches) {
    let dirs = [];
    try { dirs = fs.readdirSync(cache); } catch { continue; }
    for (const d of dirs) {
      const p = path.join(cache, d, 'node_modules', 'terser');
      if (fs.existsSync(path.join(p, 'package.json'))) return p;
    }
  }
  return null;
}

function fetchTerser() {
  const npxCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npx-cli.js');
  if (!fs.existsSync(npxCli)) return false;
  say('  · 本地没有 terser，正在通过 npm 拉取一次（仅首次需要联网）…');
  try {
    execFileSync(process.execPath, [npxCli, '--yes', 'terser@5', '--version'], { stdio: 'pipe' });
    return !!findTerser();
  } catch (e) {
    return false;
  }
}

let minify = null;
if (!NO_MANGLE) {
  let terserPath = findTerser() || (fetchTerser() ? findTerser() : null);
  if (terserPath) {
    minify = createRequire(import.meta.url)(terserPath).minify;
  } else {
    say('!! 找不到也拉不到 terser —— 无法混淆。');
    say('   处理办法：① 联网后重跑；② 已装过就确认 npx 缓存可读；');
    say('   ③ 只要明文产物（内部排查用）可加 --no-mangle。');
    process.exit(1);
  }
}

/* terser 配置：ecma 2022 保留现代语法（不要降级到 ES5，那会平白增大体积）；
 * compress.toplevel / mangle.toplevel 都保持默认 false —— 顶层名必须留着（见文件头说明）。 */
const TERSER_OPTS = { compress: { passes: 2 }, mangle: true, ecma: 2022, format: { comments: false } };

const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
const banner = '/* DSH Console v' + VER.v + ' — 构建产物 ' + stamp + '\n' +
               ' * Copyright 2026 liwei (易智瑞西安) <liwei@geoscene.cn> · SPDX-License-Identifier: Apache-2.0（见包内 LICENSE / NOTICE）\n' +
               ' * 已压缩，请勿手工修改；要改请回到源码工程。 */\n';

/* 混淆一个文件；返回 [原大小, 产物大小]。失败直接抛错（不能静默交付明文源码）。 */
async function buildFile(srcRel, dstRel) {
  const src = fs.readFileSync(path.join(ROOT, srcRel), 'utf8');
  const dstAbs = path.join(OUT, dstRel);
  fs.mkdirSync(path.dirname(dstAbs), { recursive: true });

  if (NO_MANGLE) {
    fs.writeFileSync(dstAbs, src, 'utf8');
    return [src.length, src.length];
  }

  const r = await minify(src, TERSER_OPTS);
  if (r.error) throw new Error(srcRel + ' 压缩失败：' + (r.error.message || r.error));
  const head = src.startsWith('#!') ? src.slice(0, src.indexOf('\n') + 1) + banner : banner;
  fs.writeFileSync(dstAbs, head + r.code, 'utf8');
  return [src.length, Buffer.byteLength(head + r.code)];
}

/* 原样拷贝；唯一例外：两个 .cmd 在拷贝时把 DSHC_VER 占位填成真实版本号，
 * 对方双击启动 / 交自检报告时能看出是哪个版本的包（源码直跑时该值为空，无妨）。
 * 两个 .cmd 必须保持「纯 ASCII + CRLF」—— utf8 读写不会改动换行字节。 */
function copyAsIs(rel) {
  const srcAbs = path.join(ROOT, rel);
  const dstAbs = path.join(OUT, rel);
  if (rel === 'start.cmd' || rel === 'check.cmd') {
    const text = fs.readFileSync(srcAbs, 'utf8').replace('set "DSHC_VER="', 'set "DSHC_VER=v' + VER.v + '"');
    if (!text.includes('DSHC_VER=v' + VER.v)) throw new Error(rel + ' 里找不到 DSHC_VER 占位，版本号注入失败');
    fs.writeFileSync(dstAbs, text, 'utf8');
  } else {
    fs.copyFileSync(srcAbs, dstAbs);
  }
}

/* ============ 2. 生成产物 ============ */
say('生产打包 —— ' + OUT);
say('');
say('[1] 压缩混淆');
const sizes = {};
for (const [srcRel, dstRel] of [
  ['public/app.js', 'public/app.js'],
  ['server.cjs', 'server.cjs'],
]) {
  const [a, b] = await buildFile(srcRel, dstRel);
  sizes[dstRel] = [a, b];
  const pct = a ? Math.round((1 - b / a) * 100) : 0;
  say('  ✓ ' + srcRel.padEnd(16) + mb(a).padStart(8) + '  →  ' + mb(b).padStart(8) + '   （-' + pct + '%）');
  if (!NO_MANGLE && pct < 10) { say('    !! 压缩率异常低，混淆可能没生效'); bad++; }
}

say('');
say('[2] 原样拷贝');
for (const rel of ['public/index.html', 'public/style.css', 'start.cmd', 'check.cmd']) {
  copyAsIs(rel);
  say('  ✓ ' + rel);
}

/* 部署说明：源码工程里的 docs/deploy.md 是给运维看的那一份，进包时命名成 README.md（对方一眼能找到），
 * 顶部盖一行版本号，对方一看就知道拿的是哪个包。 */
const deployDoc = path.join(ROOT, 'docs', 'deploy.md');
if (fs.existsSync(deployDoc)) {
  const head = '# DSH Console v' + VER.v + '\n\n> 版本 ' + VER.v + ' · 构建于 ' + stamp + '（UTC）\n\n';
  fs.writeFileSync(path.join(OUT, 'README.md'), head + fs.readFileSync(deployDoc, 'utf8'), 'utf8');
  say('  ✓ README.md  （= docs/deploy.md 部署说明，已盖版本 ' + VER.v + '）');
} else {
  say('  !! 缺 docs/deploy.md，包里不会有部署说明');
  bad++;
}

/* 许可与归属：Apache-2.0 要求再分发时随包附带（第 4(a) 条 LICENSE、第 4(d) 条 NOTICE） */
for (const rel of ['LICENSE', 'NOTICE']) {
  if (fs.existsSync(path.join(ROOT, rel))) {
    copyAsIs(rel);
    say('  ✓ ' + rel + '  （许可与归属声明，随分发要求附带）');
  } else {
    say('  !! 缺 ' + rel + ' —— 开源许可文件不全，Apache-2.0 再分发义务无法满足');
    bad++;
  }
}

/* ============ 3. 自检：产物不能夹带本机数据 / 工程文件 ============ */
say('');
say('[3] 产物自检');

const FORBIDDEN = ['plugins.json', 'mcp-tools.json', 'dsh-config.json', 'ui-prefs.yaml'];
const present = [];
const walk = d => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else present.push(path.relative(OUT, p).replace(/\\/g, '/'));
  }
};
walk(OUT);

for (const f of FORBIDDEN) {
  if (present.some(p => p.endsWith(f))) { say('  ✗ 产物里出现了本机状态文件：' + f); bad++; }
}
for (const d of ['tools/', 'docs/', '.git']) {
  if (present.some(p => p.startsWith(d))) { say('  ✗ 产物里不该出现：' + d); bad++; }
}

/* 令牌 / 本机路径 / 用户名（拿本机配置里的真实值来比对，不把用户名写进脚本） */
const secrets = [];
try {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'dsh-config.json'), 'utf8'));
  if (cfg.token) secrets.push(cfg.token);
} catch { /* 没配过就没有可比对的令牌 */ }
const user = os.userInfo().username || '';
const BAD_STR = [
  ...secrets,
  'C:\\Users\\' + user, 'C:/Users/' + user, '\\\\Users\\\\' + user,
  '/Users/' + user, '/home/' + user,
  path.basename(path.dirname(ROOT)),          // 项目所在目录名，不该被写进产物
].filter(Boolean);

const leaks = [];
for (const rel of present) {
  if (/\.(png|jpe?g|gif|ico|woff2?|zip)$/i.test(rel)) continue;
  const t = fs.readFileSync(path.join(OUT, rel), 'utf8');
  for (const b of BAD_STR) if (t.includes(b)) leaks.push(rel + '  ←  ' + b);
}
if (leaks.length) { leaks.forEach(l => say('  ✗ ' + l)); bad++; }

say('  · 产物文件 ' + present.length + ' 个：' + present.sort().join('、'));
say(bad ? '  ✗ 存在 ' + bad + ' 个问题（见上）' : '  ✓ 无本机数据 / 无工程文件 / 无令牌与本机路径');

/* ============ 4. 打 zip ============ */
say('');
say('[4] 打包');
if (NO_ZIP) {
  say('  · 跳过（--no-zip）');
} else {
  const tar = process.platform === 'win32'
    ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
    : 'tar';
  try {
    fs.rmSync(ZIP, { force: true });
    execFileSync(tar, ['-a', '-c', '-f', ZIP, '-C', DIST, NAME], { stdio: 'pipe' });
    say('  ✓ ' + ZIP + '   （' + mb(fs.statSync(ZIP).size) + '，解压即得 ' + NAME + '/ 目录）');
  } catch (e) {
    say('  · 打包失败（目录本身可用，可手工压缩）：' + (e.message || e));
  }
}

/* ============ 5. 交付摘要 ============ */
const total = present.reduce((n, rel) => n + fs.statSync(path.join(OUT, rel)).size, 0);
say('');
say('=== 完成：' + present.length + ' 个文件 / ' + mb(total) + ' ===');
if (NO_MANGLE) say('⚠️ 本次是 --no-mangle：产物含明文源码，**不要**对外交付。');
say('对方拿到后：解压 → 装 Node ≥18 → 起 dsh web → 双击 start.cmd → 浏览器开 http://127.0.0.1:3081');
say('（首次启动会自动弹配置窗，把 dsh web 打印的带 token 的地址整段粘进去；详见包内 README.md）');

if (bad) process.exitCode = 1;
