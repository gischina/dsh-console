/* DSH Console — 工具脚本 sandbox-render.mjs
 * Copyright 2026 liwei (易智瑞西安) <liwei@geoscene.cn>
 * SPDX-License-Identifier: Apache-2.0
 *
 * 依据 Apache License 2.0 授权使用与分发；许可证全文见项目根目录 LICENSE，摘要见 NOTICE。
 */
/* 前端逻辑离线复现沙盒：把 app.js 里的真实函数抽出来，在 stub 环境里跑直连 DSH 的完整流程。
 *
 * 为什么需要它：控制台的前端没有单元测试，而浏览器里点一遍成本高、看不全。
 * 这个脚本能对"纯逻辑 + 渲染产物"做断言：探测流程、面板 HTML、分页、凭据页取值与降级路径。
 *
 * 用法：node tools/sandbox-render.mjs
 *   → 结果写到 tools/sandbox-render-out.txt（本环境的 shell 常常吞掉 stdout，所以落盘再读）
 * 依赖：控制台在 127.0.0.1:3081（默认，可用 CONSOLE_PORT 覆盖）上运行（脚本通过它代理去打原生 DSH）。
 * 注意：脚本抽取依赖函数名与声明形式（function / const / OBJ.prop =），改名要同步改抽取列表。
 */
// 前端「发现模型 + 凭据页」逻辑离线复现：抽取 app.js 里的真实代码，在 stub 环境里跑完整流程。
// 目的：不依赖浏览器也能验证——① 探测流程不抛异常 ② 面板/清单的确切 HTML ③ 分页是否生效
// ④ 凭据页能不能把本机文件里的键名 + 设置引用的键名正确合并出来。
import fs from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

const DIR = path.resolve(fileURLToPath(new URL('../', import.meta.url)));  // 项目根（tools/ 的上一级）
const PORT = Number(process.env.CONSOLE_PORT || 3081);
const OUT = path.join(DIR, 'tools', 'sandbox-render-out.txt');
const SRC = path.join(DIR, 'public', 'app.js');
const src = fs.readFileSync(SRC, 'utf8');
const out = [];
const log = s => out.push(s);

/** 抽取 `function name(...) {...}` / `async function name(...) {...}`（大括号配平） */
function extractFn(name) {
  const re = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(');
  const m = re.exec(src);
  if (!m) throw new Error('未找到函数 ' + name);
  const i = src.indexOf('{', m.index + m[0].length - 1);
  let depth = 0, j = i;
  for (; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) { j++; break; } }
  }
  return src.slice(m.index, j);
}
/** 抽取 `const NAME = ...;`（单行声明） */
function extractConst(name) {
  const m = new RegExp('const\\s+' + name + '\\s*=[^\\n]*;').exec(src);
  if (!m) throw new Error('未找到常量 ' + name);
  return m[0];
}
/** 抽取 `const NAME = [...];` 这类跨行声明（按括号配平找结尾分号） */
function extractConstBlock(name) {
  const m = new RegExp('const\\s+' + name + '\\s*=').exec(src);
  if (!m) throw new Error('未找到常量 ' + name);
  let i = m.index + m[0].length, depth = 0;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '[' || c === '{' || c === '(') depth++;
    else if (c === ']' || c === '}' || c === ')') depth--;
    else if (c === ';' && depth === 0) { i++; break; }
  }
  return src.slice(m.index, i);
}
/** 抽取 `OBJ.prop = (...) => {...};` 形式（含尾部分号） */
function extractAssign(expr) {
  const i = src.indexOf(expr);
  if (i < 0) throw new Error('未找到赋值 ' + expr);
  const k = src.indexOf('{', i);
  let depth = 0, j = k;
  for (; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) { j++; break; } }
  }
  while (src[j] === ';') j++;
  return src.slice(i, j);
}

