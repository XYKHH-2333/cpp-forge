/* 表达式解析器：把 "sin(x)/x + 2^x" 这种字符串编译成能快速求值的函数。
 *
 * 支持：
 *   数字（含 1e-3、.5）、x / y / t / θ（theta 或 th）
 *   常量 pi / π / e
 *   运算 + - * / ^ %   （^ 右结合，-x^2 按 -(x^2) 算）
 *   隐式乘法：2x、3(x+1)、(x+1)(x-1)、2sin(x)
 *   一元函数：sin cos tan cot sec csc asin acos atan asinh acosh atanh
 *             sinh cosh tanh ln lg log log2 log10 exp sqrt cbrt abs sign
 *             floor ceil round trunc frac
 *   二元函数：min max pow mod atan2 logb root gcd?（不做）
 *
 * 不依赖 eval / new Function，闭包编译，CSP 友好。
 */
(function (root) {
  'use strict';

  var CONST = { pi: Math.PI, 'π': Math.PI, e: Math.E, tau: Math.PI * 2 };
  var VARS = { x: 0, y: 1, t: 2, 'θ': 3, theta: 3, th: 3 };

  var FN1 = {
    sin: Math.sin, cos: Math.cos, tan: Math.tan,
    cot: function (v) { return 1 / Math.tan(v); },
    sec: function (v) { return 1 / Math.cos(v); },
    csc: function (v) { return 1 / Math.sin(v); },
    asin: Math.asin, acos: Math.acos, atan: Math.atan,
    sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,
    asinh: Math.asinh, acosh: Math.acosh, atanh: Math.atanh,
    ln: Math.log,
    lg: Math.log10, log10: Math.log10, log: Math.log10, log2: Math.log2,
    exp: Math.exp, sqrt: Math.sqrt, cbrt: Math.cbrt,
    abs: Math.abs, sign: Math.sign,
    floor: Math.floor, ceil: Math.ceil, round: Math.round,
    trunc: Math.trunc,
    frac: function (v) { return v - Math.trunc(v); },
    gamma: function (v) { return gammaFn(v); }
  };
  var FN2 = {
    min: Math.min, max: Math.max, pow: Math.pow,
    mod: function (a, b) { return a - b * Math.floor(a / b); },
    atan2: Math.atan2,
    logb: function (a, b) { return Math.log(b) / Math.log(a); },
    root: function (a, b) { return b < 0 && Math.abs(a % 2) === 1 ? -Math.pow(-b, 1 / a) : Math.pow(b, 1 / a); }
  };

  // Lanczos 近似的 Γ 函数（够画图用）
  var G = [676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012,
    9.9843695780195716e-6, 1.5056327351493116e-7];
  function gammaFn(z) {
    if (z < 0.5) return Math.PI / (Math.sin(Math.PI * z) * gammaFn(1 - z));
    z -= 1;
    var a = 0.99999999999980993, t = z + 7.5;
    for (var i = 0; i < G.length; i++) a += G[i] / (z + i + 1);
    return Math.sqrt(2 * Math.PI) * Math.pow(t, z + 0.5) * Math.exp(-t) * a;
  }

  // ── 输入归一化：把手机键盘打出来的数学符号翻译成表达式 ─────────────
  // ²³⁴… → ^2 ^3；√ → sqrt；∧ → ^；× → *；π → pi；全角符号 → 半角……
  var SUP = { '⁰':'0','¹':'1','²':'2','³':'3','⁴':'4','⁵':'5','⁶':'6','⁷':'7','⁸':'8','⁹':'9' };

  function normalize(raw) {
    var s = String(raw == null ? '' : raw);

    // 1) 全角 → 半角（中文键盘经常打出全角括号和加减号）
    s = s.replace(/[\uFF01-\uFF5E]/g, function (ch) {
      return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0);
    });
    s = s.replace(/\u3000/g, ' ');

    // 2) 各种"减号"统一成 -
    s = s.replace(/[\u2212\u2013\u2014\u2015\uFE63\uFF0D]/g, '-');

    // 3) 上标数字 → 幂：x² → x^2，sin²x 之类按 (sin(x))^2 处理
    s = s.replace(/([⁰¹²³⁴⁵⁶⁷⁸⁹]+)/g, function (m) {
      var n = m.split('').map(function (c) { return SUP[c]; }).join('');
      return '^' + n;
    });

    // 4) 运算符别名
    s = s.replace(/[∧^]{1}/g, '^');            // ∧ 也表示乘方
    s = s.replace(/[×·⋅∙∗]/g, '*');
    s = s.replace(/[÷∕]/g, '/');
    s = s.replace(/[−–—]/g, '-');
    s = s.replace(/[∣丨]/g, '|');

    // 5) 常量与根号
    s = s.replace(/π/g, 'pi');
    s = s.replace(/∞/g, 'Infinity');
    s = s.replace(/∛/g, 'cbrt');
    s = s.replace(/∜/g, 'sqrtsqrt');            // 极少见，兜底
    s = s.replace(/√/g, 'sqrt');

    // 6) 根号后面没括号就补一个：√x → sqrt(x)，√2x → sqrt(2x)
    s = s.replace(/\b(sqrt|cbrt)\s*(?!\()([a-zA-Z0-9_.]+)/g, function (m, fn, arg) {
      return fn + '(' + arg + ')';
    });

    // 7) sin²(x) → (sin(x))^2 ：函数名后的幂要作用在整个函数值上
    s = fixFnPow(s);

    // 8) 中文标点
    s = s.replace(/[，、]/g, ',');
    s = s.replace(/[（]/g, '(').replace(/[）]/g, ')');
    s = s.replace(/[：]/g, ':');

    return s;
  }

  function tokenize(src) {
    var s = String(src).replace(/θ/g, ' th ');
    var out = [], i = 0, n = s.length;
    while (i < n) {
      var c = s[i];
      if (/\s/.test(c)) { i++; continue; }
      if (/[0-9.]/.test(c)) {
        var j = i, dot = 0;
        while (j < n && /[0-9.]/.test(s[j])) { if (s[j] === '.') dot++; j++; }
        if (dot > 1) throw new Error('数字格式错误：' + s.slice(i, j));
        // 科学计数法 1e-3 / 2E5
        if (j < n && /[eE]/.test(s[j]) && /[0-9+-]/.test(s[j + 1] || '')) {
          var k = j + 1;
          if (/[+-]/.test(s[k])) k++;
          if (/[0-9]/.test(s[k])) { while (k < n && /[0-9]/.test(s[k])) k++; j = k; }
        }
        out.push({ t: 'num', v: parseFloat(s.slice(i, j)) });
        i = j; continue;
      }
      if (/[a-zA-Z_π]/.test(c)) {
        var e = i;
        while (e < n && /[a-zA-Z0-9_π]/.test(s[e])) e++;
        out.push({ t: 'id', v: s.slice(i, e) });
        i = e; continue;
      }
      if ('+-*/^%(),'.indexOf(c) >= 0) { out.push({ t: c }); i++; continue; }
      throw new Error('看不懂的字符：' + c);
    }
    return out;
  }

  // sin^2(x) / sin^2 x → (sin(x))^2
  var FN_NAMES = 'sin|cos|tan|cot|sec|csc|asin|acos|atan|sinh|cosh|tanh|ln|lg|log|log2|log10|exp|sqrt|cbrt|abs|sign';

  function fixFnPow(str) {
    var re = new RegExp('\\b(' + FN_NAMES + ')\\s*\\^\\s*([0-9]+)\\s*(\\(|[a-zA-Zπ]|[0-9.]|$)', 'g');
    var out = '', last = 0, m;
    while ((m = re.exec(str)) !== null) {
      var fn = m[1], exp = m[2];
      var open = str.indexOf('(', m.index);
      var inner = null, end = -1;
      if (open === m.index + m[0].length - 1) {
        // 后面直接跟括号：找到配对的右括号
        var depth = 0;
        for (var i = open; i < str.length; i++) {
          if (str[i] === '(') depth++;
          else if (str[i] === ')') { depth--; if (depth === 0) { end = i; break; } }
        }
        if (end > 0) inner = str.slice(open + 1, end);
      }
      if (inner === null) {
        // 没括号：吃后面一个"项"（变量 / 数字 / 常量）
        var mt = /^\s*([a-zA-Zπ]+|[0-9.]+)/.exec(str.slice(m.index + m[0].length - 1));
        if (!mt) continue;
        inner = mt[1];
        end = (m.index + m[0].length - 1) + (mt.index + mt[0].length) - 1;
      }
      out += str.slice(last, m.index) + '(' + fn + '(' + inner + '))^' + exp;
      last = end + 1;
      re.lastIndex = end + 1;
    }
    return out + str.slice(last);
  }

  function parse(_src) {
    var src = normalize(_src);
    var tk = tokenize(src), p = 0;
    function peek() { return tk[p]; }
    function eat(t) {
      if (tk[p] && tk[p].t === t) { p++; return true; }
      return false;
    }
    function expect(t, what) {
      if (!eat(t)) throw new Error('缺少 ' + (what || t));
    }
    // 一个记号能否开始一个"操作数"（用于识别隐式乘法）
    function startsOperand(tok) {
      if (!tok) return false;
      return tok.t === 'num' || tok.t === 'id' || tok.t === '(';
    }

    function parseExpr() {
      var node = parseTerm();
      for (;;) {
        if (eat('+')) node = { t: 'add', a: node, b: parseTerm() };
        else if (eat('-')) node = { t: 'sub', a: node, b: parseTerm() };
        else break;
      }
      return node;
    }
    function parseTerm() {
      var node = parseUnary();
      for (;;) {
        if (eat('*')) node = { t: 'mul', a: node, b: parseUnary() };
        else if (eat('/')) node = { t: 'div', a: node, b: parseUnary() };
        else if (eat('%')) node = { t: 'mod', a: node, b: parseUnary() };
        else if (startsOperand(peek())) node = { t: 'mul', a: node, b: parseUnary() };
        else break;
      }
      return node;
    }
    function parseUnary() {
      if (eat('-')) return { t: 'neg', a: parseUnary() };
      if (eat('+')) return parseUnary();
      return parsePower();
    }
    function parsePower() {
      var base = parsePrimary();
      if (eat('^')) return { t: 'pow', a: base, b: parseUnary() };   // 右结合
      return base;
    }
    function parsePrimary() {
      var tok = peek();
      if (!tok) throw new Error('表达式不完整');
      if (tok.t === 'num') { p++; return { t: 'num', v: tok.v }; }
      if (tok.t === '(') { p++; var e = parseExpr(); expect(')', '）'); return e; }
      if (tok.t === 'id') {
        p++;
        var name = tok.v;
        if (eat('(')) {
          var args = [parseExpr()];
          while (eat(',')) args.push(parseExpr());
          expect(')', '）');
          var nm = name.toLowerCase();
          if (FN1[nm]) return { t: 'fn1', f: nm, a: args[0] };
          if (FN2[nm]) {
            if (args.length !== 2) throw new Error(nm + ' 需要 2 个参数');
            return { t: 'fn2', f: nm, a: args[0], b: args[1] };
          }
          throw new Error('不认识的函数：' + name);
        }
        var low = name.toLowerCase();
        if (low in VARS) return { t: 'var', i: VARS[low] };
        if (low in CONST) return { t: 'num', v: CONST[low] };
        if (low === 'x' || low === 'y' || low === 't') return { t: 'var', i: VARS[low] };
        throw new Error('不认识的符号：' + name);
      }
      throw new Error('这里不该出现：' + tok.t);
    }

    var ast = parseExpr();
    if (p < tk.length) throw new Error('多余的内容：' + JSON.stringify(tk[p].v || tk[p].t));
    return ast;
  }

  // AST → 闭包。参数顺序固定为 (x, y, th)，用不到的忽略。
  function compile(node) {
    switch (node.t) {
      case 'num': var v = node.v; return function () { return v; };
      case 'var': var i = node.i; return function (x, y, th) {
        return i === 0 ? x : i === 1 ? y : th;
      };
      case 'neg': var a0 = compile(node.a); return function (x, y, th) { return -a0(x, y, th); };
      case 'add': var a1 = compile(node.a), b1 = compile(node.b);
        return function (x, y, th) { return a1(x, y, th) + b1(x, y, th); };
      case 'sub': var a2 = compile(node.a), b2 = compile(node.b);
        return function (x, y, th) { return a2(x, y, th) - b2(x, y, th); };
      case 'mul': var a3 = compile(node.a), b3 = compile(node.b);
        return function (x, y, th) { return a3(x, y, th) * b3(x, y, th); };
      case 'div': var a4 = compile(node.a), b4 = compile(node.b);
        return function (x, y, th) { return a4(x, y, th) / b4(x, y, th); };
      case 'mod': var a5 = compile(node.a), b5 = compile(node.b);
        return function (x, y, th) { var u = a5(x, y, th), w = b5(x, y, th); return u - w * Math.floor(u / w); };
      case 'pow': var a6 = compile(node.a), b6 = compile(node.b);
        return function (x, y, th) {
          var base = a6(x, y, th), ex = b6(x, y, th);
          if (base < 0 && Math.abs(ex % 1) > 1e-12) {
            // 负数的非整数次幂：只在分母为奇数时有实数值
            var d = 1 / ex;
            if (Math.abs(d % 2) > 1e-9 && Math.abs((d % 2) - 1) > 1e-9) return NaN;
            return -Math.pow(-base, ex);
          }
          return Math.pow(base, ex);
        };
      case 'fn1': var a7 = compile(node.a), f1 = FN1[node.f];
        return function (x, y, th) { return f1(a7(x, y, th)); };
      case 'fn2': var a8 = compile(node.a), b8 = compile(node.b), f2 = FN2[node.f];
        return function (x, y, th) { return f2(a8(x, y, th), b8(x, y, th)); };
    }
    throw new Error('内部错误：未知节点 ' + node.t);
  }

  root.ExprParser = {
    parse: parse,
    compile: compile,
    compileString: function (src) { return compile(parse(src)); },
    normalize: normalize,
    FN1: FN1, FN2: FN2
  };
})(typeof window !== 'undefined' ? window : globalThis);
