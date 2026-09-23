/* DSH Console — 离线一体包 runtime 捆绑
 * Copyright 2026 liwei (易智瑞西安) <liwei@geoscene.cn>
 * SPDX-License-Identifier: Apache-2.0
 *
 * 把官方 Node（win-x64 zip）与 @deepseek-ai/dsh 装进产物目录的 runtime/，
 * 供 make-dist.mjs --offline 调用。构建机需要联网；产物给对方时可完全离线。
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const TOOLS = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.join(TOOLS, '.cache', 'offline');

/** 钉死版本，保证可复现。可用环境变量覆盖。 */
export const DEFAULT_NODE_VERSION = process.env.DSH_OFFLINE_NODE || '22.22.0';
export const DEFAULT_NODE_ARCH = process.env.DSH_OFFLINE_ARCH || 'win-x64';

const say = (s) => console.log(s);
const mb = (n) => Math.round(n / 1024) + ' KB';

function dirSizeBytes(root) {
  let total = 0;
  const walk = (d) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      try {
        if (e.isDirectory()) walk(p);
        else total += fs.statSync(p).size;
      } catch { /* 跳过坏链 */ }
    }
  };
  walk(root);
  return total;
}

/** 把目录整棵拷过去；dereference 解开 pnpm 的 junction/symlink，保证换机可解压即用 */
function copyTreePortable(src, dest) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    fs.cpSync(src, dest, { recursive: true, dereference: true, force: true });
    return;
  } catch (e1) {
    say('    · fs.cpSync(dereference) 失败（' + (e1.message || e1) + '），改用逐项拷贝 …');
  }
  const walk = (from, to) => {
    fs.mkdirSync(to, { recursive: true });
    for (const name of fs.readdirSync(from)) {
      const a = path.join(from, name);
      const b = path.join(to, name);
      let st;
      try { st = fs.lstatSync(a); } catch { continue; }
      if (st.isSymbolicLink() || st.isDirectory()) {
        let real;
        try { real = fs.statSync(a); } catch { continue; }
        if (real.isDirectory()) walk(a, b);
        else fs.copyFileSync(a, b);
      } else if (st.isFile()) {
        fs.copyFileSync(a, b);
      }
    }
  };
  walk(src, dest);
}

/**
 * 把本机构建机上的 DSH profile（含已装插件的 node_modules）打进一体包。
 * 插件真正装在 ~/.dsh/profiles/<profile>/，不是控制台目录。
 *
 * 刻意不拷：settings.yaml / .credentials.yaml / storages / cache / 会话 —— 避免把密钥与本机数据带给别人。
 *
 * @returns {{ ok: boolean, skipped?: boolean, profile?: string, bundles?: string[], bytes?: number, error?: string }}
 */
