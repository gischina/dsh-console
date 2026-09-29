/* DSH Console — 工具脚本 probe-skmg-latency.mjs
 * Copyright 2026 liwei (易智瑞西安) <liwei@geoscene.cn>
 * SPDX-License-Identifier: Apache-2.0
 *
 * 依据 Apache License 2.0 授权使用与分发；许可证全文见项目根目录 LICENSE，摘要见 NOTICE。
 */
/* Skills 页首屏延迟验收：用本机 Edge headless + CDP 打开 Skills 页，量三件事 ——
 *   ① 页签栏（.mcpc-tab）多久出现 —— 这是"打开页面卡不卡"的观感指标；
 *   ② 首屏期间有没有发出那条重接口（GET /api/skmg 空子路径 = 全市场扫盘 ~7.4s / 2.37MB）；
 *   ③ 轻量探测（/api/skmg-status）有没有照常发出。
 *
 * 为什么需要：这个页面曾经一进去就白等 7 秒，因为加载器无条件拉了插件的全量清单。
 * DOM 层的回归（cdp-orch-check）测不到"少打了一个请求"，只有真的数网络才拦得住。
 *
 * 用法：node tools/probe-skmg-latency.mjs
 * 依赖：控制台在 127.0.0.1:3081（CONSOLE_PORT 可覆盖）运行；本机 Edge。 */
import fs from 'fs';
import path from 'path';
import http from 'http';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const DIR = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const PORT = String(process.env.CONSOLE_PORT || 3081);
const EDGE = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe']
  .find(p => fs.existsSync(p));
if (!EDGE) { console.error('未找到 msedge.exe —— 无法验收'); process.exit(1); }

const out = [];
let fail = 0, pass = 0;
const log = (s) => { out.push(s); console.log(s); };
const ok = (c, name, extra) => {
  if (c) { pass++; log('  ✅ ' + name + (extra ? ' — ' + extra : '')); }
  else { fail++; log('  ❌ ' + name + (extra ? ' — ' + extra : '')); }
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const DP = 9339;
const USER_DIR = path.join(process.env.TEMP || '/tmp', 'edge-skmg-lat-profile');
try { fs.rmSync(USER_DIR, { recursive: true, force: true }); } catch {}
const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=' + DP,
  '--user-data-dir=' + USER_DIR, 'about:blank'], { stdio: 'ignore' });

async function cdpTargets() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch('http://127.0.0.1:' + DP + '/json/list');
      const list = await r.json();
      if (list.length) return list;
    } catch {}
    await sleep(300);
  }
  throw new Error('CDP 未就绪');
}

function wsConnect(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search,
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': Buffer.from(String(Math.random())).toString('base64') } });
    req.on('upgrade', (res, socket) => resolve(socket));
    req.on('error', reject);
    req.end();
  });
}
/* 与 cdp-orch-check 同一份极简 CDP 客户端（只处理带 id 的响应帧）。
   注意帧解析要按 **当前缓冲区头部** 读，且用 slice 而不是共享视图。 */
function mkClient(socket) {
  let buf = Buffer.alloc(0);
  const waiters = new Map();
  socket.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      if (buf.length < 2) return;
      const len7 = buf[1] & 0x7f; let len = len7, off = 2;
      if (len7 === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len7 === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (buf.length < off + len) return;
      const payload = buf.slice(off, off + len).toString('utf8');
      buf = buf.slice(off + len);
      let msg; try { msg = JSON.parse(payload); } catch { continue; }
      if (msg.id && waiters.has(msg.id)) { const w = waiters.get(msg.id); waiters.delete(msg.id); w(msg); }
    }
  });
  let id = 1;
  return {
    send(method, params) {
      const mid = id++;
      const data = Buffer.from(JSON.stringify({ id: mid, method, params: params || {} }), 'utf8');
      const mask = Buffer.from([1, 2, 3, 4]);
      let header;
      if (data.length < 126) header = Buffer.from([0x81, 0x80 | data.length]);
      else if (data.length < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(data.length, 2); }
      else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(data.length), 2); }
      const masked = Buffer.alloc(data.length);
      for (let i = 0; i < data.length; i++) masked[i] = data[i] ^ mask[i % 4];
      socket.write(Buffer.concat([header, mask, masked]));
      return new Promise((res) => waiters.set(mid, res));
    },
  };
}
function withTimeout(p, ms, label) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('超时 ' + ms + 'ms：' + label)), ms))]);
}

