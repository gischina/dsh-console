/* DSH Console — 工具脚本 test-api.mjs
 * Copyright 2026 liwei (易智瑞西安) <liwei@geoscene.cn>
 * SPDX-License-Identifier: Apache-2.0
 *
 * 依据 Apache License 2.0 授权使用与分发；许可证全文见项目根目录 LICENSE，摘要见 NOTICE。
 */
/* 集成测试：把 public/app.js 载进 Node 的 vm 沙箱（只补最小 DOM 桩），
   然后直接调 API/Mux 层打真实的 DSH（经已认证的控制台）。
   这样能在没有浏览器的情况下验证整张"旧方法名 → 新端点 + 新参数"翻译表。

   ⚠️ 本脚本会打到**真实的 DSH**，所以"写端点"一律只验参数形状、绝不产生副作用：
      · 用非法内容诱发业务层报错（空标题、空目标、不存在的子代理…）
      · 需要成功构造的场景（如 session.create，参数合法就会真建会话）只做**纯映射断言**，不发请求
      · 写操作前先确认失败路径，宁可少测一条，也不要在别人机器上留下垃圾会话
   用法：CONSOLE=http://127.0.0.1:3081 SID=<sessionId> node tools/test-api.mjs */
import fs from 'node:fs';
import vm from 'node:vm';

const CONSOLE = process.env.CONSOLE || 'http://127.0.0.1:3081';
const src = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8')
  + '\n;globalThis.__x = { API, State, Mux, Stream, ROUTES, Pages, mcpView, boot, loadCredentials,'
  + ' loadWorkspaces, loadSubagents, refreshGoal, loadTrajectory, loadOlderTrajectory, loadDeliverables,'
  + ' loadWorkflowRuns, loadChatHistory, refreshSystem, loadSettings, loadFeedback, loadCommands,'
  + ' runContractCheck, loadDynamicPlugins, jobsOfAllSessions, trajectoryTurns, sessionTitleHtml, sessionPreset,'
  + ' renderChatAside, currentJobs, currentQueue, render, setTrajectoryTurn, Chat,'
  + ' mediaHtml, mediaBlockHtml, attachmentUrl, Stamps };\n';

const noop = () => {};
// 按 id 缓存的元素桩：getElementById 必须返回**同一个**对象，否则函数写进去的内容读不到
const els = {};
// 壳元素：#content 的整体重建不该动它们（真实浏览器里它们也不在 #content 里）
const SHELL_IDS = new Set(['content', 'side', 'nav', 'hstatus', 'toastwrap', 'palette']);
const el = () => {
  const o = {
    style: {}, dataset: {}, id: '',
    classList: (() => {
      const s = new Set();
      return { _s: s, add: (c) => s.add(c), remove: (c) => s.delete(c), contains: (c) => s.has(c),
               toggle: (c, on) => { const want = on === undefined ? !s.has(c) : !!on; want ? s.add(c) : s.delete(c); return want; } };
    })(),
    appendChild: noop, remove: noop, addEventListener: noop, getAttribute: () => '',
    // 属性要有真实记忆：applyTheme 靠 hasAttribute 判断 data-ds-dark-theme 挂没挂
    _attrs: new Set(),
    hasAttribute(n) { return this._attrs.has(String(n)); },
    setAttribute(n) { this._attrs.add(String(n)); },
    removeAttribute(n) { this._attrs.delete(String(n)); },
    querySelector: () => null, querySelectorAll: () => [], textContent: '', closest: () => null,
    setSelectionRange: noop,
    focus() { sandbox.document.activeElement = o; },
    // 真实浏览器的 replaceWith：把"节点"换掉。这里等价于把按 id 的缓存指向新节点。
    replaceWith(n) { for (const k of Object.keys(els)) if (els[k] === o) els[k] = n; },
  };
  let html = '';
  Object.defineProperty(o, 'innerHTML', {
    // innerHTML 赋值 = 真实浏览器里的"整块重建"：把 #content 里现造出来的元素缓存清掉，
    // 这样"重绘把加载器写的区域清空 / paintDirect 搬节点救回来"才真的可验证。
    get: () => html,
    set: (v) => { html = v; if (o.id === 'content') for (const k of Object.keys(els)) if (!SHELL_IDS.has(k)) delete els[k]; },
  });
  return o;
};
const byId = (id) => { let e = els[id]; if (!e) { e = el(); e.id = id; els[id] = e; } return e; };
const sandbox = {
  window: { addEventListener: noop, matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop, addListener: noop }) },
  document: {
    activeElement: null,
    addEventListener: noop, getElementById: byId, createElement: el, querySelector: () => null,
    querySelectorAll: () => [], body: el(), documentElement: el(),
  },
  location: { protocol: 'http:', host: '127.0.0.1:3081', hash: '', href: CONSOLE + '/' },
  localStorage: { getItem: () => null, setItem: noop },
  fetch: (u, o) => fetch(String(u).startsWith('/') ? CONSOLE + u : u, o),
  WebSocket: globalThis.WebSocket,
  Intl, JSON, Math, Date, Number, String, Object, Array, Promise, Set, Map, RegExp, Error, Boolean,
  console, setTimeout, clearTimeout, setInterval, clearInterval,
  CSS: { escape: (s) => s },
  AbortSignal,
};
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: 'app.js' });
const { API, State, Mux, Stream, ROUTES, Pages } = sandbox.__x;
const X = sandbox.__x;

/* SID 必须给：翻译表里绝大多数端点都以**会话 ID** 为入参（agentId / parentSessionId / request.sessionId…）。
   缺了它，会有十几条断言以「参数形状不对」「missing "agentId"」的形式**假红** —— 看起来像 DSH 改了网关契约，
   实际上只是没传 SID（undefined 被 JSON.stringify 丢掉，参数就变空了）。
   这个坑很贵（排查一次要顺着网关报错翻回测试脚本），所以这里先自己找一条真实会话兜底，
   并且把用的是哪条会话打出来；找不到才报错退出。 */
