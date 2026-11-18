/* 裁板計算：畫面 */
(function () {
  'use strict';

  const core = window.PanelCore;
  const STORE_KEY = 'panelCutting.settings.v1';
  const $ = (id) => document.getElementById(id);

  const state = {
    fileName: '',
    parsed: null,
    rows: [],
    edited: false,
    settings: loadSettings(),
    overrides: {}, // 組別 key → 規格 index
    results: [],
  };

  // ---------------------------------------------------------------------------
  // 設定（存在瀏覽器）
  // ---------------------------------------------------------------------------
  function defaults() {
    return JSON.parse(JSON.stringify(core.DEFAULT_SETTINGS));
  }

  function loadSettings() {
    const d = defaults();
    try {
      const raw = window.localStorage.getItem(STORE_KEY);
      if (!raw) return d;
      const s = JSON.parse(raw);
      const num = (v, fb) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : fb);
      return {
        kerf: num(s.kerf, d.kerf),
        bandAdd: num(s.bandAdd, d.bandAdd),
        trim: num(s.trim, d.trim),
        specs: d.specs.map((sp, i) => ({
          L: num(s.specs && s.specs[i] && s.specs[i].L, sp.L) || sp.L,
          W: num(s.specs && s.specs[i] && s.specs[i].W, sp.W) || sp.W,
        })),
        defaultSpec: [0, 1, 2, 3].includes(Number(s.defaultSpec)) ? Number(s.defaultSpec) : d.defaultSpec,
      };
    } catch (e) {
      return d;
    }
  }

  function saveSettings() {
    try {
      window.localStorage.setItem(STORE_KEY, JSON.stringify(state.settings));
    } catch (e) {
      /* 無痕模式等情況存不了，不影響使用 */
    }
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
    state.overrides = {};
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
      const specIdx = state.overrides[g.key] != null ? state.overrides[g.key] : s.defaultSpec;
      const spec = s.specs[specIdx];
      return {
        ...g,
        specIdx,
        spec,
        count: g.rows.reduce((n, r) => n + r.Q, 0),
        pack: core.packGroup(g.rows, spec, { kerf: s.kerf, trim: s.trim }),
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
    const tooBig = state.results.reduce((n, r) => n + r.pack.tooBig.reduce((m, x) => m + x.Q, 0), 0);
    if (tooBig) problems.push(`有 ${tooBig} 片料件比大板還大，放不進去（請看下方紅字）`);

    if (expected != null && expected === actual && !problems.length) {
      setStatus('ok', `✓ 讀到 ${actual} 片，和料單「片數總計 ${expected}」相符${editedNote}`);
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
          <td><select data-group="${i}" aria-label="${esc(r.color)} ${r.thickness}mm 的大板規格">${specOptions(r.specIdx)}</select></td>
          <td class="num boards">${r.pack.boards.length} <small>片</small>${big ? `<span class="warn-cell">另有 ${big} 片放不進</span>` : ''}</td>
          <td class="num">${meters(r.band.A)}</td>
          <td class="num">${meters(r.band.P)}</td>
        </tr>`;
      })
      .join('');
    $('calcNote').textContent =
      `算法：料件的長對大板的長（不轉向）、每片長寬各加 ${s.kerf}mm` +
      (s.trim ? `、大板每邊修邊 ${s.trim}mm` : '') +
      `；封邊每邊加 ${s.bandAdd}mm，寬欄的代碼封長邊、長欄的代碼封寬邊。大板片數是電腦排版的結果，可點下方排版圖確認。`;
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
    let html = `<p class="grain">大板 ${sp.L} × ${sp.W}：橫向 = 長（紋路方向），直向 = 寬。灰色是剩料。</p>`;
    if (r.pack.tooBig.length) {
      html += `<p class="too-big">放不進這個規格的料件：${r.pack.tooBig
        .map((x) => `${esc(x.name)} ${x.L}×${x.W}（${x.Q} 片）`)
        .join('、')}</p>`;
    }
    html += '<div class="boards-grid">';
    for (const g of groups) {
      const range = g.count > 1 ? `第 ${n}～${n + g.count - 1} 片` : `第 ${n} 片`;
      n += g.count;
      html += `<div class="board-card">
        <p class="board-title"><span>${range}</span>${g.count > 1 ? `<span class="times">同樣排法 × ${g.count} 片</span>` : ''}<span class="fill">使用率 ${Math.round(g.board.fill * 100)}%</span></p>
        ${boardSvg(g.board, r.rows, sp, r.pack.kerf)}
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

  function boardSvg(board, rows, sp, kerf) {
    const gap = Math.min(kerf, 10) / 2;
    let out = `<svg class="board" viewBox="0 0 ${sp.L} ${sp.W}" role="img" aria-label="大板 ${sp.L}×${sp.W} 排版圖">`;
    for (const q of board.placements) {
      const r = rows[q.ref];
      const size = `${r.L}×${r.W}`;
      const name = r.name || '';
      const hue = hueFor(`${name}${size}`);
      const x = q.x + gap / 2;
      const y = q.y + gap / 2;
      const w = Math.max(q.w - gap, 1);
      const h = Math.max(q.h - gap, 1);
      out += `<g><title>${esc(name)} ${size}</title><rect x="${x}" y="${y}" width="${w}" height="${h}" fill="hsl(${hue} 60% 86%)" stroke="hsl(${hue} 35% 38%)" stroke-width="4"/>`;
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
    $('setKerf').value = s.kerf;
    $('setBand').value = s.bandAdd;
    $('setTrim').value = s.trim;
    $('specEdit').innerHTML = s.specs
      .map(
        (sp, i) => `<span>規格${i + 1} 長</span><input type="number" min="1" data-spec="${i}" data-dim="L" value="${sp.L}" aria-label="規格${i + 1} 長">
        <span>寬</span><input type="number" min="1" data-spec="${i}" data-dim="W" value="${sp.W}" aria-label="規格${i + 1} 寬">`
      )
      .join('');
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
      state.overrides = {};
      settingsChanged();
    });

    $('summaryBody').addEventListener('change', (e) => {
      const sel = e.target.closest('select[data-group]');
      if (!sel) return;
      const r = state.results[Number(sel.dataset.group)];
      state.overrides[r.key] = Number(sel.value);
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
    numSetting('setKerf', 'kerf');
    numSetting('setBand', 'bandAdd');
    numSetting('setTrim', 'trim');
    $('specEdit').addEventListener('change', (e) => {
      const input = e.target.closest('input[data-spec]');
      if (!input) return;
      const v = Number(input.value);
      const sp = state.settings.specs[Number(input.dataset.spec)];
      if (Number.isFinite(v) && v > 0) sp[input.dataset.dim] = v;
      input.value = sp[input.dataset.dim];
      settingsChanged();
    });
    $('resetSettings').addEventListener('click', () => {
      if (!window.confirm('把設定和大板尺寸都恢復成預設值？')) return;
      state.settings = defaults();
      state.overrides = {};
      renderSettings();
      settingsChanged();
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
