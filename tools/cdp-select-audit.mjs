/* CDP 取证：Skills 管理 + MCP 服务 两个模块里**所有 select 下拉框**的实际样式
 * 目的：逐个列出宽高/内边距/字体/背景/箭头位置，找出"不对"的那些。
 * 同时把每个 select 所在的上下文（父容器 class、第几个）打出来，便于定位代码。
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
const CDP_PORT = Number(process.env.CDP_PORT) || 9371;
const EDGE = process.env.EDGE_BIN
  || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const OUT = process.env.SHOT_DIR || path.join(os.tmpdir(), 'dsh-console-shots');
fs.mkdirSync(OUT, { recursive: true });

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

const DUMP = `(() => {
  const g = (el, p) => getComputedStyle(el)[p];
  const where = (el) => {
    const parts = [];
    let n = el, hops = 0;
    while (n && n !== document.body && hops < 6) {
      if (n.className && typeof n.className === 'string') parts.push(n.className.trim().split(/\\s+/)[0]);
      n = n.parentElement; hops++;
    }
    return parts.join(' < ');
  };
  return Array.from(document.querySelectorAll('select')).map((s, i) => {
    const r = s.getBoundingClientRect();
    return {
      i,
      cls: s.className || '(无class)',
      where: where(s),
      opts: s.options.length,
      val: (s.value || '').slice(0, 22),
      w: Math.round(r.width), h: Math.round(r.height),
      pad: g(s, 'paddingTop') + ' ' + g(s, 'paddingRight') + ' ' + g(s, 'paddingBottom') + ' ' + g(s, 'paddingLeft'),
      font: g(s, 'fontSize'),
      bgColor: g(s, 'backgroundColor'),
      hasImg: /svg/.test(g(s, 'backgroundImage') || ''),
      imgPos: g(s, 'backgroundPosition'),
      radius: g(s, 'borderRadius'),
      border: g(s, 'borderColor'),
      appear: g(s, 'appearance'),
      visible: r.width > 0 && r.height > 0,
    };
  });
})()`;

async function main() {
  const edge = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', `--remote-debugging-port=${CDP_PORT}`, '--user-data-dir=' + path.join(ROOT, '.cdp-sel'), 'about:blank'], { stdio: 'ignore' });
  let cdp = null;
  try {
    let tabs = null;
    for (let i = 0; i < 40; i++) { await sleep(400); try { tabs = await getJson(`http://127.0.0.1:${CDP_PORT}/json/list`); } catch { continue; } if (tabs && tabs.length) break; }
    const page = (tabs || []).find(t => t.type === 'page');
    cdp = await mkClient(page.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
    const ev = async (e, t = 15000) => {
      const r = await Promise.race([cdp.send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }), sleep(t).then(() => ({ __t: 1 }))]);
      if (r.__t) throw new Error('timeout: ' + e.slice(0, 60));
      return r.result && r.result.result ? r.result.result.value : undefined;
    };
    const shot = async (name) => {
      const r = await Promise.race([cdp.send('Page.captureScreenshot', { format: 'png' }), sleep(15000).then(() => ({ __t: 1 }))]);
      const d = r && r.result && r.result.data;
      if (d) { fs.writeFileSync(path.join(OUT, name), Buffer.from(d, 'base64')); console.log('  📷 ' + name); }
    };

    await cdp.send('Page.navigate', { url: BASE + '/' });
    for (let i = 0; i < 60; i++) { await sleep(300); if (await ev('typeof State')) break; }

    const report = async (label, setup) => {
      console.log('\n████ ' + label);
      await ev(setup);
      await sleep(1400);
      const rows = await ev(DUMP);
      if (!rows || !rows.length) { console.log('  （本页没有 select）'); return; }
      for (const r of rows) {
        console.log('  [' + r.i + '] .' + r.cls + '  ' + r.w + 'x' + r.h + '  opt=' + r.opts + '  visible=' + r.visible);
        console.log('       上下文: ' + r.where);
        console.log('       pad=' + r.pad + ' font=' + r.font + ' radius=' + r.radius);
        console.log('       bg=' + r.bgColor + ' 自绘箭头=' + r.hasImg + ' pos=' + r.imgPos + ' appearance=' + r.appear);
      }
    };

    /* ---------- Skills 管理：5 个页签 ---------- */
    for (const t of ['installed', 'market', 'exec', 'local', 'orch']) {
      await report('Skills · ' + t, `location.hash='#/skills/manager';
        (()=>{ if(State.skmg.available===null) State.skmg.available=true;
               State.skmg.tab='${t}';
               if(!State.skmg.list) State.skmg.list={sources:[{source:'t1',skills:2,displayName:'t1'}],market:[{name:'t1/a',shortName:'a',description:'x',source:'t1',keywords:[]}],installed:[{name:'demo',description:'d',tokens:10,chars:40,fileCount:1,totalSize:100}]};
               if(!State.skmg.execs) State.skmg.execs=[{key:'dsh',label:'DSH',dir:'~/.dsh/skills',skills:2,count:2}];
               if(!State.orch.nodes.length) State.orch.nodes.push({id:'n1',kind:'skill',tool:'demo',title:'演示',inputSchema:null,args:{},x:60,y:40,inDecl:'',outDecl:''});
               State.orch.sel='n1';
               render({paintOnly:true}); return 1; })()`);
    }
    await ev(`location.hash='#/skills/manager';(()=>{State.skmg.tab='orch';render({paintOnly:true});return 1})()`);
    await sleep(800);
    await shot('sel-skills-orch.png');

    /* ---------- MCP 服务：4 个页签 ---------- */
    for (const t of ['conn', 'market', 'tools', 'local']) {
      await report('MCP · ' + t, `location.hash='#/mcp/manager';
        (()=>{ State.mcpc.tab='${t}'; render({paintOnly:true}); return 1; })()`);
    }

    console.log('\nDONE');
  } catch (e) {
    console.log('❌ ' + e.message);
  } finally {
    if (cdp) cdp.close();
    edge.kill();
    await sleep(300);
  }
}
main();