export function bundleDshProfile(outDir, opts = {}) {
  const profile = opts.profile || process.env.DSH_PROFILE || 'web';
  const srcHome = opts.dshHome
    || process.env.DSH_HOME
    || path.join(process.env.USERPROFILE || process.env.HOME || os.homedir(), '.dsh');
  const srcProfile = path.join(srcHome, 'profiles', profile);
  const destHome = path.join(outDir, 'runtime', 'dsh-home');
  const destProfile = path.join(destHome, 'profiles', profile);

  say('');
  say('[offline] 捆绑本机 DSH profile（插件）');
  say('  来源: ' + srcProfile);

  if (!fs.existsSync(path.join(srcProfile, 'package.json'))) {
    say('  · 未找到 package.json —— 跳过（本机该 profile 可能还没装过插件）');
    return { ok: true, skipped: true, profile };
  }

  let manifest = {};
  try { manifest = JSON.parse(fs.readFileSync(path.join(srcProfile, 'package.json'), 'utf8')); }
  catch (e) { return { ok: false, error: '读 package.json 失败：' + e.message }; }

  const deps = Object.keys(manifest.dependencies || {});
  const bundles = (manifest.dsh && manifest.dsh.profile && manifest.dsh.profile.bundles) || [];
  say('  · dependencies: ' + (deps.length ? deps.join(', ') : '（无）'));
  say('  · bundles     : ' + (bundles.length ? bundles.join(', ') : '（无）'));

  fs.rmSync(destHome, { recursive: true, force: true });
  fs.mkdirSync(destProfile, { recursive: true });

  // 配置与清单
  for (const name of ['package.json', 'cordis.yml', 'cordis.patch.yml', 'pnpm-lock.yaml', 'package-lock.json']) {
    const from = path.join(srcProfile, name);
    if (!fs.existsSync(from)) continue;
    fs.copyFileSync(from, path.join(destProfile, name));
    say('  ✓ profiles/' + profile + '/' + name);
  }

  // 插件包本体
  const nmSrc = path.join(srcProfile, 'node_modules');
  if (fs.existsSync(nmSrc)) {
    say('  · 拷贝 node_modules（解开 symlink，可能较慢 / 体积较大）…');
    const t0 = Date.now();
    copyTreePortable(nmSrc, path.join(destProfile, 'node_modules'));
    const bytes = dirSizeBytes(path.join(destProfile, 'node_modules'));
    say('  ✓ profiles/' + profile + '/node_modules  （' + mb(bytes) + '，' + Math.round((Date.now() - t0) / 1000) + 's）');
  } else {
    say('  !! 没有 node_modules —— 包里只有 package.json，目标机离线时插件装不起来');
  }

  // 打包元数据（不含本机绝对路径里的用户名敏感内容时可保留来源说明）
  fs.writeFileSync(path.join(destHome, 'BUNDLE.json'), JSON.stringify({
    note: 'Vendored DSH profile for offline console. Set DSH_HOME to this directory when starting.',
    profile,
    bundledAt: new Date().toISOString(),
    dependencies: deps,
    bundles,
    // 只记 profile 相对形态，不写 C:\\Users\\...
    sourceKind: 'dsh-profile',
  }, null, 2) + '\n');

  const noticeExtra = [
    '',
    '3) DSH profile "' + profile + '" (user-installed plugins)',
    '   Copied into runtime/dsh-home/profiles/' + profile + '/',
    '   Includes package.json + cordis*.yml + node_modules.',
    '   Does NOT include settings.yaml / credentials / sessions / cache.',
    '   Start with DSH_HOME pointed at runtime/dsh-home (start.cmd does this).',
    '',
  ].join('\n');
  const readmePath = path.join(outDir, 'runtime', 'README.txt');
  try {
    fs.appendFileSync(readmePath, noticeExtra, 'utf8');
  } catch {
    fs.writeFileSync(readmePath, noticeExtra, 'utf8');
  }

  // 安全闸：绝不能把凭据带进包
  for (const bad of ['.credentials.yaml', 'settings.yaml']) {
    const hit = path.join(destHome, bad);
    if (fs.existsSync(hit)) {
      fs.rmSync(hit, { force: true });
      say('  !! 已剔除敏感文件：' + bad);
    }
  }

  const bytes = dirSizeBytes(destHome);
  say('  ✓ runtime/dsh-home 合计 ' + mb(bytes));
  return { ok: true, profile, bundles, dependencies: deps, bytes };
}

async function downloadFile(url, dest) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error('下载失败 HTTP ' + res.status + '：' + url);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
  return buf.length;
}

function tarBin() {
  return process.platform === 'win32'
    ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
    : 'tar';
}

/**
 * @param {object} opts
 * @param {string} opts.outDir   产物根目录（…/dsh-console-offline-x.y.z）
 * @param {string} opts.dshVersion  @deepseek-ai/dsh 版本
 * @param {string} [opts.nodeVersion]
 * @param {string} [opts.nodeArch]  目前仅正式支持 win-x64
 */
