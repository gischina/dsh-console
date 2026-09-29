/* DSH Console — 工具脚本 cdp-orch-check.mjs
 * Copyright 2026 liwei (易智瑞西安) <liwei@geoscene.cn>
 * SPDX-License-Identifier: Apache-2.0
 *
 * 依据 Apache License 2.0 授权使用与分发；许可证全文见项目根目录 LICENSE，摘要见 NOTICE。
 */
/* 技能编排器的真机验收：用本机 Edge headless + CDP 打开 Skills 页「🧬 编排」页签，
 * 真实点击节点仓库 → 校验画布/参数面板/校验结果的 DOM 是否按预期长出来。
 *
 * 为什么需要：编排器是纯前端 + 事件驱动的，render-all 那种"函数生成 HTML"测不到
 * 拖拽、连线、参数来源切换这些交互；只有真浏览器里点一遍才算数。
 *
 * 用法：node tools/cdp-orch-check.mjs
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

const DP = 9337;

/* 启动 Edge headless，拿 CDP websocket */
const USER_DIR = path.join(process.env.TEMP || '/tmp', 'edge-orch-profile');
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
/* 极简 CDP 客户端：只实现文本帧的 send/recv */
function mkClient(socket) {
  let buf = Buffer.alloc(0);
  const waiters = new Map();
  socket.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      if (buf.length < 2) return;
      const b1 = buf[1]; let len = b1 & 0x7f; let off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
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
      const body = JSON.stringify({ id: mid, method, params: params || {} });
      const data = Buffer.from(body, 'utf8');
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

let client;
const EV_MS = 10000;
async function ev(expr) {
  const r = await withTimeout(
    client.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }),
    EV_MS, String(expr).slice(0, 60));
  if (r.result && r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.text || 'eval error');
  return r.result && r.result.result ? r.result.result.value : undefined;
}

/** 给每个 CDP 调用加超时：awaitPromise 遇到页面里永远不 settle 的 promise 会挂死，
 *  以前整条脚本就这么卡住不返回。宁可单条失败也不要整轮跑不完。 */
function withTimeout(p, ms, label) {
  return Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error('超时 ' + ms + 'ms：' + label)), ms)),
  ]);
}

