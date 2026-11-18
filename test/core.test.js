'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../js/core.js');
const { assertValidPack, isGuillotine } = require('./helpers.js');

const SPEC4 = { L: 2420, W: 1210 };
const OPTS = { blade: 4, trim: 10 };
const c = core.parseCode;

// 30mm 檯面組（只取尺寸、數量、封邊代碼）
const COUNTERTOP = [
  [2400, '2A', 470, '2A', 3],
  [2260, '2A', 470, '2A', 1],
  [1900, '2A', 470, '2A', 1],
  [1700, '2A', 470, '2A', 1],
  [1600, '2A', 470, '2A', 1],
  [1600, '2A', 470, '2A', 1],
  [1400, '2A', 470, '2A', 1],
  [1100, '2A', 470, '2A', 1],
  [1050, '2A', 470, '2A', 1],
  [900, '2A', 470, '2A', 1],
  [2400, '', 80, '1A', 4], // 線板
].map(([L, cl, W, cw, Q], i) => ({ name: `件${i}`, L, W, Q, codeL: c(cl), codeW: c(cw) }));

// 18mm 紅豆杉組
const YEW = [
  [714, '2A', 686, '2A', 1],
  [648, '2A', 686, '2A', 1],
  [737, '2P', 581, '2P', 1],
  [714, '2A', 576, '2A', 1],
  [648, '2A', 576, '2A', 1],
  [714, '2A', 496, '2A', 1],
  [648, '2A', 496, '2A', 2],
  [2401, '2P', 141, '2P', 4],
].map(([L, cl, W, cw, Q], i) => ({ name: `件${i}`, L, W, Q, codeL: c(cl), codeW: c(cw) }));

test('封邊代碼解析', () => {
  assert.deepEqual(c('2A'), { n: 2, type: 'A' });
  assert.deepEqual(c(' 1p '), { n: 1, type: 'P' });
  assert.equal(c(''), null);
  assert.equal(c('2X'), null);
});

test('封邊：寬欄代碼封長邊、長欄代碼封寬邊', () => {
  // 線板 2400×80，寬欄 1A，數量 4 → (2400+30)×4 = 9720
  assert.deepEqual(core.rowBanding({ L: 2400, W: 80, Q: 4, codeL: null, codeW: c('1A') }, 30), { A: 9720, P: 0 });
  // 前擋板 665×41，寬欄 1P，數量 6 → (665+30)×6 = 4170
  assert.deepEqual(core.rowBanding({ L: 665, W: 41, Q: 6, codeL: null, codeW: c('1P') }, 30), { A: 0, P: 4170 });
  // 長欄 2P、寬欄空白 → 2×(寬+30)
  assert.deepEqual(core.rowBanding({ L: 810, W: 631, Q: 1, codeL: c('2P'), codeW: null }, 30), { A: 0, P: 2 * 661 });
  // 30mm 檯面組 A 封邊合計 63.86 m
  assert.deepEqual(core.bandingTotals(COUNTERTOP, 30), { A: 63860, P: 0 });
});

test('30mm 檯面組用規格 4 需要 5 片大板', () => {
  const res = core.packGroup(COUNTERTOP, SPEC4, OPTS);
  assert.equal(res.boards.length, 5);
  assertValidPack(res, COUNTERTOP, SPEC4, 4, 10);
});

test('18mm 紅豆杉組：踢腳板 2401 超過修邊後的 2400 放不進，其餘 2 片大板', () => {
  const res = core.packGroup(YEW, SPEC4, OPTS);
  assert.deepEqual(res.tooBig.map((r) => [r.L, r.W, r.Q]), [[2401, 141, 4]]);
  assert.equal(res.boards.length, 2);
  assertValidPack(res, YEW, SPEC4, 4, 10);
});