const parts = [
  extractConst('CRED_NAME_RE'),
  extractConst('DISC_PAGE'),
  extractConstBlock('PROVIDER_KIND'),
  // 页面骨架三件套（说明卡 / 自检 / 空态引导）：页面函数里会调用它们，所以要么抽真代码、要么 stub。
  // 这里抽真的 —— 顺带验证 PAGE_HELP 的 key 与 ROUTES 对齐（scopeTag / crumbOf 这类纯装饰仍是 stub）。
  extractConstBlock('ROUTES'),
  extractConstBlock('GROUP_HINT'),
  extractConstBlock('PAGE_HELP'),
  extractConstBlock('EMPTY_GUIDE'),
  ...[
    'settingCredRefs', 'loadCredentials', 'checkCredential',
    'nsStaticModelCount', 'discReset', 'discErrText', 'discErrKind', 'discIsStatic', 'discProbe', 'discFinish',
    'discoverModels', 'discoverAll', 'toggleDiscList', 'moreDisc', 'clearDisc', 'paintDisc',
    'modelCardHtml', 'provSectionHtml', 'providerKind', 'currentSession', 'sessionPreset', 'sessionTitleHtml', 'isSubagentSession',
    'pageHelp', 'allCheckCard', 'emptyGuide', 'sessionModelOf', 'chatModelKey',
  ].map(extractFn),
  extractAssign('Pages.credentials = '),
  extractAssign('Pages.models = '),
];

