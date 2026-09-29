/* 技能编排器 —— 端到端链路验收（真浏览器 + 真磁盘）
   覆盖 CDP 点击做不到的部分：拖拽连线、类型不匹配告警、真实导出 SKILL.md。
   用法：node tools/orch-e2e.mjs     依赖：控制台在 3081、本机 Edge。 */
import fs from 'fs';
import path from 'path';
import http from 'http';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const DIR = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const PORT = String(process.env.CONSOLE_PORT || 3081);
const EDGE = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe']
  .find(p => fs.existsSync(p));
if (!EDGE) { console.error('未找到 msedge.exe'); process.exit(1); }

const out = [];
let fail = 0, pass = 0;
const log = (s) => { out.push(s); console.log(s); };
const ok = (c, name, extra) => {
  if (c) { pass++; log('  ✅ ' + name + (extra ? ' — ' + extra : '')); }
  else { fail++; log('  ❌ ' + name + (extra ? ' — ' + extra : '')); }
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const DP = 9339;
const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=' + DP,
  '--user-data-dir=' + path.join(process.env.TEMP || '/tmp', 'edge-orch-e2e'), 'about:blank'], { stdio: 'ignore' });

async function cdpTargets() {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch('http://127.0.0.1:' + DP + '/json/list'); const l = await r.json(); if (l.length) return l; } catch {}
    await sleep(300);
  }
  throw new Error('CDP 未就绪');
}
function wsConnect(url) {
  return new Promise((res, rej) => {
    const u = new URL(url);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search,
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': Buffer.from('k' + Math.random()).toString('base64') } });
    req.on('upgrade', (r, s) => res(s)); req.on('error', rej); req.end();
  });
}
function mk(socket) {
  let buf = Buffer.alloc(0); const w = new Map();
  socket.on('data', d => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      if (buf.length < 2) return;
      const b1 = buf[1]; let len = b1 & 0x7f; let off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (buf.length < off + len) return;
      const p = buf.slice(off, off + len).toString('utf8'); buf = buf.slice(off + len);
      let m; try { m = JSON.parse(p); } catch { continue; }
      if (m.id && w.has(m.id)) { const f = w.get(m.id); w.delete(m.id); f(m); }
    }
  });
  let id = 1;
  return { send(method, params) {
    const mid = id++;
    const data = Buffer.from(JSON.stringify({ id: mid, method, params: params || {} }), 'utf8');
    const mask = Buffer.from([1, 2, 3, 4]); let h;
    if (data.length < 126) h = Buffer.from([0x81, 0x80 | data.length]);
    else if (data.length < 65536) { h = Buffer.alloc(4); h[0] = 0x81; h[1] = 0x80 | 126; h.writeUInt16BE(data.length, 2); }
    else { h = Buffer.alloc(10); h[0] = 0x81; h[1] = 0x80 | 127; h.writeBigUInt64BE(BigInt(data.length), 2); }
    const mm = Buffer.alloc(data.length);
    for (let i = 0; i < data.length; i++) mm[i] = data[i] ^ mask[i % 4];
    socket.write(Buffer.concat([h, mask, mm]));
    return new Promise(r => w.set(mid, r));
  } };
}

let client;
async function ev(e) {
  const r = await client.send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
  if (r.result && r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.text || 'eval error');
  return r.result && r.result.result ? r.result.result.value : undefined;
}
async function waitFor(expr, tries = 20, ms = 1000) {
  for (let i = 0; i < tries; i++) { const v = await ev(expr).catch(() => 0); if (v) return v; await sleep(ms); }
  return await ev(expr).catch(() => 0);
}