export async function bundleOfflineRuntime(opts) {
  const outDir = opts.outDir;
  const dshVersion = opts.dshVersion;
  const nodeVersion = opts.nodeVersion || DEFAULT_NODE_VERSION;
  const nodeArch = opts.nodeArch || DEFAULT_NODE_ARCH;

  if (nodeArch !== 'win-x64') {
    throw new Error('离线一体包目前只支持 win-x64（收到：' + nodeArch + '）');
  }

  const zipName = 'node-v' + nodeVersion + '-' + nodeArch + '.zip';
  const zipUrl = 'https://nodejs.org/dist/v' + nodeVersion + '/' + zipName;
  const zipPath = path.join(CACHE, zipName);
  const runtimeNode = path.join(outDir, 'runtime', 'node');
  const runtimeDsh = path.join(outDir, 'runtime', 'dsh');

  say('');
  say('[offline] 捆绑 Node + DSH');
  say('  Node   : v' + nodeVersion + ' / ' + nodeArch);
  say('  DSH    : @deepseek-ai/dsh@' + dshVersion);
  say('  缓存目录: ' + CACHE);

  fs.mkdirSync(CACHE, { recursive: true });

  // ---- Node zip ----
  let zipSize = 0;
  try { zipSize = fs.statSync(zipPath).size; } catch { zipSize = 0; }
  if (zipSize < 1_000_000) {
    say('  · 下载 ' + zipUrl);
    zipSize = await downloadFile(zipUrl, zipPath);
    say('    ✓ ' + mb(zipSize));
  } else {
    say('  · 使用缓存 ' + zipName + '（' + mb(zipSize) + '）');
  }

  const extractRoot = path.join(CACHE, 'extract-node-v' + nodeVersion + '-' + nodeArch);
  fs.rmSync(extractRoot, { recursive: true, force: true });
  fs.mkdirSync(extractRoot, { recursive: true });
  say('  · 解压 Node …');
  execFileSync(tarBin(), ['-xf', zipPath, '-C', extractRoot], { stdio: 'pipe' });
  const innerName = fs.readdirSync(extractRoot).find((n) => {
    try { return fs.statSync(path.join(extractRoot, n)).isDirectory(); } catch { return false; }
  });
  if (!innerName) throw new Error('Node zip 解压后没有顶层目录');
  fs.rmSync(runtimeNode, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(runtimeNode), { recursive: true });
  fs.cpSync(path.join(extractRoot, innerName), runtimeNode, { recursive: true });
  const nodeExe = path.join(runtimeNode, process.platform === 'win32' ? 'node.exe' : 'node');
  if (!fs.existsSync(nodeExe)) throw new Error('解压后找不到 ' + nodeExe);
  say('  ✓ runtime/node  （' + execFileSync(nodeExe, ['-v'], { encoding: 'utf8' }).trim() + '）');

  // ---- DSH via bundled npm ----
  const npmCli = path.join(runtimeNode, 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (!fs.existsSync(npmCli)) throw new Error('捆绑的 Node 里没有 npm：' + npmCli);

  fs.rmSync(runtimeDsh, { recursive: true, force: true });
  fs.mkdirSync(runtimeDsh, { recursive: true });
  fs.writeFileSync(path.join(runtimeDsh, 'package.json'), JSON.stringify({
    name: 'dsh-console-bundled-dsh',
    private: true,
    description: 'Vendored @deepseek-ai/dsh for the offline console package. Do not publish.',
    dependencies: { '@deepseek-ai/dsh': dshVersion },
  }, null, 2) + '\n');

  say('  · npm install @deepseek-ai/dsh@' + dshVersion + '（构建机需联网，仅此一次）…');
  execFileSync(nodeExe, [
    npmCli, 'install',
    '--omit=dev',
    '--no-fund',
    '--no-audit',
    '--no-update-notifier',
    '--no-package-lock',
  ], {
    cwd: runtimeDsh,
    stdio: 'inherit',
    env: {
      ...process.env,
      npm_config_fund: 'false',
      npm_config_audit: 'false',
      // 把缓存放到 tools/.cache，避免污染用户全局，也方便清理
      npm_config_cache: path.join(CACHE, 'npm-cache'),
    },
  });

  const dshShim = path.join(runtimeDsh, 'node_modules', '.bin',
    process.platform === 'win32' ? 'dsh.cmd' : 'dsh');
  const dshPkg = path.join(runtimeDsh, 'node_modules', '@deepseek-ai', 'dsh', 'package.json');
  if (!fs.existsSync(dshShim)) throw new Error('安装后找不到 dsh 垫片：' + dshShim);
  if (!fs.existsSync(dshPkg)) throw new Error('安装后找不到 DSH 包：' + dshPkg);
  let installedVer = '?';
  try { installedVer = JSON.parse(fs.readFileSync(dshPkg, 'utf8')).version || '?'; } catch { /* ignore */ }
  say('  ✓ runtime/dsh  （@deepseek-ai/dsh@' + installedVer + '）');

  // 许可说明（Node MIT；DSH 以包内声明为准）
  const notice = [
    'Bundled runtime components for DSH Console offline package',
    '=========================================================',
    '',
    '1) Node.js v' + nodeVersion + ' (' + nodeArch + ')',
    '   Downloaded from: ' + zipUrl,
    '   License: see runtime/node/LICENSE',
    '',
    '2) @deepseek-ai/dsh@' + installedVer,
    '   Installed via npm into runtime/dsh/',
    '   License: see files under runtime/dsh/node_modules/@deepseek-ai/dsh/',
    '',
    'This runtime is for running the console offline. Do not redistribute',
    'without complying with the licenses of Node.js and DeepSeek Harness.',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(outDir, 'runtime', 'README.txt'), notice, 'utf8');
  say('  ✓ runtime/README.txt');

  return {
    nodeVersion,
    nodeArch,
    dshVersion: installedVer,
    nodeExe,
    dshShim,
  };
}
