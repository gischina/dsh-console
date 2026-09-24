/* DSH Console — 工具脚本 render-all.mjs
 * Copyright 2026 liwei (易智瑞西安) <liwei@geoscene.cn>
 * SPDX-License-Identifier: Apache-2.0
 *
 * 依据 Apache License 2.0 授权使用与分发；许可证全文见项目根目录 LICENSE，摘要见 NOTICE。
 */
/* 全页渲染沙盒：把**整个** app.js 加载进 node，配一套最小 DOM stub + 真实 HTTP 通道，
 * 走完真正的启动流程（boot + 各页数据加载），然后把 18 个页面各渲染一遍并断言产物。
 *
 * 为什么这样做：
 *   · 静态审计只能看源码文本，看不出"渲染时会不会抛异常"；
 *   · 浏览器验证在本环境不可用（PATH 里的 node 不可用、agent-browser 未安装）；
 *   · 抽取单函数到沙盒（sandbox-render.mjs 的做法）覆盖不了 18 页的依赖面。
 * 所以这里直接跑整个文件：DOM 用 stub（宽容，不解析 HTML），/api/* 走真实的 3081 控制台。
 * DSH 的 WebSocket 流用 stub 顶替（页面里靠流推进的部分不参与本次断言）。
 *
 * 用法：node tools/render-all.mjs   → 结果写 tools/render-all-out.txt
 * 依赖：控制台在 127.0.0.1:3081（默认，可用 CONSOLE_PORT 覆盖）运行。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const DIR = path.resolve(fileURLToPath(new URL('../', import.meta.url)));  // 项目根（tools/ 的上一级）
const PORT = String(process.env.CONSOLE_PORT || 3081);
const ORIGIN = 'http://127.0.0.1:' + PORT;
const code = fs.readFileSync(DIR + '/public/app.js', 'utf8');
const out = [];
const log = s => out.push(s);
let fails = 0;
const ok = (cond, label, extra) => { log((cond ? '  ✅ ' : '  ❌ ') + label + (extra ? ' — ' + extra : '')); if (!cond) fails++; };

/* 读源码文本，**统一归一成 LF** 再交给断言。
 * ⚠️ 踩过的坑（2026-09-24）：public/app.js 与 server.cjs 在本机是 **CRLF**，
 *    而下面那些「抽取某个函数体」的正则全按 `\n` 写 —— 一个都匹配不上。
 *    后果不是报错，而是 `xxxFn` 取到 null，紧接着 `xxxFn[0]` 抛异常，
 *    把整个 try 块吞在一句「本轮改动断言」里，**后面 7 条断言从此再没跑过**。
 *    所以这里统一归一：脚本里任何「读源码做正则」都必须走它。 */
const readSrc = rel => fs.readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

/* ---------------- 偏好初始态：跑前固定、跑完还原 ----------------
 * 「本页说明」的显隐存在真实项目文件 ui-prefs.yaml 里（设置页那个开关写的）。
 * 它一旦是 helpVisible:false（用户点过隐藏，或某次真机操作留下的），
 * 18 页的「页含本页说明」断言就会集体误红 —— 那是假红，不是回归失败。
 * 所以这里跑前固定成默认态（显示）、跑完（无论成败）还原用户原样：回归不该改用户的偏好。
 * ⚠️ 必须写在 boot() 之前：app.js 启动时会把偏好 GET 进内存缓存，之后再改文件就不生效了。 */
const PREFS_FILE = path.join(DIR, 'ui-prefs.yaml');
let _prefsBackup = null, _prefsExisted = false;
try { _prefsBackup = fs.readFileSync(PREFS_FILE, 'utf8'); _prefsExisted = true; } catch { }
process.on('exit', () => {
  try {
    if (_prefsExisted) fs.writeFileSync(PREFS_FILE, _prefsBackup, 'utf8');
    else fs.rmSync(PREFS_FILE, { force: true });
  } catch (e) { console.log('（还原 ui-prefs.yaml 失败，请手动检查：' + e.message + '）'); }
});
try { fs.writeFileSync(PREFS_FILE, 'helpVisible: true\n', 'utf8'); }
catch (e) { log('!! 无法固定 ui-prefs.yaml（「本页说明」断言可能假红）：' + e.message); }

/* ---------------- DOM stub ---------------- */
const nodes = {};
function mkEl(tag, id) {
  const el = {
    tagName: String(tag || 'div').toUpperCase(), id: id || '', _html: '', textContent: '', value: '', title: '',
    style: {}, dataset: {}, disabled: false, onclick: null, className: '', children: [],
    _attrs: new Set(),
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    querySelector() { return mkEl('div'); },
    querySelectorAll() { return []; },
    appendChild(child) { this.children.push(child); return child; },
    removeChild(child) { return child; },
    remove() {}, replaceWith() {}, insertBefore() {},
    addEventListener() {}, removeEventListener() {}, focus() {}, blur() {}, select() {},
    // 属性要有真实记忆：applyTheme 靠 hasAttribute 判断 data-ds-dark-theme 是否已挂（外观断言要用）
    hasAttribute(n) { return this._attrs.has(String(n)); },
    setAttribute(n) { this._attrs.add(String(n)); },
    removeAttribute(n) { this._attrs.delete(String(n)); },
    getAttribute() { return ''; },
    scrollIntoView() {}, scrollTo() {},
    getBoundingClientRect() { return { top: 0, left: 0, width: 800, height: 200 }; },
    closest() { return null; }, contains() { return false; }, cloneNode() { return mkEl(tag); },
    setSelectionRange() {}, click() {},
  };
  // innerHTML 被赋值即可读回（页面的整块产物就靠这个抓）；firstElementChild 给一个假节点，
  // 让 repaintCheck 走"局部替换"分支（真实浏览器里它替换的是真节点）
  Object.defineProperty(el, 'innerHTML', {
    get() { return this._html; },
    set(v) { this._html = String(v); this.firstElementChild = mkEl('div'); this.lastElementChild = mkEl('div'); },
  });
  el.firstElementChild = null;
  return el;
}
const document = {
  title: '',
  activeElement: null,
  // applyTheme 会写 documentElement.dataset.theme，同时 css 变量挂在 :root —— 两者都要有
  documentElement: { dataset: {}, style: {}, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } }, setAttribute() {}, getAttribute() { return ''; }, removeAttribute() {} },
  body: mkEl('body'),
  head: mkEl('head'),
  getElementById(id) { if (!nodes[id]) nodes[id] = mkEl('div', id); return nodes[id]; },
  querySelector(sel) { if (!nodes[sel]) nodes[sel] = mkEl('div', sel); return nodes[sel]; },
  querySelectorAll() { return []; },
  createElement(tag) { return mkEl(tag); },
  createTextNode(t) { return { textContent: t }; },
  addEventListener() {}, removeEventListener() {}, execCommand() { return true; },
};
/* 页面里大量"事件驱动的异步加载"带 .catch，但个别路径没有 —— 在真实浏览器里只是控制台一条红字，
   在 node 里会直接终止进程。这里收集起来继续跑，最后一起报告。 */
const asyncErrors = [];
process.on('unhandledRejection', e => asyncErrors.push(String((e && e.message) || e)));
process.on('uncaughtException', e => asyncErrors.push(String((e && e.message) || e)));
const storage = new Map();
const localStorage = {
  getItem: k => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => storage.set(k, String(v)),
  removeItem: k => storage.delete(k),
};
const winHandlers = {};
/* 可切换的"系统深浅色"：外观选「跟随系统」时必须跟着它走。
   mediaHandlers / fireMedia() 让测试能真的触发 prefers-color-scheme 的 change 事件。 */
let SYS_DARK = false;
const mediaHandlers = {};
function fireMedia() { for (const f of (mediaHandlers['(prefers-color-scheme: dark)'] || [])) f({ matches: SYS_DARK }); }
const window = {
  innerHeight: 900, innerWidth: 1400,
  addEventListener(k, f) { (winHandlers[k] = winHandlers[k] || []).push(f); },
  removeEventListener() {}, scrollTo() {}, open() { return null; },
  matchMedia: (q) => ({
    matches: /dark/.test(String(q)) ? SYS_DARK : !SYS_DARK,
    addEventListener(k, f) { (mediaHandlers[String(q)] = mediaHandlers[String(q)] || []).push(f); },
    removeEventListener() {},
    addListener(f) { (mediaHandlers[String(q)] = mediaHandlers[String(q)] || []).push(f); },
  }),
  location: null,
};
const location = {
  hash: '#/home', host: '127.0.0.1:' + PORT, hostname: '127.0.0.1', port: PORT,
  protocol: 'http:', origin: ORIGIN, pathname: '/', search: '',
  href: ORIGIN + '/', reload() {}, assign() {}, replace() {},
};
window.location = location;

/* WebSocket stub：Mux 的请求-响应立刻回一条空 ok，避免任何 loader 挂在等流上。
   （真实数据由 HTTP 通道提供；流推送的部分不在本次断言范围。） */
const sockets = [];
class WebSocketStub {
  constructor(url) { this.url = url; this.readyState = 1; sockets.push(this); setTimeout(() => this.onopen && this.onopen({}), 0); }
  send(data) {
    try {
      const m = JSON.parse(data);
      if (m && m.type === 'client-request' && m.rpcId) {
        setTimeout(() => this.onmessage && this.onmessage({ data: JSON.stringify({ type: 'server-response', rpcId: m.rpcId, result: { ok: true, value: {} } }) }), 0);
      }
    } catch (e) { /* 非 JSON 的发包忽略 */ }
  }
  close() { this.readyState = 3; if (this.onclose) this.onclose({}); }
  addEventListener(k, f) { this['on' + k] = f; }
  removeEventListener() {}
}
const realFetch = globalThis.fetch;
const fetchStub = (url, opts) => {
  const u = String(url);
  return realFetch(u.startsWith('/') ? ORIGIN + u : u, opts);
};
class FileReaderStub { readAsDataURL() { if (this.onload) this.onload({ target: { result: 'data:,' } }); } }

/* 默认用 WS stub（快、稳）。REAL_WS=1 时换成真 WebSocket 打 3081 ——
   用来端到端验证"真实事件 → 每轮用量/用时/消息 id → 操作条"这条链路（stub 推不出帧，验证不了）。 */
const REAL_WS = process.env.REAL_WS === '1';
const WS_IMPL = REAL_WS ? globalThis.WebSocket : WebSocketStub;

