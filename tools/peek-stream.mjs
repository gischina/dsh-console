/* DSH Console — 工具脚本 peek-stream.mjs
 * Copyright 2026 liwei (易智瑞西安) <liwei@geoscene.cn>
 * SPDX-License-Identifier: Apache-2.0
 *
 * 依据 Apache License 2.0 授权使用与分发；许可证全文见项目根目录 LICENSE，摘要见 NOTICE。
 */
/* 看一眼任意逻辑流的开屏帧（排查用）。参数用预设名，省得跟 shell 的引号较劲。
   用法：
     node tools/peek-stream.mjs control                  # session/control（宿主级状态）
     node tools/peek-stream.mjs follow <sessionId>       # session/follow 开屏快照
     node tools/peek-stream.mjs subagent <parentId> <childId> [one-shot|continuable]
     node tools/peek-stream.mjs workspace                # workspace/follow 基线
     node tools/peek-stream.mjs events                   # $events 转发事件流
     node tools/peek-stream.mjs raw <endpoint> [json]    # 任意端点（json 会被 JSON.parse）
   环境变量：CONSOLE（默认 http://127.0.0.1:3081） */
const CONSOLE = process.env.CONSOLE || 'http://127.0.0.1:3081';
const [kind, a, b, c] = process.argv.slice(2);
const secs = Number(process.env.SECS || 6);

function spec() {
  switch (kind) {
    case 'control': return ['session/control', { args: {} }];
    case 'workspace': return ['workspace/follow', { args: {} }];
    case 'events': return ['$events', { args: {} }];
    case 'follow':
      if (!a) throw new Error('用法：peek-stream.mjs follow <sessionId>');
      return ['session/follow', { args: { request: { address: { kind: 'session', sessionId: a }, maxMessages: 3, assistantStream: true } } }];
    case 'subagent':
      if (!a || !b) throw new Error('用法：peek-stream.mjs subagent <parentId> <childId> [mode]');
      return ['session/follow', { args: { request: { address: { kind: 'subagent', parentSessionId: a, childSessionId: b, mode: c || 'continuable' }, maxMessages: 3 } } }];
    case 'raw':
      if (!a) throw new Error('用法：peek-stream.mjs raw <endpoint> [jsonArgs]');
      return [a, JSON.parse(b || '{"args":{}}')];
    default:
      throw new Error('未知参数：' + (kind || '(空)') + '；可选 control | follow | subagent | workspace | events | raw');
  }
}
const [endpoint, payload] = spec();

const wsUrl = CONSOLE.replace(/^http/, 'ws') + '/api/remote.mux';
const ws = new WebSocket(wsUrl);
let n = 0;
const t0 = Date.now();
const timer = setTimeout(() => { console.log('—— 结束（' + secs + ' 秒）——'); process.exit(0); }, secs * 1000);

ws.onopen = () => {
  console.log('WS 已升级：' + wsUrl);
  ws.send(JSON.stringify({ type: 'open', streamId: 'peek', endpoint, payload }));
  console.log('open ' + endpoint + ' ' + JSON.stringify(payload));
};
ws.onmessage = (e) => {
  n++;
  let s = typeof e.data === 'string' ? e.data : '(binary)';
  if (s.length > 600) s = s.slice(0, 600) + ' …(+' + (s.length - 600) + ')';
  console.log('[' + (Date.now() - t0) + 'ms] ' + s);
  if (n >= 12) { clearTimeout(timer); process.exit(0); }
};
ws.onerror = (e) => { console.log('WS 错误：' + (e.message || e.type)); clearTimeout(timer); process.exit(1); };
ws.onclose = (e) => { console.log('WS 关闭 code=' + e.code); clearTimeout(timer); process.exit(0); };
