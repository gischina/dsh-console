/* DSH Console — 前端单页应用
 * Copyright 2026 liwei (易智瑞西安) <liwei@geoscene.cn>
 * SPDX-License-Identifier: Apache-2.0
 *
 * 依据 Apache License 2.0 授权使用与分发；许可证全文见项目根目录 LICENSE，摘要见 NOTICE。
 */
/* ============ DSH Console 前端 ============ */
/* ============ API 层 ============
   DSH 的一元 RPC 走 Typert Remote：
     · 端点名形如 `ns/method`（`POST /api/session/list`）
     · 信封固定为 { type:'client-request', rpcId, method:'<ns>/<method>', payload:{ args:{…} } }
     · 参数名由各端点的 descriptor 决定（`_request` / `request` / 具名参数），并不统一
   页面里原先的 `ns.method(...)` 调用保持原样，由这里的一张**翻译表**转成
   【端点 + args】：语义没变的只登记映射，语义变了的（历史、审批、工作空间列表、宿主概要）
   在下面单独实现。依据：dsh-api-remotes/lib/client.js 的端点注册表 + 各包 types.d.ts。 */
const API = {
  url(m){ return '/api/' + m; },
  _hist: null,

  /** 客户端铸的幂等 id（session/prompt、subagents/prompt 要求自带 requestId） */
  newId(prefix){
    return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  },

  /** 打一个 Remote 端点：POST /api/<endpoint> + { payload:{ args } }，并解掉外层信封 */
  async post(endpoint, args) {
    const rpcId = 'c' + Date.now() + Math.random().toString(36).slice(2, 7);
    const res = await fetch(API.url(endpoint), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args: args || {} } }),
    });
    const txt = await res.text();
    let j; try { j = JSON.parse(txt); } catch {
      const hint = res.status === 401 ? '（DSH 需要访问令牌：点右上角状态栏配置）' : '';
      throw new Error('DSH 返回 HTTP ' + res.status + '，非 JSON 响应：' + txt.replace(/\s+/g, ' ').slice(0, 120) + hint);
    }
    if (j.type !== 'server-response') throw new Error('响应格式异常: ' + txt.slice(0, 200));
    if (!j.result?.ok) {
      const e = j.result?.error || {};
      throw new Error((e.code ? '[' + e.code + '] ' : '') + (e.message || '调用失败'));
    }
    return j.result.value;
  },

  /** 旧方法名 → [新端点, 旧参数 ⇒ 新 args]。语义没变的端点只在这里出现一次。
   *  映射函数返回 { __direct: 值 } 表示"这次调用我自己做完了，直接返回该值"；
   *  返回 null 表示"我做完了，返回 null"。 */
  MAP: {
    // ---- 会话 ----
    'session.list':        ['session/list',        () => ({ _request: {} })],
    // 向后翻页：{address, throughSeq(来自 follow 开屏的 cursor), beforeSeq, maxMessages}
    'session.page':        ['session/page',        p => ({ request: p.request })],
    'session.create':      ['session/create',      p => ({ request: { cwd: p.cwd, agentPreset: p.agentPreset, sessionId: p.sessionId } })],
    'session.fork':        ['session/fork',        p => ({ request: { sessionId: p.sessionId, atSeq: p.atSeq } })],
    'session.rename':      ['session/rename',      p => ({ request: { sessionId: p.sessionId, title: p.title } })],
    'session.cancel':      ['session/cancel',      p => ({ request: { sessionId: p.sessionId } })],
    'session.selectModel': ['session/selectModel', p => ({ request: { sessionId: p.sessionId, provider: p.provider, model: p.model, reasoningEffort: p.reasoningEffort } })],
    'session.prompt':      ['session/prompt',      p => ({ request: { requestId: API.newId('prompt'), sessionId: p.sessionId, mode: p.mode || 'queue', content: p.content, clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone } })],
    'session.updateQueue': ['session/updateQueue', p => ({ request: { sessionId: p.sessionId, itemId: p.itemId, action: p.action } })],
    'session.search':      ['session/search',      p => ({ request: { query: p.query } })],
    // 返回 { default, groups, routableProviders, failures }，这里补成页面读的形状
    'session.models':      ['session/modelCatalog', async () => {
      const v = await API.post('session/modelCatalog', {});
      return { __direct: {
        current: v.default,
        groups: v.groups,
        routableProviders: v.routableProviders || [],   // 真正可路由的供应商（"已激活"的判据）
        routable: (v.routableProviders || []).length > 0,
        failures: v.failures || [],
      } };
    }],
    // ---- 设置 / 凭据 ----
    'settings.describe':     ['settings/describe',     () => ({})],
    'settings.update':       ['settings/update',       p => ({ ns: p.ns, patch: p.value, expectedRevision: p.expectedRevision })],
    'settings.mutate':       ['settings/mutate',       p => ({ ns: p.ns, ops: p.ops, expectedRevision: p.expectedRevision })],
    'settings.replace':      ['settings/replace',      p => ({ ns: p.ns, section: p.section, expectedRevision: p.expectedRevision })],
    'settings.openDocument': ['settings/openSettingsDocument', () => ({})],
    'credentials.describe':  ['credentials/describe',  p => ({ refs: p.refs || [] })],
    // 旧接口一次能传多条；新接口一次一条，这里循环
    'credentials.set':       ['credentials/set',       async p => {
      for (const r of (p.refs || [])) await API.post('credentials/set', { ref: r.key, value: r.secret });
      return null;
    }],
    'credentials.unset':     ['credentials/unset',     async p => {
      for (const k of (p.keys || [])) await API.post('credentials/unset', { ref: k });
      return null;
    }],
    // ---- 工作空间 ----
    'workspace.create':              ['workspace/create',              p => ({ request: { path: p.path } })],
    'workspace.rename':              ['workspace/rename',              p => ({ request: { workspaceId: p.workspaceId, title: p.title } })],
    'workspace.delete':              ['workspace/delete',              p => ({ request: { workspaceId: p.workspaceId } })],
    'workspace.insertBefore':        ['workspace/insertBefore',        p => ({ request: { workspaceId: p.workspaceId, beforeWorkspaceId: p.beforeWorkspaceId } })],
    'workspace.insertSessionBefore': ['workspace/insertSessionBefore', p => ({ request: { workspaceId: p.workspaceId, sessionId: p.sessionId, beforeSessionId: p.beforeSessionId } })],
    // 按会话归档，不需要 workspaceId
    'workspace.archiveSession':      ['workspace/archiveSession',      p => ({ request: { sessionId: p.sessionId } })],
    // ---- 子代理 ----
    'subagent.list':      ['subagents/list',      p => ({ parentSessionId: p.parentSessionId })],
    // delivery 由调用方决定：'queue' 排到下一轮，'steer' 插到最近的步骤边界
    'subagent.prompt':    ['subagents/prompt',    p => ({ request: { requestId: API.newId('subprompt'), parentSessionId: p.parentSessionId, childSessionId: p.childSessionId, mode: 'continuable', delivery: p.delivery === 'steer' ? 'steer' : 'queue', content: p.content } })],
    'subagent.interrupt': ['subagents/interruptByParent', p => ({ parentSessionId: p.parentSessionId, childSessionId: p.childSessionId, mode: p.mode || 'continuable' })],
    // ---- 智能体预设 ----
    'agentPreset.list':         ['agentPresets/list',         () => ({})],
    'agentPreset.read':         ['agentPresets/read',         p => ({ agentPreset: p.agentPreset })],
    'agentPreset.select':       ['agentPresets/select',       p => ({ agentId: p.sessionId, agentPreset: p.agentPreset })],
    'agentPreset.copy':         ['agentPresets/copy',         p => ({ from: p.from, id: p.id, name: p.name })],
    'agentPreset.remove':       ['agentPresets/deletePreset', p => ({ id: p.id })],
    // 只有"打开智能体预设目录"，没有"打开某个智能体预设文档"
    'agentPreset.openDocument': ['settings/openAgentPresetDirectory', p => ({ agentPreset: p.agentPreset })],
    // ---- 大模型 ----
    // ⚠️ 线上字段名是 descriptor 的 `wire`，不一定等于 TS 参数名（如 agent / agentId）。
    // 这里用到 `agentId` 的端点：commands/*、fileReferences/list、goals/*、sessionReferenceResolver/*、agentPresets/select
    'llm.providers': ['llm/listConfigurableProviders', async () => {
      // ⚠️ 这个端点返回的是**所有候选供应商**（本机 40 个），不是"已接入的"。
      // 原实现给每条都写死 active:true，于是页面显示"已激活 40/40"，与事实相反。
      // 真正可路由的供应商由 session/modelCatalog 的 routableProviders 给出。
      const [list, cat] = await Promise.all([
        API.post('llm/listConfigurableProviders', {}),
        API.post('session/modelCatalog', {}).catch(() => null),
      ]);
      const routable = new Set((cat && cat.routableProviders) || []);
      const inCatalog = new Set(((cat && cat.groups) || []).map(g => g.id));
      return { __direct: { providers: (list || []).map(x => ({
        provider: x.provider, displayName: x.displayName, settingsNs: x.settingsNs,
        settingsPath: x.settingsPath || [],
        active: routable.has(x.provider),
        inCatalog: inCatalog.has(x.provider),
      })) } };
    }],
    // 实测契约（2026-09-20）：args 必须**同时**给 settingsNs 与 request.provider。
    //   缺 request.provider → llm/model-discovery-rejected "needs a provider route or a baseURL"
    //   命名空间本身没注册发现 → "no model discovery is registered for \"<ns>\""（本机仅 llm-deepseek）
    // 修好这一条之前，40 个供应商探测全是失败。
    'llm.discoverModels': ['llm/discoverModels', p => ({
      settingsNs: p.settingsNs,
      request: { provider: p.provider, ...(p.baseURL ? { baseURL: p.baseURL } : {}) },
    })],
    // ---- 技能 / 目标 / 宿主 ----
    'skill.list':    ['skills/list',    p => ({ request: { sessionId: p.sessionId } })],
    'goal.create':   ['goals/create',   p => ({ agentId: p.sessionId, request: { objective: p.objective } })],
    'goal.edit':     ['goals/edit',     p => ({ agentId: p.sessionId, ref: p.ref, request: { objective: p.objective } })],
    'goal.pause':    ['goals/pause',    p => ({ agentId: p.sessionId, ref: p.ref })],
    'goal.resume':   ['goals/resume',   p => ({ agentId: p.sessionId, ref: p.ref })],
    'goal.complete': ['goals/complete', p => ({ agentId: p.sessionId, ref: p.ref })],
    'goal.clear':    ['goals/clear',    p => ({ agentId: p.sessionId, ref: p.ref })],
    'goal.get':      ['goals/get',      p => ({ agentId: p.sessionId })],
    'host.openPath': ['session/openWorkspacePath', p => ({ request: { path: p.path } })],
    // ---- Remote 通道：端点名没变，只是参数从 {args:{旧名}} 变成新名字 ----
    'pluginInventory/list': ['pluginInventory/list', () => ({})],
    'commands/list':        ['commands/list',        p => ({ agentId: p.args?.agentId ?? State.sessionId })],
    'commands/execute':     ['commands/execute',     p => ({ agentId: p.args?.agentId ?? State.sessionId, line: p.args?.line, submittedAttachments: p.args?.submittedAttachments || [] })],
    'fileReferences/list':  ['fileReferences/list',  p => ({ agentId: p.args?.agentId ?? State.sessionId, query: p.args?.query ?? '' })],
    'sessionReferenceResolver/candidates': ['sessionReferenceResolver/candidates', p => ({ agentId: p.args?.agentId ?? State.sessionId, query: p.args?.query ?? '' })],
    'messageFeedback/list':   ['messageFeedback/list',   p => ({ request: p.args?.request ?? p.request })],
    'messageFeedback/put':    ['messageFeedback/put',    p => ({ request: p.args?.request ?? p.request })],
    'messageFeedback/delete': ['messageFeedback/delete', p => ({ request: p.args?.request ?? p.request })],
    // ---- 工作区文件（workspaceFiles/*，对齐原生 sidebar-files/documentpreview）----
    // ⚠️ 实测（0.1.5-rc.2）：线上参数名 workspaceFileScopeId = 会话 ID；
    //    首次 list 传会话 cwd（绝对路径）标识 scope 根，之后的目录一律传**相对 scope 根的路径**（'/' 分隔，
    //    返回的 listing.path 就是父目录的相对路径）；read 的 range 是行窗口 {offset,limit}，offset 从 1 起。
    'files.list': ['workspaceFiles/list', p => ({ workspaceFileScopeId: p.scopeId ?? State.sessionId, path: p.path || '' })],
    'files.read': ['workspaceFiles/read', p => ({ workspaceFileScopeId: p.scopeId ?? State.sessionId, path: p.path, range: { offset: p.offset, limit: p.limit } })],
    'files.stat': ['workspaceFiles/stat', p => ({ workspaceFileScopeId: p.scopeId ?? State.sessionId, path: p.path })],
    // ---- 目录选择（directoryPicker/*，DSH 原生通道）----
    // pick = **系统文件夹对话框**（native 后端，弹在宿主屏幕）；UI.pickDir 就调它。
    // list / mkdir 属 browse 后端，本部署没挂（实测 directory-picker/unavailable），
    // 保留映射只为命令行/后续面板直接可用。
    'dir.pick':  ['directoryPicker/pick',            () => ({})],
    'dir.list':  ['directoryPicker/list',            p => ({ path: p.path })],
    'dir.mkdir': ['directoryPicker/createDirectory', p => ({ path: p.path, name: p.name })],
    // ---- 能力探测：打开路径前先探一次，避免盲调后让用户看原始报错（无参 → boolean）----
    'host.canOpenPath': ['session/canOpenWorkspacePath', () => ({})],
    // ---- 动态插件运行时（dynamicCordisRunner/*）----
    // invoke/getClientCode 都需要 pluginRunId —— 只有插件正在会话中运行时才存在（由 agent 回合产生）。
    // 控制台的插件页是静态清单，没有活动 run，所以这里只接通端点（命令行/后续面板可直接用），
    // 不做无 run 时的伪 UI。
    'dyn.getClientCode': ['dynamicCordisRunner/getClientCode', p => ({ agentId: p.agentId ?? State.sessionId, pluginId: p.pluginId, pluginRunId: p.pluginRunId })],
    'dyn.invoke':        ['dynamicCordisRunner/invoke',        p => ({ pluginId: p.pluginId, pluginRunId: p.pluginRunId, method: p.method, args: p.args ?? null })],
  },

  /**
   * 调用一个 DSH 接口。method 可以是旧方法名（走 MAP 翻译）或新端点名（原样）。
   * @returns 解掉外层信封后的业务值
   */
  async call(method, payload = {}) {
    const spec = API.MAP[method];
    if (!spec) return API.post(method, payload);          // 已经是 ns/method 形式
    const [endpoint, build] = spec;
    const args = await build(payload || {});
    if (args === null) return null;                        // 循环型映射已经自己做完了
    if (args && args.__direct !== undefined) return args.__direct;   // 映射自己取了数并整形
    return API.post(endpoint, args);
  },

  /**
   * 会话事件流（含投影基线）。
   * 会话历史取 `session/follow` 流的开屏快照
   * （{ header, cursor, records, hasMore, projections }），取完即可取消那条流。
   * 轨迹 / 交付物 / 工作流 / 对话历史四个页面都读它，所以仍做 4 秒 TTL 缓存。
   */
  async history(sessionId, force) {
    // 子代理会话分流到 subagent 快照通道：session/follow 只服务主会话，对子代理返回空。
    // 轨迹/交付物/工作流/聊天历史都从这里取数，分流收在这一个口子上（列表未加载时按主会话处理，安全）。
    const s = (State.sessions || []).find(x => x.sessionId === sessionId);
    if (s && isSubagentSession(s)) return this.subHistory(s.parentSessionId, sessionId);
    const now = Date.now();
    if (!force && API._hist && API._hist.sessionId === sessionId && now - API._hist.at < 4000) return API._hist.value;
    const snap = await Mux.snapshot({ kind: 'session', sessionId });
    const value = {
      events: (snap.records || []).map(r => ({ event: r.event, view: r.view })),
      hasMore: snap.hasMore,
      projections: snap.projections,
      header: snap.header,
      cursor: snap.cursor,          // session/page 的 throughSeq 就取它
    };
    API._hist = { sessionId, at: now, value };
    return value;
  },

  /** 子代理会话历史：同一套 follow 快照，只是地址换成 subagent。
   *  返回形状与 history() 对齐（含 header/cursor），调用方可以无差别使用。 */
  async subHistory(parentSessionId, childSessionId, mode) {
    const snap = await Mux.snapshot({ kind: 'subagent', parentSessionId, childSessionId, mode: mode || 'continuable' });
    return { events: (snap.records || []).map(r => ({ event: r.event, view: r.view })), hasMore: snap.hasMore, projections: snap.projections, header: snap.header, cursor: snap.cursor };
  },

  /** 工作空间注册表：`workspace/follow` 的基线快照 */
  async workspaces() {
    return Mux.snapshot('workspace/follow');
  },

  /**
   * 本机凭据文件里的**键名清单**（只读键名，不含值）。
   * 为什么需要它：`credentials/describe` 只能"按名查询"，传 refs:[] 恒返回 {}，
   * 没有"列出全部凭据"的能力 —— 所以要么从本机文件拿候选名，要么永远显示"没有凭据"。
   * 状态仍以 DSH 的 describe 结果为准，这里只负责"有哪些名字值得去问"。
   */
  async localCredentials() {
    const r = await fetch('/api/local/credentials');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  },

  /**
   * 宿主概要：由真实数据拼装：
   *   · 模型 / 供应商 ← modelCatalog；工作目录 / 会话数 ← session 列表
   *   · DSH 版本 ← 控制台后端从本机读出来的 dshVersion
   */
  async host() {
    const [cat, list, local] = await Promise.all([
      API.call('session.models').catch(() => ({})),
      API.call('session.list').catch(() => ({ items: [] })),
      fetch('/api/local/dsh').then(r => r.json()).catch(() => ({})),
    ]);
    const items = list.items || [];
    const cur = items.find(s => s.sessionId === State.sessionId) || items[0] || {};
    return {
      version: local.dshVersion || '—',
      rev: local.dshRev || '',
      model: cat.current?.model || '—',
      provider: cat.current?.provider || '—',
      cwd: cur.cwd || '—',
      attachedSessions: items.length,
      runningSessions: items.filter(s => s.running).length,
      canOpenPath: true,
    };
  },

  /** 审批：$events 的 Remote Event waterfall，用 /api/$events/result 作答 */
  respondApproval(approval, allow) {
    return Stream.answerEvent(approval, { kind: 'result', value: allow ? 'allowed-once' : 'rejected' });
  },
  /** 提问作答：同一个应答通道，outcome.value 是 { answers:[{id,selected,custom?}] } */
  answerQuestion(question, answer) {
    return Stream.answerEvent(question, { kind: 'result', value: answer });
  },
};

/* ============ 轻量 UI 工具（替代原生 alert / prompt）============
   Toast  —— 右下角浮出，3 秒自动消失，不打断操作
   Modal  —— 自定义对话框，支持多行 JSON 编辑 + 校验 + 回车提交
   busy   —— 按钮 loading 态
================================================================ */
const UI = {
  /* ---------- Toast ---------- */
  _wrap() {
    let w = document.getElementById('toastwrap');
    if (!w) { w = document.createElement('div'); w.id = 'toastwrap'; w.className = 'toast-wrap'; document.body.appendChild(w); }
    return w;
  },
  toast(msg, kind = 'ok', ms = 3000) {
    const ico = { ok: '✅', err: '❌', warn: '⚠️', info: 'ℹ️' }[kind] || 'ℹ️';
    const el = document.createElement('div');
    el.className = 'toast ' + kind;
    el.innerHTML = '<span class="t-ico">' + ico + '</span><span>' + fmt.esc(String(msg)) + '</span>';
    this._wrap().appendChild(el);
    setTimeout(() => { el.classList.add('fade'); setTimeout(() => el.remove(), 260); }, ms);
  },
  ok(m, ms) { this.toast(m, 'ok', ms); },
  err(m, ms) { this.toast(m, 'err', ms || 5000); },
  warn(m, ms) { this.toast(m, 'warn', ms); },
  info(m, ms) { this.toast(m, 'info', ms); },

  /* ---------- Modal ---------- */
  /**
   * 打开一个输入对话框。
   * @param opts { title, hint, value, multiline, placeholder, okText, validate }
   * @returns Promise<string|null>  确认返回输入值；取消/关闭返回 null
   */
  prompt(opts = {}) {
    return new Promise((resolve) => {
      const multiline = opts.multiline !== false;      // 默认多行（JSON 编辑友好）
      const mask = document.createElement('div');
      mask.className = 'modal-mask';
      mask.innerHTML = `
        <div class="modal" role="dialog" aria-modal="true">
          <h3>${fmt.esc(opts.title || '输入')}</h3>
          <div class="modal-body">
            ${opts.hint ? '<div class="modal-hint">' + opts.hint + '</div>' : ''}
            ${multiline
              ? '<textarea id="modal-input" placeholder="' + fmt.esc(opts.placeholder || '') + '"></textarea>'
              : '<input id="modal-input" placeholder="' + fmt.esc(opts.placeholder || '') + '">'}
            <div class="modal-err" id="modal-err"></div>
          </div>
          <div class="modal-actions">
            <button class="btn" id="modal-cancel">取消</button>
            <button class="btn primary" id="modal-ok">${fmt.esc(opts.okText || '确定')}</button>
          </div>
        </div>`;
      document.body.appendChild(mask);
      const input = mask.querySelector('#modal-input');
      const errBox = mask.querySelector('#modal-err');
      input.value = opts.value ?? '';
      setTimeout(() => { input.focus(); if (!multiline) input.select(); }, 30);

      const close = (val) => { mask.remove(); document.removeEventListener('keydown', onKey); resolve(val); };
      const submit = () => {
        const v = input.value;
        if (opts.validate) {
          const e = opts.validate(v);
          if (e) { errBox.textContent = e; input.focus(); return; }
        }
        close(v);
      };
      const onKey = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); close(null); }
        // 单行框回车提交；多行用 Ctrl+Enter
        if (e.key === 'Enter' && (!multiline || e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); }
      };
      document.addEventListener('keydown', onKey);
      mask.querySelector('#modal-ok').onclick = submit;
      mask.querySelector('#modal-cancel').onclick = () => close(null);
      mask.onclick = (e) => { if (e.target === mask) close(null); };
    });
  },
  /**
   * 多字段表单弹层：**一次填完**，替代"连着弹两个 prompt"（那样用户点完第一步
   * 才知道还有第二步，还不能回头改第一步）。
   * @param opts { title, hint, fields:[{ key, label, hint, type:'text'|'textarea'|'select'|'note',
   *                value, placeholder, options:[{value,label}], validate(v, all) → 错误文案|null }],
   *                okText, width }
   * @returns Promise<null | { [key]: string }>  取消返回 null
   */
  form(opts = {}) {
    return new Promise((resolve) => {
      const fields = opts.fields || [];
      const fkey = k => 'mf-' + k;
      const body = fields.map(f => {
        if (f.type === 'note') {
          return '<div class="mf-note" id="' + fkey(f.key) + '">' + (f.html || fmt.esc(f.text || '')) + '</div>';
        }
        const lab = '<div class="mf-label">' + fmt.esc(f.label || f.key)
          + (f.hint ? ' <span class="muted">' + f.hint + '</span>' : '') + '</div>';
        if (f.type === 'select') {
          return '<div class="mf-field">' + lab
            + '<select class="input" id="' + fkey(f.key) + '">'
            + (f.options || []).map(o => '<option value="' + fmt.h(o.value) + '"'
              + (String(o.value) === String(f.value == null ? '' : f.value) ? ' selected' : '') + '>'
              + fmt.esc(o.label) + '</option>').join('')
            + '</select></div>';
        }
        if (f.type === 'textarea') {
          return '<div class="mf-field">' + lab
            + '<textarea class="input" id="' + fkey(f.key) + '" style="min-height:76px" placeholder="'
            + fmt.h(f.placeholder || '') + '">' + fmt.esc(f.value == null ? '' : f.value) + '</textarea></div>';
        }
        return '<div class="mf-field">' + lab
          + '<input class="input" id="' + fkey(f.key) + '" value="' + fmt.h(f.value == null ? '' : f.value)
          + '" placeholder="' + fmt.h(f.placeholder || '') + '"></div>';
      }).join('');

      const mask = document.createElement('div');
      mask.className = 'modal-mask';
      mask.innerHTML = '<div class="modal" style="width:min(' + (opts.width || 520) + 'px,100%)">'
        + '<h3>' + fmt.esc(opts.title || '填写') + '</h3>'
        + '<div class="modal-body">'
        + (opts.hint ? '<div class="modal-hint">' + opts.hint + '</div>' : '')
        + body
        + '<div class="modal-err" id="mf-err"></div>'
        + '</div>'
        + '<div class="modal-actions">'
        + '<button class="btn" id="mf-cancel">取消</button>'
        + '<button class="btn primary" id="mf-ok">' + fmt.esc(opts.okText || '确定') + '</button>'
        + '</div></div>';
      document.body.appendChild(mask);

      const inputs = {};
      fields.forEach(f => { if (f.type !== 'note') inputs[f.key] = mask.querySelector('#' + fkey(f.key)); });
      const errBox = mask.querySelector('#mf-err');
      const close = (v) => { mask.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
      const readAll = () => { const o = {}; for (const k of Object.keys(inputs)) o[k] = inputs[k].value; return o; };
      /** 逐字段校验；f.validate 若返回字符串则按模板替换 {v}（错误里带上当前值更省事） */
      const submit = () => {
        const all = readAll();
        for (const f of fields) {
          if (!f.validate) continue;
          const e = f.validate(all[f.key], all);
          if (e) {
            errBox.textContent = String(e).replace(/\{v\}/g, all[f.key] == null ? '' : all[f.key]);
            if (inputs[f.key]) inputs[f.key].focus();
            return;
          }
        }
        close(all);
      };
      const onKey = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); close(null); return; }
        const multi = /TEXTAREA/.test((e.target && e.target.tagName) || '');
        if (e.key === 'Enter' && (!multi || e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); }
      };
      document.addEventListener('keydown', onKey);
      mask.querySelector('#mf-ok').onclick = submit;
      mask.querySelector('#mf-cancel').onclick = () => close(null);
      mask.onclick = (e) => { if (e.target === mask) close(null); };
      const first = fields.find(f => f.type !== 'note');
      if (first && inputs[first.key]) setTimeout(() => { inputs[first.key].focus(); inputs[first.key].select && inputs[first.key].select(); }, 30);
    });
  },

  /** 确认对话框（替代 confirm），返回 Promise<boolean> */
  confirm(opts = {}) {
    return new Promise((resolve) => {
      const mask = document.createElement('div');
      mask.className = 'modal-mask';
      mask.innerHTML = `
        <div class="modal" style="width:min(460px,100%)">
          <h3>${fmt.esc(opts.title || '确认操作')}</h3>
          <div class="modal-body">
            <div style="font-size:13px;line-height:1.8">${opts.html || fmt.esc(opts.message || '确定继续？')}</div>
          </div>
          <div class="modal-actions">
            <button class="btn" id="modal-cancel">${fmt.esc(opts.cancelText || '取消')}</button>
            <button class="btn ${opts.danger ? 'danger' : 'primary'}" id="modal-ok">${fmt.esc(opts.okText || '确定')}</button>
          </div>
        </div>`;
      document.body.appendChild(mask);
      const close = (v) => { mask.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
      const onKey = (e) => { if (e.key === 'Escape') close(false); };
      document.addEventListener('keydown', onKey);
      mask.querySelector('#modal-ok').onclick = () => close(true);
      mask.querySelector('#modal-cancel').onclick = () => close(false);
      mask.onclick = (e) => { if (e.target === mask) close(false); };
      setTimeout(() => mask.querySelector('#modal-ok').focus(), 30);
    });
  },
  /**
   * 只读信息弹层：比 prompt/confirm 少掉输入与"确认"语义，纯粹用来"看一眼"。
   * 用途：会话统计、以及后续任何"点开是张表"的地方（不写死成某个面板专用）。
   * @param opts { title, html, hint, width, okText }
   * @returns Promise<void>  关闭即 resolve
   */
  panel(opts = {}) {
    return new Promise((resolve) => {
      const mask = document.createElement('div');
      mask.className = 'modal-mask';
      mask.innerHTML = '<div class="modal" style="width:min(' + Number(opts.width || 520) + 'px,100%)" role="dialog" aria-modal="true">'
        + '<h3>' + fmt.esc(opts.title || '详情') + '</h3>'
        + '<div class="modal-body">'
        + (opts.hint ? '<div class="modal-hint">' + opts.hint + '</div>' : '')
        + '<div class="panel-body">' + (opts.html || '') + '</div>'
        + '</div>'
        + '<div class="modal-actions"><button class="btn primary" id="modal-ok">' + fmt.esc(opts.okText || '关闭') + '</button></div>'
        + '</div>';
      document.body.appendChild(mask);
      const close = () => { mask.remove(); document.removeEventListener('keydown', onKey); resolve(); };
      const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
      document.addEventListener('keydown', onKey);
      mask.querySelector('#modal-ok').onclick = close;
      mask.onclick = (e) => { if (e.target === mask) close(); };
      setTimeout(() => { const b = mask.querySelector('#modal-ok'); if (b) b.focus(); }, 30);
    });
  },
  /**
   * 目录选择器 —— 直接弹**系统文件夹选择框**（用户明确要求：不要应用内一级级浏览）。
   *
   * 走 DSH 的 directoryPicker/pick：本部署挂的是 native 后端，它会在**宿主屏幕**上
   * 打开操作系统的目录对话框（Windows 下由子进程驱动 IFileOpenDialog），选完回绝对路径。
   * 控制台只绑 127.0.0.1、DSH 也只绑回环，所以这个框就弹在用户面前 —— 正是要的效果。
   *
   * 用户取消返回 null；宿主没挂 native 后端时（远程 / 无桌面会话部署）会报
   * directory-picker/unavailable，这时退回"手动填一个绝对路径"，而不是给一个假的浏览界面。
   *
   * @param opts { title, start } —— 只用于提示与退路文案；系统框自身的标题由 DSH 决定
   * @returns Promise<string|null> 选中目录绝对路径；取消返回 null
   */
  async pickDir(opts = {}) {
    UI.info('已请求系统文件夹选择框 —— 请在弹出的窗口里选择目录（窗口出现在运行 DSH 的那台机器的屏幕上）');
    let p;
    try {
      p = await API.call('dir.pick');
    } catch (e) {
      const msg = String((e && e.message) || e);
      if (/unavailable/i.test(msg)) {
        UI.warn('这个 DSH 部署没有挂原生目录选择器（远程 / 无桌面部署），改成手动填路径。');
        const v = await UI.prompt({ title: opts.title || '选择目录', multiline: false,
          value: opts.start || currentSession().cwd || '', okText: '使用该路径',
          hint: '系统对话框只在宿主有桌面会话时可用；这里直接填一个绝对路径。' });
        return v ? v.trim() : null;
      }
      UI.err('打开系统文件夹选择框失败：' + msg);
      return null;
    }
    if (p == null || p === '') return null;      // 用户在系统框里点了取消
    return String(p);
  },
  /** 按钮 loading 包装：执行期间禁用并显示加载态 */
  async busy(btn, fn) {
    const el = typeof btn === 'string' ? document.querySelector(btn) : btn;
    const old = el ? el.innerHTML : null;
    if (el) { el.classList.add('loading'); el.disabled = true; }
    try { return await fn(); }
    finally { if (el) { el.classList.remove('loading'); el.disabled = false; if (old != null) el.innerHTML = old; } }
  },
};

const State = { sessionId: null, sessions: [], host: null, skills: [], presets: [], models: null,
                providers: [], settings: null, error: null, wsOk: false,
                plugins: null, mcp: null, skillsScope: null,
                subagents: null, jobs: [], jobsBySession: {}, queuesBySession: {}, jobsAllView: false, jobsReady: false,
                searchUnavailable: false, approvals: [], questions: [], queue: [], goal: null,
                pendingImage: null, pendingFile: null, references: [],
                chatDraft: '', chatLogSession: null,   // 对话草稿 / 对话流属于哪个会话（见 render 的 paintDirect）
                pluginFilter: '',
                trajectory: null, deliverables: null, producedFiles: null, workflowRuns: null,
                workspaces: null, credentials: null,
                ftree: { scopeSession: null, dirs: {}, expanded: {}, preview: null, error: null } };

/** 是否子代理会话（origin 由 session/list 返回：'user' | 'subagent' | …） */
function isSubagentSession(s) { return s?.origin === 'subagent'; }

/** 某个会话的工作目录（取自 session/list 的 cwd）。工具行靠它把绝对路径压成 `~/…`，
 *  对齐原版的 relativizeToCwd —— 否则 C:\Users\…\dsh-demo2\notes\readme.txt 会占掉整行。 */
function cwdOf(sessionId) {
  const s = (State.sessions || []).find(x => x.sessionId === sessionId);
  return (s && s.cwd) || '';
}

/** 默认会话选择：优先记住的上次选择，其次第一个**主会话**（非子代理），最后才兜底第一条。
 *  为什么不直接取第一条：父 agent 发起子代理后，DSH 会新建子代理会话且列表按新旧排序，
 *  刷新/重连后"取第一条"会把当前会话悄悄切到子代理上，所有跟随会话的页面随之错位。 */
function pickDefaultSession(list) {
  list = list || [];
  try {
    const last = localStorage.getItem('dshCurrentSession');
    if (last && list.some(s => s.sessionId === last)) return last;
  } catch {}
  return (list.find(s => !isSubagentSession(s)) || list[0])?.sessionId || null;
}
/** 当前会话失效时的兜底：仍在列表里就不动（绝不因为新会话出现而切换）；不在则回默认。 */
function ensureCurrentSession() {
  const list = State.sessions || [];
  if (State.sessionId && list.some(s => s.sessionId === State.sessionId)) return;
  State.sessionId = pickDefaultSession(list);
  try { if (State.sessionId) localStorage.setItem('dshCurrentSession', State.sessionId); } catch {}
}

/** 会话树展开/折叠（父会话 → 子代理会话）。折叠状态存 localStorage，刷新后保留。 */
function sessCollapsedMap() {
  if (!State.sessCollapsed) {
    try { State.sessCollapsed = JSON.parse(localStorage.getItem('dshSessCollapsed') || '{}'); }
    catch { State.sessCollapsed = {}; }
  }
  return State.sessCollapsed;
}
function toggleSessBranch(id) {
  const m = sessCollapsedMap();
  m[id] = !m[id];
  try { localStorage.setItem('dshSessCollapsed', JSON.stringify(m)); } catch {}
  render({ paintOnly: true });
}

/** 取当前会话（页面绑定的那个）的完整信息。
 *  兜底链：绑定的会话 → 第一个主会话 → 第一条 → 空对象（不悄悄指到子代理上）。 */
function currentSession() {
  const list = State.sessions || [];
  return list.find(s => s.sessionId === State.sessionId)
    || list.find(s => !isSubagentSession(s))
    || list[0] || {};
}

/** 会话 ID 的短形式：去掉统一的 `session-` 前缀，只留真正区分会话的那一段 uuid。
 *  所有会话 ID 都带这个前缀，截前 8 位恰好只截到 "session-"，等于一个字符都没显示。
 *  完整 ID 一律放 title —— 界面上按"能认出来"为目的，不追求显示全。 */
function shortSid(id) { return String(id || '').replace(/^session-/, ''); }

/** 会话的 智能体预设。
 *  ⚠️ `session/list` 的**顶层不带 agentPreset**，值在 `projections.values.agentPreset`
 *  （follow 的 header 里也有一份）。两个来源都兜住，否则列表里那一列会整列显示 '—'。 */
function sessionPreset(s) {
  return s?.projections?.values?.agentPreset || s?.agentPreset || '';
}

/** 会话标题单元格：把「空会话」与「子代理会话」标出来。
 *  SessionSummary 带 blank / origin / parentSessionId —— 不标就看不出
 *  列表里那条无标题的其实是个空壳，或者其实是某个会话的子代理。
 *  子代理标签刻意只写「子代理」：父会话 ID 放悬停提示 —— 之前把 8 位父 ID
 *  排进可见文本，首页窄列表里标题被挤得只剩标签。 */
function sessionTitleHtml(s, w) {
  const title = s?.projections?.values?.title || '';
  const sub = isSubagentSession(s);
  const tags = (s?.blank === true ? '<span class="tag gray" style="font-size:10px">空会话</span> ' : '')
    + (sub ? '<span class="tag" style="font-size:10px" title="子代理会话 · 父会话 ' + fmt.esc(s.parentSessionId || '') + '">子代理</span> ' : '');
  const text = title || (s?.blank === true ? '（无内容）' : '（未命名）');
  const full = title || text;
  return tags + '<span class="ellip' + (w ? ' w' + w : '') + '" title="' + fmt.esc(full) + '">' + fmt.esc(text) + '</span>';
}

/* 插件功能分类（按包名匹配）+ 安全敏感标记 */
const PLUGIN_CATS = [
  { key:'session',  label:'会话与持久化', ico:'💾', match:/session|compaction|projection|checkpoint|storage|workspace|transcript/i },
  { key:'llm',      label:'模型与推理',   ico:'🧠', match:/llm|model-title|session-title|token-meter|persona|system-prompt/i },
  { key:'agent',    label:'代理与循环',   ico:'🔁', match:/^dsh-agent|agent-loop|agent-preset|goal|subagent|workflow|ralph|repeat-tool|tool-call-timeout/i },
  { key:'tools',    label:'工具',         ico:'🛠️', match:/tool-|tool$|code-runtime|fs-observation|str-replace/i },
  { key:'skill',    label:'技能',         ico:'🧩', match:/skill/i },
  { key:'mcp',      label:'MCP 桥接',     ico:'🔌', match:/mcp/i },
  { key:'sandbox',  label:'安全与沙箱',   ico:'🛡️', match:/sandbox|authorization|approval|permission|credentials|fs-sandbox|landlock|acl/i },
  { key:'process',  label:'进程与执行',   ico:'⚙️', match:/subprocess|bash|pwsh|shell|terminal|jobs|native-command|spawn/i },
  { key:'context',  label:'上下文与文件', ico:'📄', match:/attachment|file-reference|spill|output-retention|fs$|fs-|web|search/i },
  { key:'host',     label:'宿主与服务',   ico:'🖥️', match:/host-|webserver|api-gateway|api-remotes|web-app|frontend|home-paths|launch-env|commands|user-questions|telemetry|schedule/i },
  { key:'ui',       label:'界面',         ico:'🎨', match:/client-ui|client-|ui-/i },
  { key:'infra',    label:'基础设施',     ico:'🧱', match:/cordis|loader|hmr|timer|invariant|scope|settings|brand|locale|time-context|anonymous|skill-badge/i },
];
function pluginCat(p) {
  return PLUGIN_CATS.find(c => c.match.test(p.pkg) || c.match.test(p.id)) || { key:'other', label:'其他', ico:'📎' };
}
/* 安全敏感插件（页面需单独提示的） */
const SENSITIVE = /sandbox|authorization|approval|permission|credentials|fs-observation|subprocess/i;

/* 供应商分类（按 provider id 归类，用于大模型页分组展示） */
const PROVIDER_KIND = [
  { key: 'official', label: '官方直连', match: /deepseek-official|anthropic|openai|google|mistral|xai|moonshot|zhipu|qwen|doubao/i },
  { key: 'cloud',    label: '云平台',   match: /bedrock|azure|vertex|cloudflare|sagemaker|watson|oci|alibaba/i },
  { key: 'gateway',  label: '聚合网关', match: /gateway|openrouter|together|fireworks|groq|cerebras|siliconflow|aihub/i },
  { key: 'local',    label: '本地部署', match: /ollama|lmstudio|vllm|localai|llama/i },
  { key: 'other',    label: '其他',     match: /.*/ },
];
function providerKind(id) {
  return (PROVIDER_KIND.find(k => k.match.test(id)) || PROVIDER_KIND[PROVIDER_KIND.length - 1]).label;
}

/* ============ 逻辑流客户端（/api/remote.mux）============
   实时通道是一个 WebSocket 上复用多条**逻辑流**：
     WS  /api/remote.mux
     浏览器 → 宿主： {type:'open', streamId, endpoint, payload:{args:{…}}}
                    {type:'cancel', streamId}
     宿主 → 浏览器： {type:'item', streamId, value}
                    {type:'end'|'error', streamId, …}
   控制台要开三条：
     · session/control  —— 宿主级：作业 / 消息队列 / 投影增量（含一次 baseline）
     · session/follow   —— 当前会话：开屏快照（历史）+ 之后的事件与逐字增量
     · $events          —— 转发事件：审批与提问（waterfall），要经 /api/$events/result 应答
   `Mux.snapshot()` 是"开一条流、只取开屏快照、立刻取消"的用法，
   用来替代已经消失的 `session.history` / `workspace.list`。 */
const Mux = {
  ws: null,
  open_() { return this.ws && this.ws.readyState === 1; },
  streams: new Map(),        // streamId → { endpoint, onItem, onEnd, onError, grab, timer }
  pending: [],               // 还没连上时先排队
  seq: 1,
  clientId: null,
  retry: null,

  url() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return proto + '//' + location.host + '/api/remote.mux';
  },
  connect() {
    if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) return;
    try {
      const ws = new WebSocket(this.url());
      this.ws = ws;
      ws.onopen = () => {
        State.wsOk = true; Stream.badge(true);
        const queued = this.pending.splice(0);
        for (const send of queued) send();
        Stream.onReady();                       // 打开控制流、转发事件流、当前会话 follow
      };
      ws.onmessage = (ev) => {
        let j; try { j = JSON.parse(ev.data); } catch { return; }
        const s = this.streams.get(j.streamId);
        if (!s) return;
        if (j.type === 'item') { if (s.grab) s.grab(j.value); if (s.onItem) s.onItem(j.value); }
        else if (j.type === 'end') { this.finish(j.streamId, 'end'); }
        else if (j.type === 'error') {
          if (s.grab) s.grab({ __error: j.error });
          if (s.onError) s.onError(j.error);
          this.finish(j.streamId, 'error');
        }
      };
      ws.onclose = () => {
        State.wsOk = false; Stream.badge(false);
        for (const id of [...this.streams.keys()]) this.finish(id, 'close');
        clearTimeout(this.retry);
        this.retry = setTimeout(() => this.connect(), 3000);
      };
      ws.onerror = () => { State.wsOk = false; Stream.badge(false); };
    } catch (e) { console.warn('实时流连接失败', e); }
  },
  /** 重连：丢掉旧 socket，重新开流（切换会话后调用） */
  reset() {
    try { if (this.ws) { this.ws.onclose = null; this.ws.close(); } } catch {}
    this.ws = null; State.wsOk = false; this.streams.clear(); this.pending = [];
    setTimeout(() => this.connect(), 100);
  },
  finish(streamId, why) {
    const s = this.streams.get(streamId);
    if (!s) return;
    this.streams.delete(streamId);
    clearTimeout(s.timer);
    if (s.onEnd) s.onEnd(why);
  },
  /** 打开一条逻辑流，返回 streamId */
  open(endpoint, payload, handlers = {}) {
    const streamId = 's' + (this.seq++);
    this.streams.set(streamId, { endpoint, ...handlers });
    const msg = JSON.stringify({ type: 'open', streamId, endpoint, payload });
    if (this.open_()) this.ws.send(msg);
    else { this.pending.push(() => this.open_() && this.ws.send(JSON.stringify({ type: 'open', streamId, endpoint, payload }))); this.connect(); }
    return streamId;
  },
  cancel(streamId) {
    if (this.open_() && this.streams.has(streamId)) this.ws.send(JSON.stringify({ type: 'cancel', streamId }));
    this.finish(streamId, 'cancelled');
  },

  /**
   * 取一次"开屏快照"：开流 → 等第一条能识别的帧 → 立刻取消。
   * @param target {kind:'session'|'subagent',…} 走 session/follow；字符串视为端点名（如 '/workspace'）
   */
  snapshot(target, timeoutMs = 12000) {
    return new Promise((resolve, reject) => {
      let done = false;
      const settle = (fn, v) => { if (!done) { done = true; clearTimeout(t); this.cancel(id); fn(v); } };
      let id = null;
      const onItem = (value) => {
        if (!value || typeof value !== 'object') return;
        if (value.__error) return settle(reject, new Error((value.__error.code || '') + ' ' + (value.__error.message || '流打开失败')));
        if (value.type === 'error') return settle(reject, new Error((value.error?.code || '') + ' ' + (value.error?.message || '流错误')));
        if (value.type === 'snapshot') return settle(resolve, value);            // session/follow
        if (value.type === 'baseline') return settle(resolve, value.value);      // workspace/follow 等
      };
      const t = setTimeout(() => settle(reject, new Error('等待 ' + (typeof target === 'string' ? target : 'session/follow') + ' 快照超时')), timeoutMs);
      if (typeof target === 'string') {
        id = this.open(target, { args: {} }, { onItem });
      } else {
        id = this.open('session/follow', { args: { request: { address: target, maxMessages: 200, assistantStream: true } } }, { onItem });
      }
    });
  },
};

/* ============ 事件流：把逻辑流翻译成控制台内部状态 ============
   · session/control → 作业 / 队列 / 投影（宿主级，含所有会话）
   · session/follow  → 当前会话的历史快照、事件、逐字增量
   · $events         → 审批 / 提问（waterfall，需应答）+ 会话列表变更（emit）
   事件类型（user/message、assistant/message、tool/call、tool/result…）在三条流上同名同形，
   所以 Stream.onEvent 里的分发逻辑对所有来源都适用。 */
const Stream = {
  followId: null,
  controlId: null,
  eventsId: null,
  snapshots: {},          // sessionId → follow 开屏快照（供 API.history 复用）

  connect() { Mux.connect(); },
  /** socket 就绪后开三条流（每次重连都会重新开） */
  onReady() {
    Stream.controlId = Mux.open('session/control', { args: {} }, { onItem: Stream.onControl });
    Stream.eventsId = Mux.open('$events', { args: {} }, { onItem: Stream.onForwarded });
    Stream.openFollow();
  },
  openFollow() {
    if (Stream.followId) { Mux.cancel(Stream.followId); Stream.followId = null; }
    if (!State.sessionId) return;
    Stream.followId = Mux.open('session/follow', {
      args: { request: { address: { kind: 'session', sessionId: State.sessionId }, maxMessages: 200, assistantStream: true } },
    }, { onItem: Stream.onFollow });
  },
  /** 切换会话：只重开 follow（控制流与转发事件流是宿主级的，不用动） */
  reconnect() {
    if (!Mux.open_()) { Mux.reset(); return; }
    Stream.openFollow();
  },
  badge(ok) {
    const el = document.getElementById('wsbadge'); if (!el) return;
    el.className = 'tag ' + (ok ? 'ok' : 'err');
    el.textContent = ok ? '实时流已连接' : '实时流断开';
  },
  /** 事件驱动的局部重绘。投影帧来得非常密（每步好几条），所以做 120ms 合并。 */
  repaint() {
    if (Stream._rpTimer) return;
    Stream._rpTimer = setTimeout(() => { Stream._rpTimer = null; Stream.repaintNow(); }, 120);
  },
  repaintNow() {
    const p = currentPath();
    const badge = document.getElementById('rtbadge');
    // 「n 个活动」按**全部会话**的运行中作业算（session/control 是宿主级的，这个数更真实）
    const n = jobsOfAllSessions().filter(j => j.status === 'running').length + (State.approvals || []).length + (State.questions || []).length;
    if (badge) {
      badge.style.display = n ? '' : 'none';
      badge.textContent = n ? '● ' + n + ' 个活动' : '';
    }
    if (p === '/chat-agent') {
      renderChatAside();
      const cp = document.getElementById('chatplan'); if (cp) cp.textContent = planBadgeText();
    }
    if (p === '/jobs' || p === '/home' || p === '/goal') render({ refreshed: true });
  },

  /* ---------- session/control：作业 / 队列 / 投影 ---------- */
  mergeProjection(sessionId, key, value) {
    const tgt = (State.sessions || []).find(x => x.sessionId === sessionId);
    if (!tgt) return;
    tgt.projections = tgt.projections || { values: {} };
    tgt.projections.values = { ...(tgt.projections.values || {}), [key]: value };
  },
  onControl(v) {
    if (!v || typeof v !== 'object') return;
    if (v.type === 'baseline') {
      const b = v.value || {};
      for (const [sid, proj] of Object.entries(b.projections || {})) {
        const tgt = (State.sessions || []).find(x => x.sessionId === sid);
        if (tgt) tgt.projections = proj;
        if (sid === State.sessionId && proj?.values?.todos !== undefined) State.todos = proj.values.todos;
      }
      // session/control 是宿主级的：baseline 里的 jobs/queues 按 sessionId 分组、含**所有会话**。
      // 除了当前会话那份，还留一份全量，供作业页的「全部会话」视图用（不用再发请求）。
      if (b.jobs) {
        State.jobsBySession = { ...b.jobs };
        State.jobs = State.sessionId ? (b.jobs[State.sessionId] || []) : [];
        State.jobsReady = true;
      }
      if (b.queues) {
        State.queuesBySession = { ...b.queues };
        State.queue = State.sessionId ? (b.queues[State.sessionId] || []) : [];
      }
      Stream.repaint();
      return;
    }
    if (v.type === 'projection') {
      Stream.mergeProjection(v.sessionId, v.key, v.value);
      if (v.sessionId === State.sessionId && v.key === 'todos') State.todos = v.value;
      Stream.repaint();
      return;
    }
    if (v.type === 'jobs') {
      State.jobsBySession = { ...State.jobsBySession, [v.sessionId]: v.jobs || [] };
      if (v.sessionId === State.sessionId) { State.jobs = v.jobs || []; State.jobsReady = true; Stream.repaint(); }
      return;
    }
    if (v.type === 'queue') {
      State.queuesBySession = { ...State.queuesBySession, [v.sessionId]: v.items || [] };
      if (v.sessionId === State.sessionId) { State.queue = v.items || []; Stream.repaint(); }
    }
  },

  /* ---------- session/follow：历史快照 + 事件 + 逐字增量 ---------- */
  onFollow(v) {
    if (!v || typeof v !== 'object') return;
    if (v.type === 'snapshot') {
      Stream.snapshots[State.sessionId] = v;
      API._hist = { sessionId: State.sessionId, at: Date.now(), value: {
        events: (v.records || []).map(r => ({ event: r.event })), hasMore: v.hasMore, projections: v.projections, header: v.header } };
      // 投影并进会话对象；todos 也来自它
      for (const [key, value] of Object.entries(v.projections?.values || {})) Stream.mergeProjection(State.sessionId, key, value);
      if (v.projections?.values?.todos !== undefined) State.todos = v.projections.values.todos;
      if (v.header?.agentPreset) {
        const tgt = (State.sessions || []).find(x => x.sessionId === State.sessionId);
        if (tgt) tgt.agentPreset = v.header.agentPreset;
      }
      Stream.repaint();
      return;
    }
    if (v.type === 'event') { Stream.onEvent(State.sessionId, v.event); return; }
    if (v.type === 'assistant-stream') { Stream.onAssistantFrame(v.frame); return; }
  },
  /** 逐字增量。帧形状是 {type:'chunk', attemptId, revision, index, time, chunk}
   *  —— **没有 turn/step**，所以用 attemptId 当分桶键（一次尝试一个气泡）。
   *  chunk 的形态沿用 LLM 词汇：text-delta / block-start / tool-call-delta … */
  onAssistantFrame(f) {
    if (!f) return;
    if (f.type === 'chunk') {
      const c = f.chunk || {};
      const turn = f.turn ?? f.attemptId ?? 'live';
      const step = f.step ?? '';
      if (c.type === 'text-delta') Chat.appendDelta(turn, step, c.index ?? f.index, c.text);
      else if (c.type === 'reasoning-delta') Chat.appendThink(turn, step, c.index ?? f.index, c.text);
      else if (c.type === 'block-start' && (c.blockType === 'tool-call' || c.blockType === 'tool_use')) Chat.toolHint('调用工具…');
      return;
    }
    if (f.type === 'end') Chat.status(null);
  },

  /* ---------- $events：转发事件（审批 / 提问 / 会话列表变更） ---------- */
  onForwarded(v) {
    if (!v || typeof v !== 'object') return;
    if (v.type === 'ready') { Mux.clientId = v.clientId; return; }
    if (v.type === 'cancel') {
      State.approvals = (State.approvals || []).filter(a => a.eventId !== v.eventId);
      State.questions = (State.questions || []).filter(q => q.eventId !== v.eventId);
      Stream.repaint();
      return;
    }
    if (v.type === 'emit') {
      const a = v.args || [];
      // 目标的进程内激活态变了（armed/disarmed）——刷新目标页
      if (v.event === 'goal/activation-changed') { refreshGoal().then(() => Stream.repaint()); return; }
      switch (v.event) {
        case 'api-session/added': {
          const s = a[0];
          if (s && s.sessionId && !(State.sessions || []).some(x => x.sessionId === s.sessionId)) State.sessions = [s, ...(State.sessions || [])];
          Stream.repaint(); break;
        }
        case 'api-session/removed':
          State.sessions = (State.sessions || []).filter(x => x.sessionId !== a[0]);
          ensureCurrentSession();  // 移除的是当前会话 → 兜底回主会话；否则不动
          Stream.repaint(); break;
        case 'api-session/status': {
          const t = (State.sessions || []).find(x => x.sessionId === a[0]);
          if (t) t.running = !!a[1];
          Stream.repaint(); break;
        }
        case 'api-session/activity': {
          const t = (State.sessions || []).find(x => x.sessionId === a[0]);
          if (t) t.updatedAt = a[1];
          break;
        }
        case 'api-session/error':
          UI.err('会话出错：' + String(a[1] || '').slice(0, 120)); break;
        case 'settings/document-updated':
          // 配置文件被改了（外部编辑器 / 我们自己写）：必须**绕过 loader TTL** 真取一次，
          // 裸 loadSettings() 在 8s 内会回读旧值 —— 表现就是"改了配置但界面没反应"。
          // 外观偏好也在 settings 里（ui-theme），所以取回后顺手重上一次色。
          loadSettings(true).then(applyTheme).catch(() => {}); break;
        case 'agent-preset/selected':
          refreshSessionsLite().then(() => render()); break;
      }
      return;
    }
    if (v.type === 'waterfall') {
      if (v.event === 'approval/request') {
        const item = { ...v.request, approvalId: v.eventId, eventId: v.eventId, sessionId: v.agentId };
        State.approvals = [...(State.approvals || []).filter(x => x.eventId !== v.eventId), item];
        Chat.approvalCard(item);   // 对齐原生：审批卡内嵌对话流（不在对话页时 el 不存在，自然跳过）
        Stream.repaint();
        return;
      }
      if (v.event === 'user-questions/request') {
        const item = { rpcId: v.eventId, eventId: v.eventId, sessionId: v.agentId, questions: v.request?.questions || [], answered: false };
        State.questions = [...(State.questions || []).filter(x => x.eventId !== v.eventId), item];
        Stream.repaint();
        return;
      }
    }
  },
  /** 应答一个 waterfall 事件（审批 / 提问）：POST /api/$events/result */
  async answerEvent(ev, outcome) {
    if (!Mux.clientId) throw new Error('实时流尚未就绪，稍后重试');
    const v = await API.post('$events/result', { clientId: Mux.clientId, eventId: ev.eventId, outcome });
    State.approvals = (State.approvals || []).filter(a => a.eventId !== ev.eventId);
    State.questions = (State.questions || []).filter(q => q.eventId !== ev.eventId);
    return v;
  },

  /* ---------- 单个会话事件（三条流同名同形） ---------- */
  onEvent(sessionId, event) {
    if (!event) return;
    if (sessionId !== State.sessionId) return;
    const d = event.data || {};
    const cur = () => (State.curTurn != null ? State.curTurn : null);   // 无轮号事件（工作流/目标/子代理）归到当前轮
    switch (event.type) {
      case 'assistant/chunk': {
        const c = d.chunk || {};
        if (c.type === 'text-delta') Chat.appendDelta(d.turn, d.step, c.index, c.text);
        // 思考增量：原生边想边显示，此前这里整个丢掉（只认 text-delta）
        else if (c.type === 'reasoning-delta') Chat.appendThink(d.turn, d.step, c.index, c.text);
        else if (c.type === 'block-start' && c.blockType === 'tool_use') Chat.toolHint('调用工具…');
        else if (c.type === 'block-start' && c.blockType === 'reasoning') Chat.toolHint('思考中…');
        break;
      }
      case 'assistant/message': {
        const msg = d.message || {};
        const content = msg.content || [];
        const text = content.filter(b => b.type === 'text').map(b => b.text).join('');
        const think = reasoningOf(content);
        const extra = extraBlocksHtml(content);   // 认不出的块不再静默丢弃
        // 本条消息的计时要先算（TTFT 依赖同一步的 step/start 时间，而它已经到过）
        const tm = msgTiming(event);
        // 先记本轮的用量/模型/**最终正文**，轮末页脚随后就用这份数据（顺序不能反）
        Turns.message(d.turn, d.usage, msg.source, event.seq, tm, text, msg.id, event.time, d.step);
        Chat.finishMessage(text, msg.id, { turn: d.turn, step: d.step, usage: d.usage, time: event.time, seq: event.seq, think, extra });
        Chat.placeTurnFoot(d.turn);      // 页脚永远贴在本轮最后一条消息下（对齐原生"页脚在正文下方"）
        break;
      }
      case 'user/message': {
        const src = d.source || {};
        const text = (d.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
        const turn = cur();
        if (src.kind === 'user' && !/^Current runtime context|^<system-reminder>/.test(text)) {
          // 附件（图片）由宿主提升成引用后再回显：这里直接画缩略图，不用等下一次整页重绘
          Chat.remoteUser(text, mediaHtml(State.sessionId, d.content), { time: event.time, turn, seq: event.seq });
        } else if (text) {
          // 运行时上下文注入 / 跨会话召回 / 会话中继 / 子代理结算：原生各自单列一行，
          // 标题按 source 分型（message.contextInjection / contextRecall / context.relay.from）
          pushChatRow(ChatRow.source(d, d.content), 'crow-src-slot', turn, event.seq);
        }
        break;
      }
      case 'tool/call': {
        // 工具调用开始：插一行（结果到了再补）
        Chat.toolCall(d.callId, d.name, d.arguments, d.turn, d.step, event.seq);
        Chat.status('调用 ' + d.name + '…');
        break;
      }
      case 'tool/result': {
        const msg = d.message || {};
        const block = (msg.content || []).find(c => c.type === 'tool-result');
        const text = block ? ToolCard.textOf(block.content) : '';
        const callId = block?.toolCallId || msg.source?.callId;
        Chat.toolResult(callId, text, block?.isError, mediaHtml(State.sessionId, block?.content), d.meta, event.seq);
        Chat.status(null);
        break;
      }
      case 'tool/code-dispatch': {
        // Code Mode 里 run_code 内部调用的工具（子调用）
        Chat.toolDispatch(d.subCallId || d.rootCallId, d.name, d.arguments);
        break;
      }
      case 'turn/start':
        State.curTurn = d.turn;
        Turns.start(d.turn, event.time, event.seq);
        // 用户消息不带 turn（宿主只在 turn/start 上给轮号），所以发消息时先存着，轮一开始就认领
        if (State.pendingUserText != null) {
          Turns.user(d.turn, State.pendingUserText, State.pendingUserTime || event.time);
          const b = Chat.lastBubble;
          const row = b && b.closest ? b.closest('.msg') : null;
          if (row) { row.dataset.turn = String(Number(d.turn)); row.dataset.seq = String(Number(event.seq)); }
          State.pendingUserText = null; State.pendingUserTime = null;
        }
        Chat.status('思考中…');
        break;
      case 'step/start':
        // 每一步的开始时刻 —— TTFT（首 token 用时）拿它当起点，缺了就只能不显示
        Turns.step(d.turn, d.step, event.time);
        break;
      case 'turn/end': {
        Turns.end(d.turn, d.reason, event.time);
        Chat.status(null);
        Chat.repaintTurnActions(d.turn);   // 用时此刻才有值、分支按钮此刻才该解禁
        // 非正常结束给一行告示（原生 message.stopped / maxTokens / turnError / failure.auth）
        const rk = (d.reason && d.reason.kind) || '';
        if (rk && rk !== 'completed') {
          const txt = rk === 'max-tokens' ? '已达到输出 token 上限（发送「继续」可让模型接着输出）'
            : rk === 'interrupted' ? '已停止' : rk === 'turn-error' ? '本轮运行失败' : reasonText(rk);
          const kind = rk === 'max-tokens' ? 'max' : rk === 'interrupted' ? 'stopped' : 'error';
          pushChatRow(ChatRow.notice(kind, txt), 'crow-note-slot', d.turn, event.seq);
        }
        break;
      }
      /* —— 以下为原先被整段丢掉的事件类型（对齐原版各类 surface 行） —— */
      case 'system/message': {
        const t = (d.message?.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
        if (t) pushChatRow(ChatRow.system(t), 'crow-sys-slot', d.turn != null ? d.turn : cur(), event.seq);
        break;
      }
      case 'request/context':
        pushChatRow(ChatRow.context(d), 'crow-ctx-slot', cur(), event.seq);
        break;
      case 'request/header':
        pushChatRow(ChatRow.header(d), 'crow-head-slot', cur(), event.seq);
        break;
      case 'deliverables/presented':
        pushChatRow(ChatRow.deliverables(d.files, d.turn), 'crow-deliver-slot', d.turn, event.seq);
        break;
      case 'compaction/start':
        State.compacting = true;
        Chat.status('正在压缩上下文…');
        break;
      case 'compaction/summary':
        pushChatRow(ChatRow.compaction('summary', d), 'crow-compact-slot', cur(), event.seq);
        break;
      case 'compaction/end':
        State.compacting = false;
        Chat.status(null);
        break;
      case 'goal/change':
        pushChatRow(ChatRow.goal(d), 'crow-goal-slot', cur(), event.seq);
        /* 实时把目标状态刷进 State.goal（d 的形状恰与 State.goal 兼容：{goal,roundsStarted,createdAt,updatedAt}）。
         * 以前写的是 `State.goal = State.goal || d.goal` —— 只在"原本没有"时才赋值，
         * 目标在页面开着的时候被宿主推进/暂停/完成时面板永远是旧相位，点旧按钮自然报错。
         * activation 仍是进程本地状态，事件里没有，保留已知值即可。 */
        if (d && d.goal) {
          State.goal = { goal: { ...d.goal, activation: State.goal?.goal?.id === d.goal.id ? State.goal.goal.activation : undefined },
            roundsStarted: d.roundsStarted ?? 0, createdAt: d.createdAt, updatedAt: d.updatedAt };
        } else if (d.operation === 'clear') {
          State.goal = null;
        }
        break;
      case 'subagent/catalog':
        pushChatRow(ChatRow.subagent(d), 'crow-sub-slot', cur(), event.seq);
        break;
      case 'tool-workflow/run-start':
        State.wfRun = { runId: d.runId, name: d.name };
        pushChatRow(ChatRow.workflow('run-start', d), 'crow-wf-slot', cur(), event.seq);
        break;
      case 'tool-workflow/agent-start':
        pushChatRow(ChatRow.workflow('agent-start', d), 'crow-wf-slot', cur(), event.seq);
        break;
      case 'tool-workflow/agent-end':
        pushChatRow(ChatRow.workflow('agent-end', d), 'crow-wf-slot', cur(), event.seq);
        break;
      case 'tool-workflow/run-end':
        State.wfRun = null;
        pushChatRow(ChatRow.workflow('run-end', d), 'crow-wf-slot', cur(), event.seq);
        break;
      case 'feedback/message-put': {
        const it = d.item || {};
        if (it.messageId) { State.feedback = State.feedback || {}; State.feedback[it.messageId] = it; }
        const r = (State.lastRating || 0) + 1; State.lastRating = r;   // 页脚按钮的选中态靠它刷新
        Chat.refreshFootFeedback();
        break;
      }
      case 'feedback/message-delete': {
        if (d.messageId && State.feedback) delete State.feedback[d.messageId];
        Chat.refreshFootFeedback();
        break;
      }
      case 'agent/inbox/spliced':
        // 用户消息本身由 user/message 渲染；这里只在"从队列里移除"时留一行痕迹
        if (d.removedCount) pushChatRow(ChatRow.inbox(d), 'crow-inbox-slot', cur(), event.seq);
        break;
      case 'permission/preset': State.permPreset = d.preset || State.permPreset; pushChatRow(ChatRow.settings(['权限预设 ' + (d.preset || '')]), 'crow-set-slot', cur(), event.seq); break;
      case 'sandbox/mode': State.sandboxMode = d.mode || State.sandboxMode; pushChatRow(ChatRow.settings(['沙箱模式 ' + (d.mode || '')]), 'crow-set-slot', cur(), event.seq); break;
      case 'approval/policy': State.approvalPolicy = d.policy || State.approvalPolicy; pushChatRow(ChatRow.settings(['审批策略 ' + (d.policy || '')]), 'crow-set-slot', cur(), event.seq); break;
      case 'todo/write': {
        State.todos = d.todos || null;
        const items = d.todos || [];
        if (items.length) {
          const done = items.filter(t => t.status === 'completed').length;
          const html = '<div class="crow crow-todo"><div class="crow-h">✅ 更新任务清单'
            + '<span class="crow-meta">' + done + '/' + items.length + ' 已完成</span></div>'
            + items.map(t => '<div class="td-item">' + (t.status === 'completed' ? '✅' : t.status === 'in_progress' ? '🔄' : '⬜')
              + ' ' + fmt.esc(t.content) + '</div>').join('') + '</div>';
          pushChatRow(html, 'crow-todo-slot', cur(), event.seq);
        }
        break;
      }
      case 'session/title':
        State.sessionTitle = d.title || State.sessionTitle;
        break;
    }
  },
};

/** 稳定 JSON 比较：递归排序对象键，避免键序不同导致的误判 */
function stableJson(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableJson).join(',') + ']';
  return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stableJson(v[k])).join(',') + '}';
}
function sameJson(a, b) {
  if (a === undefined || b === undefined) return false;
  return stableJson(a) === stableJson(b);
}

const fmt = {
  bytes(n){ if(n==null) return '-'; const u=['B','KB','MB','GB']; let i=0; while(n>=1024&&i<u.length-1){n/=1024;i++} return n.toFixed(i?1:0)+u[i]; },
  num(n){ return (n??0).toLocaleString('en-US'); },
  time(ts){ if(!ts) return '-'; const d=new Date(ts); return d.toLocaleString('zh-CN',{hour12:false}); },
  ago(ts){ if(!ts) return '-'; const s=(Date.now()-ts)/1000;
    if(s<60) return Math.floor(s)+' 秒前'; if(s<3600) return Math.floor(s/60)+' 分钟前';
    if(s<86400) return Math.floor(s/3600)+' 小时前'; return Math.floor(s/86400)+' 天前'; },
  esc(s){ return String(s??'').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); },
  /** ⚠️ 只给**内联事件处理器里的字符串参数**用：先 JSON 化再 HTML 转义。
   *  例：onclick="fbAsk(' + fmt.attr(id) + ')" → onclick="fbAsk(&quot;abc&quot;)"。
   *  **绝不能**拿去填 value= / title= / data-* 这类 HTML 属性 —— 那会写出
   *  `value="&quot;abc&quot;"`，属性值当场多一对引号：
   *   · `data-v` 变成 `"path"`（带引号）→ 与真实 path 比较永不相等 → **选不中**；
   *   · `<option value="&quot;code&quot;">` → 提交上来的值是 `"code"` → 预设 id 对不上；
   *   · 输入框 value/placeholder 会连引号一起显示出来。
   *  这类场景一律用 fmt.h()（下面的注释再写一遍，防止又被写回去）。 */
  attr(v){ return fmt.esc(JSON.stringify(String(v))); },
  /** HTML 属性值专用转义：转义但不加引号（与 esc 同实现，名字表意）。
   *  value= / title= / placeholder= / data-* 一律走这个。 */
  h(v){ return fmt.esc(String(v ?? '')); },
  /** 中间省略：路径最有用的是盘符/根与末级目录，砍中间比砍尾巴信息量大 */
  mid(s, n){ const t = String(s ?? ''); if (t.length <= n) return t;
    const head = Math.ceil((n - 1) / 2), tail = Math.floor((n - 1) / 2);
    return t.slice(0, head) + '…' + t.slice(t.length - tail); },
};

/* ---------- 路由 ---------- */
const ROUTES = [
  // ── 工作台：每天第一眼（本组同时常驻顶栏，见 NAV_GROUP）────────
  { id:'home',     path:'/home',            ico:'🏠', label:'首页',           group:'工作台' },
  { id:'chat',     path:'/chat-agent',      ico:'💬', label:'时空智能体',     group:'工作台' },
  // ── 对话与会话：前两项=会话实体与容器的管理页（🌐 全局）；
  //    后五项=当前会话的下钻视图（🔗 跟随会话），排序刻意"管理在前、视图在后" ──
  { id:'sessions', path:'/session/list',    ico:'📋', label:'会话',           group:'对话与会话' },
  { id:'workspace',path:'/workspace',       ico:'🗂️', label:'工作空间',       group:'对话与会话' },
  { id:'subagents',path:'/subagent/list',   ico:'👥', label:'子代理',         group:'对话与会话' },
  { id:'trajectory',  path:'/session/trajectory', ico:'🧭', label:'轨迹',      group:'对话与会话' },
  { id:'workflow',    path:'/workflow/runs',       ico:'🕸️', label:'工作流',    group:'对话与会话' },
  { id:'deliverables',path:'/deliverables',        ico:'📦', label:'交付物',    group:'对话与会话' },
  // 目标是会话数据视图（跨轮次推进、随当前会话）——与轨迹/交付物同类，不放「配置」类组
  { id:'goal',        path:'/goal',                ico:'🎯', label:'目标',      group:'对话与会话' },
  // ── 能力与资产：给智能体扩展能力的全局资产清单。
  //    大模型/智能体预设/MCP/插件是全局资产；Skills 按 cwd 分层加载（作用域标签页内已写明）──
  { id:'models',   path:'/model',           ico:'🧠', label:'大模型',         group:'能力与资产' },
  // 智能体预设是全局资产（列表/复制/删除都是全局的），只有"选择"作用到会话
  { id:'agentMgr', path:'/agent/manage',    ico:'🎛️', label:'智能体预设',     group:'能力与资产' },
  { id:'skillMgr', path:'/skills/manager',  ico:'🧩', label:'Skills 管理',    group:'能力与资产' },
  // MCP 服务是全局生效的连接（不跟随会话），和插件同组 —— 对齐原生 cordis 的作用域心智
  { id:'mcp',      path:'/mcp/manager',     ico:'🔌', label:'MCP 服务',       group:'能力与资产' },
  { id:'plugins',  path:'/plugin/manager',  ico:'🧱', label:'插件',           group:'能力与资产' },
  // ── 平台设置：本机/账号级配置 ─────────────────
  { id:'credentials',path:'/credentials',   ico:'🔑', label:'凭据',           group:'平台设置' },
  // 设置页是全局配置文件（~/.dsh/settings.yaml）：实测 settings/describe 传 sessionId
  // 会被 typert 拒绝（unexpected sessionId），14 个命名空间全部全局生效
  { id:'settings', path:'/settings',        ico:'⚙️', label:'设置',           group:'平台设置' },
  // ── 系统运行：后台任务处理 + 只读运行时监控 ──────────
  { id:'jobs',     path:'/jobs',            ico:'📊', label:'后台作业',       group:'系统运行' },
  { id:'host',     path:'/system/host',     ico:'🖥️', label:'系统状态',       group:'系统运行' },
];

/** 顶部常驻菜单栏取哪个分组（其余页面只在左侧栏出现）。
 *  固定按分组名取，不再用 ROUTES.slice(0,4) —— 那样顶栏内容会随数组书写顺序静默变化。 */
const NAV_GROUP = '工作台';

/** 侧栏分组的补充说明（鼠标悬停显示）。
 *  ⚠️ 分组名在 3 处被按字面引用：NAV_GROUP、GROUP_HINT、renderScopeBar，
 *     改名必须同步这 3 处，否则会静默失效（顶栏空掉 / 说明丢失 / 作用域条不显示）。 */
const GROUP_HINT = {
  '工作台': '每天第一眼',
  '对话与会话': '会话/工作空间=管理页（全局）；子代理/轨迹/工作流/交付物/目标=当前会话视图',
  '能力与资产': '给智能体扩能力的全局资产：模型目录 / 智能体预设 / Skills（随工作目录加载）/ MCP / 插件',
  '平台设置': '本机配置：凭据与全局配置文件（~/.dsh/settings.yaml）',
  '系统运行': '后台任务处理与只读运行时监控',
};
/* 各页作用域已由页内 scopeTag 标签逐页标注（🔗/🌐/⇄），组级徽标已废弃删除 */

function currentPath(){ const h = location.hash.replace(/^#/, ''); return h || '/home'; }
function routeOf(path){ return ROUTES.find(r => path === r.path) || ROUTES[0]; }

/** 面包屑：分组名与页面名直接取自 ROUTES。
 *  每页手写一份会漂移（分组名与侧栏对不上），统一推导保证一致。 */
function crumbOf(id) {
  const r = ROUTES.find(x => x.id === id) || {};
  // 首页的页标题已经写着「首页」，面包屑再写一遍是重复 —— 这里只留所属分组（工作台）。
  if (r.id === 'home') return '<div class="crumb">' + fmt.esc(r.group || '') + '</div>';
  return '<div class="crumb">首页 / ' + fmt.esc(r.group || '') + ' / ' + fmt.esc(r.label || '') + '</div>';
}

/* ---------- 作用域标签：写清本页内容跟着什么走 ----------
   模块间的内容依赖：
   · 🔗 跟随当前会话 —— 数据来自 State.sessionId；会话列表「设为当前」或作用域条切换后，
     本页内容由 setCurrentSession 统一重置（子代理/作业/队列/目标/流）并在重绘时按新会话重载。
   · 🔗 跟随工作目录 —— 数据来自当前会话的 cwd；换会话或会话换目录后随之更换。
   · 🌐 全局 —— 与具体会话无关，所有会话共享，切换会话不影响本页。
   · ⇄ 跨会话 —— 聚合所有会话的视图（当前会话数据为主，可切全部）。 */
const SCOPE_TAG = {
  session: { text: '🔗 跟随当前会话', tip: '本页数据来自当前选中的会话。切换会话（会话列表「设为当前」或顶部作用域条）后，本页内容随之更换' },
  cwd:     { text: '🔗 跟随工作目录', tip: '本页数据来自当前会话的工作目录（cwd）。换会话或换目录后随之更换' },
  global:  { text: '🌐 全局', tip: '本页清单/数据与具体会话无关，所有会话共享；切换会话不影响本页内容。注意：页内若有「设为当前会话 / 切模型」类操作，改变的是该会话自己的绑定属性，清单本身仍是全局' },
  cross:   { text: '⇄ 跨会话', tip: '默认显示当前会话的数据，可切换为聚合所有会话' },
};
function scopeTag(kind) {
  const s = SCOPE_TAG[kind];
  return s ? '<span class="tag gray" style="font-size:10.5px;margin-left:6px" title="' + fmt.esc(s.tip) + '">' + s.text + '</span>' : '';
}

/** 侧栏折叠（窄屏用），状态存 localStorage */
function toggleSide() {
  const el = document.getElementById('side');
  if (!el) return;
  el.classList.toggle('collapsed');
  try { localStorage.setItem('sideCollapsed', el.classList.contains('collapsed') ? '1' : '0'); } catch {}
}
function restoreSide() {
  try {
    if (localStorage.getItem('sideCollapsed') === '1') document.getElementById('side')?.classList.add('collapsed');
  } catch {}
}

let _navCache = { nav: '', side: '' };   // 上次渲染的侧栏 HTML：内容没变就不碰 DOM（双渲染/事件重绘都走这里）
function renderNav(){
  const cur = routeOf(currentPath());
  const nav = ROUTES.filter(r => r.group === NAV_GROUP).map(r =>
    `<a href="#${r.path}" class="${r.id===cur.id?'on':''}">${r.label}</a>`).join('');
  const groups = [...new Set(ROUTES.map(r => r.group))];
  const side = groups.map(g =>
    `<h4 title="${GROUP_HINT[g] || ''}">${g}</h4>` + ROUTES.filter(r => r.group === g).map(r =>
      `<a href="#${r.path}" class="${r.id===cur.id?'on':''}"><span class="ico">${r.ico}</span>${r.label}</a>`).join('')
  ).join('');
  if (nav !== _navCache.nav) { document.getElementById('nav').innerHTML = nav; _navCache.nav = nav; }
  if (side !== _navCache.side) { document.getElementById('side').innerHTML = side; _navCache.side = side; }
}

/* ---------- 数据加载 ---------- */
async function boot(){
  try {
    // 概要由 modelCatalog + 会话列表 + 本机版本拼出来（见 API.host）
    State.host = await API.host();
    const s = await API.call('session.list', {});
    State.sessions = s.items || [];
    // 默认会话：先恢复上次选的；没有记录才取第一个**主会话**（origin!=='subagent'）。
    // 不取"列表第一条"——父 agent 发起子代理后新会话排最前，刷新就会把当前会话悄悄切到子代理。
    State.sessionId = pickDefaultSession(State.sessions);
    if (State.sessionId) { try { localStorage.setItem('dshCurrentSession', State.sessionId); } catch {} }
    // 会话的 agentPreset 在 follow 的 header 里，列表接口不再返回；点开会话时补上。
    // 右上角只承担「连接状态 + 配置入口」：模型在时空智能体侧栏、会话数在会话页/首页都有，
    // 顶栏不再重复 —— 之前"显示模型·会话数但点击却是 DSH 配置"职责是混的。
    document.getElementById('hstatus').innerHTML =
      `<span class="dot"></span> <span class="hs-txt">DSH 已连接 · 点击配置</span>`;
    State.error = null;
    // 外观偏好来自 DSH 的 ui-theme 设置；监听系统深浅色变化（"跟随系统"要真实时跟随）
    watchSystemTheme();
    loadSettings().then(applyTheme);   // 此时 #content 还是空的，只上色不重绘（收尾那次 render 会统一画）
    // 服务端全文检索是否可用：探一次（本部署配置为 never），好让会话页诚实标注
    API.call('session.search', { query: 'probe' })
      .then(() => { State.searchUnavailable = false; })
      .catch(() => { State.searchUnavailable = true; });
  } catch (e) {
    State.error = e.message;
    document.getElementById('hstatus').innerHTML = `<span class="dot bad"></span> <span class="hs-txt">DSH 未就绪 · 点击配置</span>`;
  }
}

/* ---------- 会话附件（session/attachment）----------
   会话日志里只记引用、不记字节：
     { type:'image', attachment:{attachmentId, mediaType, bytes, width, height, name?} }
     { type:'file',  attachment:{attachmentId, name, bytes} }
   图片字节按 attachmentId 走控制台的 /api/local/attachment 取（服务端替浏览器调
   session/attachment，因为 <img> 自己带不上 DSH 的会话 cookie）。
   控制台"自己刚发出去"的图片是内联 base64（PromptContentPart 的 image 形状），两种都要能画。 */
function attachmentUrl(sessionId, attachmentId, download) {
  return '/api/local/attachment?sessionId=' + encodeURIComponent(sessionId || '')
    + '&attachmentId=' + encodeURIComponent(attachmentId || '') + (download ? '&download=1' : '');
}
/** 点开原图：新标签页直接取字节 */
function openAttachment(sessionId, attachmentId) {
  window.open(attachmentUrl(sessionId, attachmentId), '_blank');
}
/** 一个 image/file 内容块 → HTML；其它类型返回 '' */
function mediaBlockHtml(sessionId, b) {
  if (!b || typeof b !== 'object') return '';
  const ref = b.attachment || {};
  if (b.type === 'image') {
    const id = ref.attachmentId;
    const name = ref.name || (id ? String(id).replace(/^sha256:/, '').slice(0, 12) : '图片');
    const src = id ? attachmentUrl(sessionId, id)
      : (b.data ? 'data:' + (b.mediaType || 'image/png') + ';base64,' + b.data : '');
    if (!src) return '';
    const size = ref.bytes ? ' · ' + fmt.bytes(ref.bytes) : '';
    const dim = (ref.width && ref.height) ? ' · ' + ref.width + '×' + ref.height : '';
    const open = id ? ' onclick="openAttachment(' + fmt.attr(sessionId) + ', ' + fmt.attr(id) + ')" title="点击查看原图"' : '';
    return '<figure class="att-img"><img src="' + fmt.esc(src) + '" alt="' + fmt.esc(name) + '" loading="lazy"' + open + '>'
      + '<figcaption>🖼️ ' + fmt.esc(String(name).slice(0, 60)) + size + dim + '</figcaption></figure>';
  }
  if (b.type === 'file') {
    const name = ref.name || '文件';
    const size = ref.bytes ? '<span class="muted"> · ' + fmt.bytes(ref.bytes) + '</span>' : '';
    // session/attachment 只回图片字节：文件块展示元信息，不假装能下载
    return '<div class="att-file" title="' + fmt.esc(ref.attachmentId ? 'attachmentId ' + ref.attachmentId : name) + '">'
      + fileIco(name) + ' ' + fmt.esc(String(name).slice(0, 80)) + size + '</div>';
  }
  return '';
}
/** 一组内容块 → 附件 HTML（没有附件返回 ''，调用方可直接拼接） */
function mediaHtml(sessionId, blocks) {
  if (!Array.isArray(blocks)) return '';
  return blocks.map(b => mediaBlockHtml(sessionId, b)).filter(Boolean).join('');
}

/* 本项目画得出来的内容块。其余类型**不再静默丢弃** —— 原生对认不出的块会给一条
   「附加内容块 / 未知内容块」，此前这里只 filter 出 text/reasoning，别的整类消失：
   这正是"很多东西没有"的一大来源（块在事件里是真实存在的）。 */
const KNOWN_BLOCKS = ['text', 'reasoning', 'tool-call', 'tool-result', 'image', 'file'];
/** 认不出的内容块 → 一条摘要行（原生 message.extraBlock / message.unknownBlock） */
function extraBlocksHtml(blocks) {
  if (!Array.isArray(blocks)) return '';
  const rest = blocks.filter(b => b && typeof b === 'object' && !KNOWN_BLOCKS.includes(b.type));
  if (!rest.length) return '';
  const types = [...new Set(rest.map(b => (b.type ? String(b.type) : '')))];
  const named = types.filter(Boolean);
  const unknown = types.length !== named.length || !named.length;
  // 有类型名 → 「附加内容块 · image、audio」；连类型都没有 → 「未知内容块」
  const head = named.length ? '📎 附加内容块' : '❔ 未知内容块';
  const meta = [rest.length + ' 个', named.length ? named.join('、') : '无可识别类型'].join(' · ');
  return '<div class="crow crow-extra" title="' + fmt.esc(JSON.stringify(rest.map(b => b.type || null))) + '">'
    + fmt.esc(head) + '<span class="crow-meta">' + fmt.esc(meta) + (unknown && named.length ? ' · 含未知类型' : '') + '</span></div>';
}


/* ============ 消息操作条（对齐原生 MessageIconActions + turn tail）============
   原生每条消息底部有一条动作条：时间 · 复制 · 👍好的回答 / 👎有问题的回答 · 在新对话中分支 · 用量/用时。
   数据全部取自真实事件（DSH 0.1.5-rc.2 实测）：
     · messageId ← assistant/message.data.message.id（反馈只能用它；用序号会被宿主判 target-not-found）
     · usage     ← assistant/message.data.usage
                   {inputTokens, outputTokens, totalTokens, cacheReadTokens, reasoningTokens}
     · 消息时间  ← 事件的 time
     · 本轮用时  ← turn/end.time − turn/start.time
     · 分支      ← session/fork{atSeq}，只能从**已完成**轮次分支（宿主的判据同样是"该轮是否已 turn/end"）
   step/end 不带耗时，所以原生那种每轮 TTF/TPS 取不到 —— 宁缺勿假，这里不造。 */

/** 每轮的元数据（历史与实时两条路径共用一份口径） */
const Turns = {
  reset() { State.turns = {}; State.stepStart = {}; },
  of(turn, create) {
    const t = Number(turn);
    if (!Number.isFinite(t)) return null;
    State.turns = State.turns || {};
    let r = State.turns[t];
    if (!r && create) r = State.turns[t] = {
      turn: t, startTime: null, startSeq: null, endTime: null, reason: null,
      usage: null, provider: null, model: null, n: 0,
      // 轮末页脚（对齐原生"已完成轮次的页脚"）要用的三样：
      //   finalText/finalMessageId = 该轮**最终正文**（原生：最后一个含文本、不含工具调用的步骤）
      //   lastTime/lastStep        = 末条消息的时间与步号（页脚的"时间"与"速度"取它）
      finalText: null, finalMessageId: null, userText: null, lastTime: null, lastStep: null,
    };
    return r || null;
  },
  start(turn, time, seq) {
    const r = this.of(turn, true); if (!r) return null;
    if (time != null) r.startTime = time;
    if (seq != null && r.startSeq == null) r.startSeq = seq;
    return r;
  },
  end(turn, reason, time) {
    const r = this.of(turn, true); if (!r) return null;
    if (time != null) r.endTime = time;
    r.reason = (reason && reason.kind) || r.reason;
    return r;
  },
  /** 记一条助手消息：累加本轮用量、记下模型。返回该轮记录（供操作条即时取数）
   *  @param seq 该条消息的事件序号 —— 用来认"这一轮的最后一条消息"（分支与用时只挂在它上面）
   *  @param timing 该条消息的计时（msgTiming() 的产物：TTFT / 解码跨度 / TPS），可选 */
  message(turn, usage, source, seq, timing, text, messageId, time) {
    const r = this.of(turn, true); if (!r) return null;
    r.n++;
    if (seq != null) r.lastSeq = seq;
    // 最终正文：只有带非空文本的助手消息才更新它 —— 空消息/纯工具调用步不该顶掉最终回答
    if (text != null && String(text).trim()) { r.finalText = String(text); r.finalMessageId = messageId || r.finalMessageId; }
    if (time != null) r.lastTime = Number(time);
    if (timing && timing.step != null) r.lastStep = timing.step;
    if (usage && typeof usage === 'object') {
      const u = r.usage = r.usage || { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, lastTotal: 0 };
      ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'].forEach(k => {
        const v = Number(usage[k]); if (Number.isFinite(v)) u[k] += v;
      });
      const tot = Number(usage.totalTokens);
      if (Number.isFinite(tot)) u.lastTotal = Math.max(u.lastTotal || 0, tot);
    }
    if (source) { r.provider = source.provider || r.provider; r.model = source.model || r.model; }
    if (timing) { r.timings = r.timings || {}; r.timings[timing.step != null ? timing.step : 'last'] = timing; }
    return r;
  },
  /** 记某一步的开始时刻（step/start 事件的 time）—— TTFT 拿它当起点，没有它就算不出首 token 用时 */
  step(turn, step, time) {
    if (turn == null || step == null || time == null) return;
    State.stepStart = State.stepStart || {};
    State.stepStart[turn + '/' + step] = Number(time);
  },
  stepStart(turn, step) {
    const v = (State.stepStart || {})[turn + '/' + step];
    return Number.isFinite(v) ? v : null;
  },
  /** 某条消息的计时；没记到返回 null（操作条据此决定显不显示 TTFT/TPS） */
  timingOf(turn, step) {
    const r = this.of(turn, false);
    if (!r || !r.timings) return null;
    return r.timings[step != null ? step : 'last'] || null;
  },
  /** 该轮是否已完成（分支的硬条件） */
  done(turn) { const r = this.of(turn, false); return !!(r && r.endTime != null); },
  /** 本轮用时（ms）；拿不到返回 null */
  runMs(turn) { const r = this.of(turn, false); return (r && r.startTime != null && r.endTime != null) ? (r.endTime - r.startTime) : null; },
  /** 记这一轮的开场用户输入（助手还没回话时，页脚也要有可复制的内容） */
  user(turn, text, time) {
    const r = this.of(turn, true); if (!r) return null;
    if (text != null) r.userText = String(text);
    if (time != null && r.startTime == null) r.startTime = Number(time);
    if (time != null) r.lastTime = Number(time);
    return r;
  },
  /** 轮末页脚的全部入参（实时路径与历史回填共用一份口径） */
  footOf(turn) {
    const r = this.of(turn, false);
    if (!r) return null;
    return {
      foot: true, turn: r.turn,
      messageId: r.finalMessageId || '',
      text: r.finalText != null ? r.finalText : (r.userText || ''),
      hasReply: !!(r.finalMessageId || r.finalText != null),
      time: r.lastTime != null ? r.lastTime : (r.endTime != null ? r.endTime : r.startTime),
      step: r.lastStep,
    };
  },
};

/** 千分位（原生 number.groupSeparator = ","） */
function fmtInt(n) {
  const v = Number(n);
  return Number.isFinite(v) ? v.toLocaleString('en-US') : '—';
}
/** 时间戳 → 人类可读：当天只给 HH:MM，同年给「M月D日 HH:MM」，跨年带年份（对齐原生 formatMessageClock） */
function msgClock(ts) {
  const t = Number(ts);
  if (!Number.isFinite(t) || t <= 0) return '';
  const d = new Date(t), n = new Date();
  const hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  const md = (d.getMonth() + 1) + '月' + d.getDate() + '日';
  if (d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()) return hm;
  if (d.getFullYear() === n.getFullYear()) return md + ' ' + hm;
  return d.getFullYear() + '年' + md + ' ' + hm;
}
/** 时长 → 「1.2秒 / 2分31秒 / 820毫秒」（对齐原生 duration.compact*） */
function fmtDur(ms) {
  const v = Number(ms);
  if (!Number.isFinite(v) || v < 0) return '';
  if (v < 1000) return Math.round(v) + '毫秒';
  const sec = v / 1000;
  if (sec < 60) return (sec < 10 ? sec.toFixed(1) : String(Math.round(sec))) + '秒';
  const m = Math.floor(sec / 60), s = Math.round(sec % 60);
  return m + '分' + String(s).padStart(2, '0') + '秒';
}

/** turn/end 的 reason.kind → 人话（原生 message.stopped / message.maxTokens / message.turnError）。
 *  只翻译"见到过或语义明确"的取值，其余原样透出 —— 编一个假的中文名比显示英文更误导。 */
function reasonText(kind) {
  const m = {
    completed: '正常完成',
    interrupted: '已停止',
    cancelled: '已取消',
    steer: '被新指令接管',
    'max-tokens': '已达输出上限',
    error: '本轮运行失败',
    failed: '本轮运行失败',
    conflict: '与其它请求冲突',
  };
  const k = String(kind == null ? '' : kind);
  return m[k] || k;
}
/** 该 reason 是否需要额外提醒一句（原生把这些做成行内提示，不是只藏在面板里） */
function reasonHint(kind) {
  const k = String(kind == null ? '' : kind);
  if (k === 'max-tokens') return '回答被输出上限截断，已有输出保留在对话中；发送「继续」可让模型接着输出';
  if (k === 'error' || k === 'failed') return '本轮运行失败，可检查右侧栏错误或重发一次';
  if (k === 'interrupted' || k === 'cancelled') return '本轮已被停止，未完成的部分不会继续';
  return '';
}

/** 思考块（对齐原生 message.think：折叠的披露条）。
 *  为什么必须有它：真实数据里 assistant 消息的 content 含 {type:'reasoning'} 块
 *  （本机实测 63/68 条），而控制台此前只取 type==='text' —— 思考过程被整段静默丢掉。
 *  @param open 流式过程中展开（边想边看），完整消息到达后收起（不占版面） */
function reasoningHtml(text, open) {
  const s = String(text == null ? '' : text).trim();
  if (!s) return '';
  return '<details class="think"' + (open ? ' open' : '') + '>'
    + '<summary>💭 思考 <span class="muted">' + fmtInt(s.length) + ' 字</span></summary>'
    + '<div class="think-body">' + fmt.esc(s) + '</div></details>';
}
/** 聚合一条 assistant 消息里的思考块文本（历史渲染与完整消息校正共用） */
function reasoningOf(blocks) {
  return (blocks || []).filter(b => b && (b.type === 'reasoning' || b.type === 'thinking') && b.text)
    .map(b => b.text).join('\n\n');
}

/** 从一条**真实** assistant/message 事件里算该条消息的计时。
 *  字段全部来自 0.1.5-rc.2 实测（68/68 条消息都带 stream）：
 *    · 起点 = 同一 (turn,step) 的 step/start 事件 time
 *    · 首 token 时刻 = 该消息 data.stream[] 里最早/最晚的 chunk.time
 *    · 输出量 = data.usage.outputTokens
 *  任一项取不到就返回 null —— 宁可不显示，也不给一个编出来的速度。 */
function msgTiming(ev) {
  const d = (ev && ev.data) || {};
  const stream = Array.isArray(d.stream) ? d.stream : null;
  if (!stream || !stream.length) return null;
  const ts = stream.map(c => Number(c && c.time)).filter(Number.isFinite);
  if (!ts.length) return null;
  const t0 = Math.min(...ts), t1 = Math.max(...ts);
  const st = Turns.stepStart(d.turn, d.step);
  const out = Number(d.usage && d.usage.outputTokens);
  const spanMs = t1 - t0;
  return {
    step: d.step == null ? null : Number(d.step),
    ttftMs: (st != null && ts[0] >= st) ? ts[0] - st : null,
    // 思考块耗时：stream 里 reasoning 那个 block 的 block-start → block-end（按 index 配对，缺一不算）
    thinkMs: thinkDuration(stream),
    spanMs,
    tps: (spanMs > 0 && Number.isFinite(out)) ? out / (spanMs / 1000) : null,
  };
}
/** 思考块耗时：在 stream 里找 blockType='reasoning' 的 block-start，用同 index 的 block-end 减。
 *  流式聚合帧里 block-end 不带 blockType（实测），所以按 index 配对；配不上就返回 null。 */
function thinkDuration(stream) {
  let startT = null, startIdx = null;
  for (const c of stream) {
    const k = c && c.chunk; if (!k) continue;
    if (k.type === 'block-start' && k.blockType === 'reasoning') { startT = Number(c.time); startIdx = k.index; }
    else if (k.type === 'block-end' && startT != null && (startIdx == null || k.index === startIdx)) {
      const t = Number(c.time);
      if (Number.isFinite(t) && t >= startT) return t - startT;
      return null;
    }
  }
  return null;
}
/** 本轮用量面板：本条用量 + 本条速度 + 本轮小计 + 本轮用时（全部真实字段，缺项不显示）
 *  @param step 本条消息所在的步 —— 用来取"这条"的 TTFT / TPS（同轮每步的数值差别很大） */
function usagePanelHtml(turn, usage, step) {
  const r = Turns.of(turn, false);
  const rows = [];
  const kv = (k, v) => rows.push('<div class="ma-kv"><span>' + k + '</span><b>' + v + '</b></div>');
  const u = usage || {};
  const own = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']
    .some(k => Number.isFinite(Number(u[k])) && Number(u[k]) > 0);
  if (own) {
    rows.push('<div class="ma-sec">这一次调用</div>');
    if (Number.isFinite(Number(u.totalTokens)) && u.totalTokens > 0) kv('上下文规模', fmtInt(u.totalTokens) + ' tok');
    if (Number.isFinite(Number(u.inputTokens))) kv('未缓存输入', fmtInt(u.inputTokens) + ' tok');
    if (Number.isFinite(Number(u.cacheReadTokens))) kv('缓存读取', fmtInt(u.cacheReadTokens) + ' tok');
    if (Number.isFinite(Number(u.cacheWriteTokens)) && Number(u.cacheWriteTokens) > 0) kv('缓存写入', fmtInt(u.cacheWriteTokens) + ' tok');
    if (Number.isFinite(Number(u.outputTokens))) kv('输出', fmtInt(u.outputTokens) + ' tok');
    if (Number.isFinite(Number(u.reasoningTokens)) && u.reasoningTokens > 0) kv('其中推理', fmtInt(u.reasoningTokens) + ' tok');
  }
  // 本条消息的速度（原生 message.turnTime：首 token 用时 / 输出速度）—— 数据来自 step/start 与 stream 的 chunk 时间
  const tm = turn != null ? Turns.timingOf(turn, step) : null;
  if (tm) {
    rows.push('<div class="ma-sec">这一次调用的速度</div>');
    if (Number.isFinite(tm.ttftMs)) kv('首 token 用时（TTFT）', fmtDur(tm.ttftMs));
    if (Number.isFinite(tm.thinkMs)) kv('其中思考', fmtDur(tm.thinkMs));
    if (Number.isFinite(tm.tps)) kv('输出速度（TPS）', tm.tps.toFixed(1) + ' tok/s');
  }
  if (r) {
    const agg = r.usage;
    if (agg && r.n > 1) {
      rows.push('<div class="ma-sec">本轮小计（' + r.n + ' 次调用）</div>');
      kv('未缓存输入', fmtInt(agg.inputTokens) + ' tok');
      kv('缓存读取', fmtInt(agg.cacheReadTokens) + ' tok');
      kv('输出', fmtInt(agg.outputTokens) + ' tok');
      if (agg.reasoningTokens) kv('其中推理', fmtInt(agg.reasoningTokens) + ' tok');
      kv('本轮消耗', fmtInt(agg.inputTokens + agg.outputTokens) + ' tok');
    }
    const ms = Turns.runMs(r.turn);
    if (ms != null) kv('本轮用时', fmtDur(ms));
    if (r.reason) kv('本轮结束', reasonText(r.reason));
    if (r.model) kv('提供方 / 模型', fmt.esc((r.provider ? r.provider + ' / ' : '') + r.model));
  }
  if (!rows.length) rows.push('<div class="muted" style="font-size:11.5px">这条消息没有用量记录（宿主未上报 usage）</div>');
  return '<div class="ma-pop" hidden>' + rows.join('') + '</div>';
}

/** 一轮的**页脚**（对齐原生 dsh-client-ui-chat：操作页脚属于已完成轮次，位于正文下方 20px）。
 *
 *  为什么整轮只渲染一次：原生的 时间 / 复制 / 👍好的回答 / 👎有问题的回答 / 用量 / 用时 / 分支
 *  全都挂在这一个页脚上，**不是每条消息各来一条**。之前控制台按消息渲染，一轮十几步就刷出
 *  十几条重复的操作条 —— 这正是要改掉的东西。
 *  所以：只有轮末（o.foot === true）才产出 HTML；非轮末一律返回空串，由调用方决定挂在哪条消息下。
 *  @param o { foot, messageId, text, time, turn, step, hasReply }
 *           foot 缺省即"不是页脚" → 返回空串（唯一开关，别再逐条渲染） */
function msgActionsHtml(o) {
  if (!o || !o.foot) return '';
  const id = o.messageId || '';
  // 复制用的键：优先持久化 id，其次事件序号；本地刚发的用户消息两者都没有，
  // 用自增序号兜底 —— 否则所有本地消息会共用同一个键，复制到的永远是最后一条。
  const fbKey = id || ('s' + (o.seq != null ? o.seq : (State._mk = (State._mk || 0) + 1)));
  const text = String(o.text == null ? '' : o.text);
  // 复制按钮按 key 取原文。不把全文塞进 data-* 属性（一条消息可达 8KB，160 条就是 1MB+ 的 HTML）；
  // 但也不能无限留档：只保最近 600 条（复制是即时动作，翻回去再点的情况很少）。
  State.msgText = State.msgText || {};
  State._mtOrder = State._mtOrder || [];
  if (!(fbKey in State.msgText)) State._mtOrder.push(fbKey);
  State.msgText[fbKey] = text;
  while (State._mtOrder.length > 600) {
    const k = State._mtOrder.shift();
    if (k !== fbKey) delete State.msgText[k];
  }
  const cur = id ? (State.feedback || {})[id] : null;
  const clock = msgClock(o.time);
  const rec = o.turn != null ? Turns.of(o.turn, false) : null;
  const done = o.turn != null && Turns.done(o.turn);
  const dur = o.turn != null ? Turns.runMs(o.turn) : null;
  const bits = [];
  // 时间取本轮末条消息（或 turn/end）的时刻 —— 页脚是轮次级的，显示某个中间步骤的时间没有意义
  // HTML 属性值一律用 fmt.esc；fmt.attr 是"内联事件里的 JS 字符串参数"专用（会自带引号）
  if (clock) bits.push('<span class="ma-time" title="' + fmt.esc('本轮时间：' + new Date(Number(o.time)).toLocaleString('zh-CN')) + '">' + clock + '</span>');
  bits.push('<button class="ma-btn" onclick="copyMsg(this)" data-key="' + fmt.esc(fbKey) + '" title="复制这一轮的最终回答全文">⧉<span class="ma-t">复制</span></button>');
  // 反馈绑定该轮**最终正文**那条助手消息的 messageId（宿主按 messageId 存反馈，用序号会被判 target-not-found）。
  // 拿不到 id 说明这轮还没有助手回复（用户单独一条），此时不给反馈按钮。
  if (id) {
    const pos = cur && cur.rating === 'positive', neg = cur && cur.rating === 'negative';
    bits.push('<button class="ma-btn' + (pos ? ' on' : '') + '" data-fb="' + fmt.esc(id) + '" data-v="positive"'
      + ' onclick="fbAsk(' + fmt.attr(id) + ',\'positive\')" title="' + fmt.esc(pos ? '取消标记' : '好的回答：存到 DSH 服务端，可带分类与说明') + '">👍<span class="ma-t">好的回答</span></button>');
    bits.push('<button class="ma-btn' + (neg ? ' on' : '') + '" data-fb="' + fmt.esc(id) + '" data-v="negative"'
      + ' onclick="fbAsk(' + fmt.attr(id) + ',\'negative\')" title="' + fmt.esc(neg ? '取消标记' : '有问题的回答：存到 DSH 服务端，可带分类与说明') + '">👎<span class="ma-t">有问题的回答</span></button>');
  }
  if (o.turn != null) {
    bits.push('<button class="ma-btn" onclick="toggleMsgUsage(this)" title="本轮用量与用时">📊<span class="ma-t">用量</span></button>');
    // 不再用 isTail 门控：整轮只有这一条页脚，它天然就是轮末
    bits.push('<button class="ma-btn" onclick="branchAtTurn(' + Number(o.turn) + ')"'
      + (done ? '' : ' disabled')
      + ' title="' + fmt.esc(done ? '在新对话中分支：从第 ' + o.turn + ' 轮结束处复制出一个新会话，当前会话不受影响' : '仅可从已完成轮次的最后一条消息分支') + '">⑂<span class="ma-t">在新对话中分支</span></button>');
  }
  if (dur != null) bits.push('<span class="ma-dur" title="' + fmt.esc('本轮用时（turn/start → turn/end）') + '">用时 ' + fmtDur(dur) + '</span>');
  // 轮次非正常结束时给一句行内提醒（原生 message.maxTokens.hint 等也是行内，不只藏在面板里）
  const hint = rec ? reasonHint(rec.reason) : '';
  if (hint) bits.push('<span class="ma-note" title="' + fmt.esc(reasonText(rec.reason)) + '">⚠ ' + fmt.esc(hint) + '</span>');
  // 用量浮层取**轮次级**数据（usage 传 null：本轮页脚不该只显示某一次调用的用量），
  // step 仍传末步，好让"这一次调用的速度（TTFT/TPS）"这一段还有数
  return '<div class="msg-acts turn-foot" data-turn="' + (o.turn != null ? Number(o.turn) : '') + '">'
    + bits.join('')
    + (o.turn != null ? usagePanelHtml(o.turn, null, o.step) : '')
    + '</div>';
}

/** 复制一条消息的全文（成功就地变 ✓，1 秒后复原 —— 对齐原生 copy/copied） */
async function copyMsg(btn) {
  const key = btn && btn.dataset ? btn.dataset.key : '';
  const text = (State.msgText || {})[key];
  if (text == null) { UI.warn('这条消息的原文已不在内存，重新载入会话后再试'); return; }
  const ok = await writeClipboard(text);
  if (!ok) { UI.warn('复制失败，请手动选择文本'); return; }
  btn.classList.add('cp-ok');
  btn.innerHTML = '✓<span class="ma-t">已复制</span>';
  setTimeout(() => { btn.classList.remove('cp-ok'); btn.innerHTML = '⧉<span class="ma-t">复制</span>'; }, 1000);
}

/** 展开 / 收起某条消息的用量面板 */
function toggleMsgUsage(btn) {
  const pop = btn && btn.parentElement ? btn.parentElement.querySelector('.ma-pop') : null;
  if (!pop) return;
  const willOpen = pop.hasAttribute('hidden');
  if (willOpen) pop.removeAttribute('hidden'); else pop.setAttribute('hidden', '');
  btn.classList.toggle('on', willOpen);
}

/** 写剪贴板：现代 API 优先，失败退回 execCommand 兜底。返回 Promise<boolean> */
function writeClipboard(text) {
  const s = String(text == null ? '' : text);
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(s).then(() => true).catch(() => legacyCopy(s));
  }
  return Promise.resolve(legacyCopy(s));
}
function legacyCopy(s) {
  try {
    const ta = document.createElement('textarea');
    ta.value = s; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
    return true;
  } catch (e) { return false; }
}

/* ---------- 对话流式渲染 ---------- */
const Chat = {
  el(){ return document.getElementById('chatlog'); },
  clearEmpty(){ const l = this.el(); if (l && l.querySelector('.empty')) l.innerHTML = ''; },
  /* 是否跟随到底部。**这是"轮次点击有时候没反应"的根因**：
     以前这里是无条件 `scrollTop = scrollHeight`，于是流式过程中每来一行都把面板拽回底部 ——
     用户点轮次刚跳上去、下一行事件到达就被覆盖，看起来就是"点了没反应"（只在会话还在跑时出现，
     所以是"有时候"）。现在改成**只在用户本来就在底部时跟随**：滚上去看历史就停下来，
     回到近距离内自动恢复跟随（见 onScroll）。
     force=true 用于"用户主动要到底部"的动作：发消息、本地命令回显、回到底部按钮。 */
  _follow: true,
  scroll(force){ const l = this.el(); if (!l) return; if (!force && this._follow === false) return; l.scrollTop = l.scrollHeight; },
  /** 两侧的身份标识：头像 + 角色名。视觉区分的唯一来源，实时流与历史回填共用 */
  ROLE: {
    user:  { ico: '👤', name: '我' },
    agent: { ico: '🛰️', name: '时空智能体' },
  },
  /**
   * 构造一条消息行：模型气泡；追加到对话流并返回气泡元素。
   * 字号 / 底色 / 圆角全部由 style.css 的 .msg-* 决定，这里不写内联样式。
   *
   * **一次问答只在最开始标记一次**（对齐原生）：
   * 原生对话流里既没有逐条的角色名，也没有头像 —— 助手回答就是一段通栏 Markdown。
   * 唯一的"这是谁在什么时候问的"标记，是**用户气泡下方那一行日期时间**（原生
   * MessageItem 的用户行 = [userStack, actions]，actions 里放 formatMessageClock）。
   * 所以这里只在 role='user' 时挂 .msg-stamp；助手行不带任何标记。
   * 原来每条消息都顶一个「🛰️ 时空智能体」，满屏重复且原版没有，已去掉。
   * @param role 'user' | 'agent'
   * @param meta { turn?, seq?, time? } time 用于用户行的日期时间标记
   */
  row(role, meta = {}) {
    this.clearEmpty();
    const wrap = document.createElement('div');
    wrap.className = 'msg ' + (role === 'user' ? 'user' : 'agent');
    // 轮号与序号打在行上：轮末页脚靠 data-turn 定位，轮次过程折叠靠 data-turn + data-seq 划窗口
    if (meta.turn != null && Number.isFinite(Number(meta.turn))) wrap.dataset.turn = String(Number(meta.turn));
    if (meta.seq != null && Number.isFinite(Number(meta.seq))) wrap.dataset.seq = String(Number(meta.seq));
    const col = document.createElement('div');
    col.className = 'msg-wrap';
    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble';
    col.appendChild(bubble);
    // 提问那一行才带时间标记；没有时间就整行不占位（原生也是没有就不渲染 actions）
    if (role === 'user') {
      const clock = msgClock(meta.time != null ? meta.time : Date.now());
      if (clock) {
        const stamp = document.createElement('div');
        stamp.className = 'msg-stamp';
        stamp.textContent = clock;
        col.appendChild(stamp);
      }
    }
    wrap.appendChild(col);
    this.el().appendChild(wrap);
    this.scroll();
    return bubble;
  },
  /** 加一条消息并写入 HTML，返回气泡元素（保留旧签名） */
  bubble(role, html, meta) {
    const b = this.row(role === 'user' ? 'user' : 'agent', meta || {});
    if (html != null) b.innerHTML = html;
    return b;
  },
  reset() {
    const l = this.el(); if (!l) return;
    l.innerHTML = '<div class="empty">面板已清空（会话记录仍在 DSH 侧）</div>';
    this.cur = null; this.curKey = null; this.lastUser = null; this.lastBubble = null;
    State.msgText = {};                       // 复制用的原文缓存跟着清（否则跨会话残留旧文本）
  },
  // 把用户消息加进流（发消息时先本地显示，避免和回显重复）；media 是附件 HTML
  // 用户消息**不挂操作条**：本轮页脚统一在轮末，由 placeTurnFoot() 摆放
  localUser(text, media){
    // 时间标记就用本地这一刻：服务端回显会把真实 event.time 覆盖回来（见 remoteUser）
    const b = this.bubble('user', fmt.esc(text) + (media || ''), { time: Date.now() });
    this.lastUser = text; this.lastBubble = b;
    State.pendingUserText = text; State.pendingUserTime = Date.now();   // 等 turn/start 认领轮号
  },
  // 服务端回显的用户消息：与本地刚发的同一条则不再画一遍（但缺附件时把附件补到那条上）
  remoteUser(text, media, meta){
    const m = meta || {};
    if (this.lastUser && text.trim() === this.lastUser.trim()) {
      this.lastUser = null;
      if (media && this.lastBubble && !this.lastBubble.querySelector('.att-img, .att-file')) this.lastBubble.innerHTML += media;
      State.pendingUserTime = m.time || State.pendingUserTime;
      // 本地先画的那条也要补上轮号/序号，否则它落在折叠窗口之外
      const row = this.lastBubble && this.lastBubble.closest ? this.lastBubble.closest('.msg') : null;
      if (row && m.turn != null) row.dataset.turn = String(Number(m.turn));
      if (row && m.seq != null) row.dataset.seq = String(Number(m.seq));
      // 时间标记换成服务端的权威时间（本地那条用的是发起时刻，两者可能差几秒）
      const stamp = row && row.querySelector ? row.querySelector('.msg-stamp') : null;
      if (stamp && m.time) stamp.textContent = msgClock(m.time);
      return;
    }
    const b = this.bubble('user', fmt.esc(text) + (media || ''), { time: m.time });
    const row = b && b.closest ? b.closest('.msg') : null;
    if (row && m.turn != null) row.dataset.turn = String(Number(m.turn));
    if (row && m.seq != null) row.dataset.seq = String(Number(m.seq));
    State.pendingUserText = text;
    State.pendingUserTime = m.time || Date.now();
  },
  /** 只做两件事：① 给消息行标上轮次（轮次导航靠 data-turn 定位）② 若这条**本身**就是页脚锚点则挂页脚。
   *  注意：普通消息不会再产出操作条了 —— 页脚整轮只有一条，由 placeTurnFoot() 统一摆放。 */
  addActions(bubble, o) {
    const msg = bubble && bubble.closest && bubble.closest('.msg');
    if (msg && o && o.turn != null) msg.dataset.turn = String(Number(o.turn));
    if (!o || !o.foot) return;
    const wrap = (bubble.closest && bubble.closest('.msg-wrap')) || bubble.parentElement;
    if (!wrap) return;
    const box = document.createElement('div');
    box.innerHTML = msgActionsHtml(o);
    if (box.firstElementChild) wrap.appendChild(box.firstElementChild);
  },
  /** 把某一轮的页脚摆到该轮**最后一条消息**下面（对齐原生：页脚在正文下方 20px）。
   *  消息是逐步追加的，所以每来一条新消息都要重摆一次 —— 先摘掉这一轮所有旧页脚再重建，
   *  这样"页脚永远在轮末"这条不变量只有一处维护点。
   *  幂等：同一状态下重复调用结果一致。 */
  placeTurnFoot(turn) {
    const log = this.el();
    if (!log || !log.querySelector || turn == null) return;
    const n = Number(turn);
    if (!Number.isFinite(n)) return;
    const msgs = [...log.querySelectorAll('.msg[data-turn="' + n + '"]')];
    if (!msgs.length) return;
    // 旧页脚可能挂在本轮任意一条消息下（上一条消息上），统一摘掉
    log.querySelectorAll('.turn-foot[data-turn="' + n + '"]').forEach(e => e.remove());
    const o = Turns.footOf(n);
    if (!o) return;
    const last = msgs[msgs.length - 1];
    const wrap = last.querySelector('.msg-wrap') || last;
    const box = document.createElement('div');
    box.innerHTML = msgActionsHtml(o);
    if (box.firstElementChild) wrap.appendChild(box.firstElementChild);
  },
  /** 一轮结束时刷新该轮页脚：用时此刻才有值、分支按钮此刻才该解禁。 */
  repaintTurnActions(turn) { this.placeTurnFoot(turn); },
  /** 滚动时决定「回到底部」是否露面（离底超过一屏的 1/4 才给，免得晃眼） */
  onScroll() {
    const l = this.el(), btn = document.getElementById('chatbottom');
    if (!l) return;
    const gap = l.scrollHeight - l.scrollTop - l.clientHeight;
    /* 两档阈值，别合成一个：
       · >60   → 视为"在看历史"，停止自动跟随（含点轮次跳上去、手动往上滚）；
       · >200  → 「回到底部」按钮才显示。
       合成一个的话，稍微滚一点点就会弹出按钮、或者刚点完轮次就被自动跟随拽走。 */
    this._follow = gap < 60;
    if (!btn) return;
    btn.style.display = gap > 200 ? '' : 'none';
  },
  toBottom() {
    this._follow = true;                       // 用户明确要回到底部 → 恢复自动跟随
    const l = this.el(); if (l) l.scrollTop = l.scrollHeight;
    const btn = document.getElementById('chatbottom'); if (btn) btn.style.display = 'none';
  },
  // 逐字增量（对齐原生 MarkdownText：流式过程中就按 Markdown 渲染，120ms 节流；
  // 完整消息到达后 finishMessage 会用服务端全文校正一次）
  appendDelta(turn, step, index, text){
    this.step_(turn, step);
    this.cur._raw = (this.cur._raw || '') + text;
    this.scroll();
    this.scheduleFlush_();
  },
  /** 流式思考增量（assistant/chunk 的 reasoning-delta）。原生也是先思考后正文。
   *  与正文共用同一个气泡：思考渲染成展开的折叠条，正文跟随其后。 */
  appendThink(turn, step, index, text){
    this.step_(turn, step);
    this.cur._think = (this.cur._think || '') + text;
    this.scroll();
    this.scheduleFlush_();
  },
  /** 取（必要时新建）本步的气泡。思考与正文都落在这里，所以顺序天然是"思考在前、正文在后" */
  step_(turn, step){
    const key = turn + ':' + step;
    if (this.curKey !== key || !this.cur) {
      this.curKey = key;
      this.cur = this.row('agent');
      this.cur._raw = '';                                     // 原始文本挂在气泡元素上，重绘搬运时随节点走
      this.cur._think = '';
      this.cur.closest('.msg')?.classList.add('streaming');   // 生成中：气泡末尾显示光标（CSS ::after）
    }
    return this.cur;
  },
  scheduleFlush_(){
    if (this._mdTimer) return;
    this._mdTimer = setTimeout(() => { this._mdTimer = null; this.flushDelta(); }, 120);
  },
  /** 把当前累积的思考 + 原始文本渲染进流式气泡（节流合并，避免每 delta 全量重排） */
  flushDelta(){
    if (!this.cur || !this.cur.isConnected) return;
    this.cur.innerHTML = reasoningHtml(this.cur._think, true) + MD.render(this.cur._raw || '');
    this.scroll();
  },
  /** 完整消息到达：用服务端全文校正增量内容，并挂上操作条。
   *  @param messageId 服务端持久化的助手消息 id —— **反馈就用它**（用序号会被宿主判 target-not-found）
   *  @param meta { turn, step, usage, time, seq, think } 供操作条显示 用量 / 速度 / 本轮用时 / 时间 */
  finishMessage(text, messageId, meta){
    if (this._mdTimer) { clearTimeout(this._mdTimer); this._mdTimer = null; }
    const m = meta || {};
    // 思考块以服务端全文为准（流式那份可能只到一半）；完整消息里收起，不占版面
    const think = m.think != null ? m.think : (this.cur && this.cur._think);
    const inner_ = reasoningHtml(think, false) + MD.render(text) + (m.extra || '');
    let inner = this.cur;
    if (inner) {
      inner.closest('.msg')?.classList.remove('streaming');   // 生成结束：光标消失
      inner.innerHTML = inner_;                       // 完整消息用 Markdown 渲染
      this.cur = null; this.curKey = null;
    } else if (text || think) {
      inner = this.bubble('agent', inner_);
    }
    if (inner) {
      const msg = inner.closest && inner.closest('.msg');
      if (msg && m.turn != null) msg.dataset.turn = String(Number(m.turn));
      if (msg && m.seq != null) msg.dataset.seq = String(Number(m.seq));
      this.placeTurnFoot(m.turn);
      this.scroll();
    }
  },
  /** 反馈状态变了（feedback/message-put|delete 事件）→ 就地刷新页脚上的 👍/👎 选中态。
   *  不重绘整页：那会重跑加载器、把滚动位置和折叠状态一起冲掉。 */
  refreshFootFeedback() {
    const log = this.el();
    if (!log || !log.querySelectorAll) return;
    log.querySelectorAll('.turn-foot [data-fb]').forEach(btn => {
      const id = btn.dataset ? btn.dataset.fb : '';
      const cur = (State.feedback || {})[id];
      const v = btn.dataset ? btn.dataset.v : '';
      const on = !!(cur && cur.rating === v);
      if (btn.classList) { if (on) btn.classList.add('on'); else btn.classList.remove('on'); }
    });
  },
  toolHint(t){ this.status(t); },
  /** 工具调用：插一张工具行（结果到达后由 toolResult 用同一份 name/args 重渲染）。
   *  name/args 必须留在 `data-*` 上：结果事件里**没有**这两个字段，丢了名字就再也画不出对的标题。 */
  toolCall(callId, name, args, turn, step, seq) {
    this.clearEmpty();
    const wrap = document.createElement('div');
    wrap.className = 'rail tool-slot';                       // 归属智能体一侧的左轨
    wrap.dataset.callId = callId;
    wrap.dataset.tool = name || '';
    wrap.dataset.args = (typeof args === 'string') ? args : JSON.stringify(args || {});
    if (turn != null && Number.isFinite(Number(turn))) wrap.dataset.turn = String(Number(turn));
    if (seq != null && Number.isFinite(Number(seq))) wrap.dataset.seq = String(Number(seq));
    wrap.innerHTML = ToolCard.html({ name, args, state: 'running' });
    this.el().appendChild(wrap);
    this.scroll();
    return wrap;
  },
  /** 审批请求卡（对齐原生：审批内嵌对话流，允许/拒绝按钮就在卡片上；侧栏仅作汇总兜底） */
  approvalCard(a) {
    const el = this.el(); if (!el) return;
    this.clearEmpty();
    const id = a.approvalId || a.eventId || '';
    const wrap = document.createElement('div');
    wrap.className = 'rail';
    wrap.dataset.apprId = String(id);
    wrap.innerHTML = `<div class="apprcard">
      <div class="apprcard-head">🛡️ <b>审批请求</b>${a.toolName ? '<span class="tag gray mono" style="font-size:9.5px">' + fmt.esc(String(a.toolName).slice(0,60)) + '</span>' : ''}</div>
      ${a.reason ? `<div class="apprcard-reason">${fmt.esc(String(a.reason).slice(0,300))}</div>` : ''}
      <div class="apprcard-actions">
        <button class="btn sm primary" onclick="respondApproval('${fmt.esc(id)}', true)">允许一次</button>
        <button class="btn sm" onclick="respondApproval('${fmt.esc(id)}', false)">拒绝</button>
      </div>
    </div>`;
    el.appendChild(wrap);
    this.scroll();
  },
  /** 工具结果：把对应工具行重渲染成完成态（name/args 从 data-* 取回，结果从事件里来） */
  toolResult(callId, text, isError, media, meta, seq) {
    const el = this.el();
    if (!el) return;
    const wrap = el.querySelector('[data-call-id="' + CSS.escape(callId) + '"]');
    if (!wrap) return;
    if (seq != null) wrap.dataset.seq = String(Number(seq));
    wrap.innerHTML = ToolCard.html({
      name: wrap.dataset.tool || '', args: wrap.dataset.args || '',
      result: text, isError: !!isError, state: isError ? 'error' : (meta && meta.interrupted ? 'stopped' : 'ok'),
      meta, media,
    });
    this.scroll();
  },
  /** Code Mode 子调用（run_code 内调用的工具） */
  toolDispatch(subCallId, name, args) {
    this.clearEmpty();
    const wrap = document.createElement('div');
    wrap.className = 'rail chat-subcall';
    wrap.innerHTML = '↳ 子调用 <b class="mono">' + fmt.esc(name) + '</b> '
      + fmt.esc(String(args?.file_path || args?.toolName || '').slice(0, 60));
    this.el().appendChild(wrap);
    this.scroll();
  },
  status(t){
    let el = document.getElementById('chatstatus');
    if (!el) {
      el = document.createElement('div'); el.id = 'chatstatus';
      el.className = 'chat-status';
      this.el().appendChild(el);
    }
    el.innerHTML = t ? '<span class="loading"></span> ' + fmt.esc(t) : '';
    if (!t && el.parentNode) el.remove();
    this.scroll();
  },
};

/* ============ 对话流里的"非消息行" ============
 * 原版对话流不只有提问与回答，还有一整套 surface 行：系统提示词、上下文注入、交付文件、
 * 本轮文件改动、上下文压缩、子代理、工作流（多 agent）、目标变更、轮次结束原因……
 * 这些事件控制台此前**整个丢掉**（history 只保留 6 种类型），所以看起来"少了好多东西"。
 * 下面把每一类都按原版的文案与形态补上（文案取自 dsh-client-ui-chat / -deliverables / -subagent）。
 */
const ChatRow = {
  /** 系统提示词（原生 message.systemPrompt）：默认折叠 —— 它有几 KB，铺开会把对话淹掉 */
  system(text) {
    const s = String(text || '');
    const head = s.split('\n').map(x => x.trim()).filter(Boolean)[0] || '';
    return '<details class="crow crow-sys"><summary>系统提示词'
      + '<span class="crow-meta">' + fmtInt(s.length) + ' 字</span></summary>'
      + '<div class="crow-sum mono">' + fmt.esc(head.slice(0, 200)) + '</div>'
      + '<pre class="tr-pre mono crow-pre">' + fmt.esc(s.slice(0, 20000)) + '</pre></details>';
  },
  /** 上下文注入（原生 message.contextInjection）：本轮带了哪些注入内容 + 上下文窗口 */
  context(d) {
    const bits = [];
    if (d && d.provider) bits.push('提供方 ' + d.provider);
    if (d && d.model) bits.push('模型 ' + d.model);
    if (d && d.contextWindow) bits.push('上下文窗口 ' + fmtInt(d.contextWindow));
    return '<details class="crow crow-ctx"><summary>上下文注入'
      + '<span class="crow-meta">' + fmt.esc(bits.join(' · ')) + '</span></summary>'
      + '<div class="crow-sum">运行时上下文（<code>Current runtime context</code> / <code>&lt;system-reminder&gt;</code> 等）'
      + '由宿主在每次请求前拼接，不属于用户输入，所以单独成行、默认收起。</div></details>';
  },
  /** 非用户输入产生的 user/message：插件注入 / 跨会话召回 / 会话中继 / 子代理结算 / 目标推进轮。
   *
   *  ⚠️ 实测这一条很要紧：本机某会话 15 条 user/message 里只有 5 条 source.kind === 'user'，
   *  其余 10 条（plugin 6 / agent-message 2 / subagent-settled 2）**都带着真实正文**，
   *  长的有 4.7KB（子代理回传的完整报告）。此前它们一律被画成一张**空的**「上下文注入」，
   *  等于把近 19KB 的真实内容整段丢掉 —— 这正是"很多内容没有"的主因之一。
   *
   *  这是一个**逐字对照原生**的实现（上游 dsh-client-ui-chat：ContextInjectionRow + ContextBody）：
   *   · 标题只有两个取值 —— `跨会话召回`（provenance.role === 'recall'）与 `上下文注入`（其余）；
   *     标题右侧用 2×2 圆点分隔地跟 `provenance.label`（原生 XrJvXW_sep/source），
   *     notice 形态再多一个 `source.summary`（原生 XrJvXW_summary）。
   *   · 展开体按 `source.form` 分型：instructions / catalog / snapshot / notice / relay / recall；
   *     没有 form、或 form 认不出、或该 form 的字段读不完整 → 一律落**通透白底**
   *     （原生 OpaqueBody：模型面对的原文 + 其余 source 字段的键值表）。
   *     `goal` 的 round、`sections` 的段落名就是靠这张键值表露出来的。
   *   · 原文上限 2e4 字符（原生 MAX_CHARS），超出补 `… 已截断，共 N 字符`。
   *
   *  实测 8 种 source 形状（全 10 会话 / 44 条）：
   *   user · plugin(dsh-knowledge) · plugin(dsh-system-prompt,form=snapshot,sections[]) ·
   *   agent-message(form=relay) · subagent-settled(form=notice,summary) ·
   *   plugin(tool-jobs,form=notice,summary) · goal(round) · skill-catalog(form=catalog,entries[])。 */
  source(d, blocks) {
    const src = (d && d.source) || {};
    const form = ChatRow.ctxForm(src);
    const prov = ChatRow.provenance(src);
    const b = ChatRow.ctxBody(form, src, blocks);
    const parts = ['<span class="tr-lead"><span class="tr-ico">' + (prov.recall ? '🧠' : '🧩')
      + '</span><span class="tr-chev">▸</span></span>'
      + '<span class="crow-lbl">' + (prov.recall ? '跨会话召回' : '上下文注入') + '</span>'];
    if (prov.label !== null) parts.push('<span class="crow-dot"></span><span class="crow-src-name" data-context-source="1">' + fmt.esc(prov.label) + '</span>');
    if (b.summary !== null) parts.push('<span class="crow-dot"></span><span class="crow-src-sum" data-context-summary="1">' + fmt.esc(b.summary) + '</span>');
    return '<details class="crow crow-src"' + (b.rendered ? ' data-form="' + fmt.esc(b.rendered) + '"' : '')
      + '><summary title="' + fmt.esc(ChatRow.ctxChars(blocks) + ' 字') + '">' + parts.join('') + '</summary>'
      + '<div class="crow-body" data-context-injection-body="1">' + b.html + '</div></details>';
  },
  /** 原生 KNOWN_FORMS：只有这 6 个 form 有专属正文，其余一律走通透白底 */
  FORMS: ['instructions', 'catalog', 'snapshot', 'notice', 'relay', 'recall'],
  /** 原生 contextForm：声明的 form 必须在 KNOWN_FORMS 里，否则视同"没有 form" */
  ctxForm(src) {
    const f = (src && typeof src.form === 'string') ? src.form : '';
    return ChatRow.FORMS.includes(f) ? f : null;
  },
  /** 原生 contextProvenance：只产出 role(recall?) 与右侧 label；标题文案由 role 决定 */
  provenance(src) {
    const rec = (v) => (v && typeof v === 'object' && !Array.isArray(v)) ? v : null;
    const str = (o, k) => { const v = o ? o[k] : null; return (typeof v === 'string' && v.length) ? v : null; };
    const collect = (o, member, field) => {
      const list = o ? o[member] : null;
      if (!Array.isArray(list)) return [];
      const seen = [];
      for (const it of list) {
        const v = (rec(it) !== null) ? str(rec(it), field) : null;
        if (v !== null && !seen.includes(v)) seen.push(v);
      }
      return seen;
    };
    const kind = str(rec(src), 'kind');
    if (rec(src) === null || kind === null) return { recall: false, label: null };
    if (kind === 'session-reference') { const l = collect(src, 'references', 'label'); return { recall: true, label: l.length ? l.join(', ') : kind }; }
    if (kind === 'agent-instructions') { const l = collect(src, 'changes', 'path'); return { recall: false, label: l.length ? l.join(', ') : kind }; }
    if (kind === 'plugin') return { recall: false, label: str(src, 'plugin') || kind };
    if (kind === 'skill-invocation') return { recall: false, label: str(src, 'name') || kind };
    return { recall: false, label: kind };
  },
  /** 原生 contentRuns：相邻 text 块**无分隔**拼接（加换行会显示出模型没见过的行）；
   *  不认识的块打断成段并各自兜底，既不被抬到相邻文字之前，也不凭空消失 */
  runs(blocks) {
    const out = [];
    for (const blk of (Array.isArray(blocks) ? blocks : [])) {
      if (!blk || typeof blk !== 'object') continue;
      if (blk.type !== 'text') { out.push({ block: blk }); continue; }
      const last = out[out.length - 1];
      const t = String(blk.text == null ? '' : blk.text);
      if (last && 'text' in last) last.text += t; else out.push({ text: t });
    }
    return out;
  },
  /** 原生 boundedText：模型面对的原文，超 2e4 字符截断并注明总长（json.truncated） */
  bounded(text) {
    const t = String(text == null ? '' : text), MAX = 20000;
    return t.length > MAX ? t.slice(0, MAX) + '\n… 已截断，共 ' + fmtInt(t.length) + ' 字符' : t;
  },
  /** 原生 UnknownBlocks / JsonBlock：本版本认不出的块，保留可见而不是丢掉 */
  unknownBlock(blk) {
    let payload = '';
    try { payload = String(JSON.stringify(blk, null, 2)); } catch { payload = String(blk); }
    return '<div class="crow crow-extra" data-context-unknown-block="1">❔ 未知内容块'
      + '<span class="crow-meta">' + fmt.esc(String(blk && blk.type ? blk.type : '?')) + '</span>'
      + '<pre class="tr-pre mono">' + fmt.esc(payload.slice(0, 20000)) + '</pre></div>';
  },
  /** 原生 ModelFacingContent：text 段按真实换行渲染，未知块各自兜底 */
  modelFacing(blocks) {
    return ChatRow.runs(blocks).map(r => {
      if ('text' in r) return r.text === '' ? '' : '<pre class="ctx-text" data-context-text="1">' + fmt.esc(ChatRow.bounded(r.text)) + '</pre>';
      return ChatRow.unknownBlock(r.block);
    }).join('');
  },
  /** 只取认不出的块（用于正文已被结构体取代的分型：snapshot 之外它们仍要露出来） */
  unknownOnly(blocks) {
    return ChatRow.runs(blocks).filter(r => 'block' in r).map(r => ChatRow.unknownBlock(r.block)).join('');
  },
  /** 行上"N 字"提示用：只数模型面对的文本，与原生 body 的文本口径一致 */
  ctxChars(blocks) {
    return ChatRow.runs(blocks).reduce((n, r) => n + ('text' in r ? r.text.length : 0), 0);
  },
  /** 原生 OpaqueBody：模型面对的原文 + 其余 source 字段的键值表 */
  opaqueBody(src, blocks) {
    return ChatRow.modelFacing(blocks) + ChatRow.sourceFields(src, false);
  },
  /** 原生 SourceFields：source 的键值表。`kind` 永远隐去（行头已经点名生产者）；
   *  `form` 只在有专属正文时才隐去 —— 走通透白底时它是唯一能露出来的地方 */
  sourceFields(src, formRendered) {
    const rec = (v) => (v && typeof v === 'object' && !Array.isArray(v)) ? v : null;
    const r = rec(src);
    if (r === null) return '';
    const hidden = formRendered ? ['kind', 'form'] : ['kind'];
    const rows = Object.entries(r).filter(([k]) => !hidden.includes(k));
    if (rows.length === 0) return '';
    return '<dl class="ctx-fields" data-context-fields="1">' + rows.map(([k, v]) => {
      // 原生 fieldValue：字符串/数字/布尔直接成文，其余形状保持紧凑 JSON
      const val = (typeof v === 'string') ? v
        : (typeof v === 'number' || typeof v === 'boolean') ? String(v)
          : String(JSON.stringify(v));
      return '<div class="ctx-field"><dt class="ctx-fkey">' + fmt.esc(k) + '</dt><dd class="ctx-fval">'
        + fmt.esc(ChatRow.bounded(val)) + '</dd></div>';
    }).join('') + '</dl>';
  },
  /** 原生 contextBody(form, props) → {rendered, summary, html}；rendered=null 表示落了通透白底。
   *  每种分型的读取都是**全有或全无**：读不完整就退回通透白底 —— 只丢一条读不出的记录，
   *  会显示出一份"看着可信、其实不全"的清单。 */
  ctxBody(form, src, blocks) {
    const opaque = { rendered: null, summary: null, html: ChatRow.opaqueBody(src, blocks) };
    const rec = (v) => (v && typeof v === 'object' && !Array.isArray(v)) ? v : null;
    const str = (k) => { const v = src ? src[k] : null; return (typeof v === 'string' && v.length) ? v : null; };
    const arr = (k) => (src && Array.isArray(src[k])) ? src[k] : null;
    if (form === 'instructions') {
      // 原生 InstructionsBody：文件清单 + 原文。action ∈ set|replace|remove，path 首次出现优先
      const list = arr('changes'); if (list === null) return opaque;
      const changes = [], seen = new Set();
      for (const it of list) {
        const c = rec(it); if (c === null) return opaque;
        const path = (typeof c.path === 'string' && c.path) ? c.path : null;
        if (path === null || !['set', 'replace', 'remove'].includes(c.action)) return opaque;
        if (seen.has(path)) continue;
        seen.add(path);
        changes.push({ path, action: c.action, digest: (typeof c.digest === 'string') ? c.digest : null });
      }
      if (changes.length === 0) return opaque;
      const baseline = src.baseline === true;
      const act = (a) => a === 'remove' ? '已移除' : (baseline ? '已载入' : (a === 'set' ? '已新增' : '已更新'));
      return { rendered: 'instructions', summary: null,
        html: '<ul class="ctx-files" data-context-files="1">' + changes.map(c =>
          '<li' + (c.digest ? ' title="' + fmt.esc(c.digest) + '"' : '') + '><span class="ctx-fpath">' + fmt.esc(c.path)
          + '</span><span class="ctx-fact">' + act(c.action) + '</span></li>').join('') + '</ul>'
          + ChatRow.modelFacing(blocks) };
    }
    if (form === 'catalog') {
      // 原生 CatalogBody：条目清单取代原文；认不出的块仍要露出来，原文不再重复
      const list = arr('entries'); if (list === null) return opaque;
      const entries = [];
      for (const it of list) {
        const e = rec(it); if (e === null) return opaque;
        const name = (typeof e.name === 'string' && e.name) ? e.name : null;
        if (name === null || typeof e.description !== 'string') return opaque;
        entries.push({ name, description: e.description });
      }
      const MAX = 200, shown = entries.slice(0, MAX);
      let html = '';
      if (src.update === true) html += '<p class="ctx-note" data-context-catalog-update="1">替换目录</p>';
      html += '<ul class="ctx-entries" data-context-entries="1">' + shown.map(e =>
        '<li><code class="ctx-ename">' + fmt.esc(e.name) + '</code><span class="ctx-edesc">' + fmt.esc(e.description) + '</span></li>').join('') + '</ul>';
      if (shown.length < entries.length) {
        html += '<p class="ctx-note" data-context-entries-truncated="1">…还有 ' + fmtInt(entries.length - shown.length) + ' 条</p>';
      }
      return { rendered: 'catalog', summary: null, html: html + ChatRow.unknownOnly(blocks) };
    }
    if (form === 'snapshot') {
      // 原生 SnapshotBody：只给"哪几个子系统贡献了什么"的段落表 + supersedes 说明。
      // 这一段刻意**不重复**拼接后的原文 —— 段落就是那批字节按生产者边界切开的结果。
      const list = arr('sections'); if (list === null) return opaque;
      const secs = [];
      for (const it of list) {
        const s2 = rec(it); if (s2 === null) return opaque;
        if (typeof s2.name !== 'string' || !s2.name || typeof s2.text !== 'string') return opaque;
        secs.push({ name: s2.name, text: s2.text });
      }
      if (secs.length === 0) return opaque;
      return { rendered: 'snapshot', summary: null,
        html: '<p class="ctx-note" data-context-snapshot-supersedes="1">取代先前的快照</p>'
          + '<dl class="ctx-sections" data-context-sections="1">' + secs.map(s2 =>
            '<div><dt class="ctx-sname">' + fmt.esc(s2.name) + '</dt><dd class="ctx-stext">' + fmt.esc(ChatRow.bounded(s2.text)) + '</dd></div>').join('') + '</dl>' };
    }
    if (form === 'notice') {
      // 原生 NoticeBody：一句话摘要在**折叠行**上就说完，展开只是原文
      const summary = str('summary'); if (summary === null) return opaque;
      return { rendered: 'notice', summary, html: ChatRow.modelFacing(blocks) };
    }
    if (form === 'relay') {
      // 原生 RelayBody：发送方是 opaque 的会话 id，按字段展示（客户端解不出标题）
      const sender = str('senderSessionId'); if (sender === null) return opaque;
      return { rendered: 'relay', summary: null,
        html: '<p class="ctx-note" data-context-relay-sender="1">来自会话 ' + fmt.esc(sender) + '</p>' + ChatRow.modelFacing(blocks) };
    }
    if (form === 'recall') {
      // 原生 RecallBody：被召回的会话 + 保留/省略条数 + 是否截断
      const list = arr('references'); if (list === null) return opaque;
      const refs = [];
      for (const it of list) {
        const r = rec(it); if (r === null) return opaque;
        const label = (typeof r.label === 'string' && r.label) ? r.label : null;
        if (label === null || typeof r.retainedMessages !== 'number' || typeof r.omittedMessages !== 'number' || typeof r.truncated !== 'boolean') return opaque;
        refs.push({ label, retained: r.retainedMessages, omitted: r.omittedMessages, truncated: r.truncated });
      }
      if (refs.length === 0) return opaque;
      return { rendered: 'recall', summary: null,
        html: '<ul class="ctx-recalls" data-context-recalls="1">' + refs.map(r =>
          '<li><span class="ctx-rlabel">' + fmt.esc(r.label) + '</span><span class="ctx-rcount">保留 ' + fmtInt(r.retained)
          + ' 条 · 省略 ' + fmtInt(r.omitted) + ' 条</span>'
          + (r.truncated ? '<span class="ctx-rcount">已截断</span>' : '') + '</li>').join('') + '</ul>'
          + ChatRow.modelFacing(blocks) };
    }
    return opaque;
  },
  /** 请求头（原生 request/header）：真正发出去的配置与工具定义清单一瞥 */
  header(d) {
    const h = (d && d.header) || {};
    const cfg = h.config || {};
    const tools = Array.isArray(h.tools) ? h.tools : [];
    const bits = [];
    if (cfg.model) bits.push(cfg.model);
    if (cfg.reasoningEffort) bits.push('reasoning ' + cfg.reasoningEffort);
    if (cfg.maxTokens) bits.push('maxTokens ' + fmtInt(cfg.maxTokens));
    bits.push(tools.length + ' 个工具定义');
    if (d && d.reason) bits.push('原因 ' + d.reason);
    return '<details class="crow crow-head"><summary>请求头'
      + '<span class="crow-meta">' + fmt.esc(bits.join(' · ')) + '</span></summary>'
      + '<div class="crow-sum">工具定义：' + fmt.esc(tools.map(t => t.name).filter(Boolean).join(', ').slice(0, 1200) || '—') + '</div></details>';
  },
  /** 上下文压缩（原生 message.compaction：正在压缩… / 已压缩 N 条历史记录（约 M tokens）） */
  compaction(kind, d) {
    const items = d && (d.items != null ? d.items : d.count);
    const tokens = d && d.tokens;
    let txt = '正在压缩…';
    if (kind === 'summary') txt = '已压缩 ' + (items != null ? fmtInt(items) + ' 条历史记录' : '历史记录')
      + (tokens != null ? '（约 ' + fmtInt(tokens) + ' tokens）' : '');
    else if (kind === 'end') txt = '上下文已压缩';
    return '<div class="crow crow-compact">📦 上下文已压缩<span class="crow-meta">' + fmt.esc(txt) + '</span></div>';
  },
  /** 交付文件（原生 deliverables：row.title = 交付文件，presented.all = 全部 N 个文件）
   *  文件行只留**一个"点名字即打开"的超链接**，不再挂「打开 / 下载」按钮（用户明确要求）。 */
  deliverables(files, turn) {
    const list = Array.isArray(files) ? files : [];
    if (!list.length) return '';
    const rows = list.map(f => {
      const p = String((f && f.path) || '');
      const nm = p.split(/[\\/]/).pop() || p;
      return '<div class="crow-file">' + fileLinkHtml(p, nm)
        + '<span class="crow-fdesc">' + fmt.esc(String((f && f.description) || '')) + '</span></div>';
    }).join('');
    return '<div class="crow crow-deliver"><div class="crow-h">📦 交付文件'
      + '<span class="crow-meta">全部 ' + list.length + ' 个文件' + (turn != null ? ' · 第 ' + Number(turn) + ' 轮' : '') + '</span></div>'
      + rows + '</div>';
  },
  /** 本轮文件改动（原生 produced.label = "本轮文件改动" / produced.open = "打开 {name}"）：
   *  整轮 write/edit 过的文件 + 增删行。文件名同样做成"点即打开"的链接。 */
  produced(list) {
    const rows = (list || []).slice(0, 40).map(f =>
      '<div class="crow-file">' + fileLinkHtml(f.path, f.name)
      + '<span class="crow-fstat">' + fmt.esc(f.kind || '编辑') + '</span>'
      + (f.added || f.removed ? '<span class="crow-add">+' + f.added + '</span><span class="crow-del">−' + f.removed + '</span>' : '')
      + '</div>').join('');
    const more = (list || []).length > 40 ? '<div class="crow-more">+ ' + ((list || []).length - 40) + ' 个文件</div>' : '';
    return '<div class="crow crow-produced"><div class="crow-h">🗂 本轮文件改动'
      + '<span class="crow-meta">' + (list || []).length + ' 个文件</span></div>' + rows + more + '</div>';
  },
  /** 子代理（原生 subagent：{count} 个子代理 / 正在运行 + 模式 一次性 / 可继续） */
  subagent(d) {
    const mode = d.mode === 'continuable' ? '可继续' : (d.mode === 'one-shot' || d.mode === 'oneshot' ? '一次性' : (d.mode || ''));
    return '<div class="crow crow-sub"><span class="crow-cont mono">' + fmt.esc(String(d.label || d.childId || '').slice(0, 90)) + '</span>'
      + '<span class="crow-meta">子代理' + (mode ? ' · ' + fmt.esc(mode) : '') + '</span></div>';
  },
  /** 工作流（多 agent，原生 tool-workflow 事件族）：一次 run 下的各阶段与 agent */
  workflow(kind, d) {
    if (kind === 'run-start') return '<div class="crow crow-wf crow-wf-start">🧭 工作流 <b>' + fmt.esc(d.name || '') + '</b><span class="crow-meta">开始运行</span></div>';
    if (kind === 'run-end') return '<div class="crow crow-wf crow-wf-end">🧭 工作流结束<span class="crow-meta">' + fmt.esc(d.stopReason || '') + '</span></div>';
    if (kind === 'agent-start') return '<div class="crow crow-wf crow-wf-agent">↳ 阶段 <b>' + fmt.esc(d.phase || '') + '</b> · agent ' + fmt.esc(d.label || '')
      + '<span class="crow-meta mono">' + fmt.esc(String(d.childId || '').slice(0, 8)) + '</span></div>';
    return '<div class="crow crow-wf crow-wf-agent">↳ 阶段结束<span class="crow-meta">' + fmt.esc(d.outcome || '') + '</span></div>';
  },
  /** 目标变更（goal/change）：目标页有全套视图，这里只留一行"什么时候发生了什么" */
  goal(d) {
    d = d || {};
    const g = d.goal || {};
    const op = { create: '创建目标', update: '更新目标', clear: '清除目标', complete: '完成目标', pause: '暂停目标', resume: '恢复目标' }[d.operation] || d.operation || '目标变更';
    return '<div class="crow crow-goal">🎯 ' + fmt.esc(op) + ' v' + fmt.esc(String(d.version == null ? '' : d.version))
      + '<span class="crow-meta">' + fmt.esc(String(g.objective || '').slice(0, 120)) + (g.phase ? ' · ' + fmt.esc(g.phase) : '') + '</span></div>';
  },
  /** 会话设置（permission/preset · sandbox/mode · approval/policy）：三条实测事件合成一行 */
  settings(list) {
    const txt = (list || []).filter(Boolean).join(' · ');
    return txt ? '<div class="crow crow-set">⚙ 会话设置<span class="crow-meta">' + fmt.esc(txt) + '</span></div>' : '';
  },
  /** 轮次结束/异常（原生 message.stopped / maxTokens / turnError / failure.auth / retry.*） */
  notice(kind, text) {
    const map = { stopped: '⏹', max: '✂️', error: '⚠️', auth: '🔑', retry: '🔁', warn: '⚠️' };
    return '<div class="crow crow-note crow-note-' + fmt.esc(kind) + '">' + (map[kind] || 'ℹ') + ' ' + fmt.esc(text) + '</div>';
  },
  /** 手写一条用户消息的"收件箱"痕迹（agent/inbox/spliced 且发生了移除） */
  inbox(d) {
    if (!d || !d.removedCount) return '';
    return '<div class="crow crow-inbox">↩ 已从待发送队列移除 ' + fmtInt(d.removedCount) + ' 条消息<span class="crow-meta">'
      + fmt.esc(d.target || '') + '</span></div>';
  },
};
/** 往对话流末尾追加一行非消息行；turn/seq 供轮次定位与统计使用，必须带上 */
function pushChatRow(html, cls, turn, seq) {
  const log = document.getElementById('chatlog');
  if (!log || !html) return null;
  const w = document.createElement('div');
  w.className = 'rail crow-slot ' + (cls || '');
  if (turn != null && Number.isFinite(Number(turn))) w.dataset.turn = String(Number(turn));
  if (seq != null && Number.isFinite(Number(seq))) w.dataset.seq = String(Number(seq));
  w.innerHTML = html;
  log.appendChild(w);
  const el = document.getElementById('chatlog');
  if (el) el.scrollTop = el.scrollHeight;
  return w;
}

/* ---------- MCP 服务（100% 由后端 /api/local/mcp 提供） ----------
   serverName / 显示名 / 厂商 / 类型 / 传输 / 启动命令 / 连接状态 / 工具数 / 工具分组
   全部来自后端：cordis.patch.yml 配置 + 插件树 + 端口探测 + MCP 握手。
   前端不含任何服务清单，新增服务无需改前端代码。
------------------------------------------------------------------ */
/** 后端返回的原始条目 → 页面视图模型（纯映射，不补充任何写死内容） */
function mcpView(s) {
  return {
    serverName: s.serverName,
    name: s.displayName || s.serverName,
    vendor: s.vendor || '—',
    kind: s.kind || (s.transport === 'streamable-http' ? '服务器平台' : '桌面客户端'),
    ns: s.ns || ('mcp__' + s.serverName + '__*'),
    desc: s.description || '',
    note: s.note || '',
    groups: s.groups || [],
    transport: s.transport,
    target: s.target,
    status: s.status,
    online: s.status === 'connected',
    tools: s.tools,
    toolNames: s.toolNames || [],
    toolsSource: s.toolsSource,
    endpoint: s.endpoint,
    source: s.source,
    loadedByDsh: s.loadedByDsh,
    pluginId: s.pluginId,
  };
}

/* ============================================================
   页面骨架两件套：说明卡（PageHelp）· 空态引导（EmptyGuide）
   ------------------------------------------------------------
   要解决的问题：模块一多，"这页是干什么的、数据从哪来、怎么用、出问题去哪查"
   就散落在各页各写一段 —— 有的写得很足（大模型/凭据/系统状态），有的几乎空白。
   现在统一成一份数据表 + 一个渲染函数，各页只写一行 `pageHelp('xxx')`。
   （功能自检原先也是三件套之一，已按用户要求统一收进「系统状态」页 —— 见 runAllChecks。）

   三条硬约定：
   ① 表的 key 必须是 ROUTES 里的路由 id（写错会静默不显示，tools/page-audit.mjs 有断言）；
   ② 自检（PAGE_CHECKS）一律**只读**：只打查询类端点，不写入、不触发模型动作，
      所以用户可以放心点 —— "功能到底通不通"必须能在页面上一眼看出来；
   ③ 需要造数据的场景写进 EMPTY_GUIDE，给出能直接复制到对话页的提示词。
   ============================================================ */
const PAGE_HELP = {
  home: {
    what: '每天开机的第一眼：当前会话进展、需要你动手的事、最近会话、常用入口。',
    src: '<code>session/control</code>（会话投影：上下文压力、任务、权限）+ <code>session/list</code> + 本机 host（版本/模型）',
    use: [
      '顶部卡看当前会话：模型、智能体预设、工作目录、上下文压力。',
      '「待我处理」里的审批与提问可以**直接处理**，不必进时空智能体页。',
      '「最近会话」点标题进会话页；快捷入口直达对话 / 会话 / 作业 / 交付物。',
      '数字与预期不符时先点右上「刷新」——本页数据有 2–5 秒缓存。',
    ],
    go: ['chat', 'sessions', 'jobs', 'deliverables'],
    tip: '本页所有数字都是**当前会话**的。要换会话用顶栏作用域条切换，或去会话页点「设为当前」。',
  },
  chat: {
    what: '与当前 DSH 会话实时对话的主界面。消息经 WebSocket 推送，支持流式回答、图片/文件附件、斜杠命令、@ 引用文件、提问作答与工具审批。',
    src: '<code>session/follow</code>（实时流）+ <code>session/control</code>（投影）+ <code>session/prompt</code>（发送）',
    use: [
      '输入框直接发指令；输入 <code>/</code> 打开命令菜单，输入 <code>@</code> 引用工作目录文件。',
      '📎 传图片（base64 内联进消息）；📁 传任意文件（先上传换 <code>receiptId</code> 再随消息发送）。',
      '智能体的提问与工具审批会出现在**输入框上方**：直接点选项作答，不用等它把话说完。',
      '📋 侧栏看任务列表 / 消息队列 / 审批，也能在里面直接切模型与智能体预设，不必跳页打断对话。',
      '📈 统计给出「会话统计」与「上下文占用」两张表（轮数 / 用时 / Token / 缓存命中 / 上下文压力）。',
      '会话消息**全量载入**（不再只取最近一段）；要清掉面板显示用命令面板的 <code>/clear</code>。',
    ],
    go: ['sessions', 'trajectory', 'subagents', 'jobs', 'models', 'agentMgr'],
    tip: '当前停在**子代理会话**时（标题旁有「子代理」标签），直接发普通消息可能被子代理能力门控拒绝 —— 请用子代理页的「继续对话 / 插话」，或点「↩ 回父会话」。',
  },
  sessions: {
    what: '会话实体管理页：清单、筛选、排序、树形折叠，以及每个会话的全部管理动作。这是"会话"这个对象的唯一入口。',
    src: '<code>session/list</code>（清单/状态）+ 会话投影（标题、智能体预设、cwd）+ <code>parentSessionId</code>（子代理归属）',
    use: [
      '点表头排序、输入关键字筛选（ID / 标题 / 工作目录）。',
      '「设为当前」决定所有"跟随会话"页面（轨迹 / 交付物 / 作业 / 目标…）看向哪个会话。',
      '「分叉」从该会话当前状态复制出新会话；按轮次分叉请去轨迹页选轮次。',
      '「切模型」改的是该会话自己的绑定；当前会话也可直接在时空智能体侧栏切。',
      '父会话左侧 ▾ 展开它派生的子代理会话。',
    ],
    go: ['chat', 'workspace', 'subagents', 'trajectory'],
    tip: '子代理会话行只保留「设为当前 / 历史 / 导出」：改名、分叉、切模型对子代理通常会被 DSH 拒绝，删掉比留着点了报错更清楚。',
  },
  workspace: {
    what: '上下两区：① **工作空间**（一个目录就是一个空间，空间下挂多个会话）② 当前会话的**工作目录文件树**（可展开目录、可点开预览）。',
    src: '<code>workspace/list</code>（空间与会话归属）+ <code>workspaceFiles/list|read|stat</code>（文件树与预览）',
    use: [
      '当前会话所在的空间会高亮（左缘蓝条 + 描边），同空间的其他会话列在卡内。',
      '文件树点目录展开、点文件名预览；文本按行窗口读取，二进制自动退回"只给元信息"。',
      '预览里的「打开」用宿主默认程序打开真实文件（需部署允许打开路径，见系统状态页）。',
    ],
    go: ['sessions', 'deliverables', 'chat'],
    tip: '会话与空间是**一对多**：一个会话同一时刻最多属于一个空间（<code>insertSessionBefore</code> 是"移动"不是"共享"）；归档后则不属于任何空间。',
  },
  subagents: {
    what: '当前父会话派生的子代理清单与操作：查看历史、继续对话、插话、打断。子代理由模型在回合内自行派发，不是页面上的一个开关。',
    src: '子代理快照通道（<code>kind:\'subagent\'</code>）+ <code>subagents/list</code> / <code>subagents/prompt</code> / <code>subagents/interruptByParent</code>',
    use: [
      '「查看历史」在卡内展开该子代理的消息记录 —— 主通道对子代理返回空，所以这里走的是子代理专用通道。',
      '「继续对话」给空闲子代理追加一条消息；「⚡ 插话」把消息插到最近的步骤边界，会打断当前步。',
      '「打断」终止进行中的回合。',
      '发起子代理要在时空智能体页让模型调用子代理工具（示例见下方空态卡）。',
    ],
    go: ['chat', 'workflow', 'sessions', 'jobs'],
    tip: '发起子代理**不会**抢走当前会话：父会话仍是当前会话，轨迹 / 交付物 / 作业等页面继续按父会话取数。',
  },
  trajectory: {
    what: '事件级时间线：把会话事件流按轮次与步骤铺开（提问、模型回复、工具调用、Code Mode 子调用、附件）。',
    src: '<code>session/follow</code> 记录流 + <code>session/page</code>（向前翻页加载更早）',
    use: [
      '点轮次按钮只看该轮；「加载更早」按 seq 往前补历史，直到会话开头。',
      '选中某轮后可「从这一轮分叉」出新会话（<code>session/fork</code> 的 <code>atSeq</code>，保留该轮之前的上下文）。',
      '时间线里的图片与文件是真实附件，可点开查看。',
    ],
    go: ['sessions', 'deliverables', 'chat'],
    tip: '数据量随会话长度增长：长会话先按轮筛选再看，别一路「加载更早」把几千条一次性铺开。',
  },
  workflow: {
    what: '多代理编排的运行记录：每次工作流运行的阶段、参与的成员代理、各自状态。',
    src: '会话事件流里的 <code>tool-workflow</code> run-start 事件与 <code>agent-start</code> 事件（从事件推导，不是独立接口）',
    use: [
      '看上区统计判断"这次编排跑了没有"；下区按运行展开阶段与成员。',
      '成员带子代理 ID 的，去子代理页看它的历史与继续对话。',
    ],
    go: ['subagents', 'sessions', 'trajectory'],
    tip: '本页是**只读**视图；没有运行记录说明该会话还没用 workflow 工具做过多代理扇出。',
  },
  deliverables: {
    what: '会话产物两路来源：① 本会话里模型**实际写入或修改**过的文件（从工具调用参数提取，不靠模型自述）② 工作目录里最近落盘的文件。',
    src: '会话事件流中 <code>tool/call</code>、<code>tool/code-dispatch</code> 的变更类工具（write / edit / multi_edit / apply_patch…）+ 本机 <code>/api/local/deliverables</code>',
    use: [
      '① 区看"这次会话产出了什么"，带途经（顶层调用 / Code Mode 子调用）、工具名、轮次与 seq。',
      '「下载」取文件；「打开」用宿主程序打开。',
      '② 区是工作目录的快照，完整目录树与预览请去工作空间页。',
    ],
    go: ['workspace', 'trajectory', 'chat'],
    tip: '产物为空**不代表功能坏了** —— 说明本轮还没写文件。让模型显式写盘即可（下方空态卡给了一句话示例）。',
  },
  goal: {
    what: '目标的完整生命周期管理：创建 / 暂停 / 恢复 / 完成 / 清除。目标 = 跨轮次自动推进的长期任务，与"一次性提问"相对。',
    src: '<code>goals/get</code> 读当前目标；<code>goals/create|edit|pause|resume|complete|clear</code> 改状态',
    use: [
      '新建时写**客观、可判定**的目标（例："把 data/ 下所有 CSV 做质检并生成报告"）。',
      '「暂停」后 DSH 不再自动续跑，恢复后继续；「标记完成」结束推进。',
      '「编辑目标」改文案，<code>revision</code> 会递增 —— 页面上直接可见。',
      '相位决定能用哪些操作：<b>active</b>（自动推进）可暂停 / 标记完成；<b>paused / blocked</b> 可恢复；',
      '<b>complete 已完成的目标不可恢复</b>——宿主只接受 active / paused / blocked 三态，要继续推进请清除后新建。',
    ],
    go: ['chat', 'host', 'trajectory'],
    tip: '这一页的按钮**会真实改动**当前会话的目标状态，不是演示。'
      + '页面对"不能做的操作"直接不给按钮、并写明原因（此前对已完成目标也画了「恢复」，点了必报宿主英文错误）。',
  },
  models: {
    what: '模型目录与供应商接入：当前用哪个模型、有哪些候选供应商、哪些**真正可路由**，并能对供应商做一次真实模型探测。',
    src: '<code>session/modelCatalog</code>（目录 + 可路由供应商）+ <code>llm/listConfigurableProviders</code>（候选全量）+ <code>llm/discoverModels</code>（探测）+ 设置里 <code>llm-*</code> 命名空间',
    use: [
      '「当前会话路由」卡是本会话实际生效的模型与推理强度；切换在**时空智能体侧栏**，不在这页。',
      '「📦 可用模型」是部署写在设置里的**静态目录**，决定能选哪些模型。',
      '「🔧 供应商接入」列全部候选通道，并在**同一行**做模型探测：点「探测」拉该通道的最新清单，结果显示在该行下面。',
    ],
    go: ['settings', 'credentials', 'host'],
    tip: '「模型发现」= 向通道**实时拉取**它能提供哪些模型（<code>llm/discoverModels</code>，只读）。'
      + '有的通道没注册这个能力，模型清单改由部署写在设置里 ——'
      + '面板对这种通道标灰「静态清单」而不是标红失败，因为它<b>不是故障</b>：'
      + '"能不能发现"和"能不能用"是两件事。',
  },
  agentMgr: {
    what: '智能体预设（工具与提示词组合）的全局清单：查看配置、复制、删除。',
    src: '<code>agentPresets/list</code>（清单 + <code>authorable</code>）+ <code>agentPresets/read|copy|deletePreset</code>',
    use: [
      '「查看配置」读该智能体预设的完整定义，结果落在本页下方的面板里。',
      '「复制」生成可编辑的用户智能体预设副本；「删除」只对用户智能体预设开放。',
      '某个会话**用哪个智能体预设**是会话级属性，在时空智能体侧栏的智能体预设框里切 —— 本页只管清单。',
    ],
    go: ['chat', 'settings', 'models'],
    tip: '系统智能体预设（<code>trust:\'system\'</code>）随部署发布、只读：不能改名 / 删除 / 在编辑器中打开，要定制请先「复制」。',
  },
  skillMgr: {
    what: 'Skills（技能）清单与加载根目录。技能按作用域分层加载，近层覆盖远层（项目级 > 用户级）。',
    src: '<code>skills/list</code>（按当前会话工作目录解析）+ 本机 <code>/api/local/skills</code>（根目录与存在性）',
    use: [
      '每个技能卡显示它来自哪一层、文件路径与字节数 —— 判断"加载的是我改的那份吗"看路径。',
      '项目级根的基准是**当前会话的工作目录**：换会话就换作用域，页面顶部已标出当前 cwd。',
      '加技能 = 往对应根目录放技能目录（含 SKILL.md），然后刷新本页重扫。',
    ],
    go: ['chat', 'workspace', 'settings'],
    tip: '根目录显示「未创建」是正常的：DSH 不会自动建目录，放进去后才会出现技能。',
  },
  mcp: {
    what: 'MCP（Model Context Protocol）服务清单：配置了哪些服务、能否连上、实际注入了多少工具。',
    src: '本机 <code>/api/local/mcp</code>（配置解析 + TCP 探测 + 握手统计）+ 插件运行时 <code>pluginInventory/list</code>',
    use: [
      '逐项看：服务名、命名空间、传输方式、地址或启动命令、工具数及其来源。',
      '「查看清单」列出该服务注入的工具全名（<code>mcp__&lt;服务名&gt;__&lt;工具名&gt;</code>）。',
      '「🔄 重新握手」重做一次 TCP 探测 + 握手，成功后自动回写 <code>mcp-tools.json</code> 快照。',
    ],
    go: ['plugins', 'host', 'credentials'],
    tip: '新增服务要改 <code>~/.dsh/profiles/web/cordis.patch.yml</code> 并**重启 <code>dsh web</code>**（该 profile 的 HMR 是关闭的），重启后再点「重新握手」。',
  },
  plugins: {
    what: 'Cordis 插件树清单：本部署到底装了哪些插件、来自哪一层、哪些被禁用、哪些属于安全敏感类。',
    src: '<code>dsh --dump-config</code> 实时 dump（失败自动回退 <code>plugins.json</code> 快照）+ <code>pluginInventory/list</code> 运行时状态',
    use: [
      '按分类看分布；表格可筛选（id 或包名关键字）与排序。',
      '「🔄 重新探测」重跑一次 dump-config，成功即回写快照。',
      '下区是运行时清单（fiber 状态），用来区分"配了"与"真的在跑"。',
    ],
    go: ['mcp', 'settings', 'host'],
    tip: '想知道"某个插件到底有没有在跑"看下区的运行时清单；想知道"它是怎么被装配进来的"看表格里的层与来源。',
  },
  credentials: {
    what: '凭据（API Key 等）的**键名**管理：写入、更新、删除，以及"哪个供应商缺 Key 会导致不参与路由"。',
    src: '<code>credentials/describe</code>（按名逐个确认状态）+ 本机 <code>/api/local/credentials</code>（只解析键名，不读值）+ 设置里的 <code>*Env</code> / <code>*Ref</code> 引用',
    use: [
      '分区看：已配置 / 被引用但缺 Key（会影响路由，优先处理）/ 本机孤立键名 / 非用户凭据记录 / 供应商对照表。',
      '「写入 / 更新」按名提交新值；「删除」只对可写凭据开放。',
      '「按名查询」对任意键名核对一次状态，不必先配好再来。',
    ],
    go: ['models', 'settings'],
    tip: '写入会**真实影响** DSH 对外部模型的调用。本页只显示键名，从不显示明文，也从不读取密文。',
  },
  settings: {
    what: 'DSH 全局设置（<code>~/.dsh/settings.yaml</code>）的 schema 驱动表单：14 个命名空间，改完立即生效。',
    src: '<code>settings/describe</code>（命名空间 + schema）+ <code>settings/mutate|update|replace</code>',
    use: [
      '徽标区分「已覆盖 / 默认」：一眼看出哪些被改过。',
      '表单区由 schema 生成控件，提交时**只下发改动过的字段**（增量 ops），不会误覆盖其他值。',
      '高级区可查看原始 schema、整段替换、按路径 ops 修改。',
    ],
    go: ['credentials', 'models', 'agentMgr'],
    tip: '三类命名空间的作用面不同：新会话出厂默认值（**不影响已有会话**）、执行环境参数（影响所有会话）、界面偏好（只影响本控制台）。',
  },
  jobs: {
    what: '四类"异步进行中"的事：后台作业、工具审批、智能体提问、消息队列。',
    src: '<code>session/control</code> 的 jobs / approvals 投影 + 事件流里的提问请求 + <code>session/updateQueue</code>（队列增删改）',
    use: [
      '审批卡直接允许 / 拒绝；提问卡直接选答案或填自定义回答。',
      '默认只看当前会话，「查看全部会话」可切跨会话视图。',
      '消息队列支持插话（steer）、编辑、撤回。',
    ],
    go: ['chat', 'sessions', 'host'],
    tip: '作业由模型侧的 job 工具发起，控制台是**观察者**：这一页不能启动 / 终止作业，终止要走模型侧工具。',
  },
  host: {
    what: '全量数字面板：上区平台健康（与具体会话无关），下区当前会话用量（轮次、步数、上下文占用、Token、权限与限制）。',
    src: '<code>session/modelCatalog</code> + <code>session/control</code> 投影 + 插件 / MCP 清单 + 本机 dsh 版本与构建号',
    use: [
      '开头的「🧪 契约自检」逐项打真实 DSH 接口，失败项直接标红 —— 排查"某个模块没数据"先跑它。',
      '概览永远不折叠、明细一律折叠，方便快速扫读。',
      '下区跟随当前会话：换会话即换数据，页头已标出会话 ID。',
    ],
    go: ['settings', 'plugins', 'mcp', 'jobs'],
    tip: '本页也显示最近的**页面渲染耗时**（见「渲染性能」折叠区），页面卡顿时用它判断是加载慢还是渲染慢。',
  },
};

/* 说明卡折叠状态：记忆在本地，**默认全部收起**。
   18 个模块都默认铺开会把每页首屏挤满；收起时标题行仍显示本页一句话摘要（见 pageHelp），
   信息不至于丢，点一下就能展开全文。 */
const HELP_LS_KEY = 'dshHelpCollapsed';
let _helpCollapsed = null;
function helpCollapsed(id) {
  if (_helpCollapsed === null) {
    _helpCollapsed = {};
    try { _helpCollapsed = JSON.parse(localStorage.getItem(HELP_LS_KEY) || '{}') || {}; } catch { _helpCollapsed = {}; }
  }
  if (_helpCollapsed[id] === undefined) return true;   // 没记过 → 收起
  return !!_helpCollapsed[id];
}
function toggleHelp(id) {
  _helpCollapsed = _helpCollapsed || {};
  // ⚠️ 必须相对**当前生效状态**取反（helpCollapsed 的返回值），不能对"记录值"取反：
  // 默认收起时记录值是 undefined，`!undefined` 也是 true，等于第一次点击反而把它设成"收起"，点了没反应。
  _helpCollapsed[id] = !helpCollapsed(id);
  try { localStorage.setItem(HELP_LS_KEY, JSON.stringify(_helpCollapsed)); } catch {}
  render({ paintOnly: true });
}

/* ---------- 控制台自身的界面偏好 ----------
   这一组**不是 DSH 设置**：DSH 的 settings.* 是服务端配置（写 ~/.dsh/settings.yaml、影响所有会话），
   而这里只是"这个控制台长什么样"，所以落到项目里的 ui-prefs.yaml（服务端 /api/local/prefs 读写）。
   为什么不放 localStorage：那是**浏览器**的存储，换浏览器/清缓存就丢、也没法随项目交付；
   界面偏好描述的是项目本身，理应跟项目在一起。
   写入是异步的（一次 POST），但**读取是同步的**（内存快照 _uiPrefs），
   所以渲染路径里的 uiPref() 不引入 async —— 启动时先 await loadUiPrefs() 再首次 render()。 */
const UI_PREF_LS_KEY = 'dshUiPrefs';        // 旧版本用的浏览器键；只在迁移时读一次
let _uiPrefs = null;
let _uiPrefsFile = '';
function uiPrefs() {
  if (_uiPrefs === null) _uiPrefs = {};
  return _uiPrefs;
}
/** 读一个界面偏好；没记过就用默认值（默认由调用方给，避免"忘了初始化变成关闭"） */
function uiPref(key, def) {
  const v = uiPrefs()[key];
  return v === undefined || v === null ? !!def : !!v;
}
/** 启动时拉一次界面偏好（在首次 render 之前 await 它）。
 *  还会做一次**一次性迁移**：把旧版本留在 localStorage 里的开关搬到新文件，搬完清掉本地键。 */
async function loadUiPrefs() {
  let fromFile = null;
  try {
    const r = await fetch('/api/local/prefs', { cache: 'no-store' });
    const j = await r.json();
    if (j && j.prefs && typeof j.prefs === 'object') { fromFile = j.prefs; _uiPrefsFile = j.file || ''; }
  } catch { /* 服务端读不到就退回默认值，不阻塞启动 */ }
  if (fromFile === null) {                       // 读不到（旧服务端 / 接口挂了）：退回本地值，功能不残
    try { _uiPrefs = JSON.parse(localStorage.getItem(UI_PREF_LS_KEY) || '{}') || {}; } catch { _uiPrefs = {}; }
    return _uiPrefs;
  }
  _uiPrefs = fromFile;
  let legacy = null;
  try { legacy = JSON.parse(localStorage.getItem(UI_PREF_LS_KEY) || 'null'); } catch {}
  if (legacy && typeof legacy === 'object' && Object.keys(legacy).length) {
    const merged = { ...legacy, ...fromFile };   // 文件里已有的键优先（它是更新的真相）
    try { await postUiPrefs(merged); } catch {}
    _uiPrefs = merged;
    try { localStorage.removeItem(UI_PREF_LS_KEY); } catch {}
  }
  return _uiPrefs;
}
/** 写回偏好文件（整体合并写，服务端也是合并语义；失败不抛给调用方，只提示一次） */
async function postUiPrefs(obj) {
  const r = await fetch('/api/local/prefs', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj || {}),
  });
  const j = await r.json();
  if (!j || j.ok !== true) throw new Error((j && j.error) || '写入失败');
  if (j.file) _uiPrefsFile = j.file;
  return j.prefs || obj;
}
function setUiPref(key, val) {
  _uiPrefs = { ...uiPrefs(), [key]: !!val };
  // 先本地生效（渲染不等网络），再把整份快照写回项目文件；失败就提示一次，界面状态仍然是对的
  postUiPrefs(_uiPrefs).catch(e => UI.warn('界面偏好写入项目文件失败：' + e.message));
  render({ paintOnly: true });
}
function toggleUiPref(key, def) { setUiPref(key, !uiPref(key, def)); }

/** 界面偏好的开关行（onchange 走 toggleUiPref，见上面的"只改客户端状态用 paintOnly"铁律） */
function uiPrefRow(key, def, label, hint, onText, offText) {
  const on = uiPref(key, def);
  return '<div class="pref-row">'
    + '<div class="pref-txt"><b>' + fmt.esc(label) + '</b>'
    + (hint ? '<span class="muted">' + hint + '</span>' : '') + '</div>'
    + '<button class="btn sm' + (on ? ' primary' : '') + '" onclick="toggleUiPref(' + fmt.attr(key) + ',' + (def ? 'true' : 'false') + ')"'
    + ' aria-pressed="' + (on ? 'true' : 'false') + '">'
    + (on ? fmt.esc(onText || '显示中') : fmt.esc(offText || '已隐藏')) + '</button>'
    + '</div>';
}

/** 设置页顶部的「控制台界面偏好」卡：只影响本控制台显示，不改 DSH 配置 */
function uiPrefsCard() {
  const shown = uiPref('helpVisible', true);
  return '<div class="card mb">'
    + '<h3>🖥 控制台界面偏好 <span class="tag gray">只影响本控制台</span></h3>'
    + '<div class="muted" style="font-size:11.5px;margin:6px 0 2px">'
    + '这一组与上面的 <code>DSH 设置</code> 无关：它们存在项目文件 '
    + '<code>dsh-console/ui-prefs.yaml</code> 里，不写 <code>~/.dsh/settings.yaml</code>，也不影响任何会话的模型与工具行为。'
    + (stateFileHint() || '') + '</div>'
    + uiPrefRow('helpVisible', true, '显示各页「本页说明」',
      '18 个模块顶部那张说明卡（这页做什么 / 数据从哪来 / 怎么用）。关掉后整页首屏更干净，说明内容仍在 <code>app.js</code> 的 <code>PAGE_HELP</code> 里。',
      '显示中', '已隐藏')
    + '<div class="muted" style="font-size:11px;margin-top:8px">'
    + '当前状态：说明卡' + (shown ? '正在显示' : '<b>已隐藏</b>')
    + '</div></div>';
}
/** 偏好文件在哪（页面上标出来，方便用户直接去改 / 删） */
function stateFileHint() {
  return _uiPrefsFile ? ' · 当前文件：<code title="' + fmt.h(_uiPrefsFile) + '">' + fmt.esc(_uiPrefsFile) + '</code>' : '';
}

/** 本页说明卡：这页做什么 / 数据从哪来 / 怎么用 / 相关页去哪。
 *  内容全部来自 PAGE_HELP（允许内联 <code> 等标签，是本文件里的静态文案，不含用户数据）。 */
function pageHelp(id) {
  // 设置页里的「显示本页说明」关掉之后，18 个模块的说明卡一起消失（默认显示）
  if (!uiPref('helpVisible', true)) return '';
  const h = PAGE_HELP[id];
  if (!h) return '';
  const col = helpCollapsed(id);
  const r0 = ROUTES.find(x => x.id === id) || {};
  // 收起时标题行显示本页"一句话定位"（what 去掉标签）；展开时才显示栏目导读。
  // 默认收起之后这一行就是唯一的常驻说明，不能只写一句没有信息量的栏目名。
  const brief = String(h.what || '').replace(/<[^>]+>/g, '');
  const chips = (h.go || []).map(gid => {
    const r = ROUTES.find(x => x.id === gid);
    return r ? '<a class="pg-chip" href="#' + r.path + '" title="' + fmt.esc(r.label + ' · ' + (GROUP_HINT[r.group] || '')) + '">'
      + r.ico + ' ' + fmt.esc(r.label) + '</a>' : '';
  }).join('');
  return '<div class="pguide' + (col ? ' col' : '') + '" id="pguide">'
    + '<div class="pg-head" onclick="toggleHelp(' + fmt.attr(id) + ')">'
    + '<span>ℹ️</span><b>本页说明</b>'
    + '<span class="pg-sub" title="' + fmt.esc(brief) + '">'
    + (col ? fmt.esc(brief) : fmt.esc((r0.label || '') + ' · 这页做什么 / 数据从哪来 / 怎么用 / 去哪'))
    + '</span>'
    + '<span class="pg-tg">' + (col ? '展开 ▸' : '收起 ▾') + '</span></div>'
    + (col ? '' : '<div class="pg-body">'
      + '<div class="pg-grid">'
      + '<div><div class="pg-k">这页做什么</div><div class="pg-v">' + h.what + '</div></div>'
      + '<div><div class="pg-k">数据从哪来</div><div class="pg-v mono" style="font-size:11.5px">' + h.src + '</div></div>'
      + '<div><div class="pg-k">怎么用</div><ol class="pg-use">' + (h.use || []).map(u => '<li>' + u + '</li>').join('') + '</ol></div>'
      + '</div>'
      + (chips ? '<div class="pg-go"><span class="muted">相关页：</span>' + chips + '</div>' : '')
      + (h.tip ? '<div class="pg-tip">⚠️ ' + h.tip + '</div>' : '')
      + '</div>')
    + '</div>';
}

/* ---------- 空态引导：把"怎么造出数据"写成可照做的步骤 + 可复制提示词 ---------- */
const EMPTY_GUIDE = {
  subagents: {
    title: '怎么让这里出现子代理',
    steps: [
      '子代理由模型在回合内派发，页面不提供"新建子代理"按钮。',
      '在时空智能体页发一句能让模型判断"可并行 / 可独立"的任务，它就会开子代理。',
    ],
    prompt: '请并行开两个子代理：一个统计当前工作目录的文件数量与总体积，另一个总结 README 的要点；两边都完成后把结论汇总给我。',
  },
  workflow: {
    title: '怎么让这里出现工作流运行',
    steps: [
      '工作流 = 模型用 workflow 工具做多代理编排，运行记录由事件流推导。',
      '让它显式"分阶段 + 每阶段派代理"，才会产生阶段与成员记录。',
    ],
    prompt: '用 workflow 工具把任务拆成两个阶段：第一阶段派一个代理调研当前目录结构，第二阶段派一个代理基于结果写一份摘要，最后把两阶段结论合并给我。',
  },
  deliverables: {
    title: '怎么让这里出现产物',
    steps: [
      '① 区只认"模型真的写了文件"，所以要让它在对话里显式要求写盘。',
      '② 区是工作目录最近落盘的文件，先选一个真实工作目录（会话 cwd）再看。',
    ],
    prompt: '请在当前工作目录写入 out/产物体检.md，内容包括：当前时间、目录里的文件数量、以及一句话结论。',
  },
  goal: {
    title: '怎么用目标',
    steps: [
      '目标是跨轮次自动推进的长期任务：一轮没做完，DSH 会按需继续。',
      '写"客观、可判定"的目标，别写"优化一下"这种没有终点的表述。',
    ],
    prompt: '把"检查当前目录所有 .md 文档的错别字并输出一份报告"设为一个目标，跨轮次自动推进直到完成为止。',
  },
  jobs: {
    title: '怎么让这里出现作业',
    steps: [
      '作业由模型侧的 job 工具发起（控制台只观察）。',
      '让它"后台跑一段耗时命令"即可产生作业记录。',
    ],
    prompt: '请用后台作业的方式统计当前目录下所有文件的大小并排序，跑完把前 20 行结果给我。',
  },
  trajectory: {
    title: '怎么让轨迹有内容',
    steps: [
      '轨迹就是会话事件流：只要在时空智能体页发过消息、调用过工具，这里就有节点。',
      '想看到丰富的步骤，就让模型多用几次工具（读文件、列目录、写文件）。',
    ],
    prompt: '先读 README，再列出当前目录结构，然后写一个 summary.md 总结前两步，最后把结果告诉我。',
  },
  skillMgr: {
    title: '怎么让技能出现在这里',
    steps: [
      '技能靠目录约定加载，不靠对话创建：把技能目录（含 SKILL.md）放进下面列出的某个根目录。',
      '项目级根的基准是**当前会话的工作目录**；放好后刷新本页即会重扫。',
    ],
  },
  mcp: {
    title: '怎么新增一个 MCP 服务',
    steps: [
      '编辑 <code>~/.dsh/profiles/web/cordis.patch.yml</code>，为该服务加一个插件实例（每个服务一个实例）。',
      '重启 <code>dsh web</code>（该 profile 的 HMR 已关闭），回到本页点「🔄 重新握手」。',
    ],
    prompt: '（无需对话）配置文件片段，加到 ~/.dsh/profiles/web/cordis.patch.yml：\nplugins:\n  "@deepseek-ai/dsh-mcp-client":\n    servers:\n      - name: filesystem\n        transport: stdio\n        command: npx\n        args: ["-y", "@modelcontextprotocol/server-filesystem", "C:/data"]',
  },
};
/** 空态引导卡（可折叠）：把"造数据"的操作写清楚，并给一句可直接发送的提示词 */
function emptyGuide(id) {
  const g = EMPTY_GUIDE[id];
  if (!g) return '';
  return '<details class="fold mt"><summary>💡 ' + g.title + '</summary><div class="fold-body">'
    + '<ol class="pg-use">' + (g.steps || []).map(s => '<li>' + s + '</li>').join('') + '</ol>'
    + (g.prompt ? '<div class="pg-k" style="margin-top:8px">可复制的一句话示例</div>'
      + '<div class="pg-prompt"><button class="btn sm" onclick="copyText(' + fmt.attr(g.prompt) + ')">复制</button>'
      + '<pre>' + fmt.esc(g.prompt) + '</pre></div>' : '')
    + '</div></details>';
}

/* ---------- 功能自检数据（统一收在「系统状态」页执行，这里只是各模块的检查项清单）----------
   为什么要有它：模块变多之后，"这页到底通不通"没有别的办法判断 ——
   空白的页面可能是"本来就没数据"，也可能是"接口坏了"。自检把这件事做成一次点击：
   逐项打该页真正依赖的端点，标出通过 / 失败 / 提示，附耗时与详情。

   设计约束：
   · **只读**：只调用查询类端点（list / get / describe / 快照），绝不写入、不触发模型动作 ——
     所以用户点它永远是安全的，这也是它敢放在每页右上角的原因；
   · `opt:true` 的项失败只算「提示」不算故障（例如某个能力依赖外部服务、或当前确实没数据）；
   · 前置两项（认证 + 当前会话）所有页面共用，避免"其实连不上 DSH"时逐页去猜。 */
const PRE_CHECKS = () => [
  { name: '控制台 → DSH 认证', fn: async () => {
      const st = await (await fetch('/api/local/dsh', { cache: 'no-store' })).json();
      if (st.state !== 'ok') throw new Error(st.error || st.detail || st.state);
      return st;
    }, want: st => st.origin + ' · 令牌 ' + (st.tokenHint || '—') + ' · ' + (st.dshVersion || '—') },
  { name: '当前会话有效', fn: async () => {
      if (!State.sessionId) throw new Error('没有当前会话：会话列表为空或还没加载完');
      const s = (State.sessions || []).find(x => x.sessionId === State.sessionId);
      if (!s) throw new Error('当前会话不在会话列表里：' + State.sessionId);
      return s;
    }, want: s => (s.projections?.values?.title || '（未命名）')
      + (isSubagentSession(s) ? ' · ⚠️ 这是子代理会话，跟随会话的页面可能取不到数据（父 ' + (s.parentSessionId || '—').slice(0, 12) + '…）' : '') },
];

const PAGE_CHECKS = {
  home: [
    { name: 'session/control 投影基线', fn: () => Mux.snapshot('session/control').then(b => ({ b })),
      want: r => Object.keys(r.b?.projections || {}).length + ' 个会话有投影 · 作业 ' + Object.keys(r.b?.jobs || {}).length + ' 组' },
    { name: '会话列表 session/list', fn: () => API.call('session.list'),
      want: v => (v.items || []).length + ' 个会话（运行中 ' + (v.items || []).filter(x => x.running).length + ' 个）' },
    { name: '本机概要 /api/local/dsh', fn: () => fetch('/api/local/dsh', { cache: 'no-store' }).then(r => r.json()),
      want: v => '版本 ' + (v.dshVersion || '—') + ' · 状态 ' + v.state },
  ],
  chat: [
    { name: '实时流连接（WebSocket）', fn: async () => { if (!State.wsOk) throw new Error('实时流未连接：发送消息会失败，先看顶栏状态或重启 dsh web'); return true; },
      want: () => '已连接' },
    { name: '斜杠命令 commands/list', fn: () => API.call('commands/list', { args: { agentId: State.sessionId } }),
      want: v => (v || []).length + ' 条：' + (v || []).slice(0, 6).map(c => '/' + c.name).join(' ') },
    { name: '@ 引用候选 fileReferences/list', fn: () => API.call('fileReferences/list', { args: { agentId: State.sessionId, query: '' } }),
      want: v => (v || []).length + ' 个候选' },
    { name: '消息反馈 messageFeedback/list', fn: () => API.call('messageFeedback/list', { args: { request: { sessionId: State.sessionId } } }),
      want: v => ((v.value && v.value.items) || []).length + ' 条反馈', opt: true },
    { name: '历史消息可回填 session/follow', fn: () => Mux.snapshot({ kind: 'session', sessionId: State.sessionId }),
      want: s => (s.records || []).length + ' 条记录 · hasMore=' + (s.hasMore ? '是' : '否') },
  ],
  sessions: [
    { name: '会话清单 session/list', fn: () => API.call('session.list'),
      want: v => (v.items || []).length + ' 个（子代理会话 ' + (v.items || []).filter(isSubagentSession).length + ' 个）',
    },
    { name: '模型目录 session/modelCatalog', fn: () => API.call('session.models'),
      want: v => (v.groups || []).length + ' 组 · 当前 ' + (v.current?.model || '—') },
    { name: '服务端检索 session/search', fn: () => API.call('session.search', { query: 'a' }),
      want: v => (Array.isArray(v) ? v.length : (v.items || []).length) + ' 条命中', opt: true },
  ],
  workspace: [
    { name: '工作空间 workspace/follow 基线', fn: () => API.workspaces(),
      want: v => (v.items || []).length + ' 个空间 · 归档 ' + (v.archivedSessionIds || []).length + ' 个会话' },
    { name: '工作区文件树 workspaceFiles/list', fn: async () => {
        const cwd = currentSession().cwd;
        if (!cwd) throw new Error('当前会话没有工作目录（cwd），文件树无从解析');
        return API.call('files.list', { path: cwd });
      }, want: v => (v.entries || []).length + ' 个条目 · ' + fmt.mid(v.path || '', 60) },
    { name: '目录选择器 directoryPicker/list', fn: () => API.call('dir.list', { path: '' }),
      want: v => (v.entries || []).length + ' 个条目', opt: true },
  ],
  subagents: [
    { name: '子代理清单 subagents/list', fn: () => API.call('subagent.list', { parentSessionId: State.sessionId }),
      want: v => (v.entries || []).length + ' 个子代理（0 个属正常，见本页空态引导）' },
    { name: '父会话可用（清单非空的前提）', fn: async () => {
        const r = await API.call('subagent.list', { parentSessionId: State.sessionId });
        if (r.parentAvailable === false) throw new Error('DSH 报告父会话不可用：当前会话可能已结束');
        return r;
      }, want: () => '父会话可查询' },
    { name: '子代理快照通道（历史用）', fn: () => Mux.snapshot({ kind: 'subagent', parentSessionId: State.sessionId }).then(r => ({ r })),
      want: r => '通道可用 · 快照键 ' + Object.keys(r.r || {}).slice(0, 4).join('/'), opt: true },
  ],
  trajectory: [
    { name: '会话事件流 session/follow', fn: () => Mux.snapshot({ kind: 'session', sessionId: State.sessionId }),
      want: s => (s.records || []).length + ' 条记录 · cursor ' + (s.cursor != null ? '有' : '无') },
    { name: '数据可被解析（轨迹节点）', fn: () => API.history(State.sessionId, true).then(h => ({ n: (h.events || []).length, more: h.hasMore })),
      want: v => v.n + ' 条事件' + (v.more ? '（还有更早的，可「加载更早」）' : '（已到开头）') },
  ],
  workflow: [
    { name: '编排事件可读（tool-workflow）', fn: async () => {
        const h = await API.history(State.sessionId, true);
        const ev = (h.events || []).filter(x => String(x.event?.type || '').includes('workflow'));
        return { n: ev.length };
      }, want: v => v.n + ' 条编排事件（0 条属正常，见空态引导）' },
    { name: '成员来源 subagents/list', fn: () => API.call('subagent.list', { parentSessionId: State.sessionId }),
      want: v => (v.entries || []).length + ' 个子代理' },
  ],
  deliverables: [
    { name: '会话事件流（来源①）', fn: () => API.history(State.sessionId, true).then(h => ({ n: (h.events || []).length })),
      want: v => v.n + ' 条事件可解析（变更类工具从这里提取）' },
    { name: '工作目录扫描（来源②）', fn: async () => {
        const cwd = currentSession().cwd;
        if (!cwd) throw new Error('当前会话没有工作目录（cwd）');
        const r = await (await fetch('/api/local/deliverables?limit=20&cwd=' + encodeURIComponent(cwd))).json();
        if (r.error) throw new Error(r.error);
        return r;
      }, want: r => (r.items || []).length + ' 个文件 / 扫描 ' + (r.scanned || 0) },
    { name: '打开文件能力 session/canOpenWorkspacePath', fn: () => API.call('host.canOpenPath'),
      want: v => v ? '支持（产物可「打开」）' : '不支持（只提供下载）', opt: true },
  ],
  goal: [
    { name: 'goals/get 读当前目标', fn: () => API.call('goal.get', { sessionId: State.sessionId }),
      want: v => (v && v.goal) ? ('有目标 · phase=' + v.goal.phase) : '无活跃目标（正常，可在本页新建）' },
    { name: '当前会话可写（目标归属）', fn: async () => {
        const s = (State.sessions || []).find(x => x.sessionId === State.sessionId);
        if (!s) throw new Error('当前会话不在列表里');
        if (isSubagentSession(s)) throw new Error('子代理会话不能作为目标载体，请先「回父会话」');
        return s;
      }, want: () => '可以创建 / 修改目标' },
    { name: '目标事件可读（推进记录）', fn: () => API.history(State.sessionId, true).then(h => ({ n: (h.events || []).filter(x => String(x.event?.type || '').includes('goal')).length })),
      want: v => v.n + ' 条目标相关事件', opt: true },
  ],
  models: [
    // 用 API.post 直连端点：少一层 MAP 间接，与 tools/page-audit.mjs 的实测路径一致
    { name: '模型目录 session/modelCatalog', fn: () => API.post('session/modelCatalog', {}),
      want: v => (v.groups || []).length + ' 组 · 可路由供应商 ' + (v.routableProviders || []).length },
    { name: '候选供应商 llm/listConfigurableProviders', fn: () => API.call('llm.providers'),
      want: v => (v.providers || []).length + ' 个候选 · 已激活 ' + (v.providers || []).filter(p => p.active).length },
    { name: '模型探测 llm/discoverModels（抽样候选）', opt: true, fn: async () => {
        const ps = State.providers || [];
        if (!ps.length) throw new Error('供应商清单还没加载出来，先在下方「供应商接入」区刷新一次');
        // 抽 3 个：当前可路由的、静态清单大户 openrouter、以及 llm-deepseek（用来显示"通道未注册发现"这个已知结论）。
        // 只看 1 个供应商容易误判 —— 本机 llm-deepseek 恰好是唯一没注册发现的通道。
        const picks = [...new Map([ps.find(p => p.active), ps.find(p => /openrouter/i.test(p.provider)), ps.find(p => p.settingsNs === 'llm-deepseek')]
          .filter(Boolean).map(p => [p.provider, p])).values()].slice(0, 3);
        let okN = 0, models = 0; const notes = [];
        for (const p of picks) {
          try {
            const v = await API.call('llm.discoverModels', { settingsNs: p.settingsNs, provider: p.provider });
            const c = Array.isArray(v) ? v.length : ((v && v.models) || []).length;
            okN++; models += c; notes.push(p.provider + '→' + c + ' 个');
          } catch (e) {
            notes.push(p.provider + '→' + discErrKind(e.message) + '（' + discErrText(e.message).slice(0, 18) + '…）');
          }
        }
        if (!okN) throw new Error('抽样 ' + picks.length + ' 个供应商都没能返回模型清单：' + notes.join('；'));
        return { okN, total: picks.length, models, notes };
      }, want: v => v.okN + '/' + v.total + ' 条通道可发现 · 共 ' + v.models + ' 个模型 —— ' + v.notes.join('；') },
  ],
  agentMgr: [
    { name: '智能体预设清单 agentPresets/list', fn: () => API.call('agentPreset.list'),
      want: v => (v.presets || []).length + ' 个智能体预设 · 可编辑 ' + ((v.authorable || []).length || (v.presets || []).filter(p => p.trust === 'user').length) + ' 个' },
    { name: '智能体预设读取 agentPresets/read', fn: async () => {
        const r = await API.call('agentPreset.list');
        const p = (r.presets || [])[0];
        if (!p) throw new Error('部署里一个智能体预设都没有');
        const d = await API.call('agentPreset.read', { agentPreset: p.id });
        return { id: p.id, n: Object.keys(d || {}).length };
      }, want: v => '读到 ' + v.id + '（' + v.n + ' 个字段）' },
    { name: '系统智能体预设只读（预期报 read-only）', opt: true, fn: async () => {
        const r = await API.call('agentPreset.list');
        const sys = (r.presets || []).find(p => p.trust !== 'user');
        if (!sys) return { msg: '本部署没有系统智能体预设，跳过' };
        try { await API.call('agentPreset.openDocument', { agentPreset: sys.id }); return { msg: '居然能打开系统智能体预设目录（预期被拒）' }; }
        catch (e) { return { msg: '已被正确拒绝：' + String(e.message).slice(0, 60) }; }
      }, want: v => v.msg },
  ],
  skillMgr: [
    { name: '技能清单 skills/list', fn: () => API.call('skill.list', { sessionId: State.sessionId }),
      want: v => (v.skills || []).length + ' 个技能' },
    { name: '技能根目录（本机扫描）', fn: async () => {
        const cwd = currentSession().cwd || '';
        const r = await (await fetch('/api/local/skills' + (cwd ? '?cwd=' + encodeURIComponent(cwd) : ''))).json();
        if (r.error) throw new Error(r.error);
        return r;
      }, want: r => (r.roots || []).length + ' 个根 · 已存在 ' + (r.roots || []).filter(x => x.exists).length + ' 个' },
  ],
  mcp: [
    { name: 'MCP 配置解析 + 探测（本机）', fn: () => fetch('/api/local/mcp').then(r => r.json()),
      want: m => (m.servers || []).length + ' 个服务 · 已连接 ' + (m.servers || []).filter(s => s.status === 'connected').length },
    { name: 'MCP 插件运行时 pluginInventory/list', fn: () => API.call('pluginInventory/list', { args: {} }),
      want: v => (v.entries || []).filter(e => /mcp/i.test(e.id || e.package || '')).length + ' 个 MCP 插件实例', opt: true },
  ],
  plugins: [
    { name: '插件树实时 dump（dsh --dump-config）', fn: async () => {
        const p = await (await fetch('/api/local/plugins?refresh=1')).json();
        if (p.source !== 'dump-config') throw new Error('回退到快照：' + String(p.error || '').slice(0, 120));
        return p;
      }, want: p => (p.plugins || []).length + ' 个插件 · ' + Object.keys(p.layers || {}).length + ' 层 · 执行方式 ' + (p.via || '—') },
    { name: '插件运行时 pluginInventory/list', fn: () => API.call('pluginInventory/list', { args: {} }),
      want: v => (v.entries || []).length + ' 条（活动 ' + (v.entries || []).filter(e => e.fiberPhase === 'active').length + '）' },
  ],
  credentials: [
    { name: '本机凭据文件键名（只读键名）', fn: () => API.localCredentials(),
      want: v => '文件' + (v.exists ? '存在' : '不存在') + ' · refs ' + (v.refs || []).length + ' 个 · records ' + (v.records || []).length + ' 个' },
    { name: 'DSH 按名确认 credentials/describe', fn: async () => {
        const refs = Object.keys(settingCredRefs(State.settings) || {});
        if (!refs.length) throw new Error('设置里没有任何 *Env/*Ref 引用，没有可确认的键名（可先在大模型页接入供应商）');
        const d = await API.call('credentials.describe', { refs: refs.slice(0, 8) });
        const n = Object.keys((d && d.credentials) || d || {}).length;
        return { n, total: refs.length };
      }, want: v => '查询 ' + v.total + ' 个引用名（本次取 ' + v.n + ' 条状态）' },
    { name: '供应商 ↔ 期望凭据对照', fn: () => API.call('llm.providers'),
      want: v => (v.providers || []).length + ' 个候选供应商参与对照' },
  ],
  settings: [
    { name: '设置 schema settings/describe', fn: () => API.call('settings.describe'),
      want: v => (v.namespaces || []).length + ' 个命名空间 · 可写=' + (v.writable ? '是' : '否') },
    { name: '用户文档状态（~/.dsh/settings.yaml）', fn: () => API.call('settings.describe').then(v => ({ has: v.hasDocument, w: v.writable })),
      want: v => (v.has ? '已有用户文档' : '尚无用户文档（全用默认值）') + ' · ' + (v.w ? '可写' : '只读') },
    { name: '字段级改动可下发（ops 通道存在）', fn: async () => {
        const v = await API.call('settings.describe');
        const ns = (v.namespaces || []).find(n => Number.isFinite(n.revision));
        if (!ns) throw new Error('没有带 revision 的命名空间');
        return ns;
      }, want: ns => '如 ' + ns.ns + ' · revision ' + ns.revision },
  ],
  jobs: [
    { name: '作业与审批投影 session/control', fn: () => Mux.snapshot('session/control').then(b => ({ b })),
      want: r => Object.keys(r.b?.jobs || {}).length + ' 组作业 · 审批 ' + Object.keys(r.b?.approvals || {}).length + ' 组' },
    { name: '当前会话作业缓存', fn: async () => ({ n: currentJobs().length, ready: State.jobsReady }),
      want: v => v.n + ' 个作业（本会话）' + (v.ready ? ' · 已同步' : ' · 等推送，稍后刷新') },
    { name: '消息队列 session/updateQueue 通道', fn: async () => ({ n: currentQueue().length }),
      want: v => v.n + ' 条队列消息（0 条正常）', opt: true },
  ],
  host: [
    // ⚠️ 这里必须是 API.host()：API.MAP 里没有 'host' 这个旧方法名，
    //   写成 API.call('host') 会被当作端点名直发 POST /api/host，拿到 console 的 404 "not found"。
    { name: '本机 dsh 版本与构建号', fn: () => API.host(),
      want: v => '版本 ' + (v.version || '—') + (v.rev ? ' · rev ' + v.rev : '') + ' · 模型 ' + (v.model || '—') },
    { name: '会话用量投影 sessionStats', fn: async () => {
        const s = currentSession();
        const st = s.projections?.values?.sessionStats;
        if (!st) throw new Error('当前会话还没有 sessionStats 投影（会话未运行过）');
        return st;
      }, want: st => '轮次 ' + (st.turns ?? '—') + ' · 步数 ' + (st.steps ?? '—') },
    { name: '插件 / MCP / 智能体预设副数据源', fn: () => Promise.all([
        API.call('pluginInventory/list', { args: {} }),
        fetch('/api/local/mcp').then(r => r.json()),
        API.call('agentPreset.list'),
      ]).then(([p, m, a]) => ({ p: (p.entries || []).length, m: (m.servers || []).length, a: (a.presets || []).length })),
      want: v => '插件运行时 ' + v.p + ' · MCP ' + v.m + ' · 智能体预设 ' + v.a },
  ],
};

/* ---------- 全模块功能自检（统一收在「系统状态」页）----------
 *  为什么收拢：每个模块各挂一颗「功能自检」时，检查内容大量重复（认证 / 当前会话 / 清单类端点…），
 *  用户真正要回答的问题是"现在哪些功能是好的"，而不是"这一页好不好" —— 统一在系统状态页
 *  一次跑完所有模块、按模块分组出结果；**有失败时顶部直接列出受影响的功能模块**。
 *  设计约束（沿袭逐页版）：
 *  · **只读**：只调查询类端点，绝不写入、不触发模型动作；
 *  · `opt:true` 的项失败只算「提示」不算故障；
 *  · 每个模块可单独「重跑」，不必整套重来。 */
/** 把自检的原始错误翻译成"下一步该干什么"。
 *  自检的价值在于可操作：只说"超时"用户没法判断是自己环境的问题还是控制台的问题。 */
function checkHint(msg) {
  const m = String(msg || '');
  if (/快照超时/.test(m)) {
    return State.wsOk
      ? '。实时流已连接，但这条通道 12 秒没回开屏帧：先重跑一次自检（实测正常应在百毫秒内回 baseline）；仍失败才说明该宿主不提供此通道，此时看本页其他检查项的结论'
      : '。实时流当前未连接（顶栏徽标为灰）：点顶栏状态或刷新页面重连，未连接时发送消息同样会失败';
  }
  if (/超时/.test(m)) return '。多为网关或宿主响应慢，可直接重跑一次自检';
  if (/\b404\b|not found|unknown method|ENOENT_METHOD/i.test(m)) return '。端点不存在：本机 dsh 版本与控制台期望的接口对不上，去「系统状态」页核对版本';
  if (/\b401\b|\b403\b|unauthor/i.test(m)) return '。认证失败：控制台 → DSH 的令牌无效或已过期，去「系统状态」页看认证卡片';
  if (/Failed to fetch|NetworkError|ECONNREFUSED/i.test(m)) return '。连不上控制台自身的后端：确认 dsh-console 服务还在跑';
  return '';
}

/** 跑一条检查项（失败重试一次：长连接/网关偶发抖动不该让用户看到红行，自检报告要可信） */
async function runOneCheck(c) {
  const t0 = Date.now();
  let rec = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const v = await c.fn();
      rec = { name: c.name, ok: true, opt: !!c.opt, ms: Date.now() - t0, detail: c.want ? String(c.want(v)) : '' };
      break;
    } catch (e) {
      const raw = String((e && e.message) || e).slice(0, 220);
      rec = { name: c.name, ok: false, opt: !!c.opt, ms: Date.now() - t0, detail: raw + checkHint(raw) };
      if (attempt === 0) await new Promise(r => setTimeout(r, 400));
    }
  }
  return rec;
}

/** 模块清单：PAGE_CHECKS 的键就是模块（route id），label 从 ROUTES 取 */
function checkModules() {
  return Object.keys(PAGE_CHECKS).map(id => {
    const r = ROUTES.find(x => x.id === id);
    return { id, label: (r ? r.ico + ' ' + r.label : id), items: PAGE_CHECKS[id] || [] };
  });
}

/** 逐项统计：{ all, bad, hint, badRows } */
function checkRowsStat(rows) {
  return {
    all: rows.length,
    bad: rows.filter(r => !r.ok && !r.opt).length,
    hint: rows.filter(r => !r.ok && r.opt).length,
    badRows: rows.filter(r => !r.ok && !r.opt),
  };
}

/** 跑**全部模块**的自检：先跑两项基础设施（认证 + 当前会话，所有模块共用），再逐模块跑。
 *  基础设施失败 → 所有模块都标受影响（它们依赖同一前提），且不再空跑后续模块。 */
async function runAllChecks() {
  if (State.allCheck && State.allCheck.running) return;   // 防重入
  const mods = checkModules();
  State.allCheck = { at: Date.now(), running: true, base: null, mods: {}, cur: '基础', total: mods.length + 1 };
  repaintAllCheck();
  const baseRows = [];
  for (const c of PRE_CHECKS()) { baseRows.push(await runOneCheck(c)); State.allCheck.base = { rows: baseRows.slice() }; repaintAllCheck(); }
  const baseBad = checkRowsStat(baseRows).bad;
  State.allCheck.base = { rows: baseRows, bad: baseBad };
  if (baseBad) {   // 认证/会话坏了，后面全是无效重复，直接停（省 20+ 个注定失败的请求）
    State.allCheck.running = false;
    State.allCheck.stopped = '基础设施失败，后续模块未执行';
    repaintAllCheck();
    UI.err('基础设施自检失败（' + baseBad + ' 项），所有模块都受影响 —— 修好认证 / 会话后再跑');
    return;
  }
  for (let i = 0; i < mods.length; i++) {
    const m = mods[i];
    State.allCheck.cur = m.label;
    const rows = [];
    for (const c of m.items) { rows.push(await runOneCheck(c)); State.allCheck.mods[m.id] = { label: m.label, rows: rows.slice() }; repaintAllCheck(); }
    State.allCheck.mods[m.id] = { label: m.label, rows };
    repaintAllCheck();
  }
  State.allCheck.running = false;
  repaintAllCheck();
  const bad = Object.values(State.allCheck.mods).reduce((a, m) => a + checkRowsStat(m.rows).bad, 0);
  const hint = Object.values(State.allCheck.mods).reduce((a, m) => a + checkRowsStat(m.rows).hint, 0);
  if (bad) UI.err('全模块自检：' + bad + ' 项失败，受影响模块见红行' + (hint ? '（另有 ' + hint + ' 项提示，不影响使用）' : ''));
  else UI.ok('全模块自检通过：' + mods.length + ' 个模块' + (hint ? '（' + hint + ' 项提示，不影响使用）' : ''));
}

/** 只重跑一个模块（结果卡里每行的「重跑」） */
async function runModuleCheck(id) {
  const m = checkModules().find(x => x.id === id);
  if (!m) return;
  if (State.allCheck && State.allCheck.running) return;
  State.allCheck = State.allCheck || { at: Date.now(), running: false, base: null, mods: {}, total: 1 };
  State.allCheck.mods[id] = { label: m.label, running: true, rows: State.allCheck.mods[id]?.rows || [] };
  repaintAllCheck();
  const rows = [];
  for (const c of m.items) { rows.push(await runOneCheck(c)); State.allCheck.mods[id] = { label: m.label, rows: rows.slice() }; repaintAllCheck(); }
  State.allCheck.mods[id] = { label: m.label, rows };
  State.allCheck.at = Date.now();
  repaintAllCheck();
}

/** 关闭全模块自检结果卡（下次点「全模块自检」会整套重跑） */
function closeAllCheck() {
  State.allCheck = null;
  const holder = document.getElementById('allcheckcard');
  if (holder) holder.remove();
}

/** 全模块自检结果卡：结论徽标 + 受影响模块横幅 + 按模块分组的结果表。
 *  没跑过不显示（避免占地方）；跑的过程中也能看进度，随时可关（后台照常结束）。 */
function allCheckCard() {
  const c = State.allCheck;
  if (!c) return '';
  const stat = m => checkRowsStat((m && m.rows) || []);
  const modList = Object.entries(c.mods || {});
  const totalBad = (c.base && c.base.bad ? c.base.bad : 0)
    + modList.reduce((a, [, m]) => a + stat(m).bad, 0);
  const totalHint = modList.reduce((a, [, m]) => a + stat(m).hint, 0);
  const doneN = (c.base ? 1 : 0) + modList.filter(([, m]) => !m.running).length;
  const badge = c.running
    ? '<span class="tag gray">进行中…（' + fmt.esc(c.cur || '') + ' · ' + doneN + '/' + c.total + '）</span>'
    : totalBad ? '<span class="tag err">' + totalBad + ' 项失败</span>'
    : '<span class="tag ok">全部通过</span>' + (totalHint ? ' <span class="tag warn">' + totalHint + ' 项提示</span>' : '');
  // 受影响模块横幅：基础设施失败=全部模块；否则列出有失败项的模块
  let affected = '';
  if (!c.running && totalBad) {
    const names = (c.base && c.base.bad)
      ? ['全部模块（基础设施失败）']
      : modList.filter(([, m]) => stat(m).bad).map(([id, m]) => m.label + '（' + stat(m).bad + '）');
    affected = '<div class="alert err" style="margin:8px 0">⚠️ 受影响功能模块：<b>' + names.map(fmt.esc).join('、')
      + '</b>' + (c.stopped ? '<div class="muted" style="font-size:11px;margin-top:4px">' + fmt.esc(c.stopped) + '</div>' : '') + '</div>';
  }
  const rowsHtml = (title, rows, id) => {
    const st = checkRowsStat(rows);
    return '<tr>'
      + '<td style="white-space:nowrap"><b>' + fmt.esc(title) + '</b></td>'
      + '<td style="white-space:nowrap">' + st.all + ' 项 · '
        + (st.bad ? '<span class="tag err">' + st.bad + ' 失败</span> ' : '<span class="tag ok">通过</span> ')
        + (st.hint ? '<span class="tag warn">' + st.hint + ' 提示</span>' : '') + '</td>'
      + '<td class="muted mono" style="font-size:11px"><span class="ellip w400" title="'
        + fmt.esc(st.badRows.map(r => r.name + ' → ' + r.detail).join('\n') || '—') + '">'
        + fmt.esc(st.badRows.map(r => r.name).join('、') || '—') + '</span></td>'
      + '<td style="white-space:nowrap"><button class="btn sm" onclick="runModuleCheck(' + fmt.attr(id) + ')"'
        + (c.running ? ' disabled' : '') + ' title="只重跑这一个模块的检查项">重跑</button></td>'
      + '</tr>';
  };
  return '<div class="card mb" id="allcheckcard">'
    + '<h3>🧪 全模块自检 ' + badge
    + '<span class="muted" style="font-size:11px;font-weight:400;margin-left:auto">'
    + new Date(c.at).toLocaleTimeString('zh-CN', { hour12: false }) + '</span>'
    // 关闭入口：进行中也能关（关的只是显示，自检流程在后台照常结束）
    + '<button class="btn sm" style="margin-left:8px" onclick="closeAllCheck()" '
    + 'title="收起这张结果卡；重新自检会整套重跑">✕ 关闭</button></h3>'
    + '<div class="muted mb" style="font-size:11.5px">一次跑完全部模块依赖的真实端点（检查内容与原每页自检一致，重复项已合并）。<b>全部只读</b>：不写入任何配置、不触发模型动作。失败时上方列出<b>受影响的功能模块</b>。</div>'
    + affected
    + '<table><thead><tr><th>模块</th><th>结果</th><th>失败明细</th><th></th></tr></thead><tbody>'
    + rowsHtml('基础设施（认证 · 当前会话）', (c.base && c.base.rows) || [], '__base__')
    + modList.map(([id, m]) => rowsHtml(m.label, m.rows || [], id)).join('')
    + '</tbody></table></div>';
}

/** 只重画结果卡本身（不跑整页重绘）；卡不在页面上时退回整页局部重绘
 *  （首次运行时页面里还没有这张卡，必须让 render() 把它带出来 —— 沿袭 repaintCheck 的教训）。 */
function repaintAllCheck() {
  const holder = document.getElementById('allcheckcard');
  if (!holder || typeof holder.replaceWith !== 'function') { render({ paintOnly: true }); return; }
  const box = document.createElement('div');
  box.innerHTML = allCheckCard();
  const fresh = box.firstElementChild;
  if (fresh) holder.replaceWith(fresh);
}

/** 复制文本到剪贴板（空态引导里的示例提示词用）；失败退回手动选择 */
function copyText(t) {
  writeClipboard(String(t == null ? '' : t))
    .then(ok => { if (ok) UI.ok('已复制到剪贴板'); else UI.warn('复制失败，请手动选择文本'); });
}

/** 首页刷新：把本页依赖的三份数据（本机概要 / 会话列表 / 目标）一起重取。
 *  首页此前没有刷新入口，说明卡里却写着"点右上刷新"—— 补上它，别让文案与页面不符。 */
async function refreshHome() {
  await Promise.all([
    API.host().then(h => { State.host = h; }).catch(() => {}),
    API.call('session.list').then(s => { State.sessions = s.items || []; }).catch(() => {}),
    refreshGoal(true).catch(() => {}),
  ]);
  render();
}

/** 重扫技能根目录（本机 /api/local/skills）：往根目录里放/删技能后不必刷新整页重来。
 *  cwd 是关键参数 —— 项目级根的基准就是当前会话的工作目录。 */
async function reloadSkillsScope() {
  try {
    const cwd = currentSession().cwd || '';
    const r = await fetch('/api/local/skills' + (cwd ? '?cwd=' + encodeURIComponent(cwd) : ''));
    State.skillsScope = await r.json();
    UI.ok('已重新扫描技能根目录（' + ((State.skillsScope.roots || []).length) + ' 个根）');
  } catch (e) { UI.err('扫描失败：' + e.message); }
  render();
}

/* ---------- 页面渲染 ---------- */
const Pages = {};

Pages.home = () => {
  const s = currentSession();
  const p = s.projections?.values || {};
  const ctx = p.contextPressure || {};
  const pressure = ctx.contextWindow ? Math.min(100, (ctx.pressureTokens / ctx.contextWindow) * 100) : 0;
  const jobs = currentJobs();
  const running = jobs.filter(j => j.status === 'running');
  const subs = State.subagents?.entries || [];
  const activeSubs = subs.filter(x => x.activity === 'active');
  const approvals = State.approvals || [];
  const questions = (State.questions || []).filter(q => !q.answered);
  const todoItems = p.todos?.items || [];
  const todoDone = todoItems.filter(t => t.status === 'completed').length;
  const recent = (State.sessions || []).slice(0, 5);

  // 小键值格：会话卡内统一用这个列，避免各处字号/字重漂移
  const kv = (k, v) => `<div style="min-width:0"><div class="muted" style="font-size:11.5px">${k}</div>
    <div style="font-size:13px;font-weight:600;overflow-wrap:anywhere">${v}</div></div>`;

  // 快捷入口：直达常用页面，避免在侧栏里找。
  // 只保留最高频的 4 个（其余从侧栏进，避免与菜单重复）。
  // 只在这里写 id 与本页专属的一句提示；路径 / 图标 / 名称一律从 ROUTES 取，
  // 否则页面名会出现第四份副本（此前这里自己写死过一个和侧栏不一致的简称）。
  const shortcuts = [
    { id: 'chat',         hint: '与智能体对话' },
    { id: 'sessions',     hint: '历史与会话操作' },
    { id: 'jobs',         hint: '作业与审批' },
    { id: 'deliverables', hint: '会话产出的文件' },
  ].map(s => ({ ...(ROUTES.find(r => r.id === s.id) || {}), ...s }));

  return `
  <div class="page-title"><h2>首页</h2>
    <span class="sub">当前会话进展 · 待我处理 · 快捷入口</span>
    <span class="pt-actions">
      <button class="btn sm" onclick="refreshHome()" title="重取本页依赖的全部数据：本机概要 / 会话列表 / 目标">🔄 刷新</button>
      
    </span>
  </div>
  ${crumbOf('home')}
  ${pageHelp('home')}
  
    ${!ROUTES.some(r => r.path === currentPath()) ? `<div class="alert info">地址 <code>#${fmt.esc(currentPath())}</code> 不是有效页面，已回到首页。<a href="#/session/list" style="color:var(--brand-2)">去会话列表 →</a></div>` : ''}
    ${State.error ? `<div class="alert err">无法连接 DSH 主机：${fmt.esc(State.error)}
      <br>请确认 <code>dsh web</code> 正在运行。本页通过 <code>${fmt.esc(location.host)}/api</code> 代理访问 DSH。
      <div class="mt"><button class="btn sm primary" onclick="openDshDialog()">🔌 配置 DSH 主机</button></div>
    </div>` : ''}
    ${!State.error && dshStatusCache && dshStatusCache.state !== 'ok' ? `<div class="alert ${dshStatusCache.state === 'need-token' ? 'info' : 'err'}">
      🔌 DSH 未就绪（${fmt.esc((DSH_STATE[dshStatusCache.state] || DSH_STATE.unknown).text)}）：
      ${fmt.esc(dshStatusCache.error || dshStatusCache.detail || '')}
      <br><span class="muted">把 <code>dsh web</code> 打印的地址（含 <code>?token=…</code>）整段填进控制台。</span>
      <div class="mt"><button class="btn sm primary" onclick="openDshDialog()">🔌 配置 DSH 主机</button></div>
    </div>` : ''}

    <!-- ① 当前会话：打开首页第一眼看"我进行到哪了"，操作按钮一步可达 -->
    <div class="card">
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <h3 style="margin:0">📌 当前会话</h3>
        ${s.running ? '<span class="tag ok">运行中</span>' : '<span class="tag gray">空闲</span>'}
        <span style="margin-left:auto;display:flex;gap:8px">
          <a class="btn sm primary" href="#/chat-agent">💬 继续对话</a>
          <a class="btn sm" href="#/session/trajectory">🧭 会话轨迹</a>
        </span>
      </div>
      <div style="font-size:15px;font-weight:700;margin:12px 0 2px">${sessionTitleHtml(s)}</div>
      <div class="row c4 mt">
        ${kv('模型', fmt.esc(State.host?.model || '—'))}
        ${kv('智能体预设', `<code>${fmt.esc(sessionPreset(s) || '—')}</code>`)}
        ${kv('工作目录', `<span class="mono" style="font-size:11.5px">${fmt.esc(s.cwd || '—')}</span>`)}
        ${kv('最后活动', p.sessionListMetadata?.lastPromptAt ? fmt.ago(p.sessionListMetadata.lastPromptAt) : '—')}
      </div>
      ${ctx.contextWindow ? `<div class="mt">
        <div style="display:flex;justify-content:space-between;font-size:11.5px" class="muted">
          <span>上下文压力</span><span>${pressure.toFixed(1)} % · ${fmt.num(ctx.pressureTokens)} / ${fmt.num(ctx.contextWindow)}</span></div>
        <div style="height:8px;background:var(--inset-solid);border-radius:6px;overflow:hidden;margin-top:4px">
          <div style="height:100%;width:${pressure}%;background:linear-gradient(90deg,var(--brand),var(--brand-2))"></div></div>
      </div>` : ''}
      ${todoItems.length ? `<div class="mt" style="font-size:11.5px">
        <span class="muted">任务进度</span> <b>${todoDone}/${todoItems.length}</b>
        <a href="#/system/host" style="font-size:11px;margin-left:6px">明细见系统状态 →</a></div>` : ''}
    </div>

    <!-- ② 待我处理 + 最近会话：需要动手的事放左（审批可直接批），回顾信息放右 -->
    <div class="row c2 mt">
      <div class="card">
        <h3>⚡ 待我处理</h3>
        <div style="display:flex;gap:14px;flex-wrap:wrap;font-size:12px">
          <span>🔐 待审批 <b>${approvals.length}</b></span>
          <span>❓ 待回答 <b>${questions.length}</b></span>
          <span>⚙️ 运行作业 <b>${running.length}</b></span>
          <span>👥 活跃子代理 <b>${activeSubs.length}</b></span>
        </div>
        ${approvals.length ? `<div class="mt">${approvals.slice(0, 3).map(a => `
          <div class="apprcard" style="margin-top:8px">
            <div class="apprcard-head">🔐 <b>审批请求</b>：工具 <code>${fmt.esc(a.toolName)}</code>
              ${a.reason ? ' · ' + fmt.esc(a.reason) : ''}</div>
            <div style="margin-top:8px;display:flex;gap:8px">
              <button class="btn sm primary" onclick="respondApproval('${fmt.esc(a.approvalId)}', true)">允许一次</button>
              <button class="btn sm" onclick="respondApproval('${fmt.esc(a.approvalId)}', false)">拒绝</button>
            </div>
          </div>`).join('')}${approvals.length > 3 ? `<div class="muted mt" style="font-size:11.5px">还有 ${approvals.length - 3} 个，见 <a href="#/jobs">后台作业页</a></div>` : ''}</div>` : ''}
        ${questions.length ? `<div class="mt" style="font-size:12.5px">❓ 有 <b>${questions.length}</b> 个待回答问题，
          <a href="#/chat-agent">去时空智能体处理 →</a></div>` : ''}
        ${running.length ? `<table class="mt">
          <thead><tr><th>标签</th><th>类型</th><th>开始</th></tr></thead>
          <tbody>${running.slice(0, 4).map(j => `<tr>
            <td class="mono" style="font-size:11.5px">${fmt.esc(j.label)}</td>
            <td>${fmt.esc(j.kind)}</td>
            <td class="muted">${fmt.ago(j.startedAt)}</td></tr>`).join('')}</tbody>
        </table>
        <div class="mt"><a class="btn sm" href="#/jobs">全部 ${jobs.length} 个作业 →</a></div>`
          : (!approvals.length && !questions.length ? `<div class="empty" style="padding:22px">✅ 没有待处理事项</div>` : '')}
      </div>
      <div class="card">
        <h3>🕘 最近会话</h3>
        ${recent.length ? `<table>
          <thead><tr><th>标题</th><th>状态</th><th>更新</th></tr></thead>
          <tbody>${recent.map(x => `<tr>
            <td>${sessionTitleHtml(x, 240)}</td>
            <td>${x.running ? '<span class="tag ok">运行中</span>' : '<span class="tag gray">空闲</span>'}</td>
            <td class="muted">${fmt.ago(x.updatedAt)}</td></tr>`).join('')}</tbody>
        </table>
        <div class="mt"><a class="btn sm" href="#/session/list">查看全部 ${(State.sessions || []).length} 个会话 →</a></div>`
        : '<div class="empty">暂无会话</div>'}
      </div>
    </div>

    <!-- ③ 快捷入口：其余高频页面直达 -->
    <div class="card mt">
      <h3>🚀 快捷入口</h3>
      <div class="row c4">
        ${shortcuts.map(x => `
          <a class="card" href="#${x.path}" style="padding:14px 16px;display:flex;align-items:center;gap:12px;text-decoration:none">
            <span style="font-size:22px">${x.ico}</span>
            <span>
              <span style="display:block;font-weight:600">${x.label}</span>
              <span class="muted" style="font-size:11.5px">${x.hint}</span>
            </span>
          </a>`).join('')}
      </div>
    </div>`;
};

/** 聊天页的轮次导航（数据来自投影 turnOutline：宿主已把每一轮的锚点与摘要算好）。
 *  贴在工具条**最右侧**、单行横向滚动（轮数多也不会把工具条撑成两行）。 */
function chatNavHtml() {
  const outline = currentSession().projections?.values?.turnOutline;
  if (!Array.isArray(outline) || !outline.length) return '';
  return '<div class="chat-nav" title="轮次导航：点某一轮跳到它的第一条消息"><span class="cn-lb">轮次</span>'
    + outline.map(t => {
      const p = String(t.prompt || '').replace(/\s+/g, ' ').slice(0, 110);
      return '<button class="cn-btn" onclick="jumpTurn(' + Number(t.turn) + ')" title="'
        + fmt.h('第 ' + t.turn + ' 轮 · ' + (p || '（无提问摘要）')) + '">' + Number(t.turn) + '</button>';
    }).join('')
    + '</div>';
}
/** 跳到某一轮的第一条消息；消息全量载入后每一轮都在面板里，找不到只会是会话刚被清空 */
function jumpTurn(turn) {
  const log = document.getElementById('chatlog');
  if (!log) return;
  /* 轮号的**权威来源是宿主投影 turnOutline**（带 seq 锚点）。
     ⚠️ 千万别拿行上的 data-turn 当轮号用：那是**事件流的 turn 字段**，和 outline 的轮号
     不是一套编号 —— 实测（4 轮会话）行内轮号序列是 2,1,2,2,…,1,1,… 整体错位 +1 且互相穿插，
     按 data-turn 找落点会"点 2 跳进第 1 轮"（用户报的"第一轮不是第一轮"就是它）。
     正确做法：用 outline 里这一轮的 seq，找面板上 data-seq ≥ 它的第一行（= 这一轮的开头）；
     outline 拿不到（老版本宿主）才退回 data-turn 尽力而为。 */
  const n = Number(turn);
  let hit = null;
  const outline = currentSession().projections?.values?.turnOutline;
  const item = Array.isArray(outline) ? outline.find(t => Number(t.turn) === n) : null;
  if (item && Number.isFinite(Number(item.seq))) {
    const anchor = Number(item.seq);
    hit = [...log.children]
      .filter(c => c.dataset && Number.isFinite(Number(c.dataset.seq)) && Number(c.dataset.seq) >= anchor)
      .sort((a, b) => Number(a.dataset.seq) - Number(b.dataset.seq))[0] || null;
  }
  if (!hit) {
    const all = [...log.querySelectorAll('[data-turn="' + n + '"]')];
    hit = all.find(e => e.classList.contains('msg'))
      || all.find(e => !e.classList.contains('turn-foot'))
      || all[0] || null;
  }
  if (!hit) { UI.warn('第 ' + n + ' 轮不在当前面板里（消息是全量载入的，正常都能找到；点「刷新」重载一次）'); return; }
  /* ⚠️ 必须先关掉"跟随到底部"再滚动：
     否则流式还在跑时，下一行事件到达就会调用 Chat.scroll() 把面板拽回底部、覆盖这次跳转 ——
     这正是"轮次点击有时候没反应"（只在会话运行中出现，所以是"有时候"）。 */
  Chat._follow = false;
  if (hit.scrollIntoView) hit.scrollIntoView({ block: 'center', behavior: 'smooth' });
  else if (hit.offsetTop != null) log.scrollTop = Math.max(0, hit.offsetTop - 80);
  hit.classList.add('flash');
  setTimeout(() => hit.classList.remove('flash'), 1200);
  Chat.onScroll();     // 立刻同步一次「回到底部」按钮与跟随状态，不等 scroll 事件
}
/** 工具条右侧那个「统计」按钮：**会话统计 + 上下文占用合并在同一处**。
 *  以前是两个入口 —— 工具条常驻一枚「上下文 x%」徽标，「⋯ 更多」里又有一项「会话统计」，
 *  两者读的是同一份投影，信息也重叠（统计面板本来就有"上下文"一节）。
 *  现在与统计**分开**：这是一个只讲上下文占用的小徽标，点开是只含"上下文"一节的面板。
 *  （用户反馈：两者合在一颗按钮里、徽标又嵌在按钮内，样式又挤又难看。） */
function contextBadgeHtml() {
  const pv = currentSession().projections?.values || {};
  const p = pv.contextPressure || {}, b = pv.contextBreakdown || {};
  const used = Number(p.pressureTokens), win = Number(p.contextWindow);
  const ok = Number.isFinite(used) && Number.isFinite(win) && win > 0;
  const pct = ok ? Math.min(100, (used / win) * 100) : null;
  const cls = pct == null ? 'gray' : pct >= 80 ? 'err' : pct >= 50 ? 'warn' : 'ok';
  const tip = ok
    ? '上下文压力 ' + fmtInt(used) + ' / 窗口 ' + fmtInt(win) + ' tok'
      + (Number.isFinite(Number(p.projectedTokens)) ? '，预计下一轮 ' + fmtInt(p.projectedTokens) + ' tok' : '')
      + (Number.isFinite(Number(b.messageTokens)) ? '。构成：系统 ' + fmtInt(b.systemTokens) + ' · 工具 ' + fmtInt(b.toolsTokens) + ' · 消息 ' + fmtInt(b.messageTokens) : '')
      + '。接近上限时宿主会自动压缩历史（compaction）。'
    : '这个会话还没有上下文占用数据（跑过至少一轮才有）。';
  return '<button class="ctx-badge ' + cls + '" onclick="showContextPanel()" title="' + fmt.h(tip) + '"'
    + (ok ? '' : ' data-empty="1"') + '>'
    + '<span class="ctx-dot" aria-hidden="true"></span>'
    + '<span class="ctx-t">上下文</span>'
    + (pct != null ? '<b>' + pct.toFixed(1) + '%</b>' : '<span class="ctx-na">—</span>')
    + '</button>';
}
/** 只讲"上下文"一节的面板（与「📈 统计」分开的第二个入口） */
async function showContextPanel() {
  const pv = currentSession().projections?.values || {};
  const p = pv.contextPressure || {}, b = pv.contextBreakdown || {};
  const N = v => (Number.isFinite(Number(v)) ? Number(v) : null);
  const used = N(p.pressureTokens), win = N(p.contextWindow);
  const rows = [];
  const kv = (k, v) => rows.push('<div class="ma-kv"><span>' + k + '</span><b>' + v + '</b></div>');
  if (used != null && win) {
    const pct = (used / win) * 100;
    kv('当前占用', fmtInt(used) + ' / ' + fmtInt(win) + ' tok（' + pct.toFixed(1) + '%）');
    if (N(p.projectedTokens) != null) kv('预计下一轮', fmtInt(p.projectedTokens) + ' tok');
    if ([b.systemTokens, b.toolsTokens, b.messageTokens].some(v => N(v) != null))
      kv('构成', '系统 ' + fmtInt(b.systemTokens || 0) + ' · 工具 ' + fmtInt(b.toolsTokens || 0) + ' · 消息 ' + fmtInt(b.messageTokens || 0));
    const left = win - used;
    if (left > 0) kv('剩余可写', fmtInt(left) + ' tok');
  }
  await UI.panel({
    title: '上下文占用',
    width: 460,
    hint: '来自宿主会话级投影 contextPressure / contextBreakdown。接近窗口上限时宿主会自动压缩历史（compaction），不需要手动清理。',
    html: rows.length ? rows.join('') : '<div class="muted">这个会话还没有上下文占用数据（跑过至少一轮才会有）。</div>',
  });
}

/** 会话统计面板（对齐原生 stats.dialog.*：会话统计 / 模型用时 / 工具调用用时 / 首 token 平均 / 输出速度 / 缓存命中）。
 *  数据源全部是宿主**会话级投影**，不是控制台自己攒的：sessionStats + tokenUsage + contextPressure/Breakdown。
 *  口径逐项对应：
 *    · TPS = decodeTokens / decodeMs（原生 stats.dialog.speed = 输出速度）
 *    · TTFT 平均 = ttftMs / ttftSteps（原生 stats.dialog.ttft = 首 token 平均）
 *    · 缓存命中 = cacheRead / (cacheRead + 未缓存输入)（原生 stats.cacheHit）
 *  取不到的项直接不渲染 —— 面板上出现一个 0 或 "—" 比不显示更容易被当成"真的是 0"。 */
function sessionStatsHtml() {
  const pv = currentSession().projections?.values || {};
  const st = pv.sessionStats || {}, tk = pv.tokenUsage || {}, cp = pv.contextPressure || {}, cb = pv.contextBreakdown || {};
  const rows = [];
  const sec = t => rows.push('<div class="ma-sec">' + t + '</div>');
  const kv = (k, v) => rows.push('<div class="ma-kv"><span>' + k + '</span><b>' + v + '</b></div>');
  const N = v => (Number.isFinite(Number(v)) ? Number(v) : null);

  const turns = N(st.turns), steps = N(st.steps);
  if (turns != null || steps != null) {
    sec('规模');
    if (turns != null) kv('轮数', fmtInt(turns) + ' 轮');
    if (steps != null) kv('步数', fmtInt(steps) + ' 步');
    if (turns && steps != null) kv('平均每轮', (steps / turns).toFixed(1) + ' 步');
  }
  const llm = N(st.llmMs), tool = N(st.toolMs), ttftMs = N(st.ttftMs), ttftSteps = N(st.ttftSteps);
  const decMs = N(st.decodeMs), decTok = N(st.decodeTokens);
  if ([llm, tool, ttftMs, decMs].some(v => v != null)) {
    sec('用时');
    if (llm != null) kv('模型用时', fmtDur(llm));
    if (tool != null) kv('工具调用用时', fmtDur(tool));
    if (llm != null && tool != null) kv('合计', fmtDur(llm + tool));
    if (ttftMs != null && ttftSteps) kv('首 token 平均（TTFT）', fmtDur(ttftMs / ttftSteps));
    if (decMs != null && decTok != null && decMs > 0) kv('输出速度（TPS）', (decTok / (decMs / 1000)).toFixed(1) + ' tok/s');
  }
  const uIn = N(tk.uncachedInputTokens), cR = N(tk.cacheReadTokens), cW = N(tk.cacheWriteTokens), oOut = N(tk.outputTokens);
  if ([uIn, cR, cW, oOut].some(v => v != null)) {
    sec('Token 用量');
    if (uIn != null) kv('未缓存输入', fmtInt(uIn) + ' tok');
    if (cR != null) kv('缓存读取', fmtInt(cR) + ' tok');
    if (cW) kv('缓存写入', fmtInt(cW) + ' tok');
    if (oOut != null) kv('输出', fmtInt(oOut) + ' tok');
    if (uIn != null && cR != null && (uIn + cR) > 0) kv('缓存命中', ((cR / (uIn + cR)) * 100).toFixed(1) + '%');
  }
  const press = N(cp.pressureTokens), win = N(cp.contextWindow);
  if (press != null && win) {
    sec('上下文');
    kv('当前占用', fmtInt(press) + ' / ' + fmtInt(win) + ' tok（' + ((press / win) * 100).toFixed(1) + '%）');
    if (N(cp.projectedTokens) != null) kv('预计下一轮', fmtInt(cp.projectedTokens) + ' tok');
    if ([cb.systemTokens, cb.toolsTokens, cb.messageTokens].some(v => N(v) != null))
      kv('构成', '系统 ' + fmtInt(cb.systemTokens || 0) + ' · 工具 ' + fmtInt(cb.toolsTokens || 0) + ' · 消息 ' + fmtInt(cb.messageTokens || 0));
  }
  const ms = (currentSession().projections?.values || {}).modelSelection || {};
  const model = String(ms.model || '');
  if (ms.provider || model) kv('提供方 / 模型', fmt.esc((ms.provider ? ms.provider + ' / ' : '') + model));
  if (!rows.length) return '<div class="muted">这个会话还没有统计数据（跑过至少一轮才会有）。</div>';
  return rows.join('');
}
/** 打开会话统计弹层（工具条「📈 统计」的唯一去处；上下文占用也在这一张表里） */
async function showSessionStats() {
  await UI.panel({
    title: '会话统计',
    width: 480,
    hint: '全部来自宿主会话级投影（sessionStats / tokenUsage / contextPressure / contextBreakdown），口径与原生「会话统计」一致；取不到的项不显示。上下文占用另有独立的「上下文」入口。',
    html: sessionStatsHtml(),
  });
}

Pages.chat = () => `
  <div class="chat-page">
  <div class="page-title"><h2>时空智能体</h2>
    <span class="sub">与当前会话实时对话 · 消息实时推送，支持流式回答、提问与审批${scopeTag('session')}</span>
    <span class="pt-actions">
      <span class="tag ${State.wsOk?'ok':'err'}" id="wsbadge">${State.wsOk?'实时流已连接':'实时流断开'}</span>
      
    </span>
  </div>
  ${crumbOf('chat')}
  <div style="flex:0 0 auto">${pageHelp('chat')}</div>
  <div style="flex:0 0 auto;max-height:38vh;overflow:auto"></div>
  <div class="card chat-card">
    <!-- 工具条：整块只有一行。左侧=侧栏 + 计划/任务徽标 + 载入统计小字，右侧=统计 + 上下文 + 轮次导航（贴右）。
         统计与上下文是**两个独立入口**（用户要求分开）：统计看规模 / 用时 / Token，
         上下文只看占用与构成；不再挤在同一颗按钮里、也不再互相嵌套样式。
         「⋯ 更多」菜单已按反馈整组移除：三个低频动作都不再挂在这里
         （历史本就是全量载入；其余两个动作改走命令面板 /feedback、/history、/clear）。 -->
    <div class="chat-tools">
      <div class="ct-left">
        <button class="btn sm" onclick="toggleChatAside()" title="任务 / 消息队列 / 审批，也能直接切模型与智能体预设">📋 侧栏</button>
        <span id="chatplan" class="ct-plan">${planBadgeText()}</span>
        ${isSubagentSession(currentSession()) ? `<span class="muted" style="font-size:11.5px">子代理会话（父 ${fmt.esc(String(currentSession().parentSessionId||'').slice(0,10))}…）</span>
          <button class="btn sm" onclick="setCurrentSession('${fmt.esc(currentSession().parentSessionId||'')}')">↩ 回父会话</button>` : ''}
        <span class="muted" id="chatload" style="font-size:11px"></span>
      </div>
      <div class="ct-right">
        <button class="btn sm" onclick="reloadChat()" title="重新拉取当前会话的全部消息并重绘（消息是全量载入的）">🔄 刷新</button>
        <button class="btn sm" onclick="showSessionStats()" title="会话统计：轮数 / 步数 / 用时 / Token 用量（宿主 sessionStats 投影）">📈 统计</button>
        ${contextBadgeHtml()}
        ${chatNavHtml()}
      </div>
    </div>
    <div class="chat-split" style="flex:1;display:flex;min-height:0;position:relative">
      <div class="chat-log" style="flex:1;overflow:auto" id="chatlog" onscroll="Chat.onScroll()">
        <div class="empty">向智能体提问，消息将送入当前 DSH 会话，回复通过 WebSocket 实时返回<br>
          <span class="muted">提示：输入 <code>/</code> 调用指令，输入 <code>@</code> 引用文件或对话；附件用输入框左侧的 📎（图片与文件同一个入口）</span></div>
      </div>
      <aside id="chataside" style="width:312px;flex:0 0 auto;border-left:1px solid var(--line);padding:0 0 0 12px;overflow:auto;display:none"></aside>
      <button class="btn sm chat-jump" id="chatbottom" onclick="Chat.toBottom()" style="display:none"
        title="跳到最后一条消息（面板滚上去之后才会出现）">⤓ 回到底部</button>
    </div>
    <div id="chatquestions"></div>
    <div id="attachpreview"></div>
    <div id="refchips"></div>
    <div class="chat-input">
      <div id="cmdmenu" class="menu-pop" style="display:none"></div>
      <div id="refmenu" class="menu-pop" style="display:none"></div>
      <div class="chat-input-row">
        <input type="file" id="chatfile" style="display:none" onchange="pickAttach(event)">
        <button class="btn sm ci-icon" id="chatattach" onclick="document.getElementById('chatfile').click()" title="添加附件：图片或任意文件均可（对齐原生「添加附件」）">📎</button>
        <input id="chatinput" value="${fmt.esc(State.chatDraft || '')}" placeholder="发消息或创建任务，/ 调用指令，@ 引用文件或对话" onkeydown="chatKey(event)" oninput="chatTyping(event)">
        <button class="btn primary" onclick="sendChat(event)" id="chatsend">发送</button>
      </div>
    </div>
  </div>
  </div>`;

Pages.agentMgr = () => `
  <div class="page-title"><h2>智能体预设</h2>
    <span class="sub">${State.presets.length} 个 智能体预设 · 决定会话的工具与提示词组合${scopeTag('global')}</span>
    <span class="pt-actions"><button class="btn sm" onclick="loadPresets(true)">刷新</button></span>
      </div>
  ${crumbOf('agentMgr')}
  ${pageHelp('agentMgr')}
  
  <div class="alert info">💡 智能体预设<b>清单</b>全局共享；每个会话<b>用哪个智能体预设</b>是会话级属性。当前会话使用：<b>${fmt.esc(sessionPreset(currentSession()) || '默认智能体预设')}</b>；新会话的默认智能体预设见<a href="#/settings">设置 → agent-presets</a>。<br>
  <b>系统智能体预设</b>（来源 <code>system</code>）随部署发布、<b>只读</b>：不能改名/删除，也不能在编辑器中打开；要定制先「复制」成用户智能体预设，再编辑副本。</div>

  ${State.presets.length ? `<div class="row c2">${State.presets.map(p => `
    <div class="card">
      <h3>🤖 ${fmt.esc(p.name || p.id)}
        ${p.isDefault ? '<span class="tag ok">默认</span>' : ''}
        <span class="tag gray">${p.trust === 'user' ? '👤 用户智能体预设' : '🔒 系统智能体预设（只读）'}</span>
      </h3>
      <div class="muted mono mb" style="font-size:11.5px">${fmt.esc(p.id)}</div>
      <p>${fmt.esc(p.description || '—')}</p>
      <div class="mt" style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn sm" onclick="readPreset('${fmt.esc(p.id)}')">查看配置</button>
        ${p.trust === 'user'
          ? `<button class="btn sm" onclick="openPresetDoc('${fmt.esc(p.id)}')" title="在宿主编辑器里打开这个用户智能体预设的目录">编辑器打开</button>`
          : `<button class="btn sm" disabled title="系统智能体预设随部署发布、只读，无法编辑；要定制请先「复制」成用户智能体预设">编辑器打开</button>`}
        <button class="btn sm" onclick="copyPreset('${fmt.esc(p.id)}')" title="复制成用户智能体预设（副本可编辑）">复制</button>
        ${p.trust === 'user' ? `<button class="btn sm" onclick="removePreset('${fmt.esc(p.id)}')">删除</button>` : ''}
      </div>
    </div>`).join('')}</div>` : '<div class="empty">暂无智能体预设</div>'}

  <div id="presetpanel"></div>

  <div class="card mt">
    <h3>📋 智能体预设明细</h3>
    <table>
      <thead><tr><th>ID</th><th>名称</th><th>来源</th><th>默认</th><th>说明</th></tr></thead>
      <tbody>${State.presets.map(p => `<tr>
        <td class="mono">${fmt.esc(p.id)}</td><td>${fmt.esc(p.name)}</td>
        <td><span class="tag gray">${p.trust === 'user' ? '👤 用户预设（可编辑）' : '🔒 系统预设（只读）'}</span></td>
        <td>${p.isDefault ? '<span class="tag ok">是</span>' : '—'}</td>
        <td class="muted">${fmt.esc((p.description||'').slice(0,80))}</td></tr>`).join('')}</tbody>
    </table>
  </div>`;

/* 作用域 → 展示样式 */
const SCOPE_STYLE = {
  project:        { tag: 'ok',     ico: '📁', name: '项目级' },
  'project-agents': { tag: 'ok',   ico: '📁', name: '项目级(.agents)' },
  user:           { tag: '',       ico: '👤', name: '用户级' },
  'user-agents':  { tag: '',       ico: '👤', name: '用户级(.agents)' },
};
function scopeBadge(scope) {
  const s = SCOPE_STYLE[scope] || { tag: 'gray', ico: '❔', name: scope || '未知' };
  return `<span class="tag ${s.tag}" style="font-size:10.5px">${s.ico} ${s.name}</span>`;
}

Pages.skillMgr = () => {
  const sc = State.skillsScope;
  const list = sc?.skills || [];
  const byScope = {};
  list.forEach(s => (byScope[s.scope] = (byScope[s.scope] || 0) + 1));
  return `
  <div class="page-title"><h2>Skills 管理</h2>
    <span class="sub">${list.length} 个技能 · 按作用域分层（近层覆盖远层）${scopeTag('cwd')}</span>
    <span class="pt-actions">
      <button class="btn sm" onclick="reloadSkillsScope()" title="按当前会话工作目录重新扫描技能根目录">🔄 重新扫描</button>
      
    </span>
  </div>
  ${crumbOf('skillMgr')}
  ${pageHelp('skillMgr')}
  

  <div class="card mb">
    <h3>📚 技能根目录（作用域由路径决定）</h3>
    <table>
      <thead><tr><th>作用域</th><th>路径</th><th>状态</th><th>技能数</th></tr></thead>
      <tbody>${(sc?.roots || []).map(r => `<tr>
        <td>${scopeBadge(r.scope)}</td>
        <td class="mono" style="font-size:11.5px">${fmt.esc(r.path)}</td>
        <td>${r.exists ? '<span class="tag ok">存在</span>' : '<span class="tag gray">未创建</span>'}</td>
        <td>${byScope[r.scope] || 0}</td></tr>`).join('') || '<tr><td colspan="4" class="empty">未扫描到根目录</td></tr>'}</tbody>
    </table>
    <p class="muted mt" style="font-size:11.5px">项目级根目录基于<b>当前会话的工作目录</b>解析：<code>${fmt.esc(sc?.cwd || '—')}</code> —— 换会话即换作用域。</p>
  </div>

  ${list.length ? `<div class="row c2">${list.map(s => `
    <div class="card">
      <h3>🧩 ${fmt.esc(s.name)} ${scopeBadge(s.scope)}</h3>
      ${s.whenToUse ? `<div class="muted mb" style="font-size:11.5px">适用：${fmt.esc(s.whenToUse)}</div>` : ''}
      <p>${fmt.esc(s.description || '—')}</p>
      <div class="muted mt mono" style="font-size:10.5px">${fmt.esc(s.file)} · ${s.bytes} 字节</div>
    </div>`).join('')}</div>` : '<div class="empty">当前工作空间下没有技能</div>' + emptyGuide('skillMgr')}`;
};

Pages.plugins = () => {
  const d = State.plugins;
  if (!d) return `<div class="page-title"><h2>插件</h2>
      <span class="sub">Cordis 插件树 · 等待探测${scopeTag('global')}</span>
          </div>
    ${crumbOf('plugins')}
    ${pageHelp('plugins')}
    
    <div class="card"><div class="empty"><span class="loading"></span> 正在读取插件清单…</div></div>`;
  const ps = d.plugins || [];
  const disabled = ps.filter(p => p.disabled);
  const cats = {};
  ps.forEach(p => { const c = pluginCat(p); (cats[c.key] = cats[c.key] || { ...c, items: [] }).items.push(p); });
  const sensitive = ps.filter(p => SENSITIVE.test(p.pkg) || SENSITIVE.test(p.id));
  const layers = d.layers || {};

  return `
  <div class="page-title"><h2>插件</h2>
    <span class="sub">Cordis 插件树 · ${ps.length} 个插件 · 来源 ${Object.keys(layers).length} 层${scopeTag('global')}</span>
    <span class="pt-actions">
      <button class="btn sm" onclick="reloadPlugins()" title="重新执行 dsh --dump-config，成功后自动回写 plugins.json">🔄 重新探测</button>
      
    </span>
  </div>
  ${crumbOf('plugins')}
  ${pageHelp('plugins')}
  

  <div class="row c4">
    <div class="card stat"><div class="k">插件总数</div><div class="v">${ps.length}</div></div>
    <div class="card stat"><div class="k">已禁用</div><div class="v">${disabled.length}</div></div>
    <div class="card stat"><div class="k">功能分类</div><div class="v">${Object.keys(cats).length}</div></div>
    <div class="card stat"><div class="k">安全敏感</div><div class="v">${sensitive.length}</div></div>
  </div>

  <div class="alert info" style="margin-top:14px">
    数据来源：<code>${fmt.esc(d.source)}</code>${d.via ? '（执行方式 ' + fmt.esc(d.via) + '）' : ''}${d.at ? ' · 时间 ' + fmt.esc(new Date(d.at).toLocaleString('zh-CN')) : ''}
    ${d.error
      ? '<br><span class="tag warn">回退</span> 实时 dump 不可用（' + fmt.esc(d.error) + '），已回退到 plugins.json 快照。'
        + '<br><span class="muted" style="font-size:11.5px">在普通 PowerShell 窗口里重启控制台即可恢复实时 dump；快照会在每次 dump 成功时自动更新。</span>'
      : '<br><span class="tag ok">实时</span> 本次为实时 dump，结果已同步回写 plugins.json 快照。'}
  </div>

  <div class="card">
    <h3>📦 完整插件清单</h3>
    <input id="plugfilter" placeholder="筛选：输入 id 或包名关键字" value="${fmt.esc(State.pluginFilter || '')}"
           oninput="State.pluginFilter=this.value;renderPlugins()" style="margin-bottom:12px">
    <div class="listsrc perf-list">
      <table id="plugtable">
        <thead><tr>
          ${Table.th('plugins','id','ID')}
          ${Table.th('plugins','pkg','包名')}
          ${Table.th('plugins','cat','分类')}
          ${Table.th('plugins','layer','来源层')}
          ${Table.th('plugins','disabled','状态')}
        </tr></thead>
        <tbody></tbody>
      </table>
    </div>
    <div id="pluginpager"></div>
  </div>

  <details class="card mt">
    <summary>📊 插件构成与诊断（分类 / 来源层 / 安全敏感 / 已禁用）</summary>
    <div class="card mb" style="border:none;padding:0;margin-top:12px">
      <h3>🧱 插件来源层（合成顺序）</h3>
      <table>
        <thead><tr><th>来源</th><th>插件数</th><th>说明</th></tr></thead>
        <tbody>${Object.entries(layers).map(([k, v]) => `<tr>
          <td class="mono" style="font-size:11.5px">${fmt.esc(k)}</td>
          <td>${v}</td>
          <td class="muted">${k.includes('cordis.patch') ? '你的自定义补丁层（如 mcp-geoscene）'
            : k.includes('dsh-base') && k.includes('patched') ? '基础包中被上层改过配置的行'
            : k.includes('dsh-base') ? '基础包原始行'
            : k.includes('web-app') ? 'Web 应用层' : '—'}</td></tr>`).join('')}</tbody>
      </table>
    </div>
    <div class="card mb" style="border:none;padding:0">
      <h3>📊 按功能分类</h3>
      <div class="row c3">
        ${Object.values(cats).sort((a,b)=>b.items.length-a.items.length).map(c => `
          <div class="card" style="padding:12px 14px">
            <div style="font-weight:600;margin-bottom:6px">${c.ico} ${fmt.esc(c.label)} <span class="tag gray">${c.items.length}</span></div>
            <div class="muted mono" style="font-size:11px;line-height:1.7">${c.items.slice(0,6).map(x=>fmt.esc(x.id)).join(' · ')}${c.items.length>6?' …':''}</div>
          </div>`).join('')}
      </div>
    </div>
    <div class="card mb" style="border:none;padding:0">
      <h3>🛡️ 安全敏感插件（${sensitive.length}）</h3>
      <p class="muted mb" style="font-size:12px">这些插件构成 DSH 的「缰绳」——约束模型能做什么。改动它们会直接影响安全边界。</p>
      <table>
        <thead><tr><th>插件</th><th>作用</th></tr></thead>
        <tbody>${sensitive.map(p => {
          const role = /sandbox/.test(p.pkg) ? '文件沙箱：限制可写入的路径范围'
            : /authorization/.test(p.pkg) ? '授权：判定操作是否被允许'
            : /approval|user-approval/.test(p.pkg) ? '审批：需要人工确认的操作走这里'
            : /permission/.test(p.pkg) ? '权限模式：read-only / workspace-write / full-access'
            : /credentials/.test(p.pkg) ? '凭据存储：API Key 等的加密读写'
            : /fs-observation/.test(p.pkg) ? '先读后写：禁止修改未观察过的文件'
            : /subprocess/.test(p.pkg) ? '子进程：环境变量凭据擦洗（KEY/TOKEN 不外泄）'
            : '—';
          return `<tr><td class="mono" style="font-size:11.5px">${fmt.esc(p.id)}</td>
            <td class="muted">${fmt.esc(role)}</td></tr>`;
        }).join('')}</tbody>
      </table>
    </div>
    <div class="card" style="border:none;padding:0">
      <h3>⛔ 已禁用的插件（${disabled.length}）</h3>
      <p class="muted mb" style="font-size:12px">被上层补丁关闭的行。例如 <code>hmr</code> 被关闭 —— 这就是"改配置必须重启"的原因。</p>
      <div style="display:flex;flex-wrap:wrap;gap:6px">
        ${disabled.map(p => `<span class="tag gray mono" style="font-size:11px">${fmt.esc(p.id)}</span>`).join('')}
      </div>
    </div>
  </details>

  <details class="card mt">
    <summary>🛰️ 运行时清单（宿主插件 / 动态插件）</summary>
    <div class="card mb" id="hostinv" style="border:none;padding:0;margin-top:12px">
      <h3>🛰️ 宿主插件运行时清单（pluginInventory/list）</h3>
      <div class="empty"><span class="loading"></span> 读取中…</div>
    </div>
    <div class="card mb" id="dynplugins" style="border:none;padding:0">
      <h3>🧩 动态插件（dynamicCordisRunner/inventory）</h3>
      <div class="empty"><span class="loading"></span> 读取中…</div>
    </div>
  </details>

  <details class="card mt">
    <summary>⚙️ 配置与生效</summary>
    <table style="margin-top:12px">
      <tr><td>合成顺序</td><td class="muted">base bundle → web-app bundle → <code>cordis.patch.yml</code> → <code>--patch</code> 覆盖层</td></tr>
      <tr><td>你的补丁</td><td class="mono">~/.dsh/profiles/web/cordis.patch.yml</td></tr>
      <tr><td>根配置</td><td class="mono">~/.dsh/profiles/web/cordis.yml（空模板，每次启动重写）</td></tr>
      <tr><td>生效方式</td><td><span class="tag warn">需重启 dsh web</span>（该 profile 的 HMR 已禁用）</td></tr>
    </table>
  </details>`;
};

/* 插件表格：客户端筛选渲染（136 条不必一次全塞 DOM） */
function renderPlugins() {
  const d = State.plugins; if (!d) return;
  // 筛选词存在 State 里（不是只读 DOM）：这样排序/翻页触发的重绘不会把筛选条件丢掉
  const kw = String(State.pluginFilter || (document.getElementById('plugfilter')?.value || '')).trim().toLowerCase();
  let list = (d.plugins || []).filter(p => !kw || p.id.toLowerCase().includes(kw) || p.pkg.toLowerCase().includes(kw));

  // 排序（cat 用动态分类名）+ 分页
  list = Table.apply('plugins', list, {
    id: p => p.id, pkg: p => p.pkg, cat: p => pluginCat(p).label,
    layer: p => p.layer, disabled: p => p.disabled ? 0 : 1,
  });
  const sliced = Table.slice('plugins', list);
  list = sliced.rows;
  const pagerEl = document.getElementById('pluginpager');
  if (pagerEl) pagerEl.innerHTML = sliced.pager;

  const tb = document.querySelector('#plugtable tbody'); if (!tb) return;
  tb.innerHTML = list.map(p => {
    const c = pluginCat(p);
    const shortLayer = p.layer.includes('cordis.patch') ? '↳ 用户补丁'
      : p.layer.includes('patched') ? 'base（被改）'
      : p.layer.includes('dsh-base') ? 'base'
      : p.layer.includes('web-app') ? 'web-app' : '—';
    return `<tr>
      <td class="mono" style="font-size:11.5px">${fmt.esc(p.id)}</td>
      <td class="mono muted" style="font-size:11px">${fmt.esc(p.pkg)}</td>
      <td><span class="tag gray" style="font-size:10.5px">${c.ico} ${fmt.esc(c.label)}</span></td>
      <td style="font-size:11.5px">${p.layer.includes('cordis.patch')
        ? '<span class="tag ok">📁 我的补丁</span>'
        : '<span class="tag gray">🌐 系统</span>'} <span class="muted" style="font-size:10.5px">' + fmt.esc(shortLayer) + '</span></td>
      <td>${p.disabled ? '<span class="tag gray">禁用</span>' : '<span class="tag ok">启用</span>'}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="5" class="empty">无匹配</td></tr>';
}

Pages.models = () => {
  const m = State.models || {};
  const cur = sessionModelOf(State.sessionId);   // 会话级 next 优先；投影没回来才退全局默认
  const groups = m.groups || [];
  // 会话身份显示**标题**（完整 ID 放 title）：uuid 截断后既认不出也读不全，
  // 与顶部作用域条保持同一口径。供应商/候选清单等局部量已收进 provSectionHtml()。
  const curSess = currentSession();
  const sessTitle = curSess.projections?.values?.title || (State.sessionId ? '未命名会话' : '（未选择会话）');
  const sessHint = State.sessionId ? '会话 ID：' + State.sessionId : '';

  return `
  <div class="page-title"><h2>大模型</h2>
    <span class="sub">供应商接入与模型目录 = 全局资产${scopeTag('global')} · 用哪个模型 = 当前会话的选择${scopeTag('session')}</span>
    <span class="pt-actions"><button class="btn sm" onclick="loadModelCatalog(true);loadProviders(true)">刷新</button></span>
      </div>
  ${crumbOf('models')}
  ${pageHelp('models')}
  

  <div class="alert info">💡 本页回答三件事：<b>哪些供应商接进来了</b>、<b>能选哪些模型</b>、<b>当前会话正在用哪个</b>。<br>
  改供应商（API Key / 参数）不在本页；切模型也不在本页——具体入口见下表。</div>

  <div class="card mb">
    <h3>🧭 作用域与入口速查</h3>
    <table>
      <thead><tr><th>内容</th><th>作用域</th><th>在哪里改</th></tr></thead>
      <tbody>
        <tr>
          <td>供应商 API Key</td>
          <td><span class="tag gray">🌐 全局</span></td>
          <td><a href="#/credentials">凭据</a> 页按名称维护（供应商参数表里的 <code>apiKeyRef</code> 指向它）</td>
        </tr>
        <tr>
          <td>供应商模型参数<br><span class="muted" style="font-size:11px">模型清单 / 上下文窗口 / maxTokens</span></td>
          <td><span class="tag gray">🌐 全局</span></td>
          <td><a href="#/settings">设置</a> → <code>llm-deepseek</code> / <code>llm-pi-ai</code> 命名空间<br><span class="muted" style="font-size:11px">本页「可用模型」目录就是从这两处读出来的</span></td>
        </tr>
        <tr>
          <td>模型目录（动态拉取）</td>
          <td><span class="tag gray">🌐 全局</span></td>
          <td>本页「🔧 供应商接入」——每行一个「探测」按钮拉该通道的最新清单，或卡头「全部探测」跑一遍；结果显示在同一行下面</td>
        </tr>
        <tr>
          <td><b>当前会话用哪个模型 + 推理强度</b></td>
          <td><span class="tag">💬 会话级</span></td>
          <td>时空智能体页右侧栏「🧠 模型」框；或 <a href="#/session/list">会话</a> 列表行内「切模型」<br><span class="muted" style="font-size:11px">本页下方「当前会话路由」只是只读展示，不能在这里改</span></td>
        </tr>
        <tr>
          <td>新会话的默认模型 / 推理强度</td>
          <td><span class="tag gray">🌐 全局</span></td>
          <td><a href="#/settings">设置</a> → <code>agent-default-model</code><br><span class="muted" style="font-size:11px">只决定新会话从什么状态开始，已有会话不受影响</span></td>
        </tr>
        <tr>
          <td>子代理可用模型白名单</td>
          <td><span class="tag gray">🌐 全局</span></td>
          <td><a href="#/settings">设置</a> → <code>subagent-model-selection</code>（未授权的模型，子代理不能选）</td>
        </tr>
      </tbody>
    </table>
  </div>

  ${!m.routable ? '<div class="alert err">⛔ 当前会话的模型路由<b>不可用</b>（routable=false）：通常是缺少对应供应商的 API Key，或模型不在目录里。请先到「凭据」页确认 Key，再回来检查供应商是否已激活。</div>' : ''}
  ${(m.failures || []).length ? `<div class="alert err">⚠️ 有供应商加载失败（失败项会被排除在模型目录之外）：<br><code class="mono" style="font-size:11px">${fmt.esc(JSON.stringify(m.failures).slice(0, 300))}</code></div>` : ''}

  <div class="card mb">
    <h3>💬 当前会话路由 <span class="tag">💬 会话级</span>
      <span style="margin-left:auto"></span>
      <a class="btn sm" href="#/chat-agent">去时空智能体切换</a>
    </h3>
    <div class="muted mb" style="font-size:11.5px">以下三项属于会话 <b title="${fmt.esc(sessHint)}">${fmt.esc(sessTitle)}</b>，切换会话后这里会跟着变。</div>
    <div class="row c3">
      <div><div class="muted" style="font-size:11.5px">供应商</div><div style="font-size:15px;font-weight:600">${fmt.esc(cur.provider || '—')}</div></div>
      <div><div class="muted" style="font-size:11.5px">模型</div><div style="font-size:15px;font-weight:600">${fmt.esc(cur.model || '—')}</div></div>
      <div><div class="muted" style="font-size:11.5px">推理强度</div><div style="font-size:15px;font-weight:600">${fmt.esc(cur.reasoningEffort || '默认')}</div></div>
    </div>
  </div>

  <div class="card mb">
    <h3>📦 可用模型 <span class="tag gray">🌐 全局</span>
    </h3>
    <div class="muted mb" style="font-size:11.5px">${groups.length} 个供应商分组 · 共 ${groups.reduce((n, g) => n + (g.models || []).length, 0)} 个模型。带「当前」标签的是当前会话正在用的。
      <br>这里是<b>静态目录</b>（部署写在设置里的清单）。要探测供应商能提供哪些模型，去下方「🔧 供应商接入」。</div>
    ${groups.map(g => {
      const ms = (g.models || []);
      if (!ms.length) return '';
      return `<div style="margin-bottom:12px">
        <div class="muted mb" style="font-weight:600">${fmt.esc(g.name || g.id || '')} · ${ms.length} 个</div>
        <div class="row c3">
          ${ms.map(x => `
            <div class="card" style="padding:12px 14px">
              <div style="font-weight:600;margin-bottom:4px">${fmt.esc(x.name || x.id)} ${(x.id === cur.model && g.id === cur.provider) ? '<span class="tag ok">当前</span>' : ''}</div>
              <div class="muted mono" style="font-size:11px;margin-bottom:6px">${fmt.esc(g.id)} / ${fmt.esc(x.id)}</div>
              ${x.description ? `<div class="muted" style="font-size:11px;margin-bottom:6px">${fmt.esc(String(x.description).slice(0, 120))}</div>` : ''}
              ${x.reasoning ? `<div style="display:flex;flex-wrap:wrap;gap:4px">${(x.reasoning.efforts || []).map(e => `<span class="tag ${e.id === x.reasoning.defaultEffort ? 'ok' : 'gray'}" style="font-size:10.5px" title="${fmt.esc(e.description || '')}">${fmt.esc(e.name)}${e.id === x.reasoning.defaultEffort ? '（默认）' : ''}</span>`).join('')}</div>
                <div class="muted" style="font-size:10.5px;margin-top:4px">以上为该模型可选的推理强度${x.reasoning.defaultEffort ? '，绿色是本部署的默认值' : ''}；会话内切换见右侧栏「🧠 模型」</div>` : ''}
            </div>`).join('')}
        </div>
      </div>`;
    }).join('') || '<div class="empty">未获取到模型列表。请检查「设置」里的 <code>llm-*</code> 命名空间是否配好了模型清单。</div>'}
  </div>

  <div class="card" id="provcard">${provSectionHtml()}</div>`;
};

Pages.mcp = () => `
  <div class="page-title"><h2>MCP 服务</h2><span class="sub">Model Context Protocol 服务${scopeTag('global')}</span>
    <span class="pt-actions">
      <button class="btn sm" onclick="reloadMcp()" title="重新做 TCP 探测 + MCP 握手，成功后自动回写 mcp-tools.json">🔄 重新握手</button>
      
    </span>
  </div>
  ${crumbOf('mcp')}
  ${pageHelp('mcp')}
  
  <div class="alert info">每个 MCP 服务一个插件实例，工具注册为 <code>mcp__&lt;serverName&gt;__&lt;工具名&gt;</code>。
    服务清单来自本机配置解析 + TCP 探测，「工具数」优先取握手结果、其次取 <code>mcp-tools.json</code> 快照。</div>

  ${!State.mcp ? '<div class="card"><div class="empty"><span class="loading"></span> 正在读取 MCP 配置…</div></div>' : ''}
  ${State.mcp && !State.mcp.length ? '<div class="card"><div class="empty">本部署没有配置任何 MCP 服务</div>' + emptyGuide('mcp') + '</div>' : ''}
  ${(State.mcp || []).map(s => {
    const on = s.online;
    return `
    <div class="card mb">
      <h3>🔌 ${fmt.esc(s.name)} ${on ? '<span class="tag ok">已连接</span>' : '<span class="tag warn">待接入</span>'}</h3>
      <div class="row c2">
        <div>
          <table>
            <tr><td>服务名</td><td class="mono">${fmt.esc(s.serverName)}</td></tr>
            <tr><td>命名空间</td><td class="mono">${fmt.esc(s.ns)}</td></tr>
            <tr><td>传输</td><td class="mono">${fmt.esc(s.transport)}</td></tr>
            <tr><td>${s.transport === 'streamable-http' ? '地址' : '启动命令'}</td><td class="mono">${fmt.esc(s.target)}</td></tr>
            <tr><td>工具数</td><td>${s.tools == null
              ? '<span class="tag warn">未能握手统计</span> <span class="muted" style="font-size:11px">（服务端口可达，但进程内无法启动 MCP 握手）</span>'
              : s.tools + ' <span class="muted" style="font-size:11px">来源 ' + fmt.esc(s.toolsSource || '—') + '</span>'
                + (s.toolNames.length ? ' <button class="btn sm" style="margin-left:6px" onclick="toggleToolList(\'' + fmt.esc(s.serverName) + '\')">查看清单</button>' : '')}</td></tr>
            <tr><td>连接状态</td><td>${s.status === 'connected' ? '<span class="tag ok">已连接</span>'
              : s.status === 'offline' ? '<span class="tag err">离线</span>'
              : s.status === 'configured' ? '<span class="tag warn">已配置</span>'
              : '<span class="tag gray">未接入</span>'}</td></tr>
            ${s.endpoint ? `<tr><td>探测端点</td><td class="mono">${fmt.esc(s.endpoint)}</td></tr>` : ''}
            <tr><td>DSH 插件</td><td>${s.loadedByDsh ? '<span class="tag ok">已加载</span> <span class="mono muted" style="font-size:11px">' + fmt.esc(s.pluginId) + '</span>' : '<span class="tag gray">未加载</span>'}</td></tr>
            <tr><td>归属</td><td>${s.source.includes('cordis.patch')
              ? '<span class="tag ok">📁 用户配置（cordis.patch.yml）</span>'
              : '<span class="tag gray">🌐 系统 bundle</span>'} <span class="mono muted" style="font-size:10.5px">${fmt.esc(s.source)}</span></td></tr>
          </table>
        </div>
        <div>
          ${(s.groups || []).length ? `<div class="muted mb">工具分组</div>
            <div style="display:flex;flex-wrap:wrap;gap:6px">${s.groups.map(g => `<span class="tag gray">${fmt.esc(g)}</span>`).join('')}</div>` : ''}
          ${s.desc ? `<p class="mt" style="font-size:12px">${fmt.esc(s.desc)}</p>` : ''}
          ${s.note ? `<p class="mt muted" style="font-size:11.5px">ℹ️ ${fmt.esc(s.note)}</p>` : ''}
          <div id="toollist-${fmt.esc(s.serverName)}"></div>
        </div>
      </div>
    </div>`;
  }).join('')}

  <div class="card mt">
    <h3>⚙️ 配置位置</h3>
    <p class="muted">插件配置：<code>~/.dsh/profiles/web/cordis.patch.yml</code> · 改动后需重启 <code>dsh web</code>（该 profile 的 HMR 已关闭）</p>
  </div>`;


/* ============ 凭据（credentials.*） ============ */
Pages.credentials = () => {
  const d = State.credentials;
  const creds = d?.credentials || {};
  const local = d?.local || null;
  const refs = d?.refs || { byName: {}, byNs: {}, inline: {} };
  const providers = State.providers || [];

  const nameOf = k => (refs.byName?.[k] || []).join('、');
  const confirmed = Object.keys(creds).filter(k => creds[k]?.configured);            // DSH 确认已配置
  const refNames = Object.keys(refs.byName || {});                                   // 设置里引用的键名
  const refMissing = refNames.filter(k => !creds[k]?.configured);                     // 被引用但未配置
  const localRefs = (local?.refs || []).filter(n => CRED_NAME_RE.test(n));            // 本机文件 refs 段
  const localOrphan = localRefs.filter(n => !(refs.byName || {})[n]);                 // 本机有、但没被任何配置引用
  const localBad = (local?.refs || []).filter(n => !CRED_NAME_RE.test(n));            // 名字不合 DSH 约束的
  const localRecords = (local?.records || []);

  const credRow = (k, ops) => {
    const i = creds[k] || {};
    return `<tr>
      <td class="mono" style="font-size:12px">${fmt.esc(k)}</td>
      <td>${i.configured ? '<span class="tag ok">已配置</span>' : '<span class="tag err">未配置</span>'}
        ${i.source ? '<span class="muted" style="font-size:11px;margin-left:6px">来源 ' + fmt.esc(i.source) + '</span>' : ''}
        ${i.writable === false ? '<span class="tag gray" style="font-size:10px;margin-left:4px">只读</span>' : ''}</td>
      <td class="muted" style="font-size:11.5px">${nameOf(k) ? '<span class="mono">' + fmt.esc(nameOf(k)) + '</span>' : '—'}</td>
      <td style="white-space:nowrap">${ops}</td>
    </tr>`;
  };
  const acts = k => `<button class="btn sm" onclick="setCredential('${fmt.esc(k)}')">${creds[k]?.configured ? '更新' : '写入'}</button>
        ${creds[k]?.configured && creds[k]?.writable !== false ? `<button class="btn sm" onclick="unsetCredential('${fmt.esc(k)}')">删除</button>` : ''}`;

  return `
  <div class="page-title"><h2>凭据</h2>
    <span class="sub">DSH 确认已配置 ${confirmed.length} 条 · 本机文件键名 ${localRefs.length} 条 · 设置引用 ${refNames.length} 个${scopeTag('global')}</span>
    <span class="pt-actions">
      <button class="btn sm" onclick="checkCredential()" title="对任意键名核对一次状态（credentials/describe 只能按名查询）">🔎 按名查询</button>
      <button class="btn sm" onclick="loadCredentials(true)">🔄 刷新</button>
      
    </span>
  </div>
  ${crumbOf('credentials')}
  ${pageHelp('credentials')}
  
    ${stampText('credentials')}

  <div class="alert err">
    🔐 <b>安全提示</b>：凭据以密文存储于 <code>~/.dsh/.credentials.yaml</code>。
    本页<b>只显示键名，不显示明文，也从不读取密文</b>；写入会真实影响 DSH 对外部模型的调用。
  </div>

  ${d?.error ? `<div class="alert err">读取失败：${fmt.esc(d.error)}</div>` : ''}
  ${!d ? '<div class="card"><div class="empty"><span class="loading"></span> 读取中…</div></div>' : ''}

  ${d && local && (local.error || !local.exists) ? `<div class="alert ${local.error ? 'err' : 'info'}">
    📄 本机凭据文件${local.error ? '读取失败' : '不存在'}：<code>${fmt.esc(local.file || '~/.dsh/.credentials.yaml')}</code>${local.error ? ' —— ' + fmt.esc(local.error) : ''}。
    ${local.error ? '若控制台后端还是旧版本（没有 <code>/api/local/credentials</code> 这个端点），重启控制台即可读到键名；' : ''}
    此时列表只依据<b>设置里引用的键名</b>，可能漏掉没被任何配置引用的旧键。
  </div>` : ''}

  ${d ? `<div class="alert info">
    🔎 <b>这页的数据是怎么来的</b>：DSH 只能<b>按名查询</b>凭据状态（没有"列出全部凭据"的接口），
    所以页面先凑出候选<b>键名</b>（本机凭据文件 <code>refs:</code> 段 + 设置里 <code>*Env</code> / <code>*Ref</code> 引用的名字；<b>只读键名、不读值</b>），再逐个向 DSH 确认 —— 下面的「已配置 / 未配置」<b>全部以 DSH 返回为准</b>。
  </div>` : ''}

  ${d && refMissing.length ? `<div class="card mb">
    <h3>⚠️ 配置引用了、但还没配好（${refMissing.length}）<span class="tag err">会影响路由</span></h3>
    <div class="muted mb" style="font-size:11.5px">下面这些键名被设置引用，但 DSH 里查不到值——对应的供应商<b>不会参与模型路由</b>。点「写入」补上即可。</div>
    <table>
      <thead><tr><th>键名</th><th>状态</th><th>被谁引用</th><th>操作</th></tr></thead>
      <tbody>${refMissing.map(k => credRow(k, acts(k))).join('')}</tbody>
    </table>
  </div>` : ''}

  ${d ? `<div class="card mb">
    <h3>✅ 已配置的凭据（${confirmed.length}）</h3>
    ${confirmed.length ? `<table>
      <thead><tr><th>键名</th><th>状态</th><th>被谁引用</th><th>操作</th></tr></thead>
      <tbody>${confirmed.map(k => credRow(k, acts(k))).join('')}</tbody>
    </table>` : `<div class="empty">DSH 里还没有已配置的凭据<br>
      <span class="muted">本机凭据文件${local?.exists ? '里有 ' + localRefs.length + ' 个键名' : '不存在'}；要在本页新增，或点上方「按名查询」核对某个键名</span>
      <div class="mt"><button class="btn primary sm" onclick="setCredential('')">+ 新增凭据</button></div></div>`}
  </div>` : ''}

  ${d && (localOrphan.length || localBad.length) ? `<div class="card mb">
    <h3>📄 本机凭据文件里的其他键名（${localOrphan.length + localBad.length}）<span class="tag gray">没被任何配置引用</span></h3>
    <div class="muted mb" style="font-size:11.5px">这些名字来自 <code>~/.dsh/.credentials.yaml</code>，但设置里没有任何字段引用它们——通常是改了供应商配置后残留的旧键。</div>
    <table>
      <thead><tr><th>键名</th><th>状态</th><th>被谁引用</th><th>操作</th></tr></thead>
      <tbody>${localOrphan.map(k => credRow(k, acts(k))).join('')}
        ${localBad.map(n => `<tr>
          <td class="mono" style="font-size:12px">${fmt.esc(n)}</td>
          <td><span class="tag warn">名字不合约束</span></td>
          <td class="muted" style="font-size:11.5px">键名只能含字母、数字、下划线，且不以数字开头（否则无法通过接口读写）</td>
          <td>—</td></tr>`).join('')}</tbody>
    </table>
  </div>` : ''}

  ${d && localRecords.length ? `<div class="card mb">
    <h3>🗄️ 凭据文件里的内部记录（${localRecords.length}）<span class="tag gray">非用户凭据</span></h3>
    <div class="muted mb" style="font-size:11.5px">DSH 自身的会话/连接记录，不在本页管理。仅在 <code>.credentials.yaml</code> 的 <code>records:</code> 段出现：</div>
    <div style="display:flex;flex-wrap:wrap;gap:6px">${localRecords.map(n => `<span class="tag gray mono">${fmt.esc(n)}</span>`).join('')}</div>
  </div>` : ''}

  ${d ? `<div class="card mb">
    <h3>🏭 供应商 ↔ 它期望的凭据（${providers.length} 个候选）</h3>
    <div class="muted mb" style="font-size:11.5px">
      「期望凭据」= 该供应商的设置命名空间里声明的 <code>*Env</code> / <code>*Ref</code> 字段。
      候选有 ${providers.length} 个，但真正进了模型目录的由
      <a href="#/model">大模型</a> 页「供应商接入」列出——本页只回答"Key 配没配"。
    </div>
    <table>
      <thead><tr><th>供应商</th><th>显示名</th><th>设置命名空间</th><th>期望凭据</th><th>状态</th><th>操作</th></tr></thead>
      <tbody>${providers.map(p => {
        const want = (refs.byNs || {})[p.settingsNs] || [];
        const inl = (refs.inline || {})[p.settingsNs] || [];
        return `<tr>
          <td class="mono">${fmt.esc(p.provider)}</td>
          <td>${fmt.esc(p.displayName)}</td>
          <td class="mono muted" style="font-size:11.5px"><a href="#/settings">${fmt.esc(p.settingsNs || '—')}</a></td>
          <td>${want.length ? want.map(w => '<span class="mono" style="font-size:11.5px">' + fmt.esc(w.name) + '</span> <span class="muted" style="font-size:10.5px">' + fmt.esc(w.field) + '</span>').join('<br>')
            : '<span class="muted" style="font-size:11px">命名空间未声明 Key 字段</span>'}
            ${inl.length ? inl.map(s => '<br><span class="muted" style="font-size:10.5px">内嵌密文 ' + fmt.esc(s.path.join('.')) + '：' + (s.set ? '已设置' : '<b>未设置</b>') + '</span>').join('') : ''}</td>
          <td>${want.length ? want.map(w => creds[w.name]?.configured
              ? '<span class="tag ok">✅ 已配置</span>' : '<span class="tag err">⛔ 缺 Key</span>').join('<br>')
            : '<span class="muted">—</span>'}</td>
          <td>${want.length ? want.map(w => `<button class="btn sm" onclick="setCredential('${fmt.esc(w.name)}')">${creds[w.name]?.configured ? '更新' : '写入'}</button>`).join(' ')
            : '—'}</td>
        </tr>`;
      }).join('') || '<tr><td colspan="6" class="empty">未读取到供应商</td></tr>'}</tbody>
    </table>
    <div class="mt"><button class="btn primary sm" onclick="setCredential('')">+ 新增凭据（自定义键名）</button></div>
  </div>` : ''}`;
};

/* ============ 设置表单（schema 驱动）============
   settings.describe 每个命名空间都带 schema：
     { uid, refs:{ <id>:{ type, meta:{default,min,max,step,role,required}, value, list:[refId], inner:refId, dict:{字段:refId} } },
       dict:{ 字段名: refId } }
   把 refs 映射成控件，用户不必手写 JSON；提交仍走 settings.mutate 的增量 ops，
   未改动的字段不下发，避免误覆盖。 */
const SF = { draft: {} };            // key = ns|dotted.path
function sfKey(ns, path) { return ns + '|' + path; }
function sfRef(schema, id) { return (schema?.refs || {})[id]; }

/** 判定一个 ref 该用哪种控件 */
function sfKind(schema, ref) {
  if (!ref) return 'complex';
  const t = ref.type;
  if (t === 'const') return 'const';
  if (t === 'union' || t === 'enum') {
    const opts = (ref.list || []).map(id => sfRef(schema, id)).filter(Boolean);
    return opts.length && opts.every(o => o.type === 'const') ? 'select' : 'complex';
  }
  if (t === 'string') {
    if (ref.meta?.role === 'secret') return 'secret';
    if (ref.meta?.role === 'credential-ref') return 'credential';
    return 'text';
  }
  if (t === 'number') return 'number';
  if (t === 'boolean') return 'boolean';
  if (t === 'array') {
    const inner = sfRef(schema, ref.inner);
    return inner && (inner.type === 'string' || inner.type === 'number' || inner.type === 'boolean') ? 'list' : 'json';
  }
  if (t === 'object') return 'object';
  return 'json';
}

function sfSet(ns, path, raw, kind) {
  const k = sfKey(ns, path);
  if (raw === '__unset__') { SF.draft[k] = { ns, path: path.split('.'), op: 'unset' }; }
  else {
    let v = raw;
    if (kind === 'number') { v = Number(raw); if (Number.isNaN(v)) { UI.warn('请输入数字'); return; } }
    else if (kind === 'boolean') v = raw === 'true';
    else if (kind === 'list') v = raw.split(',').map(s => s.trim()).filter(Boolean);
    else if (kind === 'json') { try { v = JSON.parse(raw); } catch (e) { UI.warn('JSON 格式错误：' + e.message); return; } }
    SF.draft[k] = { ns, path: path.split('.'), op: 'set', value: v };
  }
  sfBarRefresh(ns);
}
function sfBarRefresh(ns) {
  const n = Object.values(SF.draft).filter(d => d.ns === ns).length;
  const bar = document.getElementById('sfbar-' + ns);
  if (bar) bar.innerHTML = n ? '<span class="tag warn">已暂存 ' + n + ' 项修改</span>'
                             : '<span class="muted" style="font-size:11.5px">未修改</span>';
  const btn = document.getElementById('sfsave-' + ns);
  if (btn) btn.disabled = !n;
}
function sfDiscard(ns) {
  for (const k of Object.keys(SF.draft)) if (SF.draft[k].ns === ns) delete SF.draft[k];
  render();
}
async function sfSave(ns) {
  const ops = Object.values(SF.draft).filter(d => d.ns === ns)
    .map(d => d.op === 'unset' ? { op: 'unset', path: d.path } : { op: 'set', path: d.path, value: d.value });
  if (!ops.length) return;
  const item = (State.settings?.namespaces || []).find(n => n.ns === ns);
  const ok = await UI.confirm({
    title: '保存 ' + ns,
    html: '将下发 <b>' + ops.length + '</b> 项增量修改：<pre class="mono" style="font-size:11px;margin-top:8px;max-height:220px;overflow:auto">'
      + fmt.esc(JSON.stringify(ops, null, 1)) + '</pre>',
    okText: '保存',
  });
  if (!ok) return;
  try {
    const payload = { ns, ops };
    if (item?.revision != null) payload.expectedRevision = item.revision;
    // mutate 会回传该命名空间的最新对象 → 并回本地，不走 loadSettings()（8s TTL 内它会回读旧值）
    mergeNsLocal(await API.call('settings.mutate', payload));
    for (const k of Object.keys(SF.draft)) if (SF.draft[k].ns === ns) delete SF.draft[k];
    applyTheme();          // ui-theme 也可能在这里被改（字号/外观都在这个命名空间）
    render();
    UI.ok('已保存 ' + ops.length + ' 项修改');
  } catch (e) { UI.err('保存失败：' + e.message); }
}

/** credential-ref 的候选来自凭据（credentials.describe 的真实结果） */
function sfCredList() {
  const c = State.credentials?.credentials || {};
  const names = Object.keys(c);
  return names.length ? '<datalist id="sfcreds">' + names.map(n => '<option value="' + fmt.esc(n) + '"></option>').join('') + '</datalist>' : '';
}

/** 渲染一个字段控件 */
function sfControl(ns, pathStr, schema, ref, cur, secretSet, depth) {
  const key = sfKey(ns, pathStr);
  const draft = SF.draft[key];
  const eff = draft ? (draft.op === 'unset' ? undefined : draft.value) : cur;
  const kind = sfKind(schema, ref);
  const meta = ref?.meta || {};
  const dirty = draft ? ' style="outline:2px solid var(--warn);outline-offset:1px"' : '';
  const on = (k, ev) => ev + '="sfSet(' + fmt.attr(ns) + ',' + fmt.attr(pathStr) + ',this.value,' + fmt.attr(k) + ')"';
  const numAttr = [meta.min != null ? 'min="' + meta.min + '"' : '', meta.max != null ? 'max="' + meta.max + '"' : '',
    meta.step != null ? 'step="' + meta.step + '"' : ''].join(' ');

  if (kind === 'const') return '<input value="' + fmt.esc(String(ref.value)) + '" disabled' + dirty + '>';
  if (kind === 'select') {
    const opts = (ref.list || []).map(id => sfRef(schema, id)).filter(o => o && o.type === 'const');
    return '<select' + on('select', 'onchange') + dirty + '>'
      + (meta.required ? '' : '<option value="__unset__"' + (eff === undefined ? ' selected' : '') + '>（未设置）</option>')
      + opts.map(o => '<option value="' + fmt.esc(String(o.value)) + '"'
          + (String(o.value) === String(eff ?? '') ? ' selected' : '') + '>' + fmt.esc(String(o.value)) + '</option>').join('')
      + '</select>';
  }
  if (kind === 'secret') return '<input type="password" placeholder="' + (secretSet ? '已设置，留空表示不改' : '未设置，输入新值') + '"'
    + on('text', 'oninput') + dirty + '>'
    + '<div class="muted" style="font-size:10.5px;margin-top:3px">只写字段：服务端只回传"是否已设置"，不回传明文</div>';
  if (kind === 'credential') return '<input list="sfcreds" value="' + fmt.esc(String(eff ?? '')) + '"' + on('text', 'oninput') + dirty + '>'
    + '<div class="muted" style="font-size:10.5px;margin-top:3px">引用凭据名（在「凭据」里维护）</div>';
  if (kind === 'number') return '<input type="number" ' + numAttr + ' value="' + fmt.esc(String(eff ?? '')) + '"' + on('number', 'oninput') + dirty + '>';
  if (kind === 'boolean') return '<select' + on('boolean', 'onchange') + dirty + '>'
    + ['true', 'false'].map(b => '<option value="' + b + '"' + (String(eff) === b ? ' selected' : '') + '>' + (b === 'true' ? '是' : '否') + '</option>').join('')
    + '</select>';
  if (kind === 'list') return '<input value="' + fmt.esc(Array.isArray(eff) ? eff.join(', ') : '') + '" placeholder="逗号分隔"' + on('list', 'oninput') + dirty + '>'
    + '<div class="muted" style="font-size:10.5px;margin-top:3px">默认值：' + fmt.esc(JSON.stringify(meta.default ?? [])) + '</div>';
  if (kind === 'object' && depth < 3) {
    const dict = ref.dict || {};
    const names = Object.keys(dict);
    if (!names.length) return '<span class="muted">空对象</span>';
    return '<table style="margin:0">' + names.map(fn => {
      const sub = sfRef(schema, dict[fn]);
      const subVal = (eff && typeof eff === 'object') ? eff[fn] : undefined;
      return '<tr>' + sfCell(fn, sub, subVal) + '<td>'
        + sfControl(ns, pathStr ? pathStr + '.' + fn : fn, schema, sub, subVal, secretSet && !pathStr, depth + 1) + '</td></tr>';
    }).join('') + '</table>';
  }
  // 复杂结构：JSON 文本框兜底（数组对象、联合类型、字典…）
  const shown = eff === undefined ? '' : JSON.stringify(eff, null, 1);
  return '<textarea rows="3" placeholder="JSON"' + on('json', 'oninput') + dirty + '>' + fmt.esc(shown) + '</textarea>'
    + '<div class="muted" style="font-size:10.5px;margin-top:3px">' + fmt.esc(ref.type) + ' 类型，按 JSON 填写'
    + (meta.default !== undefined ? '；默认 ' + fmt.esc(JSON.stringify(meta.default)).slice(0, 80) : '') + '</div>';
}
function sfCell(name, ref, val) {
  const meta = ref?.meta || {};
  const badges = (meta.required ? '<span class="tag err" style="font-size:9.5px">必填</span>' : '')
    + (meta.role ? '<span class="tag warn" style="font-size:9.5px">' + fmt.esc(meta.role) + '</span>' : '')
    + (val === undefined ? '<span class="tag gray" style="font-size:9.5px">未设置</span>' : '');
  return '<td style="width:230px;vertical-align:top">' + fmt.esc(name) + ' ' + badges + '</td>';
}

/** 一个命名空间的完整表单 */
function settingsForm(n) {
  const schema = n.schema;
  // schema 的形状是 { uid, refs }：根节点的字段表在 refs[uid].dict 里，不在 schema.dict 上
  const root = schema && schema.refs ? schema.refs[schema.uid] : null;
  if (!root || !root.dict) return '<div class="empty">该命名空间没有可渲染的 schema，请用下方 JSON 方式编辑</div>';
  const secList = n.secrets || [];
  const value = (n.value && typeof n.value === 'object') ? n.value : {};
  const names = Object.keys(root.dict);
  const rows = names.map(fn => {
    const ref = sfRef(schema, root.dict[fn]);
    const cur = value[fn];
    const isSet = secList.some(s => (s.path || []).join('.') === fn && s.set);
    return '<tr>' + sfCell(fn, ref, cur) + '<td>' + sfControl(n.ns, fn, schema, ref, cur, isSet, 0) + '</td></tr>';
  }).join('');
  return sfCredList() + '<table style="margin-top:4px"><tbody>' + rows + '</tbody></table>'
    + '<div class="mt" style="display:flex;gap:8px;align-items:center">'
    + '<button class="btn sm primary" id="sfsave-' + n.ns + '" onclick="sfSave(' + fmt.attr(n.ns) + ')" disabled>保存修改</button>'
    + '<button class="btn sm" onclick="sfDiscard(' + fmt.attr(n.ns) + ')">放弃修改</button>'
    + '<span id="sfbar-' + n.ns + '"><span class="muted" style="font-size:11.5px">未修改</span></span>'
    + '</div>';
}

/* ============ 设置（settings.*） ============ */
/* 每个命名空间的一句话说明（消除"改了会影响谁"的歧义）：
 * 前三类是**新会话的出厂默认值**——只决定新会话从什么状态开始，已有会话不受影响；
 * 会话级覆盖入口写在说明里。其余是全局运行参数/界面偏好，改了立即对所有会话生效。 */
const NS_HINT = {
  'agent-default-model':        '新会话的<b>默认模型与推理强度</b>。已有会话不受影响——改单个会话用时空智能体侧栏「🧠 模型」或会话列表「切模型」',
  'agent-presets':              '新会话的<b>默认智能体预设</b>。已有会话不受影响——切单个会话用时空智能体侧栏「🧭 智能体预设」；智能体预设清单本身在「智能体预设」页管理',
  'permission':                 '新会话的<b>默认权限模式</b>。已有会话不受影响——改单个会话用时空智能体侧栏「🛡️ 审批」区的权限模式下拉',
  'subagent-model-selection':   '子代理可用的<b>模型白名单</b>（授权后子代理才能用对应模型）。全局生效，影响所有会话派生的子代理',
  'agent-loop':                 '每步<b>并行工具调用上限</b>（如同时跑几条命令）。全局生效，影响所有会话的执行节奏',
  'shell':                      '命令执行的<b>超时与输出上限</b>。全局生效——所有会话里跑命令的工具调用都受它约束',
  'llm-deepseek':               'DeepSeek 供应商<b>参数表</b>（模型清单 / 上下文窗口 / maxTokens / API key 来源）。「大模型」页的可用模型目录来自这里',
  'llm-pi-ai':                  '其他自定义供应商的<b>参数表</b>。同上，喂给「大模型」页的模型目录',
  'web-search-deepseek':        '联网搜索工具的<b>模型与次数上限</b>。全局生效，影响所有会话的搜索工具',
  'ui-theme':                   '控制台<b>主题与字号</b>。纯界面偏好，与任何会话数据无关',
  'locale':                     '界面<b>语言</b>。纯界面偏好',
  'ui-onboarding':              '引导提示的<b>已读版本号</b>（控制首页公告是否再弹）。与业务无关',
  'ui-conversation':            '智能体<b>忙时按 Enter 的行为</b>（当前=排队进消息队列）。全局生效——决定时空智能体页消息队列的进入方式',
  'ui-chat':                    '聊天记录的<b>视图密度</b>（compact）。纯界面偏好',
};
/** 懒渲染命名空间的 schema。
 *  设置页有 14 个命名空间、每个 schema 截断后还有 2KB JSON —— 一次性全铺开相当于给页面多加
 *  3 万多个字符的文本节点，是这一页最重的一块（渲染规模排行里设置页常年第一）。
 *  改成点击后按需渲染：骨架先出来，要看细节再点。再点一次收起。 */
function showNsSchema(ns) {
  const el = document.getElementById('nsjson-' + ns);
  if (!el) return;
  if (el.dataset && el.dataset.loaded === '1') { el.innerHTML = ''; el.dataset.loaded = ''; return; }
  const n = (State.settings?.namespaces || []).find(x => x.ns === ns);
  if (!n) { el.innerHTML = '<div class="muted" style="font-size:11.5px">没找到命名空间 ' + fmt.esc(ns) + '</div>'; return; }
  el.innerHTML = '<pre class="mono" style="font-size:11px;overflow:auto;max-height:220px;background:var(--inset-solid);padding:10px;border-radius:6px;margin:0">'
    + fmt.esc((JSON.stringify(n.schema, null, 1) || '（该命名空间未返回 schema）').slice(0, 4000)) + '</pre>';
  if (el.dataset) el.dataset.loaded = '1';
}

Pages.settings = () => {
  const d = State.settings;
  const ns = d?.namespaces || [];
  const changed = ns.filter(n => !sameJson(n.value, n.base));
  return `
  <div class="page-title"><h2>设置</h2>
    <span class="sub">${ns.length} 个配置命名空间 · 全局生效（~/.dsh/settings.yaml） · ${changed.length} 个被用户覆盖${scopeTag('global')}</span>
    <span class="pt-actions">
      ${platformSwitches()}
      <button class="btn sm" onclick="openSettingsDoc()">打开配置文件</button>
      <button class="btn sm" onclick="loadSettings(true)">刷新</button>
      
    </span>
  </div>
  ${crumbOf('settings')}
  ${pageHelp('settings')}
  
    ${stampText('settings')}
  ${uiPrefsCard()}

  ${!d ? '<div class="card"><div class="empty"><span class="loading"></span> 读取中…</div></div>' : ''}
  ${d ? `<div class="alert ${d.writable ? 'info' : 'err'}">
    配置文件 ${d.writable ? '<b>可写</b>' : '<b>只读</b>'} · ${d.hasDocument ? '用户文档已存在' : '尚无用户文档'}
    · 位置 <code>~/.dsh/settings.yaml</code></div>` : ''}
  ${d ? `<div class="alert info">
    本页配置的是 <b>DSH 全局设置</b>，分三类，改了立即生效（<code>applies=live</code>）：<br>
    ① <b>新会话的出厂默认值</b>（agent-default-model / agent-presets / permission）——只决定<b>新</b>会话从什么状态开始，<b>已有会话完全不受影响</b>；要改当前会话请用时空智能体侧栏，不要改这里<br>
    ② <b>执行环境参数</b>（llm-* / web-search-* / shell / agent-loop / subagent-model-selection）——立即影响<b>所有会话</b>的模型目录、工具与子代理行为<br>
    ③ <b>界面偏好</b>（ui-* / locale）——只影响本控制台显示</div>` : ''}

  ${ns.map(n => {
    const isChanged = !sameJson(n.value, n.base);
    return `
    <div class="card mb">
      <h3>⚙️ ${fmt.esc(n.ns)} ${isChanged ? '<span class="tag ok">已覆盖</span>' : '<span class="tag gray">默认</span>'}
        <span class="tag gray" style="font-size:10.5px">${n.applies || '—'}</span></h3>
      ${NS_HINT[n.ns] ? `<div class="muted" style="font-size:11.5px;margin:6px 0 2px">${NS_HINT[n.ns]}</div>` : ''}
      <table>
        <tr><td>当前值</td><td class="mono" style="font-size:11.5px;word-break:break-all">${fmt.esc(JSON.stringify(n.value))}</td></tr>
        ${n.base !== undefined ? `<tr><td>基线值</td><td class="mono muted" style="font-size:11.5px;word-break:break-all">${fmt.esc(JSON.stringify(n.base))}</td></tr>` : ''}
        <tr><td>版本 revision</td><td>${n.revision ?? '—'}</td></tr>
        ${(n.secrets || []).length ? `<tr><td>敏感字段</td><td>${n.secrets.map(s => '<span class="tag warn">' + fmt.esc((s.path || []).join('.')) + (s.set ? ' 已设置' : ' 未设置') + '</span>').join(' ')}</td></tr>` : ''}
      </table>
      <details style="margin-top:10px" open><summary class="muted" style="cursor:pointer;font-size:12px">📝 表单编辑（按 settings schema 生成控件）</summary>
        <div style="margin-top:10px">${settingsForm(n)}</div>
      </details>
      <details style="margin-top:8px"><summary class="muted" style="cursor:pointer;font-size:12px">🧾 高级：查看 schema / 直接改 JSON</summary>
        <div class="mt" style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn sm" onclick="showNsSchema('${fmt.esc(n.ns)}')" title="按需渲染该命名空间的 schema（默认不渲染：14 个命名空间全铺开会让这页多出上万个文本节点）">查看 schema</button>
          <button class="btn sm" onclick="editSetting('${fmt.esc(n.ns)}')">整段替换（JSON）</button>
          <button class="btn sm" onclick="patchSetting('${fmt.esc(n.ns)}')">增量修改（路径 ops）</button>
          <button class="btn sm" onclick="replaceSetting('${fmt.esc(n.ns)}')" title="覆盖整个命名空间的配置">整体覆盖</button>
        </div>
        <div id="nsjson-${fmt.esc(n.ns)}"></div>
      </details>
    </div>`;
  }).join('') || (d ? '<div class="empty">没有可配置的命名空间</div>' : '')}`;
};

/* ============ 工作空间（workspace.*） ============ */
/* ---------- 工作区文件树（workspaceFiles/*，对齐原生 sidebar-files）----------
   对齐报告定的方案：文件浏览做进「工作空间」页的内嵌卡片，不新开页。
   作用域是**当前会话**（workspaceFileScopeId=SessionId），所以切会话后要重取；
   目录列表按 path 缓存进 State.ftree.dirs，展开/收起/预览只改 State 后
   paintOnly 重绘 —— 不重跑加载器，也不会把已取到的列表冲掉。 */
async function loadWorkspaceFiles() {
  if (!State.sessionId) return false;
  if (State.ftree.scopeSession === State.sessionId && State.ftree.dirs['']) return false;   // 已取过
  State.ftree.scopeSession = State.sessionId;
  State.ftree.dirs = {}; State.ftree.expanded = {}; State.ftree.preview = null; State.ftree.error = null;
  // ⚠️ 实测：首次 list 必须传会话 cwd（绝对路径）标识 scope 根；传 '' 会被 DSH 拒绝（path is required）
  const cwd = currentSession().cwd;
  if (!cwd) { State.ftree.error = null; State.ftree.noCwd = true; return true; }
  try { State.ftree.dirs[''] = await API.call('files.list', { path: cwd }); }
  catch (e) { State.ftree.error = e.message; }
  return true;
}
async function ftreeReload() {
  State.ftree.scopeSession = null;
  await loadWorkspaceFiles();
  render({ paintOnly: true });
}
/** 子路径拼接：跟宿主的目录分隔符走（Windows 是 \），以 list 返回的规范化 path 为准 */
function ftreeJoin(listing, name) {
  const base = (listing && listing.path) || '';
  if (!base) return name;
  const sep = base.includes('\\') ? '\\' : '/';
  return base.endsWith(sep) ? base + name : base + sep + name;
}
function ftreeEntriesHtml(dirKey, listing, depth) {
  const pad = 'padding-left:' + (depth * 14 + 4) + 'px';
  if (!listing) return '';
  if (listing.error) return '<div class="muted" style="font-size:11.5px;' + pad + '">读取失败：' + fmt.esc(listing.error) + '</div>';
  const es = listing.entries || [];
  if (!es.length) return '<div class="muted" style="font-size:11.5px;' + pad + '">（空目录）</div>';
  return es.map(e => {
    const p = ftreeJoin(listing, e.name);
    if (e.type === 'directory') {
      const open = !!State.ftree.expanded[p];
      return '<div>'
        + '<div class="ftree-row" style="' + pad + '" onclick="ftreeToggle(' + fmt.attr(p) + ')">'
        + '<span class="ftree-tw">' + (open ? '▾' : '▸') + '</span>📁 <span>' + fmt.esc(e.name) + '</span></div>'
        + (open ? ftreeEntriesHtml(p, State.ftree.dirs[p], depth + 1) : '') + '</div>';
    }
    return '<div class="ftree-row" style="padding-left:' + (depth * 14 + 22) + 'px" onclick="ftreePreview(' + fmt.attr(p) + ')" title="点击预览">'
      + '📄 <span>' + fmt.esc(e.name) + '</span>'
      + (e.size != null ? ' <span class="muted" style="font-size:10.5px">' + fmt.bytes(e.size) + '</span>' : '') + '</div>';
  }).join('');
}
async function ftreeToggle(path) {
  const ex = State.ftree.expanded;
  if (ex[path]) { delete ex[path]; return render({ paintOnly: true }); }
  ex[path] = true;
  if (!State.ftree.dirs[path]) {
    try { State.ftree.dirs[path] = await API.call('files.list', { path }); }
    catch (e) { State.ftree.dirs[path] = { entries: [], error: e.message }; }
  }
  render({ paintOnly: true });
}
/** 文本预览：workspaceFiles/read 是行窗口（{offset,limit}），先取 400 行；
 *  读不动（二进制等）就退回 stat，只给元数据 —— 对齐原生 documentpreview 的降级行为。 */
async function ftreePreview(path) {
  State.ftree.preview = { path, loading: true };
  render({ paintOnly: true });
  try {
    // ⚠️ 实测：read 的行窗口 offset 从 1 起（0 会被边界拒绝）
    const v = await API.call('files.read', { path, offset: 1, limit: 400 });
    State.ftree.preview = { path, text: v.text, eof: v.eof, lines: v.lines, abs: v.absolutePath, bytes: v.bytes };
  } catch (e) {
    let stat = null;
    try { stat = await API.call('files.stat', { path }); } catch {}
    State.ftree.preview = { path, error: e.message, stat };
  }
  render({ paintOnly: true });
}
function ftreeClosePreview() { State.ftree.preview = null; render({ paintOnly: true }); }
function ftreePreviewHtml() {
  const pv = State.ftree.preview;
  if (!pv) return '';
  if (pv.loading) return '<div class="mt"><div class="empty"><span class="loading"></span> 读取 ' + fmt.esc(pv.path) + ' …</div></div>';
  const head = '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">'
    + '<b class="mono" style="font-size:11.5px;word-break:break-all">' + fmt.esc(pv.path) + '</b>'
    + (pv.abs ? '<button class="btn sm" onclick="openLocalPath(' + fmt.attr(pv.abs) + ')">打开</button>' : '')
    + '<button class="btn sm" style="margin-left:auto" onclick="ftreeClosePreview()">收起</button></div>';
  if (pv.error) {
    const st = pv.stat || {};
    return '<div class="mt" style="border-top:1px solid var(--line);padding-top:10px">' + head
      + '<div class="alert err">无法按文本读取（可能是二进制文件）：' + fmt.esc(pv.error) + '</div>'
      + (st.absolutePath ? '<table><tr><td>绝对路径</td><td class="mono" style="font-size:11.5px">' + fmt.esc(st.absolutePath) + '</td></tr>'
        + (st.bytes != null ? '<tr><td>大小</td><td>' + fmt.bytes(st.bytes) + '</td></tr>' : '') + '</table>' : '') + '</div>';
  }
  return '<div class="mt" style="border-top:1px solid var(--line);padding-top:10px">' + head
    + (pv.bytes != null ? '<div class="muted" style="font-size:11px;margin-bottom:4px">' + fmt.bytes(pv.bytes) + ' · 前 ' + pv.lines + ' 行' + (pv.eof ? '（全文）' : '，未完') + '</div>' : '')
    + '<pre class="mono" style="max-height:420px;overflow:auto;font-size:11.5px;background:var(--panel-2);padding:10px;border-radius:8px;white-space:pre-wrap;word-break:break-all">' + fmt.esc(pv.text || '') + '</pre></div>';
}

Pages.workspace = () => {
  const d = State.workspaces;
  const ws = d?.items || [];
  const archived = d?.archivedSessionIds || [];
  const sess = State.sessions || [];
  /* 归属关系（实测原生 DSH）：一对多 —— workspace {workspaceId,path,title,sessionIds[]},
     会话同一时刻**最多属于一个**空间（insertSessionBefore 是"移动"不是"共享"），
     归档(archivedSessionIds)后不属于任何空间。所以"当前会话 → 所在空间"是单值，可直接标出。 */
  const cur = State.sessionId;
  const curWs = cur ? ws.find(w => (w.sessionIds || []).includes(cur)) : null;
  const curSess = sess.find(s => s.sessionId === cur);
  /* ---- 未分组桶（逐条对齐原生 dsh-client-ui-workspace 的 groupByWorkspace）----
   * 用户问"原生那个未命名工作空间的路径是什么"——**没有路径，它根本不是工作空间**：
   *   ① 常量 `UNGROUPED_KEY = ""`（上游 lib/types/client/tree.d.ts）；
   *   ② 桶是 `buildGroup("", void 0, void 0, void 0, "", members, "recency")` ——
   *      workspaceId / path / createdAt **全是 undefined**，没有悬停卡也没有菜单，纯客户端虚拟分组；
   *   ③ 成员 = "不被任何 workspace.sessionIds 认领、且未归档的会话"，按 updatedAt 倒序（原生 "recency"）；
   *   ④ 只有 stray 非空时才出现（`if (stray.length > 0)`）；
   *   ⑤ 本地化文案是 **`group.ungrouped` = 「未分组」**（不是"未命名"）。
   * 所以**删除工作空间不需要"搬会话"**：会话本来就只是从分组里被释放，自动落到这里。
   *   （原生删除确认文案：将把“X”从工作区列表中移除。文件夹与会话记录会保留，其会话将显示在“未分组”下。）
   * 子代理会话不进这个桶：原生把它们嵌在父会话行下面（`descendants`），不是独立分组行。 */
  const accounted = new Set(ws.flatMap(w => w.sessionIds || []));
  const archSet = new Set(archived);
  const stray = sess
    .filter(s => s.origin !== 'subagent' && !accounted.has(s.sessionId) && !archSet.has(s.sessionId))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return `
  <div class="page-title"><h2>工作空间</h2>
    <span class="sub">空间列表全局共享${scopeTag('global')} · 当前会话所在空间已标出 · 页内「📁 工作目录文件」跟随当前会话${scopeTag('session')}</span>
    <span class="pt-actions">
      <button class="btn sm" onclick="loadWorkspaces(true)">刷新</button>
      <button class="btn sm primary" onclick="createWorkspace()">+ 新建空间</button>
      
    </span>
  </div>
  ${crumbOf('workspace')}
  ${pageHelp('workspace')}
  
    ${stampText('workspaces')}

  ${cur && !curWs ? `<div class="alert info">当前会话 <span class="mono">${fmt.esc(String(cur).slice(0, 18))}…</span>${curSess?.origin === 'subagent' ? '是<b>子代理会话</b>，随父会话活动、不挂在工作空间下' : '不属于任何工作空间 —— 见下方<b>「未分组」</b>（新建的、以及从已删除空间里释放出来的会话都在那儿）'}。</div>` : ''}
  <div class="alert info">
    <b>工作空间 ≠ 工作目录</b>：空间是会话的<b>分组容器</b>（可排序、可归档）；工作目录（cwd）是会话的<b>文件系统路径</b>，决定项目级能力的作用域。一个空间装多个会话，一个会话同一时刻只属于一个空间。
  </div>

  ${State.sessionId ? `<div class="card mb">
    <h3>📁 工作目录文件 <span class="tag gray">当前会话作用域</span>
      <button class="btn sm" style="margin-left:auto" onclick="ftreeReload()">刷新</button></h3>
    <div class="muted mb" style="font-size:11.5px">📦 只看会话产出的文件？<a href="#/deliverables">交付物 → 工作目录成果</a> 已按修改时间排好。</div>
    ${State.ftree.error ? '<div class="alert err">读取失败：' + fmt.esc(State.ftree.error) + '</div>' : ''}
    ${State.ftree.noCwd ? '<div class="muted" style="font-size:12px">当前会话没有工作目录（cwd），无法列出文件。</div>'
      : State.ftree.dirs[''] ? `<div style="max-height:420px;overflow:auto">${ftreeEntriesHtml('', State.ftree.dirs[''], 0)}</div>`
      : (State.ftree.error ? '' : '<div class="empty"><span class="loading"></span> 读取中…</div>')}
    ${ftreePreviewHtml()}
  </div>` : ''}

  ${!d ? '<div class="card"><div class="empty"><span class="loading"></span> 读取中…</div></div>' : ''}
  ${ws.map(w => {
    const ids = w.sessionIds || [];
    const isCurWs = !!cur && ids.includes(cur);
    return `
    <div class="card mb${isCurWs ? ' cur-ws' : ''}">
      <h3>🗂️ ${fmt.esc(w.title || w.path)} ${isCurWs ? '<span class="tag ok">📍 当前会话所在</span>' : ''}<span class="tag gray">${ids.length} 个会话</span>
        ${ws.length > 1 ? `<button class="btn sm" style="margin-left:auto" onclick="moveWorkspace('${fmt.esc(w.workspaceId)}')">上移</button>` : '<span style="margin-left:auto"></span>'}
        <button class="btn sm" onclick="renameWorkspace('${fmt.esc(w.workspaceId)}','${fmt.esc(w.title || w.path)}')">重命名</button>
        <button class="btn sm" onclick="deleteWorkspace('${fmt.esc(w.workspaceId)}','${fmt.esc(w.title || w.path)}')">删除</button>
      </h3>
      <table>
        <tr><td>空间 ID</td><td class="mono" style="font-size:11.5px">${fmt.esc(w.workspaceId)}</td></tr>
        <tr><td>绑定路径</td><td class="mono" style="font-size:11.5px">${fmt.esc(w.path)}</td></tr>
        <tr><td>创建 / 更新</td><td class="muted">${fmt.time(new Date(w.createdAt).getTime())} · ${fmt.ago(new Date(w.updatedAt).getTime())}</td></tr>
      </table>
      <div class="mt muted mb">包含会话：</div>
      <table>
        <thead><tr><th>会话</th><th>标题</th><th>状态</th><th>操作</th></tr></thead>
        <tbody>${ids.map(id => {
          const s = sess.find(x => x.sessionId === id);
          const isCur = id === cur;
          return `<tr${isCur ? ' style="background:rgba(47,123,255,.08)"' : ''}>
            <td class="mono" style="font-size:11.5px">${fmt.esc(id.slice(0,26))}…</td>
            <td>${sessionTitleHtml(s, 200)}${isCur ? ' <span class="tag ok" style="font-size:10px">当前</span>' : ''}</td>
            <td>${s?.running ? '<span class="tag ok">运行中</span>' : '<span class="tag gray">空闲</span>'}</td>
            <td>
              ${isCur ? '' : `<button class="btn sm" onclick="setCurrentSession('${fmt.esc(id)}')">设为当前</button>`}
              <button class="btn sm" onclick="moveSession('${fmt.esc(w.workspaceId)}','${fmt.esc(id)}')">上移</button>
              <button class="btn sm" onclick="archiveSession('${fmt.esc(w.workspaceId)}','${fmt.esc(id)}')">归档</button>
            </td></tr>`;
        }).join('')}</tbody>
      </table>
    </div>`;
  }).join('')}

  ${stray.length ? `
  <div class="card mb">
    <h3>🗂️ 未分组 <span class="tag gray">${stray.length} 个会话</span></h3>
    <div class="muted mb" style="font-size:11.5px">
      ⚠️ 这<b>不是一个真实工作空间</b>：没有绑定路径，也不能重命名 / 删除 / 排序。
      凡是「不属于任何空间、且未归档」的会话都落在这里，按最近活动倒序。
      <b>删除工作空间后，其会话就回到这里</b> —— 文件夹与会话记录都会保留。
    </div>
    <table>
      <thead><tr><th>会话</th><th>标题</th><th>状态</th><th>最后活动</th><th>操作</th></tr></thead>
      <tbody>${stray.map(s => {
        const id = s.sessionId, isCur = id === cur;
        return `<tr${isCur ? ' style="background:rgba(47,123,255,.08)"' : ''}>
          <td class="mono" style="font-size:11.5px">${fmt.esc(id.slice(0,26))}…</td>
          <td>${sessionTitleHtml(s, 200)}${isCur ? ' <span class="tag ok" style="font-size:10px">当前</span>' : ''}</td>
          <td>${s.running ? '<span class="tag ok">运行中</span>' : '<span class="tag gray">空闲</span>'}</td>
          <td class="muted" style="font-size:11.5px">${fmt.ago(s.updatedAt)}</td>
          <td>
            ${isCur ? '' : `<button class="btn sm" onclick="setCurrentSession('${fmt.esc(id)}')">设为当前</button>`}
            <button class="btn sm" onclick="archiveSession('','${fmt.esc(id)}')">归档</button>
          </td></tr>`;
      }).join('')}</tbody>
    </table>
  </div>` : ''}

  ${archived.length ? `<div class="card"><h3>📦 已归档会话（${archived.length}）</h3>
    <div style="display:flex;flex-wrap:wrap;gap:6px">${archived.map(id => `<span class="tag gray mono" style="font-size:11px">${fmt.esc(id.slice(0,26))}…</span>`).join('')}</div>
  </div>` : ''}`;
};

/* ============ 目标（goal.*） ============ */
/** 目标相位的原生标签（dsh-client-ui-goal 的 phase.* 文案，逐字对齐）。
 *  ⚠️ complete **没有标签**：原生对已完成的目标整条不渲染 —— 见 goalPhaseLabel 的注释。 */
const GOAL_PHASE_LABEL = {
  active: '进行中的目标', paused: '已暂停的目标', blocked: '受阻的目标', complete: '已完成的目标',
};
/** 相位 → 中文标签。active 且未运行（activation=disarmed）时用原生的「未运行的目标」。 */
function goalPhaseLabel(g) {
  if (!g) return '—';
  if (g.phase === 'active' && g.activation === 'disarmed') return '未运行的目标';
  return GOAL_PHASE_LABEL[g.phase] || String(g.phase || '—');
}
/** 目标动作的**前置校验**：按钮在页面上能不能点、点了宿主会不会收。
 *  权威依据（dsh-goal/lib/index.js 的服务实现，逐条核对过）：
 *    · resume  : 相位 ∈ {active, paused, blocked}；active 且 armed 不行；roundsStarted ≥ maxGoalRounds 不行
 *    · pause   : 相位必须是 active
 *    · complete: 相位 ∈ {active, paused, blocked}（complete → complete 被拒）
 *    · edit    : **任意相位都行**（fold 只要求 edit 不改相位；complete 也能改目标描述/轮次上限）
 *    · clear   : 任意相位
 *    · create  : 当前无目标，或当前目标已 complete（其余相位要先清除）
 *  ⚠️ activation 是**进程本地**状态，投影里刻意没有 —— 拿不到时按"未知"处理：
 *     不因为不知道就提前拦（拦错了用户点不了本来能点的按钮），交给宿主裁决，再把拒绝翻成人话。 */
function goalActionState(action, g) {
  const info = g && g.goal;
  if (!info) return { can: false, why: '当前会话没有目标' };
  const act = info.activation;
  const rounds = Number(g.roundsStarted), max = Number(info.maxGoalRounds);
  const exhausted = Number.isFinite(rounds) && Number.isFinite(max) && rounds >= max;
  switch (action) {
    case 'resume':
      if (info.phase === 'complete') return { can: false, why: '已完成的目标无法恢复（宿主只接受 active / paused / blocked）。要继续推进请新建一个目标。' };
      if (info.phase === 'active' && act === 'armed') return { can: false, why: '目标正在自动推进（armed），无需恢复。' };
      if (exhausted) return { can: false, why: '无法恢复：已推进 ' + rounds + ' 轮，达到上限 ' + max + ' 轮。请先「编辑目标」调高轮次上限，或清除后新建。' };
      return { can: true, why: '' };
    case 'pause':
      if (info.phase !== 'active') return { can: false, why: '只有进行中的目标可以暂停（当前：' + goalPhaseLabel(info) + '）。' };
      return { can: true, why: '' };
    case 'complete':
      if (info.phase === 'complete') return { can: false, why: '目标已经是完成状态。' };
      if (info.phase !== 'active' && info.phase !== 'paused' && info.phase !== 'blocked')
        return { can: false, why: '未知相位 ' + info.phase };
      return { can: true, why: '' };
    case 'edit':
      return { can: true, why: '' };        // 宿主允许在任意相位编辑（包括 complete）
    case 'clear':
      return { can: true, why: '' };
    default:
      return { can: false, why: '未知操作 ' + action };
  }
}
/** 兼容旧名（回归脚本与历史调用还在用）：只关心「恢复」这一颗按钮 */
function goalResumeState(g) { return goalActionState('resume', g && g.goal ? g : (g ? { goal: g } : null)); }
Pages.goal = () => {
  const g = State.goal;
  const has = g && g.goal;
  const info = has ? g.goal : null;
  // 每颗按钮都先过一遍宿主的前置校验：能点的才画，不能点的把原因写在按钮位置
  const act = (a) => goalActionState(a, g);
  const rs = act('resume');
  const exhausted = !!info && Number(g.roundsStarted) >= Number(info.maxGoalRounds);
  const btn = (a, label, primary, extra) => {
    const st = act(a);
    if (!st.can) return '';                       // 点了必被宿主拒绝的按钮：不画
    return '<button class="btn sm' + (primary ? ' primary' : '') + '" onclick="goalAction(\'' + a + '\')"'
      + (extra || '') + ' title="' + fmt.h(st.why || label) + '">' + label + '</button>';
  };
  return `
  <div class="page-title"><h2>目标</h2>
    <span class="sub">跨轮次自动推进的长期目标 · 当前会话状态${scopeTag('session')}</span>
    <span class="pt-actions">
      <button class="btn sm" onclick="refreshGoal(true)">刷新</button>
      
    </span>
  </div>
  ${crumbOf('goal')}
  ${pageHelp('goal')}
  

  ${!has ? `<div class="card">
      <div class="empty" style="padding:34px 20px">
        <div style="font-size:34px;margin-bottom:10px">🎯</div>
        当前会话没有活跃目标
        <div class="mt"><button class="btn primary" onclick="createGoal()">新建目标</button></div>
      </div>
      <div style="border-top:1px solid var(--line);padding-top:14px">
        <h3>💡 目标（Goal）是什么</h3>
        <p class="muted" style="font-size:12px;line-height:1.8">
          <b>目标</b>是 DSH 的<b>跨轮次自动推进机制</b>：一个目标可以跨越多次对话轮次持续存在，
          DSH 在每轮结束后自动判断是否继续推进，直到目标完成或达到轮次上限。与会话的一次性提问不同，
          目标适合"长期任务"——例如"把这份数据全部质检一遍"。
        </p>
        <table class="mt">
          <tr><td style="width:130px">生命周期</td><td class="muted">创建 → 自动推进（最多 N 轮）→ 完成 / 阻塞 / 手动清除</td></tr>
          <tr><td>状态</td><td>${['active','paused','blocked','complete'].map(x=>'<span class="tag gray" style="font-size:10.5px">'+x+'</span>').join(' ')}</td></tr>
          <tr><td>与会话的关系</td><td class="muted">一个会话同时只有一个活跃目标</td></tr>
          <tr><td>当前会话</td><td class="muted">无活跃目标 · 可通过上方按钮创建</td></tr>
        </table>
      </div>
      ${emptyGuide('goal')}
    </div>`
  : `<div class="card">
      <h3>🎯 ${fmt.esc(info.objective)}
        <span class="tag ${info.phase === 'active' ? (info.activation === 'armed' ? 'ok' : 'warn') : info.phase === 'paused' ? 'warn' : info.phase === 'blocked' ? 'err' : 'gray'}">${fmt.esc(goalPhaseLabel(info))}</span>
        <span class="muted mono" style="font-size:11px;font-weight:400">${fmt.esc(info.phase)}</span>
      </h3>
      <table>
        <tr><td>目标 ID</td><td class="mono" style="font-size:11.5px">${fmt.esc(info.id)}</td></tr>
        <tr><td>版本 revision</td><td>${info.revision}</td></tr>
        <tr><td>自动推进</td><td>${info.activation === 'armed'
          ? '<span class="tag ok">armed</span> <span class="muted" style="font-size:11.5px">本轮结束后会自动继续推进</span>'
          : info.activation === 'disarmed'
          ? '<span class="tag gray">disarmed</span> <span class="muted" style="font-size:11.5px">不会自动推进（需手动恢复）</span>'
          : '<span class="muted" title="activation 是宿主进程本地状态，本会话未上报过该事件；以宿主实际裁决为准">—</span>'}</td></tr>
        <tr><td>已推进轮次</td><td class="mono">${g.roundsStarted ?? '—'} / ${info.maxGoalRounds}${exhausted ? ' <span class="tag err" style="font-size:10px">轮次已用尽</span>' : ''}</td></tr>
        <tr><td>创建时间</td><td class="muted">${fmt.time(g.createdAt)}</td></tr>
        <tr><td>更新时间</td><td class="muted">${fmt.ago(g.updatedAt)}</td></tr>
        ${info.blockedReason ? `<tr><td>阻塞原因</td><td class="muted">${fmt.esc(info.blockedReason.message || JSON.stringify(info.blockedReason))}</td></tr>` : ''}
      </table>
      <div class="mt" style="display:flex;gap:8px;flex-wrap:wrap">
        ${btn('resume', '恢复', true, exhausted ? ' disabled' : '')}
        ${btn('pause', '暂停')}
        ${btn('complete', '标记完成')}
        ${btn('edit', '编辑目标')}
        ${btn('clear', info.phase === 'complete' ? '清除这个目标' : '清除')}
        ${!rs.can && rs.why ? `<span class="muted" style="font-size:11.5px;align-self:center">${fmt.esc(rs.why)}</span>` : ''}
        ${info.phase === 'complete' ? '<button class="btn sm" onclick="createGoal()">新建目标</button>' : ''}
      </div>
      <p class="muted mt" style="font-size:11.5px">⚠️ 这些操作会真实修改会话目标。
        <br>相位说明：<b>active</b> 自动推进 → 可暂停/标记完成；<b>paused / blocked</b> 可恢复；
        <b>complete</b> <b>不可恢复</b>（宿主只接受 active / paused / blocked 三态），要继续推进请新建目标；
        <b>编辑</b>任何相位都可以（宿主只要求编辑不改变相位）。</p>
    </div>`}`;
};


/* ============ 后台作业 / 审批 / 提问 / 消息队列 ============ */

/* ---------- 智能体提问卡片 ----------
   数据来自 $events 的 user-questions/request（Stream.onForwarded 收进 State.questions）。
   两个渲染出口共用这一份模板：
   1. 对话页（#chatquestions，renderChatQuestions() 直接写 DOM）——
      对齐原生 QuestionComposer 的「composer 接管」：提问卡出现在输入区正上方；
   2. 后台作业页（Pages.jobs 直接内嵌）。
   注意：repaintNow() 在 /chat-agent 不做整页 render（保护流式气泡），
   所以对话页的提问区必须像侧栏一样"事件驱动 + 直接写 DOM"，不能指望 render() 帮它刷新。 */

/** 解析选项 label 的推荐后缀（原生 QuestionComposer 同款约定 parseRecommendedLabel）：
 *  「方案 A（推荐）」/「方案 A (Recommended)」→ { label:'方案 A', recommended:true }。
 *  注意：作答回传的 value 仍是**原始 label**，与 DSH 侧的匹配逻辑保持一致。 */
function parseRecommendedLabel(label) {
  const m = /^(.*?)\s*[（(]\s*(?:推荐|建议|Recommended)\s*[)）]\s*$/i.exec(String(label || ''));
  return m ? { label: m[1], recommended: true } : { label: String(label || ''), recommended: false };
}
/** 提问卡模板。
 *  @param sessionId 传了就只渲染该会话的提问（对话页用）；不传=全部（后台作业页那种全局视图用）。
 *  为什么要按会话过滤：State.questions 是宿主机级 waterfall 汇总、**带 sessionId**，
 *  不过滤会把别的会话的提问卡画到当前对话里，用户答了也不是这个会话的事。
 *
 *  `x.detail` 是提问携带的**正文/全文**，必须渲染出来：
 *  计划模式的确认（`intent.kind === 'plan-review'`，见 dsh-plan-mode 的 `interaction.ask`）
 *  把**整份计划**放在 detail 里，问题文案只有一句"Approve this plan and leave plan mode?"——
 *  以前不渲染 detail，于是用户看不到计划、却要按「Approve」，等于盲签。计划类默认展开。 */
function questionsCardsHtml(sessionId) {
  return (State.questions || [])
    .filter(q => sessionId == null || !q.sessionId || q.sessionId === sessionId)
    .map(q => `
    <div class="qcard">
      <div class="qcard-head">❓ <b>智能体提问</b>
        <span class="muted mono qcard-id">${fmt.esc((q.rpcId||'').slice(0,12))}…</span>
        ${q.answered ? '<span class="tag ok">已作答</span>' : '<span class="tag warn">等待作答</span>'}
      </div>
      ${(q.questions || []).map(x => `
        <div class="qcard-q">
          ${x.header ? `<div class="qcard-header">${fmt.esc(x.header)}</div>` : ''}
          <div class="qcard-text">${fmt.esc(x.question)}</div>
          ${x.detail ? `<details class="qcard-detail"${/plan-review/.test((x.intent && x.intent.kind) || '') ? ' open' : ''}>
            <summary>${/plan-review/.test((x.intent && x.intent.kind) || '') ? '📋 待确认的计划（完整）' : '详情'}</summary>
            <div class="qcard-detail-body">${MD.render(String(x.detail))}</div>
          </details>` : ''}
          ${(x.options || []).length ? `<div class="qcard-opts">
            ${(x.options || []).map(o => {
              const p = parseRecommendedLabel(o.label);
              const on = (q._sel?.[x.id] || []).includes(o.label);
              return `<button class="btn sm qopt${on ? ' sel' : ''}${p.recommended ? ' rec' : ''}" ${q.answered ? 'disabled' : ''}
                title="${fmt.h(o.description || '')}"
                onclick="answerQuestion('${fmt.esc(q.rpcId)}','${fmt.esc(x.id)}','${fmt.esc(o.label)}',${x.multiSelect ? 'true' : 'false'})">${on ? '✓ ' : ''}${fmt.esc(p.label)}${p.recommended ? ' <span class="qrec">推荐</span>' : ''}</button>`;
            }).join('')}
          </div>` : ''}
          ${!q.answered ? `<div class="qcard-custom">
            <input id="qinput-${fmt.esc(x.id)}" placeholder="或输入自定义回答…" style="flex:1">
            <button class="btn sm" onclick="answerQuestion('${fmt.esc(q.rpcId)}','${fmt.esc(x.id)}', document.getElementById('qinput-${fmt.esc(x.id)}').value, false, true)">提交</button>
          </div>` : ''}
          ${!q.answered && x.multiSelect ? `<div class="mt">
            <button class="btn sm primary" onclick="submitMulti('${fmt.esc(q.rpcId)}','${fmt.esc(x.id)}')">提交多选（已选 ${(q._sel?.[x.id] || []).length} 项）</button>
          </div>` : ''}
        </div>`).join('')}
    </div>`).join('');
}
/** 对话页的提问区（#chatquestions）：事件来了 / 作答后 / 整页重绘后都要刷一遍 */
function renderChatQuestions() {
  const el = document.getElementById('chatquestions');
  if (!el) return;
  el.innerHTML = questionsCardsHtml(State.sessionId);   // 只显示当前会话的提问
}

const JOB_STATUS = {
  running:   { tag: 'ok',   text: '运行中' },
  stopping:  { tag: 'warn', text: '停止中' },
  completed: { tag: 'gray', text: '已完成' },
  killed:    { tag: 'gray', text: '已终止' },
  failed:    { tag: 'err',  text: '失败' },
};

Pages.jobs = () => {
  const all = State.jobsAllView === true;
  const jobs = all ? jobsOfAllSessions() : currentJobs();
  const running = jobs.filter(j => j.status === 'running');
  return `
  <div class="page-title"><h2>后台作业</h2>
    <span class="sub">后台任务与审批 · 默认当前会话，可切全部 · 实时推送${scopeTag('cross')}</span>
    <span class="pt-actions">
      <button class="btn sm" onclick="toggleJobsAll()">${all ? '只看当前会话' : '查看全部会话'}</button>
      <button class="btn sm" onclick="refreshJobs()" title="重取 session/control 基线（作业/队列/投影平时是实时推送，这是手动兜底）">刷新</button>
      <span class="tag ${State.jobsReady ? 'ok' : 'warn'}">
        ${State.jobsReady ? '已同步 · ' + jobs.length + ' 个作业' : '等待推送…'}
      </span>

    </span>
  </div>
  ${crumbOf('jobs')}
  ${pageHelp('jobs')}
  

  ${State.approvals.length ? State.approvals.map(a => `
    <div class="apprcard">
      <div class="apprcard-head">🔐 <b>审批请求</b>：工具 <code>${fmt.esc(a.toolName)}</code>
        ${a.reason ? ' · ' + fmt.esc(a.reason) : ''}</div>
      <div style="margin-top:8px;display:flex;gap:8px">
        <button class="btn sm primary" onclick="respondApproval('${fmt.esc(a.approvalId)}', true)">允许一次</button>
        <button class="btn sm" onclick="respondApproval('${fmt.esc(a.approvalId)}', false)">拒绝</button>
      </div>
    </div>`).join('') : ''}

  ${questionsCardsHtml()}


  <div class="row c4">
    <div class="card stat"><div class="k">作业总数</div><div class="v">${jobs.length}</div></div>
    <div class="card stat"><div class="k">运行中</div><div class="v">${running.length}</div></div>
    <div class="card stat"><div class="k">已完成</div><div class="v">${jobs.filter(j=>j.status==='completed').length}</div></div>
    <div class="card stat"><div class="k">失败/终止</div><div class="v">${jobs.filter(j=>j.status==='failed'||j.status==='killed').length}</div></div>
  </div>

  <div class="card mt">
    <h3>📊 作业列表 ${all ? '<span class="tag gray">全部会话</span>' : '<span class="tag gray">当前会话</span>'}</h3>
    ${jobs.length ? `<table>
      <thead><tr><th>ID</th><th>类型</th>${all ? '<th>所属会话</th>' : ''}<th>标签</th><th>状态</th><th>开始</th><th>结束</th><th>操作</th></tr></thead>
      <tbody>${jobs.map(j => {
        const st = JOB_STATUS[j.status] || { tag: 'gray', text: j.status };
        return `<tr>
          <td class="mono" style="font-size:11.5px">${fmt.esc(j.id)}</td>
          <td>${fmt.esc(j.kind)}</td>
          ${all ? '<td>' + sessionTitleHtml(sessionById(j._sessionId), 180) + '</td>' : ''}
          <td class="mono" style="font-size:11.5px">${fmt.esc(j.label)}</td>
          <td><span class="tag ${st.tag}">${st.text}</span></td>
          <td class="muted">${fmt.ago(j.startedAt)}</td>
          <td class="muted">${j.finishedAt ? fmt.ago(j.finishedAt) : '—'}</td>
          <td>${j.status === 'running' ? '<span class="muted" style="font-size:11.5px" title="终止作业属模型侧工具（job_kill），控制台只能看">模型侧</span>' : '—'}</td>
        </tr>`;
      }).join('')}</tbody>
    </table>` : `<div class="empty">${all ? '全部会话都没有后台作业' : '当前会话没有后台作业'}</div>` + emptyGuide('jobs')}
  </div>`;
};

/* ============ 子代理 ============ */
Pages.subagents = () => {
  const d = State.subagents;
  const rootId = State.sessionId;
  const entries = d?.entries || [];
  const active = entries.filter(e => e.activity === 'active');
  // 长列表分页：子代理一多，卡片（每张含表格+按钮）的 DOM 成本远高于普通表格行
  const subPage = Table.slice('subagentcards', entries);
  return `
  <div class="page-title"><h2>子代理</h2>
    <span class="sub">父会话 <code class="mono">${fmt.esc((rootId||'').slice(0,24))}…</code> · ${entries.length} 个子代理${scopeTag('session')}</span>
    <span class="pt-actions">
      <button class="btn sm" onclick="loadSubagents(true)">刷新</button>
      
    </span>
  </div>
  ${crumbOf('subagents')}
  ${pageHelp('subagents')}
  
    ${stampText('subagents')}

  ${d === null ? '<div class="card"><div class="empty"><span class="loading"></span> 正在读取子代理…</div></div>' : ''}
  ${d && !d.parentAvailable ? '<div class="alert err">父会话不可用：当前会话可能已结束或不是可查询的父会话。</div>' : ''}

  <div class="row c3">
    <div class="card stat"><div class="k">子代理总数</div><div class="v">${entries.length}</div></div>
    <div class="card stat"><div class="k">运行中</div><div class="v">${active.length}</div>
      <div class="muted" style="font-size:11px">activity=active（DSH 状态值）</div></div>
    <div class="card stat"><div class="k">可继续对话</div><div class="v">${entries.filter(e=>e.mode==='continuable').length}</div></div>
  </div>

  ${entries.length ? `<div class="card mt">${subPage.rows.map(e => `
    <div class="card mb" style="background:var(--panel-2)">
      <h3>🤖 ${fmt.esc(e.label || '(未命名)')}
        ${e.activity === 'active' ? '<span class="tag ok">运行中</span>' : '<span class="tag gray">空闲</span>'}
        ${e.hasChildren ? '<span class="tag">含子级</span>' : ''}
      </h3>
      <table>
        <tr><td>子代理 ID</td><td class="mono" style="font-size:11.5px">${fmt.esc(e.id)}</td></tr>
        <tr><td>类型 / 模式</td><td>${fmt.esc(e.kind)} · ${fmt.esc(e.mode)}</td></tr>
        <tr><td>活动状态</td><td>${e.activity === 'active' ? '正在进行回合' : '空闲（可继续发消息）'}</td></tr>
      </table>
      <div style="margin-top:10px;display:flex;gap:8px">
        <button class="btn sm" onclick="loadSubagentHistory('-1','${fmt.esc(e.id)}')">查看历史</button>
        ${e.mode === 'continuable' ? `<button class="btn sm" onclick="promptSubagent('${fmt.esc(e.id)}')">继续对话</button>
          ${e.activity === 'active' ? `<button class="btn sm" onclick="promptSubagent('${fmt.esc(e.id)}','steer')" title="delivery:steer —— 插到最近的步骤边界，打断当前步">⚡ 插话</button>` : ''}` : ''}
        ${e.activity === 'active' ? `<button class="btn sm" onclick="interruptSubagent('${fmt.esc(e.id)}')">打断</button>` : ''}
      </div>
      <div id="sahist-${fmt.esc(e.id)}"></div>
    </div>`).join('')}${subPage.pager}</div>`
  : (d ? '<div class="card mt"><div class="empty">当前父会话没有子代理</div>' + emptyGuide('subagents') + '</div>' : '')}`;
};

/* ============ 会话 ============ */
Pages.sessions = () => {
  const all = State.sessions || [];
  const kw = (State.sessionFilter || '').toLowerCase();
  const list = all.filter(s => !kw
    || s.sessionId.toLowerCase().includes(kw)
    || shortSid(s.sessionId).toLowerCase().includes(kw)   // 列表里显示的是去前缀的短 ID，按它也能筛到
    || (s.projections?.values?.title || '').toLowerCase().includes(kw)
    || (s.cwd || '').toLowerCase().includes(kw));
  const running = all.filter(s => s.running).length;
  const subs = all.filter(isSubagentSession).length;
  // 排序（标题/工作目录取嵌套字段）
  const sorted = Table.apply('sessions', list, {
    id: s => s.sessionId,
    title: s => s.projections?.values?.title || '',
    running: s => s.running ? 0 : 1,
    preset: s => sessionPreset(s),
    cwd: s => s.cwd || '',
    updatedAt: s => s.updatedAt || 0,
  });
  // 树形分组：子代理会话挂到父会话下；父会话被筛掉/不在列表时按顶层显示（不丢行）。
  // 同层顺序仍遵循上面的排序（点表头排序依然有效）。
  const kids = {}; const top = [];
  for (const s of sorted) {
    const p = isSubagentSession(s) ? s.parentSessionId : null;
    if (p && sorted.some(x => x.sessionId === p)) (kids[p] = kids[p] || []).push(s);
    else top.push(s);
  }
  const collapsed = sessCollapsedMap();
  const sessRow = (s, depth) => {
    const kk = kids[s.sessionId] || [];
    const open = kk.length ? !collapsed[s.sessionId] : true;
    // 当前会话：**不再在行上做任何标记**（不加高亮、不在 ID 列挂「当前」标签）——
    // 表格保持"每行长得一样"，当前身份只在操作列的那颗禁用按钮上体现（见下方 ✓ 当前会话）。
    const isCur = s.sessionId === State.sessionId;
    const idCell = (kk.length
        ? `<button class="tw-btn" onclick="toggleSessBranch('${fmt.esc(s.sessionId)}')" title="${open ? '收起' : '展开'}它的 ${kk.length} 个子代理会话">${open ? '▾' : '▸'}</button>`
        : (depth ? '<span class="sa-elbow">└</span>' : ''))
      + `<span class="mono" title="${fmt.esc(s.sessionId)}">${fmt.esc(shortSid(s.sessionId).slice(0, 18))}…</span>`;
    const extra = kk.length && depth === 0 ? ` <span class="muted" style="font-size:10.5px">×${kk.length} 子代理</span>` : '';
    return `<tr class="${depth ? 'sa-child' : ''}">
      <td style="font-size:11.5px;${depth ? `padding-left:${18 + depth * 20}px;` : ''}white-space:nowrap">${idCell}${extra}</td>
      <td>${sessionTitleHtml(s, 260)}</td>
      <td><span class="tag ${s.running?'ok':'gray'}">${s.running?'运行中':'空闲'}</span></td>
      <td>${fmt.esc(sessionPreset(s) || '—')}</td>
      <!-- ⚠️ .ellip 是 display:inline-block，绝不能写在 <td> 上：它会让这个格脱离表格行
           的对齐体系（格高 39px ≠ 行高 48px、vertical-align:bottom 把内容拉到底），
           行内悬停高亮带也会在这一格断开。必须套在内层 span 上（.ellip 的 CSS 注释也是这么要求的）。 -->
      <td style="font-size:11.5px"><span class="mono ellip" style="max-width:220px" title="${fmt.h(s.cwd||'')}">${fmt.esc(s.cwd||'-')}</span></td>
      <td class="muted">${fmt.ago(s.updatedAt)}</td>
      <td style="white-space:nowrap">
        ${isSubagentSession(s)
          // 子代理行只留三个有意义的操作：改名/分叉/切模型是主会话的管理动作（对子代理多半被 DSH 拒）；
          // 「↩ 父会话」在树形列表里多余（父就在上一行）。设为当前=查看它的轨迹/交付物/作业详情。
          ? `${isCur
              // 当前行不再直接抹掉按钮：留一个禁用占位，列宽与其它行一致，也顺带告诉用户"这一行就是当前会话"
              ? '<button class="btn sm cur-sel" disabled title="当前会话就是它：跟随会话的页面（轨迹/交付物/作业…）都指向这个子代理">✓ 当前会话</button>'
              : `<button class="btn sm" onclick="setCurrentSession('${fmt.esc(s.sessionId)}')" title="设为当前后，跟随会话的页面（轨迹/交付物/作业…）指向这个子代理；作用域条可一键回父会话">设为当前</button>`}
             <button class="btn sm" onclick="viewHistory('${fmt.esc(s.sessionId)}')" title="面板内查看该子代理的消息记录（走 subagent 通道）">历史</button>
             <button class="btn sm" onclick="exportSession('${fmt.esc(s.sessionId)}')" title="把该子代理自己的对话记录打包成 ZIP 下载">⬇ 导出</button>`
          : `${isCur
              ? '<button class="btn sm cur-sel" disabled title="当前会话就是它：整个列表只有这一行是这颗按钮，跟随会话的页面（轨迹/交付物/作业…）都指向这个会话">✓ 当前会话</button>'
              : `<button class="btn sm" onclick="setCurrentSession('${fmt.esc(s.sessionId)}')" title="设为当前会话">设为当前</button>`}
             <button class="btn sm" onclick="viewHistory('${fmt.esc(s.sessionId)}')" title="面板内查看该会话的消息记录；事件级时间线在轨迹页">历史</button>
             <button class="btn sm" onclick="renameSession('${fmt.esc(s.sessionId)}')">改名</button>
             <button class="btn sm" onclick="forkSession('${fmt.esc(s.sessionId)}')" title="从该会话当前状态复制出一个新会话；按轮次分叉在轨迹页">分叉</button>
             <button class="btn sm" onclick="selectModel('${fmt.esc(s.sessionId)}')" title="为该会话切换模型与推理强度；当前会话也可在时空智能体侧栏直接切">切模型</button>
             <button class="btn sm" onclick="exportSession('${fmt.esc(s.sessionId)}')" title="把该会话的对话记录与产物打包成 ZIP 下载（含其子代理日志）">⬇ 导出</button>
             ${s.running ? `<button class="btn sm" onclick="cancelSession('${fmt.esc(s.sessionId)}')">取消</button>` : ''}`}
      </td></tr>`
      + (kk.length && open ? kk.map(c => sessRow(c, depth + 1)).join('') : '');
  };
  // 长列表分页：只切**顶层**行，子代理行跟着父行走（否则树会被切散）
  const sessPage = Table.slice('sessionrows', top);
  return `
  <div class="page-title"><h2>会话</h2>
    <span class="sub">${all.length} 个会话 · ${running} 个运行中${subs ? ` · ${subs} 个子代理会话（挂在父会话下）` : ''}${scopeTag('global')}</span>
    <span class="pt-actions">
      <button class="btn sm" onclick="reloadSessions()">刷新</button>
      <button class="btn sm primary" onclick="newSession()">+ 新建会话</button>
      
    </span>
  </div>
  ${crumbOf('sessions')}
  ${pageHelp('sessions')}
  

  ${State.searchUnavailable ? '<div class="alert info">筛选在浏览器本地完成（服务端全文检索未启用）。</div>' : ''}

  <div class="card mb">
    <input id="sessfilter" placeholder="筛选：会话 ID / 标题 / 工作目录" value="${fmt.esc(State.sessionFilter || '')}"
           oninput="State.sessionFilter=this.value;render({paintOnly:true})">
  </div>

  ${stampText('sessions')}
  <div class="card"><table>
    <thead><tr>
      ${Table.th('sessions','id','会话 ID')}
      ${Table.th('sessions','title','标题')}
      ${Table.th('sessions','running','状态')}
      ${Table.th('sessions','preset','智能体预设')}
      ${Table.th('sessions','cwd','工作目录')}
      ${Table.th('sessions','updatedAt','更新时间')}
      <th>操作</th>
    </tr></thead>
    <tbody>${sessPage.rows.map(s => sessRow(s, 0)).join('') || '<tr><td colspan="7" class="empty">无匹配会话</td></tr>'}</tbody>
  </table>${sessPage.pager}</div>

  ${(State.queue || []).length ? `<div class="card mt">
    <h3>📨 消息队列（${currentQueue().length} 条待处理）</h3>
    <p class="muted mb" style="font-size:11.5px">placement：queued=排队等待 · steering=插话打断 · context=上下文注入</p>
    <table>
      <thead><tr><th>位置</th><th>角色</th><th>内容</th><th>操作</th></tr></thead>
      <tbody>${currentQueue().map(it => {
        const text = (it.message?.content || []).filter(b => b.type === 'text').map(b => b.text).join(' ');
        const plc = { queued: '排队', steering: '插话', context: '上下文' }[it.placement] || it.placement;
        const tag = it.placement === 'steering' ? 'warn' : it.placement === 'context' ? 'gray' : 'ok';
        return `<tr>
          <td><span class="tag ${tag}">${fmt.esc(plc)}</span></td>
          <td>${fmt.esc(it.message?.role || '—')}</td>
          <td class="muted" style="font-size:12px">${fmt.esc(text.slice(0, 120)) || '（非文本内容）'}</td>
          <td style="white-space:nowrap">
            ${it.placement === 'queued' ? `<button class="btn sm" onclick="queueOp('${fmt.esc(it.id)}','steer')" title="立即插入，打断当前生成">插话</button>` : ''}
            <button class="btn sm" onclick="queueEdit('${fmt.esc(it.id)}')">编辑</button>
            <button class="btn sm" onclick="queueOp('${fmt.esc(it.id)}','remove')">撤回</button>
          </td>
        </tr>`;
      }).join('')}</tbody>
    </table>
  </div>` : ''}

  <div id="histpanel"></div>`;
};


/* ============ 轨迹（Trajectory）============ */
Pages.trajectory = () => {
  const d = State.trajectory;
  // 未就绪时也要给说明卡与自检入口：这一页最容易出现"数据拉不回来就一直空白"，
  // 恰恰是用户最需要知道"这页是什么 + 怎么自检"的时候。
  if (!d) return `<div class="page-title"><h2>轨迹</h2>
      <span class="sub">会话事件流 · 等待读取${scopeTag('session')}</span>
          </div>
    ${crumbOf('trajectory')}
    ${pageHelp('trajectory')}
    
    <div class="card"><div class="empty"><span class="loading"></span> 正在读取事件流…</div></div>`;
  const items = d.items || [];
  const stats = d.stats || {};
  const turns = trajectoryTurns();
  // 按轮筛选：只显示该轮的节点（turn 为 null 的早期节点只在「全部」里出现）
  const shown = d.turnFilter == null ? items : items.filter(it => it.turn === d.turnFilter);
  return `
  <div class="page-title"><h2>轨迹</h2>
    <span class="sub">会话事件流 · 已加载 ${items.length} 个节点 · 步骤级时间线${turns.length ? ' · 共 ' + turns.length + ' 轮' : ''}${scopeTag('session')}</span>
    <span class="pt-actions">
      <button class="btn sm" onclick="loadTrajectory(true)">刷新</button>
      
    </span>
  </div>
  ${crumbOf('trajectory')}
  ${pageHelp('trajectory')}
  

  <div class="row c4">
    <div class="card stat"><div class="k">总轮次</div><div class="v">${stats.turns || 0}</div></div>
    <div class="card stat"><div class="k">总步数</div><div class="v">${stats.steps || 0}</div></div>
    <div class="card stat"><div class="k">工具调用</div><div class="v">${stats.toolCalls || 0}</div>
      <div class="muted" style="font-size:11px">失败 ${stats.toolErrors || 0}</div></div>
    <div class="card stat"><div class="k">子调用</div><div class="v">${stats.dispatches || 0}</div>
      <div class="muted" style="font-size:11px">代码沙箱内调用的工具</div></div>
  </div>

  ${turns.length ? `<div class="card mt">
    <h3>🧭 轮次</h3>
    <div style="display:flex;flex-wrap:wrap;gap:6px">
      <button class="btn sm ${d.turnFilter == null ? 'primary' : ''}" onclick="setTrajectoryTurn(null)">全部 ${turns.length} 轮</button>
      ${turns.map(t => `<button class="btn sm ${d.turnFilter === t.turn ? 'primary' : ''}"
          title="${fmt.esc(fmt.mid(t.prompt || '（无摘要）', 120))}"
          onclick="setTrajectoryTurn(${t.turn})">第 ${t.turn} 轮</button>`).join('')}
    </div>
    ${d.turnFilter != null ? (() => {
      const t = turns.find(x => x.turn === d.turnFilter) || {};
      return `<div class="mt" style="border-top:1px solid var(--line);padding-top:10px">
        <div class="muted" style="font-size:11.5px">第 ${d.turnFilter} 轮 · 锚点 seq ${t.seq ?? '—'}</div>
        ${t.prompt ? `<div class="mt" style="font-size:12.5px"><b>提问：</b>${fmt.esc(fmt.mid(t.prompt, 400))}</div>` : ''}
        ${t.response ? `<div class="mt muted" style="font-size:12px"><b>回复：</b>${fmt.esc(fmt.mid(t.response, 400))}</div>` : ''}
        ${t.seq != null ? `<div class="mt"><button class="btn sm" onclick="forkAtTurn(${d.turnFilter}, ${t.seq})">⤴ 从这一轮分叉会话</button>
          <span class="muted" style="font-size:11px;margin-left:8px">（session/fork 的 atSeq，保留该轮之前的上下文）</span></div>` : ''}
      </div>`;
    })() : ''}
  </div>` : ''}

  <div class="card mt">
    <h3>⏱️ 步骤时间线 ${d.turnFilter != null ? '<span class="tag">第 ' + d.turnFilter + ' 轮</span>' : ''}</h3>
    ${(d.items || []).length ? `<div class="mb" style="display:flex;align-items:center;gap:10px">
      <button class="btn sm" onclick="loadOlderTrajectory()" ${(!d.hasMore || d.loadingOlder) ? 'disabled' : ''}
        title="${d.hasMore ? '用 session/page 向前翻页，取回比本页更早的一页事件' : '当前时间线已到会话开头，没有更早的记录'}">${d.loadingOlder ? '加载中…' : '⬆ 加载更早'}</button>
      <span class="muted" style="font-size:11.5px">本页最早 seq ${d.oldestSeq ?? '—'}${d.hasMore ? '（还有更早的）' : '（已到会话开头）'}</span>
    </div>` : ''}
    ${shown.length ? (() => {
      // 长会话的性能闸门：时间线一次只挂 200 个节点，需要时向前展开。
      // 之前是"全部渲染 + 容器滚"，几千个节点的 innerHTML 会直接让切页/筛选卡住。
      const cap = d.shown || 200;
      const view = shown.slice(Math.max(0, shown.length - cap));
      const hiddenN = shown.length - view.length;
      return `<div class="mb" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        ${hiddenN ? `<button class="btn sm" onclick="trajMore()">⬆ 再显示 ${Math.min(hiddenN, 200)} 条更早的节点</button>` : ''}
        <span class="muted" style="font-size:11.5px">正在显示 ${view.length} / ${shown.length} 个节点${hiddenN ? '（更早的 ' + hiddenN + ' 个暂未挂载：一次渲染上千节点会让页面卡住）' : '（已全部显示）'}</span>
      </div>
      <div class="listsrc perf-list">${view.map(it => `
      <div style="display:flex;gap:10px;padding:7px 0;border-bottom:1px solid var(--line)">
        <div class="mono muted" style="width:88px;flex:0 0 auto;font-size:11px">${it.time ? new Date(it.time).toLocaleTimeString('zh-CN',{hour12:false}) : '—'}</div>
        <div style="width:66px;flex:0 0 auto"><span class="tag ${it.tag}">${fmt.esc(it.kind)}</span></div>
        <div style="flex:1;min-width:0">
          <div style="font-size:12.5px">${it.title}</div>
          ${it.detail ? `<div class="muted mono" style="font-size:10.5px;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${fmt.esc(it.detail)}</div>` : ''}
          ${it.media ? `<div style="margin-top:4px">${it.media}</div>` : ''}
        </div>
        <div class="muted mono" style="width:64px;flex:0 0 auto;text-align:right;font-size:11px">${it.seq != null ? '#' + it.seq : ''}</div>
      </div>`).join('')}</div>`; })()
      : `<div class="empty">${d.turnFilter != null ? '这一轮没有落在当前已加载的时间线里（可先「加载更早」）' : '该会话还没有可展示的事件'}</div>`}
  </div>
  ${!items.length ? emptyGuide('trajectory') : ''}`;
};

/* ============ 交付物（Deliverables）============
   两条来源都是真实数据，没有写死的清单：
   ① 会话事件流里"变更类工具"自己带的文件路径（tool/call 与 tool/code-dispatch 的 arguments）
      —— 与 DSH 原生 deliverables 的思路一致：看工具"做了什么"，而不是看模型"说了什么"
   ② 会话工作目录里最近落盘的成果文件（本机文件系统扫描 /api/local/deliverables） */
const MUTATION_TOOLS = /^(write|edit|multi_edit|create_file|write_file|str_replace_editor|notebook_edit|apply_patch)$/i;

/** 从会话事件流提取"被写入/修改"的文件路径（首次出现顺序，已去重） */
function collectProducedFromEvents(events) {
  const out = []; const seen = new Set();
  for (const x of (events || [])) {
    const e = x.event || {}; const d = e.data || {};
    if (e.type !== 'tool/call' && e.type !== 'tool/code-dispatch') continue;
    if (!MUTATION_TOOLS.test(String(d.name || ''))) continue;
    let a = d.arguments;
    if (typeof a === 'string') { try { a = JSON.parse(a); } catch { continue; } }
    if (!a || typeof a !== 'object') continue;
    const p = a.file_path || a.path || a.filePath || a.filename || a.target_file;
    if (typeof p !== 'string' || !p || seen.has(p)) continue;
    seen.add(p);
    out.push({ path: p, tool: d.name, seq: e.seq, turn: d.turn,
               via: e.type === 'tool/code-dispatch' ? '代码沙箱子调用' : '顶层工具调用' });
  }
  return out;
}

const FILE_ICO = { md:'📄', json:'🧾', jsonl:'🧾', csv:'📊', txt:'📄', jpg:'🖼️', jpeg:'🖼️', png:'🖼️', webp:'🖼️',
  gif:'🖼️', svg:'🖼️', pdf:'📕', zip:'🗜️', shp:'🗺️', gdb:'🗺️', lyrx:'🎨', aprx:'📦', xlsx:'📊', xls:'📊',
  docx:'📘', doc:'📘', kml:'🌐', geojson:'🌐', prj:'🧭', log:'📃', js:'📜', cjs:'📜', mjs:'📜', ts:'📜', py:'🐍', html:'🌐' };
function fileIco(name) {
  const ext = (String(name).match(/\.([A-Za-z0-9]+)$/) || [null, ''])[1].toLowerCase();
  return FILE_ICO[ext] || '📎';
}
/** 文件名 → "点击即打开"的超链接（原生 produced.open / presented.open 的交互）。
 *  ⚠️ 用户明确要求：**不要再在文件行尾堆「打开 / 下载」按钮** —— 名字本身就是动作。
 *  · 宿主支持打开路径 → 交给系统默认程序（host.openPath）；
 *  · 宿主不支持（无桌面的部署）→ 明说一句，不静默失败，也不假装打开成功。
 *  路径参数走 fmt.attr（内联事件里的 JS 字符串），title/data-path 走 fmt.h（HTML 属性）——
 *  这两个别再互相串（见 fmt.attr 的注释：串了就多一对引号）。 */
function fileLinkHtml(p, name, cls) {
  const abs = String(p || '');
  const nm = name || abs.split(/[\\/]/).pop() || abs || '（未命名文件）';
  const canOpen = State.host?.canOpenPath === true;
  const tip = !abs ? nm : (canOpen ? '打开 ' + abs : abs + '（当前部署不支持在系统中打开，点一下会给出提示）');
  return '<a class="file-link mono' + (cls ? ' ' + cls : '') + '" href="#"'
    + ' data-path="' + fmt.h(abs) + '" title="' + fmt.h(tip) + '"'
    + ' onclick="openFileLink(event,' + fmt.attr(abs) + ')">' + fmt.esc(nm) + '</a>';
}
/** 点文件链接：能打开就打开；不能就让用户知道为什么（并给出可复制的路径） */
async function openFileLink(ev, p) {
  if (ev && ev.preventDefault) ev.preventDefault();
  if (ev && ev.stopPropagation) ev.stopPropagation();
  if (!p) { UI.warn('这条记录没有可用的文件路径'); return; }
  await openLocalPath(p);
}

Pages.deliverables = () => {
  const s = currentSession();
  const cwd = s.cwd || State.host?.cwd || '';
  const d = State.deliverables;
  const produced = State.producedFiles;
  const canOpen = State.host?.canOpenPath === true;
  // 长列表分页（每页 30）：交付物一次可能列出上百个文件，全挂上去会让本页重绘明显变贵
  const pageA = Table.slice('delivproduced', produced || []);
  const pageB = Table.slice('delivdir', (d && d.items) || []);
  return `
  <div class="page-title"><h2>交付物</h2>
    <span class="sub">会话产物文件 · 工作目录 <code>${fmt.esc(cwd || '—')}</code>${scopeTag('session')}</span>
    <span class="pt-actions">
      <button class="btn sm" onclick="loadDeliverables(true)">刷新</button>
      
    </span>
  </div>
  ${crumbOf('deliverables')}
  ${pageHelp('deliverables')}
  
  ${stampText('deliverables')}

  <div class="alert info">
    <b>① 本会话产物</b>：本次会话里模型实际写入或修改过的文件。<br>
    <b>② 工作目录成果</b>：工作目录里最近落盘的文件，按修改时间倒序。
  </div>

  <div class="card">
    <h3>① 本会话产物 ${produced === null ? '' : '<span class="tag gray">' + produced.length + ' 个</span>'}</h3>
    ${produced === null ? '<div class="empty"><span class="loading"></span> 读取会话事件…</div>'
      : produced.length ? `<table>
        <thead><tr><th>文件（点击打开）</th><th>途经</th><th>工具</th><th>轮次</th><th>seq</th></tr></thead>
        <tbody>${pageA.rows.map(f => `<tr>
          <td>${fileIco(f.path)} ${fileLinkHtml(f.path, f.path)}</td>
          <td class="muted" style="font-size:11px">${fmt.esc(f.via)}</td>
          <td class="mono">${fmt.esc(f.tool)}</td>
          <td>${f.turn ?? '—'}</td>
          <td class="muted">${f.seq ?? '—'}</td>
        </tr>`).join('')}</tbody></table>${pageA.pager}`
      : '<div class="empty">本会话还没有产生文件<br><span class="muted">变更类工具：write / edit / multi_edit / str_replace_editor / apply_patch</span></div>' + emptyGuide('deliverables')}
  </div>

  <div class="card mt">
    <h3>② 工作目录成果 ${d ? '<span class="tag gray">' + (d.items || []).length + ' / ' + (d.scanned || 0) + ' 个</span>' : ''}</h3>
    ${d ? '<div class="muted mb" style="font-size:11.5px">📁 浏览完整目录（含子目录树、预览）请到 <a href="#/workspace">工作空间 → 工作目录文件</a>；本页只看最近落盘的成果。</div>' : ''}
    ${!d ? '<div class="empty"><span class="loading"></span> 扫描工作目录…</div>'
      : (d.items || []).length ? `<table>
        <thead><tr><th>文件（点击打开）</th><th>相对路径</th><th>大小</th><th>修改时间</th></tr></thead>
        <tbody>${pageB.rows.map(f => `<tr>
          <td>${fileIco(f.name)} ${fileLinkHtml(f.path, f.name)}</td>
          <td class="mono muted" style="font-size:11px"><span class="ellip w300" title="${fmt.h(f.path)}">${fmt.esc(f.rel)}</span></td>
          <td>${fmt.bytes(f.size)}</td>
          <td class="muted">${fmt.ago(f.mtime)}</td>
        </tr>`).join('')}</tbody></table>${pageB.pager}`
      : '<div class="empty">工作目录里没有扫描到成果文件</div>'}
    ${d?.error ? '<div class="alert err mt">' + fmt.esc(d.error) + '</div>' : ''}
  </div>`;
};

/* ============ 工作流（Workflow / Ralph / 子代理）============
   数据全部来自真实调用记录：会话事件流里的 workflow / ralph 工具调用与结果，
   以及 subagent.list 返回的子代理树。没有工作流运行时给出诚实的空状态。 */
Pages.workflow = () => {
  const runs = State.workflowRuns;
  const subs = State.subagents?.entries || [];
  const totalAgents = runs ? runs.reduce((n, r) => n + r.members.length, 0) : 0;
  const STATUS = { running: { tag: 'ok', ico: '🔄', text: '运行中' }, completed: { tag: 'ok', ico: '✅', text: '完成' },
    failed: { tag: 'err', ico: '❌', text: '失败' }, cancelled: { tag: 'gray', ico: '⏹️', text: '已取消' },
    interrupted: { tag: 'warn', ico: '⚠️', text: '已中断' } };
  return `
  <div class="page-title"><h2>工作流</h2>
    <span class="sub">工作流运行与子代理 · ${runs ? runs.length : '…'} 次运行 · ${subs.length} 个子代理${scopeTag('session')}</span>
    <span class="pt-actions">
      <button class="btn sm" onclick="loadWorkflowRuns(true)">刷新</button>
      
    </span>
  </div>
  ${crumbOf('workflow')}
  ${pageHelp('workflow')}
  
  ${stampText('workflowRuns')}

  <div class="alert info">
    运行状态怎么判：报错收场记「失败」；没有收到结束事件、但它所属的轮次已经结束，记「已中断」（不是还在跑）。
  </div>

  <div class="row c3">
    <div class="card stat"><div class="k">编排运行</div><div class="v">${runs ? runs.length : '—'}<span class="u">次</span></div>
      <div class="muted" style="font-size:11px">本会话的编排运行记录数</div></div>
    <div class="card stat"><div class="k">参与代理</div><div class="v">${totalAgents}<span class="u">个</span></div>
      <div class="muted" style="font-size:11px">各次运行参与的代理数合计</div></div>
    <div class="card stat"><div class="k">当前子代理</div><div class="v">${subs.length}<span class="u">个</span></div>
      <div class="muted" style="font-size:11px">${subs.filter(x => x.activity === 'active').length} 个运行中</div></div>
  </div>

  <div class="card mt">
    <h3>🕸️ 编排运行明细</h3>
    ${!runs ? '<div class="empty"><span class="loading"></span> 读取会话事件…</div>'
      : runs.length ? runs.map(r => {
          const st = STATUS[r.status] || { tag: 'gray', ico: '❔', text: r.status };
          return '<div style="border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin-bottom:10px;background:var(--inset)">'
            + '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">'
            + '<span class="tag ' + st.tag + '">' + st.ico + ' ' + fmt.esc(st.text) + '</span>'
            + '<b>' + fmt.esc(r.name || '(未命名)') + '</b>'
            + '<span class="muted mono" style="font-size:11px">' + fmt.esc(r.runId || '') + '</span>'
            + '<span class="muted" style="font-size:11px;margin-left:auto">' + fmt.ago(r.time) + ' · 成员 ' + r.members.length + ' 个'
            + (r.stopReason !== undefined ? ' · stopReason: ' + fmt.esc(String(r.stopReason)) : '') + '</span></div>'
            + (r.phases.length ? r.phases.map(p => '<div style="margin-top:9px">'
                + '<div class="muted" style="font-size:11px;margin-bottom:4px">阶段：' + fmt.esc(p.label) + '</div>'
                + p.members.map(m => {
                    const ms = STATUS[m.status] || { tag: 'gray', ico: '❔' };
                    return '<div style="font-size:12px;padding:3px 0;display:flex;gap:8px;align-items:center">'
                      + '<span class="tag ' + ms.tag + '" style="font-size:9.5px">' + ms.ico + ' ' + fmt.esc(m.status) + '</span>'
                      + '<span>' + fmt.esc(m.label || '(无标签)') + '</span>'
                      + (m.childId ? '<span class="muted mono" style="font-size:10.5px">' + fmt.esc(String(m.childId).slice(0, 18)) + '…</span>' : '')
                      + '</div>';
                  }).join('')
                + '</div>').join('') : '<div class="muted mt" style="font-size:11.5px">这次运行没有记录到成员</div>')
            + '</div>';
        }).join('')
      : `<div class="empty">该会话没有工作流运行记录
          <div class="muted mt" style="font-size:11.5px">用 workflow 工具做多代理扇出时，这里会自动出现运行记录</div></div>` + emptyGuide('workflow')}
  </div>

  <div class="card mt">
    <h3>🤖 子代理树（实时）</h3>
    ${subs.length ? `<table>
      <thead><tr><th>标签</th><th>类型</th><th>模式</th><th>状态</th><th>有下级</th><th>操作</th></tr></thead>
      <tbody>${subs.map(x => `<tr>
        <td>${fmt.esc(x.label || '—')}</td>
        <td><span class="tag gray">${fmt.esc(x.kind || '—')}</span></td>
        <td>${fmt.esc(x.mode || '—')}</td>
        <td><span class="tag ${x.activity === 'active' ? 'ok' : 'gray'}">${x.activity === 'active' ? '运行中' : '空闲'}</span></td>
        <td>${x.hasChildren ? '是' : '—'}</td>
        <td><button class="btn sm" onclick="location.hash='#/subagent/list'">监控页</button></td>
      </tr>`).join('')}</tbody></table>`
      : '<div class="empty">当前会话没有子代理</div>'}
    <div class="muted mt" style="font-size:11.5px">子代理的运行详情与历史见 <a href="#/subagent/list">子代理</a> 页；本表为当前会话的只读快照。</div>
  </div>`;
};

/* ============ 系统状态 ============ */
Pages.host = () => {
  const h = State.host || {};
  const sess = currentSession();
  const p = sess.projections?.values || {};
  const st = p.sessionStats || {};
  const tok = p.tokenUsage || {};
  const ctx = p.contextPressure || {};
  const brk = p.contextBreakdown || {};
  const perm = p.permissions || {};
  const img = p.imageLimits || {};
  const todos = p.todos || null;
  const subTiming = p.subagentTiming || {};
  const sec = ms => ms == null ? '—' : ms < 1000 ? ms + ' ms' : ms < 60000 ? (ms/1000).toFixed(1) + ' s' : (ms/60000).toFixed(1) + ' min';
  const num = n => n == null ? '—' : Number(n).toLocaleString('en-US');
  const bytes = b => b == null ? '—' : b >= 1048576 ? (b/1048576).toFixed(0) + ' MB' : (b/1024).toFixed(0) + ' KB';
  const pctv = (a, b) => (!a || !b) ? 0 : Math.min(100, (a / b) * 100);
  const pressure = pctv(ctx.pressureTokens, ctx.contextWindow);
  return `
  <div class="page-title"><h2>系统状态</h2>
    <span class="sub">全量数字面板 · 上区=平台健康（与具体会话无关），下区=当前会话（跟随所选会话）· 概览不折叠，明细一律折叠</span>
    <span class="pt-actions">
      <button class="btn sm" onclick="runContractCheck()" title="逐项打真实的 DSH 接口，失败项直接标红">🧪 契约自检</button>
      <button class="btn sm" onclick="runAllChecks()" title="一次跑完全部模块的功能自检（只读）；失败会列出受影响的功能模块">🧪 全模块自检</button>
      <button class="btn sm" onclick="refreshSystem(true)">刷新</button>
    </span>
  </div>
  ${crumbOf('host')}
  ${pageHelp('host')}
  
    ${stampText('host')}

  ${!h.version ? '<div class="card"><div class="empty"><span class="loading"></span> 读取中…</div></div>' : ''}

  <div class="sect">平台健康 <span class="muted" style="font-weight:400;font-size:11px">· 与具体会话无关</span></div>
  <div class="row c4">
    <div class="card stat"><div class="k">DSH 版本</div><div class="v" style="font-size:19px">${fmt.esc(h.version || '—')}</div>
      <div class="muted" style="font-size:11px" title="版本读自本机 dsh 包，构建号读自运行实例">
        本机包${h.rev ? ' · 运行实例 rev ' + fmt.esc(h.rev) : ''}</div></div>
    <div class="card stat"><div class="k">已连接会话</div><div class="v">${h.attachedSessions ?? '—'}</div>
      <div class="muted" style="font-size:11px">${(State.sessions||[]).filter(s=>s.running).length} 个运行中 · <a href="#/session/list">会话列表</a></div></div>
    <div class="card stat"><div class="k">插件</div><div class="v">${State.plugins?.plugins?.length ?? '—'}</div>
      <div class="muted" style="font-size:11px">禁用 ${(State.plugins?.plugins||[]).filter(x=>x.disabled).length} · <a href="#/plugin/manager">插件管理</a></div></div>
    <div class="card stat"><div class="k">MCP 服务</div><div class="v">${(State.mcp||[]).length || '—'}</div>
      <div class="muted" style="font-size:11px">在线 ${(State.mcp||[]).filter(s=>s.online).length} · 工具 ${(State.mcp||[]).reduce((a,s)=>a+(s.tools||0),0)} · <a href="#/mcp/manager">管理</a></div></div>
  </div>

  <!-- 契约自检结果：直接铺一张卡（不再套 <details open>）。
       套 details 有两个毛病：① 每个检查项 render() 一次都会把 open 重新加回来，用户手动折起来又被弹开；
       ② details > fold-body > card 三层容器层层缩进，表看着"嵌在框里"。现在卡自己带 ✕ 关闭。 -->
  ${contractCard()}

  <!-- 全模块功能自检（原每页一颗的「功能自检」统一收拢到这里，失败标注受影响模块） -->
  ${allCheckCard()}

  ${perfCard()}

  <details class="fold mt">
    <summary>📦 平台资源总览（Skills / 智能体预设 / 作业 / 子代理 / 审批 / 目标）</summary>
    <div class="fold-body">
      <div class="row c4">
        <div><div class="muted" style="font-size:11.5px">Skills</div><div style="font-size:19px;font-weight:700">${(State.skillsScope?.skills||[]).length}</div>
          <div class="muted" style="font-size:11px">${[...new Set((State.skillsScope?.skills||[]).map(s=>s.scopeLabel))].join('/') || '—'}</div></div>
        <div><div class="muted" style="font-size:11.5px">智能体预设</div><div style="font-size:19px;font-weight:700">${(State.presets||[]).length}</div>
          <div class="muted" style="font-size:11px">当前 ${fmt.esc(sessionPreset(sess)||'—')}</div></div>
        <div><div class="muted" style="font-size:11.5px">后台作业</div><div style="font-size:19px;font-weight:700">${(State.jobs||[]).length}</div>
          <div class="muted" style="font-size:11px">运行中 ${currentJobs().filter(j=>j.status==='running').length}</div></div>
        <div><div class="muted" style="font-size:11.5px">子代理</div><div style="font-size:19px;font-weight:700">${(State.subagents?.entries||[]).length}</div>
          <div class="muted" style="font-size:11px">活跃 ${(State.subagents?.entries||[]).filter(e=>e.activity==='active').length}${subTiming.settledMs ? ' · 耗时 ' + sec(subTiming.settledMs) : ''}</div></div>
      </div>
      <div class="row c4 mt">
        <div><div class="muted" style="font-size:11.5px">待审批</div><div style="font-size:19px;font-weight:700">${(State.approvals||[]).length}</div>
          <div class="muted" style="font-size:11px">${(State.approvals||[]).length ? '需处理' : '无'}</div></div>
        <div><div class="muted" style="font-size:11.5px">目标</div><div style="font-size:19px;font-weight:700">${State.goal?.goal ? '1' : '0'}</div>
          <div class="muted" style="font-size:11px">${fmt.esc(State.goal?.goal?.phase || '无活跃目标')}</div></div>
      </div>
    </div>
  </details>

  <div class="sect mt">当前会话 <span class="muted" style="font-weight:400;font-size:11px">· 跟随所选会话，换会话即换数据 · 会话ID <span class="mono">${fmt.esc((sess.sessionId||'—').slice(0,20))}${sess.sessionId ? '…' : ''}</span></span></div>
  <!-- ① 先确认"看的是谁"：身份信息永远在最前 -->
  <div class="card">
    <h3>📇 会话身份 <span class="tag ${sess.running ? 'ok' : 'gray'}">${sess.running ? '运行中' : '空闲'}</span></h3>
    <table>
      <tr><td>标题</td><td>${fmt.esc(p.title || '（未命名）')}</td></tr>
      <tr><td>智能体预设</td><td>${fmt.esc(sessionPreset(sess) || '—')}</td></tr>
      <tr><td>工作目录</td><td style="font-size:11.5px"><span class="mono ellip" style="max-width:520px" title="${fmt.h(sess.cwd || '')}">${fmt.esc(sess.cwd || '—')}</span></td></tr>
      <tr><td>最后更新</td><td class="muted">${fmt.ago(sess.updatedAt)}</td></tr>
    </table>
  </div>
  <!-- ② 概览数字：一眼看的 4 项 -->
  <div class="row c4 mt">
    <div class="card stat"><div class="k">当前模型</div><div class="v" style="font-size:15px">${fmt.esc(h.model || '—')}</div>
      <div class="muted" style="font-size:11px">${fmt.esc(h.provider || '')} · 切换见时空智能体侧栏</div></div>
    <div class="card stat"><div class="k">轮次 / 步数</div><div class="v" style="font-size:19px">${num(st.turns)}<span class="u">/ ${num(st.steps)}</span></div>
      <div class="muted" style="font-size:11px">平均每步 ${st.steps ? sec((st.llmMs + st.toolMs) / st.steps) : '—'}</div></div>
    <div class="card stat"><div class="k">上下文压力</div><div class="v" style="font-size:19px">${pressure.toFixed(1)}<span class="u">%</span></div>
      <div class="muted" style="font-size:11px">窗口 ${num(ctx.contextWindow)}</div></div>
    <div class="card stat"><div class="k">缓存命中率</div><div class="v" style="font-size:19px">${(() => {
        const total = (tok.uncachedInputTokens||0) + (tok.cacheReadTokens||0);
        return total ? ((tok.cacheReadTokens/total)*100).toFixed(1) : '—';
      })()}<span class="u">%</span></div>
      <div class="muted" style="font-size:11px">输出 ${num(tok.outputTokens)} tokens</div></div>
  </div>

  <!-- ③ 明细：上下文占用 + 性能/Token，统一折叠 -->
  <details class="fold mt">
    <summary>📉 上下文占用与性能明细（当前会话）</summary>
    <div class="fold-body">
      <div class="card">
        <h3>🧮 上下文占用</h3>
        <div style="height:10px;background:var(--inset-solid);border-radius:6px;overflow:hidden;margin:10px 0">
          <div style="height:100%;width:${pressure}%;background:linear-gradient(90deg,var(--brand),var(--brand-2))"></div>
        </div>
        <div class="row c3" style="margin-top:12px">
          <div><div class="muted" style="font-size:11.5px">系统提示</div><div class="mono">${num(brk.systemTokens)}</div></div>
          <div><div class="muted" style="font-size:11.5px">工具定义</div><div class="mono">${num(brk.toolsTokens)}</div></div>
          <div><div class="muted" style="font-size:11.5px">对话消息</div><div class="mono">${num(brk.messageTokens)}</div></div>
        </div>
        <p class="muted mt" style="font-size:11.5px">压力 ${num(ctx.pressureTokens)} · 预估 ${num(ctx.projectedTokens)} · 窗口 ${num(ctx.contextWindow)}（超过阈值触发上下文压缩）</p>
      </div>

      <div class="row c2 mt">
        <div class="card">
          <h3>⏱️ 性能（累计）</h3>
          <table>
            <tr><td>模型耗时</td><td class="mono">${sec(st.llmMs)}</td></tr>
            <tr><td>工具耗时</td><td class="mono">${sec(st.toolMs)}</td></tr>
            <tr><td>首字延迟合计</td><td class="mono">${sec(st.ttftMs)}</td></tr>
            <tr><td>生成耗时</td><td class="mono">${sec(st.decodeMs)}</td></tr>
          </table>
        </div>
        <div class="card">
          <h3>🔢 Token 明细 <span class="muted" style="font-weight:400;font-size:11px">· 汇总见上方概览</span></h3>
          <table>
            <tr><td>未缓存输入</td><td class="mono">${num(tok.uncachedInputTokens)}</td></tr>
            <tr><td>缓存读取</td><td class="mono">${num(tok.cacheReadTokens)}</td></tr>
            <tr><td>缓存写入</td><td class="mono">${num(tok.cacheWriteTokens)}</td></tr>
          </table>
        </div>
      </div>
    </div>
  </details>

  ${todos && (todos.items || []).length ? `<details class="fold mt">
    <summary>✅ 会话任务进度 <span class="tag gray">${(todos.items||[]).filter(t=>t.status==='completed').length}/${(todos.items||[]).length} 已完成</span></summary>
    <div class="fold-body"><div class="card">
      <table>
        <thead><tr><th>状态</th><th>任务</th></tr></thead>
        <tbody>${(todos.items || []).map(t => {
          const tag = t.status === 'completed' ? 'ok' : t.status === 'in_progress' ? 'warn' : 'gray';
          const ico = t.status === 'completed' ? '✅' : t.status === 'in_progress' ? '🔄' : '⬜';
          return `<tr><td><span class="tag ${tag}">${fmt.esc(t.status)}</span></td>
            <td>${ico} ${fmt.esc(t.content || t.text || '')}</td></tr>`;
        }).join('')}</tbody>
      </table>
    </div></div>
  </details>` : ''}

  <details class="fold mt">
    <summary>🔐 权限策略与附件限制（当前会话）</summary>
    <div class="fold-body">
      <div class="row c2">
        <div>
          <div class="muted mb" style="font-size:11.5px">可选权限级别（文件沙箱边界）</div>
          <div style="display:flex;flex-wrap:wrap;gap:6px">
            ${(perm.options || []).map(o => `<span class="tag ${o.value === perm.value ? '' : 'gray'}">${fmt.esc(o.name || o.value)}</span>`).join('') || '<span class="muted">—</span>'}
          </div>
        </div>
        <div>
          <table>
            <tr><td>单图上限</td><td class="mono">${bytes(img.maxImageBytes)}</td></tr>
            <tr><td>消息图片数</td><td class="mono">${img.maxImagesPerMessage ?? '—'}</td></tr>
            <tr><td>最大像素</td><td class="mono">${num(img.maxImagePixels)}</td></tr>
            <tr><td>支持格式</td><td class="muted" style="font-size:11.5px">${(img.mediaTypes||[]).map(x=>'<span class="tag gray" style="font-size:10px">'+fmt.esc(x.replace('image/',''))+'</span>').join(' ') || '—'}</td></tr>
          </table>
        </div>
      </div>
    </div>
  </details>`;
};


/* ============ 动作函数 ============ */
/* ---------- 设置增强 ---------- */
async function loadSettings(redraw) {
  // settings 是全局配置：describe 端点不收 sessionId（传了会被 typert 拒绝），别加回去
  // TTL 8s：设置基本静态，来回切页不重打
  if (!redraw && State.settings?.namespaces && loaderFresh('settings', 8000)) return false;
  try { State.settings = await API.call('settings.describe', {}); stampLoader('settings'); if (redraw) render(); return true; }
  catch (e) { State.settings = { namespaces: [], writable: false, error: e.message }; return true; }
}
async function editSetting(ns) {
  const item = (State.settings?.namespaces || []).find(n => n.ns === ns);
  if (!item) return;
  const cur = JSON.stringify(item.value, null, 1);
  const next = await UI.prompt({
    title: '修改 ' + ns, value: cur, multiline: true, okText: '写入',
    hint: '⚠️ 部分配置会<b>立即生效</b>并影响 DSH 运行。支持多行 JSON，Ctrl+Enter 提交。',
    validate: (v) => { try { JSON.parse(v); return null; } catch (e) { return 'JSON 格式错误：' + e.message; } },
  });
  if (next === null || next.trim() === cur.trim()) return;
  const value = JSON.parse(next);
  const ok = await UI.confirm({ title: '确认写入', html: '写入 <code>' + fmt.esc(ns) + '</code>：<pre class="mono" style="font-size:11px;margin-top:8px;max-height:200px;overflow:auto">' + fmt.esc(JSON.stringify(value, null, 1)) + '</pre>', okText: '写入' });
  if (!ok) return;
  try { await API.call('settings.update', { ns, value }); await loadSettings(true); UI.ok('已写入 ' + ns); }
  catch (e) { UI.err('写入失败：' + e.message); }
}
async function patchSetting(ns) {
  const raw = await UI.prompt({
    title: '增量修改 ' + ns, multiline: true, okText: '应用',
    value: '{\n  "model": "deepseek-v4-pro"\n}',
    hint: '输入 <code>{路径: 值}</code> 的 JSON，会转成 <code>ops</code> 路径操作。<br>值写 <code>null</code> 表示删除该路径。',
    validate: (v) => { try { JSON.parse(v); return null; } catch (e) { return 'JSON 格式错误：' + e.message; } },
  });
  if (!raw) return;
  const patch = JSON.parse(raw);
  const ops = Object.entries(patch).map(([k, v]) => ({
    op: v === null ? 'unset' : 'set', path: k.split('.'),
    ...(v === null ? {} : { value: v }),
  }));
  const ok = await UI.confirm({ title: '确认增量修改', message: '对 ' + ns + ' 应用 ' + ops.length + ' 项修改？', okText: '应用' });
  if (!ok) return;
  try { await API.call('settings.mutate', { ns, ops }); await loadSettings(true); UI.ok('已应用'); }
  catch (e) { UI.err('修改失败：' + e.message); }
}
async function replaceSetting(ns) {
  const item = (State.settings?.namespaces || []).find(n => n.ns === ns);
  if (!item) return;
  const cur = JSON.stringify(item.value, null, 2);
  const first = await UI.confirm({
    title: '⚠️ 整体替换 ' + ns,
    html: '整体替换会<b class="danger-fg">覆盖</b>该命名空间的全部现有配置。<br><br>当前值：<pre class="mono" style="font-size:11px;max-height:180px;overflow:auto">' + fmt.esc(cur.slice(0, 800)) + '</pre>',
    okText: '继续', danger: true,
  });
  if (!first) return;
  const raw = await UI.prompt({
    title: '输入替换后的完整配置', value: cur, multiline: true, okText: '下一步',
    validate: (v) => { try { JSON.parse(v); return null; } catch (e) { return 'JSON 格式错误：' + e.message; } },
  });
  if (raw === null || raw.trim() === cur.trim()) return;
  const section = JSON.parse(raw);
  const ok = await UI.confirm({ title: '二次确认', message: '此操作不可撤销，确定要覆盖 ' + ns + ' 吗？', okText: '覆盖', danger: true });
  if (!ok) return;
  try {
    const payload = { ns, section };
    if (item.revision != null) payload.expectedRevision = item.revision;
    await API.call('settings.replace', payload);
    await loadSettings(true);
    UI.ok('已替换 ' + ns);
  } catch (e) { UI.err('替换失败：' + e.message); }
}
async function openSettingsDoc() {
  try { await API.call('settings.openDocument', {}); UI.ok('已请求打开配置文件'); }
  catch (e) { UI.err('打开失败：' + e.message); }
}

/* ---------- 凭据 ---------- */
/** DSH 对凭据键名的硬约束（实测）：必须匹配这个正则，否则**整条请求**被 gateway/bad-request 拒掉。 */
const CRED_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** 从 settings/describe 的命名空间里挖出"引用了哪些凭据名"。
 *  只认 *Env / *Ref 结尾的字符串字段（且值本身长得像键名）——
 *  `apiKey` 这种字段可能是被直接粘进配置的**明文密钥**，绝不能拿它当键名去查询/展示。
 *  @returns {{byName:Object<string,string[]>, byNs:Object<string,{field:string,name:string}[], inline:Object<string,{path:string[],set:boolean}[]>}}
 *    byName —— 键名 → 引用位置（如 llm-deepseek.apiKeyEnv）
 *    byNs   —— 命名空间 → 它期望的凭据（用于"供应商 ↔ 期望凭据"对照）
 *    inline —— 命名空间 → 内嵌密文占位（settings[].secrets，值不在本页管理） */
function settingCredRefs(settings) {
  const byName = {}, byNs = {}, inline = {};
  const add = (name, from) => { (byName[name] = byName[name] || []).includes(from) || byName[name].push(from); };
  for (const n of (settings?.namespaces || [])) {
    (function walk(o, trail) {
      if (!o || typeof o !== 'object') return;
      for (const [k, v] of Object.entries(o)) {
        if (typeof v === 'string' && /(Env|Ref)$/.test(k) && CRED_NAME_RE.test(v)) {
          const field = trail.concat(k).join('.');
          add(v, n.ns + '.' + field);
          (byNs[n.ns] = byNs[n.ns] || []).push({ field, name: v });
        } else if (v && typeof v === 'object') walk(v, trail.concat(k));
      }
    })(n.value, []);
    for (const s of (n.secrets || [])) (inline[n.ns] = inline[n.ns] || []).push({ path: s.path || [], set: s.set === true });
  }
  return { byName, byNs, inline };
}

async function loadCredentials(redraw) {
  // TTL 5s（全局数据）：凭据 describe 也是切页重打的大户
  if (!redraw && State.credentials && !State.credentials.error && loaderFresh('credentials', 5000)) return false;
  // 「设置里引用了哪些凭据名」要先有 settings —— TTL 8s，命中时零开销
  await loadSettings();
  const refs = settingCredRefs(State.settings);
  State.credRefs = refs;
  // 候选键名 = 本机凭据文件的 refs ∪ 设置引用的名字 ∪ 已查过的 ∪ 用户临时查询过的
  let local = State.credLocal;
  try { local = await API.localCredentials(); State.credLocal = local; }
  catch (e) { local = local || { exists: false, refs: [], records: [], error: e.message }; }
  const names = new Set();
  for (const n of (local.refs || [])) if (CRED_NAME_RE.test(n)) names.add(n);
  for (const n of Object.keys(refs.byName)) names.add(n);
  for (const n of Object.keys(State.credentials?.credentials || {})) names.add(n);
  for (const n of (State.credProbed || [])) if (CRED_NAME_RE.test(n)) names.add(n);
  try {
    // describe 的 refs 必须**全部**合法，混进一个非法名会导致整条请求失败（实测）
    const map = names.size ? await API.call('credentials.describe', { refs: [...names] }) : {};
    State.credentials = { credentials: map || {}, local, refs, listable: true };
    stampLoader('credentials'); if (redraw) render(); return true;
  } catch (e) {
    State.credentials = { credentials: { ...(State.credentials?.credentials || {}) }, local, refs, listable: true, error: e.message };
    return true;
  }
}
/** 按名查询一条凭据（DSH 唯一的读取方式），结果并进 State.credentials */
async function checkCredential() {
  const key = await UI.prompt({
    title: '按名查询凭据', multiline: false, placeholder: '如 DEEPSEEK_API_KEY', okText: '查询',
    hint: 'DSH 的凭据接口只能按名查询，没有"列出全部"的能力。<br>本页默认列出<b>本机凭据文件的键名</b>与<b>设置里引用的键名</b>，这里是手动补查其他名字。',
  });
  const name = String(key || '').trim();
  if (!name) return;
  if (!CRED_NAME_RE.test(name)) { UI.warn('键名只能由字母/数字/下划线组成，且不能以数字开头（DSH 的硬约束）'); return; }
  try {
    const map = await API.call('credentials.describe', { refs: [name] });
    State.credProbed = [...new Set([...(State.credProbed || []), name])];   // 记下来，下次刷新也不会丢
    State.credentials = { ...(State.credentials || {}), listable: true,
      credentials: { ...(State.credentials?.credentials || {}), ...(map || {}) } };
    render({ paintOnly: true });   // 纯客户端视图更新，别让加载器把刚查到的键冲掉
    const info = (map || {})[name];
    UI.info(name + '：' + (info ? (info.configured ? '已配置（来源 ' + (info.source || '?') + (info.writable === false ? '，只读' : '，可写') + '）' : '未配置') : 'DSH 没有返回该键名的信息'));
  } catch (e) { UI.err('查询失败：' + e.message); }
}
async function setCredential(key) {
  const name = key || await UI.prompt({ title: '新增凭据', multiline: false, placeholder: '如 DEEPSEEK_API_KEY', okText: '下一步',
    validate: (v) => v.trim() ? null : '键名不能为空' });
  if (!name) return;
  const secret = await UI.prompt({ title: '凭据值', multiline: false, placeholder: '粘贴密钥', okText: '写入',
    hint: '将以密文保存到 <code>~/.dsh/.credentials.yaml</code>', validate: (v) => v ? null : '值不能为空' });
  if (!secret) return;
  const ok = await UI.confirm({ title: '确认写入凭据', message: '写入 ' + name + ' ？', okText: '写入' });
  if (!ok) return;
  try { await API.call('credentials.set', { refs: [{ key: name, secret }] }); await loadCredentials(true); UI.ok('已写入 ' + name); }
  catch (e) { UI.err('写入失败：' + e.message); }
}
async function unsetCredential(key) {
  const ok = await UI.confirm({ title: '删除凭据', message: '删除 ' + key + ' ？不可撤销。', okText: '删除', danger: true });
  if (!ok) return;
  try { await API.call('credentials.unset', { keys: [key] }); await loadCredentials(true); UI.ok('已删除'); }
  catch (e) { UI.err('删除失败：' + e.message); }
}

/* ---------- 工作空间 / 目标 ---------- */
/** 后台作业页「刷新」：重取 session/control 的开屏基线（作业 / 队列 / 投影平时靠实时推送，这是手动兜底） */
async function refreshJobs() {
  try {
    const b = await Mux.snapshot('session/control');
    Stream.onControl({ type: 'baseline', value: b });
    render();
  } catch (e) { UI.err('刷新失败：' + e.message); }
}
async function loadWorkspaces(redraw) {
  // 工作空间列表用 workspace/follow 的基线快照 { items, archivedSessionIds }
  // TTL 5s（全局数据）：来回切页不反复开流取基线；各操作按钮都传 redraw=true 强制取
  if (!redraw && State.workspaces && !State.workspaces.error && loaderFresh('workspaces', 5000)) return false;
  try { State.workspaces = await API.workspaces(); stampLoader('workspaces'); if (redraw) render(); return true; }
  catch (e) { State.workspaces = { items: [], archivedSessionIds: [], error: e.message }; return true; }
}
function setCurrentSession(id) {
  State.sessionId = id;
  // 只记住**用户显式选择**的会话；启动/兜底的自动回退不写（见 pickDefaultSession）
  try { localStorage.setItem('dshCurrentSession', id); } catch {}
  /* 切会话 = 内容依赖链的总开关（各页头的作用域标签 scopeTag 与此对应）：
     立即重置：子代理 / 作业 / 队列 / 目标（下面四行）；
     随重绘重载：聊天流(重连)、轨迹、交付物、工作区文件、Skills、首页 hero、系统状态「当前会话」区 ——
     这些页面没有各自的状态缓存，render() 时按新 State.sessionId 重新拉取；
     不受影响：插件 / 大模型 / MCP / 智能体预设 / 凭据 / 空间列表 / 会话列表本身（🌐 全局，见 SCOPE_TAG）。 */
  // 作业/队列从**宿主级映射**里取当前会话那份（baseline 已给全量，不必等新帧）
  State.subagents = null; State.jobs = State.jobsBySession[id] || []; State.queue = State.queuesBySession[id] || [];
  State.jobsReady = Object.keys(State.jobsBySession).length > 0; State.goal = null;
  // 显式切会话 → 跟会话的 TTL 缓存全部作废（loaderFresh 的会话绑定 + 清时间戳双保险）
  for (const k of ['goal', 'subagents', 'trajectory', 'deliverables', 'workflowRuns']) {
    Stamps[k] = 0;
    if (State._loaderSid) delete State._loaderSid[k];
  }
  (async () => { await loadSubagents(); await refreshGoal(); Stream.reconnect(); render(); })();
}
async function archiveSession(workspaceId, sessionId) {
  /* workspaceId 只是调用点顺手带的 —— workspace/archiveSession 的线上参数**只有 sessionId**。
     「未分组」里出来的会话也走这里，所以文案不能写成"归档到工作空间"。 */
  const ok = await UI.confirm({ title: '归档会话', message: '归档这个会话？\n\n归档后它会从工作空间 / 未分组列表里收起来（归到页面底部「已归档会话」），会话记录保留。', okText: '归档' });
  if (!ok) return;
  try { await API.call('workspace.archiveSession', { workspaceId, sessionId }); loadWorkspaces(true); UI.ok('已归档'); }
  catch (e) { UI.err('归档失败：' + e.message); }
}
async function moveWorkspace(workspaceId) {
  const list = State.workspaces?.items || [];
  const i = list.findIndex(x => x.workspaceId === workspaceId);
  if (i <= 0) { UI.info('已在最前'); return; }
  try { await API.call('workspace.insertBefore', { workspaceId, beforeWorkspaceId: list[i - 1].workspaceId }); await loadWorkspaces(true); }
  catch (e) { UI.err('移动失败：' + e.message); }
}
async function createWorkspace() {
  const path0 = await UI.pickDir({ title: '新建工作空间 · 选择绑定目录', start: currentSession().cwd || State.host?.cwd || '', okText: '用该目录' });
  if (!path0) return;
  const title = await UI.prompt({ title: '工作空间名称', multiline: false, value: path0.split(/[\\/]/).pop() || 'new', okText: '创建' });
  if (!title) return;
  try { await API.call('workspace.create', { path: path0, title }); await loadWorkspaces(true); UI.ok('已创建「' + title + '」'); }
  catch (e) { UI.err('创建失败：' + e.message); }
}
async function renameWorkspace(id, cur) {
  const title = await UI.prompt({ title: '重命名工作空间', multiline: false, value: cur, okText: '保存' });
  if (!title || title === cur) return;
  try { await API.call('workspace.rename', { workspaceId: id, title }); await loadWorkspaces(true); UI.ok('已重命名'); }
  catch (e) { UI.err('重命名失败：' + e.message); }
}
async function deleteWorkspace(id, name) {
  const w = (State.workspaces?.items || []).find(x => x.workspaceId === id);
  const n = (w?.sessionIds || []).length;
  /* 文案对齐原生 `delete.desc`（dsh-client-ui-workspace 的中文串）：
     「将把“{name}”从工作区列表中移除。文件夹与会话记录会保留，其会话将显示在“未分组”下。」
     这句话必须写在确认框里 —— 用户最怕的就是"删空间把会话一起删了"。
     实测契约也支持：workspace/delete 只解分组，会话本身不动，后端也不动磁盘。 */
  const ok = await UI.confirm({
    title: '删除工作空间',
    message: '将把「' + name + '」从工作空间列表中移除。\n\n'
      + '· 绑定目录不会被删除\n'
      + '· 会话记录不会被删除\n'
      + (n ? '· 其下 ' + n + ' 个会话会回到「未分组」\n' : '· 该空间下没有会话\n')
      + '\n只移除这个分组，不可撤销（需要的话可以重新新建）。',
    okText: '删除', danger: true,
  });
  if (!ok) return;
  try {
    await API.call('workspace.delete', { workspaceId: id });
    await loadWorkspaces(true);
    UI.ok('已删除' + (n ? '，' + n + ' 个会话已回到「未分组」' : ''));
  }
  catch (e) { UI.err('删除失败：' + e.message); }
}
async function moveSession(workspaceId, sessionId) {
  const w = (State.workspaces?.items || []).find(x => x.workspaceId === workspaceId);
  const ids = w?.sessionIds || [];
  const i = ids.indexOf(sessionId);
  if (i <= 0) { UI.info('已在最前'); return; }
  try { await API.call('workspace.insertSessionBefore', { workspaceId, sessionId, beforeSessionId: ids[i - 1] }); await loadWorkspaces(true); }
  catch (e) { UI.err('移动失败：' + e.message); }
}
async function refreshGoal(redraw) {
  // goals/get 返回 GoalView 或空（null 也是有效结果，所以只按 TTL+会话判定，不查数据存在性）
  if (!redraw && loaderFresh('goal', 2500, State.sessionId)) return false;
  const sid = State.sessionId;
  /* ① 权威数据：**会话投影**（session/list / session/follow 都带 projections.values.goal）。
   *    它与原生 GoalBar 同源，且**不要求该会话的代理此刻活在宿主注册表里**。
   *    以前只走 goals/get —— 那个读法在会话刚被宿主卸载/重启后、以及子代理会话上都会被拒
   *    （session/not-found、session/agent-busy、GOAL_AGENT_NOT_LIVE），一失败这里就把
   *    State.goal 清成 null，页面于是显示"没有目标"，点「新建目标」又报同一个错。 */
  const proj = (State.sessions || []).find(x => x.sessionId === sid)?.projections?.values?.goal || null;
  /* ② activation 是宿主**进程本地**状态，投影里刻意没有 —— 只能从 goals/get 或
   *    goal/activation-changed 事件补。拿不到就留 undefined（页面上显示"—"，按钮交宿主裁决）。
   *    ⚠️ 只在"确实拿到了旧目标的 activation"时才沿用 —— 两个 undefined 不能算"同一个目标"。 */
  const prevGoal = (State.goal && State.goal.goal) || null;
  const keepAct = (prevGoal && proj && prevGoal.id === proj.goal.id) ? prevGoal.activation : undefined;
  try {
    const v = await API.call('goal.get', { sessionId: sid });
    if (v && v.id) {
      State.goal = { goal: v, roundsStarted: v.roundsStarted ?? proj?.roundsStarted ?? 0,
        createdAt: v.createdAt ?? proj?.createdAt, updatedAt: v.updatedAt ?? proj?.updatedAt };
    } else if (v === undefined && !proj) {
      State.goal = null;                    // 宿主明确说"没有目标"且投影也没有 → 才算真的没有
    } else if (proj) {
      State.goal = { goal: { ...proj.goal, activation: keepAct },
        roundsStarted: proj.roundsStarted ?? 0, createdAt: proj.createdAt, updatedAt: proj.updatedAt };
    } else {
      State.goal = null;
    }
  } catch (e) {
    /* goals/get 失败 ≠ 没有目标：以投影为准。只把"读不到 activation"这件事记下来。 */
    State.goal = proj
      ? { goal: { ...proj.goal, activation: keepAct }, roundsStarted: proj.roundsStarted ?? 0,
          createdAt: proj.createdAt, updatedAt: proj.updatedAt, readError: e.message }
      : null;
  }
  stampLoader('goal', sid);
  if (redraw) render();
  return true;
}
async function createGoal() {
  const obj = await UI.prompt({ title: '新建目标', multiline: true, placeholder: '描述这个长期目标，例如：把 river 图层全部处理完', okText: '创建',
    hint: '目标会跨轮次自动推进，直到完成或达到轮次上限。' });
  if (!obj) return;
  try { await API.call('goal.create', { sessionId: State.sessionId, objective: obj }); await refreshGoal(); render(); UI.ok('目标已创建'); }
  catch (e) { UI.err('创建失败：' + goalErrText(e, 'create')); }
}
async function goalAction(action) {
  const g = State.goal?.goal; if (!g) return;
  /* 前置校验（goalActionState）：宿主对相位迁移有硬约束，能提前判掉的都判掉，
     不让用户看到 `cannot resume goal "goal-…" from phase "complete"; expected …` 这种网关原始英文。 */
  const st = goalActionState(action, State.goal);
  if (!st.can) { (action === 'complete' ? UI.info : UI.warn)('无法' + ({ pause: '暂停', resume: '恢复', complete: '标记完成', edit: '编辑', clear: '清除' }[action] || action) + '：' + st.why); return; }
  const payload = { sessionId: State.sessionId, ref: { id: g.id, revision: g.revision } };
  try {
    if (action === 'edit') {
      const obj = await UI.prompt({ title: '编辑目标', value: g.objective, multiline: true, okText: '保存',
        hint: '任何相位都可以编辑（宿主只要求编辑不改变相位与阻塞原因）。' });
      if (!obj) return;
      await API.call('goal.edit', { ...payload, objective: obj });
    } else if (action === 'pause')   await API.call('goal.pause', payload);
    else if (action === 'resume')    await API.call('goal.resume', payload);
    else if (action === 'complete')  await API.call('goal.complete', payload);
    else if (action === 'clear') {
      const ok = await UI.confirm({ title: '清除目标', message: '清除后不可恢复，确定？', okText: '清除', danger: true });
      if (!ok) return;
      await API.call('goal.clear', payload);
    }
    await refreshGoal(); render();
    UI.ok('已' + ({ pause: '暂停', resume: '恢复', complete: '标记完成', edit: '保存', clear: '清除' }[action] || action));
  } catch (e) {
    // 万一还是被宿主拒了（相位/版本在我们读完之后变了）：把网关英文原文翻成人话
    UI.err(action + ' 失败：' + goalErrText(e, action));
  }
}
/** 把目标相关的宿主报错翻成能照着做的话（相位迁移 / 版本过期 / 代理不在线 / 轮次用尽） */
function goalErrText(e, action) {
  const msg = String((e && e.message) || e);
  const zh = { resume: '恢复', pause: '暂停', complete: '标记完成', edit: '编辑', clear: '清除', create: '创建' }[action] || action;
  const m = /^(?:\[gateway\/internal\]\s*)?cannot (\w+) goal[^;]*;\s*expected (.+)$/i.exec(msg);
  if (m) return '目标当前的相位不允许「' + ({ resume: '恢复', pause: '暂停', complete: '标记完成', edit: '编辑' }[m[1]] || m[1])
    + '」（宿主只接受 ' + m[2] + '）。请点右上「刷新」看最新相位后再决定。';
  if (/already active and armed/i.test(msg)) return '目标已经在自动推进（armed），不需要恢复。要停下用「暂停」。';
  if (/exhausted (\d+) goal rounds/i.test(msg)) return '推进轮次已达上限（' + RegExp.$1 + ' 轮）。请「编辑目标」调高轮次上限，或清除后新建。';
  if (/stale goal ref/i.test(msg)) return '页面上的目标版本已经过期（宿主已推进到新版本）。请点右上「刷新」后再操作。';
  if (/GOAL_AGENT_NOT_LIVE|is not live in this registry/i.test(msg))
    return '这个会话当前没有在宿主里激活（刚重启或还没开始对话），宿主不接受对它的目标操作。先在时空智能体页发一条消息把会话唤醒，再回来操作。';
  if (/agent-busy|owned by subagent/i.test(msg)) return '这是子代理会话，目标操作由父会话的代理持有。请点「↩ 回父会话」后在父会话上操作。';
  if (/no current goal|GOAL_NOT_FOUND/i.test(msg)) return '这个会话当前没有目标。';
  if (/already exists with phase/i.test(msg))
    return '这个会话已有一个未完成的目标（宿主要求先完成或清除才能新建）。请先处理现有目标。';
  return msg;
}

/* ---------- 消息队列 ---------- */
async function queueOp(itemId, kind) {
  if (kind === 'remove') {
    const ok = await UI.confirm({ title: '撤回消息', message: '撤回这条待发消息？', okText: '撤回' });
    if (!ok) return;
  }
  try {
    await API.call('session.updateQueue', { sessionId: State.sessionId, itemId, action: { kind } });
    UI.ok(kind === 'remove' ? '已撤回' : '已插话（将打断当前生成）');
  } catch (e) { UI.err('操作失败：' + e.message); }
}
async function queueEdit(itemId) {
  const it = (State.queue || []).find(x => x.id === itemId);
  const cur = (it?.message?.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
  const next = await UI.prompt({ title: '编辑待发消息', value: cur, multiline: true, okText: '保存' });
  if (next === null || next === cur) return;
  try {
    await API.call('session.updateQueue', { sessionId: State.sessionId, itemId, action: { kind: 'edit', content: [{ type: 'text', text: next }] } });
    UI.ok('已更新');
  } catch (e) { UI.err('编辑失败：' + e.message); }
}

/* ---------- 用户提问作答 ---------- */
async function answerQuestion(rpcId, questionId, value, multiSelect, isCustom) {
  if (!rpcId || !value) return;
  const q = (State.questions || []).find(x => x.rpcId === rpcId);
  if (!q) return;
  if (multiSelect) {
    q._sel = q._sel || {};
    const cur = q._sel[questionId] || [];
    q._sel[questionId] = cur.includes(value) ? cur.filter(x => x !== value) : [...cur, value];
    // 纯客户端勾选：paintOnly 重绘（完整 render 会重拉一遍会话历史，还没必要地重建 DOM）
    render({ paintOnly: true }); return;
  }
  await submitAnswers(rpcId, questionId, isCustom ? [] : [value], isCustom ? value : undefined);
}
async function submitAnswers(rpcId, questionId, selected, custom) {
  const q = (State.questions || []).find(x => x.rpcId === rpcId);
  if (!q) return;
  const btns = [...document.querySelectorAll('button')].filter(b => /提交|插话|撤回|编辑/.test(b.textContent));
  btns.forEach(b => b.classList.add('loading'));
  try {
    // 提问是 $events 上的 waterfall 事件，用 /api/$events/result 回一个 answer
    await API.answerQuestion(q, { answers: [{ id: questionId, selected, ...(custom ? { custom } : {}) }] });
    q.answered = true; render({ paintOnly: true }); UI.ok('已作答');
  } catch (e) { UI.err('作答失败：' + e.message); }
  finally { btns.forEach(b => b.classList.remove('loading')); }
}
async function submitMulti(rpcId, questionId) {
  const q = (State.questions || []).find(x => x.rpcId === rpcId);
  const sel = q?._sel?.[questionId] || [];
  if (!sel.length) { UI.warn('请至少选择一项'); return; }
  await submitAnswers(rpcId, questionId, sel);
}

/* ---------- 审批 / 作业 / 导出 ---------- */

/** 按会话取会话对象（作业页的「全部会话」视图要显示归属） */
function sessionById(id) {
  return (State.sessions || []).find(s => s.sessionId === id) || { sessionId: id };
}
/** 当前会话的作业：以宿主级映射为准（切会话时不会残留上一个会话的列表） */
function currentJobs() {
  return State.jobsBySession[State.sessionId] || State.jobs || [];
}
/** 当前会话的待处理队列，同上 */
function currentQueue() {
  return State.queuesBySession[State.sessionId] || State.queue || [];
}
/** 展开所有会话的作业，每项带上归属会话，按开始时间倒序（session/control 给的就是全量） */
function jobsOfAllSessions() {
  const out = [];
  for (const [sid, list] of Object.entries(State.jobsBySession || {})) {
    for (const j of (list || [])) out.push({ ...j, _sessionId: sid });
  }
  return out.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
}
function toggleJobsAll() {
  State.jobsAllView = State.jobsAllView !== true;
  render({ paintOnly: true });
}
async function respondApproval(approvalId, allow) {
  const a = (State.approvals || []).find(x => x.approvalId === approvalId || x.eventId === approvalId);
  if (!a) { UI.warn('该审批请求已失效'); return; }
  try {
    // 审批同样是 waterfall 事件；outcome 取 'allowed-once' / 'rejected'
    await API.respondApproval(a, allow);
    // 对话流里的审批卡就地改为"已处理"态（chatlog 是 DOM_OWNED，节点跨重绘搬运，状态不丢）
    const card = document.querySelector('[data-appr-id="' + CSS.escape(String(a.approvalId || a.eventId || approvalId)) + '"]');
    if (card) card.innerHTML = '<div class="apprcard done"><span class="tag ' + (allow ? 'ok' : 'warn') + '">' + (allow ? '已允许' : '已拒绝') + '</span>'
      + (a.toolName ? '<span class="muted mono" style="font-size:10.5px">' + fmt.esc(String(a.toolName).slice(0, 60)) + '</span>' : '') + '</div>';
    // 审批按钮也可能在对话页侧栏（或作业页）：只改客户端状态，
    // 用 paintOnly 重绘 —— 否则会把用户写到一半的指令和已选附件一起冲掉
    render({ paintOnly: true });
    UI.ok(allow ? '已允许' : '已拒绝');
  } catch (e) { UI.err('响应失败：' + e.message); }
}
function exportSession(id) {
  // 可传任意会话 ID（会话列表每行的「导出」）；不传则导出当前会话
  const sid = id || State.sessionId;
  if (!sid) { UI.err('没有可导出的会话'); return; }
  // 会话日志 ZIP：GET 下载域（控制台按字节转发），includeDescendants 把子代理会话一并打包
  window.open('/api/session.export?sessionId=' + encodeURIComponent(sid) + '&includeDescendants=true', '_blank');
}

/* ---------- 子代理 ---------- */
async function loadSubagents(refresh) {
  if (!State.sessionId) return false;
  // TTL 2.5s + 会话绑定：切页来回跳不重打；发消息/打断后的 loadSubagents(true) 仍强制取
  if (!refresh && State.subagents?.entries && loaderFresh('subagents', 2500, State.sessionId)) return false;
  try { State.subagents = await API.call('subagent.list', { parentSessionId: State.sessionId }); stampLoader('subagents', State.sessionId); if (refresh) render(); return true; }
  catch (e) { State.subagents = { entries: [], parentAvailable: false, error: e.message }; return true; }
}
async function loadSubagentHistory(_x, id) {
  const box = document.getElementById('sahist-' + id);
  if (!box) return;
  if (box.innerHTML) { box.innerHTML = ''; return; }
  box.innerHTML = '<div class="muted mt"><span class="loading"></span> 读取历史…</div>';
  stamp('subhist');
  try {
    const entry = (State.subagents?.entries || []).find(e => e.id === id);
    // 子代理历史用同一套 session/follow 快照，地址换成 subagent
    const v = await API.subHistory(State.sessionId, id, entry?.mode || 'continuable');
    const events = v.events || [];
    const msgs = events.filter(e => e.event?.type === 'assistant/message' || e.event?.type === 'user/message').slice(-8);
    box.innerHTML = '<div class="mt" style="border-top:1px solid var(--line);padding-top:10px">'
      + '<div class="muted mb">最近 ' + msgs.length + ' 条消息（共 ' + events.length + ' 个事件）</div>'
      + msgs.map(m => {
          const role = m.event.type === 'user/message' ? '👤 用户' : '🤖 助手';
          const text = (m.event.data.content || m.event.data.message?.content || []).filter(b => b.type === 'text').map(b => b.text).join(' ');
          return '<div style="margin:6px 0"><span class="tag gray" style="font-size:10.5px">' + role + '</span> '
            + '<span style="font-size:12px;white-space:pre-wrap">' + fmt.esc(text.slice(0, 300)) + '</span></div>';
        }).join('') + '</div>';
  } catch (e) { box.innerHTML = '<div class="alert err mt">读取失败：' + fmt.esc(e.message) + '</div>'; }
}
async function promptSubagent(id, delivery) {
  const steer = delivery === 'steer';
  const text = await UI.prompt({
    title: steer ? '插话给子代理（打断当前步）' : '给子代理发送消息', multiline: true, okText: '发送',
    hint: steer
      ? '消息会插到最近的步骤边界，而不是排在下一轮。'
      : '默认 <code>delivery:&quot;queue&quot;</code>：消息排到子代理的下一轮。想中途打断改用「插话」。',
  });
  if (!text) return;
  try {
    await API.call('subagent.prompt', { parentSessionId: State.sessionId, childSessionId: id,
      mode: 'continuable', delivery: steer ? 'steer' : 'queue', content: [{ type: 'text', text }] });
    UI.ok(steer ? '已插话' : '已发送'); loadSubagents(true);
  } catch (e) { UI.err((steer ? '插话' : '发送') + '失败：' + e.message); }
}
async function interruptSubagent(id) {
  const ok = await UI.confirm({ title: '打断子代理', message: '打断 ' + id.slice(0, 12) + '… 的当前回合？', okText: '打断' });
  if (!ok) return;
  try { await API.call('subagent.interrupt', { parentSessionId: State.sessionId, childSessionId: id }); UI.ok('已请求打断'); loadSubagents(true); }
  catch (e) { UI.err('打断失败：' + e.message); }
}

/* ---------- 会话 ---------- */
async function reloadSessions() {
  const s = await API.call('session.list', {});
  State.sessions = s.items || [];
  ensureCurrentSession();   // 当前会话仍在列表 → 不动；失效才回默认（绝不因为新会话出现而切换）
  stamp('sessions');
  render();
}
async function refreshSessionsLite(force) {
  // TTL 2s：首页/会话页来回切不重打 session.list+subagent.list（手动刷新按钮走 reloadSessions，不受影响）
  if (!force && (State.sessions || []).length && loaderFresh('sessions', 2000)) return false;
  try {
    const [s, sa] = await Promise.all([
      API.call('session.list', {}),
      API.call('subagent.list', { parentSessionId: State.sessionId }).catch(() => null),
    ]);
    State.sessions = s.items || [];
    ensureCurrentSession(); // 静默刷新同样不切会话；当前会话被移除时才兜底
    if (sa) State.subagents = sa;
    stampLoader('sessions');
    return true;
  } catch (e) { return false; }
  // 注意：此函数不重绘；由调用方决定是否需要 render()
}
/** 新建会话：**一步**选好"在哪个工作空间 + 用哪个智能体预设"。
 *
 *  ⚠️ 为什么**只允许选已有工作空间**（用户明确要求，不允许在会话窗口新建目录/空间）：
 *  会话的 cwd 决定项目级能力的作用域（Skills、相对路径、交付物扫描、工作空间归属都挂在它上面）。
 *  DSH 的工作空间就是"一个绑定路径"，会话 cwd 与之相同即自动归属该空间 ——
 *  随手挑一个新目录的后果是：这个会话不属于任何工作空间，Skills / 交付物页全都对不上。
 *  所以"最近用过的目录""选择其他目录…"这些入口已全部移除；没有空间就去工作空间页先建。
 *  智能体预设也收进同一个弹框：原来要"选目录 → 再弹一次预设"，点完第一步才知道还有第二步。 */
async function newSession() {
  if (!State.workspaces || State.workspaces.error) await loadWorkspaces();
  const ws = ((State.workspaces && State.workspaces.items) || []).slice();
  const presets = State.presets || [];
  const presetIds = presets.map(p => p.id);
  const defPreset = presetIds.includes('code') ? 'code'
    : (presets.find(p => p.isDefault)?.id || presetIds[0] || 'code');

  return new Promise((resolve) => {
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    const opts = ws.length ? [{ group: '🗂️ 已有工作空间', items: ws.map(w => ({
      value: String(w.path || ''), title: w.title || w.path, sub: String(w.path || ''),
      badge: (w.sessionIds || []).length + ' 个会话',
    })) }] : [];
    const flat = opts.flatMap(g => g.items);
    let sel = flat.length ? flat[0].value : '';
    const renderList = () => {
      const rows = [];
      for (const g of opts) {
        rows.push('<div class="ns-group">' + fmt.esc(g.group) + '</div>');
        for (const it of g.items) {
          /* ⚠️ data-v 必须用 fmt.h（HTML 属性转义），不能用 fmt.attr —— 后者是"内联事件里的 JS 字符串"
             专用（自带一对引号），塞进属性会让 dataset.v 变成 `"C:\path"`（带引号），
             与真实路径永不相等 → 点哪一行都选不中、高亮也不动。这就是"选择工作空间无法选中"的根因。 */
          rows.push('<div class="ns-item' + (it.value === sel ? ' on' : '') + '" data-v="' + fmt.h(it.value) + '">'
            + '<span class="ns-dot"></span>'
            + '<span class="ns-txt"><b>' + fmt.esc(it.title) + '</b>'
            + '<span class="mono">' + fmt.esc(it.sub) + '</span></span>'
            + (it.badge ? '<span class="tag gray">' + fmt.esc(it.badge) + '</span>' : '')
            + '</div>');
        }
      }
      return rows.join('');
    };
    mask.innerHTML = '<div class="modal" style="width:min(600px,100%)">'
      + '<h3>新建会话</h3>'
      + '<div class="modal-body">'
      + '<div class="modal-hint">会话只能建在<b>已有工作空间</b>里——会话工作目录与空间绑定路径相同即自动归属该空间。'
      + '要新目录请先到 <a href="#/workspace">工作空间</a> 页创建，这里不再提供"选择其他目录"。</div>'
      + '<div class="ns-list" id="ns-list"></div>'
      + '<div class="mt" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">'
      + '<span class="muted mono" style="font-size:11px;word-break:break-all" id="ns-sel"></span></div>'
      + '<div class="mf-field mt"><div class="mf-label">智能体预设 <span class="muted">（决定这个会话的工具与提示词组合）</span></div>'
      + '<select class="input" id="ns-preset">'
      + (presets.length
        ? presets.map(p => '<option value="' + fmt.h(p.id) + '"' + (p.id === defPreset ? ' selected' : '') + '>'
          + fmt.esc(p.name || p.id) + (p.isDefault ? '（部署默认）' : '') + '</option>').join('')
        : '<option value="code">code（未能读到清单，按默认值）</option>')
      + '</select></div>'
      + '</div>'
      + '<div class="modal-actions"><button class="btn" id="ns-cancel">取消</button>'
      + '<button class="btn primary" id="ns-ok">创建会话</button></div></div>';
    document.body.appendChild(mask);

    const listEl = mask.querySelector('#ns-list');
    const selEl = mask.querySelector('#ns-sel');
    const paint = () => {
      listEl.innerHTML = renderList()
        || '<div class="empty">还没有任何工作空间。请先到 <a href="#/workspace">工作空间</a> 页创建一个，再回来新建会话。</div>';
      [...listEl.querySelectorAll('.ns-item')].forEach(el => { el.onclick = () => { sel = el.dataset.v; paint(); }; });
      selEl.textContent = sel ? '将创建于：' + sel : '（还没有可选的工作空间）';
      const okBtn = mask.querySelector('#ns-ok');
      okBtn.disabled = !sel;
      okBtn.title = sel ? '' : '没有工作空间可选：请先到「工作空间」页创建';
    };
    const close = (v) => { mask.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
    const onKey = (e) => { if (e.key === 'Escape') close(null); };
    document.addEventListener('keydown', onKey);
    mask.querySelector('#ns-cancel').onclick = () => close(null);
    mask.querySelector('#ns-ok').onclick = async () => {
      if (!sel) { UI.warn('请先选一个已有工作空间（或先到工作空间页创建）'); return; }
      const preset = mask.querySelector('#ns-preset').value || 'code';
      close(true);
      try { await API.call('session.create', { cwd: sel, agentPreset: preset }); UI.ok('已创建会话'); await reloadSessions(); }
      catch (e) { UI.err('创建失败：' + e.message); }
    };
    mask.onclick = (e) => { if (e.target === mask) close(null); };
    paint();
  });
}
async function forkSession(sid) {
  const ok = await UI.confirm({ title: '分叉会话', message: '分叉该会话？', okText: '分叉' });
  if (!ok) return;
  try { await API.call('session.fork', { sessionId: sid }); UI.ok('已分叉'); await reloadSessions(); }
  catch (e) { UI.err('分叉失败：' + e.message); }
}
/** 「在新对话中分支」：从某一轮的结束处复制出新会话（对齐原生 message.branch）。
 *  宿主只接受**已完成轮次**内的锚点：它取 >= atSeq 的第一个 turn/end，切到其后那一条。
 *  锚点用该轮的 turn/start seq —— 一定落在该轮内、且早于该轮任何消息。 */
async function branchAtTurn(turn) {
  const r = Turns.of(turn, false);
  if (!r) { UI.warn('第 ' + turn + ' 轮已不在已加载的事件里（重新载入会话后再试）'); return; }
  if (!Turns.done(turn)) { UI.warn('仅可从已完成轮次的最后一条消息分支'); return; }
  if (r.startSeq == null) { UI.warn('没找到该轮的起始事件，无法定位分支点'); return; }
  const ok = await UI.confirm({
    title: '在新对话中分支',
    message: '把第 ' + turn + ' 轮结束时的上下文复制成一个新会话。当前会话不受影响，新会话里可以换个方向继续追问。',
    okText: '在新对话中分支',
  });
  if (!ok) return;
  try {
    await API.call('session.fork', { sessionId: State.sessionId, atSeq: r.startSeq });
    UI.ok('已在新对话中分支');
    await reloadSessions();
  } catch (e) { UI.err('分支失败：' + e.message); }
}
/** 会话页切模型：分组下拉弹窗（与时空智能体侧栏「🧠 模型」同一数据与交互），
 *  替代旧的"手输序号 + 手输 effort"两步 prompt。
 *
 *  ⚠️ 回显必须取**目标会话自己**的投影 modelSelection.next，不能用 State.models.current：
 *  后者是 modelCatalog 的**全局默认**（还不接受 sessionId），跟某个具体会话毫无关系，
 *  结果就是弹框每次都回到默认值、推理强度永远是「（默认）」，
 *  用户看起来像"切了没生效、再点开又没了"。这就是本次修的那个回显 bug。
 *  投影形状是 {lastUsed, next}，不是扁平的 {provider,model} —— 见 sessionModelOf()。 */
async function selectModel(sid) {
  const groups = State.models?.groups || [];
  const flat = groups.flatMap(g => (g.models || []).map(m => ({ ...m, gid: g.id })));
  if (!flat.length) { UI.warn('模型列表为空，请先到大模型页「发现模型」'); return; }
  const target = (State.sessions || []).find(s => s.sessionId === sid) || {};
  const title = target.projections?.values?.title || '';
  const ms = sessionModelOf(sid);          // 会话级 next ?? 全局默认（见 sessionModelOf 的注释）
  const curKey = (ms.provider || '') + '/' + (ms.model || '');
  const curEffort = ms.reasoningEffort || '';
  return new Promise((resolve) => {
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.innerHTML = '<div class="modal" style="width:min(480px,100%)">'
      + '<h3>切换模型 <span class="muted" style="font-size:11.5px;font-weight:400">'
      + fmt.esc(title || '未命名会话') + ' <span class="mono">' + fmt.esc(sid.slice(0, 14)) + '…</span></span></h3>'
      + '<div class="modal-body">'
      + '<div class="muted" style="font-size:11.5px;margin-bottom:4px">模型'
      + (curKey && curKey !== '/' ? ' <span class="tag gray">当前 ' + fmt.esc(curKey) + '</span>' : '') + '</div>'
      + '<select class="input" id="sm-model" style="width:100%">'
      + groups.map(g => '<optgroup label="' + fmt.esc(g.name || g.id || '') + '">'
        + (g.models || []).map(m => {
          const v = (g.id || '') + '/' + m.id;
          return '<option value="' + fmt.esc(v) + '"' + (v === curKey ? ' selected' : '') + '>' + fmt.esc(m.name || m.id) + '</option>';
        }).join('') + '</optgroup>').join('')
      + '</select>'
      + '<div class="muted" style="font-size:11.5px;margin:10px 0 4px">推理强度'
      + (curEffort ? ' <span class="tag gray">当前 ' + fmt.esc(curEffort) + '</span>' : ' <span class="muted">（该会话还没设过，用模型默认）</span>')
      + '</div>'
      + '<select class="input" id="sm-effort" style="width:100%"></select>'
      + '</div>'
      + '<div class="modal-actions"><button class="btn" id="sm-cancel">取消</button>'
      + '<button class="btn primary" id="sm-ok">切换</button></div></div>';
    document.body.appendChild(mask);
    const close = (v) => { mask.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
    const onKey = (e) => { if (e.key === 'Escape') close(null); };
    document.addEventListener('keydown', onKey);
    const modelSel = mask.querySelector('#sm-model');
    const effSel = mask.querySelector('#sm-effort');
    /* 填推理强度下拉，并**回显当前值**：
       目标会话已设过 effort 时，把它选中；若它不在该模型的候选里（比如换到了别的模型、
       或值是供应商默认），额外补一个「（当前值）」选项 —— 否则下拉会静默跳回「（默认）」，
       用户以为值丢了。 */
    const fillEfforts = (want) => {
      const key = modelSel.value;
      const m = flat.find(x => (x.gid + '/' + x.id) === key);
      const efforts = (m?.reasoning?.efforts) || [];
      const has = v => !!v && efforts.some(e => e.id === v);
      let html = '<option value="">（默认：' + fmt.esc(m?.reasoning?.defaultEffort || '模型供应商默认') + '）</option>';
      html += efforts.map(e => '<option value="' + fmt.esc(e.id) + '">'
        + fmt.esc(e.name || e.id) + (e.id === m?.reasoning?.defaultEffort ? '（模型默认）' : '') + '</option>').join('');
      if (want && !has(want)) html += '<option value="' + fmt.esc(want) + '">' + fmt.esc(want) + '（当前值 · 不在该模型候选里）</option>';
      effSel.innerHTML = html;
      effSel.value = want || '';       // 不在候选里时已被上面那条选项兜住，赋不进来自动落回「（默认）」
    };
    fillEfforts(curEffort);
    modelSel.onchange = () => fillEfforts('');
    mask.querySelector('#sm-cancel').onclick = () => close(null);
    mask.querySelector('#sm-ok').onclick = async () => {
      const [provider, ...rest] = modelSel.value.split('/');
      const model = rest.join('/');
      const effort = effSel.value;
      const payload = { sessionId: sid, provider, model };
      if (effort) payload.reasoningEffort = effort;
      const changed = (payload.provider + '/' + payload.model) !== curKey || effort !== curEffort;
      close(true);
      if (!changed) { UI.info('模型与推理强度都没有变化'); return; }
      try {
        await API.call('session.selectModel', payload);
        UI.ok('已切换到 ' + model + (effort ? '（推理强度 ' + effort + '）' : ''));
        await reloadSessions();
        render();   // 会话列表 / 时空智能体侧栏的「当前模型」都要跟着刷新
      }
      catch (e) { UI.err('切换失败：' + e.message); }
    };
  });
}
async function renameSession(sid) {
  const cur = (State.sessions.find(x => x.sessionId === sid) || {}).projections?.values?.title || '';
  const name = await UI.prompt({ title: '重命名会话', multiline: false, value: cur, okText: '保存' });
  if (!name) return;
  try { await API.call('session.rename', { sessionId: sid, title: name }); reloadSessions(); UI.ok('已重命名'); }
  catch (e) { UI.err('改名失败：' + e.message); }
}
async function cancelSession(sid) {
  const ok = await UI.confirm({ title: '取消回合', message: '取消该会话正在进行的回合？', okText: '取消回合' });
  if (!ok) return;
  try { await API.call('session.cancel', { sessionId: sid }); UI.ok('已请求取消'); reloadSessions(); }
  catch (e) { UI.err('取消失败：' + e.message); }
}
async function viewHistory(sid) {
  const box = document.getElementById('histpanel');
  box.innerHTML = '<div class="card mt"><div class="empty"><span class="loading"></span> 读取会话历史…</div></div>';
  stamp('history');
  try {
    // 子代理会话由 API.history 内部自动走 subagent 通道（分流收在一个口子上）
    const v = await API.history(sid, true);
    const ev = v.events || [];
    const msgs = ev.filter(x => x.event?.type === 'user/message' || x.event?.type === 'assistant/message').slice(-40);
    box.innerHTML = '<div class="card mt"><h3>📜 会话历史（最近 ' + msgs.length + ' 条 / 共 ' + ev.length + ' 个事件）'
      + '<span class="muted" style="font-weight:400;font-size:11.5px;margin-left:8px">hasMore=' + (v.hasMore ? '是' : '否') + '</span></h3>'
      + msgs.map(m => {
          const role = m.event.type === 'user/message' ? '👤' : '🤖';
          const text = (m.event.data.content || m.event.data.message?.content || []).filter(b => b.type === 'text').map(b => b.text).join(' ');
          return '<div style="margin:8px 0;padding:8px 10px;background:var(--panel-2);border-radius:8px">'
            + '<span class="tag gray" style="font-size:10.5px">' + role + ' seq ' + m.event.seq + '</span> '
            + '<span style="font-size:12px;white-space:pre-wrap">' + fmt.esc(text.slice(0, 400)) + '</span></div>';
        }).join('') + '</div>';
  } catch (e) { box.innerHTML = '<div class="alert err mt">读取失败：' + fmt.esc(e.message) + '</div>'; }
}

/* ---------- 对话历史 ---------- */
/** 对话页工具条的「刷新」：整体重建当前会话的消息面板（消息是全量载入的，重载即全部重取） */
async function reloadChat() { await loadChatHistory(); }
async function loadChatHistory() {
  const log = document.getElementById('chatlog');
  if (!log || !State.sessionId) return;
  State.chatLogSession = State.sessionId;   // 记下这块内容属于哪个会话（见 paintDirect）
  // 这块内容马上要被整体重建：丢掉"正在流式的气泡"引用，让后续增量在新气泡里继续。
  // 否则增量会写进已被丢弃的节点 —— 表现是这条回复一个字都看不见（直到完整消息到达才补上）。
  Chat.cur = null; Chat.curKey = null;
  log.innerHTML = '<div class="empty"><span class="loading"></span> 读取会话历史…</div>';
  try {
    /* **全量载入**：session/follow 的开屏快照只给最近一窗（hasMore=true 表示还有更早的）。
     *  以前这里就停在第一窗、再用「载入历史消息」按钮人工补 —— 用户反馈"不要部分载入"。
     *  现在在这里把剩余的页一次翻完（session/page + throughSeq/beforeSeq 向前翻），
     *  翻完再进渲染循环，Turns 元数据与工具配对天然就是全量的。 */
    const v0 = await API.history(State.sessionId, true);   // 工具条「刷新」/切会话都要求真取，不吃 4s 缓存
    let events = v0.events || [];
    let more = v0.hasMore === true;
    const cursor = v0.cursor ?? null;      // session/page 的切点：固定用 follow 开屏的 cursor（与轨迹页同款）
    let pages = 0;
    while (more && cursor != null && pages < 200) {          // 200 页兜底：防宿主异常时死循环
      const v = await API.call('session.page', { request: {
        address: { kind: 'session', sessionId: State.sessionId },
        throughSeq: cursor, beforeSeq: events.length ? events[0].seq : 0,
        maxMessages: 2000,
      } });
      const older = (v.records || []).map(r => ({ event: r.event, view: r.view }));
      if (!older.length) break;
      events = older.concat(events);
      more = v.hasMore === true;
      pages++;
      log.innerHTML = '<div class="empty"><span class="loading"></span> 读取会话历史… 已回溯 '
        + events.length + ' 个事件</div>';
    }
    // 先按**全量**事件把每轮的元数据建好（用量/用时/能否分支）。
    // 必须在渲染之前做：turn/end 与 turn/start 可能落在被裁掉的窗口之外，
    // 而"本轮用时""能否分支"都依赖它们；渲染时再算就晚了。
    Turns.reset();
    State.msgText = {}; State._mtOrder = [];
    State.feedback = {};            // 👍/👎 的选中态从历史里的 feedback 事件重建，不猜
    // seq → 轮号。用户消息自己不携带轮号（宿主只在 turn/start 上给），
    // 按「紧接着的那个 turn/start」归属；末尾还没有 turn/start 的归最后一轮。
    const starts = events
      .filter(x => x.event?.type === 'turn/start' && Number.isFinite(Number(x.event.data?.turn)))
      .map(x => ({ seq: Number(x.event.seq), turn: Number(x.event.data.turn) }))
      .sort((a, b) => a.seq - b.seq);
    const turnOfSeq = (seq) => {
      const s = Number(seq);
      if (!Number.isFinite(s)) return null;
      for (const t of starts) if (t.seq > s) return t.turn;
      return starts.length ? starts[starts.length - 1].turn : null;
    };
    // 用户消息的文本（第一条真实输入的）—— 与本轮最终回答一起供轮末页脚复制
    const userTextOf = (e) => {
      const src = e.data?.source || {};
      const txt = (e.data?.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
      if (src.kind !== 'user' || !txt) return '';
      return /^Current runtime context|^<system-reminder>/.test(txt) ? '' : txt;
    };
    for (const x of events) {
      const e = x.event; if (!e) continue;
      if (e.type === 'turn/start') { Turns.start(e.data?.turn, e.time, e.seq); }
      else if (e.type === 'turn/end') { Turns.end(e.data?.turn, e.data?.reason, e.time); }
      else if (e.type === 'step/start') { Turns.step(e.data?.turn, e.data?.step, e.time); }
      else if (e.type === 'user/message') {
        const t = turnOfSeq(e.seq), txt = userTextOf(e);
        if (t != null && txt) Turns.user(t, txt, e.time);
      }
      else if (e.type === 'assistant/message') {
        // 计时（TTFT/TPS）依赖同一步的 step/start，而它在事件流里排在前面 —— 这里顺序遍历刚好赶得上
        const am = e.data?.message || {};
        const atext = (am.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
        Turns.message(e.data?.turn, e.data?.usage, am.source, e.seq, msgTiming(e), atext, am.id, e.time, e.data?.step);
      }
      else if (e.type === 'tool/call') { /* 工具行本身自渲染；轮统计不再按步累计 */ }
      else if (e.type === 'feedback/message-put') {
        const it = e.data?.item || {};
        if (it.messageId) State.feedback[it.messageId] = it;
      }
      else if (e.type === 'feedback/message-delete') {
        if (e.data?.messageId) delete State.feedback[e.data.messageId];
      }
    }
    /* 工具调用与结果配对：结果事件里**没有**工具名与参数，而卡片的标题/摘要/diff 全都要靠它们，
     * 所以先把两者按 callId 对上，渲染工具行时一次画全（不再"先画一张再回来补"）。 */
    const resByCall = new Map();
    for (const x of events) {
      const e = x.event; if (!e || e.type !== 'tool/result') continue;
      const block = (e.data?.message?.content || []).find(c => c.type === 'tool-result');
      const callId = block?.toolCallId || e.data?.message?.source?.callId;
      if (!callId) continue;
      resByCall.set(callId, {
        text: block ? ToolCard.textOf(block.content) : '',
        isError: !!block?.isError, meta: e.data?.meta,
        media: mediaHtml(State.sessionId, block?.content), seq: e.seq,
      });
    }
    /* 会话设置三条（权限预设 / 沙箱模式 / 审批策略）合成一行，放在流的最前面 */
    const setBits = [];
    for (const x of events) {
      const e = x.event; if (!e) continue;
      if (e.type === 'permission/preset') setBits.push('权限预设 ' + (e.data?.preset || ''));
      else if (e.type === 'sandbox/mode') setBits.push('沙箱模式 ' + (e.data?.mode || ''));
      else if (e.type === 'approval/policy') setBits.push('审批策略 ' + (e.data?.policy || ''));
    }
    /* 逐事件造"行"。这里覆盖的快照事件类型是实测出来的全集（26 种），
     * 不再像以前那样只认 6 种 —— 那正是"少了好多东西"的原因。 */
    const ROWS = new Set(['user/message', 'assistant/message', 'tool/call', 'tool/result', 'tool/code-dispatch',
      'todo/write', 'system/message', 'request/context', 'request/header', 'deliverables/presented',
      'compaction/start', 'compaction/summary', 'compaction/end', 'goal/change', 'subagent/catalog',
      'tool-workflow/run-start', 'tool-workflow/agent-start', 'tool-workflow/agent-end', 'tool-workflow/run-end',
      'agent/inbox/spliced']);
    const rows = events.filter(x => x.event && ROWS.has(x.event.type));
    // 不再做行数裁剪：会话消息**全量载入**（事件已在上面翻页取完）。
    // 上限曾设 240 行 —— 那正是"部分载入"的来源，配合「载入历史消息」按钮一起已被去掉。
    const shownRows = rows;
    log.innerHTML = '';
    if (!shownRows.length) { log.innerHTML = '<div class="empty">该会话还没有对话消息</div>'; return; }
    if (setBits.length) {
      const w = pushChatRow(ChatRow.settings(setBits), 'crow-set-slot', null, null);
      if (w) w.removeAttribute('data-turn');
    }
    shownRows.forEach(x => {
      const e = x.event, d = e.data || {}, seq = e.seq;
      // 没有轮号的事件（请求头、工作流、目标…）归到"这一条所属的轮" —— 与用户消息同一套归属规则
      const curTurn = () => (d.turn != null ? d.turn : turnOfSeq(seq));
      switch (e.type) {
        /* 会话设置之外的三类"元信息行" */
        case 'system/message': {
          const t = (d.message?.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
          if (t) pushChatRow(ChatRow.system(t), 'crow-sys-slot', d.turn, seq);
          return;
        }
        case 'request/context': return void pushChatRow(ChatRow.context(d), 'crow-ctx-slot', curTurn(), seq);
        case 'request/header': return void pushChatRow(ChatRow.header(d), 'crow-head-slot', curTurn(), seq);
        case 'compaction/start': return void pushChatRow(ChatRow.compaction('start', d), 'crow-compact-slot', curTurn(), seq);
        case 'compaction/summary': return void pushChatRow(ChatRow.compaction('summary', d), 'crow-compact-slot', curTurn(), seq);
        case 'compaction/end': return void pushChatRow(ChatRow.compaction('end', d), 'crow-compact-slot', curTurn(), seq);
        case 'goal/change': return void pushChatRow(ChatRow.goal(d), 'crow-goal-slot', curTurn(), seq);
        case 'subagent/catalog': return void pushChatRow(ChatRow.subagent(d), 'crow-sub-slot', curTurn(), seq);
        case 'tool-workflow/run-start': State.wfRun = { runId: d.runId, name: d.name };
          return void pushChatRow(ChatRow.workflow('run-start', d), 'crow-wf-slot', curTurn(), seq);
        case 'tool-workflow/agent-start': return void pushChatRow(ChatRow.workflow('agent-start', d), 'crow-wf-slot', curTurn(), seq);
        case 'tool-workflow/agent-end': return void pushChatRow(ChatRow.workflow('agent-end', d), 'crow-wf-slot', curTurn(), seq);
        case 'tool-workflow/run-end': State.wfRun = null;
          return void pushChatRow(ChatRow.workflow('run-end', d), 'crow-wf-slot', curTurn(), seq);
        case 'agent/inbox/spliced':
          if (d.removedCount) pushChatRow(ChatRow.inbox(d), 'crow-inbox-slot', curTurn(), seq);
          return;
        case 'deliverables/presented':
          return void pushChatRow(ChatRow.deliverables(d.files, d.turn), 'crow-deliver-slot', d.turn, seq);
        case 'turn/end': {
          const rk = (d.reason && d.reason.kind) || '';
          if (rk && rk !== 'completed') {
            const txt = rk === 'max-tokens' ? '已达到输出 token 上限（发送「继续」可让模型接着输出）'
              : rk === 'interrupted' ? '已停止' : rk === 'turn-error' ? '本轮运行失败' : reasonText(rk);
            const kind = rk === 'max-tokens' ? 'max' : rk === 'interrupted' ? 'stopped' : 'error';
            pushChatRow(ChatRow.notice(kind, txt), 'crow-note-slot', d.turn, seq);
          }
          return;
        }
        /* 工具调用：name + args + 配对到的结果一次画全 */
        case 'tool/call': {
          const res = resByCall.get(d.callId) || {};
          const w = document.createElement('div');
          w.className = 'rail tool-slot';
          w.dataset.callId = d.callId || '';
          w.dataset.tool = d.name || '';
          w.dataset.args = (typeof d.arguments === 'string') ? d.arguments : JSON.stringify(d.arguments || {});
          if (d.turn != null) w.dataset.turn = String(Number(d.turn));
          if (seq != null) w.dataset.seq = String(Number(seq));
          w.innerHTML = ToolCard.html({
            name: d.name, args: d.arguments, result: res.text, meta: res.meta,
            isError: res.isError, state: res.text == null ? 'running' : (res.isError ? 'error' : 'ok'),
            media: res.media,
          });
          log.appendChild(w);
          return;
        }
        case 'tool/result': return;   // 已在上面按 callId 配对消费掉了
        case 'tool/code-dispatch': {
          const w = document.createElement('div');
          w.className = 'rail chat-subcall';
          if (d.turn != null) w.dataset.turn = String(Number(d.turn));
          if (seq != null) w.dataset.seq = String(Number(seq));
          w.innerHTML = '↳ 子调用 <b class="mono">' + fmt.esc(d.name) + '</b> '
            + fmt.esc(String((d.arguments || {}).file_path || (d.arguments || {}).toolName || '').slice(0, 60));
          log.appendChild(w);
          return;
        }
        case 'todo/write': {
          const items = d.todos || [];
          if (!items.length) return;
          const done = items.filter(t => t.status === 'completed').length;
          const html = '<div class="crow crow-todo"><div class="crow-h">✅ 更新任务清单'
            + '<span class="crow-meta">' + done + '/' + items.length + ' 已完成</span></div>'
            + items.map(t => '<div class="td-item">' + (t.status === 'completed' ? '✅' : t.status === 'in_progress' ? '🔄' : '⬜')
              + ' ' + fmt.esc(t.content) + '</div>').join('') + '</div>';
          pushChatRow(html, 'crow-todo-slot', curTurn(), seq);
          return;
        }
        /* 用户消息：真实输入画气泡；运行时上下文注入单列一行 */
        case 'user/message': {
          const blocks = d.content || [];
          const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('\n');
          const t = turnOfSeq(seq);
          const isReal = (d.source?.kind === 'user') && !/^Current runtime context|^<system-reminder>/.test(text);
          // 非用户输入：按 source 分型成行，**正文照旧可展开读**（以前画成空行 = 内容丢失）。
          // 末位 false = 参与轮次过程折叠：原生 compact 视图里这些注入/回传本来就是"过程"的一部分
          if (!isReal) { pushChatRow(ChatRow.source(d, blocks), 'crow-src-slot', t, seq); return; }
          const bubble = Chat.row('user', { turn: t, seq, time: e.time });
          bubble.innerHTML = fmt.esc(text) + mediaHtml(State.sessionId, blocks)
            + extraBlocksHtml(blocks);
          return;
        }
        /* 助手消息：思考块 + 正文。纯工具调用步没有可显示的正文，不占版面 */
        case 'assistant/message': {
          const blocks = d.message?.content || [];
          const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('\n');
          const think = reasoningOf(blocks);
          const extra = extraBlocksHtml(blocks);
          // 只有认不出的块时也要占一行 —— 否则"这条消息有内容但什么都没显示"
          if (!text.trim() && !think && !extra) return;
          const bubble = Chat.row('agent', { turn: d.turn, seq });
          // 思考块在正文**之前**（原生也是先思考后正文）；历史里一律收起
          bubble.innerHTML = reasoningHtml(think, false) + MD.render(text)
            + mediaHtml(State.sessionId, blocks) + extra;
          return;
        }
      }
    });
    /* 本轮文件改动（原生 produced.label）：把这一轮 write/edit 过的文件挂在该轮正文之后。 */
    const produced = collectProducedFromEvents(events).filter(p => p.turn != null);
    const byTurn = new Map();
    produced.forEach(p => {
      if (!byTurn.has(p.turn)) byTurn.set(p.turn, []);
      // kind 直接给宿主的工具名（write / edit），via 只用于区分是不是 Code Mode 的子调用
      const kind = (p.tool === 'write' ? '写入' : (p.tool === 'edit' ? '编辑' : String(p.tool || '编辑')))
        + (p.via === '代码沙箱子调用' ? ' · 子调用' : '');
      // path 一定要带上：文件行现在是"点名字即打开"的链接，没有绝对路径就点不动
      byTurn.get(p.turn).push({ path: p.path, name: p.path.split(/[\\/]/).pop() || p.path, kind, added: 0, removed: 0 });
    });
    byTurn.forEach((list, t) => {
      const msgs = [...log.querySelectorAll('.msg[data-turn="' + Number(t) + '"]')];
      if (!msgs.length) return;
      const w = document.createElement('div');
      w.className = 'rail crow-slot crow-produced-slot';
      w.dataset.turn = String(Number(t));
      w.innerHTML = ChatRow.produced(list);
      const last = msgs[msgs.length - 1];
      const wrap = last.querySelector('.msg-wrap') || last;
      wrap.appendChild(w);
    });
    // 轮末页脚（对齐原生：操作页脚属于已完成轮次）。每个有消息的轮只摆一条，贴在该轮最后一条消息下。
    [...new Set(shownRows.map(x => {
      const e = x.event;
      const t = e.type === 'user/message' ? turnOfSeq(x.seq) : Number(e.data && e.data.turn);
      return Number.isFinite(Number(t)) ? Number(t) : null;
    }).filter(t => t != null))].forEach(t => Chat.placeTurnFoot(t));
    // 载入统计写在工具条左侧的小字里（会话 ID 已不再重复显示；现在是全量，只报数量）
    const meta = document.getElementById('chatload');
    if (meta) meta.innerHTML = '已载入 <b>' + shownRows.length + '</b> 行 / 共 ' + events.length + ' 个事件（全量）';
    // 刚回放完一整条会话 → 恢复"跟随到底部"，清掉上一条会话（或上次点轮次）留下的 _follow=false
    Chat._follow = true;
    log.scrollTop = log.scrollHeight;
  } catch (e) { log.innerHTML = '<div class="alert err">读取失败：' + fmt.esc(e.message) + '</div>'; }
}

/* ---------- 系统状态刷新 ---------- */
async function refreshSystem(redraw) {
  // TTL 4s：系统状态页来回切不整套重打（概要/会话/子代理/空间四路 RPC）
  if (!redraw && State.host && loaderFresh('host', 4000)) return false;
  try {
    const [h, s, sa, w] = await Promise.all([
      API.host(),                                        // 概要本地拼装（见 API.host）
      API.call('session.list', {}),
      API.call('subagent.list', { parentSessionId: State.sessionId }).catch(() => null),
      API.workspaces().catch(() => null),                // workspace/follow 基线
    ]);
    State.host = h; State.sessions = s.items || []; stampLoader('host');
    if (sa) State.subagents = sa;
    if (w) State.workspaces = w;
    await refreshGoal();
  } catch (e) { /* 静默 */ }
  if (redraw) render();
  return true;
}

/* ---------- 模型目录 / 候选供应商（大模型页） ---------- */
/** 模型目录（session/modelCatalog）：全局资产 + 当前会话路由。
 *  TTL 5s 且绑会话 —— 之前它只在 boot 时取一次，于是"发现模型"面板没有目录数据可对照，
 *  而且切换会话后页面里的「当前会话路由」也不会跟着变。 */
async function loadModelCatalog(redraw) {
  if (!redraw && State.models && loaderFresh('models', 5000)) return false;
  try {
    State.models = await API.call('session.models', { sessionId: State.sessionId });
    stampLoader('models');
    if (redraw) render();
    return true;
  } catch (e) { return false; }
}
/** 候选供应商清单（llm/listConfigurableProviders）：全局资产。
 *  TTL 30s —— 这是部署级清单，本机基本不变，没必要每次切页重打。
 *  ⚠️ 返回的是"DSH 支持的全部候选通道"（本机 40 个），不是"已经接好的"；
 *  真正进了模型目录的看 modelCatalog.routableProviders。 */
async function loadProviders(redraw) {
  if (!redraw && (State.providers || []).length && loaderFresh('providers', 30000)) return false;
  try {
    const lp = await API.call('llm.providers', {});
    State.providers = lp.providers || [];
    stampLoader('providers');
    if (redraw) render();
    return true;
  } catch (e) { return false; }
}

/** 设置命名空间里**静态声明**的模型数。
 *  llm-deepseek 这类通道没有"模型发现"能力，它的模型清单是部署写在设置里的（`value.models`）；
 *  llm-pi-ai 是转发型，模型挂在 `value.providers[].models` 下。两者都要能数出来，
 *  否则用户会以为"探测不了 = 这个供应商用不了"（其实是模型清单静态提供）。 */
function nsStaticModelCount(ns) {
  const n = (State.settings?.namespaces || []).find(x => x.ns === ns);
  if (!n) return null;
  const v = n.value || {};
  if (Array.isArray(v.models)) return v.models.length;
  if (v.providers && typeof v.providers === 'object') {
    let c = 0;
    for (const p of Object.values(v.providers)) if (p && Array.isArray(p.models)) c += p.models.length;
    return c;
  }
  return null;
}

/* ---------- 模型发现（llm/discoverModels） ----------
 * 实测契约（2026-09-20，逐条打原生端点确认）：
 *   args 必须**同时**给 settingsNs 与 request.provider。
 *   只给 settingsNs → llm/model-discovery-rejected "needs a provider route or a baseURL"
 *   —— 这就是此前"无论选哪个供应商都报同一句错"的根因：请求少了 provider 参数。
 * 本机 40 个候选供应商里 **39 个能直接返回静态模型目录**（openrouter 366 个、vercel 237 个、
 * amazon-bedrock 121 个…）；只有 llm-deepseek（DeepSeek 官方直连）报
 * "no model discovery is registered"，即该接入通道没有注册发现能力。
 * request.baseURL 存在时会改用实时 HTTP 拉取（未配 Key → "…answered 401; check the API key"）。
 * 结果统一写进 State.disc，由 provSectionHtml() 画进「供应商接入」表：不弹窗，
 * 结果就落在被探测的那一行下面，方便对着清单逐个比对各供应商。 */

/** 发现结果容器：{ running, done, total, open:{}, shown:{}, results:{ [provider]:{ok,ns,models,error,at} } }
 *  shown[provider] = 当前展开显示多少个模型（分页展开，避免一次塞 990 张卡把页面拖死）。
 *  ⚠️ 结果 key 用 provider + 命名空间：本机存在两个供应商共用同一个 settingsNs 的情况，
 *  只用 provider 做 key 在"只看型号不看通道"时容易误判。 */
function discReset() {
  State.disc = { running: false, done: 0, total: 0, open: {}, shown: {}, results: {} };
}
/** 模型清单的每页张数（「查看清单」分页展开用）。 */
const DISC_PAGE = 24;
/** 失败原因翻人话——不同 reject 原因对应不同处置动作，不能再合并成同一句。
 *  ⚠️ 实测（2026-09-21 逐条打全部 40 个候选）：只有 `llm-deepseek` 会回
 *     `no model discovery is registered for "llm-deepseek"`，其余 39 个都能发现出模型。
 *     而且 llm-deepseek 恰好是**唯一进了模型目录、也是当前会话在用的**那条通道 ——
 *     它的模型清单本来就由部署写在设置里（静态），不需要"发现"。
 *     所以这条**不是故障**，文案不能说成"通道不支持"（那听着像坏了）。 */
function discErrText(msg) {
  const m = /answered (\d{3}); check the API key/i.exec(msg || '');
  if (/no model discovery is registered/i.test(msg || ''))
    return '该通道不提供动态模型发现：模型清单由部署在设置里静态声明（检查上面那列「设置命名空间」），属正常情况，不是故障。';
  if (m) return '供应商返回 HTTP ' + m[1] + '：先在「凭据」页配好该供应商的 API Key 再试。';
  if (/needs a provider route or a baseURL/i.test(msg || ''))
    return '该供应商 id 未被 DSH 识别（缺 route / baseURL），无法发现。';
  return msg;
}
/** 失败原因归类标签：一眼看出"该不该去配 Key"。
 *  「静态清单」= 该通道没有注册发现能力但清单由部署提供（正常）；「需要 Key」= 真的缺凭据。 */
function discErrKind(msg) {
  if (/no model discovery is registered/i.test(msg || '')) return '静态清单';
  if (/answered \d{3}/i.test(msg || '')) return '需要 Key';
  if (/needs a provider route or a baseURL/i.test(msg || '')) return 'id 未识别';
  return '其他';
}
/** 这条结果是不是"没有发现能力、只有静态清单"（正常情况，不该画成红色失败） */
function discIsStatic(r) { return !!r && !r.ok && /no model discovery is registered/i.test(r.error || ''); }
/** 探测单个供应商，结果写进 State.disc（不重绘，由调用方统一重绘）。 */
async function discProbe(p) {
  try {
    const v = await API.call('llm.discoverModels', { settingsNs: p.settingsNs, provider: p.provider });
    const models = Array.isArray(v) ? v : ((v && v.models) || []);
    State.disc.results[p.provider] = { ok: true, ns: p.settingsNs, models, at: Date.now() };
    return true;
  } catch (e) {
    State.disc.results[p.provider] = { ok: false, ns: p.settingsNs, error: e.message, at: Date.now() };
    return false;
  }
}
/** 探测收尾：只重绘「供应商接入」那一张卡（paintDisc）——结果就在表内同一行下面，
 *  徽标也在同一行，一次局部重绘全都刷新。
 *  不做整页 render：整页 innerHTML 替换会把滚动位置弹回页顶，用户刚点的行就找不到了。
 *  滚动的唯一理由：卡不在视野内时把它带进来，否则看起来像"点了没反应"。 */
function discFinish() {
  paintDisc();
  const el = document.getElementById('provcard');
  if (!el || typeof el.getBoundingClientRect !== 'function' || typeof el.scrollIntoView !== 'function') return;
  const box = el.getBoundingClientRect();
  const vh = (typeof window !== 'undefined' && window.innerHeight) || 800;
  if (box.top < 0 || box.top > vh - 80) el.scrollIntoView({ block: 'start' });
}
/** 「发现模型」：传 provider 探测单个；不传（或传空）等价于探测全部候选供应商。 */
async function discoverModels(provider) {
  if (!provider) return discoverAll();
  const p = (State.providers || []).find(x => x.provider === provider);
  if (!p) { UI.warn('未知供应商：' + provider); return; }
  if (!State.disc) discReset();
  State.disc.running = true; State.disc.total = 1; State.disc.done = 0;
  paintDisc();
  await discProbe(p);
  State.disc.done = 1; State.disc.running = false;
  discFinish();
}
/** 依次探测全部候选供应商（串行，避免一次并发几十条请求把宿主打满）。只读，不改任何配置。
 *  实测本机 40 个候选全跑一遍约 1~2s：39 个能动态发现（共上千个模型），
 *  1 个（llm-deepseek，恰是当前会话在用的那条）没有注册发现能力 —— 它的清单由设置静态提供，
 *  属正常情况，所以汇总里单独计作「只有静态清单」而不是失败。 */
async function discoverAll() {
  const ps = State.providers || [];
  if (!ps.length) { UI.warn('供应商清单还没加载出来，稍后再试'); return; }
  const ok = await UI.confirm({ title: '发现模型', okText: '开始探测',
    message: '将依次探测全部 ' + ps.length + ' 个候选供应商的模型目录。\n'
      + '只读取清单，不会改动任何配置；发现的模型也不会自动写进可用模型目录。\n'
      + '有的通道没有注册"模型发现"能力（清单由部署静态提供）——那是正常情况，不算失败。' });
  if (!ok) return;
  discReset();
  State.disc.running = true; State.disc.total = ps.length;
  paintDisc();
  for (const p of ps) {
    await discProbe(p);
    State.disc.done++;
    if (State.disc.done % 4 === 0 || State.disc.done === ps.length) paintDisc();
  }
  State.disc.running = false;
  discFinish();
  const rs = Object.values(State.disc.results);
  const good = rs.filter(r => r.ok).length;
  const stat = rs.filter(discIsStatic).length;
  const bad = rs.length - good - stat;
  const models = rs.reduce((n, r) => n + ((r.models || []).length), 0);
  UI.ok('探测完成：' + good + ' 个可动态发现（共 ' + models + ' 个模型）'
    + (stat ? ' · ' + stat + ' 个只有静态清单（正常）' : '')
    + (bad ? ' · ' + bad + ' 个失败（见红行）' : ''));
}
/** 展开 / 收起某个供应商的模型清单（清单就画在它自己那一行下面）。
 *  只重绘「供应商接入」卡，不整页重绘 —— 整页 innerHTML 替换会把滚动位置弹回页顶，
 *  用户点完"查看清单"得重新滚回去找那一行。按钮文案也由同一次重绘更新，不用另改 DOM。 */
function toggleDiscList(provider) {
  if (!State.disc) return;
  State.disc.open = State.disc.open || {};
  State.disc.open[provider] = !State.disc.open[provider];
  if (!State.disc.shown) State.disc.shown = {};
  if (State.disc.open[provider] && !State.disc.shown[provider]) State.disc.shown[provider] = DISC_PAGE;
  paintDisc();
}
/** 清单再展开一批（分页，避免一次渲染上千张卡；打开 openrouter 全量能到 990 张 / 386KB）。 */
function moreDisc(provider) {
  if (!State.disc) return;
  State.disc.shown = State.disc.shown || {};
  State.disc.shown[provider] = (State.disc.shown[provider] || DISC_PAGE) + DISC_PAGE;
  paintDisc();
}
/** 清空发现结果（结果与表内徽标在同一张卡里，重绘一次即可） */
function clearDisc() {
  discReset();
  paintDisc();
}
/** 把「供应商接入」卡重画一遍（探测进度/结果/徽标都在这一张卡内，一次局部重绘全刷新）。
 *  不整页 render：整页 innerHTML 替换会把滚动位置弹回页顶。 */
function paintDisc() {
  const el = document.getElementById('provcard');
  if (el) el.innerHTML = provSectionHtml();
}
/** 模型卡片（发现结果 / 目录共用一个渲染，避免两处显示不一致） */
function modelCardHtml(m, extra) {
  const num = n => (n == null ? '—' : Number(n).toLocaleString('en-US'));
  return `<div class="card" style="padding:10px 12px">
    <div class="mono" style="font-size:12px;font-weight:600;overflow-wrap:anywhere">${fmt.esc(m.id || '—')}</div>
    ${m.name && m.name !== m.id ? `<div class="muted" style="font-size:11px">${fmt.esc(m.name)}</div>` : ''}
    <div class="muted" style="font-size:10.5px">上下文 ${num(m.contextWindow)} · 输出上限 ${num(m.maxTokens)}</div>
    ${extra || ''}
  </div>`;
}
/** 「🔧 供应商接入」整区（含模型发现）。这是模型发现的**唯一入口**。
 *
 *  为什么做成一个函数：页面骨架与探测过程中的局部重绘（paintDisc）必须共用同一份 HTML。
 *  旧版把发现结果放在页面顶部的独立面板里，而「探测」按钮在页面底部的供应商表里，两边各画一遍
 *  又互相牵着重绘（还额外在「可用模型」卡头放了个第三个入口），结果就是"点一下到处在变"、
 *  同一个供应商的模型数在三处重复出现。现在：一个入口（本卡）+ 一处结果（各自供应商行内展开）。
 *
 *  ⚠️ 结果内联在行下，所以这里不做"可发现性排序"——表格顺序必须稳定，
 *     否则点一次探测整张表会重排，用户刚定位的那一行就跑掉了。 */
function provSectionHtml() {
  const ps = State.providers || [];
  const inCat = new Set((State.models?.groups || []).map(g => g.id));
  const routable = new Set(State.models?.routableProviders || []);
  const byKind = {};
  ps.forEach(p => { const k = providerKind(p.provider); (byKind[k] = byKind[k] || []).push(p); });
  const d = State.disc;
  const results = (d && d.results) || {};
  const rows = Object.values(results);
  const staticN2 = rows.filter(discIsStatic).length;       // 只有静态清单（正常，不算失败）
  const okN = rows.filter(r => r.ok).length;
  const badN = rows.filter(r => !r.ok && !discIsStatic(r)).length;   // 真失败：缺 Key / id 未识别 / 其他
  const totalModels = rows.reduce((n, r) => n + ((r.models || []).length), 0);
  const running = !!(d && d.running);
  const shown = (d && d.shown) || {};
  const openMap = (d && d.open) || {};
  const summary = running ? '探测中 ' + d.done + ' / ' + d.total
    : okN + ' 个可动态发现 · ' + staticN2 + ' 个只有静态清单'
      + (badN ? ' · ' + badN + ' 个失败' : '') + ' · 共 ' + totalModels + ' 个模型';
  return `
    <h3>🔧 供应商接入 <span class="tag gray">🌐 全局</span>
      <span class="tag ${inCat.size ? 'ok' : 'warn'}" style="margin-left:8px">已进模型目录 ${inCat.size}</span>
      <span class="tag gray">候选 ${ps.length}</span>
      ${(rows.length || running) ? '<span class="tag ' + (running ? 'warn' : (badN === 0 ? 'ok' : 'gray')) + '">' + summary + '</span>' : ''}
      <span style="margin-left:auto"></span>
      <button class="btn sm" onclick="discoverAll()"${running ? ' disabled' : ''} title="依次探测全部候选供应商能提供哪些模型。只读取清单，不改动任何配置">🔍 全部探测</button>
      ${(rows.length && !running) ? '<button class="btn sm" onclick="clearDisc()">清空结果</button>' : ''}
    </h3>
    <div class="muted mb" style="font-size:11.5px">
      这个端点返回的是 DSH 支持的<b>全部候选接入通道</b>（本机 ${ps.length} 个），不是"已经接好的"。
      只有真正进了模型目录的才会参与路由——本机当前是 <b>${inCat.size}</b> 个。想启用其他候选：先在
      <a href="#/credentials">凭据</a> 页配 Key，再到 <a href="#/settings">设置</a> 页写进对应的 <code>llm-*</code> 命名空间。
      <br><b>模型发现也在这里做</b>：点某行的「探测」拉一次该通道的真实模型清单（只读），结果显示在<b>同一行下面</b>。
      结果只用于查看，要真正启用还得写进设置。
      <br>标注「<b>静态清单</b>」的通道<b>不是坏了</b>：它没有注册动态发现能力，模型清单本来就由部署写在设置里
      （灰色标签不算失败）。本机 40 个候选里只有 <code>llm-deepseek</code> 属于这种情况，
      而它恰好是当前会话在用的那条通道 —— 这点也说明"能不能发现"和"能不能用"是两件事。
    </div>
    ${Object.entries(byKind).map(([kind, list]) => `
      <div style="margin-bottom:14px">
        <div class="muted mb" style="font-weight:600">${fmt.esc(kind)} · ${list.length} 个</div>
        <table>
          <thead><tr><th>供应商</th><th>显示名</th><th>设置命名空间</th><th>状态</th><th>模型发现</th></tr></thead>
          <tbody>${list.map(p => {
            const r = results[p.provider];
            const staticN = nsStaticModelCount(p.settingsNs);
            const open = !!openMap[p.provider];
            const all = (r && r.models) || [];
            const limit = shown[p.provider] || DISC_PAGE;
            return `<tr>
            <td class="mono">${fmt.esc(p.provider)}</td>
            <td>${fmt.esc(p.displayName)}</td>
            <td class="mono muted" style="font-size:11.5px">${fmt.esc(p.settingsNs)} ${(p.settingsPath||[]).length ? ' / ' + fmt.esc(p.settingsPath.join('.')) : ''}
              ${staticN == null ? '' : '<br><span style="font-size:10.5px">静态清单 ' + staticN + ' 个模型</span>'}</td>
            <td>${inCat.has(p.provider)
              ? '<span class="tag ok">✅ 在模型目录</span>'
              : (routable.has(p.provider) ? '<span class="tag ok">可路由</span>' : '<span class="tag gray">候选 · 未接入</span>')}</td>
            <td style="white-space:nowrap"><button class="btn sm" onclick="discoverModels('${fmt.esc(p.provider)}')" title="只探测这一个供应商能提供哪些模型（只读，不改任何配置）">探测</button>
              ${r ? (r.ok
                ? '<span class="tag ok" style="font-size:10px;margin-left:4px">可发现 ' + all.length + '</span>'
                  + (all.length ? `<button class="btn sm" style="margin-left:4px" onclick="toggleDiscList('${fmt.esc(p.provider)}')">${open ? '收起清单' : '查看清单'}</button>` : '')
                : (discIsStatic(r)
                  /* 没有发现能力但清单由设置提供 —— 用灰色"静态清单"而不是红色失败，
                     并把用户真正需要的动作（去看设置里那份清单）放在顺手的位置 */
                  ? '<span class="tag gray" style="font-size:10px;margin-left:4px">静态清单</span>'
                    + '<span class="muted" style="font-size:10.5px;margin-left:4px">' + fmt.esc(discErrText(r.error)) + '</span>'
                    + (staticN != null ? '<a class="btn sm" style="margin-left:4px" href="#/settings">看设置里的清单（' + staticN + ' 个）</a>'
                                       : '<a class="btn sm" style="margin-left:4px" href="#/settings">看设置</a>')
                  : '<span class="tag err" style="font-size:10px;margin-left:4px">' + discErrKind(r.error) + '</span>'
                    + '<span class="muted" style="font-size:10.5px;margin-left:4px">' + fmt.esc(discErrText(r.error)) + '</span>'
                    + (staticN == null ? '<a class="btn sm" style="margin-left:4px" href="#/credentials">去配 Key</a>' : '<a class="btn sm" style="margin-left:4px" href="#/settings">看静态清单</a>'))) : ''}</td>
          </tr>
          ${(r && r.ok && open) ? `<tr class="disc-detail"><td colspan="5" style="background:var(--inset)">
            <div class="muted mb" style="font-size:11.5px">${fmt.esc(p.provider)} 可发现的模型（显示 ${Math.min(limit, all.length)} / ${all.length}）·
              只用于查看，要启用请写进 <a href="#/settings">设置</a> 的 <code>${fmt.esc(r.ns || p.settingsNs)}</code></div>
            <div class="row c3">${all.slice(0, limit).map(x => modelCardHtml(x)).join('')}</div>
            ${all.length > limit ? `<div class="mt"><button class="btn sm" onclick="moreDisc('${fmt.esc(p.provider)}')">再显示 ${DISC_PAGE} 个</button></div>` : ''}
          </td></tr>` : ''}`;
          }).join('')}</tbody>
        </table>
      </div>`).join('') || '<div class="empty">未读取到供应商。<div class="mt"><button class="btn sm" onclick="loadProviders(true)">重新读取</button></div></div>'}
  `;
}

/* ---------- 智能体预设 ---------- */
/** 智能体预设清单（全局资产）。TTL 10s：切页不重打；复制/删除后调 loadPresets(true) 强制刷新。 */
async function loadPresets(force) {
  if (!force && (State.presets || []).length && loaderFresh('presets', 10000)) return false;
  try {
    const pr = await API.call('agentPreset.list', {});
    State.presets = pr.presets || [];
    State.presetsAuthorable = pr.authorable === true;   // 部署是否允许自定义智能体预设（决定"复制"是否有意义）
    stampLoader('presets');
    if (force) render();
    return true;
  } catch (e) { return false; }
}
/** 智能体预设是否可写：实测只有 trust==='user' 的智能体预设能在编辑器里打开；
 *  trust==='system' 的会报 agent-preset/read-only（"ships with the deployment"）。 */
function presetWritable(p) { return p?.trust === 'user'; }
async function readPreset(id) {
  const box = document.getElementById('presetpanel');
  box.innerHTML = '<div class="card mt"><div class="empty"><span class="loading"></span> 读取配置…</div></div>';
  try {
    const v = await API.call('agentPreset.read', { sessionId: State.sessionId, agentPreset: id });
    box.innerHTML = '<div class="card mt"><h3>📄 ' + fmt.esc(id) + ' 的组成配置'
      + ' <span class="tag gray">' + fmt.esc(v.trust || '') + '</span>'
      + ' <button class="btn sm" style="margin-left:auto" onclick="document.getElementById(\'presetpanel\').innerHTML=\'\'">收起</button></h3>'
      + '<pre class="mono" style="font-size:11px;overflow:auto;max-height:420px;background:#0b1428;padding:12px;border-radius:8px">'
      + fmt.esc(v.content || '') + '</pre></div>';
  } catch (e) { box.innerHTML = '<div class="alert err mt">读取失败：' + fmt.esc(e.message) + '</div>'; }
}
/** 在宿主编辑器里打开智能体预设目录。
 *  ⚠️ 实测（2026-09-20）：系统智能体预设（trust=system）调它必报 agent-preset/read-only
 *  （"ships with the deployment"）——所以先按 trust 拦住并给出可执行路径（复制成用户智能体预设），
 *  而不是让用户看到一句英文报错。 */
async function openPresetDoc(id) {
  const p = (State.presets || []).find(x => x.id === id);
  if (p && !presetWritable(p)) {
    const go = await UI.confirm({
      title: '系统智能体预设只读',
      message: '「' + (p.name || id) + '」随部署发布，不能改名/删除/在编辑器中打开。\n要先复制成用户智能体预设再编辑副本吗？',
      okText: '复制并编辑',
    });
    if (go) await copyPreset(id, true);
    return;
  }
  try {
    await API.call('agentPreset.openDocument', { agentPreset: id });
    UI.ok('已请求在编辑器中打开 ' + id);
  } catch (e) {
    UI.err(/read-only|cannot be written|ships with the deployment/i.test(e.message)
      ? '该智能体预设只读（随部署发布），无法打开编辑；请先「复制」成用户智能体预设再编辑副本'
      : '打开失败：' + e.message);
  }
}
/** 复制智能体预设 → 成功后可选"立刻在编辑器中打开副本"（openAfter=true 时由只读提示直接串起这条链路）。
 *  新 ID 与显示名称在**同一个弹框**里一次填完：以前是两个串行的 prompt，
 *  用户点完"下一步"才知道还要填名称、也回不去改 ID。显示名称留空则自动跟随 ID。 */
async function copyPreset(from, openAfter) {
  const src = (State.presets || []).find(p => p.id === from) || {};
  const suggestId = /^[a-z0-9]+(-[a-z0-9]+)*$/.test(from + '-copy') ? from + '-copy' : 'my-preset';
  const r = await UI.form({
    title: '复制智能体预设',
    okText: '复制',
    hint: '源：<b>' + fmt.esc(src.name || from) + '</b> <code>' + fmt.esc(from) + '</code>'
      + '（' + (presetWritable(src) ? '用户智能体预设' : '系统智能体预设 · 只读') + '）'
      + '。副本一律是<b>用户智能体预设</b>，可改名、可删除、可在编辑器里打开。',
    fields: [
      { key: 'id', label: '新 ID', value: suggestId, placeholder: 'my-standard',
        hint: '（kebab-case：小写字母、数字、短横线）',
        validate: (v) => {
          if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(String(v || ''))) return '必须是 kebab-case（小写字母/数字/短横线，如 my-standard）';
          if ((State.presets || []).some(p => p.id === v)) return '已存在同名智能体预设「{v}」，换一个 ID';
          if (v === from) return '不能与原智能体预设同 ID';
          return null;
        } },
      { key: 'name', label: '显示名称', placeholder: '留空 = 跟随新 ID', value: '',
        hint: '（可留空）' },
    ],
  });
  if (!r) return;
  const id = r.id;
  const name = String(r.name || '').trim() || id;
  try {
    await API.call('agentPreset.copy', { from, id, name });
    UI.ok('已复制为 ' + id + '（用户智能体预设，可编辑）');
    await loadPresets(true);                        // 新副本立刻出现在列表里
    const open = openAfter || await UI.confirm({ title: '编辑副本', message: '现在在编辑器中打开 ' + id + ' ？', okText: '打开' });
    if (open) {
      try { await API.call('agentPreset.openDocument', { agentPreset: id }); UI.ok('已请求在编辑器中打开 ' + id); }
      catch (e) { UI.err('打开失败：' + e.message); }
    }
  } catch (e) { UI.err('复制失败：' + e.message); }
}
/* 会话级切换智能体预设的唯一入口是聊天页右侧栏「🧭 智能体预设」（chatSwitchPreset），
   本页只管智能体预设清单本身：查看 / 复制 / 编辑 / 删除。 */
async function removePreset(id) {
  const ok = await UI.confirm({ title: '删除智能体预设', message: '删除用户智能体预设 ' + id + '？不可撤销。', okText: '删除', danger: true });
  if (!ok) return;
  try { await API.call('agentPreset.remove', { id }); UI.ok('已删除'); await loadPresets(true); }
  catch (e) { UI.err('删除失败：' + e.message); }
}

/* ---------- MCP 工具清单 ---------- */
function toggleToolList(serverName) {
  const box = document.getElementById('toollist-' + serverName);
  if (!box) return;
  if (box.innerHTML) { box.innerHTML = ''; return; }
  const s = (State.mcp || []).find(x => x.serverName === serverName);
  const names = s?.toolNames || [];
  if (!names.length) { box.innerHTML = '<div class="muted mt">无工具清单（需成功握手一次）</div>'; return; }
  box.innerHTML = '<div class="mt" style="border-top:1px solid var(--line);padding-top:10px">'
    + '<div class="muted mb" style="font-size:11.5px">共 ' + names.length + ' 个工具（MCP 握手获得）</div>'
    + '<div style="display:flex;flex-wrap:wrap;gap:5px;max-height:220px;overflow:auto">'
    + names.map(n => '<span class="tag gray mono" style="font-size:10.5px">mcp__' + fmt.esc(serverName) + '__' + fmt.esc(n) + '</span>').join('')
    + '</div></div>';
}

/* ---------- 添加附件（对齐原生 file.attach「添加附件」）----------
   原生的附件入口只有一个「添加附件」（回形针），图片与文件都从它进来：
   attachment.dropTitle = 「文件或图片拖动到此处即可添加」。
   但两者的**通道**在原生里也是分开的，所以这里按钮合一、落点不合并：
     · 图片 → 浏览器 FileReader 读成 data-URL，base64 内联进消息（模型直接看得到）
     · 其它文件 → 先上传换取 receiptId，随消息以 {type:'file',receiptId} 发送
   分流按 MIME（image/*）。同一个 <input> 需在失败后清空 value，否则再选同一个文件不触发 change。 */
function pickAttach(ev) {
  const input = ev && ev.target;
  const file = input && input.files && input.files[0];
  if (!file) return;
  const isImage = /^image\//.test(String(file.type || ''));
  if (!(isImage ? takeImage(file) : takeAnyFile(file)) && input) input.value = '';
}
/** 图片落点：上限与允许的 MIME 由宿主投影 imageLimits 决定（不写死） */
function takeImage(file) {
  const lim = currentSession().projections?.values?.imageLimits || {};
  const maxBytes = lim.maxImageBytes || 20971520;
  const types = lim.mediaTypes || ['image/png','image/jpeg','image/webp','image/gif'];
  if (file.size > maxBytes) { UI.warn('图片过大：' + (file.size/1048576).toFixed(1) + ' MB，上限 ' + (maxBytes/1048576).toFixed(1) + ' MB'); return false; }
  if (!types.includes(file.type)) { UI.warn('不支持的图片格式：' + file.type + '（仅支持 ' + types.join(' / ') + '）'); return false; }
  const reader = new FileReader();
  reader.onload = () => {
    State.pendingImage = { mediaType: file.type, data: String(reader.result).split(',')[1], name: file.name, size: file.size };
    renderAttachPreview();
  };
  reader.readAsDataURL(file);
  return true;
}
function clearImage() {
  State.pendingImage = null;
  const f = document.getElementById('chatfile'); if (f) f.value = '';
  renderAttachPreview();
}

/** 文件落点：先上传换取 receiptId，再以 {type:'file',receiptId} 随消息发送 */
const ATTACH_MAX_BYTES = 8 * 1024 * 1024;      // 控制台自己设的上限：要经本机后端 JSON 转发
function takeAnyFile(file) {
  if (file.size > ATTACH_MAX_BYTES) {
    UI.warn('文件过大：' + (file.size / 1048576).toFixed(1) + ' MB，上限 ' + (ATTACH_MAX_BYTES / 1048576) + ' MB');
    return false;
  }
  const reader = new FileReader();
  reader.onload = () => {
    State.pendingFile = { name: file.name, bytes: file.size, data: String(reader.result).split(',')[1] };
    renderAttachPreview();
  };
  reader.readAsDataURL(file);
  return true;
}
function clearFile() {
  State.pendingFile = null;
  const f = document.getElementById('chatfile'); if (f) f.value = '';
  renderAttachPreview();
}
/** 附件预览条：图片与文件共用一个位置 */
function renderAttachPreview() {
  const box = document.getElementById('attachpreview');
  if (!box) return;
  const img = State.pendingImage, f = State.pendingFile;
  box.innerHTML =
    (img ? '<span class="tag ok">📎 ' + fmt.esc(img.name) + ' · ' + (img.size / 1024).toFixed(0) + ' KB</span> '
         + '<button class="btn sm" onclick="clearImage()">移除</button> ' : '')
    + (f ? '<span class="tag ok">📁 ' + fmt.esc(f.name) + ' · ' + fmt.bytes(f.bytes) + '</span> '
         + '<span class="muted" style="font-size:11px">发送时上传，换成 receiptId</span> '
         + '<button class="btn sm" onclick="clearFile()">移除</button>' : '');
}

/* ---------- 插件树 / MCP 的强制重新探测 ---------- */
/** 重新执行 dsh --dump-config（?refresh=1 绕过服务端内存缓存）；成功后服务端会自动回写 plugins.json */
async function reloadPlugins() {
  UI.info('正在重新执行 dsh --dump-config…');
  try {
    const d = await (await fetch('/api/local/plugins?refresh=1')).json();
    State.plugins = d;
    render();
    if (d.source === 'dump-config') UI.ok('实时探测成功（' + (d.via || '') + '），已回写 plugins.json');
    else UI.warn('实时探测失败，仍用快照：' + String(d.error || '').slice(0, 80));
  } catch (e) { UI.err('重新探测失败：' + e.message); }
}
/** 重新做 TCP 探测 + MCP 握手；成功后服务端会自动回写 mcp-tools.json */
async function reloadMcp() {
  UI.info('正在重新探测 MCP 服务…');
  try {
    const m = await (await fetch('/api/local/mcp')).json();
    State.mcp = (m.servers || []).map(mcpView);
    State.mcpRaw = m;
    render();
    const g = (m.servers || []).find(s => /geoscenepro/i.test(s.serverName)) || {};
    if (g.toolsSource === 'mcp-tools/list') UI.ok('握手成功，工具 ' + g.tools + ' 个，已回写 mcp-tools.json');
    else UI.warn('握手未成功：' + (g.toolsSource || '未知'));
  } catch (e) { UI.err('重新握手失败：' + e.message); }
}

/* ---------- 动态插件 ----------
   运行进程里的临时插件（Cordis 动态插件）清单。
   这里只读；装载/卸载要走审批，不在控制台里做。*/
async function loadDynamicPlugins(redraw) {
  const box = document.getElementById('dynplugins');
  if (!box) return;
  try {
    const rows = await API.post('dynamicCordisRunner/inventory', {});
    const list = Array.isArray(rows) ? rows : [];
    box.innerHTML = '<h3>🧩 动态插件</h3>'
      + '<div class="muted mb" style="font-size:11.5px">当前装在运行进程里的临时插件。'
      + '<b>装载/卸载需要审批</b>，本页只读。</div>'
      + (list.length
        ? '<div style="max-height:320px;overflow:auto"><table><thead><tr><th>插件</th><th>归属会话</th><th>包数</th><th>当前包</th><th>活动运行</th></tr></thead><tbody>'
          + list.map(r => '<tr>'
            + '<td class="mono" style="font-size:11px">' + fmt.esc(String(r.pluginId || '—')) + '</td>'
            + '<td class="mono" style="font-size:11px">' + fmt.esc(String(r.agentId || '—').slice(0, 22)) + '…</td>'
            + '<td>' + ((r.packages || []).length) + '</td>'
            + '<td class="mono" style="font-size:11px">' + fmt.esc(String(r.currentPackageId || '—').slice(0, 22)) + '</td>'
            + '<td>' + (r.activeRun
              ? '<span class="tag ok">运行中</span> <span class="muted mono" style="font-size:10.5px">' + fmt.esc(String(r.activeRun.packageId || '').slice(0, 18)) + '</span>'
              : '<span class="tag gray">未运行</span>') + '</td>'
            + '</tr>').join('') + '</tbody></table></div>'
        : '<div class="empty">当前没有动态插件<br><span class="muted">这是运行时状态，不是故障 —— 装一个就会出现在这里</span></div>');
  } catch (e) {
    box.innerHTML = '<h3>🧩 动态插件</h3><div class="alert err">dynamicCordisRunner/inventory 调用失败：' + fmt.esc(e.message) + '</div>';
  }
  if (redraw) render();
}

/* ---------- 契约自检（系统状态页）---------
   把 tools/test-api.mjs 的关键几项搬到页面上：点一下就知道哪一层变了。
   全部是只读调用，不产生副作用。*/
async function runContractCheck() {
  // 重跑时把"用户关掉了结果卡"这件事一并复位 —— 主动点自检当然是要看结果
  State.contract = { at: Date.now(), running: true, rows: [], hidden: false };
  render();
  const rows = [];
  const step = async (name, fn, want) => {
    const t0 = Date.now();
    try {
      const v = await fn();
      rows.push({ name, ok: true, ms: Date.now() - t0, detail: want ? want(v) : '' });
    } catch (e) {
      rows.push({ name, ok: false, ms: Date.now() - t0, detail: String(e.message || e).slice(0, 160) });
    }
    State.contract = { at: Date.now(), running: true, rows: [...rows], hidden: false };
    render();
  };
  await step('控制台 → DSH 认证', async () => {
    const st = await (await fetch('/api/local/dsh', { cache: 'no-store' })).json();
    if (st.state !== 'ok') throw new Error(st.error || st.detail || st.state);
    return st;
  }, st => st.origin + ' · 令牌 ' + (st.tokenHint || '—') + ' · ' + (st.dshVersion || '—') + (st.dshRev ? ' · rev ' + st.dshRev : ''));
  await step('session/list（会话列表）', () => API.call('session.list'), v => v.items.length + ' 个会话');
  await step('session/modelCatalog（模型目录）', () => API.call('session.models'), v => (v.current?.model || '—') + ' · ' + (v.groups || []).length + ' 组');
  await step('settings/describe（设置 schema）', () => API.call('settings.describe'), v => v.namespaces.length + ' 个命名空间');
  await step('skills/list（技能目录）', () => API.call('skill.list', { sessionId: State.sessionId }), v => (v.skills || []).length + ' 个技能');
  await step('commands/list（斜杠命令）', () => API.call('commands/list', { args: { agentId: State.sessionId } }), v => (v || []).length + ' 条：' + (v || []).map(c => '/' + c.name).join(' '));
  await step('fileReferences/list（@ 引用）', () => API.call('fileReferences/list', { args: { agentId: State.sessionId, query: '' } }), v => (v || []).length + ' 个候选');
  await step('pluginInventory/list（插件运行时）', () => API.call('pluginInventory/list', { args: {} }), v => (v.entries || []).length + ' 条');
  await step('messageFeedback/list（消息反馈）', () => API.call('messageFeedback/list', { args: { request: { sessionId: State.sessionId } } }), v => (v.value?.items || []).length + ' 条反馈');
  await step('session/control（状态流 baseline）', () => Mux.snapshot('session/control').then(b => ({ b })), r => Object.keys(r.b?.projections || {}).length + ' 个会话有投影 · jobs ' + Object.keys(r.b?.jobs || {}).length + ' 组');
  await step('session/follow（会话流开屏快照）', () => Mux.snapshot({ kind: 'session', sessionId: State.sessionId }), s => (s.records || []).length + ' 条记录 · hasMore=' + (s.hasMore ? '是' : '否'));
  await step('dsh CLI（插件树实时 dump）', async () => {
    const p = await (await fetch('/api/local/plugins?refresh=1')).json();
    if (p.source !== 'dump-config') throw new Error('回退到快照：' + String(p.error || '').slice(0, 120));
    return p;
  }, p => (p.plugins || []).length + ' 个插件 · ' + Object.keys(p.layers || {}).length + ' 层 · 执行方式 ' + (p.via || '—'));
  State.contract = { at: Date.now(), running: false, rows, hidden: false };
  const bad = rows.filter(r => !r.ok).length;
  bad ? UI.warn(bad + ' 项失败，见页面上的红行') : UI.ok('契约自检全部通过（' + rows.length + ' 项）');
  render();
}

/** 收起契约自检结果卡（只关显示；结果数据留着，重跑自检会重新展开）。
 *  ⚠️ 这里必须走一个"记住的开关"而不是靠 <details>：整页每步自检都会 render()，
 *  <details open> 会在每次重绘时被重新打开，用户关不掉 —— 这就是"自检结果关不上"的根因。 */
function closeContractCheck() {
  if (!State.contract) return;
  State.contract = { ...State.contract, hidden: true };
  render();
}

/** 契约自检结果卡片（系统状态页顶部；没跑过 / 被关掉就不显示）。
 *  布局上刻意**只用一个 card**：此前是 details > fold-body > card > table 三层套娃，
 *  同一张表外面裹了两层容器，视觉上缩进一层套一层 —— 现在扁平化，只有一张卡。 */
function contractCard() {
  const c = State.contract;
  if (!c || c.hidden) return '';
  const bad = c.rows.filter(r => !r.ok).length;
  return '<div class="card mb">'
    + '<h3>🧪 契约自检 ' + (c.running ? '<span class="tag gray">进行中…</span>' : (bad ? '<span class="tag err">' + bad + ' 项失败</span>' : '<span class="tag ok">全部通过</span>'))
    + '<span class="muted" style="font-size:11px;font-weight:400;margin-left:auto">' + new Date(c.at).toLocaleTimeString('zh-CN', { hour12: false }) + ' · ' + c.rows.length + ' 项</span>'
    // 关闭入口：进行中也能关（关的只是显示，自检流程在后台照常结束）
    + '<button class="btn sm" style="margin-left:8px" onclick="closeContractCheck()" title="收起这张结果卡；结果数据保留，重新自检会重新展开">✕ 关闭</button></h3>'
    + '<div class="muted mb" style="font-size:11.5px">逐项打真实的 DSH 接口，失败项直接标红（等价于命令行的 <code>node tools/test-api.mjs</code>，但只覆盖关键路径）。</div>'
    + '<table class="flat"><thead><tr><th>检查项</th><th>结果</th><th>耗时</th><th>详情</th></tr></thead><tbody>'
    + c.rows.map(r => '<tr>'
      + '<td>' + fmt.esc(r.name) + '</td>'
      + '<td>' + (r.ok ? '<span class="tag ok">通过</span>' : '<span class="tag err">失败</span>') + '</td>'
      + '<td class="muted mono" style="font-size:11px">' + r.ms + ' ms</td>'
      + '<td class="muted mono" style="font-size:11px"><span class="ellip w400" title="' + fmt.esc(r.detail) + '">' + fmt.esc(r.detail) + '</span></td>'
      + '</tr>').join('')
    + '</tbody></table></div>';
}

/* ---------- 宿主插件运行时清单（pluginInventory/list，真实 Remote） ---------- */
async function loadPluginInventory(redraw) {
  const box = document.getElementById('hostinv');
  if (!box) return;
  try {
    const r = await API.call('pluginInventory/list', { args: {} });
    // Remote 的返回已经被 API.call 解掉一层外层信封：pluginInventory/list 直接给 {entries}
    const entries = (r && (r.entries || (r.value && r.value.entries))) || (Array.isArray(r) ? r : []);
    State.pluginInventory = entries;
    const active = entries.filter(e => e.enabled && e.fiberPhase === 'active').length;
    const off = entries.filter(e => !e.enabled).length;
    const other = entries.filter(e => e.enabled && e.fiberPhase !== 'active').length;
    box.innerHTML = '<h3>🛰️ 宿主插件运行时清单</h3>'
      + '<div class="muted mb" style="font-size:11.5px">运行中的插件条目（含 fiber 阶段）：'
      + '共 ' + entries.length + ' 条 · 活跃 ' + active + ' · 未启用 ' + off + ' · 其它阶段 ' + other + '</div>'
      + '<div style="max-height:320px;overflow:auto"><table><thead><tr><th>entryId</th><th>模块</th><th>启用</th><th>fiber 阶段</th></tr></thead><tbody>'
      + entries.map(e => '<tr><td class="mono" style="font-size:11px">' + fmt.esc(e.entryId) + '</td>'
          + '<td class="mono" style="font-size:11px">' + fmt.esc(e.moduleName) + '</td>'
          + '<td>' + (e.enabled ? '<span class="tag ok">是</span>' : '<span class="tag gray">否</span>') + '</td>'
          + '<td>' + (e.fiberPhase ? '<span class="tag ' + (e.fiberPhase === 'active' ? 'ok' : 'warn') + '">' + fmt.esc(e.fiberPhase) + '</span>' : '—') + '</td></tr>').join('')
      + '</tbody></table></div>';
  } catch (e) {
    box.innerHTML = '<h3>🛰️ 宿主插件运行时清单</h3><div class="alert err">pluginInventory/list 调用失败：' + fmt.esc(e.message) + '</div>';
  }
  if (redraw) render();
}

/* ---------- 交付物 / 工作流 ---------- */
async function loadDeliverables(redraw) {
  // TTL 2.5s + 会话绑定：事件全量解析+目录扫描不便宜，来回切页命中缓存直接跳过
  if (!redraw && State.deliverables && loaderFresh('deliverables', 2500, State.sessionId)) return false;
  const s = currentSession();
  const cwd = s.cwd || State.host?.cwd || '';
  State.producedFiles = null; State.deliverables = null;
  const p1 = State.sessionId
    ? API.history(State.sessionId)
        .then(v => { State.producedFiles = collectProducedFromEvents(v.events || []); })
        .catch(e => { State.producedFiles = []; State.deliverablesErr = '会话事件读取失败：' + e.message; })
    : Promise.resolve((State.producedFiles = []));
  const p2 = fetch('/api/local/deliverables?limit=80&cwd=' + encodeURIComponent(cwd))
    .then(r => r.json())
    .then(j => { State.deliverables = j; })
    .catch(e => { State.deliverables = { items: [], scanned: 0, error: e.message }; });
  await Promise.all([p1, p2]);
  stampLoader('deliverables', State.sessionId);
  if (redraw) render();
  return true;
}
function downloadFile(p) {
  if (!p) return;
  window.open('/api/local/download?path=' + encodeURIComponent(p), '_blank');
}
async function openLocalPath(p) {
  try {
    // 能力探测（session/canOpenWorkspacePath）：当前部署不支持时给一句人话，而不是盲调后的原始报错。
    // 探测本身失败（旧版没有这个端点等）不拦路，照旧尝试打开。
    let can = true;
    try { can = (await API.call('host.canOpenPath', {})) !== false; } catch { can = true; }
    if (!can) { UI.warn('当前 DSH 部署不支持在宿主中打开路径。文件路径：' + p); return; }
    await API.call('host.openPath', { path: p }); UI.ok('已交给系统默认程序打开');
  } catch (e) { UI.err('打开失败：' + e.message); }
}
/**
 * 工作流：数据来自宿主 tool-workflow 专用事件族（不是 tool/call 名，也不是子代理事件）。
 * 四类事件（由工具插件追加到父会话）：
 *   tool-workflow/run-start   { runId, name }
 *   tool-workflow/agent-start { runId, seq, label, phase?, childId }
 *   tool-workflow/agent-end   { runId, seq, outcome }
 *   tool-workflow/run-end     { runId, stopReason }
 * 状态判定与原生一致：outcome=error → failed；有 stopReason 按 stopReason；
 * 没有 run-end 但所属 turn/step 已闭合 → interrupted。
 */
async function loadWorkflowRuns(redraw) {
  // TTL 2.5s + 会话绑定：整条会话事件流重新折叠不便宜
  if (!redraw && State.workflowRuns && loaderFresh('workflowRuns', 2500, State.sessionId)) return false;
  State.workflowRuns = null;
  try {
    // 同 loadTrajectory：手动刷新必须 force=true 绕过 API.history 的 4s 缓存
    const v = State.sessionId ? await API.history(State.sessionId, true) : { events: [] };
    loadSubagents();
    const evs = v.events || [];
    const runs = new Map();
    let lastSeq = -1, openTurn = false;
    for (const x of evs) {
      const e = x.event || {}; const d = e.data || {};
      if (typeof e.seq === 'number') lastSeq = Math.max(lastSeq, e.seq);
      if (e.type === 'turn/start') openTurn = true;
      else if (e.type === 'turn/end') openTurn = false;
      if (String(e.type).indexOf('tool-workflow/') !== 0) continue;
      const kind = e.type.slice('tool-workflow/'.length);
      const run = runs.get(d.runId) || { runId: d.runId, name: '', members: [], startedSeq: e.seq, time: e.time };
      if (kind === 'run-start') { run.name = d.name || '(未命名)'; run.time = e.time; }
      else if (kind === 'agent-start') {
        run.members.push({ seq: d.seq, label: d.label, phase: d.phase, childId: d.childId, status: 'running' });
      } else if (kind === 'agent-end') {
        const m = run.members.find(y => y.seq === d.seq) || { seq: d.seq, label: '(未知)' };
        m.status = d.outcome === 'error' ? 'failed' : (d.outcome || 'completed');
        if (!run.members.includes(m)) run.members.push(m);
      } else if (kind === 'run-end') { run.stopReason = d.stopReason; run.endSeq = e.seq; }
      runs.set(d.runId, run);
    }
    const out = [...runs.values()].map(r => {
      let status;
      if (r.stopReason !== undefined) status = r.stopReason === 'error' ? 'failed' : (r.stopReason || 'completed');
      else if (openTurn) status = 'running';
      else status = 'interrupted';                 // 没有 run-end 但轮次已闭合
      if (r.members.some(m => m.status === 'failed')) status = status === 'running' ? 'running' : 'failed';
      // 阶段分组：phase 字段省略（undefined）与空串是不同的键，与原生一致
      const phases = [];
      r.members.forEach(m => {
        const key = m.phase === undefined ? '__no_phase__' : String(m.phase);
        let g = phases.find(p => p.key === key);
        if (!g) { g = { key, label: m.phase === undefined ? '未分阶段' : (m.phase || '（空阶段）'), members: [] }; phases.push(g); }
        g.members.push(m);
      });
      return { ...r, status, phases, agentsStarted: r.members.length };
    }).sort((a, b) => (a.time || 0) - (b.time || 0));
    State.workflowRuns = out;
    State.workflowTrailing = { lastSeq, openTurn };
  } catch (e) { State.workflowRuns = []; State.workflowErr = e.message; }
  stampLoader('workflowRuns', State.sessionId);
  if (redraw) render();
  return true;
}

/* ---------- 外观（ui-theme）与权限模式（permission）----------
   两个开关都是"真开关"：直接写 DSH 的 settings 命名空间，
   权限模式还会立刻改变 DSH 的执行权限（因此要二次确认）。 */
const THEME_LABEL = { light: '浅色', dark: '深色', system: '跟随系统' };
/** 下拉顺序：system 在前（DSH schema 里 ui-theme.preference 的 default 就是 system） */
const THEME_KEYS = ['system', 'dark', 'light'];
/** localStorage 镜像：index.html 的内联脚本据此在首屏就先上色，避免"先深后浅"闪一下 */
const THEME_MIRROR = 'dshThemePref';
const PERM_LABEL = {
  'read-only': '只读', 'workspace-write': '工作区可写', 'danger-full-access': '完全访问',
};
const PERM_HINT = {
  'read-only': '只能读取，任何写入都会被沙箱拒绝',
  'workspace-write': '仅允许写入当前会话工作区（默认）',
  'danger-full-access': '取消沙箱与审批限制，可写任意路径',
};
function themePreference() {
  const item = (State.settings?.namespaces || []).find(n => n.ns === 'ui-theme');
  const v = item?.value?.preference;
  return THEME_LABEL[v] ? v : 'system';   // 取不到 / 越界值一律按 DSH 的默认值 system 处理
}
/** 本地乐观写偏好：写接口已经发出去了，但 State.settings 还是旧值。
 *  不先改本地就会出"点完立刻回读旧值 → 上了旧主题"的假失败。 */
function setThemePrefLocal(v) {
  const item = (State.settings?.namespaces || []).find(n => n.ns === 'ui-theme');
  if (item) item.value = Object.assign({}, item.value, { preference: v });
}
/** settings.mutate 成功时会**回传被改命名空间的完整对象**（含 value / user / revision）。
 *  直接并回 State.settings：省一次 describe 往返，也绕开 loader TTL ——
 *  裸 loadSettings() 在 8s 内会命中缓存返回旧值，那正是"外观点了没反应"的一半原因。 */
function mergeNsLocal(ns) {
  if (!ns || !ns.ns || !Array.isArray(State.settings?.namespaces)) return null;
  const i = State.settings.namespaces.findIndex(n => n.ns === ns.ns);
  if (i < 0) State.settings.namespaces.push(ns);
  else State.settings.namespaces[i] = Object.assign({}, State.settings.namespaces[i], ns);
  return ns;
}
function systemPrefersDark() {
  try { return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches); }
  catch (e) { return false; }
}
/** 把 DSH 的主题偏好应用到控制台自身。DOM 落点与原生 GUI 保持一致：
 *  html.style.colorScheme + body[data-ds-dark-theme]（原生没有任何 theme class），
 *  另外控制台自己再用 data-theme 承载浅色配色变量（CSS 默认即深色）。
 *  ⚠️ system 必须真的跟随 prefers-color-scheme —— 原来这一支的三元表达式写成了
 *  `(dark ? 'dark' : 'dark')`，无论系统是深是浅都落成 'dark'，
 *  于是"跟随系统"在浅色系统下永远不生效（用户报的"有时候没反应"就是这个）。
 *  属性只在变化时写，避免每次 render 都触发一遍样式重算。 */
function applyTheme() {
  const pref = themePreference();
  const dark = pref === 'dark' || (pref === 'system' && systemPrefersDark());
  const effective = dark ? 'dark' : 'light';
  const html = document.documentElement;
  if (html.dataset.theme !== effective) html.dataset.theme = effective;
  const cs = dark ? 'dark' : 'light';
  if (html.style.colorScheme !== cs) html.style.colorScheme = cs;
  const body = document.body;
  if (body) {
    if (dark) { if (!body.hasAttribute('data-ds-dark-theme')) body.setAttribute('data-ds-dark-theme', ''); }
    else if (body.hasAttribute('data-ds-dark-theme')) body.removeAttribute('data-ds-dark-theme');
  }
  try { localStorage.setItem(THEME_MIRROR, pref); } catch (e) { /* 隐私模式下写不了，不影响功能 */ }
  return { pref, dark, effective };
}
/** 系统深浅色变化：只有"跟随系统"才需要重算。注册一次即幂等。 */
let _sysThemeWatched = false;
function watchSystemTheme() {
  if (_sysThemeWatched || !window.matchMedia) return;
  _sysThemeWatched = true;
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const onChange = () => { if (themePreference() === 'system') applyTheme(); };
  if (mq.addEventListener) mq.addEventListener('change', onChange);
  else if (mq.addListener) mq.addListener(onChange);          // 旧内核兜底
}
function permissionInfo() {
  return currentSession().projections?.values?.permissions || { options: [], currentValue: null };
}
/** 连续切换时只认最后一次的结果：早先那次的回包别再落到界面上（防乱序回退）。 */
let _themeSeq = 0;
async function setThemePreference(v) {
  if (!THEME_LABEL[v]) return;
  const cur = themePreference();
  // 只在"确实知道服务端当前值"且与目标一致时才跳过写；settings 还没到手就别猜（原来无条件
  // early-return，settings 为空时 themePreference() 兜底返回 system，点「跟随系统」等于什么都没发生）
  const known = (State.settings?.namespaces || []).some(n => n.ns === 'ui-theme');
  if (known && v === cur) { applyTheme(); render(); return; }
  const prev = cur, seq = ++_themeSeq;
  setThemePrefLocal(v);                       // ① 先本地生效：视觉立刻变，不等两个往返
  applyTheme(); render();
  try {
    const res = await API.call('settings.mutate', { ns: 'ui-theme', ops: [{ op: 'set', path: ['preference'], value: v }] });
    if (seq !== _themeSeq) return;            // 已被更晚的一次切换取代，丢弃本次回包
    mergeNsLocal(res);                        // ② 用服务端权威值校准（顺带更新 revision）
    applyTheme(); render();
    UI.ok('外观已切换为「' + (THEME_LABEL[v] || v) + '」（已写入 DSH 设置）');
  } catch (e) {
    if (seq !== _themeSeq) return;
    setThemePrefLocal(prev); applyTheme(); render();   // ③ 失败回滚，界面不留假状态
    UI.err('切换外观失败：' + e.message);
  }
}
async function setPermissionPreset(v) {
  const info = permissionInfo();
  const cur = info.currentValue;
  if (v === cur) return;
  const danger = v === 'danger-full-access';
  const ok = await UI.confirm({
    title: danger ? '⚠️ 切换到完全访问' : '切换权限模式',
    html: '把 DSH 权限模式从 <code>' + fmt.esc(cur || '—') + '</code> 改成 <code>' + fmt.esc(v) + '</code>。<br>'
      + '<span class="muted">' + fmt.esc(PERM_HINT[v] || '') + '</span><br>'
      + (danger ? '<b class="danger-fg">完全访问会取消文件沙箱与审批限制。</b>' : '该设置立即生效，影响后续所有工具执行。'),
    okText: '切换', danger,
  });
  if (!ok) { render(); return; }
  try {
    await API.call('settings.mutate', { ns: 'permission', ops: [{ op: 'set', path: ['defaultPreset'], value: v }] });
    await loadSettings();
    await refreshSessionsLite();
    render();
    UI.ok('权限模式已切换为「' + (PERM_LABEL[v] || v) + '」');
  } catch (e) { UI.err('切换权限失败：' + e.message); }
}
/** 头部的一排"平台开关"：权限模式 + 外观，两处页面共用 */
function platformSwitches() {
  const info = permissionInfo();
  const pref = themePreference();
  // 原生注释：custom 是派生出来的显示态，永远不是一个可切换的目标，必须过滤
  const opts = (info.options || []).filter(o => o.value !== 'custom').map(o => ({ value: o.value, name: o.name || o.value }));
  const permSel = opts.length
    ? `<select title="DSH 权限模式（settings: permission.defaultPreset）" onchange="setPermissionPreset(this.value)">
        ${opts.map(o => `<option value="${fmt.esc(o.value)}"${o.value === info.currentValue ? ' selected' : ''}>${fmt.esc(PERM_LABEL[o.value] || o.name)}</option>`).join('')}
      </select>`
    : '<span class="sw-lb">权限模式：读取中…</span>';
  return `<span class="switches">
    <span class="sw-lb">权限模式</span>${permSel}
    <span class="sw-lb">外观</span>
    <select class="theme-sel" title="DSH 外观（settings: ui-theme.preference，改完立即生效）" onchange="setThemePreference(this.value)">
      ${THEME_KEYS.map(v => `<option value="${v}"${v === pref ? ' selected' : ''}>${THEME_LABEL[v]}</option>`).join('')}
    </select>
  </span>`;
}

/* ============ 斜杠命令 / @ 引用 / 消息反馈（走 DSH 原生远程通道）============
   三条 Typert Remote 通道，信封为 POST /api/<namespace>/<method> + { args }：
     commands/list                        → 本会话真实可用的命令清单（host 侧注册，不硬编码）
     commands/execute                     → 真正执行 /compact /goal /permission /plan /export /feedback
     fileReferences/list                  → @ 引用的文件候选（相对会话工作目录，支持模糊与前缀下钻）
     sessionReferenceResolver/candidates  → @ 引用的历史会话候选
     messageFeedback/list|put|delete      → 单条助手消息的赞/踩，存在 DSH 服务端（按 messageId + 版本 CAS）
   控制台另有少量"页面导航"命令，与 host 命令同列显示但标注来源，不做假动作。 */

const LOCAL_CMDS = [
  { name: 'dsh',     ico: '🔌', desc: '配置 DSH 主机地址与访问令牌',                 source: 'console', run: () => openDshDialog() },
  { name: 'new',     ico: '✨', desc: '新建会话（session.create）',            source: 'console', run: () => newSession() },
  { name: 'history', ico: '📜', desc: '把当前会话历史重新全量载入面板',           source: 'console', run: () => loadChatHistory() },
  { name: 'clear',   ico: '🧹', desc: '清空对话面板（只清界面，不动会话数据）',   source: 'console', run: () => Chat.reset() },
  { name: 'feedback', ico: '📝', desc: '写一条会话级备注（log-only，不触发模型）', source: 'console', run: () => recordSessionFeedback() },
  { name: 'model',   ico: '🧠', desc: '为当前会话切换模型（session.selectModel）', source: 'console', run: () => selectModel(State.sessionId) },
  { name: 'files',   ico: '📄', desc: '引用工作目录文件（@ 的同款菜单）',         source: 'console', run: () => openRefMenu('') },
  { name: 'trajectory', ico: '🧭', desc: '打开轨迹',                       source: 'console', run: () => { location.hash = '#/session/trajectory'; } },
  { name: 'deliverables', ico: '📦', desc: '打开交付物页',                     source: 'console', run: () => { location.hash = '#/deliverables'; } },
  { name: 'workflow', ico: '🕸️', desc: '打开工作流页',                     source: 'console', run: () => { location.hash = '#/workflow/runs'; } },
  { name: 'subagents', ico: '👥', desc: '打开子代理页',                       source: 'console', run: () => { location.hash = '#/subagent/list'; } },
  { name: 'jobs',    ico: '📊', desc: '打开后台作业页',                        source: 'console', run: () => { location.hash = '#/jobs'; } },
  { name: 'settings', ico: '⚙️', desc: '打开设置（权限 / 外观开关也在那里）', source: 'console', run: () => { location.hash = '#/settings'; } },
  { name: 'help',    ico: '❓', desc: '查看全部命令',                           source: 'console', run: () => openCmdMenu('') },
];

/** 拉取本会话的 host 命令清单（commands/list） */
async function loadCommands() {
  if (!State.sessionId) return;
  try {
    const list = await API.call('commands/list', { args: { agentId: State.sessionId } });
    State.commands = Array.isArray(list) ? list : [];
    State.commandsError = null;
  } catch (e) { State.commands = []; State.commandsError = e.message; }
}

/** 命令面板的全部条目：host 命令 + skills（原生用 / 触发纯文本插入）+ 控制台导航命令 */
function cmdItems() {
  const out = [];
  (State.commands || []).forEach(c => out.push({
    name: '/' + c.name, ico: '⌘', source: 'host',
    desc: (c.description || '') + (c.input && c.input.hint ? '   参数：' + c.input.hint : ''),
    needsArg: !!(c.input && c.input.hint),
  }));
  (State.skills || []).forEach(s => out.push({
    name: '/' + s.name, ico: '🧩', source: 'skill',
    desc: '插入技能名（原生 / 触发的纯文本插入）· ' + (s.description || '').slice(0, 60),
  }));
  LOCAL_CMDS.forEach(c => out.push({ name: '/' + c.name, ico: c.ico, source: 'console', desc: c.desc, local: c }));
  return out;
}

/** 在对话里插一条"命令回执"气泡（命令文本不进模型上下文，回执是 host 返回的原文） */
function commandBubble(line, text, kind) {
  Chat.clearEmpty();
  const wrap = document.createElement('div');
  wrap.style.cssText = 'margin:8px 0';
  wrap.innerHTML = '<div style="display:inline-block;padding:8px 12px;border:1px solid var(--line);border-radius:9px;'
    + 'background:var(--inset);max-width:88%;font-size:12.5px">'
    + '<div class="muted" style="font-size:10.5px;margin-bottom:4px">⌘ 命令 <span class="mono">' + fmt.esc(line) + '</span></div>'
    + '<div style="white-space:pre-wrap">' + fmt.esc(text || '（无输出）') + '</div>'
    + (kind === 'error' ? '<div class="tag err" style="margin-top:6px">命令执行失败</div>' : '')
    + '</div>';
  Chat.el().appendChild(wrap);
  Chat.scroll(true);        // 命令回显是"用户刚做的事"，必须看到 → 强制跟随到底部
}

/** 执行一条命令：host 命令走 commands/execute；skill 插入文本；控制台命令本地执行 */
async function executeCommand(item, line) {
  if (item && item.source === 'skill') { insertIntoInput('/' + item.name.replace(/^\//, '') + ' '); return; }
  if (item && item.source === 'console') { item.local.run(); return; }
  const cmdLine = line || (item ? item.name : '');
  try {
    const r = await API.call('commands/execute', { args: { agentId: State.sessionId, line: cmdLine, images: [] } });
    // API.call 已经解掉外层信封：commands/execute 直接返回 {commandId, result:{kind,text}}；
    // 命令没匹配上时 host 返回空值（ok 但无 value），此时 r 为 undefined。
    if (!r || !r.result) { commandBubble(cmdLine, '未知命令（host 的 commands/execute 没有匹配到该命令）', 'error'); return; }
    const res = r.result;
    commandBubble(cmdLine, res.text, res.kind === 'error' ? 'error' : 'ok');
    // /permission、/plan、/goal 这类命令会改变 host 状态：刷新后重新读投影
    setTimeout(() => { refreshSessionsLite().then(() => render()); }, 300);
  } catch (e) {
    commandBubble(cmdLine, e.message, 'error');
  }
}

/** 把文本插入输入框（保留已有内容，光标落在末尾） */
function insertIntoInput(text) {
  const inp = document.getElementById('chatinput');
  if (!inp) return;
  inp.value = inp.value.replace(/\/[^\s]*$/, '') + text;
  inp.focus();
  renderRefChips();
}

let menuState = { kind: null, items: [], index: 0, dir: '' };

function menuEl() { return document.getElementById(menuState.kind === 'cmd' ? 'cmdmenu' : 'refmenu'); }
function menuOpen() { const el = menuEl(); return !!(menuState.kind && el && el.style.display !== 'none'); }
function closeMenus() {
  const a = document.getElementById('cmdmenu'); if (a) a.style.display = 'none';
  const b = document.getElementById('refmenu'); if (b) b.style.display = 'none';
  menuState.kind = null; menuState.items = [];
}
function menuHtml(kind, title, items, extraHead) {
  menuState.kind = kind;
  const el = menuEl();
  if (!el) return;
  el.style.display = '';
  el.innerHTML = '<div class="menu-head">' + fmt.esc(title) + (extraHead || '') + '</div>'
    + (items.length ? items.map((it, i) => '<div class="menu-item' + (i === menuState.index ? ' on' : '') + '" '
        + 'onclick="menuPick(' + i + ')" onmouseenter="menuHover(' + i + ')">'
        + '<span class="mi-ico">' + (it.ico || '•') + '</span>'
        + '<span class="mi-name">' + fmt.esc(it.name) + '</span>'
        + '<span class="mi-desc">' + fmt.esc(it.desc || '') + '</span></div>').join('')
      : '<div class="menu-item"><span class="mi-desc">没有匹配项</span></div>');
}
function menuHover(i) {
  menuState.index = i;
  const el = menuEl();
  if (el) [...el.querySelectorAll('.menu-item')].forEach((n, k) => n.classList.toggle('on', k === i));
}
function menuPick(i) {
  const it = menuState.items[i];
  if (!it) return;
  const k = menuState.kind;
  if (k === 'cmd') {
    closeMenus();
    const inp = document.getElementById('chatinput');
    if (inp) inp.value = '';
    // 需要参数的 host 命令：先把命令名填进输入框，让用户补参数；无参命令直接执行
    if (it.needsArg) { insertIntoInput(it.name + ' '); return; }
    executeCommand(it, it.name);
    return;
  }
  if (k === 'ref') {
    if (it.isDir) { openRefMenu(it.name.replace(/\/$/, '') + '/'); return; }
    insertRefMention(it.raw);
    return;
  }
}
function openCmdMenu(q) {
  menuState.index = 0;
  const kw = String(q || '').toLowerCase();
  const items = cmdItems().filter(c => !kw || c.name.toLowerCase().includes(kw) || (c.desc || '').toLowerCase().includes(kw));
  menuState.items = items;
  const el = document.getElementById('refmenu'); if (el) el.style.display = 'none';
  menuHtml('cmd', '命令（host ' + (State.commands || []).length + ' 条 · skill ' + (State.skills || []).length + ' 条 · 控制台 ' + LOCAL_CMDS.length + ' 条）'
    + '   ↑↓ 选择 · Enter 执行 · Esc 关闭', items);
}

/** @ 引用菜单：候选来自 fileReferences/list（文件/目录）与 sessionReferenceResolver/candidates（历史会话） */
async function openRefMenu(query) {
  const q = String(query || '');
  menuState.index = 0;
  menuState.dir = q;
  const el = document.getElementById('cmdmenu'); if (el) el.style.display = 'none';
  const items = [];
  let note = '';
  try {
    const files = await API.call('fileReferences/list', { args: { agentId: State.sessionId, query: q } });
    (files || []).forEach(f => {
      const isDir = f.kind === 'directory';
      items.push({
        ico: isDir ? '📁' : fileIco(f.path),
        name: isDir ? f.path + '/' : f.path,
        desc: isDir ? '目录 · 进入' : '文件 · 引用',
        isDir, raw: isDir ? f.path + '/' : f.path,
      });
    });
  } catch (e) { note = '　（文件候选读取失败：' + fmt.esc(e.message) + '）'; }
  try {
    const subs = await API.call('sessionReferenceResolver/candidates', { args: { agentId: State.sessionId, query: q } });
    (subs || []).slice(0, 6).forEach(s => items.push({
      ico: '💬', name: s.mention || s.label, isDir: false,
      desc: '历史会话 · ' + (s.cwd || ''), raw: s.mention || ('@[' + s.label + '](dsh-session:' + s.sessionId + ')'),
    }));
  } catch (e) { /* 会话候选不可用时静默：文件候选仍然可用 */ }
  menuState.items = items;
  // 标题按原生 reference 包的两节口径写（section.files = 文件与文件夹 / section.sessions = 对话），
  // 不再自称"工作目录相对路径" —— 这里其实同时给历史会话候选。
  menuHtml('ref', '@ 引用 · 文件与文件夹 / 对话（前缀 ' + (q || '（空）') + '）'
    + '　点目录下钻、点文件或会话插入 @引用', items, note);
}
/** 把引用写进草稿：原生格式就是可见文本 @path（含空格用 @"..."） */
function insertRefMention(raw) {
  const inp = document.getElementById('chatinput');
  if (!inp) return;
  const mention = /\s/.test(raw) ? '@"' + raw + '"' : '@' + raw;
  const caret = inp.selectionStart ?? inp.value.length;
  const before = inp.value.slice(0, caret);
  const at = before.lastIndexOf('@');
  inp.value = (at >= 0 ? before.slice(0, at) : before) + mention + ' ' + inp.value.slice(caret);
  closeMenus();
  inp.focus();
  renderRefChips();
}
/** 从草稿里解析出 @ 引用，仅用于"已引用什么"的可视化提示（不参与编码） */
function parseRefs(text) {
  const out = [];
  const re = /@(?:"([^"]+)"|([^\s@]+))/g;
  let m;
  while ((m = re.exec(String(text || '')))) out.push(m[1] || m[2]);
  return [...new Set(out)];
}
function renderRefChips() {
  const box = document.getElementById('refchips');
  if (!box) return;
  const inp = document.getElementById('chatinput');
  const refs = parseRefs(inp ? inp.value : '');
  box.innerHTML = refs.length
    ? '<span class="muted" style="font-size:11px;margin-right:6px">已引用 ' + refs.length + ' 项：</span>'
      + refs.map(r => '<span class="chip">📄 ' + fmt.esc(r) + '</span>').join('')
    : '';
}
function chatTyping(ev) {
  const inp = ev.target;
  const v = inp.value;
  const caret = inp.selectionStart ?? v.length;
  const before = v.slice(0, caret);
  const slash = /^\/([^\s]*)$/.exec(v);
  if (slash) { openCmdMenu(slash[1]); return; }
  const at = before.lastIndexOf('@');
  if (at >= 0) {
    const q = before.slice(at + 1);
    if (!/\s/.test(q)) { openRefMenu(q); return; }
  }
  closeMenus();
  renderRefChips();
}
function chatKey(ev) {
  if (menuOpen()) {
    const n = menuState.items.length;
    if (ev.key === 'ArrowDown') { ev.preventDefault(); menuHover((menuState.index + 1) % Math.max(n, 1)); return; }
    if (ev.key === 'ArrowUp') { ev.preventDefault(); menuHover((menuState.index - 1 + n) % Math.max(n, 1)); return; }
    if (ev.key === 'Escape') { ev.preventDefault(); closeMenus(); return; }
    if (ev.key === 'Enter') { ev.preventDefault(); menuPick(menuState.index); return; }
  }
  if (ev.key === 'Enter' && !ev.shiftKey) sendChat(ev);
  if (ev.key === 'Escape') closeMenus();
}

/* ---------- 消息反馈：DSH 服务端存储（messageFeedback/*，按 messageId + 版本 CAS） ----------
   实测契约（0.1.5-rc.2，逐条打过真实端点）：
     list   {request:{sessionId}}                                     → {ok:true, value:{items:[{messageId,rating,version,note?,category?,createdAt,updatedAt}]}}
     put    {request:{sessionId,messageId,rating,note?,category?,ifVersion:string|null}} → {ok:true, value:{…item}}
     delete {request:{sessionId,messageId,ifVersion:string}}          → {ok:true, value:{absent:true}}
   · rating 只收 'positive' / 'negative'（传 like / bad 会被网关判 boundary validation）
   · messageId 必须是**已持久化的助手消息 id**，否则 target-not-found
   · ifVersion 是 UUID 字符串（不是数字）
   ⚠️ 之前界面上直接把内部名 "messageFeedback" 和原始错误码印在每条消息下面 —— 那本身就是个错误。 */

/** 反馈分类（与原生 feedback 插件的 7 项一一对应） */
const FB_CATEGORIES = [
  ['task-result', '任务结果'],
  ['instruction-following', '指令理解与遵循'],
  ['product-interaction', '产品功能与交互'],
  ['service-stability', '稳定性和速度'],
  ['resource-cost', '资源使用与费用'],
  ['security-privacy-permission', '安全隐私与权限'],
  ['other', '其他'],
];
/** 把宿主的业务错误码翻译成人话（原生 locale 的 error.* 同款口径） */
function fbErrText(code) {
  const c = String(code || '');
  const m = {
    'version-conflict': '这条反馈已在别处改动，已显示最新状态，请再试一次',
    'note-blank': '说明不能只有空白字符',
    'note-too-large': '说明太长，请缩短后再提交',
    'target-not-found': '宿主没有这条消息的持久化记录（只对已落盘的助手消息有效）',
    'session-not-found': '会话已不存在（可能已被删除）',
  };
  if (m[c]) return m[c];
  if (/gateway\/input-invalid/.test(c)) return '宿主不接受这次请求的参数形状';
  if (/Failed to fetch|NetworkError|ECONNREFUSED/i.test(c)) return '连不上控制台后端';
  return '保存失败：' + c;
}
function fbSel(id) {
  const s = String(id || '');
  if (/^[A-Za-z0-9_-]+$/.test(s)) return s;
  try { return CSS.escape(s); } catch { return s.replace(/["\\]/g, ''); }
}
async function loadFeedback() {
  if (!State.sessionId) { State.feedback = {}; return; }
  try {
    const r = await API.call('messageFeedback/list', { args: { request: { sessionId: State.sessionId } } });
    const map = {};
    if (r && r.ok && r.value && Array.isArray(r.value.items)) r.value.items.forEach(it => { map[it.messageId] = it; });
    State.feedback = map;
    State.feedbackError = (r && r.ok === false) ? (r.error && r.error.code) : null;
  } catch (e) { State.feedback = {}; State.feedbackError = e.message; }
}
/** 点「👍 好的回答 / 👎 有问题的回答」：
 *  已标记同一个 → 直接取消标记（原生 action.likeActive = 取消标记）；
 *  否则开对话框（分类 + 详情），提交后才写服务端。 */
async function fbAsk(messageId, rating) {
  if (!messageId) { UI.warn('这条消息没有持久化 id，无法反馈（多为流式中间态）'); return; }
  const cur = (State.feedback || {})[messageId];
  if (cur && cur.rating === rating) { await fbSet(messageId, rating, { cancel: true }); return; }
  const entry = await fbDialog(rating, cur);
  if (entry === null) return;                       // 用户取消
  await fbSet(messageId, rating, entry);
}
/** 反馈对话框：反馈分类 + 反馈详情（对齐原生 FeedbackDialogController） */
function fbDialog(rating, cur) {
  return new Promise(resolve => {
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.innerHTML = '<div class="modal" role="dialog" aria-modal="true">'
      + '<h3>提交反馈 · ' + (rating === 'positive' ? '好的回答' : '有问题的回答') + '</h3>'
      + '<div class="modal-body">'
      + '<div class="modal-hint">分类与说明都可以留空。<b>提交内容会包括当前对话的日志</b>，用于定位问题。</div>'
      + '<div class="fb-lbl">反馈分类</div>'
      + '<select id="fbd-cat"><option value="">（不选分类）</option>'
      + FB_CATEGORIES.map(([v, l]) => '<option value="' + v + '"' + (cur && cur.category === v ? ' selected' : '') + '>' + l + '</option>').join('')
      + '</select>'
      + '<div class="fb-lbl">反馈详情</div>'
      + '<textarea id="fbd-note" placeholder="补充说明（可留空）">' + (cur && cur.note ? fmt.esc(cur.note) : '') + '</textarea>'
      + '<div class="modal-err" id="fbd-err"></div>'
      + '</div>'
      + '<div class="modal-actions">'
      + '<button class="btn" id="fbd-cancel">取消</button>'
      + '<button class="btn primary" id="fbd-ok">提交</button>'
      + '</div></div>';
    document.body.appendChild(mask);
    const catEl = mask.querySelector('#fbd-cat');
    const noteEl = mask.querySelector('#fbd-note');
    const close = v => { mask.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
    const submit = () => {
      const note = noteEl.value.trim();
      close({ category: catEl.value || undefined, note: note || undefined });
    };
    const onKey = e => {
      if (e.key === 'Escape') { e.preventDefault(); close(null); }
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); }
    };
    document.addEventListener('keydown', onKey);
    mask.querySelector('#fbd-ok').onclick = submit;
    mask.querySelector('#fbd-cancel').onclick = () => close(null);
    mask.onclick = e => { if (e.target === mask) close(null); };
    setTimeout(() => noteEl.focus(), 30);
  });
}
/** 写 / 取消一条反馈。entry = { note?, category?, cancel? }
 *  ⚠️ ifVersion 必须是字符串（宿主 schema 如此）；版本冲突时把权威值同步回来。 */
async function fbSet(messageId, rating, entry) {
  if (!messageId || !State.sessionId) return;
  const e = entry || {};
  const cur = (State.feedback || {})[messageId];
  try {
    if (e.cancel || (cur && cur.rating === rating)) {
      const d = await API.call('messageFeedback/delete', { args: { request: {
        sessionId: State.sessionId, messageId, ifVersion: String(cur ? cur.version : '') } } });
      if (d && d.ok === false) throw new Error((d.error && d.error.code) || '删除失败');
      UI.info('已取消标记');
    } else {
      const req = { sessionId: State.sessionId, messageId, rating, ifVersion: cur ? String(cur.version) : null };
      if (e.note) req.note = e.note;
      if (e.category) req.category = e.category;
      const r = await API.call('messageFeedback/put', { args: { request: req } });
      if (r && r.ok === false) {
        if (r.error && r.error.code === 'version-conflict') {
          // host 带回权威当前值，直接同步，不必重新 list
          State.feedback[messageId] = r.error.current || undefined;
        }
        throw new Error((r.error && r.error.code) || '提交失败');
      }
      UI.ok('感谢你的反馈');
    }
    await loadFeedback();
    paintFeedback(messageId);
  } catch (err) { UI.err(fbErrText(String((err && err.message) || err))); }
}
/** 就地刷新某条消息的反馈按钮态（同一条消息在聊天流与历史面板里可能各有一份） */
function paintFeedback(messageId) {
  const it = (State.feedback || {})[messageId];
  const sel = '[data-fb="' + fbSel(messageId) + '"]';
  document.querySelectorAll(sel + ' button[data-v], ' + sel + '[data-v]').forEach(b => {
    const v = b.dataset.v;
    const on = !!it && it.rating === v;
    b.classList.toggle('on', on);
    b.title = on ? '取消标记' : (v === 'positive' ? '好的回答：存到 DSH 服务端，可带分类与说明' : '有问题的回答：存到 DSH 服务端，可带分类与说明');
  });
}
/** 历史面板里的反馈按钮组（与消息操作条共用同一份状态与文案） */
function fbHtml(messageId) {
  const cur = (State.feedback || {})[messageId];
  const pos = !!(cur && cur.rating === 'positive'), neg = !!(cur && cur.rating === 'negative');
  const cat = cur && cur.category ? ((FB_CATEGORIES.find(x => x[0] === cur.category) || [])[1] || cur.category) : '';
  const bits = [];
  if (cur) bits.push(pos ? '好的回答' : '有问题的回答');
  if (cat) bits.push(cat);
  const tip = cur ? ('已反馈：' + bits.join(' · ') + '（点同一个可取消标记）') : '存到 DSH 服务端，可带分类与说明';
  return '<div class="fb" data-fb="' + fmt.esc(messageId || '') + '" title="' + fmt.h(tip) + '">'
    + '<button data-v="positive" class="' + (pos ? 'on' : '') + '" onclick="fbAsk(' + fmt.attr(messageId) + ',\'positive\')">👍</button>'
    + '<button data-v="negative" class="' + (neg ? 'on' : '') + '" onclick="fbAsk(' + fmt.attr(messageId) + ',\'negative\')">👎</button>'
    + (cat ? '<span class="muted" style="font-size:10px;align-self:center">' + fmt.esc(cat) + '</span>' : '')
    + '</div>';
}

/* ---------- 对话侧栏：计划 / 任务 / 队列 / 待办（全部来自真实投影与实时帧） ---------- */
function chatPlanInfo() {
  const pv = currentSession().projections?.values || {};
  const todos = State.todos || pv.todos || [];
  const done = todos.filter(t => t.status === 'completed').length;
  return { todos, done };
}
/** 输入区徽标：**只报任务进度**。
 *  「计划模式：进行中 / 待确认」这类纯状态灯已按用户要求撤掉 —— 与侧栏那个块同理，
 *  它不提供任何可操作信息，计划本身与 Approve / Keep planning 都在输入框上方的提问卡里。 */
function planBadgeText() {
  const { todos, done } = chatPlanInfo();
  const bits = [];
  if (todos.length) bits.push('任务 ' + done + '/' + todos.length);
  // 没有任务就**整块不显示**：以前常驻一句"无进行中的计划"，
  // 每个会话都占着一行宽度、还什么信息都没有。
  return bits.length ? '📋 ' + bits.join(' · ') : '';
}
function toggleChatAside() {
  const el = document.getElementById('chataside');
  if (!el) return;
  const show = el.style.display === 'none' || !el.style.display;
  el.style.display = show ? 'block' : 'none';
  if (show) renderChatAside();
}
function renderChatAside() {
  const el = document.getElementById('chataside');
  if (!el || el.style.display === 'none') return;
  const { todos } = chatPlanInfo();
  const q = currentQueue();
  const qs = { queued: '排队中', steering: '转向中', context: '上下文' };
  const box = (title, body, count) => '<div style="margin-bottom:14px"><div class="muted" style="font-size:11px;letter-spacing:.5px;margin-bottom:6px">'
    + title + (count != null ? ' <span class="tag gray" style="font-size:9.5px">' + count + '</span>' : '') + '</div>' + body + '</div>';
  /* 「计划模式」块已按用户要求从侧栏整体拿掉：它只是个状态指示灯，真正的行动入口
     （计划全文 + Approve / Keep planning）始终在输入框上方的提问卡里 —— 那里才是有用的部分，保持不动。 */
  const todoBody = todos.length
    ? todos.map(t => '<div style="font-size:12px;padding:3px 0">' + (t.status === 'completed' ? '✅' : t.status === 'in_progress' ? '🔄' : '⬜')
        + ' <span' + (t.status === 'completed' ? ' class="muted"' : '') + '>' + fmt.esc(t.content) + '</span></div>').join('')
    : '<div class="muted" style="font-size:11.5px">还没有任务列表</div>';
  const queueBody = q.length
    ? q.map(it => {
        const txt = (it.message?.content || []).filter(b => b.type === 'text').map(b => b.text).join(' ');
        return '<div style="font-size:11.5px;padding:5px 8px;border:1px solid var(--line);border-radius:7px;margin-bottom:5px">'
          + '<span class="tag gray" style="font-size:9.5px">' + fmt.esc(qs[it.placement] || it.placement || '—') + '</span> '
          + fmt.esc(txt.slice(0, 120))
          + (it.placement === 'queued' ? '<div class="mt" style="display:flex;gap:5px"><button class="btn sm" onclick="queueEdit(' + fmt.attr(it.id) + ')">改</button>'
              + '<button class="btn sm" onclick="queueOp(' + fmt.attr(it.id) + ',\'remove\')">删</button></div>' : '')
          + '</div>';
      }).join('')
    : '<div class="muted" style="font-size:11.5px">消息队列为空</div>';
  /* 审批按**当前会话**过滤：State.approvals 是宿主机级 waterfall 汇总（每条带 sessionId = agentId），
     不过滤就会把别的会话的审批请求画在本会话侧栏里，点了还未必答复得对 ——
     原生是会话内视图（useSessionPendingInteraction）。
     其它会话的待处理不在侧栏展开，但**要报个数**：否则"侧栏说没有待审批、顶栏却显示有待处理"会自相矛盾。 */
  const allAp = State.approvals || [];
  const mineAp = allAp.filter(a => !a.sessionId || a.sessionId === State.sessionId);
  const otherAp = allAp.length - mineAp.length;
  const approvals = (mineAp.length
    ? mineAp.map(a => '<div style="font-size:11.5px;padding:6px 8px;border:1px solid rgba(245,165,36,.4);border-radius:7px;margin-bottom:5px">'
        + '<div>待审批：<code>' + fmt.esc(a.toolName || a.title || a.approvalId || '—') + '</code></div>'
        + '<div class="mt" style="display:flex;gap:5px"><button class="btn sm" onclick="respondApproval(' + fmt.attr(a.approvalId) + ',true)">允许</button>'
        + '<button class="btn sm" onclick="respondApproval(' + fmt.attr(a.approvalId) + ',false)">拒绝</button></div></div>').join('')
    : '<div class="muted" style="font-size:11.5px">没有待审批请求</div>')
    + (otherAp ? '<div class="muted" style="font-size:10.5px;margin-top:4px">另有 ' + otherAp + ' 条审批属于其他会话（切到那个会话才能处理）</div>' : '');
  // 会话内快捷模型切换（对齐原生 model-selection：不用跳去「大模型」页打断对话）。
  // 目录没加载时异步补一次，加载完 renderChatAside 会重入。
  const groups = State.models?.groups || [];
  if (!groups.length) loadChatModels();
  const curKey = chatModelKey();
  let modelsBody = groups.length
    ? '<select class="input" style="width:100%;font-size:12px" onchange="chatSwitchModel(this.value)">'
      + groups.map(g => '<optgroup label="' + fmt.esc(g.name || g.id || '') + '">'
        + (g.models || []).map(m => {
            const v = (g.id || '') + '/' + m.id;
            return '<option value="' + fmt.esc(v) + '"' + (v === curKey ? ' selected' : '') + '>' + fmt.esc(m.name || m.id) + '</option>';
          }).join('') + '</optgroup>').join('')
      + '</select>'
    : '<div class="muted" style="font-size:11.5px">模型目录加载中…</div>';
  // 推理强度选择器（对齐原生 composer）：目录里每个 model 自带 reasoning.efforts（id/name/defaultEffort），
  // 走同一个 session/selectModel（MAP 一直会转发 reasoningEffort，此前只是没发）。当前模型没有 efforts 就不显示。
  const ei = chatEffortInfo();
  const curEffort = sessionModelOf(State.sessionId).reasoningEffort || ei.def || '';
  if (groups.length && ei.efforts.length) {
    modelsBody += '<div style="display:flex;gap:6px;align-items:center;margin-top:6px">'
      + '<span class="muted" style="font-size:11px;white-space:nowrap">推理强度</span>'
      + '<select class="input" style="flex:1;font-size:12px" onchange="chatSwitchEffort(this.value)">'
      + ei.efforts.map(e => '<option value="' + fmt.esc(e.id) + '"' + (e.id === curEffort ? ' selected' : '') + '>'
        + fmt.esc(e.name || e.id) + (e.id === ei.def ? '（默认）' : '') + '</option>').join('')
      + '</select></div>';
  }
  // 会话内快捷智能体预设切换（与上面的模型框同款交互；对齐原生 agent-preset/selected 的会话内体验）。
  // 注意 agentPreset/select 只对"尚未产生内容的会话"有效，所以选择器下挂一句提示，切换前再 confirm 一次。
  const presets = State.presets || [];
  const curPreset = sessionPreset(currentSession());
  const presetBody = presets.length
    ? '<select class="input" style="width:100%;font-size:12px" onchange="chatSwitchPreset(this.value)">'
      + presets.map(p => '<option value="' + fmt.esc(p.id) + '"' + (p.id === curPreset ? ' selected' : '') + '>'
        + fmt.esc(p.name || p.id) + (p.isDefault ? '（默认）' : '') + '</option>').join('')
      + '</select><div class="muted" style="font-size:10.5px;margin-top:4px">作用于当前会话（清单在「智能体预设」页全局管理） · 仅对尚未产生内容的会话生效</div>'
    : '<div class="muted" style="font-size:11.5px">智能体预设加载中…</div>';
  el.innerHTML = box('🧠 模型', modelsBody) + box('🧭 智能体预设', presetBody) + box('✅ 任务列表', todoBody, todos.length)
    + box('📨 消息队列', queueBody, q.length) + box('🛡️ 审批', approvals, mineAp.length);
}
/** 会话内切换智能体预设：取消/失败都要把下拉还原成当前值（renderChatAside 重画即还原）。
 *  用 refreshSessionsLite 而不是 reloadSessions —— 后者会整页 render，把正在流式的对话打断。 */
async function chatSwitchPreset(id) {
  const cur = sessionPreset(currentSession());
  if (!id || id === cur) { renderChatAside(); return; }
  const ok = await UI.confirm({ title: '切换智能体预设', message: '把当前会话切换到 ' + id + '？\n（仅对尚未产生内容的会话有效）', okText: '切换' });
  if (!ok) { renderChatAside(); return; }
  try {
    await API.call('agentPreset.select', { sessionId: State.sessionId, agentPreset: id });
    UI.ok('已切换到 ' + id);
    await refreshSessionsLite();               // 会话列表/首页摘要里的智能体预设列同步，不触发整页重绘
    renderScopeBar(routeOf('/chat-agent'));
    renderChatAside();
  } catch (e) { UI.err('切换失败：' + e.message); renderChatAside(); }
}
/* ---------- 「会话当前模型」的唯一真相源 ----------
   ⚠️ 这里踩过一个真 bug：`session/selectModel` 改的是**会话级**的 next，
   而 `session/modelCatalog` 返回的 default 是**全局**默认 —— 它不接受 sessionId
   （实测传了会报 `args fields do not match the descriptor: unexpected "sessionId"`），
   也永远不跟着某个会话变。此前所有"当前模型"都读后者，于是出现
   "切完模型再点开还是旧的 / 推理强度掉回默认" —— 就是用户报的那个回显 bug。
   权威依据（原生 ui-model-selection 的 ModelDirectory.syncInputs）：
       current = projections.modelSelection.next ?? modelCatalog.default
   形状也要注意：modelSelection = { lastUsed, next } **两个槽**，不是扁平的 {provider,model}；
   lastUsed 是"上一轮实际用的"，切换后它会滞后一拍，不能用来回显（原生同样不用）。 */
function sessionModelOf(sid) {
  const s = (State.sessions || []).find(x => x.sessionId === (sid || State.sessionId));
  const next = s?.projections?.values?.modelSelection?.next;
  if (next && next.provider && next.model) {
    return { provider: next.provider, model: next.model, reasoningEffort: next.reasoningEffort || '', from: 'session' };
  }
  const d = State.models?.current || {};        // = modelCatalog.default（全局默认）
  if (d.provider && d.model) {
    return { provider: d.provider, model: d.model, reasoningEffort: d.reasoningEffort || '', from: 'default' };
  }
  return { provider: '', model: '', reasoningEffort: '', from: 'none' };
}
/** 当前会话的模型在切换器里的 key：'provider/model' */
function chatModelKey() {
  const cur = sessionModelOf(State.sessionId);
  return (cur.provider || '') + '/' + (cur.model || '');
}
/** 当前模型的推理强度元数据：目录里按 provider/model 找到该模型，取它的 reasoning.efforts 与 defaultEffort */
function chatEffortInfo() {
  const key = chatModelKey();
  for (const g of (State.models?.groups || [])) {
    for (const m of (g.models || [])) {
      if ((g.id || '') + '/' + m.id === key) {
        return { efforts: m.reasoning?.efforts || [], def: m.reasoning?.defaultEffort };
      }
    }
  }
  return { efforts: [], def: undefined };
}
/** 会话内切换推理强度：走同一个 session/selectModel（MAP 一直转发 reasoningEffort），模型本身不变。
 *  切模型时不带 reasoningEffort —— 与原生一致，"缺省的 effort 清掉继承值，回到该模型的供应商默认"。
 *  ⚠️ 这里必须用**会话级**当前模型（sessionModelOf）：用全局默认会把"只想改强度"变成
 *  "顺手把模型也换回全局默认"，是静默的错。 */
async function chatSwitchEffort(effortId) {
  const cur = sessionModelOf(State.sessionId);
  if (!cur.provider || !cur.model) { renderChatAside(); return; }
  try {
    await API.call('session.selectModel', { sessionId: State.sessionId, provider: cur.provider, model: cur.model, reasoningEffort: effortId || undefined });
    UI.ok('推理强度已切换为「' + (effortId || '默认') + '」');
    await refreshSessionsLite(true);      // 拉回会话级 modelSelection.next，否则下拉会跳回旧值
    await loadChatModels();
  } catch (e) { UI.err('切换失败：' + e.message); renderChatAside(); }
}
async function loadChatModels() {
  if (State._modelsLoading) return;
  State._modelsLoading = true;
  try { State.models = await API.call('session.models', { sessionId: State.sessionId }); } catch {}
  State._modelsLoading = false;
  renderChatAside();
}
async function chatSwitchModel(v) {
  const i = v.lastIndexOf('/');
  if (i < 0) return;
  const provider = v.slice(0, i), model = v.slice(i + 1);
  try {
    await API.call('session.selectModel', { sessionId: State.sessionId, provider, model });
    UI.ok('已切换到 ' + model);
    await refreshSessionsLite(true);      // 会话级 modelSelection.next 变了，回读一次再重绘下拉
    await loadChatModels();
  } catch (e) { UI.err('切换失败：' + e.message); renderChatAside(); }
}
/* ---------- 主渲染 ---------- */
/** 这些区域的内容是"加载器直接写 DOM"的（Pages 里只有骨架 div）：
    #chatlog 对话流（对话页）· #hostinv 宿主插件运行时 / #dynplugins 动态插件（插件页）
    · #histpanel 会话历史（会话页）· #presetpanel 智能体预设配置（智能体预设页）。
    重绘会把骨架一起换掉，于是 paintOnly 重绘（排序 / 翻页 / 轮次筛选 / 多选作答 / 查看全部会话）
    会把整块内容清空 —— 靠"再跑一遍加载器"补回来，又会把交互改好的状态冲掉。
    这里改成把**整块 DOM 节点**搬过去：零序列化开销，而且 Chat.cur 这类流式引用依然指向真实节点
    （否则下一次增量会新建一个气泡，一条回复被切成好几段）。
    ⚠️ 键必须是 ROUTES 里的路由 id（如 agentMgr，不是 agent），写错等于这块内容任何一次重绘后都会丢；
     tools/test-api.mjs 里有断言盯着。 */
const DOM_OWNED = {
  chat: ['chatlog'],
  plugins: ['hostinv', 'dynplugins'],
  sessions: ['histpanel'],
  agentMgr: ['presetpanel'],
};
const parkedDom = {};
function parkOwned() {
  for (const ids of Object.values(DOM_OWNED)) {
    for (const id of ids) { const n = document.getElementById(id); if (n) parkedDom[id] = n; }
  }
}
function paintDirect(r) {
  // 对话流是"属于某个会话"的：会话换了就别把上一个会话的内容贴过来（交给加载器重新取）
  const stale = r.id === 'chat' && State.chatLogSession && State.chatLogSession !== State.sessionId;
  if (stale) { Chat.cur = null; Chat.curKey = null; }
  else for (const id of (DOM_OWNED[r.id] || [])) {
    const fresh = document.getElementById(id), kept = parkedDom[id];
    if (fresh && kept && kept !== fresh && typeof fresh.replaceWith === 'function') fresh.replaceWith(kept);
  }
  // 插件表由 Table 排序/分页，且行是 renderPlugins() 直接写进去的：必须按新状态同步重填
  if (r.id === 'plugins') renderPlugins();
}
/* ---------- 渲染性能记录（把"感觉卡"变成可看的数字）----------
   render() 每次都整块替换 #content，所以"页面重不重"= innerHTML 的耗时 + 生成多少 DOM 节点。
   这里记下最近若干次，在「系统状态 → 渲染性能」里能直接看到是哪一页、是整页重绘还是局部重绘。
   为什么要它：优化不能靠猜 —— 之前"感觉更卡了"没有办法定位到具体页面与具体操作。 */
const PERF_WARN_MS = 120;      // 单次 innerHTML 超过这个耗时 → 控制台留一条 warn
const PERF_KEEP = 60;          // 环形保留最近 60 次
function nowMs() { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(); }
function recordPerf(routeId, ms, el, paintOnly) {
  let nodes = 0;
  try { nodes = (el && el.querySelectorAll) ? el.querySelectorAll('*').length : 0; } catch (e) { nodes = 0; }
  State.perf = State.perf || [];
  State.perf.push({ at: Date.now(), route: routeId, ms: Math.round(ms * 10) / 10, nodes, paintOnly: !!paintOnly });
  if (State.perf.length > PERF_KEEP) State.perf.shift();
  if (ms > PERF_WARN_MS) {
    try {
      console.warn('[DSH 控制台] 渲染较慢：' + routeId + ' · ' + ms.toFixed(1) + ' ms · ' + nodes + ' 个 DOM 节点'
        + (paintOnly ? '（局部重绘）' : '（整页重绘）') + ' —— 明细见「系统状态 → 渲染性能」');
    } catch (e) { /* 控制台不可用时忽略 */ }
  }
}
/** 渲染性能面板（系统状态页）：最近 12 次 + 汇总。数据来自 recordPerf，不额外测量。 */
function perfCard() {
  const all = State.perf || [];
  if (!all.length) return '';
  const recent = all.slice(-12).reverse();
  const ms = all.map(x => x.ms);
  const avg = ms.reduce((a, b) => a + b, 0) / ms.length;
  const worst = all.reduce((a, b) => (b.ms > a.ms ? b : a), all[0]);
  const heavy = recent.filter(x => x.nodes > 1500);
  const labelOf = id => { const r = ROUTES.find(x => x.id === id); return r ? (r.ico + ' ' + r.label) : id; };
  return '<details class="fold mt"' + (worst.ms > PERF_WARN_MS ? ' open' : '') + '>'
    + '<summary>⚡ 渲染性能（本控制台自身）'
    + (worst.ms > PERF_WARN_MS ? ' <span class="tag warn">最慢 ' + worst.ms + ' ms</span>' : ' <span class="tag ok">正常</span>')
    + '<span class="muted" style="font-weight:400;font-size:11px;margin-left:auto">样本 ' + all.length + ' 次 · 平均 ' + avg.toFixed(1) + ' ms</span></summary>'
    + '<div class="fold-body">'
    + '<div class="muted mb" style="font-size:11.5px">每次页面重绘（<code>#content.innerHTML</code>）的耗时与生成的 DOM 节点数。'
    + '超过 ' + PERF_WARN_MS + ' ms 会在浏览器控制台留一条 warn —— 排查"切页卡"就看这张表里哪一页、哪一类重绘最贵。</div>'
    + '<table><thead><tr><th>时间</th><th>页面</th><th>耗时</th><th>DOM 节点</th><th>重绘类型</th></tr></thead><tbody>'
    + recent.map(x => '<tr>'
      + '<td class="muted mono" style="font-size:11px">' + new Date(x.at).toLocaleTimeString('zh-CN', { hour12: false }) + '</td>'
      + '<td>' + fmt.esc(labelOf(x.route)) + '</td>'
      + '<td class="mono" style="font-size:11.5px' + (x.ms > PERF_WARN_MS ? ';color:var(--warn)' : '') + '">' + x.ms + ' ms</td>'
      + '<td class="mono muted" style="font-size:11.5px">' + x.nodes + '</td>'
      + '<td>' + (x.paintOnly ? '<span class="tag gray">局部</span>' : '<span class="tag">整页</span>') + '</td>'
      + '</tr>').join('')
    + '</tbody></table>'
    + (heavy.length ? '<div class="pg-tip">💡 单页 DOM 超过 1500 节点的重绘出现在：'
        + [...new Set(heavy.map(x => labelOf(x.route)))].join('、')
        + '。这类页面已经把长列表做成"分页 + 屏外跳过渲染"（<code>Table.slice</code> / <code>.perf-list</code>）；'
        + '若仍偏慢，优先把「一次显示多少条」调小，而不是继续堆列表。</div>' : '')
    + '</div></details>';
}

async function render(opts){
  renderNav();
  applyTheme();          // 主题是文档级属性：每次重绘都对齐一次，任何改了 ui-theme 的路径都不会漏上色
  closeMenus();          // 切页后命令/引用菜单的 DOM 已被替换，清掉残留状态
  const r = routeOf(currentPath());
  if (r.id !== 'chat') {
    State.pendingImage = null; State.pendingFile = null;
    // 离开对话页后 #chatlog 就不在了，流式引用必须清掉；
    // 停在对话页则保留 —— paintDirect() 会把整块 DOM 搬过来，引用仍指向真实节点。
    Chat.cur = null; Chat.curKey = null; Chat.lastUser = null; Chat.lastBubble = null;
  }
  const page = Pages[r.id] || Pages.home;
  const contentEl = document.getElementById('content');
  // 重绘整体替换 #content：正在输入的控件会丢焦点与光标（表现：打一个字就跳出去）。
  // 先记下 activeElement 的 id 与选区，贴完新骨架再放回去。
  const act = document.activeElement;
  const actId = act && act.id ? act.id : null;
  const actSel = actId && typeof act.selectionStart === 'number' ? [act.selectionStart, act.selectionEnd] : null;
  // 对话草稿：Pages.chat() 每次都会把 #chatinput 重建，先把现值记到 State 再贴回去
  // （否则点一下审批 / 切一下页面，刚写一半的指令就没了）
  const draftEl = document.getElementById('chatinput');
  if (r.id === 'chat' && draftEl && typeof draftEl.value === 'string') State.chatDraft = draftEl.value;
  parkOwned();                             // 把"加载器直接写 DOM"的区域整块摘下来（见 paintDirect）
  // 计时只包住 innerHTML：这才是"页面重不重"的成本，加载器耗时另有 TTL 与 stampText 体现
  const _t0 = nowMs();
  contentEl.innerHTML = page();
  recordPerf(r.id, nowMs() - _t0, contentEl, !!(opts && opts.paintOnly));
  paintDirect(r);                          // 再贴回原位：内容不丢，流式引用不断
  if (actId) {
    const na = document.getElementById(actId);
    if (na && typeof na.focus === 'function') {
      try { na.focus(); if (actSel && typeof na.setSelectionRange === 'function') na.setSelectionRange(actSel[0], actSel[1]); } catch (e) { /* 焦点/选区恢复失败不影响渲染 */ }
    }
  }
  // 对话页要"卡片顶到窗口底部"：去掉 .content 的 60px 底部内边距，
  // 否则卡片下方会空出一条，还会多出一条无谓的纵向滚动条。
  contentEl.classList.toggle('chat-fill', r.id === 'chat');
  // 先铺页面骨架、再让数据加载器往里填；加载完成后自动重绘一次。
  // refreshed 标记防止"加载→重绘→再加载"的无限递归。
  // 之前所有加载器都被无参调用，既没有重绘、也不被 await，
  // 于是依赖按需取数的页面会永远停在"读取中"——这就是页面点开空白的原因。
  // paintOnly：**只重绘、不重跑加载器**。给"点击后只改客户端状态"的交互用
  //   （排序/翻页/轮次筛选/查看全部会话/按名查询凭据…）。
  //   否则交互刚改好的状态会被随后的加载器重建/覆盖 —— 表现就是"按钮点不动"。
  const paintOnly = !!(opts && opts.paintOnly);
  const jobs = [];
  if (!paintOnly) {
  if (r.id === 'plugins') { loadPluginInventory(); loadDynamicPlugins(); }   // 表格行由 paintDirect() 里的 renderPlugins() 填
  if (r.id === 'subagents') jobs.push(loadSubagents());
  if (r.id === 'home' || r.id === 'sessions') jobs.push(refreshSessionsLite());
  if (r.id === 'home') jobs.push(refreshGoal());
  if (r.id === 'chat') { jobs.push(loadChatHistory()); jobs.push(loadCommands()); jobs.push(loadFeedback()); }
  if (r.id === 'host') jobs.push(refreshSystem());
  if (r.id === 'workspace') { jobs.push(loadWorkspaces()); jobs.push(loadWorkspaceFiles()); }
  if (r.id === 'settings') { jobs.push(loadSettings()); jobs.push(loadCredentials()); }   // 表单里 credential-ref 字段要用凭据名做候选
  if (r.id === 'credentials') { jobs.push(loadProviders()); jobs.push(loadCredentials()); }   // 凭据页要拿供应商 ↔ 期望凭据做对照
  if (r.id === 'models') { jobs.push(loadProviders()); jobs.push(loadModelCatalog()); jobs.push(loadSettings()); }   // 目录/候选/静态清单三处都要
  if (r.id === 'goal') jobs.push(refreshGoal());
  if (r.id === 'agentMgr') jobs.push(loadPresets());   // 智能体预设清单（TTL 10s；复制/删除后走 loadPresets(true) 强制刷新）
  if (r.id === 'trajectory') jobs.push(loadTrajectory());
  if (r.id === 'deliverables') jobs.push(loadDeliverables());
  if (r.id === 'workflow') jobs.push(loadWorkflowRuns());
  }   // ← paintOnly 时跳过上面整段加载器
  if (jobs.length && !(opts && opts.refreshed)) {
    // 兜底超时：任何一个加载器卡住也不能让页面停在半渲染状态（面包屑/作用域条都还没铺）
    const done = await Promise.race([
      Promise.all(jobs.map(p => Promise.resolve(p).then(v => v !== false, () => true))),
      new Promise(res => setTimeout(res, 15000)).then(() => null),
    ]);
    // 第二遍只重绘、不再跑加载器（加载器刚写好的 #chatlog / #dynplugins 等由 render()
    // 开头的 parkOwned() + paintDirect() 整块搬过去）——但**只有**当有 loader 真取了数
    // （返回 !==false）才有必要再画一遍；命中 TTL 缓存的切页直接跳过，省一次全量 innerHTML。
    if (done === null || done.some(Boolean)) return render({ refreshed: true });
  }
  // 引用是"会话内上下文"：切换会话时清空，避免把上一个会话的引用带过去
  if (State._refSession !== State.sessionId) { State._refSession = State.sessionId; State.references = []; }
  renderRefChips();
  renderAttachPreview();   // 已选附件也在 State 里：重绘后要把标签贴回来（不然"看不见但还会发出去"）
  const cpEl = document.getElementById('chatplan'); if (cpEl) cpEl.textContent = planBadgeText();
  renderChatAside();
  renderChatQuestions();   // 提问区跟侧栏同策略：每次重绘后按 State.questions 重贴（作答/切页后状态不丢）
  renderScopeBar(r);
  document.title = r.label + ' · 易智瑞西安·时空智能应用工作台';
}


/* ---------- 会话级反馈（sessionFeedback/record）---------
   与「消息反馈」（messageFeedback，按 messageId 赞/踩）不同：这是**整条会话**的一句备注，
   只往会话日志追加一条 log-only 事件，不触发任何模型动作（原生 `/feedback` 命令走的就是它）。 */
async function recordSessionFeedback() {
  if (!State.sessionId) return;
  const CATS = [
    ['', '（不分类）'], ['task-result', '任务结果'], ['instruction-following', '指令遵循'],
    ['product-interaction', '产品交互'], ['service-stability', '服务稳定性'], ['resource-cost', '资源消耗'],
    ['security-privacy-permission', '安全 / 隐私 / 权限'], ['other', '其他'],
  ];
  const text = await UI.prompt({
    title: '会话级反馈', multiline: true, okText: '下一步', value: '',
    placeholder: '这条会话哪里好、哪里不好？留空也可以（等于"请复核这条会话"）',
    hint: '写入会话日志（<code>feedback/record</code>），<b>不会</b>触发模型动作；与单条消息的 👍/👎 是两套东西。',
  });
  if (text === null) return;
  const list = CATS.map((c, i) => (i + 1) + ') ' + c[1]).join('\n');
  const pick = await UI.prompt({
    title: '反馈分类', multiline: false, value: '1', okText: '记录',
    hint: '可选分类：<pre class="mono" style="font-size:11px">' + fmt.esc(list) + '</pre>',
    validate: (v) => (Number(v) >= 1 && Number(v) <= CATS.length) ? null : '请输入 1–' + CATS.length,
  });
  if (pick === null) return;
  const cat = (CATS[Number(pick) - 1] || CATS[0])[0];
  try {
    // ⚠️ 这个端点的返回值是**联合类型**：失败时不会抛错，而是返回 { ok:false, error:{code,…} }
    //    （实测：sessionFeedback/record 用不存在的 sessionId 会拿到 ok:false + session-not-found）
    const r = await API.post('sessionFeedback/record', { request: {
      sessionId: State.sessionId, ...(text ? { text } : {}), ...(cat ? { category: cat } : {}),
    } });
    if (r && r.ok === false) throw new Error((r.error && (r.error.message || r.error.code)) || '被拒绝');
    if (r && r.recorded === false) throw new Error('DSH 没有确认记录');
    UI.ok('已记录到会话日志（log-only，不触发模型动作）');
  } catch (e) { UI.err('记录失败：' + e.message); }
}

/* ---------- 发送消息（含附件） ---------- */
async function sendChat(ev){
  const inp = document.getElementById('chatinput');
  if (!inp) return;
  const text = inp.value.trim();
  const img = State.pendingImage;
  const pf = State.pendingFile;
  if ((!text && !img && !pf) || !State.sessionId) return;
  // 引用已经以原生可见文本 @path 的形式写在草稿里，随文本一起送达
  // 图片本地就能画：先用内联 base64 显示（宿主回显时会带 durable 引用，见 Chat.remoteUser）
  Chat.localUser(text + (img ? '\n[📎 ' + img.name + ']' : '') + (pf ? '\n[📁 ' + pf.name + ']' : ''),
    mediaHtml(State.sessionId, img ? [{ type: 'image', mediaType: img.mediaType, data: img.data, name: img.name }] : []));
  inp.value = '';
  State.chatDraft = '';       // 已送出：别让下一个重绘把这句话又贴回输入框
  closeMenus();
  renderRefChips();
  const btn = document.getElementById('chatsend');
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="loading"></span>'; }
  try {
    const content = [];
    if (text) content.push({ type: 'text', text });
    if (img) content.push({ type: 'image', mediaType: img.mediaType, data: img.data, name: img.name });
    if (pf) {
      // 非图片文件：先上传换 receiptId（fileUploads/upload），再作为 file 块随消息发送
      Chat.status('上传 ' + pf.name + '…');
      const up = await API.post('fileUploads/upload', { agentId: State.sessionId, request: { data: pf.data, name: pf.name } });
      if (!up || !up.receiptId) throw new Error('上传没有返回 receiptId');
      content.push({ type: 'file', receiptId: up.receiptId });
      Chat.status(null);
    }
    await API.call('session.prompt', { sessionId: State.sessionId, mode: 'queue', content });
    clearImage(); clearFile();
  } catch (e) {
    Chat.status(null);
    Chat.bubble('assistant', '<span class="tag err">发送失败</span> ' + fmt.esc(e.message));
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '发送'; }
  }
}

/* ============ 通用表格：排序 + 分页 ============ */
const Table = {
  /** 当前排序状态：{ tableId: { key, dir } } */
  sort: {},
  /** 当前分页状态：{ tableId: page } */
  page: {},
  PAGE_SIZE: 30,

  /** 生成可排序表头 */
  th(tableId, key, label, align) {
    const s = this.sort[tableId] || {};
    const cls = 'sortable' + (s.key === key ? ' ' + s.dir : '');
    return `<th class="${cls}" style="${align ? 'text-align:' + align : ''}" onclick="Table.toggle('${tableId}','${key}')">${label}</th>`;
  },
  /** 点击表头切换排序 */
  toggle(tableId, key) {
    const s = this.sort[tableId] || {};
    this.sort[tableId] = { key, dir: s.key === key && s.dir === 'asc' ? 'desc' : 'asc' };
    render({ paintOnly: true });   // 纯客户端排序，不必重跑加载器
  },
  /** 对数据排序 */
  apply(tableId, rows, getters) {
    const s = this.sort[tableId];
    if (!s) return rows;
    const get = getters[s.key] || ((r) => r[s.key]);
    return [...rows].sort((a, b) => {
      const va = get(a), vb = get(b);
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      const r = typeof va === 'number' && typeof vb === 'number'
        ? va - vb
        : String(va).localeCompare(String(vb), 'zh-CN');
      return s.dir === 'asc' ? r : -r;
    });
  },
  /** 分页切片 */
  slice(tableId, rows) {
    const total = rows.length;
    if (total <= this.PAGE_SIZE) return { rows, pager: '' };
    const pages = Math.ceil(total / this.PAGE_SIZE);
    const p = Math.min(Math.max(1, this.page[tableId] || 1), pages);
    this.page[tableId] = p;
    const rowsP = rows.slice((p - 1) * this.PAGE_SIZE, p * this.PAGE_SIZE);
    const btn = (n, label, dis) => `<button class="btn sm" ${dis ? 'disabled' : ''} onclick="Table.go('${tableId}',${n})">${label}</button>`;
    const pager = '<div style="display:flex;align-items:center;gap:8px;margin-top:12px;font-size:12px" class="muted">'
      + btn(p - 1, '‹ 上一页', p <= 1)
      + '<span>第 ' + p + ' / ' + pages + ' 页 · 共 ' + total + ' 条</span>'
      + btn(p + 1, '下一页 ›', p >= pages)
      + '</div>';
    return { rows: rowsP, pager };
  },
  go(tableId, page) { this.page[tableId] = page; render({ paintOnly: true }); },
};

/* ============ 数据刷新时间戳 ============ */
const Stamps = {};
function stamp(key) { Stamps[key] = Date.now(); }
/** loader 级 TTL：来回切页不再每次把该页的 RPC 整套重打一遍（这是切页卡的主因之一）。
 *  loaderFresh()：key 在 ms 内取过 且（可选）数据绑定的会话没变 → 跳过；
 *  显式刷新（redraw/force 参数）与数据不存在时永远真取。
 *  配套 stampLoader()：成功取数后记录时间 + 会话绑定；显式切会话时把相关 Stamps 清零强制重取。 */
function loaderFresh(key, ms, sid) {
  const t = Stamps[key];
  if (!t || Date.now() - t > ms) return false;
  if (sid !== undefined && (State._loaderSid || {})[key] !== sid) return false;
  return true;
}
function stampLoader(key, sid) {
  Stamps[key] = Date.now();
  if (sid !== undefined) { State._loaderSid = State._loaderSid || {}; State._loaderSid[key] = sid; }
}
/** 约定：render() 挂的 loader 返回 true=真取了数（需要第二遍重绘）/ false=命中缓存跳过（省一次全量重绘）。 */
function stampText(key) {
  const t = Stamps[key];
  return t ? '<span class="muted" style="font-size:11.5px">数据更新于 ' + new Date(t).toLocaleTimeString('zh-CN', { hour12: false }) + '</span>' : '';
}

/* ============ Ctrl+K 全局跳转 ============ */
function openPalette() {
  if (document.getElementById('palette')) return;
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.id = 'palette';
  mask.innerHTML = `
    <div class="modal" style="width:min(520px,100%);align-self:flex-start;margin-top:12vh">
      <h3 style="padding-bottom:10px">🔍 快速跳转 <span class="muted" style="font-weight:400;font-size:11.5px">Ctrl+K</span></h3>
      <div style="padding:0 20px 14px">
        <input id="palette-input" placeholder="输入页面名称或关键词…" autocomplete="off">
      </div>
      <div class="modal-body" style="padding-top:0;max-height:52vh" id="palette-list"></div>
    </div>`;
  document.body.appendChild(mask);

  const input = mask.querySelector('#palette-input');
  const list = mask.querySelector('#palette-list');
  let idx = 0;

  const filter = () => {
    const kw = input.value.trim().toLowerCase();
    const items = ROUTES.filter(r => !kw
      || r.label.toLowerCase().includes(kw)
      || r.path.toLowerCase().includes(kw)
      || (GROUP_HINT[r.group] || '').toLowerCase().includes(kw));
    idx = 0;
    list.innerHTML = items.length ? items.map((r, i) => `
      <a href="#${r.path}" onclick="document.getElementById('palette').remove()"
         class="palette-item${i === 0 ? ' on' : ''}" data-path="${r.path}"
         style="display:flex;align-items:center;gap:10px;padding:9px 12px;border-radius:8px;text-decoration:none">
        <span style="font-size:17px">${r.ico}</span>
        <span style="flex:1">
          <span style="display:block;font-size:13.5px">${fmt.esc(r.label)}</span>
          <span class="muted" style="font-size:11px">${fmt.esc(r.group)} · ${fmt.esc(GROUP_HINT[r.group] || '')}</span>
        </span>
      </a>`).join('') : '<div class="empty">没有匹配的页面</div>';
  };
  const move = (d) => {
    const els = [...list.querySelectorAll('.palette-item')];
    if (!els.length) return;
    els[idx]?.classList.remove('on');
    idx = (idx + d + els.length) % els.length;
    els[idx].classList.add('on');
    els[idx].scrollIntoView({ block: 'nearest' });
  };
  const close = () => { mask.remove(); document.removeEventListener('keydown', onKey, true); };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const el = list.querySelectorAll('.palette-item')[idx];
      if (el) { location.hash = el.dataset.path; close(); }
    }
  };
  input.addEventListener('input', filter);
  document.addEventListener('keydown', onKey, true);
  mask.onclick = (e) => { if (e.target === mask) close(); };
  filter();
  setTimeout(() => input.focus(), 30);
}

/* ============ Markdown 渲染（轻量实现）============ */
const MD = {
  /** 渲染 Markdown → HTML（先转义，再替换） */
  render(src) {
    if (src == null) return '';
    let s = String(src);
    // 提取代码块（先占位，避免内部被解析）
    const blocks = [];
    s = s.replace(/```([\w+-]*)\n?([\s\S]*?)```/g, (m, lang, code) => {
      blocks.push({ lang, code });
      return '\u0000BLOCK' + (blocks.length - 1) + '\u0000';
    });
    // 转义 HTML
    s = s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    // 行内代码
    s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    // 粗体 / 斜体
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
    s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>');
    // 标题
    s = s.replace(/^######\s+(.+)$/gm, '<div style="font-weight:600;font-size:13px;margin:6px 0">$1</div>');
    s = s.replace(/^#####\s+(.+)$/gm, '<div style="font-weight:600;font-size:13.5px;margin:6px 0">$1</div>');
    s = s.replace(/^####\s+(.+)$/gm, '<div style="font-weight:600;font-size:14px;margin:7px 0">$1</div>');
    s = s.replace(/^###\s+(.+)$/gm, '<div style="font-weight:700;font-size:15px;margin:8px 0">$1</div>');
    s = s.replace(/^##\s+(.+)$/gm, '<div style="font-weight:700;font-size:16px;margin:9px 0">$1</div>');
    s = s.replace(/^#\s+(.+)$/gm, '<div style="font-weight:700;font-size:17px;margin:10px 0">$1</div>');
    // 图片（必须在链接之前 —— 否则会被链接正则吃掉只剩 "!"）
    s = s.replace(/!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g, '<img src="$2" alt="$1" loading="lazy" style="max-width:100%;border-radius:6px;margin:4px 0">');
    // 链接
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" style="color:var(--brand-2)">$1</a>');
    // 删除线
    s = s.replace(/~~([^~\n]+)~~/g, '<s style="color:var(--txt-3)">$1</s>');
    // 任务列表（- [ ] / - [x]），按缩进分层
    s = s.replace(/^([ \t]*)[-*] \[ \] (.+)$/gm, (m, ind, t) => '<div style="padding-left:' + (14 + Math.min(ind.length, 12) * 12) + 'px">☐ ' + t + '</div>');
    s = s.replace(/^([ \t]*)[-*] \[[xX]\] (.+)$/gm, (m, ind, t) => '<div style="padding-left:' + (14 + Math.min(ind.length, 12) * 12) + 'px">✅ ' + t + '</div>');
    // 无序列表（按缩进分层：每 2 空格一级）
    s = s.replace(/^([ \t]*)[-*]\s+(.+)$/gm, (m, ind, t) => {
      const pad = 14 + Math.min(ind.length, 12) * 12;
      return '<div style="padding-left:' + pad + 'px;position:relative"><span style="position:absolute;left:' + (pad - 12) + 'px">•</span>' + t + '</div>';
    });
    // 有序列表（按缩进分层）
    s = s.replace(/^([ \t]*)(\d+)\.\s+(.+)$/gm, (m, ind, n, t) => {
      const pad = 18 + Math.min(ind.length, 12) * 12;
      return '<div style="padding-left:' + pad + 'px;position:relative"><span style="position:absolute;left:' + (pad - 16) + 'px">' + n + '.</span>' + t + '</div>';
    });
    // 分隔线
    s = s.replace(/^---+$/gm, '<hr style="border:none;border-top:1px solid var(--line);margin:8px 0">');
    // 引用
    s = s.replace(/^&gt;\s?(.+)$/gm, '<div style="border-left:3px solid var(--line-2);padding-left:10px;color:var(--txt-2);margin:4px 0">$1</div>');
    /* 表格：把**连续**的 | … | 行合成**一张**表。
       ⚠️ 旧实现是逐行 `<tr>` + 一个非贪婪正则给每一行各包一层 `<table>`：
          `s.replace(/(<tr>[\s\S]*?<\/tr>)(\s*\u0000TBLSEP\u0000)?/g, m => '<table>' + m + '</table>')`
          —— 匹配是**按行**成功的，于是 3 行变成 3 张独立的表，每张各自算列宽、各自左对齐，
          看上去就是"表格错位、列对不齐"（用户报的那个）。现在按整块解析：
          第一行 = 表头 → <thead>，`|:---|:--:|` 分隔行决定每列对齐，其余进 <tbody>。 */
    const splitRow = (line) => {
      // 按未成对反引号外的 `|` 切分（行内代码里可能带 | ），再丢掉首尾空单元
      const out = []; let buf = ''; let code = false;
      for (const ch of line) {
        if (ch === '`') code = !code;
        if (ch === '|' && !code) { out.push(buf); buf = ''; continue; }
        buf += ch;
      }
      out.push(buf);
      if (out.length && out[0].trim() === '') out.shift();
      if (out.length && out[out.length - 1].trim() === '') out.pop();
      return out.map(c => c.trim());
    };
    const isRow = (l) => /^\s*\|.*\|\s*$/.test(l);
    const isSep = (cells) => cells.length > 0 && cells.every(c => /^:?-{1,}:?$/.test(c));
    const tableHtml = (block) => {
      const rows = block.map(splitRow);
      let head = null, align = [], body = rows;
      if (rows.length >= 2 && isSep(rows[1])) {
        head = rows[0];
        align = rows[1].map(c => (c.startsWith(':') && c.endsWith(':')) ? 'center' : c.endsWith(':') ? 'right' : 'left');
        body = rows.slice(2);
      } else {
        align = (rows[0] || []).map(() => 'left');
      }
      const cell = (tag, c, i) => '<' + tag + ' style="text-align:' + (align[i] || 'left') + '">' + c + '</' + tag + '>';
      const tr = (cells, tag) => '<tr>' + cells.map((c, i) => cell(tag, c, i)).join('') + '</tr>';
      return '<div class="md-table-wrap"><table class="md-table">'
        + (head ? '<thead>' + tr(head, 'th') + '</thead>' : '')
        + '<tbody>' + body.map(r => tr(r, 'td')).join('') + '</tbody>'
        + '</table></div>';
    };
    {
      const lines = s.split('\n');
      const outLines = [];
      for (let i = 0; i < lines.length; i++) {
        if (!isRow(lines[i])) { outLines.push(lines[i]); continue; }
        const block = [];
        while (i < lines.length && isRow(lines[i])) { block.push(lines[i]); i++; }
        i--;                                  // 上面的 while 多走了一行，退回去
        outLines.push(tableHtml(block));
      }
      s = outLines.join('\n');
    }
    // 还原代码块
    s = s.replace(/\u0000BLOCK(\d+)\u0000/g, (m, i) => {
      const b = blocks[Number(i)];
      return '<div style="margin:8px 0"><div class="muted" style="font-size:10.5px;margin-bottom:3px">' + fmt.esc(b.lang || 'code') + '</div>'
        + '<pre class="mono" style="font-size:11.5px;background:#0b1428;border:1px solid var(--line);border-radius:6px;padding:9px 11px;overflow:auto;max-height:320px;margin:0">'
        + fmt.esc(b.code.replace(/\n$/, '')) + '</pre></div>';
    });
    // 段落换行
    return s.replace(/\n{2,}/g, '<div style="height:7px"></div>');
  },
  /** 纯文本摘要（用于列表/预览） */
  plain(src, max = 120) {
    const s = String(src || '').replace(/```[\s\S]*?```/g, '[代码]').replace(/[#*_`>|-]/g, '').replace(/\s+/g, ' ').trim();
    return s.length > max ? s.slice(0, max) + '…' : s;
  },
};

/* ============ 工具调用行 ============
 * 原版 DSH 的工具行**不是**"一个泛用卡片 + 宿主视图"，而是按工具名分成若干 variant，
 * 每型自带标题、摘要来源、状态徽标与正文形态（见 @deepseek-ai/dsh-client-ui-tool 的
 * TOOL_VARIANTS / VARIANT_TITLE_KEYS / TOOL_TITLE_KEYS / SUMMARY_KEYS）。下面是照抄的对照表。
 *
 * 两个必须写下来的实测结论（推翻了此前的实现假设）：
 *   ① `session/follow` 快照的 452 条记录**只有 type 与 event 两个键，没有 view**；
 *      实时帧里同样搜不到 "view"。所以原先那套 `view.kind` / `view.title` 分支永远走不到，
 *      工具行只能在这里按「工具名 + arguments + 结果 + result.meta」自己算出来。
 *   ② `tool/result` 带 **meta**，是与卡片正文一一对应的结构化视图数据（此前被整个丢掉）：
 *        read   → { path, offset, lines:[{number,text}], totalLines, lang }
 *        glob   → { shape:'paths', paths:[…], truncated, total }
 *        grep   → { shape:'matches', files:[{ path, matches:[{lineNumber,line}] }], truncated, total }
 *        write/edit → { diffs:[{ path, oldText, newText }] }
 *      有 meta 就用 meta（权威），没有才退回解析结果文本。
 */
const ToolCard = {
  /* 工具名 → variant（原版 TOOL_VARIANTS） */
  VARIANTS: {
    bash: 'bash', pwsh: 'bash',
    read: 'read', read_image: 'read', web_fetch: 'read',
    web_search: 'search', grep: 'search', glob: 'search',
    write: 'write', edit: 'edit',
    run_code: 'code',
    cordis_package_inspect: 'read', cordis_runtime_inspect: 'read',
    cordis_run: 'others', cordis_stop: 'others', cordis_undefine: 'others',
  },
  /* variant → 标题（原版 VARIANT_TITLE_KEYS，中文取自 conversation 的 tool.title.*） */
  VARIANT_TITLE: { search: '搜索', read: '读取', bash: 'Bash', write: '写入', edit: '编辑', code: '代码', others: '工具调用' },
  /* 具体工具名细化标题（原版 TOOL_TITLE_KEYS） */
  TOOL_TITLE: {
    pwsh: 'Pwsh', read_image: '读取图片',
    cordis_package_inspect: '查看', cordis_runtime_inspect: '查看',
    cordis_run: '运行 Cordis 插件', cordis_stop: '停止 Cordis 插件', cordis_undefine: '移除 Cordis 插件',
  },
  /* grep/glob 在 search variant 之上再细化（原版 SEARCH_TITLE_KEYS） */
  SEARCH_TITLE: { grep: 'Grep', glob: 'Glob' },
  WEB_TITLE: { web_search: '网页搜索', web_fetch: '网页获取' },
  /* variant → 摘要取哪个参数（原版 SUMMARY_KEYS） */
  SUMMARY_KEYS: {
    bash: ['description', 'command'],
    read: ['path', 'file_path', 'url'],
    search: ['query', 'pattern', 'url'],
    write: ['path', 'file_path'],
    edit: ['path', 'file_path'],
    code: ['description'],
    others: [],
  },
  /* 子代理/任务类工具：不计入"工具调用"计数，单列"个 subagent"（原版 isSubagentDelegationTool） */
  SUBAGENT_TOOLS: ['subagent', 'subagent_fork', 'task', 'dispatch_agent'],
  /* 专项卡片：这些工具名有专属外观，不走 variant 通用行 */
  SPECIAL: ['present', 'todo_write', 'todowrite', 'ask_user_question', 'workflow',
    'create_goal', 'get_goal', 'update_goal', 'job_list', 'job_output', 'list_agents'],
  /* 原版对这几类也是"工具调用"+裸 JSON 摘要 —— 裸 JSON 看不出干了什么，这里给个人话标题与摘要。
   * 外观仍是同一张通用行（不改结构，只改文字），所以与原版依然一致。 */
  SPECIAL_TITLE: { present: '交付文件', workflow: '工作流', create_goal: '目标', get_goal: '目标', update_goal: '目标' },
  SPECIAL_SUMMARY: {
    present: a => (Array.isArray(a.files) ? a.files.length + ' 个文件' + (a.files[0] && a.files[0].path ? ' · ' + a.files[0].path.split(/[\\/]/).pop() : '') : ''),
    workflow: a => (a.meta && a.meta.name) ? a.meta.name : '',
    create_goal: a => (typeof a.objective === 'string' ? a.objective.slice(0, 60) : ''),
    get_goal: a => (typeof a.goal_id === 'string' ? a.goal_id.slice(0, 24) : ''),
    update_goal: a => (a.action ? a.action + ' · ' : '') + (typeof a.goal_id === 'string' ? a.goal_id.slice(0, 24) : ''),
  },

  classify(name) { return this.VARIANTS[name] || 'others'; },
  isSubagent(name) { return this.SUBAGENT_TOOLS.includes(name); },
  /* 行首图标（原生是 16px 的 SVG，悬停时换成 chevron）。这里用同语义的字形，
     免得为一个图标引入图标字体 —— 关键是把"这是哪类工具"在一行里先立住。 */
  ICON: {
    bash: '❯', read: '▤', search: '⌕', write: '✚', edit: '✎', code: '{ }', others: '◇',
    present: '⤓', workflow: '⚙', goal: '◎', todo: '☑', question: '?', job: '⧗',
  },
  iconOf(name, variant) {
    if (name === 'present') return this.ICON.present;
    if (name === 'workflow') return this.ICON.workflow;
    if (/goal/.test(name)) return this.ICON.goal;
    if (/^todo/.test(name)) return this.ICON.todo;
    if (/question/.test(name)) return this.ICON.question;
    if (/^job_/.test(name)) return this.ICON.job;
    return this.ICON[variant] || this.ICON.others;
  },
  titleOf(name) {
    if (this.SPECIAL_TITLE[name]) return this.SPECIAL_TITLE[name];
    if (this.TOOL_TITLE[name]) return this.TOOL_TITLE[name];
    if (this.SEARCH_TITLE[name]) return this.SEARCH_TITLE[name];
    if (this.WEB_TITLE[name]) return this.WEB_TITLE[name];
    return this.VARIANT_TITLE[this.classify(name)] || '工具调用';
  },
  /** arguments 是 JSON **字符串**（不是对象）—— 实测确认，这里统一解析并容错 */
  parseArgs(raw) {
    if (raw && typeof raw === 'object') return raw;
    try { const v = JSON.parse(String(raw == null ? '' : raw)); return (v && typeof v === 'object') ? v : {}; }
    catch { return { __raw: String(raw == null ? '' : raw) }; }
  },
  /** 摘要：先看专项表（人话），再按原版 SUMMARY_KEYS 取参数（原版 deriveSummary），取首行 */
  summaryOf(variant, args, rawArgs, name) {
    const sp = this.SPECIAL_SUMMARY[name];
    if (sp) { const s = sp(args); if (s) return String(s).split('\n')[0]; }
    for (const k of (this.SUMMARY_KEYS[variant] || [])) {
      const v = args[k];
      if (typeof v === 'string' && v !== '') return String(v).split('\n')[0];
    }
    for (const v of Object.values(args)) if (typeof v === 'string' && v !== '') return v.split('\n')[0];
    return String(rawArgs == null ? '' : rawArgs).split('\n')[0];
  },
  /** 工作区相对化（原版 relativizeToCwd）：有 cwd 就剥掉前缀，让路径短到能一眼看完 */
  shorten(p) {
    const s = String(p || '');
    const cwd = cwdOf(State.sessionId);
    if (cwd && s.startsWith(cwd)) {
      const rel = s.slice(cwd.length).replace(/^[\\/]+/, '');
      return '~/' + rel.replace(/\\/g, '/');
    }
    return s.replace(/\\/g, '/');
  },
  /** 结果里指向文件时剥掉 <path>/<type>/<content> 信封（原版没有这层，是本项目收到的形状） */
  unwrapFile(text) {
    const t = String(text || '');
    const p = /<path>([\s\S]*?)<\/path>/.exec(t);
    const c = /<content>\n?([\s\S]*?)\n?<\/content>/.exec(t);
    if (!p && !c) return null;
    return { path: p ? p[1].trim() : '', content: c ? c[1] : '' };
  },
  /** 从工具结果块里抽文本（MCP 返回块） */
  textOf(content) {
    if (!Array.isArray(content)) return '';
    return content.filter(c => c.type === 'text').map(c => c.text).join('\n');
  },

  /* ---------- 归一化：把 (name, args, result, meta, state) 变成一张可渲染的模型 ---------- */
  model(o) {
    const name = o.name || '';
    const variant = this.classify(name);
    const args = this.parseArgs(o.args);
    const rawArgs = (typeof o.args === 'string') ? o.args : JSON.stringify(o.args || {});
    const state = o.state || (o.isError ? 'error' : (o.done ? 'ok' : 'running'));
    const text = String(o.result == null ? '' : o.result);
    const meta = (o.meta && typeof o.meta === 'object') ? o.meta : null;
    const m = {
      name, variant, state, meta,
      title: this.titleOf(name),
      summary: this.summaryOf(variant, args, rawArgs, name),
      path: '',
      badges: [],        // 头部右侧的量化徽标
      body: null,        // 正文（HTML）
      sections: [],      // 输入 / 输出 / 附件
      args, rawArgs, text,
    };

    /* —— 路径与徽标 —— */
    if (variant === 'read' || variant === 'write' || variant === 'edit') {
      const p = args.file_path || args.path || args.url || '';
      if (p) { m.path = this.shorten(p); m.summary = m.path; }
    }
    /* read：行窗口来自 meta（权威），退回解析 "N: " 前缀 */
    if (variant === 'read' && !m.badges.length) {
      if (meta && Array.isArray(meta.lines) && meta.lines.length) {
        const total = Number(meta.totalLines) || meta.lines.length;
        m.badges.push('显示 ' + meta.lines.length + ' / ' + total + ' 行');
        m.body = meta.lines.map(l => '<div class="tr-line"><span class="tr-ln">' + fmt.esc(String(l.number)) + '</span>'
          + '<span class="tr-lt">' + fmt.esc(String(l.text == null ? '' : l.text)) + '</span></div>').join('');
        m.readWindow = true;
        if (meta.lang) m.badges.push(String(meta.lang));
      } else {
        const file = this.unwrapFile(text);
        const raw = file ? file.content : text;
        const lines = raw.split('\n').filter(l => l !== '');
        const nums = lines.map(l => Number((/^(\d+):/.exec(l) || [])[1])).filter(Number.isFinite);
        const total = nums.length ? Math.max(...nums) : lines.length;
        if (lines.length) m.badges.push('显示 ' + lines.length + ' / ' + total + ' 行');
        m.body = lines.map(l => {
          const mm = /^(\d+):(.*)$/.exec(l);
          return '<div class="tr-line"><span class="tr-ln">' + fmt.esc(mm ? mm[1] : '') + '</span>'
            + '<span class="tr-lt">' + fmt.esc(mm ? mm[2].replace(/^ /, '') : l) + '</span></div>';
        }).join('');
        m.readWindow = true;
      }
    }
    /* glob：meta.paths → "N 个路径" */
    if (name === 'glob' || (meta && meta.shape === 'paths')) {
      const paths = (meta && Array.isArray(meta.paths)) ? meta.paths : String(text).split('\n').filter(Boolean);
      m.badges.push(paths.length + ' 个路径' + (meta && meta.truncated ? '（已截断）' : ''));
      m.body = paths.map(p => '<div class="tr-line tr-p"><span class="tr-lt mono">' + fmt.esc(this.shorten(p)) + '</span></div>').join('');
      m.searchList = true;
    } else if (meta && meta.shape === 'matches') {
      /* grep：meta.files → "N 处匹配 · M 个文件" */
      const files = Array.isArray(meta.files) ? meta.files : [];
      const total = Number(meta.total) || files.reduce((n, f) => n + (f.matches || []).length, 0);
      m.badges.push(total + ' 处匹配 · ' + files.length + ' 个文件' + (meta.truncated ? '（已截断）' : ''));
      m.body = files.length ? files.map(f => '<div class="tr-file"><div class="tr-fp mono">' + fmt.esc(this.shorten(f.path)) + '</div>'
        + (f.matches || []).map(x => '<div class="tr-line"><span class="tr-ln">' + fmt.esc(String(x.lineNumber)) + '</span>'
          + '<span class="tr-lt mono">' + fmt.esc(String(x.line)) + '</span></div>').join('') + '</div>').join('')
        : '<div class="tr-empty">无结果</div>';
      m.searchList = true;
    }
    /* edit / write：diff。优先 meta.diffs（权威），否则用 old_string/new_string 自己算 */
    if (variant === 'edit' || variant === 'write') {
      let hunks = (meta && Array.isArray(meta.diffs) && meta.diffs.length) ? meta.diffs : null;
      if (!hunks) {
        if (variant === 'edit' && (args.old_string != null || args.new_string != null)) {
          hunks = [{ path: args.file_path || args.path || '', oldText: args.old_string == null ? null : args.old_string, newText: String(args.new_string == null ? '' : args.new_string) }];
        } else if (variant === 'write' && typeof args.content === 'string') {
          hunks = [{ path: args.file_path || args.path || '', oldText: null, newText: args.content }];
        }
      }
      if (hunks) {
        const tot = this.diffTotals(hunks);
        m.badges.push('+' + tot.added + ' −' + tot.removed);
        m.body = hunks.map(h => this.diffHtml(h)).join('');
        m.diffBody = true;
      } else if (state === 'error') {
        m.body = '<pre class="tr-pre mono">' + fmt.esc(text.slice(0, 4000)) + '</pre>';
        m.diffBody = true;
      }
      /* 工具还没回结果时，edit 也先把"打算怎么改"画出来（原版 running 态同样给 intended diff） */
      if (!m.body && state === 'running') {
        const it = (variant === 'edit')
          ? [{ path: args.file_path || '', oldText: args.old_string ?? null, newText: String(args.new_string ?? '') }]
          : [{ path: args.file_path || '', oldText: null, newText: String(args.content ?? '') }];
        m.body = it.map(h => this.diffHtml(h)).join('');
        m.badges.push('待写入');
        m.diffBody = true;
      }
      /* write 的正文很长时，折叠到 diff 里已经包含了（newText 就是全文），不再重复贴一遍 */
      if (variant === 'write' && !m.body && typeof args.content === 'string') {
        m.body = '<pre class="tr-pre mono">' + fmt.esc(args.content.slice(0, 4000)) + '</pre>';
      }
    }
    /* bash / code：终端输出。命令本身必须可见 —— 摘要按原版取 description（人话），
     * 真正跑了什么要单给一行，否则只能看到"Run test script"却不知道命令是啥。 */
    if (variant === 'bash' || variant === 'code') {
      const empty = !text.trim();
      const err = /^\[stderr\]/m.test(text);
      if (state === 'running') m.badges.push('运行中');
      else if (state === 'error') m.badges.push('失败');
      else if (empty) m.badges.push('无输出');       // 正常完成不再重复给"已完成"：右侧状态徽标已经是「完成」
      if (err) m.badges.push('有 stderr');
      if (args.run_in_background) m.badges.push('后台');
      m.terminal = true;
      if (args.workdir) m.where = this.shorten(args.workdir);
      if (!empty) m.body = '<pre class="tr-pre mono">' + fmt.esc(text.slice(0, 8000)) + '</pre>';
      const cmd = typeof args.command === 'string' ? args.command : (typeof args.code === 'string' && variant === 'code' ? null : null);
      if (cmd && cmd !== m.summary) m.cmd = cmd;
    }

    /* —— 输入 / 输出分区（原版 row.input / row.output） —— */
    if (!m.body && !m.readWindow && !m.searchList) {
      const body = (variant === 'code' && typeof args.code === 'string')
        ? args.code : (rawArgs ? JSON.stringify(args, null, 2) : '');
      if (body && body !== '{}') m.sections.push({ t: '输入', html: '<pre class="tr-pre mono">' + fmt.esc(body.slice(0, 4000)) + '</pre>' });
      if (text.trim()) m.sections.push({ t: '输出', html: '<pre class="tr-pre mono">' + fmt.esc(text.slice(0, 6000)) + '</pre>' });
    } else {
      /* 有专门正文时，原始参数退到"输入"里，仍然可查（不丢信息）。
       * 终端行例外：命令已经单列一行（m.cmd），再贴一遍 JSON 就是噪音。 */
      if (rawArgs && rawArgs !== '{}' && rawArgs !== '' && !(m.terminal && m.cmd)) {
        m.sections.push({ t: '输入', html: '<pre class="tr-pre mono">' + fmt.esc(rawArgs.slice(0, 3000)) + '</pre>' });
      }
      if (m.terminal && !m.body) m.sections.push({ t: '输出', html: '<div class="tr-empty">无输出</div>' });
    }
    if (o.media) m.media = o.media;
    return m;
  },
  /** diff 行统计：oldText 的行数算删除，newText 的行数算新增（原版 diffTotals） */
  diffTotals(hunks) {
    let added = 0, removed = 0;
    for (const h of hunks || []) {
      if (h.oldText) removed += String(h.oldText).split('\n').length;
      if (h.newText) added += String(h.newText).split('\n').length;
    }
    return { added, removed };
  },
  /** 一个 hunk 的 diff 视图：old 行标红删除、new 行标绿新增；超过 12 行折叠并提示“其余 N 行” */
  diffHtml(h) {
    const CAP = 12;
    const oldLines = h.oldText == null ? [] : String(h.oldText).split('\n');
    const newLines = String(h.newText == null ? '' : h.newText).split('\n');
    const rows = [];
    oldLines.forEach(l => rows.push({ t: 'del', s: l }));
    newLines.forEach(l => rows.push({ t: 'add', s: l }));
    const head = h.path ? '<div class="tr-fp mono">' + fmt.esc(this.shorten(h.path)) + '</div>' : '';
    const shown = rows.slice(0, CAP);
    const rest = rows.length - shown.length;
    return '<div class="tr-file">' + head + shown.map(r =>
      '<div class="tr-dline ' + r.t + '"><span class="tr-dsign">' + (r.t === 'add' ? '+' : '−') + '</span>'
      + '<span class="tr-lt mono">' + fmt.esc(r.s) + '</span></div>').join('')
      + (rest > 0 ? '<div class="tr-rest">… 其余 ' + rest + ' 行</div>' : '') + '</div>';
  },
  /** 状态徽标（原版 row.running / row.failed / row.stopped） */
  stateBadge(state) {
    if (state === 'running') return '<span class="loading"></span>';
    if (state === 'error') return '<span class="tag err">失败</span>';
    if (state === 'stopped') return '<span class="tag gray">已停止</span>';
    return '<span class="tag ok">完成</span>';
  },
  /** 渲染一张工具行。参数是一个对象，避免六七个别名不清的位置参数（旧签名已无调用方）。 */
  html(o) {
    const m = this.model(o || {});
    const openAttr = o && o.open ? ' data-open="1"' : '';
    const headArg = fmt.attr(m.name);
    const parts = [];
    parts.push('<div class="toolrow" data-state="' + m.state + '" data-variant="' + fmt.esc(m.variant) + '" data-tool="' + fmt.esc(m.name) + '"' + openAttr + '>');
    parts.push('<button type="button" class="tr-head" onclick="toggleToolRow(this)" aria-expanded="' + (openAttr ? 'true' : 'false') + '">'
      // 行首图标：常态显示"哪类工具"，悬停换成展开箭头（对齐原生 _iconIdle / _chevronHover 的切换）
      + '<span class="tr-lead" aria-hidden="true">'
      + '<span class="tr-ico">' + fmt.esc(this.iconOf(m.name, m.variant)) + '</span>'
      + '<span class="tr-chev">▸</span></span>'
      + '<span class="tr-title">' + fmt.esc(m.title) + '</span>'
      + '<span class="tr-sep" aria-hidden="true">·</span>'
      + '<span class="tr-sum mono" title="' + fmt.esc(m.summary) + '">' + fmt.esc(m.summary.slice(0, 160)) + '</span>'
      + m.badges.map(b => '<span class="tr-badge">' + fmt.esc(b) + '</span>').join('')
      + '<span class="tr-state">' + this.stateBadge(m.state) + '</span></button>');
    const body = [];
    if (m.where) body.push('<div class="tr-where mono">' + fmt.esc(m.where) + '</div>');
    if (m.cmd) body.push('<div class="tr-cmd mono">' + fmt.esc(m.cmd.slice(0, 2000)) + '</div>');
    if (m.body) body.push(m.body);
    m.sections.forEach(s => body.push('<div class="tr-sec"><span class="tr-sec-t">' + fmt.esc(s.t) + '</span>' + s.html + '</div>'));
    if (m.media) body.push('<div class="tr-sec"><span class="tr-sec-t">附件</span>' + m.media + '</div>');
    parts.push('<div class="tr-body"' + (openAttr ? '' : ' hidden') + '>' + body.join('') + '</div>');
    parts.push('</div>');
    return parts.join('');
  },
};
/** 展开/收起一张工具行（就地翻，不重绘） */
function toggleToolRow(btn) {
  const row = btn && btn.closest ? btn.closest('.toolrow') : null;
  if (!row) return;
  const open = !row.hasAttribute('data-open');
  if (open) row.setAttribute('data-open', '1'); else row.removeAttribute('data-open');
  if (btn.setAttribute) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  const b = row.querySelector ? row.querySelector('.tr-body') : null;
  if (b) { if (open) b.removeAttribute('hidden'); else b.setAttribute('hidden', ''); }
}

/* ---------- 轨迹数据 ---------- */
/**
 * 轨迹数据：DSH 没有轨迹专用 RPC，原生 GUI 也是自己把会话事件折叠成节点，
 * 这里同样只按会话事件重建。节点类型沿用原生的记录层词汇：
 *   system | user | context | compacted | message | tool | subtool
 *
 * 折叠逻辑抽成 foldTrajectoryEvent()，因为「加载更早」（session/page 向后翻页）
 * 要用同一套规则，只是把结果**前插**到已有时间线。
 */
const TRAJ_PAGE = 200;      // 每次向后翻多少条消息
const TRAJ_MAX = 2000;      // 时间线最多保留多少个节点（防止无限翻页吃内存）

/** 一次折叠的累计状态（统计 + 当前轮次游标） */
function trajState(seedTurn) {
  return { toolCalls: 0, toolErrors: 0, dispatches: 0, compactions: 0, userMsgs: 0, assistants: 0,
           maxTurn: 0, maxStep: 0, curTurn: seedTurn ?? null };
}

/** 把一条会话事件折叠成一个轨迹节点；返回 null 表示该事件不进时间线 */
function foldTrajectoryEvent(x, st) {
  const e = x.event || {}; const d = e.data || {};
  if (d.turn) st.maxTurn = Math.max(st.maxTurn, d.turn);
  if (d.step) st.maxStep = Math.max(st.maxStep, d.step);
  if (e.type === 'turn/start') st.curTurn = d.turn;      // 之后的事件都归到这一轮（供「按轮筛选」用）
  const base = { seq: e.seq, time: e.time, turn: st.curTurn };
  // 有宿主视图时用视图标题，信息量比原始 arguments 大得多
  const vw = x.view && x.view.view;
  switch (e.type) {
    case 'turn/start': return { ...base, kind: 'system', tag: 'ok', title: '第 ' + d.turn + ' 轮开始' };
    case 'turn/end':   return { ...base, kind: 'system', tag: 'gray', title: '第 ' + d.turn + ' 轮结束' + (d.reason ? '（' + (d.reason.kind || '') + '）' : '') };
    case 'step/start': return { ...base, kind: 'system', tag: 'gray', title: '轮 ' + d.turn + ' 步 ' + d.step + ' 开始' };
    case 'step/end':   return { ...base, kind: 'system', tag: 'gray', title: '轮 ' + d.turn + ' 步 ' + d.step + ' 结束' };
    case 'request/header': return { ...base, kind: 'context', tag: 'gray', title: '请求头（provider ' + ((d.provider) || '?') + ' / model ' + ((d.model) || '?') + '）' };
    case 'compaction/start': return { ...base, kind: 'compacted', tag: 'warn', title: '开始压缩历史' };
    case 'compaction/summary': st.compactions++; return { ...base, kind: 'compacted', tag: 'warn', title: '压缩摘要已生成' };
    case 'compaction/end': return { ...base, kind: 'compacted', tag: 'warn', title: '压缩结束' };
    case 'user/message': {
      const txt = (d.content || []).filter(b => b.type === 'text').map(b => b.text).join(' ');
      if (/^Current runtime context|^<system-reminder>/.test(txt)) return { ...base, kind: 'context', tag: 'gray', title: '注入的运行时上下文' };
      st.userMsgs++;
      return { ...base, kind: 'user', tag: 'ok', title: '用户输入', detail: MD.plain(txt, 90),
               media: mediaHtml(State.sessionId, d.content) };
    }
    case 'assistant/message': {
      st.assistants++;
      const txt = (d.message?.content || []).filter(b => b.type === 'text').map(b => b.text).join(' ');
      return { ...base, kind: 'message', tag: '', title: '助手回复', detail: MD.plain(txt, 90),
               media: mediaHtml(State.sessionId, d.message?.content) };
    }
    case 'tool/call': {
      st.toolCalls++;
      return { ...base, kind: 'tool', tag: 'warn',
        title: '调用 ' + d.name + (vw && vw.title ? ' · ' + vw.title : ''),
        detail: MD.plain(vw && vw.rawInput !== undefined ? vw.rawInput : (typeof d.arguments === 'string' ? d.arguments : JSON.stringify(d.arguments)), 90) };
    }
    case 'tool/result': {
      const blk = (d.message?.content || []).find(c => c.type === 'tool-result');
      if (blk?.isError) st.toolErrors++;
      return { ...base, kind: 'tool', tag: blk?.isError ? 'err' : 'ok', title: blk?.isError ? '工具失败' : '工具完成',
               detail: MD.plain(ToolCard.textOf(blk?.content), 90), media: mediaHtml(State.sessionId, blk?.content) };
    }
    case 'tool/code-dispatch':
      st.dispatches++;
      return { ...base, kind: 'subtool', tag: 'gray', title: '内部调用 ' + d.name, detail: MD.plain(JSON.stringify(d.arguments || {}), 80) };
    case 'todo/write': return { ...base, kind: 'system', tag: 'ok', title: '任务列表更新（' + (d.todos || []).length + ' 项）' };
    case 'session/title': return { ...base, kind: 'system', tag: 'gray', title: '会话标题：' + (d.title || '') };
  }
  return null;
}

/** 合并两次折叠的统计：计数相加、轮/步取较大 */
function mergeTrajStats(a, b) {
  return {
    turns: Math.max(a.turns || 0, b.turns || 0), steps: Math.max(a.steps || 0, b.steps || 0),
    toolCalls: (a.toolCalls || 0) + (b.toolCalls || 0), toolErrors: (a.toolErrors || 0) + (b.toolErrors || 0),
    dispatches: (a.dispatches || 0) + (b.dispatches || 0), compactions: (a.compactions || 0) + (b.compactions || 0),
    userMsgs: (a.userMsgs || 0) + (b.userMsgs || 0), assistants: (a.assistants || 0) + (b.assistants || 0),
  };
}

async function loadTrajectory(redraw) {
  // TTL 2.5s + 会话绑定：事件折叠是全站最重的解析之一
  if (!redraw && State.trajectory && loaderFresh('trajectory', 2500, State.sessionId)) return false;
  State.trajectory = null;
  try {
    // ⚠️ 手动刷新必须 force=true 绕过 API.history 的 4s 缓存 —— 否则刚看过页面再点「刷新」
    //    就是纯缓存命中（0 请求、画面不变），看起来像"点了没反应"（实测踩过）
    const v = State.sessionId ? await API.history(State.sessionId, true) : { events: [] };
    const st = trajState(null);
    const items = [];
    for (const x of (v.events || [])) { const it = foldTrajectoryEvent(x, st); if (it) items.push(it); }
    const kept = items.slice(-400);
    State.trajectory = {
      items: kept,
      stats: { turns: st.maxTurn, steps: st.maxStep, toolCalls: st.toolCalls, toolErrors: st.toolErrors,
               dispatches: st.dispatches, compactions: st.compactions, userMsgs: st.userMsgs, assistants: st.assistants },
      // 向后翻页：throughSeq 取 follow 开屏的 cursor（session/page 要求它作为日志切点），
      // beforeSeq 取当前时间线里最早一条的 seq。
      cursor: v.cursor ?? null,
      oldestSeq: kept.length ? kept[0].seq : null,
      hasMore: v.hasMore === true && kept.length > 0,
      turnFilter: null,
      loadingOlder: false,
    };
  } catch (e) { State.trajectory = { items: [], stats: {}, error: e.message }; }
  stampLoader('trajectory', State.sessionId);
  if (redraw) render();
  return true;
}

/** 「加载更早」：用 session/page 取回更早的一页，折叠后前插到时间线 */
async function loadOlderTrajectory() {
  const t = State.trajectory;
  if (!t || t.loadingOlder) return;
  if (!t.hasMore || t.oldestSeq == null || t.cursor == null) { UI.info('没有更早的记录了'); return; }
  t.loadingOlder = true; render({ paintOnly: true });
  try {
    const v = await API.call('session.page', { request: {
      address: { kind: 'session', sessionId: State.sessionId },
      throughSeq: t.cursor, beforeSeq: t.oldestSeq, maxMessages: TRAJ_PAGE,
    } });
    // 从上一页最早节点的轮次起算，避免这一页开头的事件没有轮次归属
    const seedTurn = t.items.length ? t.items[0].turn : null;
    const st = trajState(seedTurn);
    const older = [];
    for (const rec of (v.records || [])) { const it = foldTrajectoryEvent({ event: rec.event }, st); if (it) older.push(it); }
    if (!older.length) { t.hasMore = false; UI.info('没有更早的记录了'); }
    else {
      t.items = [...older, ...t.items].slice(0, TRAJ_MAX);
      t.stats = mergeTrajStats(t.stats, { turns: st.maxTurn, steps: st.maxStep, toolCalls: st.toolCalls,
        toolErrors: st.toolErrors, dispatches: st.dispatches, compactions: st.compactions,
        userMsgs: st.userMsgs, assistants: st.assistants });
      t.oldestSeq = older[0].seq;
      t.hasMore = v.hasMore === true;
      UI.ok('已加载更早的 ' + older.length + ' 个节点');
    }
  } catch (e) { UI.err('加载更早失败：' + e.message); }
  t.loadingOlder = false;
  render({ paintOnly: true });
}

/** 轨迹页的「轮次」筛选（数据来自投影 turnOutline：宿主已把每一轮的锚点+摘要算好） */
function trajectoryTurns() {
  const pv = currentSession().projections?.values || {};
  const outline = Array.isArray(pv.turnOutline) ? pv.turnOutline : [];
  return outline.map(o => ({ turn: o.turn, seq: o.seq, prompt: o.prompt || '', response: o.response || '' }));
}
/** 时间线「再显示更多」：每次向前多挂 200 个节点。
 *  为什么不做虚拟滚动：轨迹节点里含图片与工具卡片，等高的虚拟列表会算错高度，
 *  反而是"分页 + 屏外跳过渲染（.perf-list）"这条路稳且够用。 */
function trajMore() {
  const d = State.trajectory; if (!d) return;
  d.shown = (d.shown || 200) + 200;
  render({ paintOnly: true });
}
/** 切轮：同时把时间线的显示窗口收回到默认 200，避免上一轮的展开量带过来 */
function setTrajectoryTurn(n) {
  if (State.trajectory) { State.trajectory.turnFilter = n; State.trajectory.shown = 200; render({ paintOnly: true }); }
}
/** 从某一轮分叉：session/fork 带 atSeq，在该轮之前切断 */
async function forkAtTurn(turn, seq) {
  const ok = await UI.confirm({ title: '从第 ' + turn + ' 轮分叉会话',
    message: '在该轮**之前**切断，分叉出一个新会话（保留此前的上下文）。\n\n锚点 seq=' + seq + '，原会话不受影响。', okText: '分叉' });
  if (!ok) return;
  try {
    const r = await API.call('session.fork', { sessionId: State.sessionId, atSeq: seq });
    UI.ok('已分叉出新会话 ' + String(r?.sessionId || '').slice(0, 18) + '…');
    await reloadSessions();
  } catch (e) { UI.err('分叉失败：' + e.message); }
}
/* ---------- 作用域上下文条 ---------- */
/* 作用域条的内容缓存：它每次 render 都会被调用，而内容只在换会话 / 换智能体预设 / 会话跑起来时才变。
   无条件写 innerHTML 等于"每点一下都在重建这一条（含按钮）"，纯属浪费 —— 与 renderNav 同策略。 */
let _scopeCache = '';

/* 作用域条该出现在哪些页：
   只对"内容跟随当前会话、但本页自己不显示是哪个会话"的页面有用。
   下列页面已经把当前会话身份摆在显眼处，再顶一条纯属重复占地方，显式关掉：
     · home      首页 hero 卡就有会话标题 / 模型 / 智能体预设 / 工作目录
     · sessions  会话列表（当前行已标「当前」+ 高亮），本页就是切会话的地方
     · workspace 当前会话所在空间有 📍 高亮
     · chat      对话页右侧栏常驻显示模型 / 智能体预设 / 工作目录
   分组白名单保持不变：全局页（凭据 / 插件 / 设置 / 系统状态）与它无关，本来就不该出现。 */
const SCOPE_BAR_GROUPS = ['工作台', '对话与会话', '能力与资产'];
const SCOPE_BAR_OFF = ['home', 'sessions', 'workspace', 'chat'];

function renderScopeBar(route) {
  const el = document.getElementById('scopebar');
  if (!el) return;
  const s = currentSession();
  const show = SCOPE_BAR_GROUPS.includes(route.group) && !SCOPE_BAR_OFF.includes(route.id);
  if (!show || !s.sessionId) {
    if (el.style.display !== 'none') el.style.display = 'none';
    _scopeCache = '';
    return;
  }
  if (el.style.display === 'none') el.style.display = '';
  const preset = sessionPreset(s) || '—';
  const proj = State.skillsScope?.cwd || s.cwd || '—';
  // 会话项显示**标题**而不是截断的 session id：uuid 截到 22 位再打省略号，既认不出也读不全。
  // 没有标题时才退回短 id，完整 ID 一律放 title 里（要复制去会话页）。
  const title = s.projections?.values?.title || '';
  const sessLabel = title ? fmt.mid(title, 26) : '未命名会话';
  const sessIdHint = '当前会话 ID：' + s.sessionId + (title ? '｜标题：' + title : '');
  // 子代理会话：把归属写明白（属于哪个父会话），并提供一键回到父会话。
  const sub = isSubagentSession(s);
  const subChip = sub
    ? '<span class="scope-sep"></span>'
      + '<span class="scope-item" title="当前会话是子代理会话，父会话 ' + fmt.esc(s.parentSessionId || '') + '。子代理的轨迹/交付物/作业等均属于它自己，父会话不受影响">🧩 子代理 · 父 <b class="mono">' + fmt.esc(shortSid(s.parentSessionId).slice(0, 12)) + '…</b></span>'
      + '<span class="scope-item"><button class="btn sm" onclick="setCurrentSession(' + fmt.attr(s.parentSessionId) + ')">↩ 回父会话</button></span>'
    : '';
  const html =
    '<span class="scope-item" title="' + fmt.esc(sessIdHint) + '">💬 <b>' + fmt.esc(sessLabel) + '</b>'
    + (title ? '' : ' <span class="mono muted" style="font-size:11px">' + fmt.esc(shortSid(s.sessionId).slice(0, 8)) + '…</span>')
    + '</span>'
    + subChip
    + '<span class="scope-sep"></span>'
    + '<span class="scope-item">🧭 智能体预设 <b>' + fmt.esc(preset) + '</b></span>'
    + '<span class="scope-sep"></span>'
    // 工作目录常常很长：中间省略显示，完整路径放 title 里（够长时中间省略比截尾巴信息量大）
    + '<span class="scope-item" title="会话级属性：决定项目级能力的作用域' + (proj ? '｜' + fmt.esc(proj) : '') + '">📁 工作目录 <b class="mono">' + fmt.esc(fmt.mid(proj, 42)) + '</b></span>'
    + '<span class="scope-sep"></span>'
    + '<span class="scope-item">' + (s.running ? '<span class="tag ok">运行中</span>' : '<span class="tag gray">空闲</span>') + '</span>';
  if (html !== _scopeCache) { el.innerHTML = html; _scopeCache = html; }
}

/* ============ 配置 DSH 主机（地址 + 访问令牌）============
   DSH 的 Web 端口带浏览器会话鉴权：`dsh web` 会打印
     http://127.0.0.1:3080/?token=<launchToken>
   只有带这个令牌换到会话 cookie，/api/* 才不返回 401。
   "用令牌换 cookie"以及"代理时带上 cookie"都在 server.cjs 里做，
   所以页面这边只需要把地址交给 /api/local/dsh，并落盘到 dsh-config.json。

   触发时机：启动时若「没配过 / 没认证 / 连不上」就弹窗；连上了不打扰。
   之后点顶栏右上角的状态栏也能随时打开重新配置。 */
let dshStatusCache = null;

const DSH_STATE = {
  'ok':             { tag: 'ok',   text: '已连接' },
  'need-token':     { tag: 'warn', text: '需要令牌' },
  'token-rejected': { tag: 'err',  text: '令牌无效' },
  'not-dsh':        { tag: 'err',  text: '不是 DSH' },
  'forbidden':      { tag: 'err',  text: 'Host 被拒' },
  'unreachable':    { tag: 'err',  text: '不可达' },
  'unknown':        { tag: 'gray', text: '未检测' },
};

/** 问控制台后端：DSH 地址来源、是否已认证、失败原因 */
async function fetchDshStatus() {
  try { dshStatusCache = await (await fetch('/api/local/dsh', { cache: 'no-store' })).json(); }
  catch (e) {
    dshStatusCache = { state: 'unreachable', configured: false, origin: '—', source: '—',
                       error: '控制台后端无响应：' + e.message };
  }
  return dshStatusCache;
}

/**
 * 「连接 DSH 主机」弹窗。
 * @param status 可选，fetchDshStatus() 的结果；不传就用缓存
 */
function openDshDialog(status) {
  if (document.getElementById('dshdlg')) return;
  const st = status || dshStatusCache || {};
  const s = DSH_STATE[st.state] || DSH_STATE.unknown;
  // 预填：已配过就带上原地址与令牌占位；没配过就给默认地址 + ?token= 提示
  const preset = st.configured
    ? (st.origin || '') + (st.hasToken ? '/?token=' : '')
    : 'http://127.0.0.1:3080/?token=';
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.id = 'dshdlg';
  mask.innerHTML = `
    <div class="modal" style="width:min(640px,100%)">
      <h3>🔌 连接 DSH 主机</h3>
      <div class="modal-body">
        <div style="font-size:12.5px;line-height:1.9">
          当前状态：<span class="tag ${s.tag}">${fmt.esc(s.text)}</span>
          <span class="mono muted" style="font-size:11px">${fmt.esc(st.origin || '—')}</span>
          ${st.httpStatus && st.httpStatus !== '—' ? '<span class="muted" style="font-size:11px">HTTP ' + fmt.esc(st.httpStatus) + '</span>' : ''}
          ${st.source ? '<span class="muted" style="font-size:11px">来源 ' + fmt.esc(st.source) + '</span>' : ''}
          ${st.error ? '<div class="alert err" style="margin:8px 0 0;font-size:12px">' + fmt.esc(st.error) + '</div>' : ''}
          ${st.detail && !st.error ? '<div class="muted" style="font-size:11.5px;margin-top:4px">' + fmt.esc(st.detail) + '</div>' : ''}
        </div>

        <div class="modal-hint" style="margin-top:12px;line-height:1.9">
          把 <code>dsh web</code> 启动时打印的地址<b>整段</b>粘贴进来（含 <code>?token=…</code>）：<br>
          <code>http://127.0.0.1:3080/?token=&lt;令牌&gt;</code><br>
          只粘贴令牌本身也可以，只填地址（<code>http://127.0.0.1:3080</code>）也可以。
        </div>

        <input id="dsh-url" placeholder="http://127.0.0.1:3080/?token=…" value="${fmt.esc(preset)}"
               style="margin-top:10px" autocomplete="off" spellcheck="false">
        <div class="modal-err" id="dsh-err"></div>
        <div class="muted" style="font-size:11px;margin-top:6px">
          保存后会写入 <code>dsh-config.json</code>（含令牌，已在 .gitignore 中排除），下次启动自动读取。
        </div>
      </div>
      <div class="modal-actions">
        <button class="btn" id="dsh-clear" title="删掉保存的地址与令牌，回到默认 127.0.0.1:3080">恢复默认</button>
        <button class="btn" id="dsh-keep" title="DSH 还没启动时也能先存下来">仅保存不验证</button>
        <button class="btn" id="dsh-cancel">稍后</button>
        <button class="btn primary" id="dsh-ok">保存并连接</button>
      </div>
    </div>`;
  document.body.appendChild(mask);

  const input = mask.querySelector('#dsh-url');
  const err = mask.querySelector('#dsh-err');
  const btns = [...mask.querySelectorAll('button')];
  const close = () => mask.remove();
  const post = async (payload) => {
    const r = await fetch('/api/local/dsh', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
    });
    return r.json();
  };
  const submit = async (keep) => {
    const url = input.value.trim();
    if (!url) { err.textContent = '请填写地址或令牌'; input.focus(); return; }
    err.innerHTML = '<span class="loading"></span> 正在验证…';
    btns.forEach(b => { b.disabled = true; });
    try {
      const r = await post(keep ? { url, keep: true } : { url });
      if (!r.ok) {
        err.textContent = r.error || '连接失败';
        btns.forEach(b => { b.disabled = false; });
        return;
      }
      err.innerHTML = '<span class="tag ok">已保存</span> 正在重新加载…';
      UI.ok(keep ? '已保存（未验证）' : '已连接 DSH 并保存');
      setTimeout(() => location.reload(), 600);
    } catch (e) {
      err.textContent = '请求控制台后端失败：' + e.message;
      btns.forEach(b => { b.disabled = false; });
    }
  };
  mask.querySelector('#dsh-ok').onclick = () => submit(false);
  mask.querySelector('#dsh-keep').onclick = () => submit(true);
  mask.querySelector('#dsh-cancel').onclick = close;
  mask.querySelector('#dsh-clear').onclick = async () => {
    const ok = await UI.confirm({ title: '恢复默认 DSH 地址', message: '删除保存的地址与令牌，回到 http://127.0.0.1:3080 ？', okText: '恢复默认' });
    if (!ok) return;
    btns.forEach(b => { b.disabled = true; });
    try { await post({ clear: true }); UI.ok('已恢复默认'); setTimeout(() => location.reload(), 500); }
    catch (e) { err.textContent = '请求失败：' + e.message; btns.forEach(b => { b.disabled = false; }); }
  };
  mask.onclick = (e) => { if (e.target === mask) close(); };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submit(false); }
    if (e.key === 'Escape') { e.preventDefault(); close(); }
  });
  setTimeout(() => { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }, 30);
}

/* ---------- 启动 ---------- */
window.addEventListener('hashchange', render);
window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); }
});
/**
 * 点空白处自动收起命令（/）与引用（@）菜单。
 * 两个例外，否则会"刚打开就被自己关掉"：
 *  ① 菜单内部不关 —— 菜单项自己的 onclick="menuPick(i)" 还没执行完，
 *     点在菜单上必须让它把这一下吃完（Esc 仍然只关不选）。
 *  ② 输入行整块不关 —— 📎 / @ 两个触发按钮就在这一行里；按钮 onclick 打开菜单后，
 *     同一次点击会继续冒泡到 document，若不排除打开的动作会被立刻撤销。
 */
document.addEventListener('click', (e) => {
  if (!menuOpen()) return;
  if (e.target.closest('.menu-pop, .chat-input-row')) return;
  closeMenus();
});
window.addEventListener('DOMContentLoaded', async () => {
  // 界面偏好必须在**首次 render 之前**拿到：页面骨架（说明卡、对话显示模式）靠它决定
  await loadUiPrefs();
  // 先问控制台后端：DSH 地址配了没、认证过没（需要访问令牌）
  const dsh = await fetchDshStatus();
  const hs = document.getElementById('hstatus');
  if (hs) {
    hs.style.cursor = 'pointer';
    hs.title = '点击配置 DSH 主机地址与访问令牌';
    hs.onclick = () => openDshDialog();
  }

  await boot();
  try {
    if (State.sessionId) {
      const sk = await API.call('skill.list', { sessionId: State.sessionId });
      State.skills = sk.skills || [];
      const pr = await API.call('agentPreset.list', {});
      State.presets = pr.presets || [];
      State.presetsAuthorable = pr.authorable === true;
      State.models = await API.call('session.models', { sessionId: State.sessionId });
      const lp = await API.call('llm.providers', {});
      State.providers = lp.providers || [];
    }
  } catch (e) { console.warn('附加数据加载失败:', e.message); }

  // console 本地接口（不经 DSH）
  try { State.plugins = await (await fetch('/api/local/plugins')).json(); }
  catch (e) { console.warn('插件清单加载失败', e.message); }
  try {
    const m = await (await fetch('/api/local/mcp')).json();
    State.mcp = (m.servers || []).map(mcpView);
    State.mcpRaw = m;
  } catch (e) { console.warn('MCP 清单加载失败', e.message); }
  try {
    const cwd = currentSession().cwd || '';
    const qs = cwd ? '?cwd=' + encodeURIComponent(cwd) : '';
    State.skillsScope = await (await fetch('/api/local/skills' + qs)).json();
  } catch (e) { console.warn('Skills 归属加载失败', e.message); }
  try { State.subagents = await API.call('subagent.list', { parentSessionId: State.sessionId }); }
  catch (e) { State.subagents = { entries: [], error: e.message }; }

  await loadWorkspaces();
  await refreshGoal();
  await loadSettings();
  await loadCredentials();

  restoreSide();
  Stream.connect();
  render();
  // 没配过 / 没认证 / 连不上 → 启动即弹窗让人填 DSH 地址；一切正常就不打扰
  if (dsh.state !== 'ok') openDshDialog(dsh);
});
