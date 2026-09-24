/* DSH Console — 工具脚本 shot-page.mjs
 * Copyright 2026 liwei (易智瑞西安) <liwei@geoscene.cn>
 * SPDX-License-Identifier: Apache-2.0
 *
 * 依据 Apache License 2.0 授权使用与分发；许可证全文见项目根目录 LICENSE，摘要见 NOTICE。
 */
/* 截图工具：用本机 Edge headless + CDP 打开控制台的任意路由，按固定宽度截整页图。
 * 为什么需要：README / docs 里的界面截图要与真实产物一致，手工截图没法复现、也容易忘。
 * 用法：node tools/shot-page.mjs --route=#/knowledge --out=docs/images/knowledge.png [--width=1910] [--theme=dark]
 *      可重复用 --route/--out 组合，一次跑多张。
 * 依赖：控制台在 127.0.0.1:3081（可用 CONSOLE_PORT 覆盖）运行；本机 Edge（无 Edge 时报错退出）。 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const DIR = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const PORT = String(process.env.CONSOLE_PORT || 3081);
const EDGE = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe']
  .find(p => fs.existsSync(p));

/* ---- 参数 ---- */
const jobs = []; let width = 1910; let theme = 'dark'; let height = 1200; let wait = 12000;
for (const a of process.argv.slice(2)) {
  let m;
  if ((m = a.match(/^--route=(.+)$/))) jobs.push({ route: m[1] });
  else if ((m = a.match(/^--out=(.+)$/))) jobs[jobs.length - 1].out = m[1];
  else if ((m = a.match(/^--width=(\d+)$/))) width = Number(m[1]);
  else if ((m = a.match(/^--height=(\d+)$/))) height = Number(m[1]);
  else if ((m = a.match(/^--wait=(\d+)$/))) wait = Number(m[1]);
  else if ((m = a.match(/^--click=(.+)$/))) jobs[jobs.length - 1].click = m[1];
  else if ((m = a.match(/^--clickwait=(\d+)$/))) jobs[jobs.length - 1].clickwait = Number(m[1]);
  else if ((m = a.match(/^--theme=(\w+)$/))) theme = m[1];
}
if (!jobs.length || jobs.some(j => !j.route || !j.out)) {
  console.error('用法：node tools/shot-page.mjs --route=#/knowledge --out=docs/images/knowledge.png [--width=1910] [--theme=dark]');
  process.exit(2);
}
if (!EDGE) { console.error('未找到 msedge.exe —— 无法截图'); process.exit(1); }

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* MSYS/Git Bash 会把命令行里的 /xxx 当路径改写成 Windows 绝对路径（#/knowledge → #C:/…/knowledge），
   这里把被改写掉的前缀还原回来。*/
const unmunge = s => { const m = s.match(/^#?[A-Za-z]:[\\/].*?[\\/]([A-Za-z0-9_-]+(?:[\\/][A-Za-z0-9_-]+)*)$/); return m ? '#/' + m[1].replace(/\\/g, '/') : s; };
for (const j of jobs) j.route = unmunge(j.route);

const DP = 9336;
const child = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars',
  '--remote-debugging-port=' + DP, '--window-size=' + width + ',' + height,
  '--user-data-dir=' + path.join(os.tmpdir(), 'dsh-console-shot-' + Date.now()), 'about:blank'], { stdio: 'ignore' });

let ws, msgId = 0; const pending = new Map();
const send = (m, p = {}) => new Promise((res, rej) => { const id = ++msgId; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method: m, params: p })); });