let client;
async function ev(expr) {
  const r = await withTimeout(client.send('Runtime.evaluate',
    { expression: expr, awaitPromise: true, returnByValue: true }), 10000, String(expr).slice(0, 60));
  if (r.result && r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.text || 'eval error');
  return r.result && r.result.result ? r.result.result.value : undefined;
}

(async () => {
  const watchdog = setTimeout(() => {
    fail++; log('  ❌ 全局超时（90s），强制收尾'); log('\nDONE fails=' + fail);
    try { proc.kill(); } catch {}
    process.exit(1);
  }, 90000);
  try {
    const targets = await cdpTargets();
    const page = targets.find(t => t.type === 'page') || targets[0];
    const socket = await wsConnect(page.webSocketDebuggerUrl);
    client = mkClient(socket);
    await client.send('Page.enable');
    await client.send('Runtime.enable');

    log('=== 打开 Skills 页首屏计时 ===');
    const t0 = Date.now();
    await client.send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/#/skills/manager' });

    /* 等页面脚本就绪（State 挂上 window）再开始轮询，否则 ev 会打空。 */
    for (let i = 0; i < 60; i++) {
      const ready = await ev(`typeof State === 'object' && !!document.getElementById('content')`).catch(() => false);
      if (ready) break;
      await sleep(100);
    }
    let tabMs = null;
    for (let i = 0; i < 100; i++) {
      const n = await ev(`document.querySelectorAll('.mcpc-tab').length`).catch(() => 0);
      if (n > 0) { tabMs = Date.now() - t0; break; }
      await sleep(100);
    }
    ok(tabMs != null, '页签栏出现（页面可用）', tabMs != null ? tabMs + 'ms' : '超时');
    ok(tabMs != null && tabMs < 2500, '首屏 < 2.5s（此前被 ~7.4s 的重接口按住）', (tabMs || 0) + 'ms');

    const urls = await ev(`(performance.getEntriesByType('resource')||[]).map(e=>e.name).filter(u=>u.includes('/api/'))`);
    log('  请求过的 /api/ : ' + JSON.stringify(urls));
    const heavy = (urls || []).filter(u => /\/api\/skmg(\?|$)/.test(u));
    ok(heavy.length === 0, '首屏没有打插件全量清单（/api/skmg 空子路径）', heavy.length ? JSON.stringify(heavy) : '0 次');
    const probe = (urls || []).filter(u => u.includes('/api/skmg-status'));
    ok(probe.length >= 1, '轻量探测照常做了（/api/skmg-status）', probe.length + ' 次');
    ok((urls || []).some(u => u.includes('/api/local/skills')), '本机技能根扫描照常做了（/api/local/skills）');

    /* 站点页签不依赖插件：探测未完成时也该在 */
    const hasLocalTab = await ev(`Array.from(document.querySelectorAll('.mcpc-tab')).some(b=>b.textContent.includes('本机配置'))`);
    ok(hasLocalTab, '「本机配置」页签在探测未完成时也可见');
    const hasOrchTab = await ev(`Array.from(document.querySelectorAll('.mcpc-tab')).some(b=>b.textContent.includes('编排'))`);
    ok(hasOrchTab, '「🧬 编排」页签可见');

    /* 切到「本机配置」应立即出内容，不等插件 */
    await ev(`skmgTab('local')`);
    await sleep(500);
    const localOk = await ev(`!!document.querySelector('.mcpc-tab.on') && document.body.innerText.includes('技能根')`);
    ok(localOk, '切到「本机配置」立刻有内容（不依赖插件探测）');
    const localMs = Date.now() - t0;

    const errs = await ev(`(window.__errs||[]).length`).catch(() => 0);
    ok(!errs, '页面无未捕获异常', String(errs || 0));
    log('  （本机配置页签可用总耗时 ' + localMs + 'ms）');

    log('\nDONE fails=' + fail);
  } catch (e) {
    fail++; log('💥 ' + e.message);
  } finally {
    clearTimeout(watchdog);
    try { fs.writeFileSync(path.join(DIR, 'tools', 'skmg-latency-out.txt'), out.join('\n')); } catch {}
    try { proc.kill(); } catch {}
    try { fs.rmSync(USER_DIR, { recursive: true, force: true }); } catch {}
    process.exit(fail ? 1 : 0);
  }
})();