// ---------------- stubs ----------------
const State = { providers: [], models: { groups: [], current: {} }, disc: null, settings: null, credentials: null, allCheck: null };
const fmt = {
  esc: s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
  // pageHelp/allCheckCard 里给 onclick 参数用的转义（与 app.js 同实现）
  attr: v => fmt.esc(JSON.stringify(String(v))),
};
// 说明卡折叠状态：与生产默认一致（**默认收起**），localStorage 不参与断言
const localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const helpCollapsed = () => true;
// 界面偏好：沙盒一律取默认值（不读 ui-prefs.yaml，避免断言依赖运行它的那台机器的偏好）
const uiPref = (key, def) => def;
const UI = { warn: m => log('[warn] ' + m), ok: m => log('[ok] ' + m), err: m => log('[err] ' + m), info: m => log('[info] ' + m), confirm: async () => true };
const scopeTag = () => '';
const crumbOf = () => '';
const stampText = () => '';
const loaderFresh = () => false;
const stampLoader = () => {};
let renderCalls = 0;
let renderFn = () => {};
const render = () => { renderCalls++; renderFn(); };
const Pages = {};
const domEls = {};
const document = {
  getElementById: id => {
    if (!domEls[id]) domEls[id] = { innerHTML: '', scrollIntoView() { domEls[id].scrolled = true; } };
    return domEls[id];
  },
};
function rpc(method, args) {
  return new Promise((res, rej) => {
    const body = JSON.stringify({ type: 'client-request', rpcId: 'h' + Math.random().toString(36).slice(2), method, payload: { args } });
    const req = http.request({ host: '127.0.0.1', port: PORT, path: '/api/' + method, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, r => {
      let d = ''; r.on('data', c => d += c); r.on('end', () => {
        let j; try { j = JSON.parse(d); } catch { return rej(new Error('non-json')); }
        if (!j.result?.ok) { const e = new Error((j.result?.error?.code ? '[' + j.result.error.code + '] ' : '') + (j.result?.error?.message || 'fail')); return rej(e); }
        res(j.result.value);
      });
    });
    req.on('error', rej); req.write(body); req.end();
  });
}
const API = {
  call: async (method, payload) => {
    if (method === 'llm.discoverModels') return rpc('llm/discoverModels', { settingsNs: payload.settingsNs, request: { provider: payload.provider } });
    if (method === 'session.models') { const v = await rpc('session/modelCatalog', {}); return { current: v.default, groups: v.groups, routableProviders: v.routableProviders || [], routable: (v.routableProviders || []).length > 0, failures: v.failures || [] }; }
    if (method === 'llm.providers') {
      const [list, cat] = await Promise.all([rpc('llm/listConfigurableProviders', {}), rpc('session/modelCatalog', {}).catch(() => null)]);
      const routable = new Set((cat && cat.routableProviders) || []);
      const inCat = new Set(((cat && cat.groups) || []).map(g => g.id));
      return { providers: (list || []).map(x => ({ provider: x.provider, displayName: x.displayName, settingsNs: x.settingsNs, settingsPath: x.settingsPath || [], active: routable.has(x.provider), inCat: inCat.has(x.provider) })) };
    }
    if (method === 'settings.describe') return rpc('settings/describe', {});
    if (method === 'credentials.describe') return rpc('credentials/describe', { refs: payload.refs || [] });
    throw new Error('stub 未实现 ' + method);
  },
  localCredentials: async () => {
    // 走真实端点逻辑（server.cjs 里那段），不依赖后端是否重启
    const srv = fs.readFileSync(path.join(DIR, 'server.cjs'), 'utf8');
    const i = srv.indexOf("if (pathname === '/api/local/credentials')");
    let k = srv.indexOf('{', i), depth = 0, j = k;
    for (; j < srv.length; j++) { if (srv[j] === '{') depth++; else if (srv[j] === '}') { depth--; if (depth === 0) { j++; break; } } }
    const captured = [];
    const res = { writeHead() { return this; }, end(s) { captured.push(JSON.parse(s)); } };
    new Function('fs', 'path', 'res', 'pathname', 'req', srv.slice(i, j))(fs, await import('path'), res, '/api/local/credentials', {});
    return captured[0];
  },
};
async function loadSettings() { State.settings = await API.call('settings.describe', {}); return true; }

// ⚠️ Pages 必须作为参数传入：parts 里的 `Pages.credentials = …` 赋值要靠它；
//    new Function 的作用域链只到 global，拿不到本模块作用域里的 const Pages。
const sandbox = { State, fmt, UI, API, document, console, Math, Object, Array, Number, Date, String, Set, JSON, loadSettings, scopeTag, crumbOf, stampText, loaderFresh, stampLoader, render, localStorage, helpCollapsed, uiPref, Pages };
const code = parts.join('\n\n');
const factory = new Function(...Object.keys(sandbox), code + '\nreturn { discReset, discoverModels, discoverAll, toggleDiscList, moreDisc, clearDisc, provSectionHtml, settingCredRefs, nsStaticModelCount, loadCredentials, Pages, CRED_NAME_RE };');
const F = factory(...Object.values(sandbox));

(async () => {
  // 准备真实数据
  State.providers = (await API.call('llm.providers', {})).providers;
  State.models = await API.call('session.models', {});
  await loadSettings();
  log('候选供应商 ' + State.providers.length + ' 个；模型目录 ' + (State.models.groups || []).length + ' 组');

  log('\n=== 1. 单供应商探测（deepseek）===');
  try { await F.discoverModels('deepseek'); log('无异常'); } catch (e) { log('!! 异常 ' + e.message); }
  // 现在只重绘「供应商接入」那张卡（#provcard），不做整页 render
  log('discFinish 后整页 render 调用次数 = ' + renderCalls + '（期望 0，改走 paintDisc）');
  log('provcard 被重绘 = ' + (domEls['provcard'] ? '是' : '否') + '；卡滚动 = ' + !!domEls['provcard']?.scrolled);
  log('结果条数 = ' + Object.keys(State.disc.results).length);

  log('\n=== 2. 失败供应商的说明（deepseek-official）===');
  await F.discoverModels('deepseek-official');
  const h0 = F.provSectionHtml();
  const failRow = h0.split('<tr').find(s => s.includes('deepseek-official')) || '';
  log('静态清单数 nsStaticModelCount(llm-deepseek) = ' + F.nsStaticModelCount('llm-deepseek'));
  log('失败行里是否提到静态清单: ' + /静态清单/.test(failRow));
  log('失败行操作: ' + (/看静态清单/.test(failRow) ? '「看静态清单」✅' : '❌ ' + failRow.slice(0, 240)));

  log('\n=== 3. 全量探测 + 行内结果 + 分页 ===');
  await F.discoverAll();
  log('结果条数 ' + Object.keys(State.disc.results).length + '（候选 ' + State.providers.length + '）');
  let h = F.provSectionHtml();
  // 不变式：结果内联在各自行下，所以**顺序必须稳定**（不能按可发现性重排，否则点一次探测整张表重排）。
  // 注意表格是按 provider kind 分组的，所以"分组后的顺序"本来就 ≠ 扁平候选清单顺序 —— 比的是**两次渲染是否一致**。
  const orderOf = x => [...x.matchAll(/onclick="discoverModels\('([^']+)'\)"/g)].map(m => m[1]).join(',');
  const order1 = orderOf(h);
  const order2 = orderOf(F.provSectionHtml());
  log('供应商行数 = ' + order1.split(',').length + '（候选 ' + State.providers.length + '）');
  log('两次渲染顺序一致（未按可发现性重排）: ' + (order1 === order2 && order1.length > 0));
  log('出现「可发现 N」徽标 = ' + ((h.match(/可发现 \d+/g) || []).length) + ' 条');
  log('deepseek-official 行含「通道不支持」: ' + /通道不支持/.test(h));

  State.disc.open['openrouter'] = true; State.disc.shown['openrouter'] = 24;
  h = F.provSectionHtml();
  log('openrouter 展开首批卡片数 = ' + ((h.match(/class="card"/g) || []).length) + '（期望 24）· 明细行 ' + ((h.match(/disc-detail/g) || []).length));
  F.moreDisc('openrouter');
  h = F.provSectionHtml();
  log('moreDisc 后卡片数 = ' + ((h.match(/class="card"/g) || []).length) + '（期望 48）');
  State.providers.forEach(p => { const r = State.disc.results[p.provider]; if (r?.ok) { State.disc.open[p.provider] = true; } });
  Object.keys(State.disc.results).forEach(p => { State.disc.shown[p] = 24; });
  h = F.provSectionHtml();
  log('全部展开(每个 24 张)时 HTML 长度 = ' + h.length + '，卡片数 = ' + ((h.match(/class="card"/g) || []).length) + '（对比旧实现一次渲染 990 张 / 386KB）');
  // 清理：别把"全部展开"的状态带进后面的整页渲染断言
  F.clearDisc();
  log('clearDisc 后 disc = ' + JSON.stringify(State.disc && State.disc.results) + '（应为 {}，且不再触发整页 render：renderCalls=' + renderCalls + '）');

  log('\n=== 4. 凭据：设置里引用的键名 ===');
  const refs = F.settingCredRefs(State.settings);
  log('byName = ' + JSON.stringify(refs.byName));
  log('byNs.llm-deepseek = ' + JSON.stringify(refs.byNs['llm-deepseek']));
  log('inline.web-search-deepseek = ' + JSON.stringify(refs.inline['web-search-deepseek']));

  log('\n=== 5. 凭据页完整渲染 ===');
  await F.loadCredentials(true);
  const local = State.credentials.local;
  log('本机文件 refs = ' + JSON.stringify(local?.refs) + ' / records = ' + JSON.stringify(local?.records));
  log('describe 结果 = ' + JSON.stringify(State.credentials.credentials));
  const html = F.Pages.credentials();
  log('页面 HTML 长度 ' + html.length);
  log('页面里出现 DEEPSEEK_API_KEY: ' + html.includes('DEEPSEEK_API_KEY'));
  log('出现「已配置」标签: ' + /已配置<\/span>/.test(html));
  log('出现「缺 Key」: ' + html.includes('缺 Key'));
  log('出现「配置引用了、但还没配好」: ' + html.includes('配置引用了、但还没配好'));
  // 找出「已配置的凭据」卡里到底列了几行
  const card = html.slice(html.indexOf('已配置的凭据'), html.indexOf('本机凭据文件里的其他键名') > 0 ? html.indexOf('本机凭据文件里的其他键名') : html.length);
  log('「已配置的凭据」卡内容片段:\n' + card.slice(0, 700));

  log('\n=== 6. 大模型页完整渲染（发现入口已并入供应商接入）===');
  let mh;
  try { mh = F.Pages.models(); log('无异常，HTML 长度 ' + mh.length); }
  catch (e) { log('!! 抛异常 ' + e.message + '\n' + e.stack.split('\n').slice(0, 5).join('\n')); }
  if (mh) {
    const iModels = mh.indexOf('📦 可用模型');
    const iProv = mh.indexOf('id="provcard"');
    const nProv = (State.providers || []).length;
    const nBtn = (mh.match(/onclick="discoverModels\(/g) || []).length;
    log('已移除独立发现面板: ' + !mh.includes('id="discpanel"') + '（页面里 discpanel 出现 ' + (mh.match(/discpanel/g) || []).length + ' 次）');
    log('「可用模型」卡头已无发现按钮: ' + !mh.includes('🔍 发现模型'));
    log('发现入口只剩一处：每行一个「探测」= ' + nBtn + ' / 候选 ' + nProv + ' → ' + (nBtn === nProv && nProv > 0));
    log('卡头「全部探测」出现次数 = ' + (mh.match(/全部探测/g) || []).length + '（应为 1）');
    log('顺序: 可用模型@' + iModels + ' < 供应商接入(id=provcard)@' + iProv + ' → ' + (iProv > iModels && iModels > 0));
    log('llm-deepseek 行含「静态清单 4 个模型」: ' + /静态清单 4 个模型/.test(mh));
    const mOnclick = [...new Set([...mh.matchAll(/onclick="([a-zA-Z_$][\w$]*)\(/g)].map(m => m[1]))];
    const mMissing = mOnclick.filter(n => !new RegExp('function\\s+' + n + '\\s*\\(').test(src));
    log('大模型页 onclick: ' + mOnclick.join(', ') + ' | 未定义: ' + (mMissing.join(', ') || '无'));
  }

  log('\n=== 7. onclick 定义核对（凭据页）===');
  const onclickNames = [...html.matchAll(/onclick="([a-zA-Z_$][\w$]*)\(/g)].map(m => m[1]);
  const uniq = [...new Set(onclickNames)];
  const missing = uniq.filter(n => !new RegExp('function\\s+' + n + '\\s*\\(').test(src));
  log('凭据页 onclick: ' + uniq.join(', ') + ' | 未定义: ' + (missing.join(', ') || '无'));

  log('\n=== 8. 降级路径：后端没有 /api/local/credentials（未重启）===');
  const saved = API.localCredentials;
  API.localCredentials = async () => { throw new Error('HTTP 404'); };
  State.credLocal = null; State.credentials = null;
  try {
    await F.loadCredentials(true);
    const h2 = F.Pages.credentials();
    log('无异常，HTML 长度 ' + h2.length);
    log('提示了本机文件读取失败: ' + /本机凭据文件读取失败/.test(h2));
    log('提示了重启控制台: ' + /重启控制台/.test(h2));
    log('仍然列出了 DEEPSEEK_API_KEY（靠设置引用兜底）: ' + h2.includes('DEEPSEEK_API_KEY'));
    log('仍然显示「已配置」: ' + /已配置<\/span>/.test(h2));
  } catch (e) { log('!! 异常 ' + e.message); }
  API.localCredentials = saved;

  fs.writeFileSync(OUT, out.join('\n'));
  console.log('DONE');
})().catch(e => { console.log('FATAL ' + e.message); fs.writeFileSync(OUT, out.join('\n') + '\nFATAL ' + e.stack); });