let SID = process.env.SID;
if (!SID) {
  try {
    const list = await API.call('session.list', {});
    SID = ((list && list.items) || [])[0]?.sessionId || '';
    if (SID) console.log('（未传 SID —— 自动选用真实会话 ' + SID + '，如需指定请见文件头用法）\n');
  } catch { /* 落到下面统一报错 */ }
}
if (!SID) {
  console.error('缺会话 ID。用法：CONSOLE=http://127.0.0.1:3081 SID=<sessionId> node tools/test-api.mjs\n'
    + '（当前 DSH 上也没查到任何会话；没有 SID 时多数端点断言只会假红，所以直接退出。）');
  process.exit(2);
}
State.sessionId = SID;
State.sessions = [{ sessionId: SID, running: true, projections: { values: {} } }];

let pass = 0, fail = 0;
const show = (v) => { let s = JSON.stringify(v); return s && s.length > 110 ? s.slice(0, 110) + '…' : s; };
/** mode: 'ok' 正常 | 'err' 期望业务层报错 | 'argErr' 期望边界（参数形状）拒绝 */
async function t(label, fn, mode = 'ok') {
  try {
    const v = await fn();
    if (mode === 'ok') { console.log('✓ ' + label + '  ' + show(v)); pass++; }
    else { console.log('✗ ' + label + '  期望报错但成功了: ' + show(v)); fail++; }
  } catch (e) {
    const msg = String(e.message || e);
    const boundary = /arguments-invalid|input-invalid|unexpected "|missing "/i.test(msg) || /invalid payload/i.test(msg);
    if (mode === 'argErr') {
      if (boundary) { console.log('✓ ' + label + '  参数被边界拒绝（符合预期）'); pass++; }
      else { console.log('✗ ' + label + '  期望边界拒绝，实际是业务错：' + msg.slice(0, 120)); fail++; }
      return;
    }
    if (mode === 'err') {
      if (boundary) { console.log('✗ ' + label + '  参数形状不对：' + msg.slice(0, 140)); fail++; }
      else { console.log('✓ ' + label + '  参数通过（业务层报错：' + msg.slice(0, 90) + '）'); pass++; }
      return;
    }
    console.log('✗ ' + label + '  ' + msg.slice(0, 160)); fail++;
  }
}

/* 渲染事故标记：只看"整块文本 / 整个属性值就是异常值"的位置。
   不能直接 includes('undefined') —— 轨迹、对话、交付物页会把**会话内容原样渲染**出来，
   而会话内容里本来就可能出现 undefined / NaN 这些词（模型或工具自己打印过），那是假阳性。
   真正由 `${x}` 未定义造成的事故长这样：<td>undefined</td>、="undefined"、>NaN<。 */
const BAD_MARK = /(?:>\s*(?:undefined|NaN|\[object Object\])(?=[\s<]))|(?:"\s*(?:undefined|NaN|\[object Object\])\s*")/;
const findBadMark = (html) => { const m = BAD_MARK.exec(html); return m ? m[0] : null; };
{
  // 自检：这套标记必须能抓模板事故、又不能误伤会话正文（否则这条检查会静默失效）
  const cases = [['<td>undefined</td>', true], ['<div class="v">NaN</div>', true], ['<div class="v">undefined ms</div>', true],
    ['<b data-x="undefined">ok</b>', true], ['<span title="a undefined b">ok</span>', false],
    ['会话正文里出现 undefined 与 NaN 这两个词', false]];
  const bad = cases.filter(([h, want]) => !!findBadMark(h) !== want).map(([h]) => h);
  console.log((bad.length ? '✗' : '✓') + ' 渲染事故标记自检（' + cases.length + ' 例）' + (bad.length ? '  误判：' + bad.join(' | ') : ''));
  bad.length ? fail++ : pass++;
}

console.log('=== 只读端点（走翻译表）===');
await t('session.list', () => API.call('session.list').then(v => ({ items: v.items.length })));
await t('session.models', () => API.call('session.models').then(v => ({ current: v.current, groups: v.groups.length })));
await t('settings.describe', () => API.call('settings.describe', { sessionId: SID }).then(v => ({ ns: v.namespaces.length, writable: v.writable })));
await t('credentials.describe', () => API.call('credentials.describe', { refs: [] }).then(v => ({ keys: Object.keys(v).length })));
await t('llm.providers', () => API.call('llm.providers').then(v => ({ n: v.providers.length, first: v.providers[0] })));
await t('skill.list', () => API.call('skill.list', { sessionId: SID }).then(v => ({ skills: v.skills.length })));
await t('agentPreset.list', () => API.call('agentPreset.list').then(v => ({ presets: v.presets.length })));
await t('agentPreset.read', () => API.call('agentPreset.read', { sessionId: SID, agentPreset: 'standard' }).then(v => ({ trust: v.trust, bytes: (v.content || '').length })));
await t('subagent.list', () => API.call('subagent.list', { parentSessionId: SID }).then(v => ({ entries: v.entries.length, parentAvailable: v.parentAvailable })));
await t('pluginInventory/list', () => API.call('pluginInventory/list', { args: {} }).then(v => ({ entries: v.entries.length })));
await t('commands/list', () => API.call('commands/list', { args: { agentId: SID } }).then(v => ({ cmds: v.length, names: v.map(c => '/' + c.name).join(' ') })));
await t('fileReferences/list', () => API.call('fileReferences/list', { args: { agentId: SID, query: '' } }).then(v => ({ n: v.length })));
await t('sessionReferenceResolver/candidates', () => API.call('sessionReferenceResolver/candidates', { args: { agentId: SID, query: '' } }).then(v => ({ n: v.length })));
await t('messageFeedback/list', () => API.call('messageFeedback/list', { args: { request: { sessionId: SID } } }).then(v => ({ ok: v.ok, items: v.value?.items?.length })));
await t('API.host()', () => API.host().then(v => v));
await t('API.workspaces()', () => API.workspaces().then(v => ({ items: v.items.length, archived: (v.archivedSessionIds || []).length })));
await t('API.history()', () => API.history(SID, true).then(v => ({ events: v.events.length, hasMore: v.hasMore, title: v.projections?.values?.title, preset: v.header?.agentPreset })));