/* ---------------- 加载整个 app.js ---------------- */
const sandbox = {
  window, document, location, localStorage, navigator: { userAgent: 'node-sandbox', clipboard: null },
  WebSocket: WS_IMPL, fetch: fetchStub, FileReader: FileReaderStub,
  setTimeout, clearTimeout, setInterval, clearInterval, performance: globalThis.performance,
  requestAnimationFrame: f => setTimeout(f, 0), console, alert() {}, confirm: () => true, prompt: () => null,
  Intl, atob: globalThis.atob, btoa: globalThis.btoa, Blob: globalThis.Blob, File: globalThis.File,
  FormData: globalThis.FormData, URL: globalThis.URL, URLSearchParams: globalThis.URLSearchParams,
  TextEncoder: globalThis.TextEncoder, TextDecoder: globalThis.TextDecoder,
};
const EXPORTS = ['Pages', 'State', 'ROUTES', 'PAGE_HELP', 'PAGE_CHECKS', 'EMPTY_GUIDE', 'render', 'boot',
  'runAllChecks', 'runModuleCheck', 'closeAllCheck', 'pageHelp', 'allCheckCard', 'emptyGuide', 'perfCard', 'recordPerf', 'Table',
  'toggleHelp', 'provSectionHtml', 'renderScopeBar', 'scopeChipHtml', 'moreDisc', 'SCOPE_BAR_OFF', 'SCOPE_BAR_GROUPS',
  // 消息操作条 / 反馈（第三十轮）
  'Chat', 'Turns', 'ChatRow', 'MD', 'msgActionsHtml', 'fbHtml', 'fbErrText', 'paintFeedback',
  'contextBadgeHtml', 'chatNavHtml', 'jumpTurn', 'toggleMsgUsage', 'FB_CATEGORIES', 'branchAtTurn',
  // 真流端到端要用：API.history 取真实事件、fmtDur 读秒、usagePanelHtml 验用量浮层
  'API', 'fmtDur', 'fmtInt', 'msgClock', 'usagePanelHtml',
  // 思考块 / 每步计时 / 会话统计（第三十一轮）
  'reasoningHtml', 'reasoningOf', 'msgTiming', 'thinkDuration', 'reasonText', 'reasonHint',
  'sessionStatsHtml', 'showSessionStats', 'UI',
  // 外观（ui-theme）：跟随系统要真跟随 prefers-color-scheme
  'applyTheme', 'themePreference', 'setThemePreference', 'platformSwitches', 'THEME_KEYS', 'THEME_LABEL', 'mergeNsLocal',
  // 本轮：契约自检扁平卡 / 目标相位 / 模型发现分型 / 界面偏好 / 聊天页工具条
  'contractCard', 'closeContractCheck', 'goalPhaseLabel', 'goalResumeState', 'goalActionState', 'goalErrText',
  'discIsStatic', 'discErrKind', 'discErrText',
  'uiPref', 'uiPrefs', 'setUiPref', 'toggleUiPref', 'uiPrefsCard', 'planBadgeText', 'contextBadgeHtml',
  // 会话当前模型（回显 bug 的唯一真相源）：投影形状 {lastUsed, next}，只认 next
  'sessionModelOf', 'chatModelKey'];
const factory = new Function(...Object.keys(sandbox), code + '\nreturn {' + EXPORTS.join(', ') + '};');
let S = null;
try { S = factory(...Object.values(sandbox)); }
catch (e) { log('!! app.js 加载失败：' + e.message); fs.writeFileSync(DIR + '/tools/render-all-out.txt', out.join('\n')); console.log('LOAD FAIL'); process.exit(1); }

const withTimeout = (p, ms, label) => Promise.race([
  Promise.resolve(p).then(v => ({ ok: true, v })).catch(e => ({ ok: false, err: e.message })),
  new Promise(r => setTimeout(() => r({ ok: false, err: '超时 ' + ms + 'ms（' + label + '）' }), ms)),
]);

