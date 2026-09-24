/* DSH Console — 工具脚本 verify-react-runtime.mjs
 * Copyright 2026 liwei (易智瑞西安) <liwei@geoscene.cn>
 * SPDX-License-Identifier: Apache-2.0
 *
 * 依据 Apache License 2.0 授权使用与分发；许可证全文见项目根目录 LICENSE，摘要见 NOTICE。
 */
/* 冒烟验证 public/react/ 里抽取出来的 React 运行时（Node 侧，不依赖浏览器）。
 *
 * 为什么需要：extract-react-runtime.mjs 是从 DSH 前端里"逆向"抽模块，
 * 一旦上游打包方式变了（换 React 版本、改 chunk 结构、加新包装），
 * 抽出来的东西可能"文件在、但导出是空的"。这个脚本专治这种静默失败。
 *
 * 用法：node tools/verify-react-runtime.mjs   → 退出码非 0 表示运行时不可用
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const mfFile = path.join(ROOT, 'public', 'react', 'manifest.json');

if (!fs.existsSync(mfFile)) {
  console.log('❌ 缺 public/react/manifest.json —— 先跑 node tools/extract-react-runtime.mjs');
  process.exit(1);
}
const mf = JSON.parse(fs.readFileSync(mfFile, 'utf8'));
const file = path.join(ROOT, 'public', 'react', mf.file);
if (!fs.existsSync(file)) {
  console.log('❌ manifest 指向的 ' + mf.file + ' 不存在，请重新运行 extract-react-runtime.mjs');
  process.exit(1);
}

const m = (await import(new URL('../public/react/' + mf.file, import.meta.url).href)).default || {};

/* 逐个断言：名字 → 期望类型。React 侧的入口一个都不能少，否则插件界面会在运行时炸。 */
const expect = {
  'react.version': ['string', m.react && m.react.version],
  'react.createElement': ['function', m.react && m.react.createElement],
  'react.useState': ['function', m.react && m.react.useState],
  'react.useEffect': ['function', m.react && m.react.useEffect],
  'react.useSyncExternalStore': ['function', m.react && m.react.useSyncExternalStore],
  'react.createContext': ['function', m.react && m.react.createContext],
  'react-dom/createRoot': ['function', m['react-dom/client'] && m['react-dom/client'].createRoot],
  'react-dom/createPortal': ['function', m['react-dom'] && m['react-dom'].createPortal],
  'react-dom/flushSync': ['function', m['react-dom'] && m['react-dom'].flushSync],
  'jsx-runtime/jsx': ['function', m['react/jsx-runtime'] && m['react/jsx-runtime'].jsx],
  'jsx-runtime/jsxs': ['function', m['react/jsx-runtime'] && m['react/jsx-runtime'].jsxs],
  'jsx-runtime/Fragment': ['symbol', m['react/jsx-runtime'] && m['react/jsx-runtime'].Fragment],
};

const misses = [];
for (const [name, [want, got]] of Object.entries(expect)) {
  const kind = typeof got;
  const okType = want === 'string' ? typeof got === 'string'
    : want === 'symbol' ? typeof got === 'symbol'
      : kind === 'function';
  if (!okType) misses.push(name + '（期望 ' + want + '，实得 ' + (got === undefined ? 'undefined' : kind) + '）');
}

console.log('运行时文件：public/react/' + mf.file + '   （' + fs.statSync(file).size + ' B）');
console.log('React 版本：' + (m.react && m.react.version));
console.log('导出命名空间：' + Object.keys(m).join(', '));
if (misses.length) {
  console.log('❌ 缺失或类型不对 ' + misses.length + ' 项：');
  misses.forEach(x => console.log('   · ' + x));
  process.exit(1);
}
console.log('✅ 抽取出的 React 运行时可用（' + Object.keys(expect).length + ' 项断言全过）');