let code = 0;
try {
  let target = null;
  for (let i = 0; i < 40 && !target; i++) {
    await sleep(500);
    try { target = (await (await fetch('http://127.0.0.1:' + DP + '/json')).json()).find(t => t.type === 'page'); } catch {}
  }
  if (!target) throw new Error('Edge 没有起来（CDP 端口无 page 目标）');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws fail')); });
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); return; }
  };
  await send('Runtime.enable'); await send('Page.enable');
  const ev = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('EVAL ERR: ' + ((r.exceptionDetails.exception || {}).description || r.exceptionDetails.text));
    return r.result.value;
  };

  for (const j of jobs) {
    /* 主题镜像：index.html 的**首屏**上色读的是 localStorage 的 `dshThemePref`
     * （键名见 public/index.html 的引导脚本），先写再进页面，避免截出"先深后浅"的中间态。
     * ⚠️ 这里只影响首屏那一瞬；进页面后 app.js 会用 ui-prefs.yaml 的真实偏好覆盖成权威值。
     *    所以要截某个主题的正式截图，得先把偏好改对（设置页「外观」，或直接改 ui-prefs.yaml）。 */
    await send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/' });
    await sleep(2500);
    await ev(`(() => { try { localStorage.setItem('dshThemePref', ${JSON.stringify(theme)}); } catch {} ; return 1; })()`);
    await send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/' + j.route });
    await sleep(wait);

    // 页面状态自述：截到的到底是什么，别截一张"正在装载"
    const info = await ev(`(() => {
      const c = document.getElementById('content');
      const de = document.documentElement;
      return {
        route: (location.hash || '#/home'),
        theme: de.getAttribute('data-theme') || '(未设)',
        colorScheme: de.style.colorScheme || '',
        contentChars: c ? c.textContent.replace(/\\s+/g, ' ').trim().length : -1,
        skeleton: /正在装载|正在检查|加载中/.test(c ? c.textContent : ''),
        scrollH: de.scrollHeight, clientH: de.clientHeight,
      };
    })()`);
    console.log(j.out, JSON.stringify(info));

    // 可选：截图前点一下页面里的元素（按可见文本匹配，比如选中某个知识库），让截图带真实内容
    if (j.click) {
      const hit = await ev(`(() => {
        const t = ${JSON.stringify(j.click)}.toLowerCase();
        const sel = 'button, [role=button], a, li, .kb-row, .kb-card, [class*=item], [class*=row], [class*=card]';
        let hits = [...document.querySelectorAll(sel)]
          .filter(e => e.textContent && e.textContent.trim().toLowerCase().includes(t) && e.offsetParent);
        /* 兜底：插件界面（React + 自有类名体系）的行不一定带 item/row/card 这类词
         * —— 实测知识库列表行就是无类名的 <span>（"geoscene pro"），上面的选择器
         * 一个都扫不到。落空时退回"全文档扫可见叶子元素"，同样按"文本最短者胜"
         * 点最深的那个（click 事件会冒泡，React 的行级 onClick 照常触发）。 */
        if (!hits.length) {
          hits = [...document.querySelectorAll('*')]
            .filter(e => !e.children.length && e.textContent && e.textContent.trim().toLowerCase().includes(t) && e.offsetParent);
        }
        if (!hits.length) return 'no match';
        // 取文本最短的那个（最深的元素），避免点到把整个面板包进去的祖先
        const el = hits.reduce((a, b) => (b.textContent.length < a.textContent.length ? b : a));
        el.click(); return 'clicked: <' + el.tagName.toLowerCase() + '> ' + el.textContent.trim().slice(0, 60);
      })()`);
      console.log('click:', hit);
      await sleep(j.clickwait || 4000);
    }

    const full = Math.max(height, Math.min(6000, (info.scrollH || height) + 8));
    await send('Emulation.setDeviceMetricsOverride', { width, height: full, deviceScaleFactor: 2, mobile: false });
    await sleep(1200);
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    const abs = path.isAbsolute(j.out) ? j.out : path.join(DIR, j.out);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, Buffer.from(shot.data, 'base64'));
    console.log('WROTE', abs, fs.statSync(abs).size + ' B');
  }
} catch (e) { console.error('FATAL ' + e.message); code = 1; }
finally { try { ws && ws.close(); } catch {} child.kill(); }
process.exit(code);
