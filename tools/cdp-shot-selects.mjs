/* CDP 目检：MCP 工具页下拉 + 浅色主题下两模块的下拉/输入框 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const PORT = process.env.CONSOLE_PORT || 3081;
const BASE = 'http://127.0.0.1:' + PORT;
const CDP_PORT = Number(process.env.CDP_PORT) || 9373;
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

async function main() {
  const edge = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', `--remote-debugging-port=${CDP_PORT}`, '--user-data-dir=' + path.join(ROOT, '.cdp-shot2'), 'about:blank'], { stdio: 'ignore' });
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
      if (r.__t) throw new Error('timeout');
      return r.result && r.result.result ? r.result.result.value : undefined;
    };
    const shot = async (name) => {
      const r = await Promise.race([cdp.send('Page.captureScreenshot', { format: 'png' }), sleep(15000).then(() => ({ __t: 1 }))]);
      const d = r && r.result && r.result.data;
      if (d) { fs.writeFileSync(path.join(OUT, name), Buffer.from(d, 'base64')); console.log('📷 ' + name); }
    };
    await cdp.send('Page.navigate', { url: BASE + '/' });
    for (let i = 0; i < 60; i++) { await sleep(300); if (await ev('typeof State')) break; }

    /* MCP 工具页（真实连接数据）深色 */
    await ev(`location.hash='#/mcp/manager';(()=>{State.mcpc.tab='tools';render({paintOnly:true});return 1})()`);
    await sleep(2000);
    await shot('sel-mcp-tools-dark.png');

    /* 浅色主题：编排顶栏 + MCP 工具页
       ⚠ 不能只 setAttribute('data-theme')—— render() 里的 applyTheme() 会按
       State.settings 里的偏好把主题刷回去。走 setThemePrefLocal（只改本地 State，
       不发接口不落盘）+ applyTheme 才是真切换。 */
    await ev(`(()=>{ setThemePrefLocal('light'); applyTheme(); return 1; })()`);
    await sleep(500);
    await ev(`location.hash='#/skills/manager';(()=>{if(State.skmg.available===null)State.skmg.available=true;State.skmg.tab='orch';if(!State.orch.nodes.length)State.orch.nodes.push({id:'n1',kind:'skill',tool:'demo',title:'演示',inputSchema:null,args:{},x:60,y:40,inDecl:'',outDecl:''});State.orch.sel='n1';render({paintOnly:true});return 1})()`);
    await sleep(900);
    await shot('sel-skills-orch-light.png');

    await ev(`location.hash='#/mcp/manager';(()=>{State.mcpc.tab='tools';render({paintOnly:true});return 1})()`);
    await sleep(1500);
    await shot('sel-mcp-tools-light.png');
    /* 还原深色 */
    await ev(`(()=>{ setThemePrefLocal('dark'); applyTheme(); return 1; })()`);

    console.log('DONE');
  } catch (e) { console.log('❌ ' + e.message); }
  finally { if (cdp) cdp.close(); edge.kill(); await sleep(300); }
}
main();