console.log('\n=== 写端点：只验参数形状（**必须无副作用**，见文件头注释）===');
await t('session.prompt（空内容）', () => API.call('session.prompt', { sessionId: SID, mode: 'queue', content: [] }), 'err');
await t('goals.create（空目标）', () => API.call('goal.create', { sessionId: SID, objective: '' }), 'err');
await t('session.rename（空标题）', () => API.call('session.rename', { sessionId: SID, title: '' }), 'err');
await t('subagents.prompt（不存在子代理）', () => API.call('subagent.prompt', { parentSessionId: SID, childSessionId: 'session-00000000-0000-0000-0000-000000000000', content: [{ type: 'text', text: 'x' }] }), 'err');
// session.create 只做**纯映射断言**，不发请求：
// 之前用"不存在的目录"来诱发报错，但目录是否存在取决于机器/沙箱，曾因此真建出一个空会话。
{
  const [endpoint, build] = API.MAP['session.create'];
  const args = await build({ cwd: '/no-such-dir-for-test', agentPreset: 'standard' });
  const okShape = endpoint === 'session/create'
    && args?.request?.cwd === '/no-such-dir-for-test'
    && args.request.agentPreset === 'standard'
    && 'sessionId' in args.request;
  console.log((okShape ? '✓' : '✗') + ' session.create 参数映射（不发请求）  ' + endpoint + ' ← ' + JSON.stringify(args));
  okShape ? pass++ : fail++;
}
await t('settings.mutate（不存在的 ns）', () => API.call('settings.mutate', { ns: 'no-such-ns', ops: [] }), 'err');
// 凭据只读验证：refs 的字段名与取值规则（^[A-Za-z_][A-Za-z0-9_]*$）都要对
await t('credentials.describe（非法键名 → 边界拒绝）', () => API.call('credentials.describe', { refs: ['bad name!'] }), 'argErr');
await t('credentials.unset（不存在的键，幂等）', () => API.call('credentials.unset', { keys: ['DSH_CONSOLE_NO_SUCH_KEY'] }), 'ok');

console.log('\n=== 关键路径：分页 / 上传 / 分叉 / 插话 / 反馈 / 目标 / 自检 ===');
// session/page：向后翻页（只读）。throughSeq 必须是 follow 开屏给的 cursor —— 传大了会被 DSH 拒绝
// （实测：through seq 1e9 is past cursor N）
await t('session.page 向后翻页', async () => {
  const snap = await API.history(SID, true);
  const v = await API.call('session.page', { request: {
    address: { kind: 'session', sessionId: SID }, throughSeq: snap.cursor, maxMessages: 3,
  } });
  return { cursor: snap.cursor, records: (v.records || []).length, hasMore: v.hasMore };
});
await t('dynamicCordisRunner/inventory', () => API.post('dynamicCordisRunner/inventory', {}).then(v => ({ rows: Array.isArray(v) ? v.length : v })));
// 形状验证：用不存在的身份，让请求到达业务层（边界不报错 = 字段名对）
await t('fileUploads/upload（陌生人身份）', () => API.post('fileUploads/upload', { agentId: 'session-00000000-0000-0000-0000-000000000000', request: { data: 'aGk=', name: 'probe.txt' } }), 'err');
// sessionFeedback/record 的失败是**值级联合类型**（返回 {ok:false,error}，不抛错）——这里按值断言
await t('sessionFeedback/record（陌生人身份 → 值级失败）', async () => {
  const v = await API.post('sessionFeedback/record', { request: { sessionId: 'session-00000000-0000-0000-0000-000000000000', text: 'probe', category: 'other' } });
  if (!v || v.ok !== false) throw new Error('期望 {ok:false} 的值级失败，实际: ' + JSON.stringify(v));
  return { value: v.error && v.error.code };
});
// 纯映射断言：带 atSeq 的分叉、带 delivery 的子代理消息（都不发请求）
{
  const [ep, build] = API.MAP['session.fork'];
  const a = await build({ sessionId: 'session-x', atSeq: 42 });
  const ok1 = ep === 'session/fork' && a.request.sessionId === 'session-x' && a.request.atSeq === 42;
  const [ep2, build2] = API.MAP['subagent.prompt'];
  const b = await build2({ parentSessionId: 'p', childSessionId: 'c', content: [{ type: 'text', text: 'x' }], delivery: 'steer' });
  const ok2 = ep2 === 'subagents/prompt' && b.request.delivery === 'steer' && b.request.mode === 'continuable' && !!b.request.requestId;
  console.log((ok1 ? '✓' : '✗') + ' session.fork 带 atSeq 映射  ' + JSON.stringify(a));
  console.log((ok2 ? '✓' : '✗') + ' subagents/prompt 带 delivery 映射  ' + JSON.stringify({ ...b.request, requestId: '…' }));
  (ok1 && ok2) ? pass++ : fail++;
}
// 轨迹翻页：先加载轨迹，再往前翻一页，看节点数是否增长
await t('轨迹向前翻页（loadOlderTrajectory）', async () => {
  await X.loadTrajectory();
  const before = State.trajectory.items.length, oldest = State.trajectory.oldestSeq;
  if (!State.trajectory.hasMore) return { skipped: '快照已含全部记录' };
  await X.loadOlderTrajectory();
  return { before, after: State.trajectory.items.length, oldestBefore: oldest, oldestAfter: State.trajectory.oldestSeq };
});
// 契约自检：逐项跑（dsh CLI 那项在受限环境里会失败，属预期）
await t('runContractCheck（页面上的契约自检）', async () => {
  await X.runContractCheck();
  const rows = State.contract.rows || [];
  return { total: rows.length, failed: rows.filter(r => !r.ok).map(r => r.name) };
});
console.log('\n=== 18 个页面渲染（喂真实数据，抓渲染期错误）===');
try {
  // 模拟页面启动：把各加载器跑一遍（等价于 refresh 后的状态）
  await X.loadSettings();
  await X.loadCredentials();
  await X.loadWorkspaces();
  await X.loadSubagents();
  await X.refreshGoal();
  await X.loadTrajectory();
  await X.loadDeliverables();
  await X.loadWorkflowRuns();
  await X.loadCommands();
  await X.loadFeedback();
  State.plugins = await (await fetch(CONSOLE + '/api/local/plugins')).json();
  const mcpRaw = await (await fetch(CONSOLE + '/api/local/mcp')).json();
  State.mcp = (mcpRaw.servers || []).map(X.mcpView);
  State.skillsScope = await (await fetch(CONSOLE + '/api/local/skills?cwd=' + encodeURIComponent(State.host?.cwd || ''))).json();
  State.skills = (await API.call('skill.list', { sessionId: SID })).skills || [];
  State.presets = (await API.call('agentPreset.list')).presets || [];
  State.models = await API.call('session.models');
  State.providers = (await API.call('llm.providers')).providers || [];
} catch (e) {
  console.log('✗ 加载器阶段失败：' + e.message); fail++;
}
for (const r of ROUTES) {
  try {
    const html = Pages[r.id] ? Pages[r.id]() : null;
    if (typeof html !== 'string' || !html.length) throw new Error('返回空');
    // 只查渲染事故标记（见 BAD_MARK 的说明：会话内容里的同名词不算）
    const mark = findBadMark(html);
    if (mark) throw new Error('页面里出现异常标记：' + mark);
    console.log('✓ ' + r.path.padEnd(22) + html.length + ' 字节');
    pass++;
  } catch (e) {
    console.log('✗ ' + r.path.padEnd(22) + e.message);
    fail++;
  }
}