test('修邊後可用 2400×1190：剛好的放得進，多 1mm 就挑出來', () => {
  const rows = [
    { name: '太長', L: 2401, W: 300, Q: 2 },
    { name: '太寬', L: 1000, W: 1191, Q: 1 },
    { name: '剛好', L: 2400, W: 1190, Q: 1 },
  ];
  const res = core.packGroup(rows, SPEC4, OPTS);
  assert.deepEqual(res.tooBig.map((r) => r.name), ['太長', '太寬']);
  assert.equal(res.boards.length, 1);
  assert.deepEqual(res.usable, { L: 2400, W: 1190 });
  assertValidPack(res, rows, SPEC4, 4, 10);
});

test('每刀扣 4mm：剛好塞滿與差 1mm 的情況', () => {
  // 可用長 2400：n 片長 a 排一排要 n×a + (n−1)×4 ≤ 2400
  // 3 片 797：797×3 + 8 = 2399 → 一片大板一排放得下 3 片
  const fit = core.packGroup([{ name: 'a', L: 797, W: 1190, Q: 3 }], SPEC4, OPTS);
  assert.equal(fit.boards.length, 1);
  // 3 片 798：798×3 + 8 = 2402 → 超過，要 2 片大板
  assert.equal(core.packGroup([{ name: 'a', L: 798, W: 1190, Q: 3 }], SPEC4, OPTS).boards.length, 2);
  // 寬向：可用 1190，8 條寬 145：145×8 + 7×4 = 1188 → 放得下
  assert.equal(core.packGroup([{ name: 'b', L: 2400, W: 145, Q: 8 }], SPEC4, OPTS).boards.length, 1);
  assert.equal(core.packGroup([{ name: 'b', L: 2400, W: 146, Q: 8 }], SPEC4, OPTS).boards.length, 2);
  // 第一片從修邊後的位置開始
  assert.equal(fit.boards[0].placements[0].x, 10);
  assert.equal(fit.boards[0].placements[0].y, 10);
  assertValidPack(fit, [{ name: 'a', L: 797, W: 1190, Q: 3 }], SPEC4, 4, 10);
});

test('數量 0 或空清單不會出錯', () => {
  assert.equal(core.packGroup([], SPEC4, OPTS).boards.length, 0);
  assert.equal(core.packGroup([{ name: 'x', L: 100, W: 100, Q: 0 }], SPEC4, OPTS).boards.length, 0);
});

test('隨機料件：所有排法都合法（不重疊、可一刀切）', () => {
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const { packGuillotine, packStrips, ORDERS, CHOICES, SPLITS } = core._internal;
  for (let round = 0; round < 15; round++) {
    const rows = [];
    const n = 5 + Math.floor(rand() * 25);
    for (let i = 0; i < n; i++) {
      rows.push({ name: `r${i}`, L: 50 + Math.floor(rand() * 2300), W: 30 + Math.floor(rand() * 1100), Q: 1 + Math.floor(rand() * 4) });
    }
    const res = core.packGroup(rows, SPEC4, OPTS);
    assertValidPack(res, rows, SPEC4, 4, 10);

    const pieces = [];
    rows.forEach((r, ref) => {
      for (let k = 0; k < r.Q; k++) pieces.push({ w: r.L + 10, h: r.W + 10, ref });
    });
    const all = [packStrips(pieces, 2420, 1210)];
    for (const o of Object.keys(ORDERS))
      for (const ch of Object.keys(CHOICES))
        for (const sp of Object.keys(SPLITS)) all.push(packGuillotine(pieces, 2420, 1210, o, ch, sp));
    for (const boards of all) {
      assert.equal(boards.flat().length, pieces.length);
      for (const pl of boards) assert.ok(isGuillotine(pl, 0, 0, 2420, 1210));
    }
  }
});

test('相同排法的大板會合併計數', () => {
  const rows = [{ name: '踢腳板', L: 2400, W: 141, Q: 16 }];
  const res = core.packGroup(rows, SPEC4, OPTS);
  assert.equal(res.boards.length, 2); // 每片放 8 條（141×8 + 7×4 = 1156 ≤ 1190）
  const groups = core.groupIdenticalBoards(res.boards, rows);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].count, 2);
});
