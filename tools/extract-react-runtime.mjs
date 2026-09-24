// 从 DSH 前端产物里抽出 React 运行时 → public/react/react-runtime.<hash>.js（构建期，产物入库）
//
// 为什么是"抽"而不是"直接 import DSH 的那份文件"：
// 那份产物是**整个 DSH 前端**，末尾自带启动代码（找 #root 并把应用跑起来）。
// 直接 import 会在控制台里把 DSH 自己启动一遍（实测报 "web app: missing #root"）。
//
// 抽取思路（对应产物的真实结构，rollup 打包的 minified CJS）：
//   · 每个源模块的边界是 `/**\n * @license React` 这样的 banner 注释；
//   · 模块间靠顶层 `var X={exports:{}}` + 惰性初始化 `var y; function init(){return y||(y=1,X.exports=impl()),X.exports}` 连接；
//   · 产物末尾 `function by(){return{react:ec,...}}` 是 DSH 自己的种子表 —— 从它取真实导出符号，不写死名字（升级会重新 mangle）。
// 取法是"白名单闭包"：从要的三个导出符号出发，递归收集它们引用的顶层标识符所在模块，其余一律丢掉。
//
// 用法：node tools/extract-react-runtime.mjs   （需要本机装了 DSH；也可用 DSH_FRONTEND_DIST 指定 dist）
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const OUT = path.join(ROOT, 'public', 'react');
const WANT = ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'];

function findAssets() {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const cands = [
    process.env.DSH_FRONTEND_DIST,
    'C:/nvm4w/nodejs/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist',
    path.join(home, '.dsh', 'profiles', process.env.DSH_PROFILE || 'web', 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist'),
  ].filter(Boolean);
  for (const d of cands) { const a = path.join(d, 'assets'); if (fs.existsSync(a)) return a; }
  throw new Error('找不到 DSH 前端产物（可用 DSH_FRONTEND_DIST 指定 dist 目录）');
}

/* ---------- 轻量括号扫描：把顶层语句切出来 ----------
   ⚠️ 两个必须处理的干扰（不处理就会全盘切错，实测括号深度直接跑成负数）：
   ① 正则字面量 /…/ 与除号长得一样，误判成注释起点会把后面整段吞掉；
   ② 文件是 ES 模块，开头有 import 语句（没有分号的换行结尾）。
   判据：`/` 若紧跟在标识符/数字/右括号之后，就是除号；否则是正则起点。
   在正则里 [ 与 ] 不配对（`[^/]` 是字符类），所以整段跳过，不参与深度统计。 */
function topLevelStatements(src) {
  const out = [];
  let depth = 0, start = 0, i = 0;
  const prevSignificant = () => {
    for (let k = i - 1; k >= 0; k--) { const ch = src[k]; if (!/\s/.test(ch)) return ch; }
    return '';
  };
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { const j = src.indexOf('\n', i); i = j < 0 ? src.length : j; continue; }
    if (c === '/' && src[i + 1] === '*') { const j = src.indexOf('*/', i); i = j < 0 ? src.length : j + 2; continue; }
    if (c === '/' && !/[\w$)\]'"`]/.test(prevSignificant())) {
      // 正则字面量：跳到收尾的 /（字符类内的 / 不算）
      let j = i + 1, inClass = false;
      while (j < src.length) {
        const ch = src[j];
        if (ch === '\\') { j += 2; continue; }
        if (ch === '[') inClass = true;
        else if (ch === ']') inClass = false;
        else if (ch === '/' && !inClass) break;
        else if (ch === '\n') break;
        j++;
      }
      i = j + 1; continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const q = c; i++;
      while (i < src.length) { if (src[i] === '\\') i += 2; else if (src[i] === q) { i++; break; } else i++; }
      continue;
    }
    if (c === '{' || c === '(' || c === '[') depth++;
    else if (c === '}' || c === ')' || c === ']') depth--;
    else if (c === ';' && depth === 0) { out.push({ at: start, code: src.slice(start, i + 1) }); start = i + 1; }
    i++;
  }
  if (start < src.length) out.push({ at: start, code: src.slice(start) });
  return out;
}

