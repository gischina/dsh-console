/* DSH Console — 工具脚本 cdp-chat-check.mjs
 * Copyright 2026 liwei (易智瑞西安) <liwei@geoscene.cn>
 * SPDX-License-Identifier: Apache-2.0
 *
 * 依据 Apache License 2.0 授权使用与分发；许可证全文见项目根目录 LICENSE，摘要见 NOTICE。
 */
/* 真机核验（第二轮）：从会话页选一条"有内容"的会话设为当前，再回到对话页量渲染结构。
 * 为什么需要：沙盒脚本（render-all/sandbox-render）用的是 stub DOM，量不出"真实浏览器里
 * 到底画了多少行、工具卡/表格/列表/代码块有没有出来、轮次跳转是不是真跳到那一轮"。
 * 用法：node tools/cdp-chat-check.mjs → 结果写 tools/cdp-chat-out.txt
 * 依赖：控制台在 127.0.0.1:3081（可用 CONSOLE_PORT 覆盖）运行；本机 Edge（无 Edge 时直接跳过，不算失败）。 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const DIR = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const OUT = path.join(DIR, 'tools', 'cdp-chat-out.txt');
const PORT = String(process.env.CONSOLE_PORT || 3081);
const EDGE = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe']
  .find(p => fs.existsSync(p));
const out = []; const log = s => out.push(s);
const sleep = ms => new Promise(r => setTimeout(r, ms));

if (!EDGE) { log('未找到 msedge.exe —— 跳过真机核验（不影响其他回归项）'); fs.writeFileSync(OUT, out.join('\n')); console.log('DONE'); process.exit(0); }

const DP = 9335;
const child = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=' + DP,
  '--user-data-dir=' + path.join(os.tmpdir(), 'dsh-console-cdp-' + Date.now()), 'about:blank'], { stdio: 'ignore' });

let ws, msgId = 0; const pending = new Map(); const errs = [];
const send = (m, p = {}) => new Promise((res, rej) => { const id = ++msgId; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method: m, params: p })); });

try {
  let target = null;
  for (let i = 0; i < 40 && !target; i++) {
    await sleep(500);
    try { target = (await (await fetch('http://127.0.0.1:' + DP + '/json')).json()).find(t => t.type === 'page'); } catch {}
  }
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws fail')); });
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); return; }
    if (m.method === 'Runtime.exceptionThrown') errs.push('EXC ' + ((m.params.exceptionDetails.exception || {}).description || m.params.exceptionDetails.text));
  };
  await send('Runtime.enable'); await send('Page.enable');
  const ev = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('EVAL ERR: ' + ((r.exceptionDetails.exception || {}).description || r.exceptionDetails.text));
    return r.result.value;
  };
  const go = async (hash, wait = 9000) => { await send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/' + hash }); await sleep(wait); };

  // ① 会话页：列出行数，挑"最后活动/行标题最长"的一条设为当前
  await go('#/session/list');
  const onSessions = await ev(`(() => {
    const rows = [...document.querySelectorAll('table tbody tr')];
    const btns = [...document.querySelectorAll('button, a.btn')];
    const setCur = btns.filter(b => /设为当前/.test(b.textContent) && !b.disabled);
    return { rows: rows.length,
      sample: rows.slice(0, 3).map(r => r.textContent.replace(/\\s+/g, ' ').trim().slice(0, 90)),
      setCurBtns: setCur.length };
  })()`);
  log('=== 会话页 ===');
  log(JSON.stringify(onSessions, null, 1));

  const clicked = await ev(`(async () => {
    const btns = [...document.querySelectorAll('button, a.btn')].filter(b => /设为当前/.test(b.textContent) && !b.disabled);
    if (!btns.length) return '没有可点的「设为当前」';
    btns[Math.min(1, btns.length - 1)].click();
    await new Promise(r => setTimeout(r, 2500));
    return '已点第 ' + Math.min(2, btns.length) + ' 条的「设为当前」';
  })()`);
  log('\n=== 设为当前 ===');
  log(String(clicked));

  // ② 回对话页量结构
  await go('#/chat-agent', 11000);
  const stats = await ev(`(() => {
    const log = document.getElementById('chatlog'); if (!log) return { fatal: 'no chatlog' };
    const q = s => log.querySelectorAll(s).length;
    const titles = {}; log.querySelectorAll('.tr-title').forEach(t => { const k = t.textContent.trim(); titles[k] = (titles[k] || 0) + 1; });
    const roles = {}; log.querySelectorAll('.msg[data-role]').forEach(m => { const k = m.dataset.role; roles[k] = (roles[k] || 0) + 1; });
    return {
      rows: log.querySelectorAll(':scope > .rail').length,
      byRole: roles,
      toolRows: q('.toolrow'), subCalls: q('.chat-subcall'),
      toolTitles: titles,
      msgActions: q('.msg-actions'), turnFoots: q('.turn-foot'),
      todoRows: q('.td-item'), produced: q('.crow-produced-slot'),
      mdTables: q('table.md-table'), mdList: q('.msg [style*="padding-left"]'), mdPre: q('pre'), mdImg: q('img'),
      navButtons: document.querySelectorAll('.chat-nav button').length,
      badge: (document.getElementById('chatplan')||{}).textContent||'',
      meta: (document.getElementById('chatmeta')||{}).textContent||'',
      hiddenRows: [...log.querySelectorAll(':scope > .rail')].filter(r => r.hidden || getComputedStyle(r).display === 'none').length,
    };
  })()`);
  log('\n=== 对话页（选中会话后）===');
  for (const [k, v] of Object.entries(stats || {})) log(String(k).padEnd(12) + ' = ' + (typeof v === 'object' ? JSON.stringify(v) : String(v).replace(/\s+/g, ' ').slice(0, 260)));

  // ③ 轮次跳转一致性：点第 N 轮 → 停止滚动位置附近的行 data-seq 应 >= 该轮锚点
  const jump = await ev(`(async () => {
    const btns = [...document.querySelectorAll('.chat-nav button')];
    if (btns.length < 3) return '轮次按钮 ' + btns.length + ' 个（不足以抽查）';
    const res = [];
    for (const i of [1, 2]) {
      const b = btns[i]; b.click();
      await new Promise(r => setTimeout(r, 700));
      const log = document.getElementById('chatlog');
      const vis = [...log.querySelectorAll('.msg[data-seq]')].find(m => m.getBoundingClientRect().top > log.getBoundingClientRect().top - 5);
      res.push(b.textContent.trim() + ' → 视口首行 seq=' + (vis ? vis.dataset.seq : '?'));
    }
    return res.join(' | ');
  })()`);
  log('\n=== 轮次跳转 ===');
  log(String(jump));
  log('\n=== 异常 ===');
  log(errs.slice(0, 10).join('\n') || '（无）');
} catch (e) { log('FATAL ' + e.message); }
finally { try { ws && ws.close(); } catch {} child.kill(); fs.writeFileSync(OUT, out.join('\n')); console.log('DONE'); }