(async () => {
  /* 全局看门狗：无论卡在哪一步，到点就收摊、把已有结果写盘。 */
  const watchdog = setTimeout(() => {
    fail++;
    log('  ❌ 全局超时（180s）—— 脚本被判为挂起，强制收尾');
    log('\nDONE fails=' + fail);
    try { fs.writeFileSync(path.join(DIR, 'tools', 'cdp-orch-out.txt'), out.join('\n')); } catch {}
    try { proc.kill(); } catch {}
    process.exit(1);
  }, 180000);
  try {
    const targets = await cdpTargets();
    const page = targets.find(t => t.type === 'page') || targets[0];
    const socket = await wsConnect(page.webSocketDebuggerUrl);
    client = mkClient(socket);
    await client.send('Page.enable');
    await client.send('Runtime.enable');

    await client.send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/#/skills/manager' });
    /* 等插件探测完成 —— 页面先画"正在探测 Skills 管理插件…"的骨架，
       探测（/api/skmg-status）回来后才出页签栏。轮询而不是死等固定秒数。 */
    for (let i = 0; i < 30; i++) {
      const n = await ev(`document.querySelectorAll('.mcpc-tab').length`).catch(() => 0);
      if (n > 0) break;
      await sleep(1000);
    }

    log('=== 打开 Skills 页 → 🧬 编排 页签 ===');
    const tabs = await ev(`Array.from(document.querySelectorAll('.mcpc-tab')).map(b=>b.textContent.trim())`);
    ok(Array.isArray(tabs) && tabs.some(t => t.includes('编排')), '页签栏出现「🧬 编排」', JSON.stringify(tabs));

    await ev(`(()=>{const b=Array.from(document.querySelectorAll('.mcpc-tab')).find(x=>x.textContent.includes('编排'));if(b)b.click();return !!b})()`);
    /* 切页签后要等 orchLoadList + orchLoadPool 两次请求回来 */
    for (let i = 0; i < 20; i++) {
      const n = await ev(`document.querySelectorAll('.orch-pool-item').length`).catch(() => 0);
      if (n > 0) break;
      await sleep(1000);
    }
    await sleep(500);
    const hasCanvas = await ev(`!!document.getElementById('orchcanvas')`);
    ok(hasCanvas, '画布容器 #orchcanvas 已渲染');
    const three = await ev(`document.querySelectorAll('.orch-grid > .orch-panel, .orch-grid > .orch-canvas-wrap').length`);
    ok(three === 3, '三栏布局（左仓库 / 中画布 / 右面板）', '实际 ' + three);
    const empty = await ev(`!!document.querySelector('.orch-canvas-empty')`);
    ok(empty, '空态提示可见');
    const poolN = await ev(`document.querySelectorAll('.orch-pool-item').length`);
    ok(poolN > 0, '左侧节点仓库列出了 MCP 工具', poolN + ' 个');
    const wires = await ev(`!!document.getElementById('orchwires')`);
    ok(wires, '连线 SVG 层存在');

    log('\n=== 服务下拉（先选服务 → 再列工具）===');
    const connOpts = await ev(`Array.from(document.querySelectorAll('.orch-conns select option')).map(o=>o.textContent.trim())`);
    ok(connOpts.length >= 2, '服务是可伸缩的下拉框（全部服务 + 各连接）', JSON.stringify(connOpts));
    const chipCountBefore = await ev(`document.querySelectorAll('.orch-pool-item').length`);
    /* 选中第一个非"全部"的服务 */
    await ev(`(()=>{const s=document.querySelector('.orch-conns select');
      const i=Array.from(s.options).findIndex(o=>o.value);if(i<0)return 0;
      s.selectedIndex=i;s.dispatchEvent(new Event('change',{bubbles:true}));return 1})()`);
    await sleep(300);
    const connSel = await ev(`(()=>{const s=document.querySelector('.orch-conns select');
      return s.selectedIndex>0 && s.options[s.selectedIndex].value})()`);
    ok(!!connSel, '下拉选中的是一个真实服务', String(connSel));
    const chipCountAfter = await ev(`document.querySelectorAll('.orch-pool-item').length`);
    ok(chipCountAfter > 0 && chipCountAfter <= chipCountBefore, '选中服务后工具按服务过滤', chipCountBefore + ' → ' + chipCountAfter);
    /* 回落到"全部服务" */
    await ev(`(()=>{const s=document.querySelector('.orch-conns select');
      s.selectedIndex=0;s.dispatchEvent(new Event('change',{bubbles:true}));return 1})()`);
    await sleep(300);
    const backAll = await ev(`(()=>{const s=document.querySelector('.orch-conns select');
      return s.selectedIndex===0 && document.querySelectorAll('.orch-pool-item').length})()`);
    ok(backAll >= chipCountBefore, '回到"全部服务"后工具恢复全量', String(backAll));

    log('\n=== 顶栏与草稿下拉 ===');
    /* 先播种一份草稿到**当前会话 cwd 所属的项目根** —— 编排的落点是"会话工作目录向上
       找最近的 .git"，测试页自己的 cwd 未必等于控制台进程的 cwd，所以这里问页面要 cwd，
       再按它存一份。不播种的话这条断言在干净环境下永远看不到草稿，等于白测。
       ⚠ 不依赖 State.sessions 的内部形状：优先问页面拿会话 cwd，拿不到就退回
       控制台进程自己的 cwd（服务端会用 process.cwd() 兜底）。 */
    const pageCwd = await ev(`(()=>{try{
      const s=(State.sessions&&(State.sessions.items||State.sessions.list||State.sessions))||[];
      const arr=Array.isArray(s)?s:(s.items||s.list||[]);
      const cur=arr.find(x=>x&&(x.id===State.sessionId||x.sessionId===State.sessionId));
      return (cur&&cur.cwd)||'';
    }catch(e){return ''}})()`).catch(() => '');
    log('  页面会话 cwd = ' + (pageCwd || '(取不到，退回服务端 cwd)'));
    const seedDoc = {
      name: 'cdp-seed-orch', title: 'CDP 回归样例', description: '这条草稿由 cdp-orch-check 播种，用于验证「选已保存的编排」这条路径。',
      nodes: [{ id: 's1', kind: 'mcp', tool: 'render_point', title: 'render_point', x: 40, y: 40,
        connectorId: '__json__', serverName: 'geoscenepro', args: {},
        inputSchema: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] } }],
      edges: [],
    };
    let seedJson = {};
    try {
      const seedRes = await fetch('http://127.0.0.1:' + PORT + '/api/local/orch'
        + (pageCwd ? '?cwd=' + encodeURIComponent(pageCwd) : ''),
        { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: seedDoc.name, doc: seedDoc }),
          signal: AbortSignal.timeout(8000) });
      seedJson = await seedRes.json().catch(() => ({}));
    } catch (e) { seedJson = { error: e.message }; }
    ok(seedJson.ok, '播种草稿到页面 cwd 的项目根', seedJson.projectRoot || seedJson.error || '');
    /* 让页面重新拉一次清单（不 await 返回的 promise：它 reject 时 CDP 的 awaitPromise 会挂住） */
    await ev(`(orchLoadList(true).then(()=>render({paintOnly:true})).catch(()=>0), 1)`);
    await sleep(1200);

    const barInputs = await ev(`Array.from(document.querySelectorAll('.orch-bar .orch-in')).map(i=>i.placeholder)`);
    ok(barInputs.length >= 3, '顶栏一行放下 编排名/标题/描述 三个输入', JSON.stringify(barInputs));
    const draftSel = await ev(`!!document.querySelector('.orch-bar2 select')`);
    ok(draftSel, '草稿列表收成了顶栏下拉（不再占画布上方的高度）');
    /* ⚠ 回归守：option 的 value 绝不能带引号。
       历史 bug：value 用了 fmt.attr → value="&quot;orch-x&quot;" → 解析出的名字带一对引号 →
       orchOpen 报"找不到这个编排（草稿与技能目录里都没有）："orch-x""。 */
    const quotedOpts = await ev(`Array.from(document.querySelectorAll('.orch-bar2 option')).filter(o=>o.value && /^["']/.test(o.value)).map(o=>o.value)`);
    ok(quotedOpts.length === 0, '草稿下拉的 option value 没有多余引号', JSON.stringify(quotedOpts));
    const draftOpts = await ev(`Array.from(document.querySelectorAll('.orch-bar2 option')).map(o=>o.value).filter(Boolean)`);
    ok(draftOpts.length > 0, '草稿下拉里有可选的编排', JSON.stringify(draftOpts));
    /* 真去选一次，确认能打开（这正是用户报的那条路径） */
    await ev(`(()=>{const s=document.querySelector('.orch-bar2 select');
      const i=Array.from(s.options).findIndex(o=>o.value);if(i<0)return 0;
      s.selectedIndex=i;s.dispatchEvent(new Event('change',{bubbles:true}));return 1})()`);
    await sleep(900);
    const openErr = await ev(`(document.body.innerText.match(/找不到这个编排[^\\n]*/)||[''])[0]`);
    ok(!openErr, '从下拉选一个编排能正常打开（无"找不到这个编排"）', openErr || '(无错误)');
    /* 打开的确实是被选的那份：编排名回填 + 画布上出现它的节点 */
    const openedName = await ev(`State.orch.name`);
    ok(openedName === 'cdp-seed-orch', '打开的正是下拉里选中的那份编排', String(openedName));
    const seededNode = await ev(`document.querySelectorAll('[data-orch-node]').length`);
    ok(seededNode === 1, '被打开的编排把节点还原到了画布上', seededNode + ' 个');
    /* 打开完成后把画布清掉，后面的用例从头开始。
       ⚠ 不能调 orchNew()：它第一件事是 await UI.confirm(...)，无头浏览器里没人点确认，
       那个 promise 永远不 settle —— CDP 的 awaitPromise 会把整条脚本挂死。
       直接改 State 再重绘，效果等价。 */
    await ev(`(()=>{const O=State.orch;O.name='my-orchestration';O.title='';O.description='';
      O.nodes=[];O.edges=[];O.sel=null;O.lastCheck=null;render({paintOnly:true});return 1})()`);
    await sleep(300);
    const pageScroll = await ev(`[document.documentElement.scrollHeight, document.documentElement.clientHeight]`);
    ok(pageScroll[0] <= pageScroll[1] + 2, '整页无滚动条（画布优先的版面）', 'scrollH=' + pageScroll[0] + ' clientH=' + pageScroll[1]);

    log('\n=== 点一个工具 → 加节点 ===');
    await ev(`(()=>{const it=document.querySelector('.orch-pool-item');if(it)it.click();return !!it})()`);
    /* 点完要等 toolDetail 把 inputSchema 补回来（列表接口不带 schema） */
    for (let i = 0; i < 15; i++) {
      const n = await ev(`document.querySelectorAll('.orch-arg').length`).catch(() => 0);
      if (n > 0) break;
      await sleep(1000);
    }
    const nodeN = await ev(`document.querySelectorAll('[data-orch-node]').length`);
    ok(nodeN === 1, '节点已加进画布', nodeN + ' 个');
    const panelTitles = await ev(`Array.from(document.querySelectorAll('.orch-panel-h')).map(x=>x.textContent.trim())`);
    ok(panelTitles.some(t => /🧰|🧩/.test(t)), '右侧切到该节点的参数面板', JSON.stringify(panelTitles));
    const argN = await ev(`document.querySelectorAll('.orch-arg').length`);
    ok(argN > 0, '参数面板列出了参数', argN + ' 个');
    const reqTag = await ev(`document.querySelectorAll('.orch-arg .tag').length > 0`);
    ok(reqTag, '参数上标了类型/必填');

    log('\n=== 参数来源切换（三层校验的第 ③ 层）===');
    await ev(`(()=>{const s=document.querySelector('.orch-arg select');if(s){s.value='const';s.dispatchEvent(new Event('change'));}return !!s})()`);
    await sleep(400);
    const hasValInput = await ev(`document.querySelectorAll('.orch-arg input').length > 0`);
    ok(hasValInput, '选「固定值」后出现取值输入框');
    await ev(`(()=>{const s=document.querySelector('.orch-arg select');if(s){s.value='upstream';s.dispatchEvent(new Event('change'));}return !!s})()`);
    await sleep(400);
    const hasUpSel = await ev(`Array.from(document.querySelectorAll('.orch-arg select')).length >= 1`);
    ok(hasUpSel, '切到「上游输出」有选择器');

    log('\n=== 校验结果常驻 + 连线着色 ===');
    /* 加第二个节点并连线，验证：连线有状态色、右栏选中节点时校验结果仍常驻 */
    await ev(`(()=>{const d=document.querySelector('[data-orch-node] .orch-node-del');if(d)d.click();return !!d})()`);
    await sleep(500);
    await ev(`(()=>{const it=document.querySelector('.orch-pool-item');if(it)it.click();return 1})()`);
    for (let i = 0; i < 15; i++) { const n = await ev(`document.querySelectorAll('.orch-arg').length`).catch(() => 0); if (n > 0) break; await sleep(1000); }
    await ev(`(()=>{const it=document.querySelectorAll('.orch-pool-item')[1];if(it)it.click();return 1})()`);
    for (let i = 0; i < 15; i++) { const n = await ev(`document.querySelectorAll('[data-orch-node]').length`).catch(() => 0); if (n >= 2) break; await sleep(1000); }
    await ev(`(()=>{const ns=document.querySelectorAll('[data-orch-node]');if(ns.length>=2){const a=ns[0].getAttribute('data-orch-node'),b=ns[1].getAttribute('data-orch-node');window.orchLink && orchLink(a,b);}return 1})()`);
    await sleep(500);
    const edgeN = await ev(`document.querySelectorAll('#orchwires .orch-wire').length`);
    ok(edgeN === 1, '两个节点连出一条线', edgeN + ' 条');
    const wireCls = await ev(`(document.querySelector('#orchwires .orch-wire')||{getAttribute:()=>''}).getAttribute('class')`);
    ok(/st-(ok|warn|bad|idle)/.test(String(wireCls)), '连线带状态色（绿/黄/红/灰）', String(wireCls).trim());
    const hitN = await ev(`document.querySelectorAll('#orchwires .orch-wire-hit').length`);
    ok(hitN === 1, '连线上叠了悬停命中区（含 <title> 说明）', hitN + ' 条');
    /* 选中节点（参数面板展开）时，校验结果必须仍然可见 —— 旧版会整个被顶掉 */
    const checkVisible = await ev(`(()=>{const c=document.getElementById('orchcheck');if(!c)return false;const r=c.getBoundingClientRect();return r.height>40;})()`);
    ok(checkVisible, '选中节点时右栏校验结果仍常驻可见（旧版会被参数面板顶掉）');
    const legend = await ev(`(document.getElementById('orchcheck')||{textContent:''}).textContent.includes('悬停连线')`);
    ok(legend, '校验面板里有连线图例说明');

    log('\n=== 校验结果面板 ===');
    await ev(`(()=>{let n=0;const t=setInterval(()=>{const d=document.querySelector('[data-orch-node] .orch-node-del');if(d){d.click();n++;}else clearInterval(t);},120);return 1})()`);
    for (let i = 0; i < 20; i++) {
      const n = await ev(`document.querySelectorAll('[data-orch-node]').length`).catch(() => 0);
      if (n === 0) break;
      await sleep(500);
    }
    const afterDel = await ev(`document.querySelectorAll('[data-orch-node]').length`);
    ok(afterDel === 0, '删除节点生效', afterDel + ' 个');
    const msgs = await ev(`document.querySelectorAll('.orch-msg').length`);
    ok(msgs > 0, '校验面板给出结论', msgs + ' 条');

    log('\n=== 导出前置校验：缺描述应被拦下 ===');
    await ev(`(()=>{const b=Array.from(document.querySelectorAll('.orch-panel-item, .orch-pool-item'));return 1})()`);
    await ev(`(()=>{const it=document.querySelector('.orch-pool-item');if(it)it.click();return !!it})()`);
    await sleep(400);
    const before = await ev(`document.querySelectorAll('[data-orch-node]').length`);
    await ev(`(()=>{const b=Array.from(document.querySelectorAll('button')).find(x=>x.textContent.includes('导出技能'));if(b)b.click();return !!b})()`);
    await sleep(1500);
    const toastText = await ev(`(document.body.innerText.match(/描述|错误|导出/)||[''])[0]`);
    const stillAlive = await ev(`document.querySelectorAll('[data-orch-node]').length`);
    ok(stillAlive === before && before > 0, '缺描述时导出被拦下（画布未被破坏）', '节点 ' + stillAlive);

    log('\n=== 无 JS 异常 ===');
    const errs = await ev(`(window.__orchErrs||[]).join(' | ')`);
    ok(!errs, '页面无未捕获异常', errs || '无');

  } catch (e) {
    fail++;
    log('  ❌ 执行异常 — ' + e.message);
  } finally {
    clearTimeout(watchdog);
    log('\nDONE fails=' + fail);
    fs.writeFileSync(path.join(DIR, 'tools', 'cdp-orch-out.txt'), out.join('\n'));
    try { proc.kill(); } catch {}
    process.exit(fail ? 1 : 0);
  }
})();
