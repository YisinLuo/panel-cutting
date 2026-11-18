'use strict';
const assert = require('node:assert/strict');

/** 能不能只用一刀到底的切法切出來 */
function isGuillotine(rects, x0, y0, x1, y1) {
  if (rects.length <= 1) return true;
  for (const c of new Set(rects.map((r) => r.x + r.w))) {
    if (c <= x0 || c >= x1) continue;
    const a = rects.filter((r) => r.x + r.w <= c);
    const b = rects.filter((r) => r.x >= c);
    if (a.length && b.length && a.length + b.length === rects.length) {
      return isGuillotine(a, x0, y0, c, y1) && isGuillotine(b, c, y0, x1, y1);
    }
  }
  for (const c of new Set(rects.map((r) => r.y + r.h))) {
    if (c <= y0 || c >= y1) continue;
    const a = rects.filter((r) => r.y + r.h <= c);
    const b = rects.filter((r) => r.y >= c);
    if (a.length && b.length && a.length + b.length === rects.length) {
      return isGuillotine(a, x0, y0, x1, c) && isGuillotine(b, x0, c, x1, y1);
    }
  }
  return false;
}

/** 檢查排版結果：不重疊、不超出、件數正確、方向沒轉、切得出來 */
function assertValidPack(res, rows, spec, kerf) {
  const expected = rows.reduce((s, r) => s + r.Q, 0) - res.tooBig.reduce((s, r) => s + r.Q, 0);
  let count = 0;
  for (const b of res.boards) {
    const ps = b.placements;
    count += ps.length;
    for (const q of ps) {
      const r = rows[q.ref];
      assert.equal(q.w, r.L + kerf, '料件的長要對大板的長（不旋轉）');
      assert.equal(q.h, r.W + kerf);
      assert.ok(q.x >= 0 && q.y >= 0 && q.x + q.w <= spec.L && q.y + q.h <= spec.W, '超出大板');
    }
    for (let i = 0; i < ps.length; i++)
      for (let j = i + 1; j < ps.length; j++) {
        const a = ps[i];
        const c = ps[j];
        const overlap = a.x < c.x + c.w && c.x < a.x + a.w && a.y < c.y + c.h && c.y < a.y + a.h;
        assert.ok(!overlap, '料件重疊');
      }
    assert.ok(isGuillotine(ps, 0, 0, spec.L, spec.W), '排法無法一刀到底切出');
  }
  assert.equal(count, expected, '件數不符');
  assert.ok(res.boards.length >= res.lowerBound);
}

module.exports = { isGuillotine, assertValidPack };
