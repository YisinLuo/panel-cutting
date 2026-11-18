/* 裁板計算：畫面 */
(function () {
  'use strict';

  const core = window.PanelCore;
  // 存的設定如果還是「當時的預設值」，就換成新預設；自己改過的值照舊沿用。
  // v5：規格 4 修邊後可用寬預設從 1190 改 1195（v3、v4 存的 1190 換掉）
  // v4：刀片厚度預設從 4 改 6（v1～v3 存的 4 換掉）
  // v3：每個規格各自記修邊後可用尺寸。v1/v2 沒有可用尺寸，只沿用大板尺寸、選的規格與封邊加長
  const STORE_KEY = 'panelCutting.settings.v5';
  const OLD_STORE_KEYS = ['panelCutting.settings.v4', 'panelCutting.settings.v3', 'panelCutting.settings.v2', 'panelCutting.settings.v1'];
  const OLD_DEFAULT_BLADE = { v3: 4, v2: 4, v1: 4 };
  const OLD_DEFAULT_USE_W = { v4: [, , , 1190], v3: [, , , 1190] };
  // 每個「顏色|厚度」記住選過的大板規格，下次同顏色自動套用
  const COLOR_SPEC_KEY = 'panelCutting.colorSpecs.v1';
  const $ = (id) => document.getElementById(id);

  const state = {
    fileName: '',
    parsed: null,
    rows: [],
    edited: false,
    settings: loadSettings(),
    colorSpecs: loadJson(COLOR_SPEC_KEY, {}), // 組別 key（顏色|厚度）→ 規格 index
    results: [],
  };

  // ---------------------------------------------------------------------------
  // 設定（存在瀏覽器）
  // ---------------------------------------------------------------------------
  function defaults() {
    return JSON.parse(JSON.stringify(core.DEFAULT_SETTINGS));
  }

  function loadJson(key, fallback) {
    try {
      const raw = window.localStorage.getItem(key);
      const v = raw ? JSON.parse(raw) : null;
      return v && typeof v === 'object' ? v : fallback;
    } catch (e) {
      return fallback;
    }
  }

  function saveJson(key, value) {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      /* 無痕模式等情況存不了，不影響使用 */
    }
  }

  function loadSettings() {
    const d = defaults();
    let s = loadJson(STORE_KEY, null);
    let ver = s ? 'current' : '';
    for (const k of OLD_STORE_KEYS) {
      if (s) break;
      s = loadJson(k, null);
      if (s) ver = k.split('.').pop();
    }
    if (!s) return d;
    const num = (v, fb) => (v != null && v !== '' && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : fb);
    const specs = d.specs.map((sp, i) => {
      const o = (s.specs && s.specs[i]) || {};
      const L = num(o.L, sp.L) || sp.L;
      const W = num(o.W, sp.W) || sp.W;
      // 舊版沒有可用尺寸：大板尺寸沒改過就用新預設，有改過就四邊各修 10
      const sameSize = L === sp.L && W === sp.W;
      const useL = num(o.useL, sameSize ? sp.useL : L - 20);
      let useW = num(o.useW, sameSize ? sp.useW : W - 20);
      if (sameSize && OLD_DEFAULT_USE_W[ver] && useW === OLD_DEFAULT_USE_W[ver][i]) useW = sp.useW;
      return { L, W, useL: Math.min(useL || L, L), useW: Math.min(useW || W, W) };
    });
    const oldBlade = s.blade != null ? num(s.blade, d.blade) : d.blade;
    return {
      blade: oldBlade === OLD_DEFAULT_BLADE[ver] ? d.blade : oldBlade,
      bandAdd: num(s.bandAdd, d.bandAdd),
      specs,
      defaultSpec: [0, 1, 2, 3].includes(Number(s.defaultSpec)) ? Number(s.defaultSpec) : d.defaultSpec,
    };
  }

  function saveSettings() {
    saveJson(STORE_KEY, state.settings);
  }

  function specFor(key) {
    const v = state.colorSpecs[key];
    return [0, 1, 2, 3].includes(v) ? v : state.settings.defaultSpec;
  }

  // ---------------------------------------------------------------------------
  // 小工具
  // ---------------------------------------------------------------------------
  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const meters = (mm) => (mm > 0 ? `${(mm / 1000).toFixed(2)} 米` : '—');
  const specText = (i) => {
    const sp = state.settings.specs[i];
    return `規格${i + 1}：${sp.L} × ${sp.W}`;
  };

  function setStatus(kind, html) {
    const el = $('status');
    el.className = `status show ${kind}`;
    el.innerHTML = html;
  }

  function hueFor(text) {
    let h = 0;
    for (const ch of text) h = (h * 31 + ch.codePointAt(0)) % 360;
    return h;
  }

  // ---------------------------------------------------------------------------
  // 讀 PDF
  // ---------------------------------------------------------------------------
  async function extractItems(data) {
    const pdfjsLib = window.pdfjsLib;
    if (!pdfjsLib) throw new Error('PDF 讀取元件沒有載入，請重新整理網頁');
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdfjs/pdf.worker.min.js';
    const doc = await pdfjsLib.getDocument({ data, cMapUrl: 'vendor/pdfjs/cmaps/', cMapPacked: true }).promise;
    const items = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      for (const it of tc.items) {
        if (it.str) items.push({ str: it.str, x: it.transform[4], y: it.transform[5], page: p });
      }
    }
    return items;
  }

  async function loadPdf(name, data) {
    state.fileName = name;
    $('fileName').textContent = `已選：${name}`;
    setStatus('info', `正在讀取「${esc(name)}」…`);
    let parsed;
    try {
      parsed = core.parseTextItems(await extractItems(data));
    } catch (e) {
      console.error(e);
      setStatus('err', `讀不到這個 PDF：${esc(e.message || e)}<br>請確認是生產料單的 PDF 檔。`);
      return;
    }
    if (!parsed.rows.length) {
      setStatus('err', '這個 PDF 裡找不到料件。請確認選的是「生產料單」PDF。');
      $('resultSection').hidden = true;
      $('diagramsSection').hidden = true;
      return;
    }
    state.parsed = parsed;
    state.rows = parsed.rows.map((r) => ({ ...r }));
    state.edited = false;
    renderEditor();
    recompute();
  }

  function handleFile(file) {
    if (!file) return;
    if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') {
      setStatus('err', `「${esc(file.name)}」不是 PDF 檔，請選生產料單的 PDF。`);
      return;
    }
    file
      .arrayBuffer()
      .then((buf) => loadPdf(file.name, new Uint8Array(buf)))
      .catch((e) => setStatus('err', `檔案打不開：${esc(e.message || e)}`));
  }

  // ---------------------------------------------------------------------------
  // 計算
  // ---------------------------------------------------------------------------
  function recompute() {
    const s = state.settings;
    const valid = state.rows.filter((r) => r.Q > 0 && r.L > 0 && r.W > 0 && r.color);
    state.results = core.groupRows(valid).map((g) => {
      const specIdx = specFor(g.key);
      const spec = s.specs[specIdx];
      return {
        ...g,
        specIdx,
        spec,
        remembered: state.colorSpecs[g.key] != null && specIdx !== s.defaultSpec,
        count: g.rows.reduce((n, r) => n + r.Q, 0),
        pack: core.packGroup(g.rows, spec, { blade: s.blade }),
        band: core.bandingTotals(g.rows, s.bandAdd),
      };
    });
    renderCheck();
    renderSummary();
    renderDiagrams();
  }

  // ---------------------------------------------------------------------------
  // 畫面：核對、總表
  // ---------------------------------------------------------------------------
  function renderCheck() {
    const p = state.parsed;
    if (!p) return;
    const actual = state.rows.reduce((n, r) => n + (r.Q > 0 ? r.Q : 0), 0);
    const expected = p.total.expected;
    const editedNote = state.edited ? '（資料有手動修改過）' : '';
    const problems = [];
    if (!state.edited) {
      for (const b of p.blocks) {
        if (b.expected != null && b.expected !== b.actual) {
          problems.push(`${esc(b.color)} ${b.thickness}mm：讀到 ${b.actual} 片，料單寫 ${b.expected} 片`);
        }
      }
    }
    for (const w of p.warnings) problems.push(esc(w));
    for (const r of state.results) {
      if (!r.pack.tooBig.length) continue;
      const u = r.pack.usable;
      const list = r.pack.tooBig.map((x) => `${esc(x.name)} ${x.L}×${x.W}（${x.Q} 片）`).join('、');
      problems.push(
        `${esc(r.color)} ${r.thickness}mm：${list} 比規格${r.specIdx + 1}修邊後可用的 ${u.L}×${u.W} 還大，沒有算進大板片數。可以在結果表把這一組換成大一點的規格。`
      );
    }

    const list = () => `<ul>${problems.map((x) => `<li>${x}</li>`).join('')}</ul>`;
    if (expected != null && expected === actual && !problems.length) {
      setStatus('ok', `✓ 讀到 ${actual} 片，和料單「片數總計 ${expected}」相符${editedNote}`);
    } else if (expected != null && expected === actual) {
      setStatus('warn', `✓ 讀到 ${actual} 片，和料單「片數總計 ${expected}」相符${editedNote}。另外請注意：${list()}`);
    } else if (expected != null && expected !== actual) {
      setStatus(
        'warn',
        `⚠ 讀到 ${actual} 片，但料單寫 ${expected} 片，請到下方「檢查／修改讀到的資料」核對${editedNote}` +
          (problems.length ? `<ul>${problems.map((x) => `<li>${x}</li>`).join('')}</ul>` : '')
      );
    } else if (problems.length) {
      setStatus('warn', `⚠ 讀到 ${actual} 片，請注意：<ul>${problems.map((x) => `<li>${x}</li>`).join('')}</ul>`);
    } else {
      setStatus('info', `讀到 ${actual} 片（料單上找不到總計可以核對）${editedNote}`);
    }
  }

  function specOptions(selected) {
    return state.settings.specs
      .map((_, i) => `<option value="${i}"${i === selected ? ' selected' : ''}>${esc(specText(i))}</option>`)
      .join('');
  }

  function renderSummary() {
    const s = state.settings;
    $('resultSection').hidden = false;
    $('summaryBody').innerHTML = state.results
      .map((r, i) => {
        const big = r.pack.tooBig.reduce((n, x) => n + x.Q, 0);
        return `<tr>
          <td><b>${esc(r.color)}</b></td>
          <td class="num">${r.thickness}</td>
          <td class="num">${r.count}</td>
          <td><select data-group="${i}" aria-label="${esc(r.color)} ${r.thickness}mm 的大板規格">${specOptions(r.specIdx)}</select>${
            r.remembered ? '<span class="remember">這個顏色會記住用這個規格</span>' : ''
          }</td>
          <td class="num boards">${r.pack.boards.length} <small>片</small>${big ? `<span class="warn-cell">另有 ${big} 片放不進</span>` : ''}</td>
          <td class="num">${meters(r.band.A)}</td>
          <td class="num">${meters(r.band.P)}</td>
        </tr>`;
      })
      .join('');
    const used = [...new Set(state.results.map((r) => r.specIdx))].sort();
    const usable = used.map((i) => `規格${i + 1} 可用 ${s.specs[i].useL}×${s.specs[i].useW}`).join('、');
    $('calcNote').textContent =
      `算法：大板修邊後的可用尺寸（${usable}）、每裁一刀扣 ${s.blade}mm（刀片厚度），料件的長對大板的長（不轉向）；` +
      `封邊每邊加 ${s.bandAdd}mm，寬欄的代碼封長邊、長欄的代碼封寬邊。大板片數是電腦排版的結果，可點下方排版圖確認。`;
    $('printHead').textContent = `料單：${state.fileName}　列印日期：${new Date().toLocaleDateString('zh-TW')}`;
  }

  // ---------------------------------------------------------------------------
  // 畫面：排版圖
  // ---------------------------------------------------------------------------
  function renderDiagrams() {
    const wrap = $('diagrams');
    const openKeys = new Set([...wrap.querySelectorAll('details[open]')].map((d) => d.dataset.key));
    $('diagramsSection').hidden = !state.results.length;
    wrap.innerHTML = state.results
      .map((r, i) => {
        const sp = r.spec;
        return `<details class="box" data-index="${i}" data-key="${esc(r.key)}"${openKeys.has(r.key) ? ' open' : ''}>
          <summary>${esc(r.color)}　${r.thickness}mm　<span class="summary-meta">${r.pack.boards.length} 片大板（規格${r.specIdx + 1}：${sp.L}×${sp.W}）</span></summary>
          <div class="inner" data-rendered="0"></div>
        </details>`;
      })
      .join('');
    wrap.querySelectorAll('details').forEach((d) => {
      if (d.open) fillDiagram(d);
      d.addEventListener('toggle', () => d.open && fillDiagram(d));
    });
  }

  function fillDiagram(details) {
    const inner = details.querySelector('.inner');
    if (inner.dataset.rendered === '1') return;
    const r = state.results[Number(details.dataset.index)];
    const sp = r.spec;
    const groups = core.groupIdenticalBoards(r.pack.boards, r.rows);
    let n = 1;
    const u = r.pack.usable;
    let html = `<p class="grain">大板 ${sp.L} × ${sp.W}，修邊後可用 ${u.L} × ${u.W}；料件之間留 ${r.pack.blade}mm 刀縫。橫向 = 長（紋路方向），直向 = 寬。外框深灰是修邊，淺灰是剩料。</p>`;
    if (r.pack.tooBig.length) {
      html += `<p class="too-big">比修邊後可用的 ${u.L}×${u.W} 還大、沒有排進去的料件：${r.pack.tooBig
        .map((x) => `${esc(x.name)} ${x.L}×${x.W}（${x.Q} 片）`)
        .join('、')}</p>`;
    }
    html += '<div class="boards-grid">';
    for (const g of groups) {
      const range = g.count > 1 ? `第 ${n}～${n + g.count - 1} 片` : `第 ${n} 片`;
      n += g.count;
      html += `<div class="board-card">
        <p class="board-title"><span>${range}</span>${g.count > 1 ? `<span class="times">同樣排法 × ${g.count} 片</span>` : ''}<span class="fill">使用率 ${Math.round(g.board.fill * 100)}%</span></p>
        ${boardSvg(g.board, r.rows, sp, r.pack)}
      </div>`;
    }
    html += '</div>';
    inner.innerHTML = html;
    inner.dataset.rendered = '1';
  }

  function textEm(s) {
    let em = 0;
    for (const ch of s) em += /[\x00-\x7f×]/.test(ch) ? 0.58 : 1;
    return em;
  }

  function boardSvg(board, rows, sp, pack) {
    let out = `<svg class="board" viewBox="0 0 ${sp.L} ${sp.W}" role="img" aria-label="大板 ${sp.L}×${sp.W} 排版圖">`;
    const { x: ox, y: oy } = pack.offset;
    if (ox > 0 || oy > 0) {
      // 修邊：外框深灰，可用範圍淺灰（剩料）；太細看不到，畫圖時至少 6mm
      const tx = ox > 0 ? Math.max(ox, 6) : 0;
      const ty = oy > 0 ? Math.max(oy, 6) : 0;
      out += `<rect x="0" y="0" width="${sp.L}" height="${sp.W}" fill="#9aa1ab"/>`;
      out += `<rect x="${tx}" y="${ty}" width="${sp.L - 2 * tx}" height="${sp.W - 2 * ty}" fill="#eceef1"/>`;
    }
    for (const q of board.placements) {
      const r = rows[q.ref];
      const size = `${r.L}×${r.W}`;
      const name = r.name || '';
      const hue = hueFor(`${name}${size}`);
      const { x, y } = q;
      const w = Math.max(q.w, 1);
      const h = Math.max(q.h, 1);
      out += `<g><title>${esc(name)} ${size}</title><rect x="${x}" y="${y}" width="${w}" height="${h}" fill="hsl(${hue} 60% 86%)" stroke="hsl(${hue} 35% 38%)" stroke-width="3"/>`;
      const cx = x + w / 2;
      const cy = y + h / 2;
      const two = Math.min(64, (h * 0.8) / 2.3, (w * 0.9) / Math.max(textEm(name), textEm(size)));
      const one = Math.min(64, h * 0.72, (w * 0.9) / textEm(size));
      if (name && two >= 26) {
        out += `<text x="${cx}" y="${cy - two * 0.15}" font-size="${two.toFixed(0)}" text-anchor="middle" fill="#1d232b" font-weight="700">${esc(name)}</text>`;
        out += `<text x="${cx}" y="${cy + two * 1.0}" font-size="${two.toFixed(0)}" text-anchor="middle" fill="#1d232b">${size}</text>`;
      } else if (one >= 18) {
        out += `<text x="${cx}" y="${cy + one * 0.36}" font-size="${one.toFixed(0)}" text-anchor="middle" fill="#1d232b">${size}</text>`;
      }
      out += '</g>';
    }
    return `${out}</svg>`;
  }

  // ---------------------------------------------------------------------------
  // 畫面：修改資料
  // ---------------------------------------------------------------------------
  function renderEditor() {
    $('editorBox').hidden = false;
    $('editorBody').innerHTML = state.rows
      .map(
        (r, i) => `<tr data-i="${i}">
        <td><input class="w-color" type="text" data-f="color" value="${esc(r.color)}" aria-label="顏色"></td>
        <td><input type="number" data-f="thickness" value="${r.thickness}" min="0" aria-label="厚"></td>
        <td><input class="w-name" type="text" data-f="name" value="${esc(r.name)}" aria-label="名稱"></td>
        <td><input type="number" data-f="L" value="${r.L}" min="0" aria-label="長"></td>
        <td><input class="w-code" type="text" data-f="codeL" value="${core.formatCode(r.codeL)}" aria-label="長的封邊"></td>
        <td><input type="number" data-f="W" value="${r.W}" min="0" aria-label="寬"></td>
        <td><input class="w-code" type="text" data-f="codeW" value="${core.formatCode(r.codeW)}" aria-label="寬的封邊"></td>
        <td><input type="number" data-f="Q" value="${r.Q}" min="0" aria-label="數量"></td>
        <td><button class="del" type="button" title="刪除這列" aria-label="刪除這列">✕</button></td>
      </tr>`
      )
      .join('');
  }

  let recomputeTimer = null;
  function scheduleRecompute() {
    clearTimeout(recomputeTimer);
    recomputeTimer = setTimeout(recompute, 400);
  }

  function onEditorInput(e) {
    const input = e.target.closest('input');
    if (!input) return;
    const row = state.rows[Number(input.closest('tr').dataset.i)];
    const f = input.dataset.f;
    if (f === 'codeL' || f === 'codeW') {
      const v = input.value.trim();
      const code = core.parseCode(v);
      input.style.borderColor = v && !code ? 'var(--err)' : '';
      row[f] = code;
    } else if (f === 'color' || f === 'name') {
      row[f] = input.value.trim();
    } else {
      row[f] = Number(input.value) || 0;
    }
    state.edited = true;
    scheduleRecompute();
  }

  function onEditorClick(e) {
    const btn = e.target.closest('.del');
    if (!btn) return;
    const i = Number(btn.closest('tr').dataset.i);
    const r = state.rows[i];
    if (!window.confirm(`確定刪除「${r.name} ${r.L}×${r.W}」這列？`)) return;
    state.rows.splice(i, 1);
    state.edited = true;
    renderEditor();
    recompute();
  }

  function addRow() {
    const last = state.rows[state.rows.length - 1] || { color: '', thickness: 18 };
    state.rows.push({ name: '', color: last.color, thickness: last.thickness, L: 0, W: 0, Q: 1, codeL: null, codeW: null });
    state.edited = true;
    renderEditor();
    const inputs = $('editorBody').querySelectorAll('tr:last-child input');
    if (inputs[2]) inputs[2].focus();
  }

  // ---------------------------------------------------------------------------
  // 規格與設定
  // ---------------------------------------------------------------------------
  function renderSpecSelect() {
    $('specSelect').innerHTML = specOptions(state.settings.defaultSpec);
  }

  function renderSettings() {
    const s = state.settings;
    $('setBlade').value = s.blade;
    $('setBand').value = s.bandAdd;
    const cell = (i, dim, label) =>
      `<td><input type="number" min="1" data-spec="${i}" data-dim="${dim}" value="${s.specs[i][dim]}" aria-label="規格${i + 1} ${label}"></td>`;
    $('specEditBody').innerHTML = s.specs
      .map(
        (sp, i) =>
          `<tr><th scope="row">規格${i + 1}</th>${cell(i, 'L', '大板長')}${cell(i, 'W', '大板寬')}${cell(i, 'useL', '修邊後可用長')}${cell(i, 'useW', '修邊後可用寬')}</tr>`
      )
      .join('');
    renderRemembered();
  }

  function renderRemembered() {
    const entries = Object.entries(state.colorSpecs);
    $('rememberedInfo').innerHTML = entries.length
      ? `已記住的顏色：${entries
          .map(([k, v]) => {
            const [color, t] = k.split('|');
            return `${esc(color)} ${esc(t)}mm → 規格${v + 1}`;
          })
          .join('、')}`
      : '還沒有記住任何顏色。在結果表某一列換規格，就會記住那個顏色。';
    $('clearRemembered').hidden = !entries.length;
  }

  function settingsChanged() {
    saveSettings();
    renderSpecSelect();
    if (state.parsed) recompute();
  }

  // ---------------------------------------------------------------------------
  // 列印
  // ---------------------------------------------------------------------------
  function printWithDiagrams() {
    const ds = [...$('diagrams').querySelectorAll('details')];
    const wasOpen = ds.map((d) => d.open);
    ds.forEach((d) => {
      d.open = true;
      fillDiagram(d);
    });
    document.body.classList.add('print-diagrams');
    const restore = () => {
      document.body.classList.remove('print-diagrams');
      ds.forEach((d, i) => (d.open = wasOpen[i]));
      window.removeEventListener('afterprint', restore);
    };
    window.addEventListener('afterprint', restore);
    window.print();
  }

  // ---------------------------------------------------------------------------
  // 事件
  // ---------------------------------------------------------------------------
  function init() {
    renderSpecSelect();
    renderSettings();

    $('fileInput').addEventListener('change', (e) => {
      handleFile(e.target.files[0]);
      e.target.value = '';
    });

    const drop = $('drop');
    ['dragenter', 'dragover'].forEach((t) =>
      document.addEventListener(t, (e) => {
        e.preventDefault();
        drop.classList.add('over');
      })
    );
    ['dragleave', 'drop'].forEach((t) =>
      document.addEventListener(t, (e) => {
        e.preventDefault();
        if (t === 'dragleave' && e.relatedTarget) return;
        drop.classList.remove('over');
      })
    );
    document.addEventListener('drop', (e) => handleFile(e.dataTransfer && e.dataTransfer.files[0]));

    $('specSelect').addEventListener('change', (e) => {
      state.settings.defaultSpec = Number(e.target.value);
      // 和新預設一樣的記住項目就不用再記
      for (const [k, v] of Object.entries(state.colorSpecs)) if (v === state.settings.defaultSpec) delete state.colorSpecs[k];
      saveJson(COLOR_SPEC_KEY, state.colorSpecs);
      renderRemembered();
      settingsChanged();
    });

    // 某個顏色換規格：記住，下次同顏色（同厚度）自動套用；換回預設規格就不再記
    $('summaryBody').addEventListener('change', (e) => {
      const sel = e.target.closest('select[data-group]');
      if (!sel) return;
      const r = state.results[Number(sel.dataset.group)];
      const v = Number(sel.value);
      if (v === state.settings.defaultSpec) delete state.colorSpecs[r.key];
      else state.colorSpecs[r.key] = v;
      saveJson(COLOR_SPEC_KEY, state.colorSpecs);
      renderRemembered();
      recompute();
    });

    $('editorBody').addEventListener('input', onEditorInput);
    $('editorBody').addEventListener('click', onEditorClick);
    $('addRow').addEventListener('click', addRow);

    const numSetting = (id, key) =>
      $(id).addEventListener('change', (e) => {
        const v = Number(e.target.value);
        if (Number.isFinite(v) && v >= 0) state.settings[key] = v;
        e.target.value = state.settings[key];
        settingsChanged();
      });
    numSetting('setBlade', 'blade');
    numSetting('setBand', 'bandAdd');
    $('specEditBody').addEventListener('change', (e) => {
      const input = e.target.closest('input[data-spec]');
      if (!input) return;
      const v = Number(input.value);
      const sp = state.settings.specs[Number(input.dataset.spec)];
      const dim = input.dataset.dim;
      if (Number.isFinite(v) && v > 0) {
        if (dim === 'L' || dim === 'W') {
          // 改大板尺寸時，可用尺寸跟著平移（修邊量不變）
          const use = dim === 'L' ? 'useL' : 'useW';
          sp[use] = Math.max(1, v - (sp[dim] - sp[use]));
          sp[dim] = v;
        } else {
          sp[dim] = Math.min(v, dim === 'useL' ? sp.L : sp.W); // 可用尺寸不能比大板大
        }
      }
      renderSettings();
      settingsChanged();
    });
    $('resetSettings').addEventListener('click', () => {
      if (!window.confirm('把刀片厚度、封邊加長、大板尺寸都恢復成預設值？（記住的顏色規格不會清掉）')) return;
      state.settings = defaults();
      renderSettings();
      settingsChanged();
    });
    $('clearRemembered').addEventListener('click', () => {
      if (!window.confirm('清掉所有記住的顏色規格？之後每個顏色都用上方選的規格。')) return;
      state.colorSpecs = {};
      saveJson(COLOR_SPEC_KEY, state.colorSpecs);
      renderRemembered();
      if (state.parsed) recompute();
    });

    $('printSummary').addEventListener('click', () => window.print());
    $('printAll').addEventListener('click', printWithDiagrams);

    // 本機測試用：http://localhost:xxxx/?sample=料單.pdf
    const sample = new URLSearchParams(window.location.search).get('sample');
    if (sample && /^(localhost|127\.0\.0\.1)$/.test(window.location.hostname)) {
      fetch(sample)
        .then((r) => {
          if (!r.ok) throw new Error(r.status);
          return r.arrayBuffer();
        })
        .then((buf) => loadPdf(sample, new Uint8Array(buf)))
        .catch((e) => setStatus('err', `範例檔讀不到：${esc(e.message)}`));
    }
  }

  init();
})();