const assets = findAssets();
const files = fs.readdirSync(assets).filter(n => n.endsWith('.js'));
let src = null, picked = null;
for (const n of files) {
  const t = fs.readFileSync(path.join(assets, n), 'utf8');
  if (/function by\(\)\{return\{react:/.test(t)) { src = t; picked = n; break; }
}
if (!src) throw new Error('产物里没有找到种子表 by()，无法确定导出符号');

/* ---------- 1. 导出符号 ---------- */
const seedAt = src.indexOf('function by(){return{react:');
const seed = src.slice(seedAt, src.indexOf('}', seedAt));
const wanted = WANT.map(name => {
  // 键的引号不统一：`react:ec` 与 `"react/jsx-runtime":ic` 并存，两种都认
  const key = name.replace(/[/-]/g, c => '\\' + c);
  const m = new RegExp('(?:^|[{,])\\s*"?\\s*' + key + '\\s*"?\\s*:\\s*([A-Za-z_$][\\w$]*)').exec(seed);
  return { name, sym: m ? m[1] : null };
});
const missing = wanted.filter(w => !w.sym);
if (missing.length) throw new Error('种子表里没有这些模块：' + missing.map(w => w.name).join(', '));
console.log('产物 :', picked, Math.round(src.length / 1024) + ' KB');
console.log('导出 :', wanted.map(w => w.name + '→' + w.sym).join('  '));

/* ---------- 2. 顶层语句与"提供者"下标 ---------- */
const stmts = topLevelStatements(src);
// ⚠️ 必须剔掉 `import{...}from"./vendor-xxx.js"` —— 它的花括号里全是 `c as da,a as fa,…` 这种
// 别名绑定，会被"逗号+标识符+="的规则误当成顶层声明。一旦收进来，闭包就会顺着
// `h: Q4` 逃逸到外部的 vendor chunk，再把 DSH 全部图标组件（几十 KB 的 SVG）拖进来。
// 实测：不剔这一条，保留语句从 20 条暴涨到 125 条。
for (const s of stmts) if (/^\s*import[\s{*]/.test(s.code)) s.isImport = true;
// import 语句里的别名绑定（`c as da`）绝不能算顶层声明：它指向的是**外部模块**，
// 本文件里根本没有它的定义，收进闭包只会把依赖链引向不存在的东西。
const isImportCode = (code) => /^\s*(?:import|export)\s*[\s{*]/.test(code);
const userStmts = stmts.filter(s => !s.isImport && !/^\/\/#\s*sourceMappingURL/.test(s.code.trim()));
/* 产物里必须抠掉的尾巴（构建工具塞的，不是 React）：Vite 的 modulepreload 垫片。
   它是个裸 IIFE 挂在某条语句后面，会摸 document —— 浏览器里无害，但对我们没意义，
   而且 Node 里跑会 ReferenceError。注意声明 Eo 的那条语句也挂着它，
   所以只能剪尾巴，不能整条丢。 */
const VITE_POLY_RE = /\(function\(\)\{const r=document\.createElement\("link"\)\.relList;[\s\S]*?\}\)\(\);/;
for (const s of userStmts) {
  const m = VITE_POLY_RE.exec(s.code);
  if (m) s.code = s.code.slice(0, m.index) + s.code.slice(m.index + m[0].length);
}
/* 提供者：语句在**自身顶层作用域**里声明的标识符（`function X` / `var|let|const X =`）。
   ⚠️ 关键约束：只看语句自己的顶层，**不进函数体**。
   产物是 minified 的，函数体里到处是 `const s=…`、`c=>…` 这种单字母局部名；如果连它们
   一起收，`s`/`c`/`h` 这类名字会和别处的顶层 mangle 名撞车，闭包就会顺着撞出来的边
   从 React 一路爬到整个 DSH 应用（实测：正确的 4 个 React 模块被稀释成 125 条语句）。
   做法：对语句做一次括号深度扫描，只接受"深度 0 处"出现的声明。 */
function topLevelDecls(code) {
  const ids = new Set();
  // 语句本身若是 `function X(...){...}`，整个体都在深度 1 —— 先把函数名收下
  const head = /^\s*function\s+([A-Za-z_$][\w$]*)\s*\(/.exec(code);
  if (head) ids.add(head[1]);
  let depth = 0, i = 0;
  const prevSig = () => { for (let k = i - 1; k >= 0; k--) { const c = code[k]; if (!/\s/.test(c)) return c; } return ''; };
  while (i < code.length) {
    const c = code[i];
    if (c === '/' && code[i + 1] === '/') { const j = code.indexOf('\n', i); i = j < 0 ? code.length : j; continue; }
    if (c === '/' && code[i + 1] === '*') { const j = code.indexOf('*/', i); i = j < 0 ? code.length : j + 2; continue; }
    if (c === '/' && !/[\w$)\]'"`]/.test(prevSig())) {
      let j = i + 1, inClass = false;
      while (j < code.length) {
        const ch = code[j];
        if (ch === '\\') { j += 2; continue; }
        if (ch === '[') inClass = true; else if (ch === ']') inClass = false;
        else if (ch === '/' && !inClass) break; else if (ch === '\n') break;
        j++;
      }
      i = j + 1; continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const q = c; i++;
      let tpl = 0;
      while (i < code.length) {
        if (code[i] === '\\') { i += 2; continue; }
        if (q === '`' && code[i] === '$' && code[i + 1] === '{') { tpl++; depth++; i += 2; continue; }
        if (q === '`' && code[i] === '}' && tpl > 0) { tpl--; depth--; i++; continue; }
        if (code[i] === q) { i++; break; }
        i++;
      }
      continue;
    }
    if (c === '{' || c === '(' || c === '[') { depth++; i++; continue; }
    if (c === '}' || c === ')' || c === ']') { depth--; i++; continue; }
    if (depth === 0) {
      // 深度 0 上的 `var|let|const X` 或 `function X(`。
      // ⚠️ `=` 不能要求必须有：产物里到处是 `var r5;` 这种"只开槽位、不赋初值"的写法
      // （React 工厂靠 `if(r5)return ve;r5=1;` 惰性初始化）。漏掉它们会在运行期
      // 报 `ReferenceError: r5 is not defined`，而且报得离根因很远，很难查。
      // ⚠️ 只把**标识符本身**吃掉，后面的 `=` / `(` 交回主循环，否则会跳掉那个括号、
      // 让 depth 错位：函数体被当成顶层，参数名全被登记（实测 #44 泄漏 20 个名字）。
      const rest = code.slice(i);
      const m = /^(?:var|let|const)\s+([A-Za-z_$][\w$]*)/.exec(rest);
      if (m) { ids.add(m[1]); i += m[0].length; continue; }
      const f = /^function\s+([A-Za-z_$][\w$]*)\s*\(/.exec(rest);
      if (f) { ids.add(f[1]); i += f[0].length - 1; continue; }
      // 逗号续声明：`const a=1,b=2` / `var a,b` → 深度 0 上的 `,b`
      const cm = /^,\s*([A-Za-z_$][\w$]*)/.exec(rest);
      if (cm) { ids.add(cm[1]); i += cm[0].length; continue; }
    }
    i++;
  }
  return ids;
}
const collectDecls = topLevelDecls;
const provides = [];        // [ { id, idx } ] 声明顺序即求值顺序
userStmts.forEach((s, idx) => { for (const id of collectDecls(s.code)) provides.push({ id, idx }); });
// 一个标识符可能被声明多次（`var x` 先 undefined 后赋值）：保留"最后一次"为定义点，
// 但首次声明也有意义（提升语义），所以记录初始声明下标用于依赖排查。
const firstDecl = new Map(), lastDecl = new Map();
for (const p of provides) { if (!firstDecl.has(p.id)) firstDecl.set(p.id, p.idx); lastDecl.set(p.id, p.idx); }
if (process.env.KB_DIAG) {
  console.log('语句数:', userStmts.length, '声明的顶层标识符:', lastDecl.size, '个');
  for (const w of wanted) console.log('  ' + w.sym + ' → 语句 #' + lastDecl.get(w.sym));
}

/* ---------- 3. 从导出符号出发，收集依赖闭包 ----------
   这一段是脚本里最容易写错的地方。先说清产物模型：

   每个源模块在这里都是一个**惰性工厂**，形如
       var V0={exports:{}},ve={};                                   // 语句 A：提前开好的"槽位"
       function Xa(){if(r5)return ve;r5=1;…ve.version="18.3.1";return ve}   // 语句 B：工厂
       function P3(){return i5||(i5=1,V0.exports=Xa()),V0.exports}var I=P3();
       const Ja=$r(I),ec=Eo({__proto__:null,default:Ja},[I]);       // 语句 C：对外导出

   "B 依赖 A" 只能靠**看 B 的函数体引用了哪些外层名字**判断。两个坑：
   ① 只看语句顶层 → 函数体整段被跳过，依赖全丢（实测只剩 7 条语句 / 3 KB，等于没抽）；
   ② 无脑全文扫 → minified 的函数参数名（t/r/s/h…）会和别处的顶层 mangle 名撞车，
      闭包顺着撞名从 React 爬到整个 DSH 应用（实测 125 条 / 544 KB）。

   正确做法：扫函数体，但**扣掉局部绑定的名字**，剩下的自由变量才是指向外层的边。
   作用域链只用来"屏蔽"，不需要精确到块级，够用。 */
function refsOf(codeText, selfIdx) {
  const found = new Set();
  const scopes = [new Set()];                       // 词法作用域栈
  const isBound = (id) => scopes.some(s => s.has(id));

  let i = 0;
  const prevSig = () => { for (let k = i - 1; k >= 0; k--) { const c = codeText[k]; if (!/\s/.test(c)) return c; } return ''; };
  const push = (id) => { if (!isBound(id) && lastDecl.has(id) && lastDecl.get(id) !== selfIdx) found.add(id); };

  while (i < codeText.length) {
    const c = codeText[i];
    if (c === '/' && codeText[i + 1] === '/') { const j = codeText.indexOf('\n', i); i = j < 0 ? codeText.length : j; continue; }
    if (c === '/' && codeText[i + 1] === '*') { const j = codeText.indexOf('*/', i); i = j < 0 ? codeText.length : j + 2; continue; }
    if (c === '/' && !/[\w$)\]'"`]/.test(prevSig())) {
      // 正则字面量：跳过（字符类里的 / 不算结尾）
      let j = i + 1, inClass = false;
      while (j < codeText.length) {
        const ch = codeText[j];
        if (ch === '\\') { j += 2; continue; }
        if (ch === '[') inClass = true; else if (ch === ']') inClass = false;
        else if (ch === '/' && !inClass) break; else if (ch === '\n') break;
        j++;
      }
      i = j + 1; continue;
    }
    if (c === '"' || c === "'" || c === '`') { const q = c; i++; while (i < codeText.length) { if (codeText[i] === '\\') i += 2; else if (codeText[i] === q) { i++; break; } else i++; } continue; }

    // 函数体：`(params){ … }` —— 压帧后整段跳进去，体内的名字不会污染外层判断
    if (c === '(') {
      const head = /^\(([^)]*)\)\s*\{/.exec(codeText.slice(i));
      if (head) {
        const frame = new Set();
        for (const p of head[1].split(',')) { const t = p.trim().replace(/[:=].*$/, '').trim(); if (/^[A-Za-z_$][\w$]*$/.test(t)) frame.add(t); }
        const bodyOpen = i + head[0].length - 1;
        const bodyEnd = matchBrace(codeText, bodyOpen);
        const body = codeText.slice(bodyOpen + 1, bodyEnd);
        for (const id of collectLocals(body)) frame.add(id);   // var/let/const/function 在本层的绑定
        scopes.push(frame);
        for (const id of refsOf(body, selfIdx)) found.add(id); // 体内自由变量
        scopes.pop();
        i = bodyEnd + 1; continue;
      }
      i++; continue;
    }
    // 箭头函数 `x=>` / `(a,b)=>`：参数进帧，体交给下一轮（单表达式体也能被扫到）
    if (c === '=' && codeText[i + 1] === '>') {
      i += 2; continue;
    }
    if (c === '{' || c === '[' || c === '}' || c === ']' || c === ')' || c === ';' || c === ',') { i++; continue; }
    if (/[A-Za-z_$]/.test(c)) {
      const id = /^[A-Za-z_$][\w$]*/.exec(codeText.slice(i))[0];
      const before = codeText[i - 1];
      const after = /^\s*:/.test(codeText.slice(i + id.length));
      if (before !== '.' && !after) push(id);     // 跳过属性访问 `.foo` 与对象键 `foo:`
      i += id.length; continue;
    }
    i++;
  }
  return found;
}

// 收集一段代码里"在本层直接绑定"的名字（参数以外的：var/let/const/function、箭头单参）
function collectLocals(text) {
  const ids = new Set();
  for (const m of text.matchAll(/(?<![\w$.])(?:var|let|const)\s+([A-Za-z_$][\w$]*)/g)) ids.add(m[1]);
  for (const m of text.matchAll(/(?<![\w$.])function\s+([A-Za-z_$][\w$]*)\s*\(/g)) ids.add(m[1]);
  for (const m of text.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*=>/g)) ids.add(m[1]);  // 箭头单参
  for (const m of text.matchAll(/(?<![\w$.])catch\s*\(\s*([A-Za-z_$][\w$]*)/g)) ids.add(m[1]);
  return ids;
}

// 从 `{` 配平到对应的 `}`，返回 `}` 的下标；字符串/注释/正则一并跳过
function matchBrace(s, openAt) {
  let d = 0, j = openAt;
  while (j < s.length) {
    const c = s[j];
    if (c === '"' || c === "'" || c === '`') { const q = c; j++; while (j < s.length) { if (s[j] === '\\') j += 2; else if (s[j] === q) { j++; break; } else j++; } continue; }
    if (c === '/' && s[j + 1] === '/') { const k = s.indexOf('\n', j); j = k < 0 ? s.length : k; continue; }
    if (c === '/' && s[j + 1] === '*') { const k = s.indexOf('*/', j); j = k < 0 ? s.length : k + 2; continue; }
    if (c === '{') d++;
    else if (c === '}') { d--; if (d === 0) return j; }
    j++;
  }
  return s.length;
}

const keep = new Set();
const queue = [];
for (const w of wanted) {
  const idx = lastDecl.get(w.sym);
  if (idx === undefined) throw new Error('找不到 ' + w.sym + ' 的定义语句');
  // 定义点与首次声明都要保留（后者可能是 `var x;` 的槽位）
  for (const i of new Set([idx, firstDecl.get(w.sym)])) { keep.add(i); queue.push(i); }
}
while (queue.length) {
  const idx = queue.pop();
  for (const id of refsOf(userStmts[idx].code, idx)) {
    for (const i of new Set([lastDecl.get(id), firstDecl.get(id)])) {
      if (i !== undefined && !keep.has(i)) { keep.add(i); queue.push(i); }
    }
  }
}
/* ⚠️ 收完闭包还要过一道闸，原因和取舍都要写清楚（后人改这里很容易改坏）：

   为什么需要闸门：minified 代码里**名字会跨模块撞车**，纯靠名字分析一定会有假阳性。
   实测：react-dom 体内引用了一个 `e3`，而 DSH 自己也有一条 188 字节的工具函数叫 `e3`
   （`function e3(t){…codePointAt…}`）。于是闭包顺着这条假边爬进了 DSH 的整套
   UI 组件（图标 SVG、弹层、代码高亮…），产物从 ~163 KB 虚胖到 ~410 KB。

   闸门规则 —— 只接受这些语句：
   ① React 模块本体。注意产物里 banner 和工厂是**两条独立语句**：
          #43  一条只写 @license React 与 react.production.min.js 名的 banner 注释
          #44  function Xa(){if(r5)return ve;…}          ← 真正的工厂
      所以判据是"含 @license React banner"**或**"紧跟在 banner 语句之后"（bannerIdx+1）。
   ② 导出语句（`const Ja=$r(I),ec=Eo({…},[I]);`）无条件留 —— 它们很小（约 54 字节），
      声明出的 ec/ic/cc/fc 又是终点、不会被别人引用，按"共用"判会被当碎语句丢掉，
      一丢产物直接缺导出。见 rootStmt。
   ③ 纯槽位语句（`var A0={exports:{}},Lr={};`）无条件留 —— 只开空对象、不引用任何东西，
      工厂里的 `A0.exports=tc()` 立刻会炸（实测 ReferenceError: A0 is not defined）。见 slotOnly。
   ④ 小工具：长度 ≤ ALLOW_SMALL，且声明的名字被 ≥2 条保留语句共用（`Eo`/`$r`/`st` 就是）。

   ⚠️ 残留：这套规则**已经能跑通**（React 18.3.1 全导出可用），但闭包里仍会剩约 12 KB
   的 DSH 代码（几个图标/弹层组件，功能无害、只是多余）。用户已确认接受这个取舍，
   不再继续做更精细的作用域分析 —— 收益太小、风险太大。 */
const LICENSE_RE = /@license React/;
const bannerIdx = new Set();
userStmts.forEach((s, i) => { if (LICENSE_RE.test(s.code)) bannerIdx.add(i); });
const isModuleBody = (i) => bannerIdx.has(i) || bannerIdx.has(i - 1);
const refCount = new Map();
for (const i of keep) for (const id of refsOf(userStmts[i].code, i)) refCount.set(id, (refCount.get(id) || 0) + 1);
const ALLOW_SMALL = 9000;      // 小工具的体积上限（React 本体动辄 100 KB+，不会被误伤）
const rootStmt = new Set(wanted.map(w => lastDecl.get(w.sym)).filter(i => i !== undefined));

/* ⚠️ 光靠"被 ≥2 条语句共用"不够。产物里有大量**单线依赖**：
       #60  function uc(){…}var x6=uc();
       #61  const dc=$r(x6),fc=Eo(…,[x6]);      ← 只有 #61 用它
   `x6` 只被引用一次，按"共用"判就会被丢掉，运行时立刻
   `ReferenceError: x6 is not defined`（实测踩过两次：x6、A0）。

   正确做法是先算出"**必留语句直接引用的名字**"（= 从根出发走一步的边），
   这些名字的声明语句无条件保留；剩下的再按"共用 + 体积"判。 */
const pinned = new Set([...rootStmt, ...[...rootStmt].flatMap(i => [...refsOf(userStmts[i].code, i)])]);
// 再迭代两轮，把 pinned 语句自己引用到的名字也钉住，避免链式漏掉
for (let round = 0; round < 3; round++) {
  const next = [];
  for (const i of keep) {
    const decls = [...collectDecls(userStmts[i].code)];
    if (decls.some(d => pinned.has(d))) { for (const id of refsOf(userStmts[i].code, i)) if (!pinned.has(id)) next.push(id); }
  }
  if (!next.length) break;
  for (const id of next) pinned.add(id);
}
const dropped = [];
const finalKeep = new Set();
for (const i of keep) {
  if (isModuleBody(i) || rootStmt.has(i)) { finalKeep.add(i); continue; }
  const code = userStmts[i].code;
  const decls = [...collectDecls(code)];
  // ① 被必留语句引用到的名字 → 无条件留
  if (decls.some(d => pinned.has(d))) { finalKeep.add(i); continue; }
  // ② 纯槽位语句 → 无条件留（见上方注释）
  const slotOnly = /^(?:var|let|const)\s+[\s\S]*$/.test(code.trim())
    && !/[A-Za-z_$][\w$]*\s*\(/.test(code)                     // 没有函数调用
    && /(=(\{\}|\[\]|""|0|void 0|null|!1|!0)\s*,?\s*)+;?$/.test(code.trim());
  if (code.length <= ALLOW_SMALL && slotOnly) { finalKeep.add(i); continue; }
  // ③ 剩下的：小工具 + 被多条语句共用
  if (code.length <= ALLOW_SMALL && decls.some(d => (refCount.get(d) || 0) >= 2)) { finalKeep.add(i); continue; }
  dropped.push(i);
}
const kept = [...finalKeep].sort((a, b) => a - b);
console.log('保留顶层语句:', kept.length, '/', userStmts.length, '（闸门丢弃 ' + dropped.length + ' 条）');

/* ---------- 4. 生成模块 ---------- */
const lines = [];
lines.push('/* DSH 客户端 React 运行时 —— 构建期从 DSH 前端产物里抽取，请勿手工修改。');
lines.push(' * 源文件 : ' + picked);
lines.push(' * 导出   : ' + wanted.map(w => w.name).join(', '));
lines.push(' *');
lines.push(' * 只保留 react / react-dom / react-dom/client 及其依赖的语句，');
lines.push(' * **剥掉了产物末尾的自启动代码** —— 那段会去找 #root 并把 DSH 应用跑起来，');
lines.push(' * 直接 import 原产物会在控制台里错误地启动一整个 DSH 前端。');
lines.push(' * 重新生成：node tools/extract-react-runtime.mjs');
lines.push(' *');
lines.push(' * ⚠️ 这里刻意不写抽取时间：文件内容要能被 sha256 稳定复现，');
lines.push(' *    否则同样一份 DSH 每次跑出来的文件名都不同，产物与版本对照就没法比。');
lines.push(' *    时间戳记在 manifest.json 里。 */');
const providedHere = new Set();
for (const i of kept) {
  lines.push('/* ── 语句 #' + i + ' ── */');
  lines.push(userStmts[i].code);
  for (const id of collectDecls(userStmts[i].code)) providedHere.add(id);
}
lines.push('');
lines.push('/* 对外只暴露这几个模块（形状与 DSH 种子表一致：react 等是带 default 的命名空间对象）。');
lines.push(' * ⚠️ 不能写 `export const ec = ec;` —— 那是自引用 TDZ，模块一加载就抛 ReferenceError。');
lines.push(' * 产物里的符号名是 mangle 出来的（DSH 升级会变），所以先取进对象再用稳定名字导出。 */');
lines.push('const _mods = {');
for (const w of wanted) {
  if (!providedHere.has(w.sym)) throw new Error('生成的模块里没有提供 ' + w.sym + '，抽取闭包不完整');
  lines.push('  ' + JSON.stringify(w.name) + ': ' + w.sym + ',');
}
lines.push('};');
lines.push('export default _mods;');
lines.push('export { _mods };');

const body = lines.join('\n');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
for (const f of fs.readdirSync(OUT)) if (/^react-runtime\..*\.js$/.test(f)) fs.unlinkSync(path.join(OUT, f));
const hash = createHash('sha256').update(body).digest('hex').slice(0, 12);
const file = 'react-runtime.' + hash + '.js';
fs.writeFileSync(path.join(OUT, file), body, 'utf8');
fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify({
  file, source: picked, at: new Date().toISOString(),
  exports: wanted.map(w => w.name), statements: kept.length,
}, null, 2));
console.log('写出 :', 'public/react/' + file, Math.round(body.length / 1024) + ' KB');

/* ---------- 5. 自查：立刻把产物 import 一遍，确认导出真的能跑 ----------
 * 光"文件生成成功"不等于"抽对了"—— 上游一改打包方式，可能抽出一个空壳。
 * 所以生成后马上验证，把静默失败挡在构建期。 */
try {
  const mod = (await import(new URL('../public/react/' + file, import.meta.url).href)).default || {};
  const checks = [
    ['react.createElement', () => typeof mod.react.createElement === 'function'],
    ['react.useState', () => typeof mod.react.useState === 'function'],
    ['react.useSyncExternalStore', () => typeof mod.react.useSyncExternalStore === 'function'],
    ['react-dom/client.createRoot', () => typeof mod['react-dom/client'].createRoot === 'function'],
    ['react-dom.createPortal', () => typeof mod['react-dom'].createPortal === 'function'],
    ['react/jsx-runtime.jsx', () => typeof mod['react/jsx-runtime'].jsx === 'function'],
    ['react/jsx-runtime.Fragment', () => typeof mod['react/jsx-runtime'].Fragment === 'symbol'],
  ];
  const miss = checks.filter(([, f]) => { try { return !f(); } catch { return true; } }).map(([n]) => n);
  if (miss.length) {
    console.error('!! 产物自查未通过，缺：' + miss.join('、') + ' —— 上游 DSH 前端结构可能变了，需要复核本脚本');
    process.exit(1);
  }
  console.log('自查 : React ' + mod.react.version + ' · 7 项导出断言全过（' + checks.length + ' 项）');
} catch (e) {
  console.error('!! 产物 import 失败：' + (e && e.message) + ' —— 抽取闭包可能不完整');
  process.exit(1);
}