(async () => {
  const TESTCWD = path.join(process.env.USERPROFILE || process.env.HOME || '.', 'Desktop', 'dsh-orch-e2e');
  try {
    const t = await cdpTargets();
    const page = t.find(x => x.type === 'page') || t[0];
    client = mk(await wsConnect(page.webSocketDebuggerUrl));
    await client.send('Page.enable'); await client.send('Runtime.enable');
    await client.send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/#/skills/manager' });
    await waitFor(`document.querySelectorAll('.mcpc-tab').length`, 30);
    await ev(`(()=>{const b=Array.from(document.querySelectorAll('.mcpc-tab')).find(x=>x.textContent.includes('编排'));if(b)b.click();return 1})()`);
    await waitFor(`document.querySelectorAll('.orch-pool-item').length`, 20);

    log('=== 一、建立两个节点并连线（拖拽连线的等价调用）===');
    // 用一个假的会话 cwd，确保导出落到测试目录
    await ev(`(()=>{const s=(State.sessions||[]).find(x=>x.sessionId===State.sessionId);
      if(s)s.cwd=${JSON.stringify(TESTCWD)};return s?s.cwd:''})()`);
    const cwdSet = await ev(`(currentSession()||{}).cwd||''`);
    ok(cwdSet === TESTCWD, '会话 cwd 指向测试目录', cwdSet);

    await ev(`State.orch.nodes=[];State.orch.edges=[];State.orch.name='e2e-orch';State.orch.title='端到端测试';State.orch.description='先加数据再渲染点位。';State.orch.sel=null;render({paintOnly:true})`);
    await ev(`orchAddTool('add_data','__json__','geoscenepro','add_data')`);
    await waitFor(`document.querySelectorAll('.orch-arg').length`, 15);
    await ev(`orchAddTool('render_point','__json__','geoscenepro','render_point')`);
    await sleep(2500);
    const n2 = await ev(`State.orch.nodes.length`);
    ok(n2 === 2, '两个节点已建立', n2 + ' 个');
    const schemas = await ev(`State.orch.nodes.map(n=>({t:n.tool,hasSchema:!!n.inputSchema,req:(n.inputSchema&&n.inputSchema.required||[]).length}))`);
    ok(schemas.every(s => s.hasSchema), '两个节点都拿到了真实 inputSchema', JSON.stringify(schemas));

    await ev(`orchLink(State.orch.nodes[0].id, State.orch.nodes[1].id)`);
    await sleep(400);
    const ew = await ev(`State.orch.edges.length`);
    ok(ew === 1, '连线已建立', ew + ' 条');
    // 每条连线渲染 2 个 path：可见线 + 悬停命中区（.orch-wire-hit，2px 的线指不到）
    const wires = await ev(`document.querySelectorAll('#orchwires path.orch-wire').length`);
    const hits = await ev(`document.querySelectorAll('#orchwires path.orch-wire-hit').length`);
    ok(wires === 1, '画布上画出了一条连线', wires + ' 条');
    ok(hits === 1, '连线上叠了悬停命中区（title 里写匹配详情）', hits + ' 条');
    // 连线后下游"尚未设来源"的必填项应被自动绑到上游（否则画了线却什么都没接）
    const autoBound = await ev(`State.orch.nodes[1].args && Object.values(State.orch.nodes[1].args).some(a=>a.source==='upstream')`);
    ok(autoBound, '连线后下游必填参数自动绑到上游输出');

    log('\n=== 二、必填未填 → 校验器应报错 ===');
    // 先把自动绑定清掉，还原"什么都还没填"的状态
    await ev(`(()=>{for(const n of State.orch.nodes)n.args={};State.orch.edges=[];render({paintOnly:true});return 1})()`);
    await sleep(300);
    let C = JSON.parse(await ev(`JSON.stringify(orchValidate(State.orch.nodes,State.orch.edges))`));
    ok(C.errors.length > 0, '缺必填参数被识别为错误', C.errors.length + ' 条：' + C.errors.slice(0, 2).join(' / '));

    log('\n=== 二·补、参数名拼错 → 应报错 ===');
    await ev(`(()=>{State.orch.nodes[0].args={path:{source:'runtime'},layername_:{source:'runtime'}};render({paintOnly:true});return 1})()`);
    C = JSON.parse(await ev(`JSON.stringify(orchValidate(State.orch.nodes,State.orch.edges))`));
    ok(C.errors.some(e => /没有参数/.test(e)), '拼错的参数名被识别', C.errors.find(e => /没有参数/.test(e)) || '（未命中）');

    log('\n=== 三、类型不匹配 → 应报错 ===');
    // add_data 的输出 schema 没声明 → 用 outputSchema 显式造一个 string 字段，接到要 number 的 size 上
    await ev(`(()=>{
      State.orch.nodes[0].outputSchema={type:'object',properties:{layerName:{type:'string'}}};
      const n=State.orch.nodes[1];const sc=orchSchemaOf(n);
      const numKey=Object.keys(sc.props).find(k=>orchTypeOf(sc.props[k])==='number');
      if(numKey)n.args[numKey]={source:'upstream',fromNode:State.orch.nodes[0].id,fromField:'layerName'};
      render({paintOnly:true});return numKey})()`);
    C = JSON.parse(await ev(`JSON.stringify(orchValidate(State.orch.nodes,State.orch.edges))`));
    const typeMsg = C.errors.find(e => /类型不匹配/.test(e)) || C.warns.find(w => /类型/.test(w));
    ok(!!typeMsg, 'string → number 被识别（直接类型不匹配时应报错）', typeMsg || '（未命中）');

    log('\n=== 四、成环 → 应报错 ===');
    // orchLink 会拦住"反向连线"（那是正确行为）—— 所以这里直接构造状态，
    // 模拟"从草稿文件里读进来一份本来就有环的编排"：a→b 与 b→a 同时存在。
    await ev(`State.orch.edges=[{from:State.orch.nodes[0].id,to:State.orch.nodes[1].id},{from:State.orch.nodes[1].id,to:State.orch.nodes[0].id}];render({paintOnly:true})`);
    await sleep(300);
    const edgeNow = await ev(`State.orch.edges.length`);
    ok(edgeNow === 2, '已构造出互指的两条边（真环）', edgeNow + ' 条');
    C = JSON.parse(await ev(`JSON.stringify(orchValidate(State.orch.nodes,State.orch.edges))`));
    ok(C.errors.some(e => /成环/.test(e)), '已存的环被识别', C.errors.find(e => /成环/.test(e)) || '（未命中）');
    // 另外验证 orchLink 拦得住"当场造环"
    const cyc = await ev(`(()=>{const before=State.orch.edges.length;orchLink(State.orch.nodes[1].id,State.orch.nodes[0].id);return State.orch.edges.length-before})()`);
    ok(cyc === 0, 'orchLink 拒绝当场造环（反向连线）', '新增 ' + cyc + ' 条');
    // 拆掉环，恢复干净状态
    await ev(`State.orch.edges=[{from:State.orch.nodes[0].id,to:State.orch.nodes[1].id}];render({paintOnly:true})`);

    log('\n=== 五、把参数都设成运行时输入 → 校验应通过 ===');
    // 清掉前面几节留下的 args（含故意拼错的那个键），从干净状态重设
    await ev(`(()=>{for(const n of State.orch.nodes)n.args={};State.orch.edges=[];render({paintOnly:true});return 1})()`);
    await sleep(300);
    await ev(`(()=>{for(const n of State.orch.nodes){const sc=orchSchemaOf(n);for(const r of sc.required)n.args[r]={source:'runtime'};}render({paintOnly:true});return 1})()`);
    C = JSON.parse(await ev(`JSON.stringify(orchValidate(State.orch.nodes,State.orch.edges))`));
    ok(C.errors.length === 0, '全部必填补齐后无错误', C.errors.length ? C.errors.join(' / ') : '0 错误');

    log('\n=== 五·补、上游引用关系要写进正文 ===');
    // 重新把连线接上并让 render_point 的一个参数取上游输出
    await ev(`orchLink(State.orch.nodes[0].id, State.orch.nodes[1].id)`);
    await sleep(300);
    const upstreamArgs = await ev(`Object.values(State.orch.nodes[1].args||{}).filter(a=>a.source==='upstream').length`);
    ok(upstreamArgs > 0, '下游有参数取自上游', upstreamArgs + ' 个');

    log('\n=== 六、真导出：写盘 + 内容核对 ===');
    await ev(`orchExport()`);
    await sleep(2500);
    const exported = await ev(`JSON.stringify({name:State.orch.name})`);
    const en = JSON.parse(exported).name;
    const skillFile = path.join(TESTCWD, '.dsh', 'skills', en, 'SKILL.md');
    ok(fs.existsSync(skillFile), 'SKILL.md 已写入磁盘', skillFile);
    if (fs.existsSync(skillFile)) {
      const md = fs.readFileSync(skillFile, 'utf8');
      ok(/^---\r?\n/.test(md), 'frontmatter 存在');
      const nm = (md.match(/^name:\s*(.+)$/m) || [])[1];
      ok(nm === en, 'frontmatter name 与目录名一致', nm);
      ok(/^description:\s*\S/m.test(md), 'description 已写入（DSH 必填）');
      ok(/## 编排步骤/.test(md), '正文含「编排步骤」章节');
      ok(/add_data/.test(md) && /render_point/.test(md), '正文列出了两个工具');
      ok(/步骤 1/.test(md), '正文写出了步骤间引用关系');
      const orchJson = path.join(TESTCWD, '.dsh', 'skills', en, 'orchestration.json');
      ok(fs.existsSync(orchJson), 'orchestration.json 一并写入（可再编辑）');
    }
    const draft = path.join(TESTCWD, '.dsh', 'orchestrations', 'e2e-orch.json');
    ok(fs.existsSync(draft), '草稿也在 orchestrations/ 下（导出时自动存）', draft);

  } catch (e) {
    fail++; log('  ❌ 执行异常 — ' + e.message + '\n' + (e.stack || ''));
  } finally {
    log('\nDONE fails=' + fail + ' pass=' + pass);
    fs.writeFileSync(path.join(DIR, 'tools', 'orch-e2e-out.txt'), out.join('\n'));
    try { proc.kill(); } catch {}
    process.exit(fail ? 1 : 0);
  }
})();