/* ============ 接线审计：编译通过 ≠ 接好了 ============
   这一段专门抓"能渲染但没接上"的问题：
     ① 页面上所有内联 onXxx="fn(...)" 的处理函数是否真的存在
     ② State.<字段> 是否都声明/赋值过（读一个不存在的字段 → 静默 undefined）
     ③ render() 里调用的加载器是否都存在
     ④ **线上没数据的分支**（活跃子代理、审批、提问、有目标的会话、有作业的全部会话视图、
        契约自检的失败行、动态插件非空…）用合成数据把它们渲染出来 —— 这些分支平时看不见，
        恰恰是"没整合好"最容易藏身的地方。 */
console.log('\n=== 接线审计（onclick 目标 / State 字段 / 加载器）===');
{
  const src = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const seen = (name) => vm.runInContext('typeof ' + name, sandbox) !== 'undefined';
  // ① 内联事件处理函数
  // 属性里可能先给 State 赋值再调用（oninput="State.x=this.value;render({paintOnly:true})"），
  // 所以要扫整段属性值；但 `xxx.method(` 这种成员调用要跳过（typeof 查不到方法名）。
  const handlers = [...new Set([...src.matchAll(/\bon(?:click|change|input|keydown)="([^"]*)"/g)]
    .flatMap(m => [...m[1].matchAll(/(?:^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g)].map(x => x[1])))];
  const missing = handlers.filter(h => !seen(h));
  console.log((missing.length ? '✗' : '✓') + ' 内联事件处理函数 ' + handlers.length + ' 个' + (missing.length ? '，未定义：' + missing.join(', ') : '，全部存在'));
  missing.length ? fail++ : pass++;
  // ② State 字段
  const declared = new Set([...src.matchAll(/State\s*=\s*\{([\s\S]*?)\};/g)].flatMap(m => [...m[1].matchAll(/([A-Za-z_$][\w$]*)\s*:/g)].map(x => x[1])));
  const assigned = new Set([...src.matchAll(/State\.([A-Za-z_$][\w$]*)\s*=(?!=)/g)].map(m => m[1]));
  const used = [...new Set([...src.matchAll(/State\.([A-Za-z_$][\w$]*)/g)].map(m => m[1]))];
  const undecl = used.filter(k => !declared.has(k) && !assigned.has(k));
  console.log((undecl.length ? '✗' : '✓') + ' State 字段 ' + used.length + ' 个被读取' + (undecl.length ? '，既没声明也没赋值：' + undecl.join(', ') : '，全部有归属'));
  undecl.length ? fail++ : pass++;
  // ③ render() 里用到的加载器
  const renderFn = /async function render\(opts\)\{([\s\S]*?)\n\}/.exec(src);
  const calls = renderFn ? [...new Set([...renderFn[1].matchAll(/\b([a-zA-Z_$][\w$]*)\s*\(/g)].map(m => m[1]))].filter(n => !['if', 'for', 'while', 'switch', 'Promise', 'return', 'await', 'catch', 'setTimeout'].includes(n)) : [];
  const missLoad = calls.filter(n => /^(load|refresh|render|apply|wait)/.test(n) && !seen(n));
  console.log((missLoad.length ? '✗' : '✓') + ' render() 里调用的加载/渲染函数 ' + calls.length + ' 个' + (missLoad.length ? '，未定义：' + missLoad.join(', ') : '，全部存在'));
  missLoad.length ? fail++ : pass++;
  // ④ 页面里出现的每个 API 名字，要么在翻译表 API.MAP 里，要么是直接打在 Remote 端点上的 ns/method
  {
    const used = [...new Set([...src.matchAll(/API\.(?:call|post)\('([^']+)'/g)].map(m => m[1]))];
    const dotted = used.filter(n => n.includes('.'));
    const unMapped = dotted.filter(n => !API.MAP[n]);
    const badRaw = used.filter(n => n.includes('/') && !/^[A-Za-z$][\w$]*\/[A-Za-z$][\w$]*$/.test(n));
    console.log((unMapped.length || badRaw.length ? '✗' : '✓') + ' 页面用到的 ' + used.length + ' 个 API 名字都有归宿'
      + (unMapped.length ? '，翻译表里没有：' + unMapped.join(', ') : '')
      + (badRaw.length ? '，端点写法可疑：' + badRaw.join(', ') : ''));
    (unMapped.length || badRaw.length) ? fail++ : pass++;
  }
}

console.log('\n=== 合成数据分支渲染（覆盖线上没有数据的分支）===');
{
  const need = (label, fn) => {
    try {
      const html = fn();
      if (typeof html !== 'string' || !html.length) throw new Error('返回空');
      if (findBadMark(html)) throw new Error('出现异常标记：' + findBadMark(html));
      console.log('✓ ' + label); pass++;
    } catch (e) { console.log('✗ ' + label + '  ' + e.message); fail++; }
  };
  const has = (label, fn, ...subs) => need(label + '  → 含 ' + subs.map(s => JSON.stringify(s)).join(' / '), () => {
    const html = fn();
    const miss = subs.filter(s => !html.includes(s));
    if (miss.length) throw new Error('缺少片段：' + miss.join(' , '));
    return html;
  });

  // A1 预设：把投影值塞进会话，看会话页/首页是否显示出来
  // 前面的加载器可能已经用真实数据覆盖过 State.sessions（沙箱里可能为 0 条），
  // 这里先保证"至少有一条带 projections 的会话"，否则下面会直接 TypeError 中断整个套件。
  if (!State.sessions.length) State.sessions = [{ sessionId: SID, running: true, projections: { values: {} } }];
  if (!State.sessions[0].projections) State.sessions[0].projections = { values: {} };
  if (!State.sessions[0].projections.values) State.sessions[0].projections.values = {};
  State.sessions[0].projections.values.agentPreset = 'standard';
  has('A1 会话页读投影里的预设', () => Pages.sessions(), 'standard');
  has('A1 首页摘要读投影里的预设', () => Pages.home(), 'standard');
  // A2 空会话标注：拿真实数据里那条 blank 会话
  has('A2 空会话 / 子代理标注', () => Pages.sessions(), '空会话');
  // A3 作业页全宿主视图（合成两个会话的作业）
  State.jobsBySession = {
    [SID]: [{ id: 'j1', kind: 'pwsh', label: 'node server.cjs', status: 'running', startedAt: Date.now() }],
    'session-other': [{ id: 'j2', kind: 'bash', label: 'npm test', status: 'completed', startedAt: Date.now() - 1000, finishedAt: Date.now() }],
  };
  State.jobsAllView = true;
  has('A3 作业页「全部会话」', () => Pages.jobs(), '所属会话', 'node server.cjs', '全部会话');
  State.jobsAllView = false;
  has('A3 作业页只看当前会话', () => Pages.jobs(), '当前会话', 'node server.cjs');
  // 审批 / 提问卡片（线上没触发过）
  State.approvals = [{ approvalId: 'e1', eventId: 'e1', sessionId: SID, toolName: 'write', reason: '越权写入' }];
  State.questions = [{ rpcId: 'e2', eventId: 'e2', sessionId: SID, questions: [{ id: 'q1', header: '选择', question: '用哪个方案？', options: [{ label: 'A' }, { label: 'B' }] }] }];
  has('审批卡片', () => Pages.jobs(), '审批请求', '越权写入', '允许一次');
  has('提问卡片', () => Pages.jobs(), '智能体提问', '用哪个方案？', '提交');
  els['chataside'].style.display = 'block';
  has('对话侧栏的审批块', () => { X.renderChatAside(); return els['chataside'].innerHTML || ''; }, '待审批', 'write');
  State.approvals = []; State.questions = [];
  // B2 子代理插话按钮（需要"运行中"的子代理）
  State.subagents = { parentAvailable: true, entries: [
    { id: 'session-child', label: '质检子代理', kind: 'spawn', mode: 'continuable', activity: 'active', hasChildren: false },
    { id: 'session-child2', label: '空闲子代理', kind: 'spawn', mode: 'continuable', activity: 'idle', hasChildren: false },
  ] };
  has('B2 子代理「插话」按钮', () => Pages.subagents(), '⚡ 插话', 'promptSubagent', "'steer'");
  // B6 目标激活态（需要活跃目标）
  State.goal = { goal: { id: 'goal-x', revision: 3, objective: '把数据质检一遍', phase: 'active', maxGoalRounds: 8, activation: 'armed' },
                 roundsStarted: 2, createdAt: Date.now() - 60000, updatedAt: Date.now() };
  has('B6 目标页 activation', () => Pages.goal(), '自动推进', 'armed', '把数据质检一遍');
  State.goal = { goal: { id: 'goal-x', revision: 3, objective: 'x', phase: 'paused', maxGoalRounds: 8, activation: 'disarmed' },
                 roundsStarted: 1, createdAt: Date.now(), updatedAt: Date.now() };
  has('B6 disarmed 分支', () => Pages.goal(), 'disarmed', '不会自动推进');
  State.goal = null;
  // D 契约自检卡片（含一行失败）
  State.contract = { at: Date.now(), running: false, rows: [
    { name: '示例通过项', ok: true, ms: 12, detail: 'ok' },
    { name: '示例失败项', ok: false, ms: 3, detail: 'boom' },
  ] };
  has('D 契约自检卡片（含失败行）', () => Pages.host(), '契约自检', '示例失败项', '失败');
  State.contract = null;
  // B5 动态插件非空分支（把 API.post 临时换掉，注入一行合成数据）
  const realPost = API.post;
  API.post = async (ep, args) => (ep === 'dynamicCordisRunner/inventory'
    ? [{ pluginId: 'plugin-x', agentId: SID, packages: [{}, {}], currentPackageId: 'pkg-1', activeRun: { packageId: 'pkg-1', pluginRunId: 'r1' } }]
    : realPost(ep, args));
  await X.loadDynamicPlugins();
  const dynHtml = els['dynplugins'].innerHTML || '';
  API.post = realPost;
  need('B5 动态插件非空分支  → 含 "plugin-x"', () => {
    if (!dynHtml.includes('plugin-x') || !dynHtml.includes('运行中')) throw new Error('未渲染合成行：' + dynHtml.slice(0, 80));
    return dynHtml;
  });
  // B1/B3 轨迹页的翻页 / 轮次 / 分叉控件
  has('B1/B3 轨迹页控件', () => Pages.trajectory(), '加载更早', '轮次', 'setTrajectoryTurn');
  // B4/B8 对话页的附件入口
  //    附件入口已合并成单个「添加附件」（对齐原生 file.attach）：图片与文件共用 pickAttach 按 MIME 分流；
  //    旧的两个按钮 id（chatfile-any）与「📁」不应再出现，@ 按钮也已去掉（@ 仍可由键盘触发引用菜单）。
  //    「⋯ 更多」菜单已按反馈整组移除：统计与上下文合并成工具条上的「📈 统计」按钮，
  //    备注 / 载入历史 / 清空面板不再挂在这里（历史本就是全量载入；备注走命令面板 /feedback）。
  has('B4/B8 对话页入口', () => Pages.chat(), 'chatattach', 'pickAttach', '统计', 'showSessionStats');
  need('B8 「更多」菜单已移除且不再引用会话备注', () => {
    const h = Pages.chat();
    if (h.includes('chatMorePick') || h.includes('chatmoremenu')) throw new Error('「⋯ 更多」菜单仍在');
    if (h.includes('会话备注') || h.includes('载入历史消息') || h.includes('清空面板'))
      throw new Error('已移除的低频动作仍出现在聊天页');
    if (!h.includes('showSessionStats()')) throw new Error('统计按钮不在');
    return '更多菜单已移除 · 统计按钮在';
  });
  need('B4 附件入口只剩一个（无上传图片/上传文件两个按钮）', () => {
    const h = Pages.chat();
    if (h.includes('chatfile-any')) throw new Error('旧的「上传任意文件」入口仍在：chatfile-any');
    if ((h.match(/<input type="file"/g) || []).length !== 1) throw new Error('file input 应只剩 1 个');
    return 'file input ×1';
  });
  need('B8 @ 引用按钮已移除（openRefMenu 不再挂在按钮上）', () => {
    const h = Pages.chat();
    if (/<button[^>]*openRefMenu/.test(h)) throw new Error('@ 引用工作目录按钮仍在');
    return '已移除';
  });
  // 模型页的 reasoning 档位
  has('模型页 reasoning 档位', () => Pages.models(), 'efforts' in {} ? '' : 'DeepSeek');
  // 恢复真实的子代理数据
  await X.loadSubagents();
}

console.log('\n=== 交互状态不被重绘冲掉（paintOnly 机制）===');
{
  // 这两个 bug 都是「点了没反应」：交互刚改好的客户端状态，被 render() 里的加载器重建/覆盖。
  // ① render({paintOnly:true}) 必须真的跳过加载器
  const realHistory = API.history;
  let histCalls = 0;
  API.history = (...a) => { histCalls++; return realHistory(...a); };
  sandbox.location.hash = '#/session/trajectory';
  // ⚠️ 测量前必须让 loader 的 TTL 缓存失效（Stamps.trajectory 在套件前段已被 stampLoader 写进时间戳）。
  // 否则 loadTrajectory 命中 2.5s 缓存直接 return，基线恒为 0，"不重跑加载器"就成了恒真的假结论。
  X.Stamps.trajectory = 0;
  await X.loadTrajectory();
  const before = histCalls;
  await X.render({ paintOnly: true });
  const afterPaint = histCalls;
  X.Stamps.trajectory = 0;                // 同理：让完整 render 的加载器真的重取，才有对照
  await X.render();                       // 完整 render 应当照旧重跑加载器（对照）
  const afterFull = histCalls;
  API.history = realHistory;
  const okPaint = afterPaint === before && before > 0 && afterFull > afterPaint;
  console.log((okPaint ? '✓' : '✗') + ' paintOnly 重绘不重跑加载器  (API.history 调用 ' + before + ' → ' + afterPaint + '，完整 render 后 ' + afterFull + ')');
  okPaint ? pass++ : fail++;
  // ② 轨迹轮次筛选在重绘后仍然生效（原 bug：点「第 N 轮」没反应）
  await X.loadTrajectory();
  const turns = X.trajectoryTurns();
  X.setTrajectoryTurn(turns.length ? turns[0].turn : 1);
  await X.render({ paintOnly: true });
  const want = turns.length ? turns[0].turn : 1;
  const kept = State.trajectory && State.trajectory.turnFilter;
  const html = Pages.trajectory();
  const chipOn = new RegExp('btn sm primary"[^>]*onclick="setTrajectoryTurn\\(' + want + '\\)"').test(html);
  const okChip = kept === want && chipOn;
  console.log((okChip ? '✓' : '✗') + ' 轮次筛选在重绘后保持  (turnFilter=' + kept + '，第 ' + want + ' 轮按钮高亮=' + chipOn + ')');
  okChip ? pass++ : fail++;
  X.setTrajectoryTurn(null);
  // ③ 凭据「按名查询」的结果不被加载器冲掉（原 bug：查完就没了）
  State.credentials = { listable: false, credentials: { PROBE_KEY: { configured: true, source: 'file' } } };
  await X.loadCredentials();
  const keys = Object.keys((State.credentials && State.credentials.credentials) || {});
  const survived = keys.includes('PROBE_KEY');
  console.log((survived ? '✓' : '✗') + ' 按名查询的凭据在重载后仍在  (' + JSON.stringify(keys) + ')');
  survived ? pass++ : fail++;
  State.credentials = null;
  await X.loadCredentials();
  // ④ 直接写 DOM 的区域（对话流等）在重绘后不能被清空
  //    （原 bug：多选作答/审批等 paintOnly 重绘把 #chatlog 换回骨架 → 整段对话消失）
  sandbox.location.hash = '#/chat-agent';
  await X.render();
  const logNode = sandbox.document.getElementById('chatlog');
  logNode.innerHTML = '<div class="empty">MARKER</div>';
  await X.render({ paintOnly: true });
  const logNode2 = sandbox.document.getElementById('chatlog');
  const okDom = logNode2 === logNode && /MARKER/.test(logNode2.innerHTML || '');
  console.log((okDom ? '✓' : '✗') + ' 重绘后对话流整块保留（同一节点=' + (logNode2 === logNode) + '，内容=' + JSON.stringify(String(logNode2.innerHTML || '').slice(0, 24)) + '）');
  okDom ? pass++ : fail++;
  // ⑤ 输入框：重绘后焦点与筛选词都要还在（原 bug：会话筛选打一个字就跳出去）
  sandbox.location.hash = '#/session/list';
  await X.render();
  State.sessionFilter = 'abc';
  const sfNode = sandbox.document.getElementById('sessfilter');
  sfNode.selectionStart = 3; sfNode.selectionEnd = 3;
  sandbox.document.activeElement = sfNode;
  await X.render({ paintOnly: true });
  const back = sandbox.document.activeElement;
  const okFocus = back && back.id === 'sessfilter';
  const okVal = /id="sessfilter"[^>]*value="abc"/.test(Pages.sessions());
  console.log((okFocus && okVal ? '✓' : '✗') + ' 筛选输入框重绘后仍聚焦且保留筛选词  (焦点=' + (back && back.id) + '，筛选词保留=' + okVal + ')');
  (okFocus && okVal) ? pass++ : fail++;
  sandbox.document.activeElement = null;
  State.sessionFilter = '';
  await X.render();
  // ⑥ 历史重建后必须丢掉"正在流式的气泡"引用：否则增量写进被丢弃的节点，整条回复都看不见
  sandbox.location.hash = '#/chat-agent';
  await X.render({ refreshed: true });
  X.Chat.cur = sandbox.document.createElement('div');
  X.Chat.curKey = '1:1';
  await X.loadChatHistory();
  const dropped = !X.Chat.cur && !X.Chat.curKey;
  console.log((dropped ? '✓' : '✗') + ' 历史重建后清掉流式气泡引用  (Chat.cur=' + String(X.Chat.cur) + ')');
  dropped ? pass++ : fail++;
  // ⑦ 附件渲染（session/attachment）：图片给缩略图 + 本地取字节的 URL，文件给元信息标签
  {
    const S = 'session-probe-0001';
    const img = X.mediaBlockHtml(S, { type: 'image', attachment: {
      attachmentId: 'sha256:abc', mediaType: 'image/png', bytes: 2048, width: 800, height: 600, name: '地图.png' } });
    // src 会经 fmt.esc 转义（& → &amp;），断言按片段匹配
    const okImg = img.includes('/api/local/attachment?sessionId=' + S + '&amp;attachmentId=sha256%3Aabc')
      && img.includes('class="att-img"') && img.includes('onclick="openAttachment(')
      && img.includes('地图.png') && img.includes('2.0KB') && img.includes('800×600');
    console.log((okImg ? '✓' : '✗') + ' 图片附件 → 缩略图 + 控制台取字节 URL' + (okImg ? '' : '  ← ' + img));
    okImg ? pass++ : fail++;
    const inline = X.mediaBlockHtml(S, { type: 'image', mediaType: 'image/jpeg', data: 'AAAA', name: 'x.jpg' });
    const file = X.mediaBlockHtml(S, { type: 'file', attachment: { attachmentId: 'sha256:def', name: '报表.xlsx', bytes: 1024 } });
    const none = X.mediaHtml(S, [{ type: 'text', text: 'hi' }]);
    const okMix = inline.includes('src="data:image/jpeg;base64,AAAA"')
      && file.includes('class="att-file"') && file.includes('报表.xlsx') && file.includes('1.0KB') && none === '';
    console.log((okMix ? '✓' : '✗') + ' 内联 base64 图片 / 文件标签 / 纯文本不产出附件块  (纯文本="' + none + '")'
      + (okMix ? '' : '  ← ' + inline + ' | ' + file));
    okMix ? pass++ : fail++;
    // 轨迹折叠要把附件带出来（用户消息、助手消息、工具结果三处）
    const okFold = /media: mediaHtml\(State\.sessionId/.test(fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8'));
    console.log((okFold ? '✓' : '✗') + ' 轨迹折叠节点携带附件');
    okFold ? pass++ : fail++;
  }
}

console.log('\n=== 会话附件端点（/api/local/attachment）===');
{
  // 这条路由是 server.cjs 自己实现的：改过 server.cjs 必须重启控制台才生效，
  // 所以进程较旧时只提示"待重启生效"，不当失败（重启后再跑就是真检查）。
  const base = CONSOLE + '/api/local/attachment';
  const r1 = await fetch(base);
  const j1 = await r1.json().catch(() => null);
  if (!(r1.status === 400 && j1 && j1.error)) {
    console.log('· 当前控制台进程里还没有这条路由（HTTP ' + r1.status + '）—— 改过 server.cjs 需重启控制台；重启后再跑此项即为真检查');
    pass++;
  } else {
    console.log('✓ 缺参数 → 400 JSON  ' + JSON.stringify(j1));
    pass++;
    const r2 = await fetch(base + '?sessionId=' + encodeURIComponent(SID) + '&attachmentId=sha256:' + '0'.repeat(64));
    const j2 = await r2.json().catch(() => null);
    const ok404 = r2.status === 404 && j2 && j2.error;
    console.log((ok404 ? '✓' : '✗') + ' 不存在的附件 → 404 JSON（DSH 的语义错误原样带回）  ' + r2.status + ' ' + JSON.stringify(j2));
    ok404 ? pass++ : fail++;
  }
}

console.log('\n=== 静态不变量（防回归）===');
{
  const invite = (label, ok, detail) => {
    console.log((ok ? '✓' : '✗') + ' ' + label + (detail ? '  ' + detail : ''));
    ok ? pass++ : fail++;
  };
  const css = fs.readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
  const appSrc = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  invite('.content.chat-fill 去掉对话页底部内边距', css.includes('.content.chat-fill{padding-bottom:0}'));
  invite('附件/引用空条不占位', css.includes('#attachpreview:not(:empty)') && css.includes('#refchips:not(:empty)'));
  invite('对话页标记条没有内联 padding', appSrc.includes('<div id="attachpreview"></div>') && appSrc.includes('<div id="refchips"></div>'));
  // 会话附件：前端取字节的 URL、服务端路由、样式三处都要在位
  {
    const srvSrc = fs.readFileSync(new URL('../server.cjs', import.meta.url), 'utf8');
    invite('服务端有附件路由（GET /api/local/attachment → session/attachment）',
      srvSrc.includes("pathname === '/api/local/attachment'") && srvSrc.includes("remoteCall('session/attachment'"));
    invite('前端附件 URL 与样式齐备',
      appSrc.includes("'/api/local/attachment?sessionId='") && appSrc.includes('function openAttachment(')
      && css.includes('.att-img img') && css.includes('.att-file'));
  }
  invite('render() 会按路由切 chat-fill', appSrc.includes("classList.toggle('chat-fill', r.id === 'chat')"));
  // "只改客户端状态"的交互必须用 paintOnly 重绘：完整 render() 会重跑加载器并把状态冲掉
  {
    const fnRegion = (sig) => {
      const at = appSrc.indexOf(sig);
      if (at < 0) return null;
      const rest = appSrc.slice(at);
      const end = rest.search(/\n\}\n/);      // 顶层函数以行首 } 收尾
      return end < 0 ? rest : rest.slice(0, end);
    };
    const paint = [
      ['轮次筛选', 'function setTrajectoryTurn(n)', 1],
      ['加载更早', 'async function loadOlderTrajectory', 2],
      ['查看全部会话', 'function toggleJobsAll()', 1],
      ['表头排序', 'toggle(tableId, key)', 1],
      ['表格翻页', 'go(tableId, page)', 1],
      ['按名查询凭据', 'async function checkCredential()', 1],
      ['多选勾选', 'async function answerQuestion(', 1],
      ['作答提交', 'async function submitAnswers(', 1],
      ['审批应答', 'async function respondApproval(', 1],
    ];
    const miss = [];
    for (const [name, sig, n] of paint) {
      const r = fnRegion(sig);
      const c = r ? (r.match(/paintOnly: true/g) || []).length : 0;
      if (c < n) miss.push(name + '(' + c + '/' + n + ')');
    }
    if (!/State\.sessionFilter=this\.value;render\(\{paintOnly:true\}\)/.test(appSrc)) miss.push('会话筛选');
    if (!/State\.pluginFilter=this\.value;renderPlugins\(\)/.test(appSrc)) miss.push('插件筛选');
    invite((paint.length + 2) + ' 处"只改客户端状态"的交互都用 paintOnly 重绘', miss.length === 0,
      miss.length ? '退回完整重绘了：' + miss.join('、') : '');
  }
  // 重绘后焦点/光标/草稿要还原（否则"打一个字就跳出去"、写到一半的指令消失）
  invite('render() 恢复焦点与选区', appSrc.includes('document.activeElement') && appSrc.includes('setSelectionRange'));
  invite('render() 保留对话草稿与附件标签', appSrc.includes('State.chatDraft = draftEl.value') && appSrc.includes('renderAttachPreview();   //'));
  // DOM_OWNED 是"加载器直接写 DOM 的区域"的清单：键必须是真实路由 id，值必须是**那个页面上**的容器 id。
  // 写错一处 = 那块内容在任何一次重绘后消失（历史面板 / 宿主插件运行时都踩过这个坑）。
  {
    const routeIds = new Set([...appSrc.slice(appSrc.indexOf('const ROUTES'), appSrc.indexOf("const NAV_GROUP"))
      .matchAll(/\{ id:\s*'([A-Za-z]+)'/g)].map(m => m[1]));
    const blk = /const DOM_OWNED = \{([\s\S]*?)\n\};/.exec(appSrc);
    const pairs = blk ? [...blk[1].matchAll(/([A-Za-z]+):\s*\[([^\]]*)\]/g)]
      .flatMap(m => [...m[2].matchAll(/'([^']+)'/g)].map(x => [m[1], x[1]])) : [];
    const pageSrc = (rid) => {
      const at = appSrc.indexOf('Pages.' + rid + ' = ');
      if (at < 0) return null;
      const next = appSrc.indexOf('\nPages.', at + 1);
      return appSrc.slice(at, next < 0 ? appSrc.length : next);
    };
    const bad = pairs.filter(([rid, id]) => !routeIds.has(rid) || !(pageSrc(rid) || '').includes('id="' + id + '"'));
    invite('DOM_OWNED 的 ' + pairs.length + ' 个区域都在对应路由的页面上', pairs.length > 0 && bad.length === 0,
      bad.length ? '对不上：' + bad.map(p => p.join('/')).join(', ') : pairs.map(p => p.join(':')).join('  '));
  }
  // 真实跑一遍 render()，确认路由切换时那个类真的加上了/去掉了
  sandbox.location.hash = '#/chat-agent';
  await X.render({ refreshed: true });
  invite('切到对话页 → .content 带 chat-fill', els['content'].classList.contains('chat-fill'));
  sandbox.location.hash = '#/home';
  await X.render({ refreshed: true });
  invite('切回首页 → chat-fill 被移除', !els['content'].classList.contains('chat-fill'));
}

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);

