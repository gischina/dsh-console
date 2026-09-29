/* CDP 验证：入口去重（MCP 页 + Skills 页）
 *
 * 背景（2026-09-29）：用户指出同一动作在**同一页内**有两个入口。删了三处：
 *   1. MCP「已连接」卡片头部的 ➕ 添加连接 / 🩺 全部测活（顶栏各有一个，全页签常驻）
 *   2. Skills 市场状态条的 🔄 同步（顶栏「🔄 同步市场」同函数）
 *   3. Skills 详情弹窗底部的 三个写操作（卡片行上每个都有）
 *
 * 这个脚本守三件事：
 *   A. 删掉的入口**真的没了**
 *   B. 顶栏/卡片行那份**还在**（能力不能少）
 *   C. 页面无 JS 异常（删按钮不能删出语法/引用错误）
 *
 * ⚠ 铁律：
 *   1. `ev()` 必须带超时。UI.confirm() 在 headless 下永不 settle，
 *      没有超时就会整个脚本挂死（踩过，挂了 4 分钟）。
 *   2. **绝不为了拿数据去 await `GET /api/skmg`**（空子路径）。那是插件全市场扫盘，
 *      实测 2,373,860 字节 / 30s 量级；本机用户库还常是空的，等来的可能是 0 项。
 *      需要技能名就单点 `/api/skmg/detail?name=`。
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const PORT = process.env.CONSOLE_PORT || 3081;
const BASE = `http://127.0.0.1:${PORT}`;
const EDGE = process.env.EDGE_BIN || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const CDP_PORT = 9339;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✅ ' + m); } else { fail++; console.log('  ❌ ' + m); } };
const log = (m) => console.log(m);

function getJson(url) {
  return new Promise((res, rej) => {
    http.get(url, r => { let b = ''; r.on('data', d => b += d); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); }).on('error', rej);
  });
}
/** 只探"起来没有"，不解析 JSON —— 根路径就是首页，最稳。 */
function alive(url) {
  return new Promise(res => {
    const r = http.get(url, x => { x.resume(); res(true); });
    r.on('error', () => res(false));
    r.setTimeout(2000, () => { r.destroy(); res(false); });
  });
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ---- 极简 CDP 客户端（照抄 cdp-orch-check 的成熟实现）---- */
function mkClient(wsUrl) {
  const url = new URL(wsUrl);
  return new Promise((resolve, reject) => {
    const key = Buffer.from('dedup' + Math.random()).toString('base64').slice(0, 16);
    const req = http.request({
      host: url.hostname, port: url.port, path: url.pathname + url.search,
      headers: {
        Connection: 'Upgrade', Upgrade: 'websocket',
        'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13',
      },
    });
    req.on('upgrade', (res, socket) => {
      let buf = Buffer.alloc(0);
      const waiters = new Map();
      let id = 0;
      socket.on('data', chunk => {
        buf = Buffer.concat([buf, chunk]);
        while (buf.length >= 2) {
          const len = buf[1] & 0x7f;
          let off = 2, payloadLen = len;
          if (len === 126) { if (buf.length < 4) break; payloadLen = buf.readUInt16BE(2); off = 4; }
          else if (len === 127) { if (buf.length < 10) break; payloadLen = Number(buf.readBigUInt64BE(2)); off = 10; }
          if (buf.length < off + payloadLen) break;
          const payload = buf.slice(off, off + payloadLen).toString();
          buf = buf.slice(off + payloadLen);
          let msg; try { msg = JSON.parse(payload); } catch { continue; }
          if (msg.id && waiters.has(msg.id)) { waiters.get(msg.id)(msg); waiters.delete(msg.id); }
        }
      });
      const send = (method, params) => new Promise(res => {
        const mid = ++id;
        waiters.set(mid, res);
        const body = Buffer.from(JSON.stringify({ id: mid, method, params: params || {} }));
        const mask = Buffer.from([0, 0, 0, 0]);
        let head;
        if (body.length < 126) head = Buffer.from([0x81, 0x80 | body.length]);
        else if (body.length < 65536) { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 0xFE; head.writeUInt16BE(body.length, 2); }
        else { head = Buffer.alloc(10); head[0] = 0x81; head[1] = 0xFF; head.writeBigUInt64BE(BigInt(body.length), 2); }
        socket.write(Buffer.concat([head, mask, body]));
      });
      resolve({ send, close: () => socket.destroy() });
    });
    req.on('error', reject);
    req.end();
  });
}

async function main() {
  // 端口探测
  if (!(await alive(BASE + '/'))) { console.log('控制台未启动（' + BASE + '），跳过'); process.exit(0); }

  const edge = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${path.join(ROOT, '.cdp-dedup-profile')}`,
    'about:blank',
  ], { stdio: 'ignore' });

  let cdp = null;
  try {
    let tabs = null;
    for (let i = 0; i < 40; i++) {
      await sleep(400);
      try { tabs = await getJson(`http://127.0.0.1:${CDP_PORT}/json/list`); } catch { continue; }
      if (tabs && tabs.length) break;
    }
    // ⚠ tabs[0] 可能是扩展页，必须筛 type === 'page'
    const page = (tabs || []).find(t => t.type === 'page');
    if (!page) throw new Error('找不到 page 目标');
    cdp = await mkClient(page.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');

    const ev = async (expr, timeoutMs = 10000) => {
      const r = await Promise.race([
        cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }),
        sleep(timeoutMs).then(() => ({ __timeout: true })),
      ]);
      if (r.__timeout) throw new Error('ev 超时: ' + expr.slice(0, 70));
      if (r.result && r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.text);
      return r.result && r.result.result ? r.result.result.value : undefined;
    };

    await cdp.send('Page.navigate', { url: BASE + '/' });
    for (let i = 0; i < 60; i++) { await sleep(300); if (await ev('typeof State')) break; }
    ok(await ev('typeof State === "object"'), '页面 State 已就绪');

    /* ---------- MCP 页 ---------- */
    log('\n=== MCP 页：已连接 页签入口去重 ===');
    await ev(`location.hash = '#/mcp/manager'; 1`);
    await sleep(1200);
    if (await ev(`(State.mcpc && State.mcpc.tab !== 'conn') ? (State.mcpc.tab='conn', render({paintOnly:true}), 1) : 1`)) await sleep(400);

    const mcp = await ev(`(() => {
      const btns = Array.from(document.querySelectorAll('.content button, .page-title button'));
      const txt = btns.map(b => (b.textContent||'').trim());
      return {
        add: txt.filter(t => t.includes('添加连接')).length,
        health: txt.filter(t => t.includes('全部测活')).length,
        head: Array.from(document.querySelectorAll('.pt-actions button')).map(b=>(b.textContent||'').trim()),
      };
    })()`);
    log('  顶栏按钮：' + JSON.stringify(mcp.head));
    ok(mcp.head.some(t => t.includes('添加连接')), '顶栏「添加连接」还在');
    ok(mcp.head.some(t => t.includes('全部测活')), '顶栏「全部测活」还在');
    ok(mcp.head.some(t => t.includes('刷新目录')), '顶栏「刷新目录」还在');
    ok(mcp.head.some(t => t.includes('导出配置')), '顶栏「导出配置」还在');
    // 有连接时：添加连接 1 个（顶栏）、全部测活 1 个（顶栏）
    const hasItems = await ev('!!(State.mcpc.items && State.mcpc.items.length)');
    if (hasItems) {
      ok(mcp.add === 1, '「添加连接」全页只剩 1 个（顶栏），实得 ' + mcp.add);
      ok(mcp.health === 1, '「全部测活」全页只剩 1 个（顶栏），实得 ' + mcp.health);
    } else {
      log('  （无已连接项，空列表引导卡保留「添加连接」，跳过计数断言）');
      ok(mcp.add <= 2, '空列表时「添加连接」不超 2 个（顶栏 + 引导卡），实得 ' + mcp.add);
    }

    /* ---------- Skills 页 ---------- */
    log('\n=== Skills 页：市场状态条同步按钮去重 ===');
    await ev(`location.hash = '#/skills/manager'; 1`);
    await sleep(1500);
    await ev(`(() => { State.skmg.tab='market'; render({paintOnly:true}); return 1; })()`);
    await sleep(900);

    const sk = await ev(`(() => {
      const all = Array.from(document.querySelectorAll('.content button'));
      const txt = all.map(b => (b.textContent||'').trim());
      const verbar = Array.from(document.querySelectorAll('.mcpc-verbar button')).map(b=>(b.textContent||'').trim());
      const head = Array.from(document.querySelectorAll('.pt-actions button')).map(b=>(b.textContent||'').trim());
     	return {
        syncAll: txt.filter(t => /同步/.test(t)).length,
        head,
        verbarSync: verbar.filter(t => /同步/.test(t)).length,
        verbarAll: verbar,
      };
    })()`);
    log('  顶栏：' + JSON.stringify(sk.head));
    log('  市场状态条：' + JSON.stringify(sk.verbarAll));
    ok(sk.head.some(t => t.includes('同步市场')), '顶栏「🔄 同步市场」还在');
    ok((sk.verbarSync || 0) === 0, '市场状态条里的「🔄 同步」已删除，实得 ' + sk.verbarSync);

    /* ---------- 详情弹窗 ---------- */
    log('\n=== Skills 详情弹窗：写操作去重 ===');
    await ev(`(() => { State.skmg.tab='installed'; render({paintOnly:true}); return 1; })()`);
    await sleep(600);
    /* ⚠ 这里**不要**为了拿个技能名去拉全量清单（GET /api/skmg）。
       那是插件全市场扫盘（实测 7.4s / 2.37MB，headless 下更慢），纯粹为了验证
       "弹窗底部有几个按钮" 而等它几十秒不划算 —— 本机用户库经常是空的，
       清单拉回来也可能是 0 项。改成直接问插件要一个已知技能名：
       market/status 的兄弟接口 /detail 才是弹窗真正的数据源。 */
    /* 已知存在于市场的技能名（带 vendor 前缀），拿它触发弹窗即可。 */
    const PROBE = 'addyosmani-agent-skills/api-and-interface-design';
    const probeName = await ev(`(async () => {
      const r = await fetch('/api/skmg/detail?name=' + encodeURIComponent(${JSON.stringify(PROBE)}));
      const j = await r.json();
      return j && j.error ? '' : (j.name || '');
    })()`, 30000);
    const first = probeName || await ev(`(() => {
      const l = (State.skmg.list && State.skmg.list.installed) || [];
      if (l.length) return l[0].name;
      const m = (State.skmg.list && State.skmg.list.market) || [];
      return m.length ? m[0].name : '';
    })()`);
    if (first) {
      await ev(`skmgDetail(${JSON.stringify(first)}); 1`);
      await sleep(1400);
      const modal = await ev(`(() => {
        const m = document.getElementById('skmgdetail');
        if (!m) return { open: false };
        const acts = Array.from(m.querySelectorAll('.modal-actions button')).map(b=>(b.textContent||'').trim());
        return {
          open: true,
          acts,
          hasDelete: !!m.querySelector('.modal-actions button.danger'),
          bodyHasContent: /SKILL\.md|正文预览|依赖文件|版本|路径/.test(m.textContent||''),
        };
      })()`);
      ok(modal.open, '详情弹窗能打开');
      ok(modal.bodyHasContent, '弹窗正文照常展示（SKILL.md 元数据 / 预览）');
      ok(!modal.hasDelete, '弹窗底部已无删除按钮');
      ok(modal.acts.length === 1 && modal.acts[0].includes('关闭'), '弹窗底部只剩「关闭」，实得 ' + JSON.stringify(modal.acts));
      await ev(`(() => { const m = document.getElementById('skmgdetail'); if (m) m.remove(); return 1; })()`);
    } else {
      log('  （DSH 用户库为空，跳过弹窗断言）');
    }

    /* ---------- 卡片行能力没丢 ---------- */
    log('\n=== 卡片行能力保留 ===');
    const row = await ev(`(() => {
      State.skmg.tab='installed'; render({paintOnly:true});
      const cards = Array.from(document.querySelectorAll('.mcpc-card'));
      return cards.length ? Array.from(cards[0].querySelectorAll('button')).map(b=>(b.textContent||'').trim()) : [];
    })()`);
    log('  已安装卡按钮：' + JSON.stringify(row));
    if (row.length) {
      ok(row.some(t => t.includes('详情')), '卡片行仍有「详情」');
      ok(row.some(t => /删除/.test(t)), '卡片行仍有「删除」');
    }

    /* ---------- 无异常 ---------- */
    log('\n=== 无 JS 异常 ===');
    const errs = await ev(`(window.__errs || []).length`);
    ok((errs || 0) === 0, '页面无未捕获异常 — ' + (errs || 0));

    console.log('\nDONE fails=' + fail);
    process.exitCode = fail ? 1 : 0;
  } catch (e) {
    console.log('❌ 脚本异常：' + e.message);
    process.exitCode = 1;
  } finally {
    if (cdp) cdp.close();
    edge.kill();
    await sleep(300);
  }
}

main();
