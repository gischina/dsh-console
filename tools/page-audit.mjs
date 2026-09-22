/* DSH Console — 工具脚本 page-audit.mjs
 * Copyright 2026 liwei (易智瑞西安) <liwei@geoscene.cn>
 * SPDX-License-Identifier: Apache-2.0
 *
 * 依据 Apache License 2.0 授权使用与分发；许可证全文见项目根目录 LICENSE，摘要见 NOTICE。
 */
/* 页面骨架审计（静态 + 真实端点）—— 对应"所有模块都写清楚 / 验证功能可用性"两项要求。
 *
 * 为什么需要：新加的「本页说明 + 功能自检 + 空态引导」是靠命名约定串起来的
 * （路由 id = PAGE_HELP key = PAGE_CHECKS key = 页内调用参数），任何一处写错都会**静默失效**
 * ——页面上什么都不会显示，也不会报错。这个脚本盯着这些约定。
 *
 * 两部分：
 *   A. 静态审计：从 app.js 抽取 ROUTES / PAGE_HELP / PAGE_CHECKS / EMPTY_GUIDE 做一致性断言，
 *      并核对新加按钮的 onclick 目标是否真有定义（"点了没反应"最常见的根因）。
 *   B. 端点探测：按自检项真实调用一遍各页依赖的端点（只读），报告通过/失败 ——
 *      保证「功能自检」打开时不会满屏红。
 *
 * 用法：node tools/page-audit.mjs   → 结果写 tools/page-audit-out.txt
 * 依赖：控制台在 127.0.0.1:3081（默认，可用 CONSOLE_PORT 覆盖）运行（B 部分要它代理到 DSH）。
 */
import fs from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

const DIR = path.resolve(fileURLToPath(new URL('../', import.meta.url)));  // 项目根（tools/ 的上一级）
const PORT = Number(process.env.CONSOLE_PORT || 3081);
const src = fs.readFileSync(DIR + '/public/app.js', 'utf8');
const out = [];
const log = s => out.push(s);
let fails = 0;
const ok = (cond, label, extra) => { log((cond ? '  ✅ ' : '  ❌ ') + label + (extra ? ' — ' + extra : '')); if (!cond) fails++; };