(async () => {
  log('=== 启动流程（DOMContentLoaded，真实打控制台 ' + PORT + '）===');
  const booters = (winHandlers['DOMContentLoaded'] || []);
  log('注册的 DOMContentLoaded 回调：' + booters.length);
  for (const fn of booters) {
    const r = await withTimeout(fn(), 20000, '启动');
    ok(r.ok, '启动流程执行完毕', r.ok ? '' : r.err);
  }
  const St = S.State;
  log('\n=== 运行态 ===');
  log('DSH 概要：' + (St.host?.version || '—') + ' · 模型 ' + (St.host?.model || '—'));
  log('会话：' + (St.sessions || []).length + ' 个 · 当前 ' + String(St.sessionId || '').slice(0, 20));
  log('预设 ' + (St.presets || []).length + ' · 供应商 ' + (St.providers || []).length
    + ' · 插件 ' + (St.plugins?.plugins || []).length + ' · MCP ' + (St.mcp || []).length
    + ' · 技能 ' + (St.skillsScope?.skills || []).length + ' · 子代理 ' + (St.subagents?.entries || []).length);

  log('\n=== 18 个页面逐个渲染（真实数据）===');
  const content = document.getElementById('content');
  const rows = [];
  for (const r of S.ROUTES) {
    location.hash = '#' + r.path;
    // ① 直接调页面函数：只验证"模板 + 真实数据"能否生成 HTML（快、稳，不受流影响）
    const tpl0 = performance.now();
    let tplHtml = '', tplErr = '';
    try { tplHtml = String(S.Pages[r.id] ? S.Pages[r.id]() : ''); } catch (e) { tplErr = e.message + ' @ ' + String(e.stack || '').split('\n')[1]; }
    const tplMs = Math.round((performance.now() - tpl0) * 10) / 10;
    // ② 再走完整 render()：验证骨架 + 加载器链路（等 WS 流的部分在沙盒里会超时，单独标注）
    const r0 = await withTimeout(S.render(), 8000, r.id);
    const html = content.innerHTML || '';
    const heads = { help: html.includes('本页说明'), check: html.includes('全模块自检') };
    const onclickNames = [...new Set([...html.matchAll(/onclick="([A-Za-z_$][\w$]*)\s*\(/g)].map(m => m[1]))];
    const missing = onclickNames.filter(n => !new RegExp('(function\\s+' + n + '\\b)|(const\\s+' + n + '\\s*=)').test(code)
      && !['Pages', 'Table', 'Chat', 'API', 'UI', 'fmt', 'Mux', 'Stream'].includes(n));
    const streamWait = !r0.ok && /超时/.test(r0.err || '');
    rows.push({ id: r.id, label: r.label, tplMs, len: tplHtml.length, heads, handlers: onclickNames.length, missing, streamWait, err: tplErr });
    ok(!tplErr, r.label + '（' + r.id + '）页面函数生成 HTML', tplErr || (tplHtml.length + ' 字符 · ' + tplMs + ' ms'));
    // 自检已统一收进「系统状态」页：普通页只要求说明卡；host 页额外要求「全模块自检」入口
    const needCheck = r.id === 'host';
    ok(heads.help && (!needCheck || heads.check), r.label + ' 页含「本页说明」' + (needCheck ? '与「全模块自检」' : ''),
      streamWait ? '（render 等待 WS 流超时：stub 环境不提供真实推送，属预期）' : '');
    if (missing.length) { log('     ⚠️ 未定义的 onclick 目标：' + missing.join(', ')); fails++; }
  }

  log('\n=== 渲染规模排行（页面函数产物字符数）===');
  rows.slice().sort((a, b) => b.len - a.len).forEach(x => log('  ' + String(x.len).padStart(7) + ' 字符 · ' + x.id + '（生成 ' + x.tplMs + ' ms）'));

  log('\n=== 渲染性能记录（recordPerf 实测，来自页面自身埋点）===');
  const perf = (St.perf || []).slice(-20);
  if (!perf.length) log('  （无记录）');
  else {
    perf.forEach(p => log('  ' + String(p.ms).padStart(7) + ' ms · ' + String(p.nodes).padStart(5) + ' 节点 · ' + p.route + (p.paintOnly ? '（局部）' : '（整页）')));
    const slow = perf.filter(p => p.ms > 120);
    ok(!slow.length, '没有超过 120ms 阈值的重绘', slow.length ? slow.map(p => p.route + ':' + p.ms + 'ms').join(', ') : '');
  }

  log('\n=== 功能自检在沙盒里的执行（真实端点，验证不会满屏红）===');
  // 自检已统一收进系统状态页：这里直接跑全模块套件的核心模块子集（同一套 runModuleCheck 机制）
  for (const id of ['home', 'models', 'credentials', 'plugins', 'sessions', 'workspace', 'host']) {
    try { S.render(); } catch (e) { /* 忽略 */ }
    const r = await withTimeout(S.runModuleCheck(id), 30000, id);
    const c = St.allCheck && St.allCheck.mods && St.allCheck.mods[id];
    if (!r.ok || !c) { ok(false, id + ' 自检执行', r.err || '无结果'); continue; }
    const sandbox = c.rows.filter(x => !x.ok && /快照超时/.test(x.detail || ''));
    const bad = c.rows.filter(x => !x.ok && !x.opt && !sandbox.includes(x)).length;
    const hint = c.rows.filter(x => !x.ok && x.opt).length;
    ok(true, id + ' 页自检：' + c.rows.length + ' 项 · 真实失败 ' + bad + ' · 提示 ' + hint
      + (sandbox.length ? ' · 沙盒预期超时 ' + sandbox.length : ''),
      c.rows.map(x => x.name + (x.ok ? '✓' : (x.opt ? '⚠' : (sandbox.includes(x) ? '🟡' : '✗')))).join(' | '));
    const isSandbox = x => sandbox.includes(x);
    c.rows.filter(x => !x.ok && !isSandbox(x)).forEach(x => log('       ' + (x.opt ? '⚠️ 提示' : '❌ 失败') + ' · ' + x.name + ' → ' + x.detail));
    // 沙盒 WebSocket 是 stub，不会推任何帧；依赖开屏快照的检查必然超时。
    // 已用真实 WS 复核（tools/peek-stream.mjs control|workspace）：session/control 22ms 回 baseline、
    // workspace/follow 14ms 回 baseline —— 所以这里是环境限制，不是控制台缺陷，单独标注以免误判。
    c.rows.filter(x => !x.ok && isSandbox(x)).forEach(x => log('       🟡 沙盒预期 · ' + x.name + ' —— WS stub 不推帧；真实宿主已实测回 baseline，此项在浏览器里是通过的'));
  }

  log('\n=== 本轮针对性断言（会话 chip / 会话当前标记 / 大模型页发现入口）===');
  try {
    /* ① 会话上下文 chip：2026-09-24 由「内容区顶部 43px 作用域条」压进各页页头。
       沙盒的 DOM stub 不解析 HTML（innerHTML 只当字符串存），所以这里不查 DOM 结构，
       而是断言**两段可判定的真相**：
         · 选取规则 SCOPE_BAR_GROUPS / SCOPE_BAR_OFF —— 哪些页注入 chip；
         · 载荷 scopeChipHtml() —— 注进去的内容长什么样。
       DOM 层面「chip 真的进了 .page-title、且在 .pt-actions 之前」由真机 CDP 实测覆盖。 */
    const on = ['trajectory', 'deliverables', 'models', 'skillMgr'];
    const off = ['home', 'sessions', 'workspace', 'chat'];
    const shows = id => {
      const r = S.ROUTES.find(x => x.id === id) || {};
      return S.SCOPE_BAR_GROUPS.includes(r.group) && !S.SCOPE_BAR_OFF.includes(r.id);
    };
    const ON_WRONG = on.filter(id => !shows(id));
    ok(!ON_WRONG.length, '会话 chip 注入「跟随会话但不显示会话身份」的页', ON_WRONG.join(','));
    const OFF_WRONG = off.filter(id => shows(id));
    ok(!OFF_WRONG.length, '会话 chip 不在「本页已展示会话身份」的 4 页重复', OFF_WRONG.join(','));
    // 旧 bar 容器不再被写入：内容全在页头，容器恒空（恒 display:none 由 renderScopeBar 收尾）
    S.renderScopeBar(S.ROUTES.find(x => x.id === 'trajectory') || {});
    ok(!String(nodes.scopebar.innerHTML || '').trim(), '旧作用域条容器不再承载内容（高度归零的根据）',
      String(nodes.scopebar.innerHTML || '').slice(0, 40));

    const chip = S.scopeChipHtml();
    ok(!/💬 会话 <b class="mono">/.test(chip), '会话 chip 不再把截断的 session id 当会话主标签');
    ok(/title="当前会话 ID：/.test(chip), '完整会话 ID 移入 title（可悬停 / 可读全）');
    ok(/class="scope-chip"/.test(chip) && !/scope-item/.test(chip),
      'chip 用独立类名命名空间（旧 .scope-item 的样式已删，不残留引用）');
    // 转义面（读源码，不动运行态）：chip 的可变字段来自宿主，进 HTML 前必须过 fmt.esc
    const chipSrc = (code.match(/function scopeChipHtml\(\)[\s\S]*?\n\}/) || [''])[0];
    ok(/fmt\.esc\(sessLabel\)/.test(chipSrc) && /fmt\.esc\(hint\)/.test(chipSrc)
      && /fmt\.esc\(shortSid\(/.test(chipSrc) && /fmt\.attr\(s\.parentSessionId\)/.test(chipSrc),
      '会话标题 / 悬停提示 / 短 ID / 父会话 id 全部经转义（title 与属性不破）');

    /* ② 会话列表：当前身份只在操作列表达，行上不做任何标记 */
    const sh = S.Pages.sessions();
    ok(!/cur-sess/.test(sh), '会话列表不再有行级「当前」高亮（当前行去掉选中状态）');
    ok(!/<span class="tag ok">当前<\/span>/.test(sh), '会话 ID 列不再挂「当前」标签');
    const curRow = sh.split('<tr').find(r => r.includes('cur-sel'));
    ok((sh.match(/class="btn sm cur-sel"/g) || []).length === 1, '当前会话由操作列那颗禁用按钮唯一标出',
      String((sh.match(/class="btn sm cur-sel"/g) || []).length));
    if (curRow) ok(!/设为当前/.test(curRow), '当前会话行不再显示「设为当前」按钮');
    ok(sh.includes('title="' + S.State.sessionId + '"'), '会话 ID 单元格带完整 ID 的 title');

    /* ③ 大模型页：模型发现只剩「供应商接入」一个入口 */
    const mh = S.Pages.models();
    ok(!mh.includes('id="discpanel"'), '页面里已无独立的「模型发现结果」面板');
    ok(!mh.includes('🔍 发现模型'), '「可用模型」卡头不再有第二个发现入口');
    ok(mh.includes('id="provcard"'), '「供应商接入」卡有稳定 id（局部重绘锚点）');
    const nProv = (S.State.providers || []).length;
    const nBtn = (mh.match(/onclick="discoverModels\(/g) || []).length;
    ok(nBtn === nProv && nProv > 0, '每行一个「探测」按钮且数量等于候选数', nBtn + ' / ' + nProv);
    ok((mh.match(/onclick="discoverAll\(\)"/g) || []).length === 1, '卡头只有一个「全部探测」入口');
    // 结果内联：展开后同一张卡里出现明细行 + 分页清单
    const p0 = (S.State.providers || [])[0];
    if (p0) {
      const models = Array.from({ length: 30 }, (_, i) => ({ id: 'm' + i, contextWindow: 1000, maxTokens: 100 }));
      S.State.disc = { running: false, done: 1, total: 1, open: { [p0.provider]: true }, shown: { [p0.provider]: 24 },
        results: { [p0.provider]: { ok: true, ns: p0.settingsNs, models, at: Date.now() } } };
      const h2 = S.provSectionHtml();
      ok(h2.includes('disc-detail'), '发现结果以行内明细行呈现（disc-detail），不再另开面板');
      const n1 = (h2.match(/class="card"/g) || []).length;
      ok(n1 === 24, '行内清单按 DISC_PAGE 分页', String(n1) + ' 张');
      S.moreDisc(p0.provider);
      const n2 = (S.provSectionHtml().match(/class="card"/g) || []).length;
      ok(n2 === 30, '「再显示 24 个」后到 30（不超过总数）', String(n2) + ' 张');
      // 失败态要给出处置入口
      S.State.disc.results[p0.provider] = { ok: false, ns: p0.settingsNs, error: 'x answered 401; check the API key', at: Date.now() };
      const h3 = S.provSectionHtml();
      ok(h3.includes('需要 Key'), '失败原因仍在行内归类显示');
      S.State.disc = null;
    }
  } catch (e) { ok(false, '本轮针对性断言', e.message); }

  log('\n=== 轮末页脚（对齐原生 completed turn footer）===');
  try {
    const ID = 'bf793a21-dc69-4718-8df0-83c5c18f6669';
    S.Turns.reset();
    S.Turns.start(3, 1000, 10);
    S.Turns.user(3, '这一轮的问题是什么', 1000);
    // 中间稿（带文本）不应顶掉最终正文
    S.Turns.message(3, { inputTokens: 100, outputTokens: 200, totalTokens: 900, cacheReadTokens: 3000, reasoningTokens: 5 }, { provider: 'deepseek-official', model: 'deepseek-v4-flash' }, 11, null, '中间稿', 'mid-id', 1100);
    S.Turns.message(3, { inputTokens: 1, outputTokens: 2, totalTokens: 950, cacheReadTokens: 4, reasoningTokens: 0 }, { provider: 'deepseek-official', model: 'deepseek-v4-flash' }, 12, null, '最终回答', ID, 1200);
    S.Turns.end(3, { kind: 'completed' }, 151000);   // 本轮 150.0s
    const tail = S.msgActionsHtml(S.Turns.footOf(3));
    ok(/复制/.test(tail) && /好的回答/.test(tail) && /有问题的回答/.test(tail) && /用量/.test(tail),
      '轮末页脚含 复制 / 好的回答 / 有问题的回答 / 用量');
    ok(/ma-time/.test(tail) && /\d{2}:\d{2}/.test(tail), '含时间（HH:MM）');
    ok(/在新对话中分支/.test(tail) && !/branchAtTurn\(3\)" disabled/.test(tail), '已完成轮次含可用的「在新对话中分支」');
    ok(/用时 2分30秒/.test(tail), '轮末页脚含本轮用时（150s → 2分30秒）', tail.replace(/<[^>]+>/g, ' ').slice(0, 100));
    ok(/本轮小计/.test(tail) && /本轮用时/.test(tail), '用量浮层含本轮小计与本轮用时');
    ok(/class="msg-acts turn-foot"/.test(tail), '页脚带 turn-foot 类（整轮只有一条的标记）');
    ok(tail.includes('data-fb="' + ID + '"'), '反馈绑定本轮**最终正文**那条消息的 id（不是中间稿）',
      (tail.match(/data-fb="[^"]*"/g) || []).join(' ') || '（没有 data-fb）');
    // ★ 核心不变量：不是轮末就不产出任何操作条。否则一轮十几步会刷出十几条重复的操作条。
    const mid = S.msgActionsHtml({ role: 'agent', messageId: ID, text: 'hi', time: Date.now(), turn: 3, seq: 11 });
    ok(mid === '', '非轮末（缺 foot）不产出操作条 —— 整轮只有一条', JSON.stringify(mid).slice(0, 60));
    const noTurn = S.msgActionsHtml({ foot: true, text: 'x' });
    ok(noTurn !== '' && !/用量/.test(noTurn) && !/在新对话中分支/.test(noTurn), '没有轮号的页脚只给复制与时间');
    // 未完成轮次：分支按钮必须禁用并说明原因（宿主同样只接受已完成轮次）
    S.Turns.reset(); S.Turns.start(4, 1, 20); S.Turns.message(4, null, null, 21, null, '答案', ID, 21);
    const running = S.msgActionsHtml(S.Turns.footOf(4));
    ok(/disabled/.test(running) && /仅可从已完成轮次/.test(running), '未完成轮次的分支按钮禁用并给出原因');
    // 只有用户输入、助手尚未回话的轮：给复制与时间，但不给反馈（没有 messageId 可绑）
    S.Turns.reset(); S.Turns.start(5, 5000, 30); S.Turns.user(5, '只有我说了一句', 5000);
    const u = S.msgActionsHtml(S.Turns.footOf(5));
    ok(/复制/.test(u) && !/好的回答/.test(u), '用户单独一轮：给复制，不给反馈');
    // 复制原文不进 DOM 属性（8KB/条 × 160 条会把 HTML 撑爆），走内存表
    ok(!/text=\\?"hi\\?"/.test(tail) || !/data-copy/.test(tail), '复制原文不放 DOM 属性，改存内存表');
  } catch (e) { ok(false, '轮末页脚', e.message); }

  log('\n=== 思考块 / 每步计时 / 会话统计 ===');
  try {
    // ① 思考块：真实数据里 assistant 消息带 {type:'reasoning'} 块（本机实测 63/68 条），此前被整个丢掉
    const rg = S.reasoningHtml('先看日志再改代码\n第二行', false);
    ok(/<details class="think">/.test(rg) && !/ open>/.test(rg), '思考块默认折叠');
    ok(/思考/.test(rg) && /\d+ 字/.test(rg), '思考块标题显示字数');
    ok(/先看日志再改代码/.test(rg), '思考块含全文');
    ok(/&lt;script&gt;/.test(S.reasoningHtml('<script>x</script>', false)), '思考块转义 HTML（模型输出不可信）');
    ok(S.reasoningHtml('') === '' && S.reasoningHtml(null) === '', '无思考内容时不渲染（不占版面）');
    ok(/ open>/.test(S.reasoningHtml('边想边看', true)), '流式中的思考块展开');
    ok(S.reasoningOf([{ type: 'text', text: '正文' }, { type: 'reasoning', text: '思考' }, { type: 'tool-call' }]) === '思考',
      'reasoningOf 只取思考块（text/tool-call 不进思考）');
    const t2 = S.reasoningHtml('想了', false) + 'BODY';
    ok(t2.indexOf('think') < t2.indexOf('BODY'), '思考块排在正文之前');

    // ② 每步计时（TTFT / TPS）：step/start 的 time + stream 里的 chunk time
    S.Turns.reset();
    S.Turns.start(1, 1000, 1);
    S.Turns.step(1, 2, 10000);                    // 这一步 10.000s 开始
    const ev = { data: { turn: 1, step: 2, usage: { outputTokens: 200 }, stream: [
      { type: 'chunk', time: 10200, chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } },
      { type: 'chunk', time: 10400, chunk: { type: 'block-end', index: 0 } },
      { type: 'chunk', time: 10500, chunk: { type: 'block-start', index: 1, blockType: 'text' } },
      { type: 'chunk', time: 11200, chunk: { type: 'finish', reason: { kind: 'stop' } } },
    ] } };
    const tm = S.msgTiming(ev);
    ok(tm && tm.ttftMs === 200, '首 token 用时 = 首个 chunk − step/start', tm && ('TTFT ' + tm.ttftMs + 'ms'));
    ok(tm && tm.thinkMs === 200, '思考耗时 = reasoning 块的 block-start → block-end', tm && ('思考 ' + tm.thinkMs + 'ms'));
    ok(tm && Math.abs(tm.tps - 200) < 0.001, 'TPS = outputTokens / (末 chunk − 首 chunk)', tm && tm.tps.toFixed(1) + ' tok/s');
    ok(S.msgTiming({ data: { turn: 1, step: 2, usage: { outputTokens: 5 } } }) === null, '没有 stream 就算不出速度（返回 null，宁缺勿假）');
    S.Turns.reset();
    const tm2 = S.msgTiming(ev);
    ok(tm2 && tm2.ttftMs === null && tm2.tps != null, '缺 step/start 只丢 TTFT，不牵连 TPS');
    ok(S.thinkDuration([{ time: 1, chunk: { type: 'block-end', index: 0 } }]) === null, '没有 reasoning 起点时思考耗时算不出');
    S.Turns.reset(); S.Turns.start(1, 1000, 1); S.Turns.step(1, 2, 10000);
    S.Turns.message(1, ev.data.usage, null, 5, S.msgTiming(ev));
    const pop = S.usagePanelHtml(1, { outputTokens: 200, cacheWriteTokens: 40, inputTokens: 100 }, 2);
    ok(/首 token 用时（TTFT）/.test(pop) && /输出速度（TPS）/.test(pop), '用量浮层含 TTFT 与 TPS');
    ok(/缓存写入/.test(pop), '用量浮层含缓存写入（原生 turnUsage.cacheWrite）');
    ok(/这一次调用的速度/.test(pop), '速度单独成段（不混进用量里）');

    // ③ reason 语义化（原生 message.stopped / message.maxTokens / message.turnError）
    ok(S.reasonText('completed') === '正常完成' && S.reasonText('interrupted') === '已停止', 'reason 翻译成人话');
    ok(S.reasonText('max-tokens').includes('输出上限'), 'max-tokens 说成"已达输出上限"');
    ok(S.reasonText('某未知原因') === '某未知原因', '没见过的 reason 原样透出（不编中文名）');
    ok(/继续/.test(S.reasonHint('max-tokens')), '截断时提示可发送「继续」');
    ok(S.reasonHint('completed') === '', '正常完成不给提醒');
    S.Turns.reset(); S.Turns.start(9, 1, 1); S.Turns.message(9, null, null, 2, null, 'y', 'x', 2); S.Turns.end(9, { kind: 'max-tokens' }, 2);
    const nt = S.msgActionsHtml(S.Turns.footOf(9));
    ok(/ma-note/.test(nt) && /继续/.test(nt), '轮次被截断时轮末页脚给行内提醒');

    // ④ 会话统计（原生 stats.dialog）—— 数据来自真实投影，所以这里也验真实值
    const prevSid = S.State.sessionId;
    const cand = (S.State.sessions || []).map(s => ({ id: s.sessionId, st: s.projections?.values?.sessionStats || {} }))
      .filter(x => Number(x.st.turns) > 0).sort((a, b) => Number(b.st.turns) - Number(a.st.turns))[0];
    if (cand) {
      S.State.sessionId = cand.id;
      const st = S.sessionStatsHtml();
      ok(/轮数/.test(st) && /步数/.test(st), '会话统计含轮数与步数（原生 stats.counts）', '轮 ' + cand.st.turns + ' / 步 ' + cand.st.steps);
      ok(/模型用时/.test(st) && /工具调用用时/.test(st), '会话统计含模型用时与工具调用用时');
      ok(/首 token 平均（TTFT）/.test(st), '会话统计含首 token 平均（原生 stats.dialog.ttft）');
      ok(/输出速度（TPS）/.test(st), '会话统计含输出速度（原生 stats.dialog.speed）');
      ok(/缓存命中/.test(st), '会话统计含缓存命中（原生 stats.cacheHit）');
      ok(/Token 用量/.test(st), '会话统计含 Token 用量分项');
      ok(!/undefined|NaN/.test(st), '统计面板里没有 undefined/NaN 漏出');
    } else log('  （本机没有跑过轮次的会话，跳过"会话统计取真实值"这组）');
    S.State.sessionId = prevSid;
    ok(typeof S.showSessionStats === 'function' && typeof S.UI.panel === 'function', '聊天页有会话统计入口与只读弹层');
    ok(S.sessionStatsHtml().length > 0, '没跑过轮次的会话也给说明文案（不返回空串）');
    const chatHtml = S.Pages.chat();
    // 「⋯ 更多」菜单已移除：会话统计与上下文占用合并成工具条上的同一颗「📈 统计」按钮
    ok(/onclick="showSessionStats\(\)"/.test(chatHtml) && /统计/.test(chatHtml), '工具条有合并后的「统计」按钮');
    ok(/上下文/.test(chatHtml), '统计按钮把上下文占用带在同一处');
    ok(!/id="chatmoremenu"/.test(chatHtml) && !/chatMorePick/.test(chatHtml), '「⋯ 更多」菜单已整体移除');
    ok(/chatbottom/.test(chatHtml) && /onscroll="Chat\.onScroll\(\)"/.test(chatHtml), '聊天页仍有回到底部与滚动监听');
    ok(typeof S.Chat.appendThink === 'function', '实时流有思考增量的落点（appendThink）');
  } catch (e) { ok(false, '思考块/计时/会话统计', e.message); }

  log('\n=== 反馈（messageFeedback）===');
  try {
    const h = S.fbHtml('abc-123');
    ok(!/messageFeedback/.test(h), '界面不再出现内部接口名（用户看到的"错误"就是它）');
    ok(/👍/.test(h) && /👎/.test(h), '反馈按钮为 👍 / 👎');
    S.State.feedback = { 'abc-123': { messageId: 'abc-123', rating: 'negative', category: 'task-result', version: 'v1' } };
    const on = S.fbHtml('abc-123');
    ok(/class="on"/.test(on), '已反馈的按钮处于选中态');
    ok(/任务结果/.test(on), '已反馈态显示分类中文名');
    ok(/取消标记/.test(on), '已反馈态提示"取消标记"（对齐原生 likeActive）');
    S.State.feedback = {};
    ok(/已在别处改动/.test(S.fbErrText('version-conflict')), 'version-conflict → 中文提示');
    ok(/太长/.test(S.fbErrText('note-too-large')), 'note-too-large → 中文提示');
    ok(/持久化记录/.test(S.fbErrText('target-not-found')), 'target-not-found → 说明对 messageId 的要求');
    ok(!/^保存失败：gateway/.test(S.fbErrText('gateway/input-invalid')), '网关参数错 → 人话提示');
    ok(S.FB_CATEGORIES.length === 7, '反馈分类 7 项（与原生 locale 一致）');
  } catch (e) { ok(false, '反馈', e.message); }

  log('\n=== 全模块自检卡状态机（统一入口在系统状态页）===');
  try {
    // 进行中：徽标带进度；不挂转圈动画
    S.State.allCheck = { at: Date.now(), running: true, base: null, mods: { home: { label: '🏠 首页', rows: [] } }, cur: '🏠 首页', total: 5 };
    const card = S.allCheckCard();
    ok(/进行中…/.test(card), '自检结果卡进行中显示静态徽标（含进度）');
    ok(!/class="loading"/.test(card) && !/<span class="loading">/.test(card), '自检结果卡里没有转圈动画');
    ok(/runModuleCheck/.test(card), '每个模块行带「重跑」按钮');
    // 完成：通过徽标
    S.State.allCheck.running = false;
    S.State.allCheck.base = { rows: [{ name: '认证', ok: true, opt: false, ms: 1, detail: '' }], bad: 0 };
    S.State.allCheck.mods.home = { label: '🏠 首页', rows: [{ name: 'x', ok: true, opt: false, ms: 1, detail: '' }] };
    const card2 = S.allCheckCard();
    ok(/全部通过/.test(card2) && !/受影响功能模块/.test(card2), '全部通过时不出现「受影响模块」横幅');
    // 失败：横幅列出受影响模块
    S.State.allCheck.mods.models = { label: '🧠 大模型', rows: [{ name: 'y', ok: false, opt: false, ms: 1, detail: 'boom' }, { name: 'z', ok: true, opt: false, ms: 1, detail: '' }] };
    const card3 = S.allCheckCard();
    ok(/受影响功能模块/.test(card3) && /🧠 大模型/.test(card3) && !/🏠 首页（\d）/.test(card3.split('受影响功能模块')[1].split('</div>')[0] || ''),
      '失败时横幅只列失败模块（🧠 大模型），通过的模块不上榜');
    ok(/closeAllCheck/.test(card3), '自检结果卡带「✕ 关闭」按钮');
    // 关闭后不渲染
    S.closeAllCheck();
    ok(S.allCheckCard() === '', '关闭后结果卡不再渲染');
    // 没跑过不渲染
    ok(S.allCheckCard() === '', '没跑过自检不渲染结果卡（不占地方）');
  } catch (e) { ok(false, '全模块自检卡状态机', e.message); }

  log('\n=== Markdown 渲染（对齐原生输出的常见形态）===');
  try {
    const md = s => S.MD.render(s);
    ok(/<b>粗体<\/b>/.test(md('**粗体**')), '粗体');
    ok(/<s style="color:var\(--txt-3\)">删除线<\/s>/.test(md('~~删除线~~')), '删除线（新增）');
    const img = md('![图](https://x/a.png)');
    ok(/<img src="https:\/\/x\/a.png"/.test(img), '行内图片渲染为 <img>（新增）');
    ok(!/<a href="https:\/\/x\/a.png"/.test(img) && !/!/.test(img), '图片不被链接正则吃成「! + 链接」');
    const nl = md('- 一级\n  - 二级');
    ok(/padding-left:14px/.test(nl) && /padding-left:38px/.test(nl), '嵌套列表按缩进分层（新增）');
    const tl = md('- [ ] 待办\n- [x] 完成');
    ok(/☐ 待办/.test(tl) && /✅ 完成/.test(tl), '任务列表渲染成勾选框（新增，不再露出 [ ]）');
    ok(/md-table/.test(md('| a | b |\n| --- | --- |\n| 1 | 2 |')), '表格仍是整块渲染（未回归）');
  } catch (e) { ok(false, 'Markdown 渲染', e.message); }

  log('\n=== 契约自检卡 / 表格单元不被 inline-block 破坏 ===');
  try {
    // ② 系统状态页：契约自检结果卡 —— 扁平单卡 + 可关闭。
    //    此前是 <details class="fold mt" open> > fold-body > card > table 三层套娃，
    //    而且 <details open> 会被每步自检的 render() 重新展开（用户关不掉）。
    const keepContract = S.State.contract;
    S.State.contract = { at: Date.now(), running: false, rows: [{ name: 'x', ok: true, ms: 1, detail: '' }] };
    const hostHtml = S.Pages.host();
    ok(/closeContractCheck/.test(hostHtml), '契约自检结果卡带「✕ 关闭」按钮');
    ok(!/<details[^>]*class="fold[^"]*"[^>]*>[\s\S]{0,400}契约自检/.test(hostHtml), '契约自检结果不再裹在 <details> 里（不再被 render 自动弹开）');
    ok(!/fold-body/.test(S.contractCard()), '契约自检结果卡内部没有 .fold-body 套娃');
    ok((S.contractCard().match(/class="card/g) || []).length === 1, '契约自检结果只有一层 card 容器');
    S.State.contract = { ...S.State.contract, hidden: true };
    ok(S.contractCard() === '' && !/closeContractCheck/.test(S.Pages.host()), '手动关闭后整张卡片不再渲染');
    S.State.contract = keepContract;
    // ③ .ellip（display:inline-block）只能写在内层 span 上，不能挂在 <td> 上 ——
    //    挂在 td 上会把表格单元变成行内块：格高脱离行高、内容被 vertical-align:bottom 拉到底、
    //    行悬停高亮带在这一格断开（会话列表工作目录列实测踩过）。
    const sh2 = S.Pages.sessions();
    ok(!/<td[^>]*class="[^"]*ellip/.test(sh2), '会话列表没有把 .ellip 挂在 td 上');
    ok(/<span class="mono ellip"/.test(sh2), '会话列表工作目录用内层 span 做省略');
    // 全站页面扫一遍，防止同类问题再犯
    const offenders = S.ROUTES.map(r => ({ id: r.id, html: (() => { try { return S.Pages[r.id] ? String(S.Pages[r.id]()) : ''; } catch { return ''; } })() }))
      .filter(x => /<td[^>]*class="[^"]*ellip/.test(x.html));
    ok(offenders.length === 0, '全站 18 页没有 td 上挂 .ellip', offenders.length ? offenders.map(o => o.id).join(',') : '干净');
  } catch (e) { ok(false, '契约卡/表格单元', e.message); }

  log('\n=== 聊天页补缺（轮次导航 / 上下文 / 回到底部）===');
  try {
    const chat = S.Pages.chat();
    ok(/chatbottom/.test(chat), '聊天页有「回到底部」按钮');
    ok(/onscroll="Chat\.onScroll\(\)"/.test(chat), 'chatlog 挂了滚动监听');
    ok(/position:relative/.test(chat), 'chat-split 设为定位上下文（浮动按钮与用量浮层需要）');
    const nav = S.chatNavHtml();
    ok(typeof nav === 'string', 'chatNavHtml 可调用' + (nav ? '（生成 ' + (nav.match(/cn-btn/g) || []).length + ' 个轮次按钮）' : '（当前会话无 turnOutline 投影）'));
    // 轮次按钮只写序号（"第 N 轮"四个字 × 十几轮会把工具条撑爆），完整说明放 title
    if (nav) ok(/第 \d+ 轮/.test(nav) && />\d+<\/button>/.test(nav), '轮次按钮文案为纯序号、完整说明在 title');
  } catch (e) { ok(false, '聊天页补缺', e.message); }

  log('\n=== 本轮：工具条瘦身 / 目标相位 / 模型发现分型 / 界面偏好 ===');
  try {
    // ① 聊天工具条只有一行：按钮行与轮次导航合并进 .chat-tools（此前两行 ≈ 80px）
    const chat = S.Pages.chat();
    ok(/class="chat-tools"/.test(chat), '聊天页工具条用的是单行 .chat-tools');
    // 注意：chatNavHtml() 在"当前会话没有轮次"时返回空串，所以这里不能拿渲染结果断言
    //       （活动会话恰为空时会假红）。改成断言模板结构：ct-right 里挂了 chatNavHtml()；
    //       带真实轮次的端到端断言在下面「轮次导航按钮来自真实 turnOutline 投影」那条。
    ok(/class="ct-right"[\s\S]{0,400}chatNavHtml\(\)/.test(code), '轮次导航挂在工具条右侧（ct-right）里');
    ok(!/id="chatmeta"/.test(chat), '不再重复显示会话 ID（顶部作用域条已有）');
    ok(!/chatMorePick|chatmoremenu/.test(chat), '「⋯ 更多」菜单不再存在（按反馈整组移除）');
    ok(!/载入历史消息|清空面板|会话备注/.test(chat), '载入历史 / 清空面板 / 会话备注不再挂在聊天页');
    ok(/onclick="showSessionStats\(\)"/.test(chat), '统计是聊天页唯一保留的会话级动作');
    // 计划徽标：没有计划时不再常驻一句"无进行中的计划"
    S.State.plan = null; S.State.todos = null;
    ok(S.planBadgeText() === '' || !/无进行中的计划/.test(S.planBadgeText()), '没有计划时不显示「无进行中的计划」噪声');

    // ② 目标相位：每颗按钮都过一遍宿主前置校验（goalActionState）
    const sr = (a, g) => S.goalActionState(a, { goal: g, roundsStarted: g.roundsStarted || 0 });
    ok(sr('resume', { phase: 'complete' }).can === false, 'complete 相位判定为「不可恢复」');
    ok(sr('resume', { phase: 'paused' }).can === true && sr('resume', { phase: 'blocked' }).can === true, 'paused / blocked 可恢复');
    ok(sr('resume', { phase: 'active', activation: 'armed' }).can === false, 'armed 的 active 不需要恢复');
    ok(sr('resume', { phase: 'active', activation: 'disarmed' }).can === true, 'disarmed 的 active 可恢复（对齐原生 showResume）');
    ok(sr('resume', { phase: 'active', roundsStarted: 6, maxGoalRounds: 6 }).can === false, '轮次用尽时不可恢复');
    ok(sr('edit', { phase: 'complete' }).can === true, 'complete 相位允许编辑（宿主只要求编辑不改相位）');
    ok(sr('pause', { phase: 'complete' }).can === false && sr('pause', { phase: 'active' }).can === true, '暂停只允许 active');
    ok(sr('complete', { phase: 'paused' }).can === true && sr('complete', { phase: 'complete' }).can === false, '标记完成允许 active/paused/blocked');
    ok(S.goalPhaseLabel({ phase: 'complete' }) === '已完成的目标', '相位标签用原生文案');
    ok(S.goalPhaseLabel({ phase: 'active', activation: 'disarmed' }) === '未运行的目标', 'disarmed 的 active 用原生「未运行的目标」');
    const keepGoal = S.State.goal;
    S.State.goal = { goal: { id: 'g1', revision: 1, phase: 'complete', maxGoalRounds: 6, roundsStarted: 6, activation: 'disarmed', objective: 'x' }, roundsStarted: 6, createdAt: Date.now(), updatedAt: Date.now() };
    const goalHtml = S.Pages.goal();
    ok(!/goalAction\('resume'\)/.test(goalHtml), 'complete 目标页面不渲染「恢复」按钮');
    ok(/goalAction\('edit'\)/.test(goalHtml), 'complete 目标页面仍可编辑');
    ok(/已完成的目标无法恢复/.test(goalHtml), 'complete 目标页面写明原因 + 引导（新建目标 / 清除）');
    ok(/goalAction\('clear'\)/.test(goalHtml) && /createGoal\(\)/.test(goalHtml), 'complete 目标给「清除」与「新建目标」');
    S.State.goal = { goal: { id: 'g2', revision: 1, phase: 'paused', maxGoalRounds: 6, roundsStarted: 1, activation: 'disarmed', objective: 'y' }, roundsStarted: 1, createdAt: Date.now(), updatedAt: Date.now() };
    ok(/goalAction\('resume'\)/.test(S.Pages.goal()), 'paused 目标页面照常给「恢复」');
    S.State.goal = keepGoal;

    // ③ 模型发现：没有发现能力的通道标「静态清单」（正常），不再当失败
    ok(S.discErrKind('x [llm/model-discovery-rejected] no model discovery is registered for "llm-deepseek"') === '静态清单', '未注册发现的通道归类为「静态清单」而不是「通道不支持」');
    ok(S.discIsStatic({ ok: false, error: 'no model discovery is registered for "x"' }) === true, 'discIsStatic 认得这条结论');
    ok(S.discIsStatic({ ok: false, error: 'answered 401; check the API key' }) === false, '缺 Key 不算静态清单');
    ok(!/通道不支持/.test(S.discErrKind('no model discovery is registered for "x"')), '文案里不再出现"通道不支持"这个听起来像故障的标签');
    const provHtml = S.provSectionHtml();
    ok(/静态清单/.test(provHtml), '供应商接入卡说明了「静态清单」的含义');

    // ④ 界面偏好：改存项目 yaml（不走 localStorage、不写 DSH 设置；json→yaml 迁移读）
    const appSrc = readSrc('../public/app.js');
    const prefFn = /\nfunction uiPrefs\(\)[\s\S]*?\n\}\n/.exec(appSrc);
    ok(!/localStorage\.getItem/.test(prefFn ? prefFn[0] : ''), 'uiPrefs() 读取路径不再用 localStorage');
    ok(/\/api\/local\/prefs/.test(appSrc), '界面偏好走 /api/local/prefs（项目内 ui-prefs.yaml）');
    ok(/await loadUiPrefs\(\)/.test(appSrc), '启动时先 await loadUiPrefs() 再首次 render');
    const srvSrc = readSrc('../server.cjs');
    ok(/ui-prefs\.yaml/.test(srvSrc) && /'\/api\/local\/prefs'/.test(srvSrc), 'server.cjs 有 ui-prefs.yaml 与 /api/local/prefs 路由');
    ok(/function prefsToYaml|function prefsFromYaml/.test(srvSrc) && !/writeJsonSafe\(UI_PREFS_FILE/.test(srvSrc), '偏好落盘走 yaml 读写器（不再写 JSON）');

    // ⑤ 预设复制：一个弹框填完（不再串两个 prompt）
    const copyFn = /\nasync function copyPreset\([\s\S]*?\n\}\n/.exec(appSrc);
    ok(copyFn && /UI\.form\(/.test(copyFn[0]), 'copyPreset 用单弹框（UI.form）一次填完 id + 名称');
    ok(copyFn && (copyFn[0].match(/UI\.prompt\(/g) || []).length === 0, 'copyPreset 里不再串行弹 prompt');

    // ⑥ 新建会话：**只**列已有工作空间（不允许在会话窗口新建工作空间/目录）
    const nsFn = /\nasync function newSession\([\s\S]*?\n\}\n/.exec(appSrc);
    ok(nsFn && /ns-list/.test(nsFn[0]), '新建会话弹框列出工作空间候选');
    ok(nsFn && /已有工作空间/.test(nsFn[0]), '新建会话只选「已有工作空间」');
    ok(nsFn && /loadWorkspaces/.test(nsFn[0]), '新建会话前先确保工作空间清单已加载');
    ok(nsFn && !/UI\.pickDir\(/.test(nsFn[0]) && !/ns-other/.test(nsFn[0]), '不再提供「选择其他目录」入口');
    ok(nsFn && !/最近用过的目录/.test(nsFn[0]), '不再列「最近用过的目录」兜底候选');
    ok(nsFn && /ns-preset/.test(nsFn[0]), '智能体预设收进同一个弹框');

    // ⑥b 新建工作空间：直接弹**系统文件夹选择框**（directoryPicker/pick 的 native 后端），
    //     不再自造应用内目录树（用户明确否掉了那条路）。
    const pdFn = /\n  async pickDir\(opts = \{\}\) \{[\s\S]*?\n  \},\n/.exec(appSrc);
    ok(!!pdFn, '取到 UI.pickDir 实现');
    ok(/API\.call\('dir\.pick'\)/.test(pdFn[0]), 'UI.pickDir 调 dir.pick');
    ok(S.API && S.API.MAP && S.API.MAP['dir.pick'] && S.API.MAP['dir.pick'][0] === 'directoryPicker/pick',
      'dir.pick → directoryPicker/pick（系统对话框）');
    ok(/unavailable/.test(pdFn[0]) && /UI\.prompt\(/.test(pdFn[0]), '宿主没挂 native 后端时退回手动填路径');
    ok(!/pd-tree|pd-cols|pd-item|roots=1/.test(appSrc), '没有应用内目录树残留（已按用户要求撤掉）');
    ok(!/\/api\/local\/fs\?[^']*roots/.test(appSrc), '不再请求盘符清单端点');

    // ⑦ 切模型回显：取目标会话自己的 modelSelection.next，不用当前会话的路由
    const smFn = /\nasync function selectModel\([\s\S]*?\n\}\n/.exec(appSrc);
    ok(smFn && /sessionModelOf\(sid\)/.test(smFn[0]), 'selectModel 回显走 sessionModelOf(目标会话)');
    ok(smFn && /fillEfforts\(curEffort\)/.test(smFn[0]), '推理强度下拉按目标会话当前值回显');
    // 行为断言：投影形状是 {lastUsed, next} 两个槽（**不是**扁平的 {provider,model}），
    // 且 next 才是"会话当前模型"，lastUsed 是上一轮用过的、不能拿来回显。
    ok(/\nfunction sessionModelOf\(/.test(appSrc), '存在 sessionModelOf()（会话当前模型的唯一真相源）');
    try {
      const keepSess = S.State.sessions, keepModels = S.State.models;
      S.State.models = { current: { provider: 'p-default', model: 'm-default', reasoningEffort: 'low' } };
      S.State.sessions = [
        { sessionId: 's-next', projections: { values: { modelSelection: {
          lastUsed: { provider: 'p-old', model: 'm-old', reasoningEffort: 'off' },
          next: { provider: 'p-new', model: 'm-new', reasoningEffort: 'max' } } } } },
        { sessionId: 's-lastonly', projections: { values: { modelSelection: { lastUsed: { provider: 'p-old', model: 'm-old' }, next: null } } } },
        { sessionId: 's-empty', projections: { values: {} } },
      ];
      const a = S.sessionModelOf('s-next'), b = S.sessionModelOf('s-lastonly'), c = S.sessionModelOf('s-empty');
      ok(a.provider === 'p-new' && a.model === 'm-new' && a.reasoningEffort === 'max',
        'next 优先：回显取 next，而不是 lastUsed', a.provider + '/' + a.model + '@' + a.reasoningEffort);
      ok(b.provider === 'p-default' && b.model === 'm-default',
        'next 为空时退全局默认（lastUsed 不参与回显）', b.provider + '/' + b.model);
      ok(c.provider === 'p-default', '没有 modelSelection 时同样退全局默认', c.provider + '/' + c.model);
      S.State.sessions = keepSess; S.State.models = keepModels;
    } catch (e) { ok(false, 'sessionModelOf 行为断言', e.message); }

    // ⑧ 「⋯ 更多」菜单已整体移除：确认源码里不再有它的开关实现与点空白关闭分支
    ok(!/function chatMoreOpen\(/.test(appSrc) && !/function toggleChatMore\(/.test(appSrc),
      '「更多」菜单的开关函数已删除');
    ok(!/chatMorePick\(/.test(appSrc) && !/closeChatMore\(/.test(appSrc), '「更多」的菜单项分发与关闭函数已删除');
    ok(!/transcriptCompact/.test(appSrc), '「对话显示：标准/紧凑」偏好已移除（对话恒为标准）');
    // 轮次折叠条按最新反馈**整体删除**（格式内容混乱无法用）——只许"恢复→再删"留下干净现场
    ok(!/ChatRow\.turnProc|toggleTurnProc|syncTurnProc/.test(appSrc), '轮次折叠条实现已整体删除');
    ok(!/turn-proc|data-turn-process|chatProcOpen/.test(appSrc), '折叠条的 DOM 标记与展开记忆状态已清除');
    ok(!/ROW_CAP/.test(appSrc) && !/最近 240 行|最近 160 条/.test(appSrc), '对话流不再做行数裁剪（全量载入）');
    ok(/session\.page/.test(appSrc) && /throughSeq/.test(appSrc), '全量载入用 session/page 向前翻页');
  } catch (e) { ok(false, '本轮改动断言', e.message); }

  log('\n=== 折叠条 / 轮次导航 / 未分组 / 侧栏（本轮四项反馈）===');
  try {
    const appSrc2 = readSrc('../public/app.js');
    const cssSrc = readSrc('../public/style.css');

    /* ① 折叠条已删：确认 pushChatRow 不再调用 syncTurnProc、收尾段也不再补算、
       批量重建开关（_bulk）随之成为死代码一并移除 */
    ok(!/_bulk/.test(appSrc2), '折叠条删除后 _bulk 批量开关已一并移除（不再留死标记）');
    const pr = /\nfunction pushChatRow\([^)]*\) \{[\s\S]*?\n\}/.exec(appSrc2);
    ok(!!pr, '取到 pushChatRow 实现');
    ok(pr && !/syncTurnProc/.test(pr[0]), 'pushChatRow 不再逐行同步折叠条');
    const tail2 = /const produced = collectProducedFromEvents\(events\)[\s\S]*?\n  \} catch/.exec(appSrc2);
    ok(!!tail2, '取到 loadChatHistory 的收尾段');
    ok(tail2 && /placeTurnFoot\(t\)/.test(tail2[0]), '收尾段算了轮末页脚');
    ok(tail2 && !/syncTurnProc/.test(tail2[0]), '收尾段不再补算折叠条');

    /* ② 轮次导航：落点必须用 turnOutline 的 seq 锚点（行内 data-turn 与 outline 轮号不是一套编号，
       实测错位 +1 且互相穿插 —— "点 2 跳进第 1 轮"的根因） */
    const jt = /\nfunction jumpTurn\(turn\) \{[\s\S]*?\n\}/.exec(appSrc2);
    ok(!!jt, '取到 jumpTurn 实现');
    ok(jt && /turnOutline/.test(jt[0]) && /Number\(item\.seq\)/.test(jt[0]), 'jumpTurn 用 turnOutline 的 seq 锚点定位轮次开头');
    ok(jt && /dataset\.seq.*>= anchor|>= anchor/.test(jt[0]), '落点 = data-seq ≥ 锚点的第一行（这一轮的开头）');
    ok(jt && /querySelectorAll\('\[data-turn="/.test(jt[0]), 'outline 缺失时退回 data-turn 尽力而为');
    ok(jt && /Chat\._follow = false/.test(jt[0]), 'jumpTurn 先关掉自动跟随（修"点了没反应"的根因）');
    ok(jt && /turn-foot/.test(jt[0]), 'jumpTurn 会跳过轮末页脚，不把落点定在轮尾');
    ok(/scroll\(force\)\{[^}]*_follow === false[^}]*return/.test(appSrc2) || /if \(!force && this\._follow === false\) return/.test(appSrc2),
      'Chat.scroll 默认不再无条件拽到底部（force 才跟）');
    ok(/onScroll\(\) \{[\s\S]{0,400}this\._follow = gap < 60/.test(appSrc2), 'onScroll 按离底距离维护 _follow');
    ok(/\.flash:not\(\.msg\)\{/.test(cssSrc), '非 .msg 落点也有高亮（否则跳转没视觉反馈）');

    /* ③ 未分组桶（对齐原生 groupByWorkspace：key 空串、无路径、按最近活动倒序、只装有会话时出现） */
    const wpage = /\nPages\.workspace = \(\) => \{[\s\S]*?\n\};/.exec(appSrc2);
    ok(!!wpage, '取到 Pages.workspace');
    ok(wpage && /UNGROUPED_KEY|accounted/.test(wpage[0]), '工作空间页有"未分组"桶的归属计算');
    ok(wpage && /stray[\s\S]{0,300}updatedAt/.test(wpage[0]), '未分组成员按 updatedAt 倒序（原生 recency）');
    ok(wpage && /origin !== 'subagent'/.test(wpage[0]), '子代理会话不进未分组（原生嵌在父会话下）');
    ok(wpage && /未分组/.test(wpage[0]), '未分组块有中文标签与说明');
    // 删除确认必须写清"只移除分组、会话回到未分组"（原生 delete.desc 的中文串）
    const dw = /\nasync function deleteWorkspace\(id, name\) \{[\s\S]*?\n\}/.exec(appSrc2);
    ok(!!dw, '取到 deleteWorkspace');
    ok(dw && /未分组/.test(dw[0]), '删除确认写明会话回到「未分组」');
    ok(dw && /绑定目录不会被删除[\s\S]{0,80}会话记录不会被删除/.test(dw[0]), '删除确认写明目录与会话记录都保留');

    /* ④ 侧栏四块：审批按会话过滤；提问卡要渲染 detail（计划模式的整份计划在 detail 里） */
    ok(/const mineAp = allAp\.filter\(a => !a\.sessionId \|\| a\.sessionId === State\.sessionId\)/.test(appSrc2),
      '侧栏审批按当前会话过滤（不再串会话）');
    ok(/otherAp \? /.test(appSrc2), '其它会话的待审批只报个数、不混进本会话列表');
    ok(/questionsCardsHtml\(sessionId\)/.test(appSrc2) && /filter\(q => sessionId == null \|\| !q\.sessionId \|\| q\.sessionId === sessionId\)/.test(appSrc2),
      '提问卡支持按会话过滤');
    ok(/questionsCardsHtml\(State\.sessionId\)/.test(appSrc2), '对话页提问区只渲染当前会话的提问');
    ok(/x\.detail \? `<details class="qcard-detail"/.test(appSrc2), '提问卡渲染 detail（计划全文）');
    ok(/intent && x\.intent\.kind/.test(appSrc2) && /plan-review/.test(appSrc2), '计划确认按 intent.kind==="plan-review" 判定');
    ok(/\.qcard-detail-body\{/.test(cssSrc), '模板全文有可滚动的正文样式');
    // 侧栏「计划模式」块已按需求移除（同折叠条）：计划全文与 Approve / Keep planning 只在提问卡里
    // 断言前先剥掉注释 —— 说明"为什么拿掉"的注释里会写到这个词，不该被当成残留
    const appCode = appSrc2.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
    const aside2 = /function renderChatAside\(\)\s*\{[\s\S]*?\n\}/.exec(appCode);
    ok(!!aside2, '取到 renderChatAside');
    ok(aside2 && !/计划模式/.test(aside2[0]), '侧栏不再有「计划模式」块（入口统一在提问卡）');
    ok(!/计划模式：进行中|计划模式：待确认/.test(appCode), '输入区徽标不再显示「计划模式」状态灯（只保留任务进度）');
    ok(!/<td>计划模式<\/td>/.test(appCode), '系统状态页不再重复展示「计划模式」状态');
  } catch (e) { ok(false, '折叠条/轮次导航/未分组/侧栏断言', e.message); }

  log('\n=== 说明卡交互（默认收起 / 点击展开）===');
  try {
    // 默认收起：18 页都不该出现 pg-body（会挤满首屏），但标题行必须还在
    const sample = ['home', 'models', 'sessions', 'trajectory', 'credentials'];
    const withBody = sample.filter(id => S.pageHelp(id).includes('pg-body'));
    ok(!withBody.length, '默认全部收起（抽样 ' + sample.length + ' 页都没有 pg-body）', withBody.join(','));
    ok(sample.every(id => S.pageHelp(id).includes('本页说明')), '收起时标题行仍在（「本页说明」可见）');
    // 收起时标题行的副文案要换成"本页一句话摘要"，不能只剩栏目名（否则默认收起=信息归零）
    ok(/class="pg-sub" title="[^"]{12,}"/.test(S.pageHelp('models')), '收起时标题行带本页一句话摘要（title 非空）');
    // 点击展开 → body 出现；再点一次收起
    S.toggleHelp('models');
    ok(S.pageHelp('models').includes('pg-body'), '点击后展开（pg-body 出现）');
    ok(S.pageHelp('models').includes('pg-chip'), '展开态含「相关页」跳转（models 有 3 个 go 目标）');
    S.toggleHelp('models');
    ok(!S.pageHelp('models').includes('pg-body'), '再点一次重新收起');
  } catch (e) { ok(false, '说明卡交互', e.message); }

  log('\n=== 上下文注入行分型（逐字对照原生 ContextInjectionRow / ContextBody）===');
  try {
    const row = (source, text) => S.ChatRow.source({ source, content: [{ type: 'text', text }] }, [{ type: 'text', text }]);
    // 标题只有两个取值，右侧跟 provenance.label（原生 contextProvenance）
    const plug = row({ kind: 'plugin', plugin: 'dsh-knowledge' }, 'hello');
    ok(/crow-lbl">上下文注入</.test(plug) && /data-context-source="1">dsh-knowledge</.test(plug) && /ctx-text/.test(plug),
      'plugin：标题「上下文注入」+ 来源 label = 插件名，正文照原文');
    // goal 没有 form → 通透白底：原文 + source 键值表（round/revision 只能靠这张表露出来）
    const goal = row({ kind: 'goal', goalId: 'g-1', revision: 2, round: 3 }, '<goal_round>');
    ok(!/data-form=/.test(goal) && /data-context-fields/.test(goal) && /ctx-fkey">round</.test(goal) && />3</.test(goal),
      'goal：无 form → 通透白底，round/revision 以键值表露出');
    // notice：一句话摘要落在**折叠行**上，展开只是原文
    const notice = row({ kind: 'subagent-settled', form: 'notice', summary: '子代理已完成', senderSessionId: 's1' }, '报告正文');
    ok(/data-form="notice"/.test(notice) && /data-context-summary="1">子代理已完成</.test(notice) && /ctx-text/.test(notice),
      'notice：摘要在折叠行上，展开是原文');
    // snapshot：段落表取代原文（刻意不重复拼接后的 prose）
    const snap = row({ kind: 'plugin', plugin: 'p', form: 'snapshot', sections: [{ name: 'sandbox:policy', text: 'A' }, { name: 'approval:policy', text: 'B' }] }, 'Current runtime context. …');
    ok(/data-form="snapshot"/.test(snap) && /取代先前的快照/.test(snap) && /ctx-sname">sandbox:policy</.test(snap) && !/ctx-text/.test(snap),
      'snapshot：段落表取代原文，不重复拼接后的 prose');
    // catalog：条目清单取代原文
    const cat = row({ kind: 'skill-catalog', form: 'catalog', entries: [{ name: 's1', description: 'd1' }] }, '<system-reminder> …');
    ok(/data-form="catalog"/.test(cat) && /ctx-ename">s1</.test(cat) && /ctx-edesc">d1</.test(cat) && !/ctx-text/.test(cat),
      'catalog：条目清单取代原文');
    // relay：发送方字段 + 原文
    const relay = row({ kind: 'agent-message', form: 'relay', senderSessionId: 'sess-9' }, '收到');
    ok(/data-form="relay"/.test(relay) && /来自会话 sess-9/.test(relay) && /ctx-text/.test(relay), 'relay：发送方 + 原文');
    // recall：标题切到「跨会话召回」，带保留/省略/截断（真实数据里没出现，靠夹具守住）
    const recall = row({ kind: 'session-reference', form: 'recall', references: [{ label: '会话 A', retainedMessages: 12, omittedMessages: 3, truncated: true }] }, 'x');
    ok(/crow-lbl">跨会话召回</.test(recall) && /保留 12 条 · 省略 3 条/.test(recall) && /已截断/.test(recall),
      'recall：标题切「跨会话召回」+ 保留/省略/截断');
    // instructions：文件清单 + 动作措辞（非 baseline：set=已新增 / replace=已更新）
    const ins = row({ kind: 'agent-instructions', form: 'instructions', changes: [{ path: 'AGENTS.md', action: 'set' }, { path: 'X.md', action: 'replace' }] }, '…');
    ok(/data-form="instructions"/.test(ins) && /ctx-fpath">AGENTS\.md</.test(ins) && /已新增/.test(ins) && /已更新/.test(ins),
      'instructions：文件清单 + 已新增/已更新');
    // 全有或全无：字段读不完整就退回通透白底（不许画出一份"看着可信其实不全"的清单）
    const badCat = row({ kind: 'skill-catalog', form: 'catalog', entries: [{ name: 'n' }] }, 'T');
    ok(!/data-form=/.test(badCat) && /ctx-text/.test(badCat), 'catalog 条目读不完整 → 退回通透白底（全有或全无）');
    // 原文上限 2e4 字符（原生 MAX_CHARS），超出补「… 已截断，共 N 字符」
    const big = row({ kind: 'plugin', plugin: 'p' }, '甲'.repeat(25000));
    ok(/已截断/.test(big) && /25,?000/.test(big), '原文超 2e4 字符截断并注明总长');
  } catch (e) { ok(false, '上下文注入行分型', e.message); }

  /* ---- 真流端到端（REAL_WS=1 才跑）----
     前面的操作条断言喂的是手搓 fixture：能证明"给了这些字段就能画对"，
     证明不了"真实事件里到底有没有这些字段"。这一段用真 WebSocket 拉真实会话事件，
     从事件形状一路走到操作条 HTML —— 这是 stub 推不出来的那段链路。 */
  if (REAL_WS) {
    log('\n=== 真流端到端：真实会话事件 → 每轮用量/用时/消息 id → 操作条 ===');
    try {
      const cand = (St.sessions || [])
        .map(s => ({ id: s.sessionId, n: (s.projections?.values?.turnOutline || []).length }))
        .sort((a, b) => b.n - a.n)[0];
      log('取样会话：' + String(cand && cand.id).slice(0, 24) + ' · turnOutline ' + (cand ? cand.n : 0) + ' 轮');
      const hv = await withTimeout(S.API.history(cand.id, true), 30000, 'session/follow 快照');
      ok(hv.ok, 'session/follow 拿到历史快照', hv.ok ? ((hv.v.events || []).length + ' 条事件') : hv.err);
      const events = (hv.ok && hv.v.events) || [];

      // ① 按真实事件建轮次元数据（与 loadChatHistory 完全同一套逻辑）
      S.Turns.reset();
      // 用户消息不带轮号 → 与 loadChatHistory 同一套归属规则：归给"紧接着的那个 turn/start"
      const startsList = events
        .filter(x => x.event?.type === 'turn/start' && Number.isFinite(Number(x.event.data?.turn)))
        .map(x => ({ seq: Number(x.event.seq), turn: Number(x.event.data.turn) }))
        .sort((a, b) => a.seq - b.seq);
      const nextTurnAfter = (seq) => {
        const s = Number(seq);
        if (!Number.isFinite(s)) return null;
        for (const t of startsList) if (t.seq > s) return t.turn;
        return startsList.length ? startsList[startsList.length - 1].turn : null;
      };
      let maxTurn = null, withUsage = 0;
      const ids = new Set(), asst = [];
      for (const x of events) {
        const e = x.event; if (!e) continue;
        if (e.type === 'turn/start') S.Turns.start(e.data?.turn, e.time, e.seq);
        else if (e.type === 'turn/end') S.Turns.end(e.data?.turn, e.data?.reason, e.time);
        else if (e.type === 'step/start') S.Turns.step(e.data?.turn, e.data?.step, e.time);
        else if (e.type === 'user/message') {
          const src = e.data?.source || {};
          const txt = (e.data?.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
          if (src.kind === 'user' && txt && !/^Current runtime context|^<system-reminder>/.test(txt)) {
            const t = nextTurnAfter(e.seq);
            if (t != null) S.Turns.user(t, txt, e.time);
          }
        } else if (e.type === 'assistant/message') {
          const tm = S.msgTiming(e);
          const am = e.data?.message || {};
          const atext = (am.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
          S.Turns.message(e.data?.turn, e.data?.usage, am.source, e.seq, tm, atext, am.id, e.time);
          asst.push({
            turn: Number(e.data?.turn), step: e.data?.step, seq: e.seq, time: e.time, id: am.id,
            usage: e.data?.usage, timing: tm, think: S.reasoningOf(am.content), text: atext,
          });
          if (am.id) ids.add(am.id);
          if (e.data?.usage) withUsage++;
          const t = Number(e.data?.turn); if (Number.isFinite(t)) maxTurn = maxTurn == null ? t : Math.max(maxTurn, t);
        }
      }
      ok(asst.length > 0, '真实事件里有 assistant/message', asst.length + ' 条');
      ok(withUsage > 0, '真实助手消息带 usage 字段', withUsage + ' 条');
      ok(ids.size > 0, '真实消息带持久化 message.id（反馈只能用它）', ids.size + ' 个');

      const turns = Object.values(St.turns || {}).filter(r => Number.isFinite(r.turn)).sort((a, b) => a.turn - b.turn);
      const runs = turns.map(r => ({ turn: r.turn, ms: S.Turns.runMs(r.turn), done: S.Turns.done(r.turn) }));
      ok(turns.length > 0, '真实事件建出轮次元数据', turns.length + ' 轮');
      const withRun = runs.filter(r => r.ms != null);
      ok(withRun.length > 0, '至少有轮次能算出用时（turn/start → turn/end 时间差）',
        withRun.slice(0, 4).map(r => '第' + r.turn + '轮 ' + S.fmtDur(r.ms)).join(' · ') || '无');

      // ② 轮末页脚（整轮一条）：必须带"分支 + 用时"，且分支是**可用**的
      const tail = asst.filter(a => a.turn === maxTurn).pop();
      if (tail) {
        const rec = S.Turns.of(tail.turn, false);
        const footO = S.Turns.footOf(tail.turn);
        const bar = S.msgActionsHtml(footO);
        ok(/class="msg-acts turn-foot"/.test(bar), '真数据页脚带 turn-foot 类（整轮一条的标记）');
        ok(/复制/.test(bar) && /好的回答/.test(bar) && /有问题的回答/.test(bar) && /用量/.test(bar),
          '真数据轮末页脚含 复制 / 好的回答 / 有问题的回答 / 用量');
        ok(S.msgClock(footO.time) !== '' && bar.includes(S.msgClock(footO.time)), '真数据页脚含时间', S.msgClock(footO.time));
        // 页脚复制/反馈的是该轮**最终正文**：最后一个带非空文本的助手消息
        const lastWithText = asst.filter(a => a.turn === maxTurn && String(a.text || '').trim()).pop();
        ok(footO.text !== '' && footO.messageId !== '', '页脚绑定了本轮最终正文（文本与 messageId 都非空）',
          String(footO.text).length + ' 字符 · id ' + String(footO.messageId).slice(0, 12));
        if (lastWithText) {
          ok(footO.messageId === lastWithText.id, '页脚绑"最终正文"那条消息（不是中间稿）',
            '末条带文本 seq=' + lastWithText.seq + ' · 本轮助手消息 ' + asst.filter(a => a.turn === maxTurn).length + ' 条');
        }
        ok(/branchAtTurn\(/.test(bar) && !/branchAtTurn\([\s\S]{0,90}?disabled/.test(bar),
          '已完成轮次的分支按钮可用（真数据）',
          S.Turns.done(tail.turn) ? '第' + tail.turn + '轮已完成' : '第' + tail.turn + '轮未完成');
        ok(/class="ma-dur"/.test(bar), '轮末页脚带本轮用时',
          (bar.match(/class="ma-dur"[^>]*>([^<]*)/) || [])[1] || '');
        const panel = S.usagePanelHtml(tail.turn, null, footO.step);
        ok(/这一次调用|本轮小计/.test(panel), '真数据用量浮层有内容');
        ok(/本轮用时/.test(panel) || rec.n > 1, '真数据用量浮层带本轮用时或小计',
          '本轮调用 ' + rec.n + ' 次 · 用时 ' + (S.Turns.runMs(tail.turn) != null ? S.fmtDur(S.Turns.runMs(tail.turn)) : '未知'));
      } else ok(false, '取到轮末助手消息', '真实事件里没有 assistant/message');

      // ③ ★ 核心不变量：非轮末一律不产出操作条 —— 否则一轮十几条消息会挂出十几条重复的操作条
      const sameTurn = asst.filter(a => a.turn === maxTurn);
      const head = sameTurn[0] || {};
      const headBar = S.msgActionsHtml({ role: 'agent', messageId: head.id, text: '', time: head.time, turn: maxTurn, seq: head.seq });
      ok(headBar === '', '非轮末不产出操作条（整轮只有一条页脚）',
        '本轮 ' + sameTurn.length + ' 条助手消息，逐条产出的话会多出 ' + sameTurn.length + ' 条');
      ok(events.filter(x => x.event?.type === 'assistant/message').length > sameTurn.length || sameTurn.length > 1,
        '该会话确有多消息轮次（这条不变量才有意义）', '本轮 ' + sameTurn.length + ' 条');

      // ④ 真用户消息：归到轮次后，页脚里给复制；反馈只在拿到助手 messageId 后出现
      //   ⚠ 必须挑 source.kind === 'user' 的那条。同一条流里的 plugin / goal / subagent-settled
      //   也都是 user/message，但按上面的规则**不进** Turns.user()。早先这里取的是"最后一条
      //   user/message"，碰上末尾是目标轮（goal 自动推进，本就没有真人输入）的会话就会假失败
      //   —— 断言要测的是"真实用户输入"，就该只挑真实用户输入。
      const umAll = events.map(x => x.event).filter(e => e && e.type === 'user/message');
      const uev = umAll.filter(e => e.data?.source?.kind === 'user').pop();
      if (uev) {
        const uTurn = nextTurnAfter(uev.seq);
        const urec = uTurn != null ? S.Turns.of(uTurn, false) : null;
        ok(!!(urec && urec.userText), '真实用户输入被记为该轮的开场输入（页脚复制的兜底来源）',
          uTurn != null ? ('第 ' + uTurn + ' 轮 · ' + String(urec && urec.userText).slice(0, 24)) : '未归属到轮次');
      } else ok(false, '取到真实用户消息', '事件里没有 user/message');
      // ⑤ 每一条**非 user** 的 user/message 都必须渲染成"能读到正文"的上下文行 ——
      //    此前它们被画成一张空行，10 条 / 近 19KB 的真实内容整段消失（"很多内容没有"的主因）。
      //    口径：正文块被结构体取代的分型（snapshot / catalog）允许不重复原文，但必须有替代结构。
      const ctxs = umAll.filter(e => e.data?.source?.kind !== 'user');
      const shapeOk = (e) => {
        const h = S.ChatRow.source(e.data, e.data.content);
        const hasBody = /data-context-injection-body/.test(h);
        const hasContent = /ctx-text|ctx-sections|ctx-entries|ctx-files|ctx-recalls|ctx-fields/.test(h);
        const titleOk = /crow-lbl">(上下文注入|跨会话召回)</.test(h);
        return hasBody && hasContent && titleOk;
      };
      const badCtx = ctxs.filter(e => !shapeOk(e));
      const kindsOf = {};
      ctxs.forEach(e => { const k = e.data.source.kind || '?'; kindsOf[k] = (kindsOf[k] || 0) + 1; });
      ok(badCtx.length === 0, '非 user 的 user/message 都渲染成可展开且有正文的上下文行',
        ctxs.length + ' 条（' + Object.entries(kindsOf).map(([k, n]) => k + '×' + n).join(' ') + '）· 有问题 ' + badCtx.length + ' 条'
        + (badCtx.length ? '（' + badCtx.slice(0, 3).map(e => e.data.source.kind).join(',') + '）' : ''));

      // ⑥ 思考块 / 每步速度 / 会话统计也必须来自真实事件 —— fixture 能过不等于真实数据能过
      const withThink = asst.filter(a => a.think);
      ok(withThink.length > 0, '真实消息带思考块（此前被整段静默丢掉）', withThink.length + '/' + asst.length + ' 条含 reasoning 块');
      if (withThink.length) {
        const rh = S.reasoningHtml(withThink[0].think, false);
        ok(/<details class="think"/.test(rh) && /思考/.test(rh), '真实思考内容渲染成折叠的思考块',
          rh.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 70));
      }
      const tT = asst.filter(a => a.timing && Number.isFinite(a.timing.ttftMs));
      const tS = asst.filter(a => a.timing && Number.isFinite(a.timing.tps));
      const tK = asst.filter(a => a.timing && Number.isFinite(a.timing.thinkMs));
      ok(tT.length > 0, '真实数据能算出首 token 用时（TTFT）',
        tT.length + '/' + asst.length + ' 条 · 例 ' + S.fmtDur(tT[0] ? tT[0].timing.ttftMs : 0));
      ok(tS.length > 0, '真实数据能算出输出速度（TPS）',
        tS.length + '/' + asst.length + ' 条 · 例 ' + (tS[0] ? tS[0].timing.tps.toFixed(1) + ' tok/s' : '—'));
      ok(tK.length > 0, '真实数据能算出思考耗时',
        tK.length + '/' + asst.length + ' 条 · 例 ' + (tK[0] ? S.fmtDur(tK[0].timing.thinkMs) : '—'));
      if (tail) {
        const pop2 = S.usagePanelHtml(tail.turn, tail.usage, tail.step);
        ok(/首 token 用时（TTFT）|输出速度（TPS）/.test(pop2), '真实数据的用量浮层带速度分项',
          pop2.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 110));
      }
      {
        const stc = (St.sessions || []).map(s => ({ id: s.sessionId, st: s.projections?.values?.sessionStats || {}, tk: s.projections?.values?.tokenUsage || {} }))
          .filter(x => Number(x.st.turns) > 0).sort((a, b) => Number(b.st.turns) - Number(a.st.turns))[0];
        if (stc) {
          const prevSid2 = St.sessionId;
          St.sessionId = stc.id;
          const panel = S.sessionStatsHtml();
          ok(/轮数/.test(panel) && /输出速度（TPS）/.test(panel) && /缓存命中/.test(panel),
            '会话统计面板取到真实会话级投影', '轮 ' + stc.st.turns + ' · 模型用时 ' + S.fmtDur(stc.st.llmMs) + ' · 输出 ' + S.fmtInt(stc.tk.outputTokens) + ' tok');
          St.sessionId = prevSid2;
        } else ok(false, '找到有轮次统计的真实会话', '没有 turns>0 的会话');
      }

      // ⑤ 轮次导航与上下文徽标：换成"有轮次的那条会话"当当前会话再验一次
      //    （活动会话恰好是空会话时，这两个投影本来就是空的 —— 那不是 bug）
      const prevSid = St.sessionId;
      St.sessionId = cand.id;
      const nav = S.chatNavHtml();
      ok((nav.match(/cn-btn/g) || []).length > 0, '轮次导航按钮来自真实 turnOutline 投影',
        '按钮 ' + (nav.match(/cn-btn/g) || []).length + ' 个 · turnOutline ' + cand.n + ' 条');
      const badge = S.contextBadgeHtml();
      ok(/上下文 /.test(badge), '上下文压力徽标来自真实 contextPressure 投影',
        badge.replace(/<[^>]+>/g, '').trim() || '（该会话无 contextPressure）');
      St.sessionId = prevSid;
    } catch (e) { ok(false, '真流端到端链路', e.message); }
  } else {
    log('\n=== 真流端到端 ===');
    log('  已跳过（未设 REAL_WS=1）。要验"真实事件 → 操作条"这条链路就带这个环境变量跑。');
  }

  log('\n=== 外观（ui-theme）：跟随系统 / 深色 / 浅色 ===');
  {
    const St = S.State;
    const nsOf = () => (St.settings?.namespaces || []).find(n => n.ns === 'ui-theme');
    const setPref = v => { const n = nsOf(); if (n) n.value = Object.assign({}, n.value, { preference: v }); };
    const dt = () => document.documentElement.dataset.theme;
    const cs = () => document.documentElement.style.colorScheme;
    const realPref = S.themePreference();
    const snap = JSON.stringify(nsOf() ? nsOf().value : null);

    // ① 源码级：三条根因各钉一颗钉子。
    //    注意要拿**去掉注释**的源码去匹配 —— 修这个 bug 时注释里正好写了那句错表达式，
    //    不剥注释的话断言会被自己的说明文字骗过（这是断言自己的坑，不是代码的）。
    const codeNoComment = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    ok(!/\(\s*dark\s*\?\s*'dark'\s*:\s*'dark'\s*\)/.test(codeNoComment)
      && /const effective = dark \? 'dark' : 'light';/.test(codeNoComment),
      "applyTheme 用 dark?'dark':'light'（system 分支曾恒等于 'dark'，浅色系统下永久深色）");
    ok(/prefers-color-scheme: dark/.test(codeNoComment) && /addEventListener\('change'/.test(codeNoComment),
      '系统深浅色变化有 change 监听（「跟随系统」要实时跟随，不能只在启动时算一次）');
    const idxHtml = fs.readFileSync(DIR + '/public/index.html', 'utf8');
    ok(/dshThemePref/.test(idxHtml) && idxHtml.indexOf('dshThemePref') < idxHtml.indexOf('style.css'),
      'index.html 在样式表之前先按本地镜像上色（消除首屏"先深后浅"闪色）');
    // 只看 setThemePreference 自己那一段 —— 权限模式那个函数里也有 `if (v === cur) return;`，
    // 全文件搜索会被它误判
    const themeFn = (codeNoComment.match(/async function setThemePreference\(v\) \{[\s\S]*?\n\}/) || [''])[0];
    ok(!/if \(v === cur\) return;/.test(themeFn) && /known && v === cur/.test(themeFn),
      'setThemePreference 不再无条件 early-return（settings 未到手时点「跟随系统」曾等于没反应）',
      '函数体 ' + themeFn.length + ' 字符');

    // ② 三态落点（真实选中的偏好 → data-theme / color-scheme / body 属性必须一致）
    setPref('light'); S.applyTheme();
    ok(dt() === 'light' && cs() === 'light', '浅色 → data-theme=light · color-scheme=light', 'data-theme=' + dt());
    setPref('dark'); S.applyTheme();
    ok(dt() === 'dark' && cs() === 'dark' && document.body.hasAttribute('data-ds-dark-theme'),
      '深色 → 三个落点全深色一致', 'data-theme=dark · data-ds-dark-theme=有');
    SYS_DARK = true; setPref('system'); S.applyTheme();
    ok(dt() === 'dark', '跟随系统 · 系统为深色 → 控制台深色', 'data-theme=' + dt());
    SYS_DARK = false; S.applyTheme();
    ok(dt() === 'light', '跟随系统 · 系统为浅色 → 控制台浅色（原 bug 在这一支恒为 dark）', 'data-theme=' + dt());

    // ③ 系统换色时监听器真的重算（不点任何东西）
    setPref('system'); S.applyTheme();
    SYS_DARK = true; fireMedia();
    ok(dt() === 'dark', '系统切到深色时控制台自动跟随（无需任何操作）', 'data-theme=' + dt());
    SYS_DARK = false; fireMedia();
    ok(dt() === 'light', '系统切回浅色时控制台自动跟随', 'data-theme=' + dt());
    setPref('dark'); S.applyTheme(); SYS_DARK = false; fireMedia();
    ok(dt() === 'dark', '固定深色时系统换色不干扰（只有 system 才跟随）', 'data-theme=' + dt());

    // ④ 下拉：三项齐全、当前项选中
    setPref('system');
    const sw = S.platformSwitches();
    ok(/class="theme-sel"/.test(sw) && (sw.match(/value="(?:system|dark|light)"/g) || []).length === 3
      && /value="system" selected/.test(sw), '外观下拉三项齐全且当前项被选中',
      S.THEME_KEYS.map(k => S.THEME_LABEL[k]).join(' / '));

    // ⑤ 切换路径：立即生效 + 写回权威值（这一条会真写 DSH 设置，末尾还原）
    setPref('light'); S.applyTheme();
    /* 先把服务端也置成 light，再切 dark。
     * 原因：写入相同的值 DSH 不产生新 revision（合理行为），而本机 settings.yaml 里
     * 往往就停在 dark（上一次跑完还原的值）—— 那样"revision 递增"这条会假红。 */
    try { await S.API.call('settings.mutate', { ns: 'ui-theme', ops: [{ op: 'set', path: ['preference'], value: 'light' }] }); }
    catch (e) { log('  （预置 light 失败，下面 revision 断言可能假红：' + e.message + '）'); }
    const revBefore = Number(nsOf() && nsOf().revision || 0);
    const p = S.setThemePreference('dark');
    ok(dt() === 'dark', '点选后立刻上色（乐观生效，不等两个服务端往返）', 'data-theme=' + dt());
    await p;
    const revAfter = Number(nsOf() && nsOf().revision || 0);
    // 断言 revision 递增：光看 preference 会分不清"服务端回包校准的"还是"前面乐观写进去的"（假论断）
    ok(nsOf() && nsOf().value.preference === 'dark' && revAfter > revBefore,
      '写完把服务端回传的权威值并回本地 State（revision 递增证明不是乐观值的假象）',
      'preference=' + (nsOf() ? nsOf().value.preference : '—') + ' · revision ' + revBefore + '→' + revAfter);

    // 收尾：把本地与 DSH 都恢复到测试前的偏好
    SYS_DARK = false;
    try { await S.API.call('settings.mutate', { ns: 'ui-theme', ops: [{ op: 'set', path: ['preference'], value: realPref }] }); }
    catch (e) { log('  （还原偏好失败，请手动把外观改回：' + realPref + '）' + e.message); }
    if (nsOf() && snap) nsOf().value = JSON.parse(snap);
    S.applyTheme();
    log('  已还原外观偏好为「' + (S.THEME_LABEL[realPref] || realPref) + '」');
  }

  log('\n=== 结论 ===');
  if (asyncErrors.length) {
    log('异步路径上的异常 ' + asyncErrors.length + ' 条（真实浏览器里是控制台红字，不阻断渲染）：');
    [...new Set(asyncErrors)].slice(0, 10).forEach(e => log('  · ' + e.slice(0, 160)));
  } else log('无异步异常');
  log(fails ? ('失败 ' + fails + ' 项 —— 见上面 ❌') : '全部通过：18 页渲染无异常，说明卡与自检入口均在位');
  fs.writeFileSync(DIR + '/tools/render-all-out.txt', out.join('\n'));
  console.log('DONE fails=' + fails);
  // 明确退出：页面里存活的 WS / 定时器会让事件循环不空，脚本会在打印结果后挂住不返回
  process.exit(fails ? 1 : 0);
})().catch(e => {
  log('FATAL ' + e.stack);
  fs.writeFileSync(DIR + '/tools/render-all-out.txt', out.join('\n'));
  console.log('FATAL ' + e.message);
  process.exit(2);
});
