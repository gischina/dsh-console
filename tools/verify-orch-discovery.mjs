/* 验证「导出的 SKILL.md 能否被 DSH 发现」—— 走真实 DSH，不猜。
   用法：node tools/verify-orch-discovery.mjs [cwd]
   做法：① 看控制台 /api/local/skills 扫到的根目录里有没有导出的技能；
        ② 走 DSH 的 skills/list，看它自己认不认（这才是权威）。 */
import fs from 'fs';
import path from 'path';
import http from 'http';
import { fileURLToPath } from 'url';

const DIR = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const PORT = String(process.env.CONSOLE_PORT || 3081);
const CWD = process.argv[2] || path.join(process.env.USERPROFILE || process.env.HOME || '.', 'Desktop', 'dsh-orch-e2e');

let fail = 0, pass = 0;
const ok = (c, n, e) => { if (c) { pass++; console.log('  ✅ ' + n + (e ? ' — ' + e : '')); } else { fail++; console.log('  ❌ ' + n + (e ? ' — ' + e : '')); } };

/* ---- ① 控制台视角：/api/local/skills ---- */
const r1 = await fetch(`http://127.0.0.1:${PORT}/api/local/skills?cwd=` + encodeURIComponent(CWD)).then(r => r.json()).catch(e => ({ error: e.message }));
console.log('=== ① 控制台扫描（/api/local/skills）===');
if (r1.error) { ok(false, '接口可用', r1.error); }
else {
  const proj = (r1.roots || []).find(x => x.scope === 'project');
  ok(!!proj, '识别出项目级技能根', proj ? proj.path : '—');
  ok(fs.existsSync((proj || {}).path || ''), '该根目录真实存在', (proj || {}).path);
  const found = (r1.skills || []).filter(s => s.scope === 'project');
  ok(found.length > 0, '项目级扫到了技能', found.map(s => s.name).join(', ') || '（无）');
  const mine = found.find(s => s.name === 'e2e-orch');
  ok(!!mine, '扫到了编排导出的 e2e-orch');
  if (mine) console.log('       file =', mine.file, '·', mine.bytes, 'bytes');
}

/* ---- ② DSH 权威视角：skills/list ---- */
console.log('\n=== ② DSH 权威视角（skills/list）===');
const cfgPath = path.join(DIR, 'dsh-config.json');
if (!fs.existsSync(cfgPath)) { ok(false, '能读到 dsh-config.json'); }
else {
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const u = new URL(cfg.origin);
  const get = (p, opts = {}) => new Promise((res, rej) => {
    const req = http.request({ hostname: u.hostname, port: u.port, path: p, method: opts.method || 'GET', headers: opts.headers || {} },
      r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res({ status: r.statusCode, headers: r.headers, body: d })); });
    req.on('error', rej); if (opts.body) req.write(opts.body); req.end();
  });
  const ex = await get('/?token=' + encodeURIComponent(cfg.token));
  const sc = String(ex.headers['set-cookie'] || '');
  const m = sc.match(/(dsh-auth-[^=;]+)=([^;]+)/);
  if (!m) { ok(false, '令牌换取会话 cookie', 'HTTP ' + ex.status); }
  else {
    ok(true, '令牌换取会话 cookie');
    const cookie = m[1] + '=' + m[2];
    /* 找一个 cwd 落在测试目录（或其父）的会话；没有就用第一个会话 ——
       skills/list 按会话 cwd 决定扫哪些项目根。 */
    const lbody = JSON.stringify({ type: 'client-request', rpcId: 'l1', method: 'session/list', payload: { args: { _request: {} } } });
    const lr = await get('/api/session/list', { method: 'POST', headers: { 'content-type': 'application/json', cookie, 'content-length': Buffer.byteLength(lbody) }, body: lbody });
    let sessions = [];
    try { sessions = JSON.parse(lr.body).result.value.items || []; } catch {}
    ok(sessions.length > 0, '拿到会话列表', sessions.length + ' 个');
    const target = sessions.find(s => String(s.cwd || '').toLowerCase().replace(/[\\/]+/g, '\\') === CWD.toLowerCase()) || sessions[0];
    console.log('       用会话 cwd =', target && target.cwd);
    if (target) {
      const sbody = JSON.stringify({ type: 'client-request', rpcId: 's1', method: 'skills/list', payload: { args: { request: { sessionId: target.sessionId } } } });
      const sr = await get('/api/skills/list', { method: 'POST', headers: { 'content-type': 'application/json', cookie, 'content-length': Buffer.byteLength(sbody) }, body: sbody });
      let skills = [];
      try {
        const j = JSON.parse(sr.body);
        skills = (j.result && j.result.value && (j.result.value.skills || j.result.value.items)) || [];
      } catch (e) { console.log('       raw:', sr.body.slice(0, 200)); }
      ok(Array.isArray(skills), 'skills/list 返回技能数组', skills.length + ' 个');
      if (skills.length) console.log('       DSH 列出的技能：' + skills.map(s => s.name).join(', ').slice(0, 300));

      /* 决定性判据：会话 cwd 必须真的落在导出的那个目录上，否则 skills/list
         查的是别的项目根，看到的空列表不能说明任何问题。 */
      const sameCwd = target.cwd && path.resolve(target.cwd) === path.resolve(CWD);
      if (sameCwd) {
        const hit = skills.find(s => (s.name || '') === 'e2e-orch');
        ok(!!hit, '★ DSH 认出了编排导出的技能（skills/list 权威结果）', hit ? JSON.stringify(hit) : '未出现');
      } else {
        console.log('       ⚠ 没有 cwd 指向 ' + CWD + ' 的会话 —— DSH 权威判据未跑到。');
        console.log('         要拿到决定性证据，先建一个 cwd 在该目录的会话：');
        console.log('         （tools/orch-e2e.mjs 已覆盖「画→导出」链路；此处只核对落盘位置）');
        ok(fs.existsSync(path.join(CWD, '.dsh', 'skills', 'e2e-orch', 'SKILL.md')),
          '技能落在 DSH 规则认定的路径上（无 .git → cwd 即项目根）',
          path.join(CWD, '.dsh', 'skills', 'e2e-orch', 'SKILL.md'));
      }
    }
  }
}

console.log('\nDONE fails=' + fail + ' pass=' + pass);
process.exit(fail ? 1 : 0);