/* ---------- 抽取工具 ---------- */
function sliceBlock(marker, open, close) {
  const i = src.indexOf(marker);
  if (i < 0) throw new Error('未找到 ' + marker);
  const k = src.indexOf(open, i);
  let depth = 0, j = k;
  for (; j < src.length; j++) {
    if (src[j] === open) depth++;
    else if (src[j] === close) { depth--; if (depth === 0) { j++; break; } }
  }
  return src.slice(k, j);
}
const routesBlock = sliceBlock('const ROUTES = [', '[', ']');
const routeIds = [...routesBlock.matchAll(/\{\s*id:'([A-Za-z0-9_$]+)'/g)].map(m => m[1]);
const routePaths = [...routesBlock.matchAll(/path:'([^']+)'/g)].map(m => m[1]);

const helpBlock = sliceBlock('const PAGE_HELP = {', '{', '}');
const helpIds = [...helpBlock.matchAll(/^  ([A-Za-z][A-Za-z0-9_$]*): \{/gm)].map(m => m[1]);
const helpGo = [...helpBlock.matchAll(/go: \[([^\]]*)\]/g)].flatMap(m => m[1].split(',').map(s => s.trim().replace(/^'|'$/g, '')).filter(Boolean));

const checksBlock = sliceBlock('const PAGE_CHECKS = {', '{', '}');
const checkIds = [...checksBlock.matchAll(/^  ([A-Za-z][A-Za-z0-9_$]*): \[/gm)].map(m => m[1]);
const emptyIds = [...sliceBlock('const EMPTY_GUIDE = {', '{', '}').matchAll(/^  ([A-Za-z][A-Za-z0-9_$]*): \{/gm)].map(m => m[1]);

/* ---------- A. 静态审计 ---------- */
log('=== A. 静态审计（命名约定与接线）===');
log('路由 ' + routeIds.length + ' 个：' + routeIds.join(', '));

const uniq = a => [...new Set(a)];
const diff = (a, b) => a.filter(x => !b.includes(x));

log('\n[1] PAGE_HELP 覆盖');
ok(!diff(routeIds, helpIds).length, '每个路由都有说明卡', '缺：' + (diff(routeIds, helpIds).join(', ') || '无'));
ok(!diff(helpIds, routeIds).length, '没有多余/拼错的说明卡 key', '多：' + (diff(helpIds, routeIds).join(', ') || '无'));
for (const id of routeIds) {
  const seg = helpBlock.slice(helpBlock.indexOf('\n  ' + id + ': {'));
  const body = seg.slice(0, seg.indexOf('\n  },'));
  const fields = ['what', 'src', 'use', 'go'].filter(f => new RegExp('\\b' + f + ':').test(body));
  ok(fields.length === 4, id + ' 说明卡四要素齐全', fields.join('/'));
}
ok(!diff(uniq(helpGo), routeIds).length, '说明卡里的"相关页"跳转都是合法路由', '非法：' + (diff(uniq(helpGo), routeIds).join(', ') || '无'));

log('\n[2] PAGE_CHECKS 覆盖（自检已统一收进系统状态页，数据仍按模块分组）');
const pagesBlock = src.slice(src.indexOf('/* ---------- 页面渲染 ---------- */'));
ok(!diff(routeIds, checkIds).length, '每个模块都有自检项', '缺：' + (diff(routeIds, checkIds).join(', ') || '无'));
const checkCounts = checkIds.map(id => {
  const seg = checksBlock.slice(checksBlock.indexOf('\n  ' + id + ': ['));
  const body = seg.slice(0, seg.indexOf('\n  ],'));
  return { id, n: (body.match(/\{ name:/g) || []).length };
});
ok(checkCounts.every(c => c.n >= 2), '每模块至少 2 个自检项', checkCounts.map(c => c.id + ':' + c.n).join(' '));
ok(/function runAllChecks\(/.test(src) && /function allCheckCard\(/.test(src) && /function runModuleCheck\(/.test(src),
  '统一自检三件套就位（runAllChecks / allCheckCard / runModuleCheck）');
ok(/runAllChecks\(\)/.test(src.slice(src.indexOf('Pages.host'))), '系统状态页接入「全模块自检」入口');
ok(!/pageCheckBtn\(|pageCheckCard\(|runPageCheck\(/.test(pagesBlock), '各页不再有独立的自检按钮/结果卡');

log('\n[3] 空态引导');
ok(!diff(emptyIds, routeIds).length, '空态引导 key 都是合法路由', '非法：' + (diff(emptyIds, routeIds).join(', ') || '无'));

log('\n[4] 每页模板都接入了说明卡');
for (const id of routeIds) {
  const has = new RegExp("pageHelp\\('" + id + "'\\)").test(pagesBlock);
  ok(has, id + ' 页接入了说明卡');
}

log('\n[5] 新增交互函数的 onclick 目标是否都有定义');
const newHandlers = ['toggleHelp', 'copyText', 'runAllChecks', 'runModuleCheck', 'closeAllCheck', 'refreshHome', 'reloadSkillsScope', 'trajMore', 'emptyGuide', 'perfCard', 'recordPerf'];
for (const fn of newHandlers) {
  const defined = new RegExp('(function\\s+' + fn + '\\s*\\()|(\\(\\s*\\)\\s*=>)|(' + fn + '\\s*\\()').test(src) &&
    new RegExp('(function\\s+' + fn + '\\b)|(const\\s+' + fn + '\\s*=)').test(src);
  ok(defined, '有定义：' + fn);
}
// 页面里所有 onclick="xxx(" 的全局函数都要有定义（抓"点了没反应"）
const onclickNames = uniq([...pagesBlock.matchAll(/onclick="([A-Za-z_$][\w$]*)\(/g)].map(m => m[1]));
const missing = onclickNames.filter(n => !new RegExp('(function\\s+' + n + '\\b)|(const\\s+' + n + '\\s*=)').test(src) && !['Pages', 'Table', 'Chat', 'API', 'UI', 'fmt', 'Mux'].includes(n));
ok(!missing.length, '页面上所有 onclick 全局函数都有定义（' + onclickNames.length + ' 个）', '未定义：' + (missing.join(', ') || '无'));

log('\n[6] 结构健康度');
ok(src.split('\n').length > 0, 'app.js 行数 ' + src.split('\n').length);
ok(/function pageHelp\(/.test(src) && /function allCheckCard\(/.test(src), '骨架函数就位');
ok(/PERF_WARN_MS/.test(src) && /function perfCard\(/.test(src), '渲染性能监控就位');
ok(/content-visibility:auto/.test(fs.readFileSync(DIR + '/public/style.css', 'utf8')), 'CSS 屏外跳过渲染已启用（content-visibility）');

/* ---------- B. 真实端点探测 ---------- */
function req(path, method = 'GET', body) {
  return new Promise(res => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: '127.0.0.1', port: PORT, path, method, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} }, resp => {
      let d = ''; resp.on('data', c => d += c);
      resp.on('end', () => { let j = null; try { j = JSON.parse(d); } catch {} res({ status: resp.statusCode, json: j, raw: d }); });
    });
    r.on('error', e => res({ status: 0, err: e.message }));
    if (data) r.write(data);
    r.end();
  });
}
const rpc = async (method, args = {}) => {
  const r = await req('/api/' + method, 'POST', { type: 'client-request', rpcId: 'a' + Math.random().toString(36).slice(2), method, payload: { args } });
  if (r.status !== 200) throw new Error('HTTP ' + r.status);
  if (!r.json || !r.json.result) throw new Error('响应格式异常');
  if (!r.json.result.ok) throw new Error((r.json.result.error?.code ? '[' + r.json.result.error.code + '] ' : '') + (r.json.result.error?.message || 'fail'));
  return r.json.result.value;
};

(async () => {
  log('\n=== B. 端点探测（各页自检项依赖的只读端点）===');
  const st = await req('/api/local/dsh');
  log('DSH 状态：' + JSON.stringify({ state: st.json?.state, origin: st.json?.origin, version: st.json?.dshVersion }));
  if (st.json?.state !== 'ok') { log('!! DSH 未就绪，跳过 B 部分'); }
  else {
    const list = await rpc('session/list', { _request: {} });
    const items = list.items || [];
    const main = items.find(s => s.origin !== 'subagent') || items[0] || {};
    const sid = main.sessionId;
    log('会话 ' + items.length + ' 个 · 取当前会话 ' + String(sid).slice(0, 18) + '… · cwd=' + (main.cwd || '—'));

    const probes = [
      ['session/list', () => rpc('session/list', { _request: {} }), v => (v.items || []).length + ' 个会话'],
      ['session/modelCatalog', () => rpc('session/modelCatalog', {}), v => (v.groups || []).length + ' 组 · 可路由 ' + (v.routableProviders || []).length],
      ['llm/listConfigurableProviders', () => rpc('llm/listConfigurableProviders', {}), v => (v || []).length + ' 个候选'],
      // 抽样探测：单看一个供应商容易误判（本机 llm-deepseek 恰好是唯一没注册发现的通道）
      ['llm/discoverModels(抽样)', () => rpc('llm/discoverModels', { settingsNs: 'llm-deepseek', request: { provider: 'deepseek' } })
        .then(v => ({ n: (Array.isArray(v) ? v : v.models || []).length }), e => { throw e; }),
        v => v.n + ' 个模型', true],
      ['settings/describe', () => rpc('settings/describe', {}), v => (v.namespaces || []).length + ' 个命名空间'],
      ['skills/list', () => rpc('skills/list', { request: { sessionId: sid } }), v => (v.skills || []).length + ' 个技能'],
      ['subagents/list', () => rpc('subagents/list', { parentSessionId: sid }), v => (v.entries || []).length + ' 个子代理'],
      ['goals/get', () => rpc('goals/get', { agentId: sid }), v => ((v && v.goal) ? '有目标' : '无目标（正常）')],
      ['agentPresets/list', () => rpc('agentPresets/list', {}), v => (v.presets || []).length + ' 个预设'],
      ['pluginInventory/list', () => rpc('pluginInventory/list', {}), v => (v.entries || []).length + ' 条运行时'],
      ['commands/list', () => rpc('commands/list', { agentId: sid }), v => (v || []).length + ' 条命令'],
      ['fileReferences/list', () => rpc('fileReferences/list', { agentId: sid, query: '' }), v => (v || []).length + ' 个候选'],
      ['messageFeedback/list', () => rpc('messageFeedback/list', { request: { sessionId: sid } }), v => (((v.value && v.value.items) || []).length) + ' 条反馈'],
      ['session/canOpenWorkspacePath', () => rpc('session/canOpenWorkspacePath', {}), v => (v ? '支持打开' : '不支持打开')],
      ['workspaceFiles/list(cwd)', () => rpc('workspaceFiles/list', { workspaceFileScopeId: sid, path: main.cwd || '' }), v => (v.entries || []).length + ' 个条目'],
      // 本机把 session-query 索引配成 openAt:never，检索天然不可用 —— 自检项里已标为「提示」
      ['session/search（可选）', () => rpc('session/search', { request: { query: 'a' } }), v => (Array.isArray(v) ? v.length : (v.items || []).length) + ' 条命中', true],
    ];
    for (const [name, fn, want, opt] of probes) {
      try { const v = await fn(); log('  ✅ ' + name + ' — ' + want(v)); }
      catch (e) {
        if (opt) log('  ⚠️ ' + name + ' — 提示（预期内，页面自检里不计失败）：' + e.message);
        else { log('  ❌ ' + name + ' — ' + e.message); fails++; }
      }
    }
    // 本机端点
    const locals = [
      ['/api/local/dsh', '/api/local/dsh', v => v.state],
      ['/api/local/credentials', '/api/local/credentials', v => 'refs ' + (v.refs || []).length],
      ['/api/local/mcp', '/api/local/mcp', v => (v.servers || []).length + ' 个服务'],
      ['/api/local/plugins', '/api/local/plugins', v => (v.plugins || []).length + ' 个插件 · ' + v.source],
      ['/api/local/skills?cwd=…', '/api/local/skills?cwd=' + encodeURIComponent(main.cwd || ''), v => (v.roots || []).length + ' 个根'],
      ['/api/local/deliverables?cwd=…', '/api/local/deliverables?limit=5&cwd=' + encodeURIComponent(main.cwd || ''), v => (v.items || []).length + ' 个文件'],
    ];
    log('\n本机端点（console 自带，不经 DSH）：');
    for (const [name, p, want] of locals) {
      const r = await req(p);
      if (r.status === 200 && r.json) log('  ✅ ' + name + ' — ' + want(r.json));
      else { log('  ❌ ' + name + ' — HTTP ' + r.status + ' ' + String(r.raw || r.err).slice(0, 120)); fails++; }
    }
  }

  log('\n=== 结论 ===');
  log(fails ? ('静态审计失败 ' + fails + ' 项 —— 见上面 ❌') : '静态审计全部通过');
  fs.writeFileSync(DIR + '/tools/page-audit-out.txt', out.join('\n'));
  console.log('DONE fails=' + fails);
})().catch(e => {
  log('FATAL ' + e.stack);
  fs.writeFileSync(DIR + '/tools/page-audit-out.txt', out.join('\n'));
  console.log('FATAL ' + e.message);
});
