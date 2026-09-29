/* 技能编排后端接口自测：直接打控制台的 /api/local/orch 与 /api/local/orch/export。
   用法：node tools/probe-orch-api.mjs [cwd]
   前置：console 跑在 3081（CONSOLE_PORT 可覆盖）。 */
const PORT = process.env.CONSOLE_PORT || 3081;
const BASE = `http://127.0.0.1:${PORT}`;
const CWD = process.argv[2] || process.env.DSH_SESSION_CWD || process.cwd();

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  → ' + JSON.stringify(extra) : '')); }
}

async function j(method, p, body) {
  const r = await fetch(BASE + p, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await r.json(); } catch {}
  return { status: r.status, data };
}

const q = '?cwd=' + encodeURIComponent(CWD);

console.log('cwd =', CWD);

// 1. 列表
const list = await j('GET', '/api/local/orch' + q);
check('GET /api/local/orch 返回 ok', list.data && list.data.ok === true, list.data);
check('返回 projectRoot', !!(list.data && list.data.projectRoot), list.data);
check('返回 items 数组', !!(list.data && Array.isArray(list.data.items)), list.data);
console.log('       projectRoot =', list.data && list.data.projectRoot);

// 2. 保存草稿（中文名 —— 应被安全化，不崩）
const doc = {
  name: '选址分析编排',
  title: '选址分析',
  description: '先添加数据，再按属性渲染点位，最后统计缓冲区。',
  nodes: [
    { id: 'n1', tool: 'add_data', connector: 'geoscene', server: 'pro', args: { path: { source: 'runtime' }, layername: { source: 'const', value: 'sites' } } },
    { id: 'n2', tool: 'render_point', connector: 'geoscene', server: 'pro', args: { layerName: { source: 'upstream', fromNode: 'n1', fromField: 'layerName' }, type: { source: 'const', value: 'circle' }, size: { source: 'const', value: 8 }, color: { source: 'const', value: '#ff0000' } } },
  ],
  edges: [{ from: 'n1', to: 'n2' }],
};
const saved = await j('POST', '/api/local/orch' + q, { name: doc.name, doc });
check('POST 保存草稿成功', saved.data && saved.data.ok === true, saved.data);
const savedName = (saved.data && saved.data.file || '').split(/[\\/]/).pop();
console.log('       saved file =', savedName);

// 3. 读回
if (saved.data && saved.data.ok) {
  const one = await j('GET', '/api/local/orch' + q + '&name=' + encodeURIComponent('选址分析编排'));
  check('GET by name 能读回', one.data && one.data.ok === true && one.data.doc && one.data.doc.nodes.length === 2, one.data);
}

// 4. 导出的三种拒收路径
const bad1 = await j('POST', '/api/local/orch/export', { cwd: CWD, doc: { ...doc, description: '' } });
check('description 为空 → 拒绝', bad1.data && bad1.data.ok === false && /description/.test(bad1.data.error || ''), bad1.data);

const bad2 = await j('POST', '/api/local/orch/export', { cwd: CWD, doc: { ...doc, nodes: [] } });
check('无节点 → 拒绝', bad2.data && bad2.data.ok === false, bad2.data);

const bad3 = await j('POST', '/api/local/orch/export', { cwd: CWD, doc: null });
check('缺 doc → 拒绝', bad3.data && bad3.data.ok === false, bad3.data);

// 5. 中文名应被转成合法 kebab-case 或兜底名
const exp = await j('POST', '/api/local/orch/export', { cwd: CWD, doc, scope: 'project' });
check('导出成功', exp.data && exp.data.ok === true, exp.data);
if (exp.data && exp.data.ok) {
  check('name 是合法 kebab-case', /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(exp.data.name), exp.data.name);
  console.log('       exported name =', exp.data.name);
  console.log('       exported file =', exp.data.file);
  // 6. 同名冲突
  const again = await j('POST', '/api/local/orch/export', { cwd: CWD, doc, scope: 'project' });
  check('同名 → 409 冲突', again.status === 409 && again.data && again.data.conflict === true, again.data);
  // 7. 覆盖
  const over = await j('POST', '/api/local/orch/export', { cwd: CWD, doc, scope: 'project', overwrite: true });
  check('overwrite=true → 覆盖成功', over.data && over.data.ok === true, over.data);
}

console.log('\nDONE fails=' + fail + ' pass=' + pass);
process.exit(fail ? 1 : 0);
