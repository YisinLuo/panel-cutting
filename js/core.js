/*
 * 板材計算核心邏輯（瀏覽器與 Node 共用）
 *  1. parseTextItems：把料單 PDF 的文字（含座標）轉成料件清單，並讀出料單上的小計/總計供核對
 *  2. packGroup：把同一組（顏色＋厚度）的料件排進大板，只用一刀到底（guillotine）的切法，不旋轉（紋路方向）
 *  3. rowBanding / bandingTotals：封邊長度
 *
 * 座標約定（排版）：x = 大板「長」方向，y = 大板「寬」方向。料件的長一律對 x。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PanelCore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const INT_RE = /^\d+$/;
  const NUM_RE = /^\d+(?:\.\d+)?$/;
  const CODE_RE = /^(\d+)\s*([AP])$/i;

  // 媽媽確認（2026-11-18）：料件尺寸不另外加，每裁一刀扣刀片厚度；後來改說「每切一刀抓 6MM」。
  // 大板修邊：原則上四邊各修 10mm（媽媽確認規格 1～3 這樣 OK），但「只是大概」——規格 4（2420×1210）可以用到 2405×1195。
  // 所以每個規格各自記「修邊後可用的長 useL × 寬 useW」。
  const DEFAULT_SETTINGS = {
    blade: 6, // 每刀扣（刀片厚度）
    bandAdd: 30, // 封邊每邊加長
    specs: [
      { L: 2850, W: 2080, useL: 2830, useW: 2060 },
      { L: 2800, W: 2070, useL: 2780, useW: 2050 },
      { L: 3150, W: 2070, useL: 3130, useW: 2050 },
      { L: 2420, W: 1210, useL: 2405, useW: 1195 },
    ],
    defaultSpec: 3, // 規格 4
  };

  const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

  // ---------------------------------------------------------------------------
  // 1. 解析料單
  // ---------------------------------------------------------------------------

  /** 依 y 把文字分行（PDF 座標 y 向上，所以由大到小排）。相鄰兩字 y 差超過 gap 就換行。 */
  function groupLines(items, gap) {
    const sorted = items.slice().sort((a, b) => b.y - a.y || a.x - b.x);
    const lines = [];
    let cur = null;
    let lastY = null;
    for (const it of sorted) {
      if (!cur || lastY - it.y > gap) {
        cur = [];
        lines.push(cur);
      }
      cur.push(it);
      lastY = it.y;
    }
    return lines.map((l) => l.sort((a, b) => a.x - b.x));
  }

  /** 找 label 右邊最近的數字（label 本身可能已含數字，如「片數小計: 16」） */
  function valueAfter(line, labelRe, maxDx) {
    const label = line.find((t) => labelRe.test(t.s));
    if (!label) return null;
    const inline = label.s.replace(labelRe, '').replace(/^[:：\s]+/, '');
    if (NUM_RE.test(inline)) return Number(inline);
    let best = null;
    for (const t of line) {
      if (t === label || !NUM_RE.test(t.s)) continue;
      const dx = t.x - label.x;
      if (dx <= 0 || dx > maxDx) continue;
      if (!best || t.x < best.x) best = t;
    }
    return best ? Number(best.s) : null;
  }

  function parseCode(s) {
    const m = CODE_RE.exec(norm(s));
    return m ? { n: Number(m[1]), type: m[2].toUpperCase() } : null;
  }

  function formatCode(c) {
    return c ? `${c.n}${c.type}` : '';
  }

  /**
   * items: [{ str, x, y, page }]（x/y 為 PDF 座標，同一頁內比較）
   * 回傳 { rows, blocks, sections, total, ok, warnings }
   */
  function parseTextItems(items) {
    const warnings = [];
    const rows = [];
    const blocks = []; // 每個「顏色」標題一塊：{ color, thickness, expected, actual }
    const sections = []; // 每個「厚」標題一段：{ thickness, expected, actual }
    let docTotal = null;
    let tailTotal = null;
    let cols = null; // 欄位分界（取自表頭）
    let section = null;
    let block = null;

    const pages = new Map();
    for (const it of items) {
      const s = norm(it.str);
      if (!s) continue;
      const p = it.page || 1;
      if (!pages.has(p)) pages.set(p, []);
      pages.get(p).push({ s, x: it.x, y: it.y, page: p });
    }

    for (const p of [...pages.keys()].sort((a, b) => a - b)) {
      const lines = groupLines(pages.get(p), 6);
      const pageRows = [];
      const orphanCodes = [];

      for (const line of lines) {
        const has = (re) => line.some((t) => re.test(t.s));

        if (has(/櫃體編號/)) {
          const find = (re) => line.find((t) => re.test(t.s));
          const name = find(/件名稱/);
          const color = find(/^顏色$/);
          const len = find(/^長$/);
          if (name && color && len) {
            cols = { nameEnd: (name.x + color.x) / 2, dimStart: (color.x + len.x) / 2 };
          }
          continue;
        }

        if (has(/片數小計/)) {
          const label = line.find((t) => /^顏色/.test(t.s));
          const sub = line.find((t) => /片數小計/.test(t.s));
          let color = '';
          if (label) {
            const inline = label.s.replace(/^顏色[:：]?/, '').trim();
            const parts = line.filter((t) => t !== label && t.x > label.x && t.x < sub.x && !/片數小計/.test(t.s));
            color = norm([inline, ...parts.map((t) => t.s)].join(' '));
          }
          block = {
            color,
            thickness: section ? section.thickness : null,
            expected: valueAfter(line, /^片數小計/, 120),
            actual: 0,
          };
          blocks.push(block);
          continue;
        }

        if (has(/片數總計/)) {
          docTotal = valueAfter(line, /^片數總計/, 150);
          continue;
        }

        const row = parseRow(line, cols);
        if (row) {
          row.page = p;
          if (!block) {
            block = { color: row.colorShort, thickness: row.T, expected: null, actual: 0 };
            blocks.push(block);
          }
          row.color = block.color || row.colorShort;
          row.thickness = row.T;
          block.actual += row.Q;
          if (section) section.actual += row.Q;
          rows.push(row);
          pageRows.push(row);
          continue;
        }

        const thick = line.find((t) => /^厚\s*\d*$/.test(t.s) && !/封邊/.test(t.s));
        if (thick && has(/總計/)) {
          section = {
            thickness: valueAfter(line, /^厚/, 60),
            expected: valueAfter(line, /^總計/, 120),
            actual: 0,
          };
          sections.push(section);
          block = null;
          continue;
        }

        if (has(/^總計/)) {
          const v = valueAfter(line, /^總計/, 600);
          if (v != null) tailTotal = v;
          continue;
        }

        if (line.every((t) => CODE_RE.test(t.s))) orphanCodes.push(...line);
      }

      // 封邊代碼若被分到獨立一行，就貼回 y 最近的那一列
      for (const c of orphanCodes) {
        let best = null;
        for (const r of pageRows) {
          const d = Math.abs(r._y - c.y);
          if (d < 12 && (!best || d < best.d)) best = { r, d };
        }
        if (best) attachCode(best.r, c);
        else warnings.push(`第 ${p} 頁有封邊代碼「${c.s}」對不到料件`);
      }
    }

    for (const r of rows) {
      delete r._y;
      delete r._wx;
    }

    const actualTotal = rows.reduce((s, r) => s + r.Q, 0);
    const total = { expected: docTotal != null ? docTotal : tailTotal, actual: actualTotal };
    const ok =
      rows.length > 0 &&
      (total.expected == null || total.expected === total.actual) &&
      blocks.every((b) => b.expected == null || b.expected === b.actual) &&
      sections.every((s) => s.expected == null || s.expected === s.actual);

    if (!rows.length) warnings.push('沒有讀到任何料件，這個 PDF 可能不是生產料單格式');

    return { rows, blocks, sections, total, ok, warnings };
  }

  function attachCode(row, tok) {
    const code = parseCode(tok.s);
    if (!code) return;
    if (tok.x < row._wx) row.codeL = code;
    else row.codeW = code;
  }

  /** 一列料件：櫃體編號 項次 件名稱 顏色 長 [封邊] 寬 [封邊] 厚 數量 備註 */
  function parseRow(line, cols) {
    const codes = line.filter((t) => CODE_RE.test(t.s));
    const rest = line.filter((t) => !CODE_RE.test(t.s));
    const ints = rest.filter((t) => INT_RE.test(t.s));
    if (ints.length < 6 || rest[0] !== ints[0] || rest[1] !== ints[1]) return null;

    let dims = ints.slice(2);
    if (cols) dims = dims.filter((t) => t.x >= cols.dimStart);
    if (dims.length < 4) return null;
    const [tL, tW, tT, tQ] = dims;

    const mids = rest.filter((t) => t.x > ints[1].x && t.x < tL.x);
    let nameToks;
    let colorToks;
    if (cols) {
      nameToks = mids.filter((t) => t.x < cols.nameEnd);
      colorToks = mids.filter((t) => t.x >= cols.nameEnd);
    } else {
      nameToks = mids.slice(0, 1);
      colorToks = mids.slice(1);
    }

    const row = {
      cab: ints[0].s,
      item: ints[1].s,
      name: norm(nameToks.map((t) => t.s).join(' ')),
      colorShort: norm(colorToks.map((t) => t.s).join(' ')),
      L: Number(tL.s),
      W: Number(tW.s),
      T: Number(tT.s),
      Q: Number(tQ.s),
      codeL: null,
      codeW: null,
      remark: norm(rest.filter((t) => t.x > tQ.x).map((t) => t.s).join(' ')),
      _y: ints[0].y,
      _wx: tW.x,
    };
    for (const c of codes) attachCode(row, c);
    return row;
  }

  /** 依「顏色＋厚度」分組，保留第一次出現的順序 */
  function groupRows(rows) {
    const map = new Map();
    for (const r of rows) {
      const key = `${r.color}|${r.thickness}`;
      if (!map.has(key)) map.set(key, { key, color: r.color, thickness: r.thickness, rows: [] });
      map.get(key).rows.push(r);
    }
    return [...map.values()];
  }

  // ---------------------------------------------------------------------------
  // 2. 封邊
  // ---------------------------------------------------------------------------

  /**
   * 代碼寫在哪一欄，就是封「讓那一欄尺寸變大」的邊（媽媽確認：顯示在寬邊，就是封長邊的尺寸）
   *   寬欄代碼 n → n ×（長 + add）
   *   長欄代碼 n → n ×（寬 + add）
   * 回傳 { A: mm, P: mm }（已乘數量）
   */
  function rowBanding(r, add) {
    const out = { A: 0, P: 0 };
    if (r.codeW) out[r.codeW.type] += r.codeW.n * (r.L + add) * r.Q;
    if (r.codeL) out[r.codeL.type] += r.codeL.n * (r.W + add) * r.Q;
    return out;
  }

  function bandingTotals(rows, add) {
    const out = { A: 0, P: 0 };
    for (const r of rows) {
      const b = rowBanding(r, add);
      out.A += b.A;
      out.P += b.P;
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // 3. 排版
  // ---------------------------------------------------------------------------

  const ORDERS = {
    area: (a, b) => b.w * b.h - a.w * a.h || b.h - a.h || b.w - a.w,
    height: (a, b) => b.h - a.h || b.w - a.w,
    width: (a, b) => b.w - a.w || b.h - a.h,
    maxSide: (a, b) => Math.max(b.w, b.h) - Math.max(a.w, a.h) || b.h - a.h || b.w - a.w,
  };

  const CHOICES = {
    bestArea: (r, p) => r.w * r.h - p.w * p.h,
    bestShort: (r, p) => Math.min(r.w - p.w, r.h - p.h),
    bestLong: (r, p) => Math.max(r.w - p.w, r.h - p.h),
  };

  // true = 橫切（下方剩餘空間跨整個寬度）
  const SPLITS = {
    shorterLeftover: (r, p) => r.w - p.w <= r.h - p.h,
    longerLeftover: (r, p) => r.w - p.w > r.h - p.h,
    minArea: (r, p) => p.w * (r.h - p.h) > (r.w - p.w) * p.h,
    maxArea: (r, p) => p.w * (r.h - p.h) <= (r.w - p.w) * p.h,
    shorterAxis: (r) => r.w <= r.h,
    longerAxis: (r) => r.w > r.h,
  };

  /** 自由矩形 guillotine：每片料挑全部大板中最合適的空位，放下後把剩餘空間一刀切成兩塊 */
  function packGuillotine(pieces, BW, BH, order, choice, split) {
    const ps = pieces.slice().sort(ORDERS[order]);
    const minW = Math.min(...ps.map((p) => p.w));
    const minH = Math.min(...ps.map((p) => p.h));
    const score = CHOICES[choice];
    const splitH = SPLITS[split];
    const boards = [];

    for (const p of ps) {
      let best = null;
      for (let bi = 0; bi < boards.length; bi++) {
        const free = boards[bi].free;
        for (let i = 0; i < free.length; i++) {
          const r = free[i];
          if (r.w < p.w || r.h < p.h) continue;
          const sc = score(r, p);
          if (!best || sc < best.sc || (sc === best.sc && bi < best.bi)) best = { bi, i, sc };
        }
      }
      if (!best) {
        boards.push({ free: [{ x: 0, y: 0, w: BW, h: BH }], placements: [] });
        best = { bi: boards.length - 1, i: 0 };
      }
      const b = boards[best.bi];
      const r = b.free[best.i];
      b.free.splice(best.i, 1);
      b.placements.push({ x: r.x, y: r.y, w: p.w, h: p.h, ref: p.ref });

      let right;
      let below;
      if (splitH(r, p)) {
        right = { x: r.x + p.w, y: r.y, w: r.w - p.w, h: p.h };
        below = { x: r.x, y: r.y + p.h, w: r.w, h: r.h - p.h };
      } else {
        right = { x: r.x + p.w, y: r.y, w: r.w - p.w, h: r.h };
        below = { x: r.x, y: r.y + p.h, w: p.w, h: r.h - p.h };
      }
      for (const f of [right, below]) if (f.w >= minW && f.h >= minH) b.free.push(f);
    }
    return boards.map((b) => b.placements);
  }

  /** 從 strips 裡挑一組總寬度最接近 cap 的條（0/1 背包，同寬度時料件面積大的優先），回傳索引 */
  function fillBest(strips, cap) {
    const n = strips.length;
    const val = new Float64Array(cap + 1).fill(-1);
    val[0] = 0;
    const take = [];
    for (let i = 0; i < n; i++) {
      const h = strips[i].h;
      const a = strips[i].area;
      const t = new Uint8Array(cap + 1);
      for (let c = cap; c >= h; c--) {
        if (val[c - h] < 0) continue;
        const v = val[c - h] + a;
        if (v > val[c]) {
          val[c] = v;
          t[c] = 1;
        }
      }
      take.push(t);
    }
    let c = cap;
    while (c > 0 && val[c] < 0) c--;
    const chosen = [];
    for (let i = n - 1; i >= 0 && c > 0; i--) {
      if (take[i][c]) {
        chosen.push(i);
        c -= strips[i].h;
      }
    }
    return chosen;
  }

  /** 條裝進大板：ffd = 由寬到窄依序塞進第一片放得下的；best = 每片先放最寬的條，再挑最剛好的組合補滿 */
  function stripsToBoards(strips, BH, how) {
    const sorted = strips.slice().sort((a, b) => b.h - a.h || b.area - a.area);
    const boards = [];
    if (how === 'ffd') {
      for (const s of sorted) {
        let b = boards.find((x) => x.usedH + s.h <= BH);
        if (!b) {
          b = { usedH: 0, strips: [] };
          boards.push(b);
        }
        b.strips.push(s);
        b.usedH += s.h;
      }
    } else {
      let left = sorted;
      while (left.length) {
        const first = left[0];
        const rest = left.slice(1);
        const chosen = new Set(fillBest(rest, BH - first.h));
        boards.push({ strips: [first, ...rest.filter((_, i) => chosen.has(i))] });
        left = rest.filter((_, i) => !chosen.has(i));
      }
    }
    return boards.map((b) => {
      const pl = [];
      let y = 0;
      for (const s of b.strips) {
        for (const { p, x } of s.items) pl.push({ x, y, w: p.w, h: p.h, ref: p.ref });
        y += s.h;
      }
      return pl;
    });
  }

  /**
   * 條狀排法（最像手工）：先順著大板的長切成一條條（條寬 = 料寬），再把每條橫切成料件。
   * 料件依 order 的順序，放進「高度最接近」且長度還夠的條；再把條裝進大板。
   */
  function packStrips(pieces, BW, BH, order, how) {
    const ps = Array.isArray(order) ? order : pieces.slice().sort(ORDERS.height);
    const strips = [];
    for (const p of ps) {
      let best = null;
      for (const s of strips) {
        if (s.h < p.h || BW - s.used < p.w) continue;
        const sc = (s.h - p.h) * 1e7 + (BW - s.used - p.w);
        if (!best || sc < best.sc) best = { s, sc };
      }
      let s = best && best.s;
      if (!s) {
        s = { h: p.h, used: 0, area: 0, items: [] };
        strips.push(s);
      }
      s.items.push({ p, x: s.used });
      s.used += p.w;
      s.area += p.w * p.h;
    }
    // 每條裡由長到短排，切起來比較順
    for (const s of strips) {
      s.items.sort((a, b) => b.p.w - a.p.w);
      let x = 0;
      for (const it of s.items) {
        it.x = x;
        x += it.p.w;
      }
    }
    if (how) return stripsToBoards(strips, BH, how);
    const a = stripsToBoards(strips, BH, 'ffd');
    const b = stripsToBoards(strips, BH, 'best');
    return b.length < a.length ? b : a;
  }

  /** 固定種子的亂數：同一張料單每次算出來都一樣 */
  function makeRng(seed) {
    let s = seed >>> 0 || 1;
    return () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  /** 料件順序的小擾動：大致維持由寬到窄，但讓寬度相近的料件互換，試出不同的條組合 */
  function jitterOrder(pieces, rng, amount) {
    const keyed = pieces.map((p) => ({ p, k: p.h * (1 + (rng() - 0.5) * amount), k2: p.w * (1 + (rng() - 0.5) * amount) }));
    keyed.sort((a, b) => b.k - a.k || b.k2 - a.k2);
    return keyed.map((x) => x.p);
  }

  function transposePieces(pieces) {
    return pieces.map((p) => ({ w: p.h, h: p.w, ref: p.ref }));
  }

  function transposeBoards(boards) {
    return boards.map((pl) => pl.map((q) => ({ x: q.y, y: q.x, w: q.h, h: q.w, ref: q.ref })));
  }

  /** 比較兩種結果：大板少者勝；同片數時，最空的那片越空越好（剩下的整塊料比較大） */
  function better(a, b) {
    if (!b) return true;
    if (a.length !== b.length) return a.length < b.length;
    const minUsed = (bs) => Math.min(...bs.map((pl) => pl.reduce((s, q) => s + q.w * q.h, 0)));
    return minUsed(a) < minUsed(b);
  }

  /**
   * rows: 同一組料件 [{ L, W, Q, name, ... }]
   * spec: { L, W, useL, useW } 大板尺寸與修邊後可用尺寸（沒給 useL/useW 就四邊各修 opts.trim，預設 10）
   * opts: { blade, trim }
   *
   * 刀縫的算法：修邊後可用範圍 usable，料件之間每一刀吃掉 blade。
   * 把每片料和可用範圍都各加一個 blade 去排（n 片排一排：n×(長+刀) ≤ 可用+刀），
   * 對一刀到底的切法剛好等於「每切一刀扣 blade」。
   */
  function packGroup(rows, spec, opts) {
    const blade = opts && opts.blade != null ? opts.blade : DEFAULT_SETTINGS.blade;
    const trim = opts && opts.trim != null ? opts.trim : 10;
    const usableL = Math.min(spec.L, spec.useL > 0 ? spec.useL : spec.L - 2 * trim);
    const usableW = Math.min(spec.W, spec.useW > 0 ? spec.useW : spec.W - 2 * trim);
    // 畫圖用：可用範圍放在大板正中間（修邊兩邊平分）
    const offX = (spec.L - usableL) / 2;
    const offY = (spec.W - usableW) / 2;
    const BW = usableL + blade;
    const BH = usableW + blade;
    const pieces = [];
    const tooBig = [];
    rows.forEach((r, idx) => {
      if (!(r.Q > 0)) return;
      if (r.L > usableL || r.W > usableW) {
        tooBig.push(r);
        return;
      }
      for (let k = 0; k < r.Q; k++) pieces.push({ w: r.L + blade, h: r.W + blade, ref: idx });
    });

    const pieceArea = pieces.reduce((s, p) => s + p.w * p.h, 0);
    const result = {
      boards: [],
      method: '',
      tooBig,
      pieceCount: pieces.length,
      lowerBound: pieces.length ? Math.ceil(pieceArea / (BW * BH)) : 0,
      boardSize: { L: spec.L, W: spec.W },
      usable: { L: usableL, W: usableW },
      offset: { x: offX, y: offY },
      blade,
    };
    if (!pieces.length) return result;

    // 條狀排法：基本順序 + 固定種子的擾動順序，取最少片數
    let best = packStrips(pieces, BW, BH);
    let method = 'strips';
    const cols = transposeBoards(packStrips(transposePieces(pieces), BH, BW));
    if (cols.length < best.length) {
      best = cols;
      method = 'columns';
    }
    const rng = makeRng(pieces.length * 7919 + BW * 31 + BH);
    const tries = opts && opts.tries != null ? opts.tries : 60;
    for (let t = 0; t < tries && best.length > result.lowerBound; t++) {
      const b = packStrips(pieces, BW, BH, jitterOrder(pieces, rng, t < tries / 2 ? 0.08 : 0.25));
      if (b.length < best.length) {
        best = b;
        method = 'strips';
      }
    }
    const stripCount = best.length;
    if (stripCount > result.lowerBound) {
      for (const order of Object.keys(ORDERS))
        for (const choice of Object.keys(CHOICES))
          for (const split of Object.keys(SPLITS)) {
            const b = packGuillotine(pieces, BW, BH, order, choice, split);
            // 條狀排法比較好切：片數一樣時保留條狀
            if (b.length < stripCount && better(b, method === 'guillotine' ? best : null)) {
              best = b;
              method = 'guillotine';
            }
          }
    }

    result.method = method;
    // 換回大板實際座標：位置加上修邊，大小用料件實際尺寸（刀縫留在料件右邊、下邊）
    result.boards = best.map((pl) => {
      const placements = pl
        .map((q) => ({ x: q.x + offX, y: q.y + offY, w: rows[q.ref].L, h: rows[q.ref].W, ref: q.ref }))
        .sort((a, b) => a.y - b.y || a.x - b.x);
      const used = placements.reduce((s, q) => s + q.w * q.h, 0);
      return { placements, fill: used / (spec.L * spec.W) };
    });
    // 最滿的放前面
    result.boards.sort((a, b) => b.fill - a.fill);
    return result;
  }

  /** 把排法完全相同的大板合併（顯示「同樣排法 × N 片」） */
  function groupIdenticalBoards(boards, rows) {
    const out = [];
    const bySig = new Map();
    for (const b of boards) {
      const sig = b.placements
        .map((q) => `${q.x},${q.y},${q.w},${q.h},${rows[q.ref].name},${rows[q.ref].L}x${rows[q.ref].W}`)
        .join(';');
      if (bySig.has(sig)) bySig.get(sig).count++;
      else {
        const g = { board: b, count: 1 };
        bySig.set(sig, g);
        out.push(g);
      }
    }
    return out;
  }

  return {
    DEFAULT_SETTINGS,
    parseTextItems,
    parseCode,
    formatCode,
    groupRows,
    rowBanding,
    bandingTotals,
    packGroup,
    groupIdenticalBoards,
    // 測試用
    _internal: { packGuillotine, packStrips, groupLines, ORDERS, CHOICES, SPLITS },
  };
});
