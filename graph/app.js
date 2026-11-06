/* 函数绘图器主程序
 * ───────────────────────────────────────────────────────────────
 * 画布坐标变换、网格、曲线采样、双指缩放、点击取坐标。
 */
(function () {
  'use strict';
  var P = window.ExprParser;

  // ── 状态 ────────────────────────────────────────────────────────
  var COLORS = ['#4c8dff', '#ff6b6b', '#3ddc97', '#ffb454', '#b06bff',
    '#22d3ee', '#f472b6', '#a3e635'];
  var STORE = 'graph-forge.v1';

  var state = {
    funcs: [],
    view: { cx: 0, cy: 0, ppu: 42 },     // ppu = 每个单位多少像素
    grid: true,
    axes: true,
    theme: 'auto',
    paramRange: [0, Math.PI * 2]
  };

  function save() {
    try {
      localStorage.setItem(STORE, JSON.stringify({
        funcs: state.funcs, view: state.view, grid: state.grid,
        axes: state.axes, theme: state.theme, paramRange: state.paramRange
      }));
    } catch (e) { /* 存不下就算了 */ }
  }
  function load() {
    try {
      var raw = localStorage.getItem(STORE);
      if (!raw) return;
      var d = JSON.parse(raw);
      if (Array.isArray(d.funcs)) state.funcs = d.funcs;
      if (d.view) state.view = d.view;
      if (typeof d.grid === 'boolean') state.grid = d.grid;
      if (typeof d.axes === 'boolean') state.axes = d.axes;
      if (d.theme) state.theme = d.theme;
      if (Array.isArray(d.paramRange)) state.paramRange = d.paramRange;
    } catch (e) { }
  }

  var uid = 1;
  function nextId() { return 'f' + (uid++) + '_' + Math.random().toString(36).slice(2, 6); }

  function addFunc(text, mode, color) {
    var f = {
      id: nextId(),
      text: text || '',
      mode: mode || 'y',
      color: color || COLORS[state.funcs.length % COLORS.length],
      visible: true,
      error: ''
    };
    state.funcs.push(f);
    compileFunc(f);
    return f;
  }

  function compileFunc(f) {
    f.error = '';
    f.fn = null;
    f.fn2 = null;
    try {
      f.normalized = P.normalize ? P.normalize(f.text) : f.text;
    } catch (e2) { f.normalized = f.text; }
    if (!f.text.trim()) return;
    try {
      if (f.mode === 'param') {
        var parts = f.text.split(';');
        if (parts.length !== 2) throw new Error('参数方程要写两段，用分号隔开：cos(3t); sin(2t)');
        f.fn = P.compileString(parts[0]);
        f.fn2 = P.compileString(parts[1]);
      } else {
        f.fn = P.compileString(f.text);
      }
    } catch (e) {
      f.error = e.message || String(e);
    }
  }

  // ── 画布与坐标变换 ─────────────────────────────────────────────
  var canvas = document.getElementById('cv');
  var ctx = canvas.getContext('2d');
  var ovl = document.getElementById('ov');
  var octx = ovl.getContext('2d');
  var DPR = Math.min(window.devicePixelRatio || 1, 2.5);
  var W = 0, H = 0;

  function resize() {
    var r = canvas.getBoundingClientRect();
    W = Math.max(1, Math.round(r.width));
    H = Math.max(1, Math.round(r.height));
    canvas.width = Math.round(W * DPR);
    canvas.height = Math.round(H * DPR);
    ovl.width = Math.round(W * DPR);
    ovl.height = Math.round(H * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    octx.setTransform(DPR, 0, 0, DPR, 0, 0);
    draw();
  }

  function toScreenX(x) { return W / 2 + (x - state.view.cx) * state.view.ppu; }
  function toScreenY(y) { return H / 2 - (y - state.view.cy) * state.view.ppu; }
  function toWorldX(sx) { return state.view.cx + (sx - W / 2) / state.view.ppu; }
  function toWorldY(sy) { return state.view.cy - (sy - H / 2) / state.view.ppu; }

  // 主题色
  function colors() {
    var dark = state.theme === 'dark' ||
      (state.theme === 'auto' && window.matchMedia &&
        window.matchMedia('(prefers-color-scheme: dark)').matches);
    return dark
      ? { bg: '#0f1115', grid: '#1b222d', grid2: '#2b3648', axis: '#9aa7bf', text: '#a9b4c6', fg: '#e6e9ef', tip: '#161a21' }
      : { bg: '#ffffff', grid: '#f1f4f8', grid2: '#e1e7ef', axis: '#556070', text: '#556070', fg: '#1b1f27', tip: '#ffffff' };
  }

  // 取一个"好看"的网格步长：1/2/5 × 10^k
  function niceStep(raw) {
    var e = Math.floor(Math.log10(raw));
    var m = raw / Math.pow(10, e);
    var s = m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10;
    return s * Math.pow(10, e);
  }

  function fmt(v, step) {
    if (!isFinite(v)) return '';
    if (Math.abs(v) < 1e-12) return '0';
    var d = Math.max(0, Math.min(6, -Math.floor(Math.log10(Math.abs(step || 1))) + 1));
    var s = v.toFixed(d);
    s = s.replace(/\.?0+$/, '');
    if (Math.abs(v) >= 1e5 || Math.abs(v) < 1e-4) s = v.toExponential(1).replace('e+', 'e');
    return s;
  }

  // ── 绘图 ────────────────────────────────────────────────────────
  var lastPaths = [];      // 供点击取点用

  // ── 网格 / 坐标轴（重写版：整数索引，杜绝浮点累加导致的错位）─────
  function idxRange(w0, w1, step) {
    return [Math.ceil(w0 / step), Math.floor(w1 / step)];
  }

  function drawGridAxes(C) {
    var ppu = state.view.ppu;
    // 主刻度目标间距 ~86 屏幕像素
    var step = niceStep(86 / ppu);
    var minor = step / 5;
    var wx0 = toWorldX(0), wx1 = toWorldX(W);
    var wy0 = toWorldY(H), wy1 = toWorldY(0);   // 注意：屏幕下边对应世界 y 的最小值

    if (state.grid) {
      // 次网格
      ctx.strokeStyle = C.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      var ax0 = idxRange(wx0, wx1, minor), ay0 = idxRange(wy0, wy1, minor);
      for (var i = ax0[0]; i <= ax0[1]; i++) {
        var vx = i * minor;
        if (Math.abs(vx) < minor * 1e-9) continue;
        var px = Math.round(toScreenX(vx)) + 0.5;
        if (px < 0 || px > W) continue;
        ctx.moveTo(px, 0); ctx.lineTo(px, H);
      }
      for (var j = ay0[0]; j <= ay0[1]; j++) {
        var vy = j * minor;
        if (Math.abs(vy) < minor * 1e-9) continue;
        var py = Math.round(toScreenY(vy)) + 0.5;
        if (py < 0 || py > H) continue;
        ctx.moveTo(0, py); ctx.lineTo(W, py);
      }
      ctx.globalAlpha = 0.5; ctx.stroke(); ctx.globalAlpha = 1;

      // 主网格
      ctx.strokeStyle = C.grid2;
      ctx.beginPath();
      var bx0 = idxRange(wx0, wx1, step), by0 = idxRange(wy0, wy1, step);
      for (var k = bx0[0]; k <= bx0[1]; k++) {
        var mx = k * step;
        if (Math.abs(mx) < step * 1e-9) continue;
        var sx = Math.round(toScreenX(mx)) + 0.5;
        if (sx < 0 || sx > W) continue;
        ctx.moveTo(sx, 0); ctx.lineTo(sx, H);
      }
      for (var m = by0[0]; m <= by0[1]; m++) {
        var my = m * step;
        if (Math.abs(my) < step * 1e-9) continue;
        var sy = Math.round(toScreenY(my)) + 0.5;
        if (sy < 0 || sy > H) continue;
        ctx.moveTo(0, sy); ctx.lineTo(W, sy);
      }
      ctx.stroke();
    }

    if (!state.axes) return;

    // ── 坐标轴 ──
    var axY = Math.round(toScreenY(0)) + 0.5;      // x 轴所在屏幕行
    var ayX = Math.round(toScreenX(0)) + 0.5;      // y 轴所在屏幕列
    var xVisible = axY >= 0 && axY <= H;
    var yVisible = ayX >= 0 && ayX <= W;

    ctx.strokeStyle = C.axis;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    if (xVisible) { ctx.moveTo(0, axY); ctx.lineTo(W, axY); }
    if (yVisible) { ctx.moveTo(ayX, 0); ctx.lineTo(ayX, H); }
    ctx.stroke();

    // ── 刻度线 ──
    var tickLen = 5;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    var tx0 = idxRange(wx0, wx1, step), ty0 = idxRange(wy0, wy1, step);
    if (xVisible) {
      for (var t = tx0[0]; t <= tx0[1]; t++) {
        var tvx = t * step;
        if (Math.abs(tvx) < step * 1e-9) continue;
        var tpx = Math.round(toScreenX(tvx)) + 0.5;
        if (tpx < 2 || tpx > W - 2) continue;
        ctx.moveTo(tpx, axY - tickLen); ctx.lineTo(tpx, axY + tickLen);
      }
    }
    if (yVisible) {
      for (var u = ty0[0]; u <= ty0[1]; u++) {
        var tvy = u * step;
        if (Math.abs(tvy) < step * 1e-9) continue;
        var tpy = Math.round(toScreenY(tvy)) + 0.5;
        if (tpy < 2 || tpy > H - 2) continue;
        ctx.moveTo(ayX - tickLen, tpy); ctx.lineTo(ayX + tickLen, tpy);
      }
    }
    ctx.stroke();

    // ── 刻度数字 ──
    // 轴跑出画面时，把数字贴到屏幕边缘，始终看得见
    var labelRow = xVisible ? Math.min(Math.max(axY + tickLen + 3, 3), H - 15)
      : (toScreenY(0) > H ? H - 16 : 3);
    var labelCol = yVisible ? Math.min(Math.max(ayX - tickLen - 4, 40), W - 6)
      : (toScreenX(0) > W ? W - 6 : 40);

    ctx.font = '600 11.5px ui-monospace,SFMono-Regular,Menlo,monospace';
    ctx.fillStyle = C.text;

    // 数字背后的底色，压在网格线上也读得清
    function halo(x, y, w, h) {
      ctx.save();
      ctx.globalAlpha = 0.82;
      ctx.fillStyle = C.bg;
      ctx.fillRect(x - 2, y - 1, w + 4, h + 2);
      ctx.restore();
      ctx.fillStyle = C.text;
    }

    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (var v = tx0[0]; v <= tx0[1]; v++) {
      var lv = v * step;
      if (Math.abs(lv) < step * 1e-9) continue;
      var lpx = toScreenX(lv);
      if (lpx < 20 || lpx > W - 20) continue;
      var label = fmt(lv, step);
      var wpx = ctx.measureText(label).width;
      halo(lpx - wpx / 2, labelRow, wpx, 13);
      ctx.fillText(label, lpx, labelRow);
    }

    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (var q = ty0[0]; q <= ty0[1]; q++) {
      var lvy = q * step;
      if (Math.abs(lvy) < step * 1e-9) continue;
      var lpy = toScreenY(lvy);
      if (lpy < 10 || lpy > H - 10) continue;
      var labelY = fmt(lvy, step);
      var wpy = ctx.measureText(labelY).width;
      halo(labelCol - wpy, lpy - 7, wpy, 14);
      ctx.textAlign = 'right';
      ctx.fillText(labelY, labelCol, lpy);
    }

    // ── 原点 O 与轴名 ──
    if (xVisible && yVisible) {
      ctx.textAlign = 'right'; ctx.textBaseline = 'top';
      halo(ayX - 16, axY + 4, 12, 13);
      ctx.fillText('O', ayX - 5, axY + 4);
    }
    ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
    if (xVisible) {
      ctx.fillStyle = C.axis;
      ctx.font = 'italic 600 13px ui-serif,Georgia,serif';
      ctx.fillText('x', W - 6, axY - 4);
    }
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    if (yVisible) {
      ctx.fillStyle = C.axis;
      ctx.font = 'italic 600 13px ui-serif,Georgia,serif';
      ctx.fillText('y', ayX + 6, 6);
    }
  }

  function draw() {
    var C = colors();
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, W, H);

    drawGridAxes(C);

    // 曲线
    lastPaths = [];
    for (var i = 0; i < state.funcs.length; i++) {
      var f = state.funcs[i];
      if (!f.visible || f.error || !f.fn) continue;
      var pts = f.mode === 'implicit' ? sampleImplicit(f)
        : f.mode === 'polar' ? samplePolar(f)
          : f.mode === 'param' ? sampleParam(f)
            : sampleExplicit(f);
      lastPaths.push({ f: f, pts: pts });
      strokePath(pts, f.color);
    }

    drawIntersections(C);   // 多条曲线的交点
    drawEvalPoints(C);      // "输入 x 求 y" 的标记点
    drawMarker();
  }

  // 多条曲线的交点：扫描符号变化 + 二分细化
  function computeIntersections() {
    var ys = [];
    for (var i = 0; i < state.funcs.length; i++) {
      var f = state.funcs[i];
      if (!f.visible || f.error || !f.fn || f.mode !== 'y') continue;
      ys.push(f);
    }
    var out = [];
    if (ys.length < 2) return out;

    function val(f, x) {
      try { var v = f.fn(x, 0, 0); return isFinite(v) ? v : NaN; } catch (e) { return NaN; }
    }
    // 屏幕像素步长：每 3px 采一次，足够找到所有交点
    var stepX = 3;
    for (var a = 0; a < ys.length; a++) {
      for (var b = a + 1; b < ys.length; b++) {
        var f1 = ys[a], f2 = ys[b];
        var prevX = null, prevD = NaN;
        var prevAbs = NaN, prev2Abs = NaN, prev2X = NaN;
        for (var sx = 0; sx <= W; sx += stepX) {
          var wx = toWorldX(sx);
          var v1 = val(f1, wx), v2 = val(f2, wx);
          if (!isFinite(v1) || !isFinite(v2)) {
            prevX = null; prevD = NaN; prevAbs = NaN; prev2Abs = NaN; continue;
          }
          var dv = v1 - v2;
          var absD = Math.abs(dv) * state.view.ppu;      // 屏幕像素上的差值
          // 相切（重根）检测：|差值| 先降后升，且极小值足够小
          if (isFinite(prev2Abs) && isFinite(prevAbs)
              && prevAbs <= prev2Abs && prevAbs <= absD && prevAbs < 1.5) {
            // 用三分法把切点位置再逼近一下（相切时差值最小处才是真正交点）
            var lo3 = prev2X, hi3 = wx;
            for (var it3 = 0; it3 < 30; it3++) {
              var m1 = lo3 + (hi3 - lo3) / 3, m2 = hi3 - (hi3 - lo3) / 3;
              var d1 = Math.abs(val(f1, m1) - val(f2, m1));
              var d2 = Math.abs(val(f1, m2) - val(f2, m2));
              if (!isFinite(d1) || !isFinite(d2)) break;
              if (d1 < d2) hi3 = m2; else lo3 = m1;
            }
            var tx3 = (lo3 + hi3) / 2;
            var iy2 = val(f1, tx3);
            prevX = tx3;
            if (isFinite(iy2)) {
              var dup2 = false;
              for (var k2 = 0; k2 < out.length; k2++) {
                if (Math.abs(out[k2].x - prevX) * state.view.ppu < 3) { dup2 = true; break; }
              }
              if (!dup2 && out.length < 40) out.push({ x: prevX, y: iy2, c: f1.color });
            }
          }
          prev2Abs = prevAbs; prev2X = prevX;
          prevAbs = absD;
          if (prevX !== null && isFinite(prevD) && prevD * dv <= 0 && Math.abs(prevD - dv) < 1e6) {
            // 二分细化到 1e-6 精度
            var lo = prevX, hi = wx, flo = prevD;
            for (var it = 0; it < 40; it++) {
              var mid = (lo + hi) / 2;
              var fm = val(f1, mid) - val(f2, mid);
              if (!isFinite(fm)) break;
              if (flo * fm <= 0) { hi = mid; } else { lo = mid; flo = fm; }
            }
            var ix = (lo + hi) / 2;
            var iy = val(f1, ix);
            if (isFinite(iy)) {
              // 去重（同一点可能被相邻区间重复找到）
              var dup = false;
              for (var k = 0; k < out.length; k++) {
                if (Math.abs(out[k].x - ix) * state.view.ppu < 3 &&
                    Math.abs(out[k].y - iy) * state.view.ppu < 3) { dup = true; break; }
              }
              if (!dup && out.length < 40) out.push({ x: ix, y: iy, c: f1.color });
            }
          }
          prevX = wx; prevD = dv;
        }
      }
    }
    return out;
  }

  function drawIntersections(C) {
    var pts = computeIntersections();
    if (!pts.length) return;
    var step = niceStep(86 / state.view.ppu);
    for (var i = 0; i < pts.length; i++) {
      var p = pts[i];
      var sx = toScreenX(p.x), sy = toScreenY(p.y);
      if (sx < -50 || sx > W + 50 || sy < -50 || sy > H + 50) continue;
      ctx.save();
      // 空心菱形，和函数颜色区分开
      ctx.beginPath();
      ctx.moveTo(sx, sy - 6); ctx.lineTo(sx + 6, sy);
      ctx.lineTo(sx, sy + 6); ctx.lineTo(sx - 6, sy);
      ctx.closePath();
      ctx.fillStyle = C.bg;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = 0xFFFFFFFF;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(sx, sy, 2.2, 0, Math.PI * 2);
      ctx.fillStyle = 0xFFFFFFFF;
      ctx.fill();

      var txt = '(' + fmt(p.x, step * 0.01) + ', ' + fmt(p.y, step * 0.01) + ')';
      ctx.font = '600 10.5px ui-monospace,SFMono-Regular,Menlo,monospace';
      var tw = ctx.measureText(txt).width;
      var lx = sx + 9, ly = sy + 14;
      if (lx + tw > W - 4) lx = sx - tw - 9;
      if (ly > H - 6) ly = sy - 14;
      ctx.globalAlpha = 0.85;
      ctx.fillStyle = C.bg;
      ctx.fillRect(lx - 3, ly - 9, tw + 6, 13);
      ctx.globalAlpha = 1;
      ctx.fillStyle = C.axis;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(txt, lx, ly - 2);
      ctx.restore();
    }
  }

  // 每个函数"输入 x 求 y"后在图上的标记点 + 坐标标签
  function drawEvalPoints(C) {
    var step = niceStep(86 / state.view.ppu);
    for (var i = 0; i < state.funcs.length; i++) {
      var f = state.funcs[i];
      if (!f.visible || f.error || !f.fn || f.mode !== 'y') continue;
      if (f.evalX === null || f.evalX === undefined) continue;
      if (f.evalY === null || f.evalY === undefined || !isFinite(f.evalY)) continue;
      var sx = toScreenX(f.evalX), sy = toScreenY(f.evalY);
      if (sx < -200 || sx > W + 200 || sy < -200 || sy > H + 200) continue;

      ctx.save();
      ctx.beginPath();
      ctx.arc(sx, sy, 6, 0, Math.PI * 2);
      ctx.fillStyle = f.color;
      ctx.fill();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = C.bg;
      ctx.stroke();

      var txt = '(' + fmt(f.evalX, step * 0.01) + ', ' + fmt(f.evalY, step * 0.01) + ')';
      ctx.font = '600 11px ui-monospace,SFMono-Regular,Menlo,monospace';
      var tw = ctx.measureText(txt).width;
      var lx = sx + 10, ly = sy - 12;
      if (lx + tw > W - 4) lx = sx - tw - 10;
      if (ly < 10) ly = sy + 18;
      ctx.globalAlpha = 0.88;
      ctx.fillStyle = C.bg;
      ctx.fillRect(lx - 3, ly - 13, tw + 6, 16);
      ctx.globalAlpha = 1;
      ctx.fillStyle = f.color;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(txt, lx, ly - 5);
      ctx.restore();
    }
  }

  // 标记点单独画在叠加层：曲线不动时只重画这一层，手指拖动才跟手
  function drawMarker() {
    var C = colors();
    octx.clearRect(0, 0, W, H);
    if (!marker) return;
    octx.save();
    octx.beginPath();
    octx.moveTo(marker.sx, 0); octx.lineTo(marker.sx, H);
    octx.moveTo(0, marker.sy); octx.lineTo(W, marker.sy);
    octx.strokeStyle = marker.color || C.axis;
    octx.globalAlpha = 0.42;
    octx.setLineDash([5, 5]);
    octx.lineWidth = 1;
    octx.stroke();
    octx.globalAlpha = 1;
    octx.setLineDash([]);
    octx.beginPath();
    octx.arc(marker.sx, marker.sy, 7, 0, Math.PI * 2);
    octx.fillStyle = marker.color || C.fg;
    octx.fill();
    octx.lineWidth = 2.5;
    octx.strokeStyle = C.bg;
    octx.stroke();
    octx.restore();
  }

  function strokePath(segments, color) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (var s = 0; s < segments.length; s++) {
      var seg = segments[s];
      if (seg.length < 2) continue;
      ctx.moveTo(seg[0].sx, seg[0].sy);
      for (var i = 1; i < seg.length; i++) ctx.lineTo(seg[i].sx, seg[i].sy);
    }
    ctx.stroke();
  }

  // 显式 y=f(x)：按屏幕列采样
  function sampleExplicit(f) {
    var segs = [], cur = [], prevSy = null, limit = H * 3;
    var stepX = 1;      // 每一列都采样：点哪就是哪，不会因为采样间隔跳一格
    for (var sx = 0; sx <= W; sx += stepX) {
      var wx = toWorldX(sx);
      var wy;
      try { wy = f.fn(wx, 0, 0); } catch (e) { wy = NaN; }
      if (!isFinite(wy)) { if (cur.length > 1) segs.push(cur); cur = []; prevSy = null; continue; }
      var sy = toScreenY(wy);
      if (sy < -limit || sy > H + limit) { if (cur.length > 1) segs.push(cur); cur = []; prevSy = null; continue; }
      // 竖直渐近线：相邻点跨度过大就断开，别连出一条假直线
      if (prevSy !== null && Math.abs(sy - prevSy) > H * 1.5) {
        if (cur.length > 1) segs.push(cur);
        cur = [];
      }
      cur.push({ wx: wx, wy: wy, sx: sx, sy: sy });
      prevSy = sy;
    }
    if (cur.length > 1) segs.push(cur);
    return segs;
  }

  // 参数方程
  function sampleParam(f) {
    var segs = [], cur = [];
    var t0 = state.paramRange[0], t1 = state.paramRange[1];
    var N = 1400;
    for (var i = 0; i <= N; i++) {
      var t = t0 + (t1 - t0) * i / N;
      var wx, wy;
      try { wx = f.fn(t, 0, t); wy = f.fn2(t, 0, t); } catch (e) { wx = NaN; wy = NaN; }
      if (!isFinite(wx) || !isFinite(wy)) { if (cur.length > 1) segs.push(cur); cur = []; continue; }
      var sx = toScreenX(wx), sy = toScreenY(wy);
      if (sx < -W * 2 || sx > W * 3 || sy < -H * 2 || sy > H * 3) { if (cur.length > 1) segs.push(cur); cur = []; continue; }
      cur.push({ wx: wx, wy: wy, sx: sx, sy: sy });
    }
    if (cur.length > 1) segs.push(cur);
    return segs;
  }

  // 极坐标 r=f(θ)
  function samplePolar(f) {
    var segs = [], cur = [];
    var N = 1600, T = Math.PI * 2;
    for (var i = 0; i <= N; i++) {
      var th = T * i / N, r;
      try { r = f.fn(0, 0, th); } catch (e) { r = NaN; }
      if (!isFinite(r)) { if (cur.length > 1) segs.push(cur); cur = []; continue; }
      var wx = r * Math.cos(th), wy = r * Math.sin(th);
      var sx = toScreenX(wx), sy = toScreenY(wy);
      if (sx < -W * 3 || sx > W * 4 || sy < -H * 3 || sy > H * 4) { if (cur.length > 1) segs.push(cur); cur = []; continue; }
      cur.push({ wx: wx, wy: wy, sx: sx, sy: sy });
    }
    if (cur.length > 1) segs.push(cur);
    return segs;
  }

  // 隐函数 F(x,y)=0：行进方块法（marching squares）
  function sampleImplicit(f) {
    var NX = 110, NY = 90;
    if (W > 900) { NX = 150; NY = 120; }
    var grid = [], i, j;
    for (j = 0; j <= NY; j++) {
      grid[j] = [];
      var wy = toWorldY(H * j / NY);
      for (i = 0; i <= NX; i++) {
        var wx = toWorldX(W * i / NX);
        var v;
        try { v = f.fn(wx, wy, 0); } catch (e) { v = NaN; }
        grid[j][i] = isFinite(v) ? v : NaN;
      }
    }
    var segs = [];
    function sxOf(i) { return W * i / NX; }
    function syOf(j) { return H * j / NY; }
    function wxOf(i) { return toWorldX(W * i / NX); }
    function wyOf(j) { return toWorldY(H * j / NY); }
    function lerp(a, b, va, vb) { var d = va - vb; return Math.abs(d) < 1e-12 ? 0.5 : va / d; }

    for (j = 0; j < NY; j++) {
      for (i = 0; i < NX; i++) {
        var v00 = grid[j][i], v10 = grid[j][i + 1], v01 = grid[j + 1][i], v11 = grid[j + 1][i + 1];
        if (!isFinite(v00) || !isFinite(v10) || !isFinite(v01) || !isFinite(v11)) continue;
        var idx = 0;
        if (v00 > 0) idx |= 1;
        if (v10 > 0) idx |= 2;
        if (v11 > 0) idx |= 4;
        if (v01 > 0) idx |= 8;
        if (idx === 0 || idx === 15) continue;

        var pts = [];
        // 上边 00-10
        if (((idx & 1) > 0) !== ((idx & 2) > 0)) {
          var t1 = lerp(0, 1, v00, v10);
          pts.push({ wx: wxOf(i) + (wxOf(i + 1) - wxOf(i)) * t1, wy: wyOf(j), sx: sxOf(i) + (sxOf(i + 1) - sxOf(i)) * t1, sy: syOf(j) });
        }
        // 右边 10-11
        if (((idx & 2) > 0) !== ((idx & 4) > 0)) {
          var t2 = lerp(0, 1, v10, v11);
          pts.push({ wx: wxOf(i + 1), wy: wyOf(j) + (wyOf(j + 1) - wyOf(j)) * t2, sx: sxOf(i + 1), sy: syOf(j) + (syOf(j + 1) - syOf(j)) * t2 });
        }
        // 下边 01-11
        if (((idx & 8) > 0) !== ((idx & 4) > 0)) {
          var t3 = lerp(0, 1, v01, v11);
          pts.push({ wx: wxOf(i) + (wxOf(i + 1) - wxOf(i)) * t3, wy: wyOf(j + 1), sx: sxOf(i) + (sxOf(i + 1) - sxOf(i)) * t3, sy: syOf(j + 1) });
        }
        // 左边 00-01
        if (((idx & 1) > 0) !== ((idx & 8) > 0)) {
          var t4 = lerp(0, 1, v00, v01);
          pts.push({ wx: wxOf(i), wy: wyOf(j) + (wyOf(j + 1) - wyOf(j)) * t4, sx: sxOf(i), sy: syOf(j) + (syOf(j + 1) - syOf(j)) * t4 });
        }
        if (pts.length === 2) segs.push([pts[0], pts[1]]);
        else if (pts.length === 4) {
          segs.push([pts[0], pts[1]]);
          segs.push([pts[2], pts[3]]);
        }
      }
    }
    return segs;
  }

  // ── 交互：拖动、双指缩放、点击取点 ─────────────────────────────
  var pointers = {};
  var drag = null;
  var pinch = null;
  var marker = null;
  var tracing = null;      // 正在沿某条曲线描点

  // 描点：只更新标记点与提示，不重画背景/坐标轴/曲线
  function applyTrace(p) {
    if (!tracing) return;
    var q = pointOnCurve(tracing.item, p.x, p.y);
    if (!q) return;
    marker = { sx: q.sx, sy: q.sy, wx: q.wx, wy: q.wy, color: tracing.item.f.color };
    showTip(q.sx, q.sy, q.wx, q.wy, tracing.item.f);
    drawMarker();
  }

  function ptOf(e) { return { x: e.clientX - canvas.getBoundingClientRect().left, y: e.clientY - canvas.getBoundingClientRect().top }; }

  canvas.addEventListener('pointerdown', function (e) {
    canvas.setPointerCapture && canvas.setPointerCapture(e.pointerId);
    var p = ptOf(e);
    pointers[e.pointerId] = p;
    var ids = Object.keys(pointers);
    if (ids.length === 1) {
      // 按住曲线附近 → 进入"沿曲线描点"模式，画面不移动
      var hit = curveAt(p.x, p.y, 42);
      if (hit) {
        tracing = { item: hit.item, p: hit.p };
        applyTrace(p);
        drag = null;
      } else {
        tracing = null;
        drag = { start: p, last: p, moved: 0, time: Date.now() };
      }
    } else if (ids.length === 2) {
      tracing = null;
      var a = pointers[ids[0]], b = pointers[ids[1]];
      pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), ppu: state.view.ppu, cx: state.view.cx, cy: state.view.cy };
      var mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      pinch.worldMid = { x: toWorldX(mid.x), y: toWorldY(mid.y) };
      pinch.mid = mid;
      drag = null;
    }
  });

  canvas.addEventListener('pointermove', function (e) {
    if (!pointers[e.pointerId]) return;
    var p = ptOf(e);
    pointers[e.pointerId] = p;
    var ids = Object.keys(pointers);

    if (tracing && ids.length === 1) {
      applyTrace(p);
      return;
    }

    if (ids.length >= 2 && pinch) {
      var a = pointers[ids[0]], b = pointers[ids[1]];
      var d = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
      clearMarker();
    var k = d / pinch.dist;
      state.view.ppu = Math.max(1e-4, Math.min(4e6, pinch.ppu * k));
      // 以两指中点为锚点缩放，手感才对
      var mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      state.view.cx = pinch.worldMid.x - (mid.x - W / 2) / state.view.ppu;
      state.view.cy = pinch.worldMid.y + (mid.y - H / 2) / state.view.ppu;
      draw();
      return;
    }

    if (drag && ids.length === 1) {
      var dx = p.x - drag.last.x, dy = p.y - drag.last.y;
      drag.moved += Math.abs(dx) + Math.abs(dy);
      drag.last = p;
      clearMarker();                     // 画面一动，旧标记点就不在原地了
      state.view.cx -= dx / state.view.ppu;
      state.view.cy += dy / state.view.ppu;
      draw();
    }
  });

  function endPointer(e) {
    var p = pointers[e.pointerId];
    delete pointers[e.pointerId];
    var ids = Object.keys(pointers);
    if (ids.length < 2) pinch = null;
    if (ids.length === 0) {
      if (tracing) { tracing = null; return; }   // 描点结束，标记留在原处
      if (drag) {
        var quick = drag.moved < 8 && (Date.now() - drag.time) < 400;
        if (quick && p) pick(p.x, p.y);
        drag = null;
        save();
      }
    }
  }
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);

  // 在单条曲线上找离手指最近的点
  function nearestOn(item, sx, sy) {
    var best = null, bd = Infinity;
    for (var s = 0; s < item.pts.length; s++) {
      var seg = item.pts[s];
      for (var k = 0; k < seg.length; k++) {
        var dx = seg[k].sx - sx, dy = seg[k].sy - sy;
        var d = dx * dx + dy * dy;
        if (d < bd) { bd = d; best = seg[k]; }
      }
    }
    return best ? { p: best, d: Math.sqrt(bd) } : null;
  }

  // 在所有曲线里找最近的（maxPx 内算命中）
  function curveAt(sx, sy, maxPx) {
    var best = null, bd = maxPx * maxPx;
    for (var i = 0; i < lastPaths.length; i++) {
      var r = nearestOn(lastPaths[i], sx, sy);
      if (r && r.d * r.d <= bd) { bd = r.d * r.d; best = { item: lastPaths[i], p: r.p, d: r.d }; }
    }
    return best;
  }

  // 靠近整数 x 时做"阻尼吸附"：越接近整数，移动越慢并轻微贴住，
  // 但不是硬停顿，继续拖还是能拿走。
  function magnetX(sx) {
    var wx = toWorldX(sx);
    var nearest = Math.round(wx);
    var dxPx = (wx - nearest) * state.view.ppu;      // 离整数还有多少像素
    var R = 10;                                     // 吸附作用半径（屏幕像素，10px 内才生效）
    if (Math.abs(dxPx) < R) {
      var t = Math.abs(dxPx) / R;                   // 0（正好在整数上）→ 1（出圈）
      // 2 次幂：靠近整数时移动变慢并轻轻贴住，但永远拖得走（不锁死）
      var eased = Math.sign(dxPx) * R * Math.pow(t, 2.0) / state.view.ppu;
      return nearest + eased;
    }
    return wx;
  }

  // 沿曲线拖动时，用这个函数把手指位置投影到曲线上的点
  function pointOnCurve(item, sx, sy) {
    var f = item.f;
    // 显式函数：直接用横坐标求值，比离散采样更准、更跟手
    if (f.mode === 'y' && f.fn) {
      var wx = magnetX(sx), wy;
      try { wy = f.fn(wx, 0, 0); } catch (e) { wy = NaN; }
      if (isFinite(wy)) {
        var syS = toScreenY(wy);
        if (syS > -H && syS < H * 2) return { wx: wx, wy: wy, sx: toScreenX(wx), sy: syS };
      }
    }
    var r = nearestOn(item, sx, sy);
    return r ? r.p : null;
  }

  // 点击取点：找最近的曲线点
  // 命中半径：屏幕像素恒定，但缩放越大收得越紧（放大后才能"点哪是哪"）
  function hitRadiusPx() {
    var base = 18, minR = 6, ref = 42;      // ref = 默认缩放（每单位 42 像素）
    var k = Math.max(0, Math.log(state.view.ppu / ref) / Math.log(8));  // 放大 8 倍 → 1
    var r = base - (base - minR) * Math.min(1, k);
    return Math.max(minR, Math.min(base, r));
  }

  function pick(sx, sy) {
    var R = hitRadiusPx();
    var best = null, bestD = R * R;      // 命中半径随缩放变化
    for (var i = 0; i < lastPaths.length; i++) {
      var item = lastPaths[i];
      var f = item.f;
      // 显式函数 y=f(x)：直接用手指的横坐标算，精度到 1 像素
      if (f.mode === 'y' && f.fn) {
        var wx0 = magnetX(sx), wy0;
        try { wy0 = f.fn(wx0, 0, 0); } catch (e) { wy0 = NaN; }
        if (isFinite(wy0)) {
          var sy0 = toScreenY(wy0);
          var dd = (sx - sx) * (sx - sx) + (sy0 - sy) * (sy0 - sy);
          if (dd < bestD && sy0 > -H && sy0 < H * 2) {
            bestD = dd;
            best = { p: { wx: wx0, wy: wy0, sx: sx, sy: sy0 }, f: f };
          }
        }
      }
      // 其余类型（隐函数/极坐标/参数）仍按采样点找最近的
      for (var s2 = 0; s2 < item.pts.length; s2++) {
        var seg2 = item.pts[s2];
        for (var k2 = 0; k2 < seg2.length; k2++) {
          var dx2 = seg2[k2].sx - sx, dy2 = seg2[k2].sy - sy;
          var d2 = dx2 * dx2 + dy2 * dy2;
          if (d2 < bestD) { bestD = d2; best = { p: seg2[k2], f: item.f }; }
        }
      }
    }
    if (!best) {
      // 没点到曲线（超出当前缩放的命中半径）就显示该位置的世界坐标
      marker = { sx: sx, sy: sy, wx: toWorldX(sx), wy: toWorldY(sy), color: null };
      showTip(sx, sy, toWorldX(sx), toWorldY(sy), null);
      draw();
      return;
    }
    marker = { sx: best.p.sx, sy: best.p.sy, wx: best.p.wx, wy: best.p.wy, color: best.f.color };
    showTip(best.p.sx, best.p.sy, best.p.wx, best.p.wy, best.f);
    draw();
  }

  var tip = document.getElementById('tip');
  function showTip(sx, sy, wx, wy, f) {
    var step = niceStep(78 / state.view.ppu);
    var txt = 'x = ' + fmt(wx, step * 0.01) + '\ny = ' + fmt(wy, step * 0.01);
    if (f) txt = (f.mode === 'implicit' ? 'F(x,y)=0' : f.mode === 'polar' ? 'r = ' + f.text : f.mode === 'param' ? '参数曲线' : 'y = ' + f.text) + '\n' + txt;
    tip.textContent = txt;
    tip.style.display = 'block';
    var tw = tip.offsetWidth, th = tip.offsetHeight;
    var left = sx + 14, top = sy - th - 12;
    if (left + tw > W - 8) left = sx - tw - 14;
    if (top < 8) top = sy + 18;
    tip.style.left = Math.max(8, left) + 'px';
    tip.style.top = Math.max(8, top) + 'px';
    if (f) tip.style.borderColor = f.color;
  }
  function hideTip() { tip.style.display = 'none'; marker = null; drawMarker(); }
  // ── 键盘上方的实时预览 ─────────────────────────────────────
  // 手机上键盘会盖住输入框，这里把"正在输入的表达式 + 求值结果"顶到键盘上方。
  (function keyboardPreview() {
    var bar = document.getElementById('kbBar');
    var ex = document.getElementById('kbExpr');
    var info = document.getElementById('kbInfo');
    if (!bar || !ex || !info) return;
    var activeInput = null;

    function kbHeight() {
      var vv = window.visualViewport;
      if (!vv) return 0;
      var h = window.innerHeight - (vv.height + vv.offsetTop);
      return h > 80 ? h : 0;      // 小于 80px 不算键盘
    }

    function place() {
      var h = kbHeight();
      if (!activeInput || h <= 0) { bar.classList.remove('on'); return; }
      bar.classList.add('on');
      bar.style.bottom = h + 'px';
    }

    function refresh() {
      if (!activeInput) return;
      var f = state.funcs.filter(function (q) { return q._input === activeInput; })[0];
      var txt = activeInput.value || '';
      ex.innerHTML = '';
      var span = document.createElement('span');
      span.textContent = txt || '（在这里输入表达式）';
      ex.appendChild(span);
      var caret = document.createElement('span');
      caret.className = 'caret';
      ex.appendChild(caret);
      ex.scrollLeft = ex.scrollWidth;

      if (f) {
        if (f.error) { info.innerHTML = '⚠️ ' + f.error; return; }
        var parts = [];
        var sel = document.activeElement;
        if (sel && sel.classList && sel.classList.contains('xv') && f.evalY !== null && f.evalY !== undefined) {
          parts.push('x = ' + f.evalX + ' → <b>y = ' + fmt(f.evalY, 0.001) + '</b>');
        }
        parts.push('识别为：<b>' + (f.normalized || f.text) + '</b>');
        info.innerHTML = parts.join('　');
      } else {
        info.textContent = '';
      }
    }

    function bind(input) {
      input.addEventListener('focus', function () {
        activeInput = input;
        var f = state.funcs.filter(function (q) { return q._input === input; })[0];
        if (f) f._input = input;
        // 让输入框本身也尽量露出来
        setTimeout(function () {
          try { input.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) { }
          place(); refresh();
        }, 120);
        setTimeout(function () { place(); refresh(); }, 350);
      });
      input.addEventListener('blur', function () {
        setTimeout(function () {
          if (document.activeElement !== input) { bar.classList.remove('on'); }
        }, 150);
      });
      input.addEventListener('input', refresh);
      input.addEventListener('click', refresh);
    }

    state.funcs.forEach(function (f) { if (f._input) bind(f._input); });

    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', function () { place(); });
      window.visualViewport.addEventListener('scroll', function () { place(); });
    }
    window.addEventListener('resize', function () { place(); });

    // 供 renderList 绑定新输入框
    window.__bindKbPreview = function (input, f) { f._input = input; bind(input); };
  })();

  function clearMarker() { if (marker) { marker = null; tip.style.display = 'none'; drawMarker(); } }

  // 滚轮缩放（电脑上）
  canvas.addEventListener('wheel', function (e) {
    e.preventDefault();
    var p = ptOf(e);
    var wx = toWorldX(p.x), wy = toWorldY(p.y);
    var k = Math.pow(1.0015, -e.deltaY);
    state.view.ppu = Math.max(1e-4, Math.min(4e6, state.view.ppu * k));
    state.view.cx = wx - (p.x - W / 2) / state.view.ppu;
    state.view.cy = wy + (p.y - H / 2) / state.view.ppu;
    draw(); save();
  }, { passive: false });

  // ── 缩放按钮 ────────────────────────────────────────────────────
  function zoomBy(k) {
    clearMarker();
    var wx = state.view.cx, wy = state.view.cy;
    state.view.ppu = Math.max(1e-4, Math.min(4e6, state.view.ppu * k));
    state.view.cx = wx; state.view.cy = wy;
    draw(); save();
  }
  function resetView() {
    state.view = { cx: 0, cy: 0, ppu: 42 };
    hideTip(); draw(); save();
  }
  document.getElementById('zin').addEventListener('click', function () { zoomBy(1.4); });
  document.getElementById('zout').addEventListener('click', function () { zoomBy(1 / 1.4); });
  document.getElementById('zreset').addEventListener('click', resetView);
  document.getElementById('gridbtn').addEventListener('click', function () {
    state.grid = !state.grid; this.classList.toggle('on', state.grid);
    draw(); save();
  });
  document.getElementById('themebtn').addEventListener('click', function () {
    state.theme = state.theme === 'auto' ? 'dark' : state.theme === 'dark' ? 'light' : 'auto';
    this.textContent = state.theme === 'auto' ? '跟随系统' : state.theme === 'dark' ? '深色' : '浅色';
    draw(); save();
  });

  // ── 函数列表 UI ────────────────────────────────────────────────
  var listEl = document.getElementById('list');

  function renderList() {
    listEl.innerHTML = '';
    var badge = document.getElementById('fnCount');
    if (badge) badge.textContent = state.funcs.filter(function (x) { return x.visible && !x.error; }).length;
    state.funcs.forEach(function (f) {
      var row = document.createElement('div');
      row.className = 'frow' + (f.visible ? '' : ' off') + (f.error ? ' err' : '');

      var dot = document.createElement('button');
      dot.className = 'dot';
      dot.style.background = f.color;
      dot.title = '显示/隐藏';
      dot.addEventListener('click', function () {
        f.visible = !f.visible; renderList(); draw(); save();
      });

      var mode = document.createElement('select');
      mode.className = 'mode';
      [['y', 'y='], ['implicit', 'F=0'], ['polar', 'r='], ['param', '参数']].forEach(function (o) {
        var op = document.createElement('option');
        op.value = o[0]; op.textContent = o[1];
        if (f.mode === o[0]) op.selected = true;
        mode.appendChild(op);
      });
      mode.addEventListener('change', function () {
        f.mode = mode.value; compileFunc(f); renderList(); draw(); save();
      });

      var input = document.createElement('input');
      input.className = 'fx';
      input.value = f.text;
      input.placeholder = f.mode === 'implicit' ? '例：x^2+y^2-25'
        : f.mode === 'polar' ? '例：1-cos(θ)' : f.mode === 'param' ? '例：cos(3t); sin(2t)' : '例：sin(x)/x';
      if (window.__bindKbPreview) window.__bindKbPreview(input, f);
      input.addEventListener('input', function () {
        f.text = input.value;
        compileFunc(f);
        var rowEl = input.closest('.frow');
        rowEl.classList.toggle('err', !!f.error);
        var errEl = rowEl.querySelector('.errmsg');
        if (errEl) errEl.textContent = f.error || '';
        draw(); save();
      });

      var del = document.createElement('button');
      del.className = 'del';
      del.textContent = '×';
      del.addEventListener('click', function () {
        state.funcs = state.funcs.filter(function (x) { return x.id !== f.id; });
        renderList(); draw(); save();
      });

      // 解析式右边：输入 x → 立刻给出 y，并在图上标出这个点
      var xin = document.createElement('input');
      xin.className = 'xv';
      xin.type = 'number';
      xin.step = 'any';
      xin.placeholder = 'x';
      if (f.evalX !== null && f.evalX !== undefined) xin.value = f.evalX;
      var ylab = document.createElement('span');
      ylab.className = 'yv';
      function refreshY() {
        if (f.evalX === null || f.evalX === undefined || !f.fn || f.mode !== 'y') {
          f.evalY = null;
          ylab.textContent = 'y=—';
          return;
        }
        try {
          var v = f.fn(f.evalX, 0, 0);
          f.evalY = isFinite(v) ? v : null;
          ylab.textContent = 'y=' + (f.evalY === null ? '—' : fmt(f.evalY, 0.001));
        } catch (e) {
          f.evalY = null;
          ylab.textContent = 'y=—';
        }
      }
      xin.addEventListener('input', function () {
        var v = parseFloat(xin.value);
        if (isNaN(v) || f.mode !== 'y') { f.evalX = null; f.evalY = null; }
        else { f.evalX = v; }
        refreshY();
        draw(); save();
      });
      refreshY();
      row.appendChild(dot); row.appendChild(mode); row.appendChild(input);
      row.appendChild(xin); row.appendChild(ylab);
      row.appendChild(del);
      var err = document.createElement('div');
      err.className = 'errmsg';
      err.textContent = f.error || '';
      row.appendChild(err);
      listEl.appendChild(row);
    });
  }

  document.getElementById('addfn').addEventListener('click', function () {
    addFunc('', 'y');
    renderList(); draw(); save();
  });

  // ── 示例库（覆盖大学常用函数）──────────────────────────────────
  var SAMPLES = [
    ['幂函数 y=x²', [['x^2', 'y']]],
    ['幂函数 y=x³', [['x^3', 'y']]],
    ['根式 y=√x', [['sqrt(x)', 'y']]],
    ['双曲线 y=1/x', [['1/x', 'y']]],
    ['指数 y=eˣ', [['e^x', 'y']]],
    ['指数 y=2ˣ', [['2^x', 'y']]],
    ['对数 y=ln x', [['ln(x)', 'y']]],
    ['常用对数 y=lg x', [['lg(x)', 'y']]],
    ['正弦 y=sin x', [['sin(x)', 'y']]],
    ['余弦 y=cos x', [['cos(x)', 'y']]],
    ['正切 y=tan x', [['tan(x)', 'y']]],
    ['反三角 y=asin x', [['asin(x)', 'y']]],
    ['反三角 y=atan x', [['atan(x)', 'y']]],
    ['双曲 y=sinh x', [['sinh(x)', 'y']]],
    ['双曲 y=tanh x', [['tanh(x)', 'y']]],
    ['高斯 y=e^(-x²)', [['e^(-x^2)', 'y']]],
    ['采样函数 y=sin x / x', [['sin(x)/x', 'y']]],
    ['取整 y=floor x', [['floor(x)', 'y']]],
    ['小数部分 y={x}', [['frac(x)', 'y']]],
    ['三次与对数对比', [['x^3', 'y'], ['ln(x)+3', 'y']]],
    ['圆 x²+y²=25', [['x^2+y^2-25', 'implicit']]],
    ['椭圆 x²/9+y²/4=1', [['x^2/9+y^2/4-1', 'implicit']]],
    ['双曲线 x²/4−y²/9=1', [['x^2/4-y^2/9-1', 'implicit']]],
    ['抛物线 y=x²（隐式）', [['y-x^2', 'implicit']]],
    ['心形线（隐式）', [['(x^2+y^2-1)^3-x^2*y^3', 'implicit']]],
    ['玫瑰线 r=cos 3θ', [['cos(3θ)', 'polar']]],
    ['心形线 r=1−cos θ', [['1-cos(θ)', 'polar']]],
    ['阿基米德螺线 r=θ', [['θ', 'polar']]],
    ['双纽线 r²=4cos2θ', [['sqrt(4*cos(2*θ))', 'polar']]],
    ['单位圆（参数）', [['cos(t); sin(t)', 'param']]],
    ['李萨如', [['cos(3t); sin(2t)', 'param']]],
    ['摆线', [['t-sin(t); 1-cos(t)', 'param']]],
    ['星形线', [['cos(t)^3; sin(t)^3', 'param']]]
  ];

  function renderSamples() {
    var box = document.getElementById('samples');
    box.innerHTML = '';
    var cnt = document.getElementById('sampleCnt');
    if (cnt) cnt.textContent = SAMPLES.length;
    SAMPLES.forEach(function (s) {
      var b = document.createElement('button');
      b.className = 'smp';
      b.textContent = s[0];
      b.addEventListener('click', function () {
        s[1].forEach(function (d) { addFunc(d[0], d[1]); });
        renderList(); draw(); save();
        document.getElementById('panel').classList.add('collapsed');
      });
      box.appendChild(b);
    });
  }

  // ── 分享给好友 ──────────────────────────────────────────────────
  var ONLINE_URL = 'https://xykhh-2333.github.io/cpp-forge/graph/';
  function shareApp() {
    // 装成 APK 时由原生接口接管（WebView 里没有 navigator.share）
    if (window.AndroidShare && typeof window.AndroidShare.share === 'function') {
      window.AndroidShare.share(
        '函数绘图器：输入函数画图像，双指缩放、点曲线取坐标，离线可用。\n' + ONLINE_URL);
      return;
    }
    var text = '函数绘图器：输入函数画图像，双指缩放、点曲线取坐标，离线可用。';
    if (navigator.share) {
      navigator.share({ title: '函数绘图器', text: text + '\n' + ONLINE_URL }).catch(function () {});
      return;
    }
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text + '\n' + ONLINE_URL).then(function () {
        alert('链接已复制，去粘贴给好友吧');
      }).catch(function () {});
    }
  }
  document.getElementById('shareBtn').addEventListener('click', shareApp);

  // ── 面板折叠 ────────────────────────────────────────────────────
  document.getElementById('togglePanel').addEventListener('click', function () {
    document.getElementById('panel').classList.toggle('collapsed');
  });

  // ── 初始化 ──────────────────────────────────────────────────────
  load();
  if (!state.funcs.length) {
    addFunc('sin(x)', 'y', COLORS[0]);
    addFunc('x^2/4-2', 'y', COLORS[1]);
  } else {
    state.funcs.forEach(compileFunc);
  }
  renderList();
  renderSamples();
  document.getElementById('gridbtn').classList.toggle('on', state.grid);
  document.getElementById('themebtn').textContent =
    state.theme === 'auto' ? '跟随系统' : state.theme === 'dark' ? '深色' : '浅色';

  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', function () { setTimeout(resize, 250); });
  document.addEventListener('click', function (e) {
    if (!tip.contains(e.target) && e.target !== canvas) hideTip();
  });

  resize();

  // 暴露给自动化测试
  window.__graph = {
    state: state, draw: draw, pick: pick, addFunc: addFunc,
    intersections: computeIntersections, hitRadiusPx: hitRadiusPx,
    toWorldX: toWorldX, toWorldY: toWorldY, toScreenX: toScreenX, toScreenY: toScreenY,
    // 供自动化测试：模拟"按住曲线 → 沿曲线拖动"的完整流程
    paths: function () { return lastPaths; },
    curveAt: curveAt,
    beginTrace: function (sx, sy) {
      var hit = curveAt(sx, sy, 42);
      if (!hit) return null;
      tracing = { item: hit.item, p: hit.p };
      applyTrace({ x: sx, y: sy });
      return { color: hit.item.f.color, text: hit.item.f.text, mode: hit.item.f.mode };
    },
    moveTrace: function (sx, sy) { applyTrace({ x: sx, y: sy }); return marker; },
    endTrace: function () { tracing = null; },
    marker: function () { return marker; }
  };
})();
