/* CDP 回归：输入框三问题（2026-09-29 修复后应为全绿）
 * 1. 焦点保持：无 id 的 oninput 搜索框重绘后焦点/光标要回到原框（render 按序号兜底）
 * 2. autocomplete=off：MutationObserver 给一切新输入框补齐，历史下拉不再出现
 * 3. select 自绘：appearance:none + chevron；color-scheme 跟随主题
 * 顺带截图市场页签 + 编排页签，供样式目检。
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const PORT = process.env.CONSOLE_PORT || 3081;
const BASE = 'http://127.0.0.1:' + PORT;
const CDP_PORT = Number(process.env.CDP_PORT) || 9361;
const EDGE = process.env.EDGE_BIN
  || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
/* 截图输出目录：默认系统临时目录，可用 SHOT_DIR 覆盖。别写死本机路径。 */
const OUT = process.env.SHOT_DIR || path.join(os.tmpdir(), 'dsh-console-shots');
fs.mkdirSync(OUT, { recursive: true });

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✅ ' + m); } else { fail++; console.log('  ❌ ' + m); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const getJson = u => new Promise((res, rej) => { http.get(u, r => { let b = ''; r.on('data', d => b += d); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); }).on('error', rej); });
function mkClient(wsUrl) {
  const url = new URL(wsUrl);
  return new Promise((resolve, reject) => {
    const key = Buffer.from('d' + Math.random()).toString('base64').slice(0, 16);
    const req = http.request({ host: url.hostname, port: url.port, path: url.pathname + url.search, headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13' } });
    req.on('upgrade', (res, socket) => {
      let buf = Buffer.alloc(0); const w = new Map(); let id = 0;
      socket.on('data', chunk => {
        buf = Buffer.concat([buf, chunk]);
        while (buf.length >= 2) {
          const len = buf[1] & 0x7f; let off = 2, pl = len;
          if (len === 126) { if (buf.length < 4) break; pl = buf.readUInt16BE(2); off = 4; }
          else if (len === 127) { if (buf.length < 10) break; pl = Number(buf.readBigUInt64BE(2)); off = 10; }
          if (buf.length < off + pl) break;
          const p = buf.slice(off, off + pl).toString(); buf = buf.slice(off + pl);
          let m; try { m = JSON.parse(p); } catch { continue; }
          if (m.id && w.has(m.id)) { w.get(m.id)(m); w.delete(m.id); }
        }
      });
      const send = (method, params) => new Promise(res => {
        const mid = ++id; w.set(mid, res);
        const body = Buffer.from(JSON.stringify({ id: mid, method, params: params || {} }));
        const mask = Buffer.from([0, 0, 0, 0]); let h;
        if (body.length < 126) h = Buffer.from([0x81, 0x80 | body.length]);
        else if (body.length < 65536) { h = Buffer.alloc(4); h[0] = 0x81; h[1] = 0xFE; h.writeUInt16BE(body.length, 2); }
        else { h = Buffer.alloc(10); h[0] = 0x81; h[1] = 0xFF; h.writeBigUInt64BE(BigInt(body.length), 2); }
        socket.write(Buffer.concat([h, mask, body]));
      });
      resolve({ send, close: () => socket.destroy() });
    });
    req.on('error', reject); req.end();
  });
}

async function main() {
  const edge = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', `--remote-debugging-port=${CDP_PORT}`, '--user-data-dir=' + path.join(ROOT, '.cdp-input'), 'about:blank'], { stdio: 'ignore' });
  let cdp = null;
  try {
    let tabs = null;
    for (let i = 0; i < 40; i++) { await sleep(400); try { tabs = await getJson(`http://127.0.0.1:${CDP_PORT}/json/list`); } catch { continue; } if (tabs && tabs.length) break; }
    const page = (tabs || []).find(t => t.type === 'page');
    cdp = await mkClient(page.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
    const ev = async (e, t = 12000) => {
      const r = await Promise.race([cdp.send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }), sleep(t).then(() => ({ __t: 1 }))]);
      if (r.__t) throw new Error('timeout: ' + e.slice(0, 60));
      return r.result && r.result.result ? r.result.result.value : undefined;
    };
    const shot = async (name) => {
      const r = await Promise.race([cdp.send('Page.captureScreenshot', { format: 'png' }), sleep(15000).then(() => ({ __t: 1 }))]);
      const data = r && r.result && r.result.data;
      if (!data) { console.log('  ⚠ 截图失败：' + name); return; }
      fs.writeFileSync(path.join(OUT, name), Buffer.from(data, 'base64'));
      console.log('  📷 ' + path.join(OUT, name));
    };

    await cdp.send('Page.navigate', { url: BASE + '/' });
    for (let i = 0; i < 60; i++) { await sleep(300); if (await ev('typeof State')) break; }

    /* ---------- 1. 焦点保持：Skills 市场搜索框 ---------- */
    console.log('\n=== 焦点保持：Skills 市场搜索框 ===');
    await ev(`location.hash='#/skills/manager';1`);
    /* 探测（/api/skmg-status）通常 ~0.5s，但负载高时会慢；available===null 时
       插件页签只画"正在探测"骨架，没有输入框。等它落定，超时就直接放行（测试不依赖真探测）。 */
    for (let i = 0; i < 30; i++) {
      if (await ev('State.skmg.available !== null')) break;
      await sleep(300);
    }
    await ev(`(()=>{ if (State.skmg.available === null) State.skmg.available = true; State.skmg.tab='market'; render({paintOnly:true}); return 1; })()`);
    await sleep(600);
    /* ⚠ 市场页签在 M.list 为空时只画"正在读取…"占位（清单接口 headless 下 ~30s）。
       焦点行为与数据无关 —— 直接造一份假清单渲染真骨架，专门测输入框。 */
    const seeded = await ev(`(()=>{
      if(State.skmg.list && State.skmg.list.market && State.skmg.list.market.length) return 'real';
      State.skmg.list={sources:[{source:'t1',skills:2,displayName:'t1'}],market:[
        {name:'t1/a',shortName:'a',description:'测试',source:'t1',keywords:[]},
        {name:'t1/b',shortName:'b',description:'测试',source:'t1',keywords:[]},
      ],installed:[]};
      render({paintOnly:true});
      return 'seeded';
    })()`);
    await sleep(400);
    console.log('  清单来源：' + seeded);
    /* 等搜索框出现（种子渲染是同步的，正常立即就有；兜底轮询防偶发时序） */
    let probe = { found: false };
    for (let i = 0; i < 10; i++) {
      probe = await ev(`(()=>{
        const inp=document.querySelector('input[placeholder^=\"搜索技能\"]');
        if(!inp) return {found:false};
        inp.focus();
        return {found:true, id:inp.id||'(无id)'};
      })()`);
      if (probe.found) break;
      await sleep(300);
    }
    ok(probe.found, '找到市场搜索框');
    if (!probe.found) { console.log('\nDONE fails=' + fail + '（搜索框未出现，提前结束）'); process.exitCode = 1; return; }
    console.log('  id：' + probe.id + '（无 id —— 正是以前必掉焦点的那类）');
    await ev(`(()=>{
      const inp=document.querySelector('input[placeholder^=\"搜索技能\"]');
      inp.focus();
      inp.value='ab';
      inp.dispatchEvent(new Event('input',{bubbles:true}));
      return 1;
    })()`);
    await sleep(500);
    const after = await ev(`(()=>{
      const inp=document.querySelector('input[placeholder^=\"搜索技能\"]');
      const a=document.activeElement;
      return {
        focused: a===inp,
        kw: State.skmg.kw,
        caret: (a===inp && typeof inp.selectionStart==='number') ? inp.selectionStart : -1,
      };
    })()`);
    ok(after.focused === true, '连续输入后焦点仍在原框（以前必掉）');
    ok(after.kw === 'ab', '关键词进 State：' + JSON.stringify(after.kw));
    ok(after.caret === 2, '光标位置恢复到输入处（selectionStart=2），实得 ' + after.caret);
    // 再输一个字验证"连续输入"
    await ev(`(()=>{
      const inp=document.querySelector('input[placeholder^=\"搜索技能\"]');
      inp.value=inp.value+'c';
      inp.dispatchEvent(new Event('input',{bubbles:true}));
      return 1;
    })()`);
    await sleep(500);
    const after2 = await ev(`(()=>({focused:document.activeElement===document.querySelector('input[placeholder^=\"搜索技能\"]'), kw:State.skmg.kw}))()`);
    ok(after2.focused === true && after2.kw === 'abc', '第二个字仍能连续输入（kw=abc）');
    await shot('input-fix-market.png');

    /* ---------- 1b. 编排参数框（无 id + oninput 重绘） ---------- */
    console.log('\n=== 焦点保持：编排 输入/输出声明框 ===');
    await ev(`(()=>{State.skmg.tab='orch';render({paintOnly:true});return 1})()`);
    await sleep(900);
    const orchSeed = await ev(`(()=>{
      const O=State.orch;
      if(!O.nodes.length){
        O.nodes.push({id:'n1',kind:'skill',tool:'demo-skill',title:'演示技能',inputSchema:null,args:{},x:60,y:40,inDecl:'',outDecl:''});
        O.sel='n1';
        render({paintOnly:true});
        return 'seeded';
      }
      return 'exists';
    })()`);
    await sleep(400);
    console.log('  节点：' + orchSeed);
    const decl = await ev(`(()=>{
      const inp=document.querySelector('input[placeholder^=\"该技能接受什么输入\"]');
      if(!inp) return {found:false};
      inp.focus();
      inp.value='图层名';
      inp.dispatchEvent(new Event('input',{bubbles:true}));
      return {found:true};
    })()`);
    if (decl.found) {
      await sleep(500);
      const d2 = await ev(`(()=>{
        const inp=document.querySelector('input[placeholder^=\"该技能接受什么输入\"]');
        return {focused:document.activeElement===inp, val:(State.orch.nodes.find(n=>n.id==='n1')||{}).inDecl};
      })()`);
      ok(d2.focused === true, '声明框重绘后焦点仍在（以前必掉）');
      ok(d2.val === '图层名', '值进 State：' + JSON.stringify(d2.val));
    } else {
      console.log('  （未找到声明框 —— 节点参数面板未展开，跳过）');
    }

    /* ---------- 2. autocomplete=off 全覆盖 ---------- */
    console.log('\n=== autocomplete=off 全覆盖 ===');
    const ac = await ev(`(()=>{
      const all=Array.from(document.querySelectorAll('input,textarea'));
      const off=all.filter(i=>i.getAttribute('autocomplete')==='off');
      return {total:all.length, off:off.length, missing:all.filter(i=>i.getAttribute('autocomplete')!=='off').map(i=>i.placeholder||i.id||i.type).slice(0,5)};
    })()`);
    ok(ac.total > 0 && ac.off === ac.total, '当前页 input/textarea 全部 autocomplete=off（' + ac.off + '/' + ac.total + '）' + (ac.missing.length ? ' 缺失:' + JSON.stringify(ac.missing) : ''));
    // 弹窗里的输入框也要覆盖到
    await ev(`(()=>{ UI.prompt({title:'测试', message:'x'}).catch(()=>0); return 1; })()`);
    await sleep(400);
    const acModal = await ev(`(()=>{
      const m=document.querySelector('.modal-mask');
      if(!m) return {found:false};
      const all=Array.from(m.querySelectorAll('input,textarea'));
      return {found:true, total:all.length, off:all.filter(i=>i.getAttribute('autocomplete')==='off').length};
    })()`);
    if (acModal.found) {
      ok(acModal.total > 0 && acModal.off === acModal.total, '模态框输入框同样覆盖（' + acModal.off + '/' + acModal.total + '）');
      await ev(`(()=>{const m=document.querySelector('.modal-mask'); if(m) m.remove(); return 1;})()`);
    } else {
      console.log('  （UI.prompt 未弹出，跳过弹窗断言）');
    }

    /* ---------- 3. select 自绘 + color-scheme ---------- */
    console.log('\n=== select 样式统一 ===');
    await ev(`(()=>{State.skmg.tab='orch';render({paintOnly:true});return 1})()`);
    await sleep(600);
    const st = await ev(`(()=>{
      const g=(el,p)=>getComputedStyle(el)[p];
      const sel=document.querySelector('select');
      if(!sel) return {found:false};
      return {
        found:true,
        appearance:g(sel,'appearance'),
        bgImage:(g(sel,'backgroundImage')||'').slice(0,60),
        colorScheme:g(sel,'colorScheme'),
        padRight:g(sel,'paddingRight'),
        cursor:g(sel,'cursor'),
      };
    })()`);
    if (st.found) {
      ok(st.appearance === 'none', 'select appearance=none（原生箭头已去掉），实得 ' + st.appearance);
      ok(/svg/.test(st.bgImage), '自绘 chevron 已挂上（background-image 含 svg）');
      ok(/dark/i.test(st.colorScheme), 'color-scheme=dark（原生弹层跟随主题），实得 ' + st.colorScheme);
      console.log('  paddingRight=' + st.padRight + ' cursor=' + st.cursor);
    } else {
      console.log('  （当前页没有 select，跳过）');
    }
    // 浅色主题下 chevron 仍在
    await ev(`(()=>{document.documentElement.setAttribute('data-theme','light');return 1})()`);
    await sleep(400);
    const stL = await ev(`(()=>{
      const sel=document.querySelector('select');
      return sel ? {img:(getComputedStyle(sel).backgroundImage||'').slice(0,60), bg:getComputedStyle(sel).backgroundColor} : {img:'-'};
    })()`);
    if (stL.img !== '-') {
      ok(/svg/.test(stL.img), '浅色主题下 chevron 仍在（background-color 补丁没清掉 image）');
      ok(stL.bg === 'rgb(241, 245, 252)', '浅色主题输入底色生效，实得 ' + stL.bg);
    }
    await ev(`(()=>{document.documentElement.setAttribute('data-theme','dark');return 1})()`);
    await sleep(300);
    await shot('input-fix-orch.png');

    console.log('\nDONE fails=' + fail);
    process.exitCode = fail ? 1 : 0;
  } catch (e) {
    console.log('❌ ' + e.message);
    process.exitCode = 1;
  } finally {
    if (cdp) cdp.close();
    edge.kill();
    await sleep(300);
  }
}
main();
