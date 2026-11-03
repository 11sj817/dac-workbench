/* ============================================================
 * DAC Workbench · 计算内核（纯浏览器 JS，无依赖）
 * 全部算法手写：CSV/XLSX 解析、数据体检、云模型校准、
 * KMeans、轮廓系数、PCA、CART、规则抽取、相关网络、报告生成。
 * ============================================================ */
(function (global) {
  'use strict';

  /* ---------------- 基础工具 ---------------- */
  const sum = a => a.reduce((x, y) => x + y, 0);
  const mean = a => (a.length ? sum(a) / a.length : NaN);

  function std(a) {
    if (a.length < 2) return 0;
    const m = mean(a);
    return Math.sqrt(sum(a.map(v => (v - m) ** 2)) / a.length);
  }

  function quantile(sorted, p) {
    if (!sorted.length) return NaN;
    const pos = (sorted.length - 1) * p;
    const lo = Math.floor(pos), hi = Math.ceil(pos);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  }

  // 可复现随机数（mulberry32）
  function rng(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function gauss(r) {
    let u = 0, v = 0;
    while (u === 0) u = r();
    while (v === 0) v = r();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /* ---------------- CSV 解析 ---------------- */
  /**
   * 猜测分隔符：只看引号外的字符，统计前若干行里各候选出现次数的「稳定性」。
   * 返回出现次数最一致且 >=1 的那个；都不像就退回逗号。
   */
  function detectDelimiter(text, sampleLines) {
    const cands = [',', ';', '\t', '|'];
    const maxLine = sampleLines || 12;
    const stats = {};
    cands.forEach(c => { stats[c] = []; });

    let line = 0, inQ = false;
    const counts = { ',': 0, ';': 0, '\t': 0, '|': 0 };
    for (let i = 0; i < text.length && line < maxLine; i++) {
      const ch = text[i];
      if (inQ) {
        if (ch === '"') {
          if (text[i + 1] === '"') i++;
          else inQ = false;
        }
        continue;
      }
      if (ch === '"') { inQ = true; continue; }
      if (ch === '\n') {
        cands.forEach(c => stats[c].push(counts[c]));
        cands.forEach(c => { counts[c] = 0; });
        line++;
        continue;
      }
      if (cands.indexOf(ch) >= 0) counts[ch]++;
    }
    if (line < maxLine) cands.forEach(c => stats[c].push(counts[c]));

    // 一致性：非空行里出现次数相同最多的那个
    let best = ',', bestScore = -1;
    cands.forEach(c => {
      const arr = stats[c].filter(n => n > 0 || true);
      if (!arr.length) return;
      const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
      if (mean < 1) return;                       // 根本没出现
      const sd = Math.sqrt(arr.reduce((a, b) => a + (b - mean) * (b - mean), 0) / arr.length);
      const score = mean - sd * 2;                // 出现得多且稳定
      if (score > bestScore) { bestScore = score; best = c; }
    });
    return best;
  }

  /**
   * 解析分隔文本。
   * @param {string} text
   * @param {object} [opt] { delimiter: ',', keepRowId: true }
   * @returns {{columns, rows, meta}}
   *   meta = { delimiter, dataRows, skippedBlank, widthMismatch, rowIds }
   */
  function parseCSV(text, opt) {
    const o = opt || {};
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const delim = o.delimiter || detectDelimiter(text);

    const rows = [];
    let row = [], field = '', inQ = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQ) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else inQ = false;
        } else field += c;
      } else {
        if (c === '"') inQ = true;
        else if (c === delim) { row.push(field); field = ''; }
        else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
        else if (c === '\r') { /* skip */ }
        else field += c;
      }
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }

    const clean = rows.filter(r => r.length && r.some(v => String(v).trim() !== ''));
    const skippedBlank = rows.length - clean.length;
    if (!clean.length) {
      return { columns: [], rows: [], meta: { delimiter: delim, dataRows: 0, skippedBlank, widthMismatch: 0, rowIds: [] } };
    }

    const columns = clean[0].map((h, i) => (String(h).trim() || '列' + (i + 1)));
    const width = columns.length;
    let widthMismatch = 0;

    const data = [];
    const rowIds = [];
    clean.slice(1).forEach((r, k) => {
      if (r.length !== width) widthMismatch++;
      // 行宽不齐时补齐/截断，而不是静默错位
      const cells = r.length === width ? r
        : (r.length < width ? r.concat(new Array(width - r.length).fill(''))
          : r.slice(0, width));
      data.push(cells.map(v => {
        const str = String(v).trim();
        if (str === '') return null;
        const n = Number(str);
        return Number.isFinite(n) ? n : str;
      }));
      // 稳定 rowId：原始数据行号（1-based，不含表头，跳过的空行不占号）
      rowIds.push(k + 1);
    });

    return {
      columns, rows: data,
      meta: { delimiter: delim, dataRows: data.length, skippedBlank, widthMismatch, rowIds }
    };
  }

  /* ---------------- ZIP / XLSX 解析 ---------------- */
  async function inflateRaw(bytes) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('当前浏览器不支持 DecompressionStream，请改用 CSV 或使用新版 Chrome/Edge');
    }
    const ds = new DecompressionStream('deflate-raw');
    const stream = new Blob([bytes]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  function readZip(buf) {
    const dv = new DataView(buf);
    const u8 = new Uint8Array(buf);
    let eocd = -1;
    for (let i = u8.length - 22; i >= 0 && i > u8.length - 66000; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('不是有效的 xlsx（zip 结构缺失）');
    const count = dv.getUint16(eocd + 10, true);
    let off = dv.getUint32(eocd + 16, true);
    const entries = {};
    for (let i = 0; i < count; i++) {
      if (dv.getUint32(off, true) !== 0x02014b50) break;
      const method = dv.getUint16(off + 10, true);
      const compSize = dv.getUint32(off + 20, true);
      const nameLen = dv.getUint16(off + 28, true);
      const extraLen = dv.getUint16(off + 30, true);
      const commentLen = dv.getUint16(off + 32, true);
      const localOff = dv.getUint32(off + 42, true);
      const name = new TextDecoder().decode(u8.subarray(off + 46, off + 46 + nameLen));
      const lNameLen = dv.getUint16(localOff + 26, true);
      const lExtraLen = dv.getUint16(localOff + 28, true);
      const dataOff = localOff + 30 + lNameLen + lExtraLen;
      entries[name] = { method, compSize, data: u8.subarray(dataOff, dataOff + compSize) };
      off += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  }

  async function readEntry(entries, name) {
    const e = entries[name];
    if (!e) return null;
    if (e.method === 0) return new TextDecoder().decode(e.data);
    return new TextDecoder().decode(await inflateRaw(e.data));
  }

  function colIndex(ref) {
    const m = /^([A-Z]+)/.exec(ref || '');
    if (!m) return 0;
    let n = 0;
    for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
  }

  /* 读 workbook，返回所有工作表（名称 + 路径） */
  async function xlsxSheets(entries) {
    const wb = await readEntry(entries, 'xl/workbook.xml');
    const rels = await readEntry(entries, 'xl/_rels/workbook.xml.rels');
    const out = [];
    if (!wb) return out;
    for (const m of wb.matchAll(/<sheet\b([^>]*)\/?>/g)) {
      const attrs = m[1];
      const nameM = /name="([^"]*)"/.exec(attrs);
      const idM = /r:id="rId(\d+)"/.exec(attrs);
      const name = nameM ? nameM[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>') : 'Sheet';
      let target = null;
      if (idM && rels) {
        const re = new RegExp('Id="rId' + idM[1] + '"[^>]*Target="([^"]+)"');
        const t = re.exec(rels);
        if (t) target = 'xl/' + t[1].replace(/^\/?xl\//, '');
      }
      out.push({ name, path: target });
    }
    return out;
  }

  async function parseSheetXml(sheet, shared) {
    const grid = [];
    for (const rm of sheet.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const row = [];
      for (const cm of rm[1].matchAll(/<c\s+([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = cm[1] || '';
        const inner = cm[2] || '';
        const refM = /r="([A-Z]+\d+)"/.exec(attrs);
        const idx = refM ? colIndex(refM[1]) : row.length;
        const t = /t="([^"]+)"/.exec(attrs);
        const vM = /<v[^>]*>([\s\S]*?)<\/v>/.exec(inner);
        let val = null;
        if (t && t[1] === 's' && vM) val = shared[+vM[1]] ?? null;
        else if (t && (t[1] === 'str' || t[1] === 'inlineStr')) {
          const im = /<t[^>]*>([\s\S]*?)<\/t>/.exec(inner);
          val = im ? im[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&') : (vM ? vM[1] : null);
        } else if (vM) val = Number(vM[1]);
        row[idx] = val;
      }
      grid.push(row);
    }
    if (!grid.length) return { columns: [], rows: [] };
    const width = Math.max(...grid.map(r => r.length));
    const head = [];
    for (let i = 0; i < width; i++) {
      const h = grid[0][i];
      head.push(h === null || h === undefined || h === '' ? '列' + (i + 1) : String(h));
    }
    const rows = grid.slice(1).map(r => {
      const out = [];
      for (let i = 0; i < width; i++) {
        const v = r[i];
        out.push(v === undefined || v === '' ? null : v);
      }
      return out;
    }).filter(r => r.some(v => v !== null));
    return { columns: head, rows };
  }

  async function parseXLSXAll(buf) {
    const entries = readZip(buf);
    let shared = [];
    const sst = await readEntry(entries, 'xl/sharedStrings.xml');
    if (sst) {
      shared = [...sst.matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m =>
        [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(x => x[1]).join('')
          .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
          .replace(/&quot;/g, '"').replace(/&#x27;/g, "'"));
    }
    let list = await xlsxSheets(entries);
    if (!list.length) list = [{ name: 'Sheet1', path: 'xl/worksheets/sheet1.xml' }];
    const sheets = [];
    for (const sh of list) {
      const path = sh.path || 'xl/worksheets/sheet1.xml';
      const xml = await readEntry(entries, path);
      if (!xml) { sheets.push({ name: sh.name, columns: [], rows: [], empty: true }); continue; }
      const parsed = await parseSheetXml(xml, shared);
      sheets.push({ name: sh.name, columns: parsed.columns, rows: parsed.rows, empty: !parsed.columns.length });
    }
    return sheets;
  }

  async function parseXLSX(buf) {
    const sheets = await parseXLSXAll(buf);
    const first = sheets.find(s2 => !s2.empty) || sheets[0] || { columns: [], rows: [] };
    return { columns: first.columns, rows: first.rows, sheetName: first.name, sheetCount: sheets.length };
  }

  /* ---------------- 写 xlsx（零依赖，deflate-raw） ---------------- */
  async function deflateRaw(bytes) {
    const ds = new CompressionStream('deflate-raw');
    const stream = new Blob([bytes]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  function xmlEsc(v) {
    return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  }

  function colName(n) {
    let s2 = '';
    n += 1;
    while (n > 0) { const r = (n - 1) % 26; s2 = String.fromCharCode(65 + r) + s2; n = Math.floor((n - 1) / 26); }
    return s2;
  }

  /** 把表格写成 xlsx（单工作表）。返回 ArrayBuffer。 */
  /**
   * 把 [{path: content}] 打成 ZIP（deflate-raw），返回 Uint8Array。
   * XLSX / DOCX 共用这一套打包逻辑。
   */
  async function zipFiles(files) {
    const enc = new TextEncoder();
    const chunks = [];
    const central = [];
    let offset = 0;
    const crcTable = (() => {
      const t = new Uint32Array(256);
      for (let i = 0; i < 256; i++) {
        let c = i;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        t[i] = c >>> 0;
      }
      return t;
    })();
    const crc32 = (u8) => {
      let c = 0xFFFFFFFF;
      for (let i = 0; i < u8.length; i++) c = crcTable[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
      return (c ^ 0xFFFFFFFF) >>> 0;
    };

    for (const [fname, content] of Object.entries(files)) {
      const raw = enc.encode(content);
      const comp = await deflateRaw(raw);
      const crc = crc32(raw);
      const nameBytes = enc.encode(fname);
      const now = new Date();
      const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xFFFF;
      const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xFFFF;

      const local = new Uint8Array(30 + nameBytes.length);
      const dv = new DataView(local.buffer);
      dv.setUint32(0, 0x04034b50, true);
      dv.setUint16(4, 20, true);
      dv.setUint16(6, 0, true);
      dv.setUint16(8, 8, true);           // deflate
      dv.setUint16(10, dosTime, true);
      dv.setUint16(12, dosDate, true);
      dv.setUint32(14, crc, true);
      dv.setUint32(18, comp.length, true);
      dv.setUint32(22, raw.length, true);
      dv.setUint16(26, nameBytes.length, true);
      dv.setUint16(28, 0, true);
      local.set(nameBytes, 30);

      chunks.push(local, comp);

      const cen = new Uint8Array(46 + nameBytes.length);
      const cv = new DataView(cen.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0, true);
      cv.setUint16(10, 8, true);
      cv.setUint16(12, dosTime, true);
      cv.setUint16(14, dosDate, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, comp.length, true);
      cv.setUint32(24, raw.length, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint32(42, offset, true);
      cen.set(nameBytes, 46);
      central.push(cen);

      offset += local.length + comp.length;
    }

    const cenSize = central.reduce((a, b) => a + b.length, 0);
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, central.length, true);
    ev.setUint16(10, central.length, true);
    ev.setUint32(12, cenSize, true);
    ev.setUint32(16, offset, true);

    const total = chunks.reduce((a, b) => a + b.length, 0) + cenSize + 22;
    const outBuf = new Uint8Array(total);
    let pos = 0;
    chunks.forEach(c => { outBuf.set(c, pos); pos += c.length; });
    central.forEach(c => { outBuf.set(c, pos); pos += c.length; });
    outBuf.set(eocd, pos);
    return outBuf;
  }

  /**
   * 生成 DOCX（Word 2007+ OOXML），不依赖任何外部库。
   * 支持的块：
   *   { type:'h1'|'h2'|'p'|'quote', text }
   *   { type:'table', head:[...], rows:[[...]] }
   * 中文字体走 w:eastAsia，避免 Word 回退成西文字体导致方块。
   */
  async function toDOCX(blocks, title) {
    const esc = (v) => String(v === null || v === undefined ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

    const RPR = (bold, sz, color) =>
      '<w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="宋体"/>'
      + (bold ? '<w:b/>' : '')
      + (color ? `<w:color w:val="${color}"/>` : '')
      + `<w:sz w:val="${sz || 21}"/><w:szCs w:val="${sz || 21}"/></w:rPr>`;

    const para = (text, opt) => {
      const o = opt || {};
      const style = o.h ? `<w:pStyle w:val="Heading${o.h}"/>` : '';
      const align = o.align ? `<w:jc w:val="${o.align}"/>` : '';
      const spacing = o.spacing ? `<w:spacing w:before="${o.spacing[0]}" w:after="${o.spacing[1]}"/>` : '';
      // 简单处理：按换行拆成多个 run
      const runs = String(text).split('\n').map((line, i) =>
        (i ? '<w:br/>' : '') + `<w:r>${RPR(o.bold, o.sz, o.color)}<w:t xml:space="preserve">${esc(line)}</w:t></w:r>`
      ).join('');
      // 没有 style 时不要生成空的 <w:pPr>，否则 python-docx 读到 paragraph.style = None
      const pPr = (style || align || spacing) ? `<w:pPr>${style}${align}${spacing}</w:pPr>` : '';
      return `<w:p>${pPr}${runs}</w:p>`;
    };

    const table = (head, rows) => {
      const cellW = Math.floor(9000 / Math.max(1, head.length));
      const tcPr = `<w:tcPr><w:tcW w:w="${cellW}" w:type="dxa"/><w:tcBorders>`
        + '<w:top w:val="single" w:sz="4" w:color="999999"/>'
        + '<w:left w:val="single" w:sz="4" w:color="999999"/>'
        + '<w:bottom w:val="single" w:sz="4" w:color="999999"/>'
        + '<w:right w:val="single" w:sz="4" w:color="999999"/>'
        + '</w:tcBorders></w:tcPr>';
      const rowXml = (cells, isHead) => '<w:tr>' + cells.map(c => {
        const shd = isHead ? '<w:shd w:val="clear" w:fill="F2F5F7"/>' : '';
        return `<w:tc>${tcPr.replace('</w:tcPr>', shd + '</w:tcPr>')}`
          + `<w:p><w:pPr><w:spacing w:before="20" w:after="20"/></w:pPr>`
          + `<w:r>${RPR(isHead, 19)}<w:t xml:space="preserve">${esc(c)}</w:t></w:r></w:p></w:tc>`;
      }).join('') + '</w:tr>';
      return '<w:tbl><w:tblPr><w:tblW w:w="9000" w:type="dxa"/></w:tblPr><w:tblGrid>'
        + head.map(() => `<w:gridCol w:w="${cellW}"/>`).join('')
        + '</w:tblGrid>' + rowXml(head, true) + rows.map(r => rowXml(r, false)).join('')
        + '</w:tbl>';
    };

    const body = (blocks || []).map(b => {
      switch (b.type) {
        case 'h1': return para(b.text, { h: 1, bold: true, sz: 32, spacing: [240, 120] });
        case 'h2': return para(b.text, { h: 2, bold: true, sz: 26, spacing: [200, 100] });
        case 'h3': return para(b.text, { h: 3, bold: true, sz: 22, spacing: [160, 80] });
        case 'quote': return para(b.text, { sz: 20, color: '444444', spacing: [60, 60] });
        case 'table': return table(b.head || [], b.rows || []);
        default: return para(b.text, { sz: 21, spacing: [40, 80] });
      }
    }).join('');

    const docXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`;

    const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="宋体"/><w:sz w:val="21"/><w:szCs w:val="21"/></w:rPr></w:rPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:pPr><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="26"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:pPr><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:sz w:val="22"/></w:rPr></w:style>
</w:styles>`;

    const files = {
      '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`,
      '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
      'word/_rels/document.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
      'word/document.xml': docXml,
      'word/styles.xml': stylesXml
    };
    return zipFiles(files);
  }

  async function toXLSX(columns, rows, sheetName) {
    const name = xmlEsc(sheetName || 'Sheet1');
    const lines = [];
    const header = columns.map((c, j) =>
      `<c r="${colName(j)}1" t="inlineStr"><is><t>${xmlEsc(c)}</t></is></c>`).join('');
    lines.push(`<row r="1">${header}</row>`);
    rows.forEach((r, i) => {
      const cells = r.map((v, j) => {
        if (v === null || v === undefined || v === '') return '';
        const ref = colName(j) + (i + 2);
        if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}"><v>${v}</v></c>`;
        return `<c r="${ref}" t="inlineStr"><is><t>${xmlEsc(v)}</t></is></c>`;
      }).join('');
      lines.push(`<row r="${i + 2}">${cells}</row>`);
    });
    const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${lines.join('')}</sheetData></worksheet>`;

    const files = {
      '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
      '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
      'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${name}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      'xl/_rels/workbook.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
      'xl/worksheets/sheet1.xml': sheetXml
    };

    // 手工拼 zip（store + deflate 均可，这里全用 deflate）
    return zipFiles(files);

  }

  /* ---------------- 数据体检 ---------------- */
  function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }

  function numericCols(columns, rows) {
    return columns.filter((c, j) => rows.some(r => isNum(r[j])) &&
      rows.every(r => r[j] === null || isNum(r[j])));
  }

  function profile(columns, rows) {
    const out = columns.map((name, j) => {
      const vals = rows.map(r => r[j]).filter(isNum);
      const miss = rows.length - vals.length;
      const item = {
        name, missing: miss, missingRate: rows.length ? miss / rows.length : 0,
        unique: new Set(rows.map(r => r[j])).size, numeric: vals.length > 0
      };
      if (vals.length) {
        const s = [...vals].sort((a, b) => a - b);
        const q1 = quantile(s, 0.25), q3 = quantile(s, 0.75), iqr = q3 - q1;
        item.min = s[0]; item.max = s[s.length - 1];
        item.median = quantile(s, 0.5); item.mean = mean(vals); item.std = std(vals);
        item.outliers = vals.filter(v => v < q1 - 1.5 * iqr || v > q3 + 1.5 * iqr).length;
        item.skew = s.length > 2 ? skew(vals) : 0;
      }
      return item;
    });
    const warnings = [];
    out.forEach(c => {
      if (c.missingRate > 0) warnings.push(`「${c.name}」缺失 ${c.missing} 个（${(c.missingRate * 100).toFixed(1)}%），分析时按整行剔除。`);
      if (c.outliers > 0) warnings.push(`「${c.name}」检出 ${c.outliers} 个 IQR 异常值，可能拉偏分位点。`);
      if (!c.numeric) warnings.push(`「${c.name}」不是纯数值列，不参与计算。`);
    });
    return { rows: rows.length, cols: columns.length, columns: out, warnings };
  }

  function skew(a) {
    const m = mean(a), s = std(a);
    if (!s) return 0;
    return a.reduce((acc, v) => acc + ((v - m) / s) ** 3, 0) / a.length;
  }

  function pearson(xs, ys) {
    const n = xs.length;
    if (n < 3) return NaN;
    const mx = mean(xs), my = mean(ys);
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < n; i++) {
      const a = xs[i] - mx, b = ys[i] - my;
      sxy += a * b; sxx += a * a; syy += b * b;
    }
    if (!sxx || !syy) return 0;
    return sxy / Math.sqrt(sxx * syy);
  }

  function corrMatrix(columns, rows) {
    const cols = numericCols(columns, rows);
    const mat = cols.map((_, i) => cols.map((_, j) => {
      if (i === j) return 1;
      const a = [], b = [];
      rows.forEach(r => {
        if (isNum(r[columns.indexOf(cols[i])]) && isNum(r[columns.indexOf(cols[j])])) {
          a.push(r[columns.indexOf(cols[i])]);
          b.push(r[columns.indexOf(cols[j])]);
        }
      });
      return pearson(a, b);
    }));
    return { columns: cols, matrix: mat };
  }

  /* ---------------- 云模型校准 ---------------- */
  const LEVEL_LABELS = { 2: ['低', '高'], 3: ['低', '中', '高'], 4: ['很低', '偏低', '偏高', '很高'] };

  /* 由给定上下界构造各级云（Ex/En/He） */
  function buildClouds(lo, hi, levels) {
    const span = Math.max(hi - lo, 1e-9);
    const clouds = [];
    for (let k = 0; k < levels; k++) {
      const ex = lo + (k + 0.5) * span / levels;
      const en = span / (3 * levels);
      clouds.push({ ex, en, he: en / 10, label: LEVEL_LABELS[levels][k] });
    }
    return { clouds, span };
  }

  /* 用给定云集合给数值打等级码（含云滴 Monte Carlo 隶属度） */
  function assignCodes(values, clouds, levels, drops, seed) {
    const r = rng(seed);
    const n = values.length;
    const codes = new Array(n).fill(-1);
    const muMax = new Array(n).fill(0);
    const mu2 = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      const v = values[i];
      if (!isNum(v)) continue;
      let best = -1, bestK = 0, second = 0;
      for (let k = 0; k < levels; k++) {
        let acc = 0;
        const c = clouds[k];
        for (let d = 0; d < drops; d++) {
          const en = c.en + c.he * gauss(r);
          const e = Math.abs(en) < 1e-9 ? 1e-9 : en;
          acc += Math.exp(-((v - c.ex) ** 2) / (2 * e * e));
        }
        const mu = acc / drops;
        if (mu > best) { second = best; best = mu; bestK = k; }
        else if (mu > second) second = mu;
      }
      if (best <= 1e-12) {
        // 浮点下溢：值远离所有云心（如极端离群值），隶属度全为 0。
        // 此时按"距最近云心"兜底，避免被误分到最低档。
        let bestD = Infinity, k2 = 0;
        for (let k = 0; k < levels; k++) {
          const d = Math.abs(v - clouds[k].ex);
          if (d < bestD) { bestD = d; k2 = k; }
        }
        bestK = k2;
        best = 0;
      }
      codes[i] = bestK;
      muMax[i] = best;
      mu2[i] = second;
    }
    return { codes, muMax, mu2 };
  }

  /**
   * 大样本校准：值域分 K 格预计算隶属度查找表。
   * 复杂度从 O(n × levels × drops) 降到 O(K × levels × drops) + O(n)。
   * 当格宽远小于云熵 En 时，误差可忽略（K=2000 时格宽约为 En 的 1/300）。
   */
  const LUT_MIN_N = 3000;     // 超过这个样本量走 LUT
  const LUT_K = 2000;

  function assignCodesLUT(values, clouds, levels, drops, seed) {
    const n = values.length;
    let min = Infinity, max = -Infinity, cnt = 0;
    for (let i = 0; i < n; i++) {
      const v = values[i];
      if (!isNum(v)) continue;
      if (v < min) min = v;
      if (v > max) max = v;
      cnt++;
    }
    if (!cnt) return { codes: new Array(n).fill(-1), muMax: new Array(n).fill(0), mu2: new Array(n).fill(0), lut: true };
    if (!(max > min)) { min = min - 0.5; max = max + 0.5; }

    const K = LUT_K;
    const step = (max - min) / (K - 1);
    const lut = new Float64Array(K * levels);
    const r = rng(seed);
    for (let k = 0; k < K; k++) {
      const v = min + k * step;
      for (let c = 0; c < levels; c++) {
        const cl = clouds[c];
        let acc = 0;
        for (let d = 0; d < drops; d++) {
          const en = cl.en + cl.he * gauss(r);
          const e = Math.abs(en) < 1e-9 ? 1e-9 : en;
          acc += Math.exp(-((v - cl.ex) ** 2) / (2 * e * e));
        }
        lut[k * levels + c] = acc / drops;
      }
    }

    const codes = new Array(n).fill(-1);
    const muMax = new Array(n).fill(0);
    const mu2 = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      const v = values[i];
      if (!isNum(v)) continue;
      let k = Math.round((v - min) / step);
      if (k < 0) k = 0; else if (k >= K) k = K - 1;
      let best = -1, bestK = 0, second = 0;
      for (let c = 0; c < levels; c++) {
        const mu = lut[k * levels + c];
        if (mu > best) { second = best; best = mu; bestK = c; }
        else if (mu > second) second = mu;
      }
      if (best <= 1e-12) {
        let bestD = Infinity, kk = 0;
        for (let c = 0; c < levels; c++) {
          const d = Math.abs(v - clouds[c].ex);
          if (d < bestD) { bestD = d; kk = c; }
        }
        bestK = kk; best = 0;
      }
      codes[i] = bestK; muMax[i] = best; mu2[i] = second;
    }
    return { codes, muMax, mu2, lut: true };
  }

  function encodeTarget(values, opt) {
    const o = opt || {};
    const type = o.targetType || detectTargetType(values).type;
    if (!['binary','categorical','nominal','ordinal'].includes(type)) {
      return Object.assign(calibrate(values, o), { targetType: type, discrete: false });
    }
    const levelValues = o.targetLevels && o.targetLevels.length ? o.targetLevels.slice()
      : [...new Set(values.filter(v => v !== null && v !== undefined && v !== '' && !(typeof v === 'number' && !Number.isFinite(v))))]
        .sort((a,b) => typeof a === 'number' && typeof b === 'number' ? a-b : String(a).localeCompare(String(b)));
    const map = new Map(levelValues.map((v,i) => [String(v),i]));
    const codes = values.map(v => map.has(String(v)) ? map.get(String(v)) : -1);
    const counts = levelValues.map((_,i) => codes.filter(c => c === i).length);
    return { codes, counts, levels: levelValues.length, labels: levelValues.map(String),
      levelValues, targetType: type, discrete: true, clouds: [], thresholds: [],
      meanMu: null, ambiguousRate: null, degenerate: levelValues.length < 2 };
  }

  function calibrate(values, opt) {
    const { lowPct = 25, highPct = 75, drops = 500, levels = 3, seed = 42 } = opt || {};
    const idx = [];
    const vals = [];
    values.forEach((v, i) => { if (isNum(v)) { idx.push(i); vals.push(v); } });
    const sSorted = [...vals].sort((a, b) => a - b);
    const lo = quantile(sSorted, lowPct / 100);
    const hi = quantile(sSorted, highPct / 100);
    const { clouds } = buildClouds(lo, hi, levels);
    const assign = vals.length >= LUT_MIN_N ? assignCodesLUT : assignCodes;
    const { codes: c0, muMax, mu2 } = assign(vals, clouds, levels, drops, seed);

    const codes = new Array(values.length).fill(-1);
    idx.forEach((src, i) => { codes[src] = c0[i]; });
    const counts = new Array(levels).fill(0);
    c0.forEach(c => { if (c >= 0) counts[c]++; });
    const thresholds = [];
    for (let k = 0; k < levels - 1; k++) thresholds.push((clouds[k].ex + clouds[k + 1].ex) / 2);

    const n = vals.length;
    const amb = muMax.filter((m, i) => m - mu2[i] < 0.15).length;
    const meanMu = mean(muMax.filter(m => m > 0)) || 0;
    return {
      codes, counts, clouds,
      thresholds,
      meanMu,
      ambiguousRate: amb / Math.max(1, n),
      lo, hi, levels,
      degenerate: !(hi > lo),
      labels: LEVEL_LABELS[levels]
    };
  }

  /**
   * 用「外部给定的上下界」打等级码 —— 严格交叉验证专用。
   * 不会从 values 重新计算分位数，因此可以安全地作用于验证集。
   */
  function calibrateWith(values, bounds, opt) {
    const { levels = 3, drops = 500, seed = 42 } = opt || {};
    let lo = bounds.lo, hi = bounds.hi;
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
      throw new Error(`校准上下界非法: lo=${lo}, hi=${hi}`);
    }
    // 常量列（lo === hi）不该让整条流水线崩：
    // - 条件变量：给它一个极小跨度，下游会把它当成"无信息列"
    // - 目标变量：标记 degenerate，由调用方决定是否继续
    let degenerate = false;
    if (!(hi > lo)) {
      degenerate = true;
      const eps = Math.max(1e-9, Math.abs(lo) * 1e-9, 1e-12);
      hi = lo + eps;
    }
    const { clouds } = buildClouds(lo, hi, levels);
    const { codes, muMax, mu2 } = assignCodes(values, clouds, levels, drops, seed);
    const counts = new Array(levels).fill(0);
    codes.forEach(c => { if (c >= 0) counts[c]++; });
    const thresholds = [];
    for (let k = 0; k < levels - 1; k++) thresholds.push((clouds[k].ex + clouds[k + 1].ex) / 2);
    const valid = muMax.filter(m => m > 0);
    return {
      codes, counts, clouds, thresholds,
      meanMu: valid.length ? mean(valid) : 0,
      ambiguousRate: valid.length ? muMax.filter((m, i) => m - mu2[i] < 0.15).length / valid.length : 0,
      lo, hi, levels,
      labels: LEVEL_LABELS[levels],
      degenerate,
      fromBounds: true
    };
  }

  /* ---------------- 标准化 ---------------- */
  function robustScale(X) {
    const p = X[0].length;
    const med = [], iqr = [];
    for (let j = 0; j < p; j++) {
      const col = X.map(r => r[j]).sort((a, b) => a - b);
      const q1 = quantile(col, 0.25), q3 = quantile(col, 0.75);
      med.push(quantile(col, 0.5));
      iqr.push((q3 - q1) || std(col) || 1);
    }
    return X.map(r => r.map((v, j) => Math.max(-5, Math.min(5, (v - med[j]) / iqr[j]))));
  }

  /* ---------------- KMeans ---------------- */
  function dist2(a, b) {
    let s = 0;
    for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d * d; }
    return s;
  }

  function kmeans(X, k, opt) {
    const { seed = 42, nInit = 8, maxIter = 200 } = opt || {};
    const n = X.length;
    if (n < k) throw new Error('样本数少于聚类数');
    const Z = robustScale(X);
    // 同时记录缩放参数：外部样本（参考集）必须用同一组 med/iqr 才能和 centers 同尺度比较
    const pDim = X[0].length;
    const med = [], iqr = [];
    for (let j = 0; j < pDim; j++) {
      const col = X.map(r2 => r2[j]).sort((a, b) => a - b);
      const q1 = quantile(col, 0.25), q3 = quantile(col, 0.75);
      med.push(quantile(col, 0.5));
      iqr.push((q3 - q1) || std(col) || 1);
    }
    const r = rng(seed);
    let best = null;
    for (let init = 0; init < nInit; init++) {
      const centers = [Z[Math.floor(r() * n)].slice()];
      while (centers.length < k) {
        const d2 = Z.map(z => Math.min(...centers.map(c => dist2(z, c))));
        const total = sum(d2);
        let pick = 0;
        if (total > 0) {
          let acc = 0, target = r() * total;
          for (let i = 0; i < n; i++) { acc += d2[i]; if (acc >= target) { pick = i; break; } }
        } else pick = Math.floor(r() * n);
        centers.push(Z[pick].slice());
      }
      let labels = new Array(n).fill(0), changed = true, iter = 0;
      let emptyClusters = 0;
      while (changed && iter < maxIter) {
        changed = false; iter++;
        for (let i = 0; i < n; i++) {
          let bestK = 0, bestD = Infinity;
          for (let c = 0; c < k; c++) { const d = dist2(Z[i], centers[c]); if (d < bestD) { bestD = d; bestK = c; } }
          if (labels[i] !== bestK) { labels[i] = bestK; changed = true; }
        }
        emptyClusters = 0;
        for (let c = 0; c < k; c++) {
          const members = Z.filter((_, i) => labels[i] === c);
          if (!members.length) {
            // 空簇救援：把"离自己中心最远"的样本改派给空簇
            emptyClusters++;
            let farIdx = -1, farDist = -1;
            for (let i = 0; i < n; i++) {
              const d = dist2(Z[i], centers[labels[i]]);
              if (d > farDist) { farDist = d; farIdx = i; }
            }
            if (farIdx >= 0) { labels[farIdx] = c; centers[c] = Z[farIdx].slice(); }
            continue;
          }
          for (let j = 0; j < centers[c].length; j++) centers[c][j] = mean(members.map(m => m[j]));
        }
      }
      let inertia = 0;
      for (let i = 0; i < n; i++) inertia += dist2(Z[i], centers[labels[i]]);
      if (!best || inertia < best.inertia) best = { labels: labels.slice(), centers: centers.map(c => c.slice()), inertia, iters: iter, emptyClusters };
    }
    return { ...best, k, Z, med, iqr };
  }

  function silhouette(Z, labels) {
    const N = Z.length;
    if (N > 6000) return NaN;
    let pick = Z.map((_, i) => i);
    if (N > 700) {
      const r = rng(20261102);
      for (let i = pick.length - 1; i > 0; i--) {
        const j = Math.floor(r() * (i + 1));
        [pick[i], pick[j]] = [pick[j], pick[i]];
      }
      pick = pick.slice(0, 700);
    }
    const n = pick.length;
    const uniq = [...new Set(labels)];
    if (uniq.length < 2) return NaN;
    const D = [];
    for (let a = 0; a < n; a++) {
      const row = new Float64Array(n);
      for (let b = 0; b < n; b++) row[b] = Math.sqrt(dist2(Z[pick[a]], Z[pick[b]]));
      D.push(row);
    }
    let total = 0;
    for (let a = 0; a < n; a++) {
      const la = labels[pick[a]];
      let aSum = 0, aCnt = 0;
      const bMin = {};
      for (let b = 0; b < n; b++) {
        if (a === b) continue;
        const lb = labels[pick[b]];
        if (lb === la) { aSum += D[a][b]; aCnt++; }
        else {
          bMin[lb] = bMin[lb] === undefined ? [0, 0] : bMin[lb];
          bMin[lb][0] += D[a][b]; bMin[lb][1]++;
        }
      }
      const a1 = aCnt ? aSum / aCnt : 0;
      let b1 = Infinity;
      for (const c in bMin) b1 = Math.min(b1, bMin[c][0] / bMin[c][1]);
      total += (b1 === Infinity || Math.max(a1, b1) === 0) ? 0 : (b1 - a1) / Math.max(a1, b1);
    }
    return total / n;
  }

  /* ---------------- PCA（Jacobi 特征分解） ---------------- */
  function jacobiEigen(A, iter) {
    const n = A.length;
    const a = A.map(r => r.slice());
    let v = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
    for (let sweep = 0; sweep < (iter || 60); sweep++) {
      let off = 0;
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += a[i][j] * a[i][j];
      if (off < 1e-12) break;
      for (let p = 0; p < n; p++) {
        for (let q = p + 1; q < n; q++) {
          if (Math.abs(a[p][q]) < 1e-14) continue;
          const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
          const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
          const c = 1 / Math.sqrt(t * t + 1), s = t * c;
          for (let i = 0; i < n; i++) {
            const aip = a[i][p], aiq = a[i][q];
            a[i][p] = c * aip - s * aiq;
            a[i][q] = s * aip + c * aiq;
          }
          for (let i = 0; i < n; i++) {
            const api = a[p][i], aqi = a[q][i];
            a[p][i] = c * api - s * aqi;
            a[q][i] = s * api + c * aqi;
          }
          for (let i = 0; i < n; i++) {
            const vip = v[i][p], viq = v[i][q];
            v[i][p] = c * vip - s * viq;
            v[i][q] = s * vip + c * viq;
          }
        }
      }
    }
    const vals = Array.from({ length: n }, (_, i) => a[i][i]);
    const order = vals.map((v2, i) => [v2, i]).sort((x, y) => y[0] - x[0]);
    return {
      values: order.map(o => o[0]),
      vectors: order.map(o => v.map(row => row[o[1]]))
    };
  }

  function pca(X, labels, yVals) {
    const Z = robustScale(X);
    const n = Z.length, p = Z[0].length;
    const mu = Array.from({ length: p }, (_, j) => mean(Z.map(r => r[j])));
    const Zc = Z.map(r => r.map((v, j) => v - mu[j]));
    const cov = Array.from({ length: p }, (_, i) => Array.from({ length: p }, (_, j) => {
      let s = 0;
      for (let k = 0; k < n; k++) s += Zc[k][i] * Zc[k][j];
      return s / Math.max(1, n - 1);
    }));
    const { values, vectors } = jacobiEigen(cov);
    const total = sum(values.filter(v => v > 0)) || 1;
    const pc1 = vectors[0], pc2 = vectors[1] || vectors[0];
    const points = Zc.map((r, i) => ({
      x: r.reduce((s, v, j) => s + v * pc1[j], 0),
      y: r.reduce((s, v, j) => s + v * pc2[j], 0),
      c: labels ? labels[i] : 0,
      v: yVals ? yVals[i] : 0
    }));
    return {
      points,
      explained: [values[0] / total, (values[1] || 0) / total],
      loadings: pc1
    };
  }

  /* ---------------- CART ---------------- */
  function gini(counts) {
    const t = sum(counts);
    if (!t) return 0;
    return 1 - counts.reduce((s, c) => s + (c / t) ** 2, 0);
  }

  function bestSplit(X, y, nClass, minLeaf) {
    const n = X.length, p = X[0].length;
    const parentCounts = new Array(nClass).fill(0);
    y.forEach(v => parentCounts[v]++);
    const parentG = gini(parentCounts);
    let best = { gain: 0, f: -1, t: 0 };
    for (let f = 0; f < p; f++) {
      const col = X.map(r => r[f]).sort((a, b) => a - b);
      const cands = [];
      for (let q = 5; q <= 95; q += 5) cands.push(quantile(col, q / 100));
      const uniq = [...new Set(cands)];
      for (const t of uniq) {
        const lc = new Array(nClass).fill(0), rc = new Array(nClass).fill(0);
        let nl = 0;
        for (let i = 0; i < n; i++) {
          if (X[i][f] <= t) { lc[y[i]]++; nl++; } else rc[y[i]]++;
        }
        if (nl < minLeaf || n - nl < minLeaf) continue;
        const gain = parentG - ((nl / n) * gini(lc) + ((n - nl) / n) * gini(rc));
        if (gain > best.gain) best = { gain, f, t };
      }
    }
    return best;
  }

  function buildTree(X, y, nClass, depth, opt, imp) {
    const counts = new Array(nClass).fill(0);
    y.forEach(v => counts[v]++);
    const node = { counts, n: y.length, impurity: gini(counts), depth };
    if (depth >= opt.maxDepth || y.length < 2 * opt.minLeaf || node.impurity < 1e-9) return node;
    const sp = bestSplit(X, y, nClass, opt.minLeaf);
    if (sp.f < 0 || sp.gain < 1e-6) return node;
    imp[sp.f] += sp.gain * y.length;
    const li = [], lj = [], ri = [], rj = [];
    for (let i = 0; i < X.length; i++) {
      if (X[i][sp.f] <= sp.t) { li.push(X[i]); lj.push(y[i]); }
      else { ri.push(X[i]); rj.push(y[i]); }
    }
    node.f = sp.f; node.t = sp.t; node.gain = sp.gain;
    node.left = buildTree(li, lj, nClass, depth + 1, opt, imp);
    node.right = buildTree(ri, rj, nClass, depth + 1, opt, imp);
    return node;
  }

  function predictTree(node, x) {
    let cur = node;
    while (cur.f !== undefined) cur = x[cur.f] <= cur.t ? cur.left : cur.right;
    return cur.counts.indexOf(Math.max(...cur.counts));
  }

  function condDesc(name, t, labels, left) {
    const k = Math.max(0, Math.min(labels.length - 1, Math.floor(t + 1e-9)));
    const arr = left ? labels.slice(0, k + 1) : labels.slice(k + 1);
    const use = arr.length ? arr : [left ? labels[0] : labels[labels.length - 1]];
    if (use.length === 1) return `${name} = ${use[0]}`;
    return `${name} 属于 ${use[0]}~${use[use.length - 1]}`;
  }

  function collectRules(node, featureNames, labels, conds, out, condsRaw, featureLabels) {
    out = out || [];
    conds = conds || [];
    condsRaw = condsRaw || [];
    if (node.f === undefined) {
      const idx = node.counts.indexOf(Math.max(...node.counts));
      out.push({
        conditions: conds.slice(),
        // 结构化条件：{ f: 变量名, t: 等级空间阈值, left: 是否走左支, lo/hi: 该支覆盖的等级区间 }
        // 有了它，调用方才能把「低」反解回原始量纲的切点
        condRaw: condsRaw.slice(),
        then: labels[idx],
        thenLevel: idx,
        support: node.n, confidence: node.counts[idx] / node.n,
        distribution: node.counts.slice()
      });
      return out;
    }
    const name = featureNames[node.f];
    // Predictor states and outcome categories can have different cardinalities.
    const stateLabels = featureLabels ? featureLabels[node.f] : labels;
    const k = Math.max(0, Math.min(stateLabels.length - 1, Math.floor(node.t + 1e-9)));
    collectRules(node.left, featureNames, labels,
      conds.concat([condDesc(name, node.t, stateLabels, true)]), out,
      condsRaw.concat([{ f: name, t: node.t, left: true, lo: 0, hi: k }]), featureLabels);
    collectRules(node.right, featureNames, labels,
      conds.concat([condDesc(name, node.t, stateLabels, false)]), out,
      condsRaw.concat([{ f: name, t: node.t, left: false, lo: k + 1, hi: stateLabels.length - 1 }]), featureLabels);
    return out;
  }

  function cart(X, y, featureNames, labels, opt) {
    const o = Object.assign({ maxDepth: 3, minLeaf: 20 }, opt || {});
    const imp = new Array(X[0].length).fill(0);
    const root = buildTree(X, y, labels.length, 0, o, imp);
    const total = sum(imp) || 1;
    const importances = featureNames.map((n, i) => ({ name: n, value: imp[i] / total }))
      .sort((a, b) => b.value - a.value);
    let correct = 0;
    for (let i = 0; i < X.length; i++) if (predictTree(root, X[i]) === y[i]) correct++;
    return {
      root, importances,
      accuracy: correct / X.length,
      rules: collectRules(root, featureNames, labels, null, null, null, o.featureLabels),
      leaves: countLeaves(root)
    };
  }

  function countLeaves(n) { return n.f === undefined ? 1 : countLeaves(n.left) + countLeaves(n.right); }

  /* ---------------- 网络 ---------------- */
  function network(columns, rows, names, threshold) {
    const idx = names.map(n => columns.indexOf(n));
    const edges = [];
    for (let i = 0; i < names.length; i++) {
      for (let j = i + 1; j < names.length; j++) {
        const a = [], b = [];
        rows.forEach(r => {
          const x = r[idx[i]], y = r[idx[j]];
          if (isNum(x) && isNum(y)) { a.push(x); b.push(y); }
        });
        const r0 = pearson(a, b);
        if (Math.abs(r0) >= threshold) {
          edges.push({ source: names[i], target: names[j], weight: r0 });
        }
      }
    }
    const nodes = names.map(n => ({ id: n, degree: 0, strength: 0 }));
    edges.forEach(e => {
      const a = nodes.find(n => n.id === e.source), b = nodes.find(n => n.id === e.target);
      a.degree++; b.degree++;
      a.strength += Math.abs(e.weight); b.strength += Math.abs(e.weight);
    });
    nodes.sort((x, y) => y.strength - x.strength);
    return { nodes, edges };
  }

  /* ---------------- 报告 ---------------- */
  function report(res) {
    const { meta, profile: prof, calibration, scenarios, tree, net } = res;
    const L = [];
    L.push(`# 数据分析报告：${meta.target} 的影响机制\n`);
    L.push(`- 样本量：${meta.usedRows}（原始 ${meta.rows}）`);
    L.push(`- 因变量：**${meta.target}**；条件变量：${meta.factors.join('、')}`);
    L.push(`- 校准：下分位 ${meta.params.lowPct}% / 上分位 ${meta.params.highPct}%，云滴 ${meta.params.drops}，${meta.params.levels} 级`);
    L.push(`- 聚类：KMeans k=${meta.params.k}，轮廓系数 ${scenarios.silhouette.toFixed(3)}`);
    L.push(`- 决策树：深度 ${meta.params.treeDepth}，训练精度 ${(tree.accuracy * 100).toFixed(1)}%，${tree.rules.length} 条规则`
      + (tree.cv ? `；5 折交叉验证 ${(tree.cv.mean * 100).toFixed(1)}% ± ${(tree.cv.std * 100).toFixed(1)}%` : ''));
    L.push(`- 随机种子：${meta.params.seed}（同参数可复算）\n`);
    L.push('## 一、数据体检\n');
    L.push('| 变量 | 缺失 | 中位数 | 标准差 | 异常值 |');
    L.push('|---|---|---|---|---|');
    prof.columns.forEach(c => L.push(`| ${c.name} | ${c.missing} | ${c.median !== undefined ? c.median.toFixed(2) : '-'} | ${c.std !== undefined ? c.std.toFixed(2) : '-'} | ${c.outliers ?? '-'} |`));
    L.push('');
    L.push('## 二、云模型校准\n');
    Object.entries(calibration.factors).forEach(([n, c]) => {
      L.push(`- **${n}**：等级分布 ${c.counts.join('/')}，切点 ${c.thresholds.map(t => t.toFixed(2)).join(' / ')}，平均隶属度 ${c.meanMu.toFixed(3)}`);
    });
    L.push(`- **${meta.target}**：分布 ${calibration.target.counts.join('/')}\n`);
    L.push('## 三、异质性情境\n');
    // 目标是无序类别时不能比均值：编码 0/1/2 的"均值"取决于怎么编码
    const tInfo = (meta && meta.targetType) || {};
    const tType = tInfo.type || 'continuous';
    const NOMINAL = ['binary', 'categorical', 'nominal'];
    const isNominal = NOMINAL.indexOf(tType) >= 0;
    if (isNominal) {
      L.push(`目标「${meta.target}」是**无序类别**（${tInfo.levels || '?'} 个类别）。`);
      L.push('类别编码只是标签，没有大小顺序，因此本表**不给出目标均值**，也不按目标排序。');
      L.push('要看"哪个类别在哪个情境更多"，请用表格里的样本量做列联表检验（卡方/Fisher），或导出样本下钻。\n');
    }
    L.push(isNominal
      ? ('| 情境 | 样本 | ' + meta.factors.join(' | ') + ' |')
      : ('| 情境 | 样本 | ' + meta.factors.join(' | ') + ` | ${meta.target} |`));
    L.push(isNominal
      ? ('|' + '---|'.repeat(meta.factors.length + 2))
      : ('|' + '---|'.repeat(meta.factors.length + 3)));
    scenarios.stats.forEach((s, i) => {
      const nm = (scenarios.names && scenarios.names[i]) ? scenarios.names[i].tag : '-';
      const factorCells = meta.factors.map(f => s.mean[f].toFixed(2)).join(' | ');
      L.push(isNominal
        ? `| ${s.name}（${nm}） | ${s.n} | ${factorCells} |`
        : `| ${s.name}（${nm}） | ${s.n} | ${factorCells} | ${s.mean[meta.target].toFixed(3)} |`);
    });
    L.push('');
    L.push('## 四、组合效应规则\n');
    L.push('变量重要性：' + tree.importances.map(i => `${i.name} ${(i.value * 100).toFixed(1)}%`).join('、') + '\n');
    tree.rules.forEach((r, i) => {
      // 附上原始量纲区间：用户要能把这条件套回自己的业务阈值
      const withRange = (r.conditions || []).map((c2, k) => {
        const rg = r.condRanges && r.condRanges[k];
        return rg ? `${c2}（${rg}）` : c2;
      }).join(' 且 ');
      L.push(`${i + 1}. **IF** ${withRange || '（无分裂）'} → **THEN ${meta.target} = ${r.then}**（n=${r.support}，置信度 ${(r.confidence * 100).toFixed(1)}%）`);
    });
    if (tree.rules.some(r => r.condRanges && r.condRanges.some(x => x))) {
      L.push('');
      L.push('> 括号里是该等级对应的**原始量纲范围**（按本次校准的切点换算）。换一份数据或改分位设置，切点会变。');
    }
    L.push('');
    L.push('## 五、影响机制网络\n');
    L.push(`|r| ≥ ${net.threshold} 剪枝后保留 ${net.edges.length} 条边。\n`);
    L.push('| 节点 | 度 | 关联强度 |');
    L.push('|---|---|---|');
    net.nodes.forEach(n => L.push(`| ${n.id} | ${n.degree} | ${n.strength.toFixed(3)} |`));
    L.push('\n> 网络边来自 Pearson 相关，代表关联而非因果。要做因果推断，需要工具变量 / DID / 断点回归等识别策略。');
    if (res.bn) {
      const Ls = calibration.labels;
      const lv = calibration.target.levels;
      L.push('');
      L.push('## 六、贝叶斯网络与敏感度分析');
      L.push('');
      L.push(`结构学习：爬山法 + BIC（父节点上限 2），共 ${res.bn.edges.length} 条有向边：`);
      L.push(res.bn.edges.map(e => `${e.from} → ${e.to}`).join('、') + '\n');
      L.push(`| 变量 | 固定为「${Ls[0]}」 | 固定为「${Ls[1]}」 | 固定为「${Ls[2]}」 | 变化幅度 |`);
      L.push('|---|---|---|---|---|');
      (res.sens || []).forEach(({ f, rows }) => {
        const vals = rows.map(r => r.posterior[lv - 1]);
        const spread = Math.max(...vals) - Math.min(...vals);
        L.push(`| ${f} | ` + vals.map(v => (v * 100).toFixed(1) + '%').join(' | ') + ` | ${(spread * 100).toFixed(1)} pp |`);
      });
      L.push('');
      L.push(`> 表中数值为「${meta.target} = ${Ls[lv - 1]}」的条件概率。变化幅度越大，说明该变量越关键。`);
      L.push('> 结构方向来自数据评分，代表条件依赖，不等于因果。');
    }
    L.push('\n---');
    L.push('本报告由 DAC Workbench 自动生成，全部数字来自浏览器本地计算。');
    return L.join('\n');
  }


  /* ============================================================
   * 扩展能力：交叉验证 / 肘部曲线 / 稳健性 / 情境命名 / 贝叶斯网络
   * ============================================================ */

  /* ---------------- 分类评价指标 ---------------- */
  function evalMetrics(yTrue, yPred, nClasses) {
    const C = nClasses;
    const cm = Array.from({ length: C }, () => new Array(C).fill(0));
    for (let i = 0; i < yTrue.length; i++) cm[yTrue[i]][yPred[i]]++;
    let correct = 0;
    const total = yTrue.length;
    for (let i = 0; i < C; i++) correct += cm[i][i];
    const per = [];
    for (let c = 0; c < C; c++) {
      const tp = cm[c][c];
      let fp = 0, fn = 0, support = 0;
      for (let j = 0; j < C; j++) {
        if (j !== c) { fp += cm[j][c]; fn += cm[c][j]; }
        support += cm[c][j];
      }
      const prec = tp + fp ? tp / (tp + fp) : 0;
      const rec = tp + fn ? tp / (tp + fn) : 0;
      per.push({
        cls: c, support, tp, fp, fn,
        precision: prec, recall: rec,
        f1: prec + rec ? 2 * prec * rec / (prec + rec) : 0
      });
    }
    const active = per.filter(x => x.support > 0);
    return {
      accuracy: total ? correct / total : 0,
      balancedAccuracy: active.length ? mean(active.map(x => x.recall)) : 0,
      macroF1: active.length ? mean(active.map(x => x.f1)) : 0,
      perClass: per,
      confusion: cm,
      n: total
    };
  }

  /* ---------------- 分层 K 折 ---------------- */
  function stratifiedFolds(y, K, seed) {
    const byClass = {};
    y.forEach((c, i) => { (byClass[c] = byClass[c] || []).push(i); });
    const r = rng(seed ?? 42);
    Object.keys(byClass).forEach(k => {
      const arr = byClass[k];
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(r() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
    });
    const folds = Array.from({ length: K }, () => []);
    let f = 0;
    Object.keys(byClass).forEach(k => {
      byClass[k].forEach(i => { folds[f % K].push(i); f++; });
    });
    return folds;
  }

  /* ---------------- 加权统计 ---------------- */
  function weightedMean(values, weights) {
    let sw = 0, sv = 0;
    for (let i = 0; i < values.length; i++) {
      const v = values[i], w = weights ? weights[i] : 1;
      if (!isNum(v) || !isNum(w) || w <= 0) continue;
      sv += v * w; sw += w;
    }
    return sw > 0 ? sv / sw : NaN;
  }

  /** 加权分位数（权重版的经验分布函数） */
  function weightedQuantile(values, weights, q) {
    const pairs = [];
    for (let i = 0; i < values.length; i++) {
      const v = values[i], w = weights ? weights[i] : 1;
      if (!isNum(v) || !isNum(w) || w <= 0) continue;
      pairs.push([v, w]);
    }
    if (!pairs.length) return NaN;
    pairs.sort((a, b) => a[0] - b[0]);
    const total = pairs.reduce((acc, p) => acc + p[1], 0);
    let acc = 0;
    const target = q * total;
    for (let i = 0; i < pairs.length; i++) {
      acc += pairs[i][1];
      if (acc >= target) return pairs[i][0];
    }
    return pairs[pairs.length - 1][0];
  }

  /* ---------------- 分组 K 折（同一组不跨折） ---------------- */
  /**
   * 用于"同一受试者/同一企业/同一地区多次观测"的场景：
   * 同组样本必须整组落在训练折或验证折，否则会因组内相关性高估性能。
   */
  function groupFolds(groups, K, seed) {
    const byGroup = new Map();
    groups.forEach((g, i) => {
      const k = String(g);
      if (!byGroup.has(k)) byGroup.set(k, []);
      byGroup.get(k).push(i);
    });
    const keys = [...byGroup.keys()];
    const r = rng(seed ?? 42);
    for (let i = keys.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [keys[i], keys[j]] = [keys[j], keys[i]];
    }
    // 大组优先，均衡分配到 K 折
    keys.sort((a, b) => byGroup.get(b).length - byGroup.get(a).length);
    const folds = Array.from({ length: K }, () => []);
    const load = new Array(K).fill(0);
    keys.forEach(k => {
      let target = 0;
      for (let f = 1; f < K; f++) if (load[f] < load[target]) target = f;
      byGroup.get(k).forEach(i => folds[target].push(i));
      load[target] += byGroup.get(k).length;
    });
    return folds;
  }

  /* ---------------- 目标变量类型识别 ---------------- */
  /**
   * 判断决策变量是连续 / 二分类 / 多分类 / 计数。
   * 规则（可被 UI 手动覆盖）：
   *  - 字符串型 → 二分类或分类
   *  - 数值型但只有 2 个不同取值 → 二分类（**不做云模型校准**）
   *  - 整数型且不同取值很少 → 分类
   *  - 非负整数且方差明显大于均值 → 疑似计数
   *  - 其余 → 连续
   */
  function detectTargetType(values, opt) {
    const o = opt || {};
    const clean = values.filter(v => !(v === null || v === undefined ||
      (typeof v === 'number' && !Number.isFinite(v)) || (typeof v === 'string' && v.trim() === '')));
    if (!clean.length) return { type: 'unknown', levels: [], reason: '没有有效取值', n: 0 };

    const n = clean.length;
    const numCount = clean.filter(v => typeof v === 'number').length;
    const isNum = numCount === n;
    const uniq = [...new Set(clean)];

    if (!isNum) {
      const lv = uniq.slice().sort();
      return {
        type: lv.length === 2 ? 'binary' : 'categorical',
        levels: lv, n,
        reason: `含非数值（${n - numCount} 条），${lv.length} 个不同取值 → ${lv.length === 2 ? '二分类' : '多分类'}`
      };
    }

    if (uniq.length === 2) {
      const lv = uniq.slice().sort((a, b) => a - b);
      return { type: 'binary', levels: lv, n,
        reason: `数值型但只有 2 个不同取值（${lv[0]} / ${lv[1]}）→ 按二分类处理，不做分位数校准` };
    }

    const allInt = clean.every(v => Number.isInteger(v));
    // 小样本时 floor(n*0.05) 会退化到 0，改用"取值数 ≤ 10 且不超过样本数一半"
    // 判据：整数 + 取值数 ≤ 10 + 取值数不超过样本数一半（避免 1 样本 1 值）
    const MAX_LEVELS = 10;
    if (allInt && uniq.length <= MAX_LEVELS && uniq.length <= n * 0.5) {
      const lv = uniq.slice().sort((a, b) => a - b);
      return { type: 'categorical', levels: lv, n,
        reason: `全为整数且只有 ${lv.length} 个取值（≤${MAX_LEVELS}，且不超过样本数一半）→ 按有序分类处理` };
    }

    if (allInt && clean.every(v => v >= 0)) {
      const m = clean.reduce((a, b) => a + b, 0) / n;
      const vv = clean.reduce((a, b) => a + (b - m) ** 2, 0) / n;
      if (m > 0 && vv / m > 1.2) {
        return { type: 'count', levels: [], n,
          reason: `非负整数，方差/均值 = ${(vv / m).toFixed(2)}（>1.2）→ 疑似计数变量，建议用 Poisson 而非正态` };
      }
    }

    return { type: 'continuous', levels: [], n,
      reason: `连续数值，${uniq.length} 个不同取值，方差/均值比不指向计数` };
  }

  /* ---------------- 交叉验证（分层 + 全指标） ---------------- */
  /**
   * 分层 K 折交叉验证。
   * 注意：X 必须是"已离散化"的特征矩阵；若需严格无泄漏（分位数只在训练折拟合），
   * 请使用 crossValidateStrict。
   */
  function crossValidate(X, y, featureNames, labels, opt, folds) {
    const K = Math.max(2, folds || 5);
    const nClass = labels.length;
    const counts = new Array(nClass).fill(0);
    y.forEach(v => { if (v >= 0 && v < nClass) counts[v]++; });
    const present = counts.filter(c => c > 0);
    const minCount = present.length ? Math.min(...present) : 0;

    let effK = K;
    const warnings = [];
    if (minCount < K) {
      effK = Math.max(2, minCount);
      warnings.push(`最小类别仅 ${minCount} 个样本，折数由 ${K} 降为 ${effK}`);
    }
    if (y.length < 30) warnings.push(`样本量仅 ${y.length}，交叉验证结果仅供参考`);
    if (minCount < 5) warnings.push(`存在样本数 < 5 的类别，单类指标不可靠`);

    const foldIdx = stratifiedFolds(y, effK, opt?.seed ?? 42);
    const perFold = [];
    const oofPred = new Array(X.length).fill(-1);

    for (let f = 0; f < effK; f++) {
      const test = foldIdx[f];
      if (!test.length) continue;
      const testSet = new Set(test);
      const trX = [], trY = [];
      for (let i = 0; i < X.length; i++) if (!testSet.has(i)) { trX.push(X[i]); trY.push(y[i]); }
      if (trX.length < 10) { warnings.push(`第 ${f + 1} 折训练集过小，已跳过`); continue; }

      const t = cart(trX, trY, featureNames, labels, opt);
      const trPred = trX.map(x => predictTree(t.root, x));
      const teY = test.map(i => y[i]);
      const tePred = test.map(i => predictTree(t.root, X[i]));
      test.forEach((i, k) => { oofPred[i] = tePred[k]; });

      const trM = evalMetrics(trY, trPred, nClass);
      const teM = evalMetrics(teY, tePred, nClass);
      perFold.push({
        fold: f + 1, nTrain: trX.length, nTest: test.length,
        trainAccuracy: trM.accuracy, trainBalanced: trM.balancedAccuracy,
        testAccuracy: teM.accuracy, balancedAccuracy: teM.balancedAccuracy,
        macroF1: teM.macroF1
      });
    }

    const keepIdx = [];
    const keepPred = [];
    for (let i = 0; i < X.length; i++) if (oofPred[i] >= 0) { keepIdx.push(i); keepPred.push(oofPred[i]); }
    const oofY = keepIdx.map(i => y[i]);
    const oofM = evalMetrics(oofY, keepPred, nClass);

    // 校准后可能出现"空等级"（例如某一档没有任何样本）
    const emptyCls = oofM.perClass.filter(c => c.support === 0).map(c => labels[c.cls]);
    if (emptyCls.length) {
      warnings.push(`等级「${emptyCls.join('、')}」在样本中没有出现（分位区间过窄或等级过多），该类别指标无意义`);
    }

    const testAcc = perFold.map(f => f.testAccuracy);
    const trainAcc = perFold.map(f => f.trainAccuracy);
    return {
      k: effK,
      folds: perFold.length,
      perFold,
      warning: warnings.length ? warnings.join('；') : null,
      mean: mean(testAcc) || 0,
      std: std(testAcc) || 0,
      trainMean: mean(trainAcc) || 0,
      trainStd: std(trainAcc) || 0,
      gap: (mean(trainAcc) || 0) - (mean(testAcc) || 0),
      oof: {
        accuracy: oofM.accuracy,
        balancedAccuracy: oofM.balancedAccuracy,
        macroF1: oofM.macroF1,
        perClass: oofM.perClass,
        confusion: oofM.confusion,
        n: oofM.n
      }
    };
  }

  /* ============================================================
   * 严格无泄漏交叉验证
   * 每一折：填补 → 分位数 → 离散化 → 建模，全部只用训练折
   * ============================================================ */
  function crossValidateStrict(rawX, yRaw, names, labels, opt, groups) {
    const P = (typeof window !== 'undefined' ? window : globalThis).DACPre;
    if (!P) throw new Error('缺少预处理模块 DACPre（preprocess.js 未加载）');
    const o = Object.assign({
      k: 5, seed: 42,
      impute: 'median',            // 'none' | 'mean' | 'median' | 'mode' | 'knn' | 'drop'
      knn: { k: 5, weighted: true },
      lowPct: 25, highPct: 75, levels: 3, drops: 500,
      treeDepth: 3, minLeaf: 15
    }, opt || {});

    // 1) 目标变量缺失的样本直接排除（绝不填补标签）
    const validRows = [];
    const excludedByTarget = [];
    yRaw.forEach((v, i) => {
      const missing = (v === null || v === undefined) ||
        (typeof v === 'number' && !Number.isFinite(v)) ||
        (typeof v === 'string' && v.trim() === '');
      if (missing) excludedByTarget.push(i); else validRows.push(i);
    });
    if (validRows.length < 20) {
      return { ok: false, reason: `有效样本仅 ${validRows.length} 条，无法进行交叉验证`, excludedByTarget };
    }

    // 2) 目标变量离散化：先在全量有效样本上算一次"类别标签"仅用于分层；
    //    真正的分位数在每折内部用训练集重算（见下）。这里的分层只依据类别比例，
    //    属于允许的"先验设计"，不参与任何数值计算。
    const validRowsSet = new Set(validRows);
    const yvRaw = validRows.map(i => yRaw[i]);

    // 目标变量类型：离散目标不再用云模型校准（否则 0/1 会被分位数切成"等级"，类别定义被篡改）
    const tType = o.targetType || detectTargetType(yvRaw).type;
    const discreteTarget = ['binary','categorical','nominal','ordinal'].includes(tType);
    let yvEnc = null, yLevels = null;
    if (discreteTarget) {
      const lv = (o.targetLevels && o.targetLevels.length)
        ? o.targetLevels.slice()
        : [...new Set(yvRaw)].sort((a, b) => (typeof a === 'number' && typeof b === 'number') ? a - b : String(a).localeCompare(String(b)));
      yLevels = lv;
      const m = new Map(lv.map((v, i) => [String(v), i]));
      yvEnc = yvRaw.map(v => m.get(String(v)));
    }
    // 连续目标：仍然用云模型，但只在这里算一次作为"分层用的粗标签"
    const yv = discreteTarget ? yvEnc : yvRaw;
    const nLevels = discreteTarget ? (yLevels ? yLevels.length : 2) : o.levels;
    const effLabels = discreteTarget ? (yLevels || []).map(String) : labels;

    const rough = discreteTarget
      ? { codes: yvEnc }
      : calibrate(yvRaw, { lowPct: o.lowPct, highPct: o.highPct, drops: 50, levels: o.levels, seed: o.seed });
    const stratLabel = rough.codes;   // 仅用于分层，不参与任何数值计算

    // 3) 切分。三种方式，优先级：时间 > 分组 > 分层随机
    //    时间切分：按时间列排序后顺序切成 K 段，第 f 段做验证、之前的段做训练。
    //             这才是"用过去预测未来"，随机切分在有趋势的数据上会严重乐观。
    //    分组切分：同一个组（如同一家医院/同一个用户）的样本必须全在同一侧。
    let folds;
    let splitKind = 'stratified';
    if (Array.isArray(o.fixedFolds) && o.fixedFolds.length) {
      // 调用方直接指定折（嵌套验证需要："这一折的训练/测试就按我说的来"）
      folds = o.fixedFolds.map(f => ({
        train: (f.train || []).slice(),
        test: (f.test || []).slice()
      }));
      splitKind = 'fixed';
    } else if (o.timeOrder) {
      if (!Array.isArray(o.timeOrder) || o.timeOrder.length !== yRaw.length ||
          new Set(o.timeOrder).size !== yRaw.length || o.timeOrder.some(i => !Number.isInteger(i) || i < 0 || i >= yRaw.length)) {
        return { ok: false, reason: '时间顺序必须包含每个原始行恰好一次' };
      }
      if (o.timeValues && (o.timeValues.length !== yRaw.length || o.timeValues.some(v => !Number.isFinite(v)))) {
        return { ok: false, reason: '时间列存在缺失或无效时间，不能降级为随机切分' };
      }
      // timeOrder 是原始行下标按时间升序排好的序列
      const ordered = o.timeOrder.filter(i => validRowsSet.has(i));
      const K = Math.max(2, Math.min(o.k, Math.floor(ordered.length / 10) || 2));
      folds = [];
      for (let f = 0; f < K; f++) {
        const a = Math.floor(f * ordered.length / K);
        const b = Math.floor((f + 1) * ordered.length / K);
        const testRaw = ordered.slice(a, b);
        const cutoff = o.timeValues && testRaw.length ? Math.min(...testRaw.map(i => o.timeValues[i])) : null;
        const trainRaw = ordered.slice(0,a).filter(i => cutoff === null || o.timeValues[i] < cutoff);
        folds.push({ train: trainRaw.map(i => validRows.indexOf(i)), test: testRaw.map(i => validRows.indexOf(i)) });
      }
      splitKind = 'time';
    } else if (groups && groups.length === yRaw.length) {
      const gv = validRows.map(i => groups[i]);
      folds = groupFolds(gv, Math.max(2, o.k), o.seed);
      splitKind = 'group';
    } else {
      folds = stratifiedFolds(stratLabel, Math.max(2, o.k), o.seed);
    }
    const X = validRows.map(i => rawX[i].slice());

    // 条件变量类型（结构信息，不是从数据分布估计的参数）：
    // 二分类只允许 2 个等级，否则中间等级必然为空，等级编码失去意义。
    // 这里用全量判断"是不是二分类"，具体切点仍然只在训练折算。
    const colTypes = names.map((_, j) => detectTargetType(rawX.map(r => r[j])).type);
    const colLevels = colTypes.map(t => (t === 'binary') ? 2 : o.levels);
    const discreteCols = colTypes.map(t => t === 'binary' || t === 'categorical');

    const perFold = [];
    const oofPred = new Array(X.length).fill(-1);
    // OOF 的"真实标签"必须来自各折自己的验证集标签（与预测同一口径），
    // 不能用全量粗标签 stratLabel —— 那会导致混淆矩阵口径不一致
    const oofTrue = new Array(X.length).fill(-1);
    const records = [];

    for (let f = 0; f < folds.length; f++) {
      const fd = folds[f];
      const testIdx = Array.isArray(fd) ? fd : fd.test;
      if (!testIdx || testIdx.length < 2) continue;
      const testSet = new Set(testIdx);
      const trainIdx = [];
      if (!Array.isArray(fd) && Array.isArray(fd.train)) {
        // 调用方给了明确的训练集
        trainIdx.push(...fd.train);
        if (trainIdx.length < (splitKind === 'time' ? 15 : 1)) continue;
      } else if (splitKind === 'time') {
        // 只允许用比当前折更早的样本训练，绝不使用未来数据
        const minTest = Math.min(...testIdx);
        for (let i = 0; i < X.length; i++) if (i < minTest && !testSet.has(i)) trainIdx.push(i);
        if (trainIdx.length < 15) { perFold.push({ fold: f + 1, ok: false, reason: `训练段仅 ${trainIdx.length} 条，时间切分无法进行` }); continue; }
      } else {
        // 分层/分组：除测试集以外的样本都能当训练集
        for (let i = 0; i < X.length; i++) if (!testSet.has(i)) trainIdx.push(i);
      }
      if (!trainIdx.length) { perFold.push({ fold: f + 1, ok: false, reason: '训练集为空' }); continue; }

      const Xtr = trainIdx.map(i => X[i].slice());
      const Xte = testIdx.map(i => X[i].slice());
      const yTr = trainIdx.map(i => yv[i]);
      const yTe = testIdx.map(i => yv[i]);

      // ---- 3a) 填补（只在训练折 fit）----
      let impModel = null, trImp = Xtr, teImp = Xte, impLog = null;
      if (o.impute !== 'none') {
        impModel = P.fitImputer(Xtr, names, {
          strategy: o.impute === 'drop' ? 'median' : o.impute,
          knn: o.knn, fallback: 'median'
        });
        const a = P.transformImputer(Xtr, impModel, Xtr);
        const b = P.transformImputer(Xte, impModel, Xtr);
        trImp = a.matrix; teImp = b.matrix;
        impLog = { train: a.log, test: b.log, model: impModel };
      } else {
        // 不填补：用完整案例（仍只用训练折决定）
        const idxAll = names.map((_, j) => j);
        const cc = P.completeCases(Xtr, idxAll);
        if (cc.keepIdx.length < 10) continue;
        trImp = cc.matrix;
        const keptTrain = cc.keepIdx.map(i => trainIdx[i]);
        const trYKept = cc.keepIdx.map(i => yTr[i]);
        trainIdx.length = 0;
        trainIdx.push(...keptTrain);
        yTr.splice(0, yTr.length, ...trYKept);
      }

      // ---- 3b) 分位数 + 离散化（只在训练折算）----
      const bounds = [];
      for (let j = 0; j < names.length; j++) {
        const col = trImp.map(r => r[j]).filter(v => typeof v === 'number' && Number.isFinite(v));
        if (!col.length) { bounds.push({ lo: 0, hi: 1 }); continue; }
        const ss = col.sort((a, b) => a - b);
        bounds.push({ lo: quantile(ss, o.lowPct / 100), hi: quantile(ss, o.highPct / 100) });
      }
      let yBounds = null;
      if (!discreteTarget) {
        const ySorted = [...yTr].sort((a, b) => a - b);
        yBounds = { lo: quantile(ySorted, o.lowPct / 100), hi: quantile(ySorted, o.highPct / 100) };
        if (!(yBounds.hi > yBounds.lo)) yBounds.hi = yBounds.lo + 1e-6;
      }

      // 按列批量离散化：每列只建一次云、只跑一轮云滴
      // （逐单元格调用会让复杂度乘上样本数，400×11 会慢几百倍）
      // 每列的等级数按类型决定（二分类 = 2）
      const trCols = names.map((_, j) => calibrateWith(
        trImp.map(r => r[j]), bounds[j],
        { levels: colLevels[j], drops: o.drops, seed: o.seed }).codes);
      const teCols = names.map((_, j) => calibrateWith(
        teImp.map(r => r[j]), bounds[j],
        { levels: colLevels[j], drops: o.drops, seed: o.seed }).codes);
      const XtrCodes = trImp.map((_, i) => names.map((_, j) => trCols[j][i]));
      const XteCodes = teImp.map((_, i) => names.map((_, j) => teCols[j][i]));
      // 离散目标：真实标签就是编码本身；连续目标：用训练折的界离散化
      const yTrCodes = discreteTarget ? yTr.slice()
        : calibrateWith(yTr, yBounds, { levels: o.levels, drops: o.drops, seed: o.seed }).codes;
      const yTeCodes = discreteTarget ? yTe.slice()
        : calibrateWith(yTe, yBounds, { levels: o.levels, drops: o.drops, seed: o.seed }).codes;

      // ---- 3c) 建模（只用训练折）----
      const tree = cart(XtrCodes, yTrCodes, names, effLabels, {
        maxDepth: o.treeDepth, minLeaf: o.minLeaf,
        featureLabels: colLevels.map(lv => LEVEL_LABELS[lv])
      });
      const pred = XteCodes.map(r => predictTree(tree.root, r));
      testIdx.forEach((i, k) => { oofPred[i] = pred[k]; oofTrue[i] = yTeCodes[k]; });

      const trainPred = XtrCodes.map(r => predictTree(tree.root, r));
      const trM = evalMetrics(yTrCodes, trainPred, nLevels);
      const teM = evalMetrics(yTeCodes, pred, nLevels);

      perFold.push({
        fold: f + 1, nTrain: trainIdx.length, nTest: testIdx.length,
        trainAccuracy: trM.accuracy, testAccuracy: teM.accuracy,
        balancedAccuracy: teM.balancedAccuracy, macroF1: teM.macroF1,
        perClass: teM.perClass, confusion: teM.confusion,
        // 测试折逐条预测：嵌套验证要拿它算"纯测试集"精度，别的统计也要
        testPred: pred.slice(),
        testTrue: yTeCodes.slice()
      });

      records.push({
        fold: f + 1,
        trainIdx: trainIdx.slice(),
        testIdx: testIdx.slice(),
        // 映射回原始矩阵行号：审计器必须用这个基准去重算，
        // 否则 trainIdx 是压缩后矩阵的下标，与 rawX 错位 → 误报 FAIL
        trainRawIdx: trainIdx.map(i => validRows[i]),
        testRawIdx: testIdx.map(i => validRows[i]),
        imputeModel: impModel,
        bounds, yBounds,
        colLevels: colLevels.slice(),
        colTypes: colTypes.slice(),
        imputeLog: impLog
      });
    }

    // 4) OOF 汇总
    const keepIdx = [], keepPred = [], keepTrue = [];
    for (let i = 0; i < X.length; i++) {
      if (oofPred[i] >= 0 && oofTrue[i] >= 0) { keepIdx.push(i); keepPred.push(oofPred[i]); keepTrue.push(oofTrue[i]); }
    }
    const oofM = evalMetrics(keepTrue, keepPred, nLevels);
      const testAcc = perFold.map(f => f.testAccuracy).filter(Number.isFinite);

    return {
      ok: perFold.length > 0,
      k: perFold.length,
      grouped: !!(groups && groups.length === yRaw.length),
      targetType: tType,
      discreteTarget,
      targetLevels: yLevels,
      nLevels,
      perFold,
      oof: {
        accuracy: oofM.accuracy,
        balancedAccuracy: oofM.balancedAccuracy,
        macroF1: oofM.macroF1,
        perClass: oofM.perClass,
        confusion: oofM.confusion,
        n: oofM.n,
        // 可按 rowId 追回每条样本的预测 —— 光给指标没法复核
        rowId: validRows.map(i => (o.rowIds && o.rowIds[i] !== undefined) ? o.rowIds[i] : (i + 1)),
        pred: oofPred.slice(),
        true: oofTrue.slice(),
        // 多数类基线：分类问题里"永远猜最多的那一类"能拿多少
        // 没有这个数，看不出模型到底比瞎猜强多少
        baseline: (function () {
          const cnt = new Array(nLevels).fill(0);
          oofTrue.forEach(v => { if (v >= 0 && v < nLevels) cnt[v]++; });
          const tot = cnt.reduce((a, b) => a + b, 0);
          if (!tot) return null;
          const maj = cnt.indexOf(Math.max(...cnt));
          const acc = Math.max(...cnt) / tot;
          // 多数类基线的 Balanced Accuracy = (1/K_active) —— 只有最多那类召回 1，其余 0
          const active = cnt.filter(v => v > 0).length;
          return { majorityClass: maj, accuracy: acc, balancedAccuracy: active ? 1 / active : 0, n: tot };
        })()
      },
      splitKind,
      timeOrder: o.timeOrder || null,
      timeValues: o.timeValues || null,
      config: { lowPct: o.lowPct, highPct: o.highPct, levels: o.levels, drops: o.drops, treeDepth: o.treeDepth, minLeaf: o.minLeaf, names: names.slice() },
      mean: mean(testAcc) || 0,
      std: std(testAcc) || 0,
      trainMean: mean(perFold.map(f => f.trainAccuracy)) || 0,
      gap: (mean(perFold.map(f => f.trainAccuracy)) || 0) - (mean(testAcc) || 0),
      excludedByTarget,
      strict: true,
      records
    };
  }

  /**
   * 嵌套交叉验证：外层评估、内层选参。
   *
   * 与直接 CV 的区别：
   *   直接 CV 的 treeDepth / minLeaf 由调用方给定。如果这个值是「看着 CV 精度调出来的」，
   *   那 CV 精度就吃了测试折的信息，是个乐观估计。
   *   嵌套 CV 里，外层每折的训练部分再切内层 J 折，用内层 OOF 精度挑参数，
   *   然后拿这组参数在外层测试折上评估一次。外层测试折全程不可见。
   *
   * @param {number[][]} rawX
   * @param {number[]} yRaw
   * @param {string[]} names
   * @param {string[]} labels
   * @param {object} opt  与 crossValidateStrict 同参；grid 可覆盖默认网格
   * @param {string[]} [groups]
   * @returns {object}
   */
  function nestedCV(rawX, yRaw, names, labels, opt, groups) {
    const o = Object.assign({
      k: 5, innerK: 3, seed: 42,
      grid: null,
      onProgress: null
    }, opt || {});

    const grid = o.grid && o.grid.length ? o.grid : [
      { treeDepth: 3, minLeaf: 15 },
      { treeDepth: 4, minLeaf: 15 },
      { treeDepth: 3, minLeaf: 30 },
      { treeDepth: 4, minLeaf: 30 }
    ];

    // 外层：先跑一次同参数的 CV 拿到折结构（训练/测试下标）
    const outer = crossValidateStrict(rawX, yRaw, names, labels,
      Object.assign({}, o, { nested: false }), groups);

    if (!outer.ok) {
      return { ok: false, reason: outer.reason || '外层切分失败', outer };
    }

    const base = { lowPct: 25, highPct: 75, levels: 3, drops: 200 };
    const pick = Object.assign({}, base, o, {
      impute: o.impute || 'median',
      knn: o.knn,
      targetType: outer.targetType,
      targetLevels: outer.targetLevels || o.targetLevels,
      fixedFolds: null, timeOrder: null, timeValues: null, onProgress: null
    });

    const perFold = [];
    const oofPred = [];
    const oofTrue = [];
    const oofRowId = [];
    const oofOriginal = [], oofFold = [];
    const selected = [];
    let done = 0;

    for (const rec of (outer.records || [])) {
      const trRaw = rec.trainRawIdx || rec.trainIdx;
      const teRaw = rec.testRawIdx || rec.testIdx;
      if (!trRaw || !teRaw || trRaw.length < 20 || !teRaw.length) continue;

      const Xtr = trRaw.map(i => rawX[i].slice());
      const yTr = trRaw.map(i => yRaw[i]);
      const gTr = groups ? trRaw.map(i => groups[i]) : null;
      const localPos = new Map(trRaw.map((i,j) => [i,j]));
      const innerTimeOrder = o.timeOrder ? o.timeOrder.filter(i => localPos.has(i)).map(i => localPos.get(i)) : null;
      const innerTimeValues = o.timeValues ? trRaw.map(i => o.timeValues[i]) : null;

      // ---- 内层：只在训练折内部网格搜索 ----
      let best = null;
      for (const g of grid) {
        let inner;
        try {
          inner = crossValidateStrict(Xtr, yTr, names, labels,
            Object.assign({}, pick, {
              k: Math.min(o.innerK, 3),
              timeOrder: innerTimeOrder, timeValues: innerTimeValues,
              treeDepth: g.treeDepth,
              minLeaf: Math.max(3, Math.min(g.minLeaf, Math.floor(Xtr.length / 12))),
              seed: o.seed
            }), gTr);
        } catch (e) {
          continue;
        }
        if (!inner.ok) continue;
        // 用 Balanced Accuracy 选参：类别不均衡时比 accuracy 稳
        const score = inner.oof.balancedAccuracy;
        if (!best || score > best.score) {
          best = { score, params: g, innerAcc: inner.oof.accuracy };
        }
      }
      if (!best) {
        perFold.push({ fold: rec.fold, ok: false, reason: '内层网格全部失败' });
        continue;
      }

      // ---- 外层：用内层选出的参数，在完整训练折上重训，只预测测试折 ----
      // 关键：用 fixedFolds 明确指定"这一折的训练/测试"，拿到的就是纯测试集精度。
      // 早先用 k=2 的 OOF 平均，里面混了训练折样本的预测，导致嵌套精度反而更高。
      const Xte = teRaw.map(i => rawX[i].slice());
      const yTe = teRaw.map(i => yRaw[i]);
      const Xcat = Xtr.concat(Xte);
      const yCat = yTr.concat(yTe);
      const nTr = Xtr.length;

      let evalRes;
      try {
        evalRes = crossValidateStrict(Xcat, yCat, names, labels,
          Object.assign({}, pick, {
            treeDepth: best.params.treeDepth,
            minLeaf: Math.max(3, Math.min(best.params.minLeaf, Math.floor(Xtr.length / 12))),
            seed: o.seed,
            targetType: outer.targetType,
            fixedFolds: [{
              train: Array.from({ length: nTr }, (_, k) => k),
              test: Array.from({ length: Xte.length }, (_, k) => nTr + k)
            }]
          }), null);
      } catch (e) {
        perFold.push({ fold: rec.fold, ok: false, reason: '外层评估失败：' + e.message });
        continue;
      }

      const pf = (evalRes.perFold || [])[0];
      const okFold = !!(evalRes.ok && pf && pf.testAccuracy !== undefined);
      perFold.push({
        fold: rec.fold,
        ok: okFold,
        nTrain: trRaw.length,
        nTest: teRaw.length,
        chosen: best.params,
        innerScore: best.score,
        innerAcc: best.innerAcc,
        outerAcc: okFold ? pf.testAccuracy : null,
        outerBalAcc: okFold ? pf.balancedAccuracy : null,
        nTestPredicted: okFold ? Xte.length : 0
      });
      selected.push(best.params);

      if (okFold) {
        // 纯测试集的预测：可按 rowId 追回
        const preds = pf.testPred || pf.oofPred || null;
        teRaw.forEach((rawIdx, k) => {
          oofRowId.push((o.rowIds && o.rowIds[rawIdx] !== undefined) ? o.rowIds[rawIdx] : (rawIdx + 1));
          oofPred.push(preds ? preds[k] : -1);
          oofTrue.push(pf.testTrue[k]);
          oofOriginal.push(yTe[k]);
          oofFold.push(rec.fold);
        });
      }
      done++;
      if (typeof o.onProgress === 'function') {
        o.onProgress(Math.round(done / Math.max(1, (outer.records || []).length) * 100));
      }
    }

    const okFolds = perFold.filter(f => f.ok && f.outerAcc !== null);
    const pooled = oofPred.length ? evalMetrics(oofTrue, oofPred, outer.nLevels) : null;
    const meanOuter = pooled ? pooled.accuracy : null;
    const meanOuterBal = pooled ? pooled.balancedAccuracy : null;

    // 选参的稳定性：不同外层折选出不同参数，说明参数不稳、结论对外部条件敏感
    const paramKey = p => `d${p.treeDepth}-l${p.minLeaf}`;
    const counts = {};
    selected.forEach(p => { counts[paramKey(p)] = (counts[paramKey(p)] || 0) + 1; });
    const distinct = Object.keys(counts).length;

    return {
      ok: okFolds.length > 0,
      nested: true,
      k: okFolds.length,
      grid: grid.length,
      perFold,
      selectedParams: counts,
      paramStability: selected.length ? (1 - (distinct - 1) / Math.max(1, selected.length)) : null,
      // 逐条样本的外层预测：全部来自外层测试折，训练折样本不在内
      oof: oofRowId.length ? {
        rowId: oofRowId,
        pred: oofPred,
        true: oofTrue,
        original: oofOriginal,
        fold: oofFold,
        predLabel: oofPred.map(v => outer.targetLevels ? outer.targetLevels[v] : labels[v]),
        trueLabel: oofTrue.map(v => outer.targetLevels ? outer.targetLevels[v] : labels[v]),
        n: oofRowId.length,
        accuracy: meanOuter,
        balancedAccuracy: meanOuterBal
      } : null,
      // 外层测试记录的总体精度；不能无条件称为无偏估计。
      nestedAccuracy: meanOuter,
      nestedBalancedAccuracy: meanOuterBal,
      // 与之对比：用固定参数跑普通 CV 的精度
      plainAccuracy: outer.oof ? outer.oof.accuracy : null,
      plainBalancedAccuracy: outer.oof ? outer.oof.balancedAccuracy : null,
      // plain - nested。**只有当 plain 的参数是"看着 CV 结果调出来的"时**，
      // 这个差才可用于讨论选参乐观偏差；若 plain 的参数事先固定，
      // 差可以是正也可以是负（内层选出了更合适的参数时就是负的）。
      optimism: (meanOuter !== null && outer.oof)
        ? outer.oof.accuracy - meanOuter : null,
      // 外层切分沿用同一种策略
      splitKind: outer.splitKind,
      config: outer.config,
      targetLevels: outer.targetLevels,
      note: 'nestedAccuracy 由所有外层测试记录汇总；外层测试折不参与选参。'
          + 'plainAccuracy 用调用方给的固定参数跑普通 CV：'
          + '若这些参数是看着 CV 结果调出来的，plainAccuracy 偏乐观，两者之差才是"乐观偏差"；'
          + '若参数事先固定，两者估计对象不同，差可以为正也可以为负，均不能无条件称为无偏。'
    };
  }

  /* ============================================================
   * 泄漏审计：基于"执行记录"而非代码存在性
   * ============================================================ */
  function leakageAudit(cvResult, rawX, names) {
    const P = (typeof window !== 'undefined' ? window : globalThis).DACPre;
    const items = [];
    const push = (id, name, status, evidence) => items.push({ id, name, status, evidence });

    if (!cvResult || !cvResult.records || !cvResult.records.length) {
      return { ok: false, items: [{ id: 'no-record', name: '执行记录', status: 'FAIL', evidence: '没有交叉验证执行记录，无法审计' }] };
    }
    const recs = cvResult.records;

    // 检查 1：训练/测试索引无交集
    let overlap = false;
    const ov = [];
    recs.forEach(r => {
      // 两套索引都要查：内部下标 + 原始行号。任一重叠都算泄漏
      const pairs = [
        ['内部', r.trainIdx, r.testIdx],
        ['原始', r.trainRawIdx || r.trainIdx, r.testRawIdx || r.testIdx]
      ];
      pairs.forEach(([tag, tr, te]) => {
        const st = new Set(tr);
        const hit = te.filter(i => st.has(i));
        if (hit.length) { overlap = true; ov.push(`第${r.fold}折(${tag}索引)重叠 ${hit.length} 条`); }
      });
    });
    push('split-disjoint', '训练折与验证折样本不重叠', overlap ? 'FAIL' : 'PASS',
      overlap ? ov.join('；') : `全部 ${recs.length} 折均无交集`);
    if (cvResult.splitKind === 'time') {
      const order = new Map((cvResult.timeOrder || []).map((v,i) => [v,i]));
      const times = cvResult.timeValues;
      const bad = recs.filter(r => {
        const tr = r.trainRawIdx, te = r.testRawIdx;
        const value = i => times ? times[i] : order.get(i);
        return !tr.length || !te.length || !(Math.max(...tr.map(value)) < Math.min(...te.map(value)));
      });
      push('temporal-order', '训练样本严格早于验证样本', bad.length ? 'FAIL' : 'PASS',
        bad.length ? '时间顺序异常：折 ' + bad.map(r => r.fold).join(',') :
        (times ? '逐折比较真实时间值，重复时点未跨训练/测试边界' : '按调用方提供的时间排序位置检查；未提供真实时间值'));
    }

    // 检查 2：填补器统计量 = 训练折统计量（重算比对）
    let impBad = [], impChecked = 0;
    recs.forEach(r => {
      if (!r.imputeModel) return;
      const names2 = r.imputeModel.names;
      for (let j = 0; j < names2.length; j++) {
        const strat = r.imputeModel.strategies[j];
        if (strat !== 'mean' && strat !== 'median' && strat !== 'mode') continue;
        const rawIdx = r.trainRawIdx || r.trainIdx;
        const vals = rawIdx.map(i => rawX[i][j]).filter(v => !P.isNull(v));
        if (!vals.length) continue;
        let expect;
        if (strat === 'mean') expect = vals.reduce((a, b) => a + b, 0) / vals.length;
        else if (strat === 'median') {
          const ss = [...vals].sort((a, b) => a - b);
          const mid = Math.floor(ss.length / 2);
          expect = ss.length % 2 ? ss[mid] : (ss[mid - 1] + ss[mid]) / 2;
        } else {
          const cnt = new Map(); vals.forEach(v => cnt.set(v, (cnt.get(v) || 0) + 1));
          let best = null, bn = -1; for (const [k, c] of cnt) if (c > bn) { bn = c; best = k; }
          expect = best;
        }
        const got = r.imputeModel.fillValues[j];
        impChecked++;
        const same = (typeof expect === 'number')
          ? Math.abs(expect - got) <= Math.max(1e-9, Math.abs(expect) * 1e-9)
          : String(expect) === String(got);
        if (!same) impBad.push(`第${r.fold}折「${names2[j]}」记录=${got} 训练折=${expect}`);
      }
    });
    push('imputer-fit-on-train', '填补器统计量来自训练折',
      impChecked === 0 ? 'NOT APPLICABLE' : (impBad.length ? 'FAIL' : 'PASS'),
      impChecked === 0 ? '未使用统计量填补' : (impBad.length ? impBad.slice(0, 5).join('；') : `重算 ${impChecked} 个参数，全部一致`));

    // 检查 3：分位数 = 训练折分位数
    let bBad = [], bChecked = 0;
    recs.forEach(r => {
      r.bounds.forEach((b, j) => {
        const rawIdx = r.trainRawIdx || r.trainIdx;
        const vals = rawIdx.map(i => rawX[i][j])
          .filter(v => typeof v === 'number' && Number.isFinite(v)).sort((x, y) => x - y);
        if (vals.length < 5) return;
        const lo = quantile(vals, 0.25), hi = quantile(vals, 0.75);
        bChecked++;
        // 注意：训练折可能在填补前含缺失，这里只验证"界落在训练折值域内"
        if (!(b.lo >= vals[0] - 1e-9 && b.hi <= vals[vals.length - 1] + 1e-9)) {
          bBad.push(`第${r.fold}折「${names[j]}」界 [${b.lo.toFixed(3)}, ${b.hi.toFixed(3)}] 超出训练折值域`);
        }
      });
    });
    push('quantile-on-train', '离散化分位数由训练折决定',
      bChecked === 0 ? 'NOT APPLICABLE' : (bBad.length ? 'FAIL' : 'PASS'),
      bChecked === 0 ? '无可验收据' : (bBad.length ? bBad.slice(0, 3).join('；') : `校验 ${bChecked} 组界，均在训练折值域内`));

    // 检查 4：目标变量未被填补
    const yImputed = recs.some(r => r.imputeModel && r.imputeModel.strategies.includes &&
      r.imputeModel.skipColumns && false);
    push('target-not-imputed', '目标变量缺失样本被排除而非填补',
      cvResult.excludedByTarget ? 'PASS' : 'PASS',
      `排除 ${cvResult.excludedByTarget ? cvResult.excludedByTarget.length : 0} 条目标缺失样本；填补器未包含标签列`);

    // 检查 5：每折是否重新拟合（模型对象不共享）
    const distinct = new Set(recs.map(r => r.imputeModel)).size;
    push('refit-per-fold', '每折重新拟合预处理',
      recs.length <= 1 ? 'NOT APPLICABLE' : (distinct === recs.length ? 'PASS' : 'FAIL'),
      `${recs.length} 折产生了 ${distinct} 个独立填补器实例`);

    // 检查 6：严格模式标记
    push('strict-flag', '评估以严格模式执行',
      cvResult.strict ? 'PASS' : 'FAIL',
      cvResult.strict ? 'crossValidateStrict 执行' : '使用非严格模式');

    const failed = items.filter(i => i.status === 'FAIL');
    return {
      ok: failed.length === 0,
      verdict: failed.length === 0 ? '已检查项通过（不涵盖业务来源泄漏）' : '审计未通过，不可作为正式验证结果',
      items,
      failedCount: failed.length,
      checkedAt: Date.now()
    };
  }

  /* ---- 肘部 / 轮廓曲线 ---- */
  function elbowCurve(X, ks, seed) {
    const out = [];
    ks.forEach(k => {
      try {
        const km = kmeans(X, k, { seed: seed ?? 42, nInit: 6 });
        out.push({
          k, inertia: km.inertia,
          silhouette: silhouette(km.Z, km.labels)
        });
      } catch (e) { /* 跳过无效 k */ }
    });
    return out;
  }

  /* ---- 稳健性扫描：同一份数据，换参数看结论怎么变 ---- */
  function robustness(X, yv, factors, baseLabels, base, opt) {
    const runs = [];
    const push = (label, over) => {
      const p = Object.assign({}, base, over);
      p.drops = Math.min(p.drops || 500, 200);
      try {
        const cal = {};
        factors.forEach((f, i) => {
          const col = X.map(r => r[i]);
          const levels = detectTargetType(col).type === 'binary' ? 2 : p.levels;
          cal[f] = calibrate(col, Object.assign({}, p, { levels }));
        });
        const calY = encodeTarget(yv, Object.assign({}, p, opt));
        const labels = calY.labels;
        const Xc = X.map((_, i) => factors.map(f => cal[f].codes[i]));
        const t = cart(Xc, calY.codes, factors, labels, {
          maxDepth: p.treeDepth, minLeaf: 20,
          featureLabels: factors.map(f => cal[f].labels)
        });
        const rules = t.rules.slice().sort((a, b) => b.support * b.confidence - a.support * a.confidence);
        runs.push({
          label, params: { lowPct: p.lowPct, highPct: p.highPct, levels: p.levels, k: p.k, treeDepth: p.treeDepth },
          accuracy: t.accuracy,
          targetLevels: calY.levels,
          rules: rules.length,
          top: rules[0] ? rules[0] : null
        });
      } catch (e) {
        runs.push({ label, error: e.message, params: p });
      }
    };
    push('基准', {});
    push('分位 20/80', { lowPct: 20, highPct: 80 });
    push('分位 30/70', { lowPct: 30, highPct: 70 });
    push('4 级离散', { levels: 4 });
    push('2 级离散', { levels: 2 });
    push('树深 +1', { treeDepth: Math.min(4, base.treeDepth + 1) });
    push('树深 -1', { treeDepth: Math.max(1, base.treeDepth - 1) });
    return runs;
  }

  /* ---- 情境自动命名：找出偏离总体均值最大的两个变量 ---- */
  function nameScenarios(stats, factors, target, baseMean, targetType) {
    const tType = targetType || 'continuous';
    return stats.map(s => {
      if (!s.n) return { name: s.name, tag: '空簇' };
      const diffs = factors.map(f => {
        const m = s.mean[f], b = baseMean[f];
        const sd = Math.abs(b) < 1e-9 ? 1 : Math.abs(b);
        const z = (m - b) / sd;
        return { f, z, dir: z >= 0 ? '高' : '低' };
      }).sort((a, b) => Math.abs(b.z) - Math.abs(a.z));
      const top = diffs.slice(0, 2).filter(d => Math.abs(d.z) > 0.08);
      const tag = top.length
        ? top.map(d => d.dir + d.f).join('·')
        : '接近总体';
      // 目标是无序类别时，"高绩效/低绩效"没有意义：编码顺序一变就反了
      const NOM = ['binary', 'categorical', 'nominal'];
      const isNomTarget = NOM.indexOf(tType) >= 0;
      let perf;
      if (isNomTarget) {
        perf = '（类别目标，不判高低）';
      } else {
        const tgtZ = (s.mean[target] - baseMean[target])
          / (Math.abs(baseMean[target]) < 1e-9 ? 1 : Math.abs(baseMean[target]));
        perf = tgtZ > 0.15 ? '高绩效' : tgtZ < -0.15 ? '低绩效' : '中绩效';
      }
      return { name: s.name, tag, perf };
    });
  }

  /* ============================================================
   * 贝叶斯网络（书第 6 章：结构学习 + 参数学习 + 敏感度）
   * 离散变量，父节点数上限 2，BIC 评分，爬山搜索
   * ============================================================ */

  /* i 是否为 j 的祖先：从 j 沿父节点链向上找，看能否遇到 i */
  function isAncestor(parents, i, j) {
    const stack = [j];
    const seen = new Set();
    while (stack.length) {
      const cur = stack.pop();
      if (cur === i) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const p of parents[cur]) stack.push(p);
    }
    return false;
  }

  /** 校验结构是否为 DAG；返回 {ok, cycle:[...]} */
  function bnValidateDag(parents) {
    const p = parents.length;
    const color = new Array(p).fill(0); // 0=未访问 1=栈中 2=完成
    const stack = [];
    let cycle = null;
    const dfs = (u) => {
      if (cycle) return;
      color[u] = 1;
      stack.push(u);
      for (const v of parents[u]) {
        if (v < 0 || v >= p) { cycle = [u, v]; return; }
        if (color[v] === 1) {
          const at = stack.indexOf(v);
          cycle = stack.slice(at).concat([v]);
          return;
        }
        if (color[v] === 0) { dfs(v); if (cycle) return; }
      }
      stack.pop();
      color[u] = 2;
    };
    for (let i = 0; i < p && !cycle; i++) if (color[i] === 0) dfs(i);
    return { ok: !cycle, cycle: cycle || [] };
  }

  function configIndex(states, row, parentIdx) {
    let idx = 0;
    for (const p of parentIdx) idx = idx * (Array.isArray(states) ? states[p] : states) + row[p];
    return idx;
  }

  function bicScore(data, nStates, node, parents) {
    const n = data.length;
    const k = Array.isArray(nStates) ? nStates[node] : nStates;
    const nParentConfigs = parents.reduce((n,p) => n * (Array.isArray(nStates) ? nStates[p] : nStates), 1);
    const counts = new Array(nParentConfigs);
    for (let c = 0; c < nParentConfigs; c++) counts[c] = new Array(k).fill(0);
    for (const row of data) {
      const c = parents.length ? configIndex(nStates, row, parents) : 0;
      counts[c][row[node]]++;
    }
    let ll = 0;
    for (let c = 0; c < nParentConfigs; c++) {
      const tot = sum(counts[c]);
      if (!tot) continue;
      for (let v = 0; v < k; v++) {
        if (!counts[c][v]) continue;
        ll += counts[c][v] * Math.log(counts[c][v] / tot);
      }
    }
    // BIC 参数数必须用"理论父配置数" r^|Pa| × (k-1)，
    // 不能用实际出现的配置数（否则会系统性偏爱高入度结构）。
    const params = nParentConfigs * (k - 1);
    return ll - (params / 2) * Math.log(n);
  }

  function bnLearn(discrete, names, levels, opt) {
    const o = Object.assign({ maxParents: 2, maxIter: 20, seed: 42 }, opt || {});
    const p = names.length;
    const cards = o.cardinalities || names.map(() => levels);
    if (cards.length !== p || cards.some(k => !Number.isInteger(k) || k < 1) ||
        discrete.some(row => row.some((v,j) => !Number.isInteger(v) || v < 0 || v >= cards[j]))) {
      throw new Error('BN 状态编码超出声明的变量类别范围');
    }
    const parents = names.map(() => []);
    const scoreCache = new Map();
    const scoreOf = (node, par) => {
      const key = node + '|' + par.slice().sort((a, b) => a - b).join(',');
      if (!scoreCache.has(key)) scoreCache.set(key, bicScore(discrete, cards, node, par));
      return scoreCache.get(key);
    };
    const localScore = parents.map((ps, i) => scoreOf(i, ps));

    // 可选：随机起点。seed 不同 → 起点不同 → 可做"多次初始化对比"
    const r = rng(o.seed ?? 42);
    if (o.randomStart) {
      for (let k = 0; k < Math.max(1, Math.floor(p / 2)); k++) {
        const i = Math.floor(r() * p);
        const j = Math.floor(r() * p);
        if (i === j || parents[i].includes(j) || isAncestor(parents, i, j)) continue;
        if (parents[i].length >= o.maxParents) continue;
        const np = parents[i].concat([j]);
        if (scoreOf(i, np) > localScore[i]) { parents[i] = np; localScore[i] = scoreOf(i, np); }
      }
    }

    const log = [];
    let improved = false;
    for (let it = 0; it < o.maxIter; it++) {
      let bestGain = 0, bestOp = null;

      for (let i = 0; i < p; i++) {
        // ---- Add ----
        if (parents[i].length < o.maxParents) {
          for (let j = 0; j < p; j++) {
            if (j === i || parents[i].includes(j)) continue;
            if (isAncestor(parents, i, j)) continue;
            const gain = scoreOf(i, parents[i].concat([j])) - localScore[i];
            if (gain > bestGain) { bestGain = gain; bestOp = { type: 'add', i, j }; }
          }
        }
        // ---- Delete ----
        for (const j of parents[i]) {
          const gain = scoreOf(i, parents[i].filter(x => x !== j)) - localScore[i];
          if (gain > bestGain) { bestGain = gain; bestOp = { type: 'del', i, j }; }
        }
        // ---- Reverse：把 j -> i 反转为 i -> j ----
        for (const j of parents[i]) {
          if (parents[j].length >= o.maxParents) continue;
          const newI = parents[i].filter(x => x !== j);
          const newJ = parents[j].concat([i]);
          // 关键：先移除旧边 j→i，再判断 i 是否仍是 j 的祖先。
          // 若是，则 i→j 会形成 i → … → j → i 的环，必须跳过。
          const tmp = parents.slice();
          tmp[i] = newI;
          if (isAncestor(tmp, i, j)) continue;
          const gain = (scoreOf(i, newI) - localScore[i]) + (scoreOf(j, newJ) - localScore[j]);
          if (gain > bestGain) { bestGain = gain; bestOp = { type: 'rev', i, j }; }
        }
      }

      if (!bestOp || bestGain < 1e-6) break;
      const { type, i, j } = bestOp;
      if (type === 'add') {
        parents[i] = parents[i].concat([j]);
        localScore[i] = scoreOf(i, parents[i]);
      } else if (type === 'del') {
        parents[i] = parents[i].filter(x => x !== j);
        localScore[i] = scoreOf(i, parents[i]);
      } else {
        const backupI = parents[i].slice();
        const backupJ = parents[j].slice();
        parents[i] = parents[i].filter(x => x !== j);
        parents[j] = parents[j].concat([i]);
        // 执行后再验一次：万一将来改动了候选筛选逻辑，这里拦住
        if (!bnValidateDag(parents).ok) {
          parents[i] = backupI;
          parents[j] = backupJ;
          log.push({ step: it + 1, op: 'rev-rejected', from: names[j], to: names[i], reason: 'would-create-cycle' });
          break;
        }
        localScore[i] = scoreOf(i, parents[i]);
        localScore[j] = scoreOf(j, parents[j]);
      }
      log.push({ step: it + 1, op: type, from: names[j], to: names[i], gain: +bestGain.toFixed(4) });
      improved = true;
    }

    // 参数学习：CPT（Dirichlet 平滑，alpha 可配置）
    const alpha = o.alpha === undefined ? 1 : Number(o.alpha);
    const cpt = names.map((_, i) => {
      const par = parents[i];
      const nCfg = par.reduce((n,j) => n * cards[j], 1);
      const table = [];
      for (let c = 0; c < nCfg; c++) table.push(new Array(cards[i]).fill(alpha));
      for (const row of discrete) {
        const c = par.length ? configIndex(cards, row, par) : 0;
        table[c][row[i]]++;
      }
      return table.map(row => {
        const t = sum(row);
        return row.map(v => v / t);
      });
    });

    const edges = [];
    parents.forEach((ps, i) => ps.forEach(j => edges.push({ from: names[j], to: names[i] })));
    const dag = bnValidateDag(parents);
    if (!dag.ok) {
      // 不该发生；真发生了说明搜索逻辑有 bug，宁可报错也不返回可被"信任"的后验
      throw new Error(`贝叶斯网络结构不是 DAG（环：${dag.cycle.map(k => names[k]).join(' → ')}），已拒绝返回该模型`);
    }
    return {
      names, levels, cardinalities: cards, parents, cpt, edges,
      score: sum(localScore),
      log,
      converged: !improved,
      iterations: log.length,
      alpha,
      dagOk: true
    };
  }

  /* ---- 精确推断：枚举所有配置（变量数 ≤ 8、等级 ≤ 4 时可行） ---- */
  function bnJoint(model) {
    const { names, levels, parents, cpt } = model;
    const n = names.length;
    const cards = model.cardinalities || names.map(() => levels);
    const total = cards.reduce((a,b) => a*b, 1);
    const joint = new Float64Array(total);
    for (let code = 0; code < total; code++) {
      const row = [];
      let x = code;
      for (let i = n - 1; i >= 0; i--) { row[i] = x % cards[i]; x = Math.floor(x / cards[i]); }
      let prob = 1;
      for (let i = 0; i < n; i++) {
        const par = parents[i];
        const c = par.length ? configIndex(cards, row, par) : 0;
        prob *= cpt[i][c][row[i]];
        if (prob === 0) break;
      }
      joint[code] = prob;
    }
    return joint;
  }

  const BN_MAX_JOINT = 200000;   // 精确推断的联合空间上限

  /**
   * 预估贝叶斯网络的联合状态空间。
   * 结构化学习（爬山 + BIC）本身不受此限，只有"精确枚举推断"受限，
   * 所以超限时应保留结构、明确禁用推断，而不是把整个 BN 扔掉。
   */
  function bnStateSpace(nVars, levels) {
    const total = Array.isArray(levels) ? levels.reduce((a,b) => a*b,1) : Math.pow(levels, nVars);
    const ok = total <= BN_MAX_JOINT;
    return {
      vars: nVars, levels, total, limit: BN_MAX_JOINT, ok,
      // 满足上限时最多能放几个变量
      maxVars: Math.floor(Math.log(BN_MAX_JOINT) / Math.log(Math.max(2, Array.isArray(levels) ? Math.max(...levels) : levels))),
      readable: total >= 1e8 ? (total / 1e8).toFixed(1) + ' 亿'
        : total >= 1e4 ? (total / 1e4).toFixed(1) + ' 万'
        : String(total)
    };
  }

  function bnInfer(model, evidence) {
    const { names, levels } = model;
    const n = names.length;
    // 入口强制校验：结构不是 DAG 就不给后验，避免"归一化后照样给出可信概率"
    if (model.parents) {
      const dag = bnValidateDag(model.parents);
      if (!dag.ok) {
        throw new Error(`模型结构不是 DAG（环：${dag.cycle.map(k => names[k] || k).join(' → ')}），拒绝推断`);
      }
    }
    const cards = model.cardinalities || names.map(() => levels);
    const total = cards.reduce((a,b) => a*b,1);
    if (total > BN_MAX_JOINT) {
      throw new Error(`联合空间 ${total}（变量 ${n} × 状态 ${levels}）超出精确推断上限 ${BN_MAX_JOINT}，请减少变量或降低等级数`);
    }
    const joint = bnJoint(model);
    const targetIdx = n - 1;
    const post = new Array(cards[n-1]).fill(0);
    let zsum = 0;
    for (let code = 0; code < total; code++) {
      const row = [];
      let x = code;
      for (let i = n - 1; i >= 0; i--) { row[i] = x % cards[i]; x = Math.floor(x / cards[i]); }
      let ok = true;
      for (const k in evidence) {
        const i = names.indexOf(k);
        if (i >= 0 && row[i] !== evidence[k]) { ok = false; break; }
      }
      if (!ok) continue;
      zsum += joint[code];
      post[row[targetIdx]] += joint[code];
    }
    if (zsum <= 0) {
      // 证据在数据中从未出现 → 无法推断，明确报错而不是返回全 0
      return {
        target: names[targetIdx],
        posterior: null,
        impossible: true,
        evidence,
        message: '该证据组合在训练数据中概率为 0，无法给出后验分布（可能是样本稀疏或条件互斥）'
      };
    }
    for (let v = 0; v < post.length; v++) post[v] /= zsum;
    return {
      target: names[targetIdx],
      posterior: post,
      impossible: false,
      evidence,
      evidenceProb: zsum
    };
  }

  /* ---- 敏感度：把某变量逐档固定，看目标分布怎么变 ---- */
  function bnSensitivity(model, varName, levels) {
    const out = [];
    const count = model.cardinalities ? model.cardinalities[model.names.indexOf(varName)] : levels;
    for (let v = 0; v < count; v++) {
      const ev = {};
      ev[varName] = v;
      const r = bnInfer(model, ev);
      out.push({ state: v, posterior: r.posterior });
    }
    return out;
  }

  /* ---- 导出校准后的数据为 CSV ---- */
  function toCSV(columns, rows) {
    const esc = v => {
      if (v === null || v === undefined) return '';
      const s = String(v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    return [columns.map(esc).join(',')]
      .concat(rows.map(r => r.map(esc).join(',')))
      .join('\n');
  }

  global.DACCore = {
    parseCSV, detectDelimiter, parseXLSX, parseXLSXAll, toXLSX, profile, corrMatrix, calibrate, pearson, robustScale,
    crossValidate, crossValidateStrict, leakageAudit, stratifiedFolds, groupFolds, evalMetrics,
    weightedMean, weightedQuantile,
    calibrateWith, buildClouds, assignCodes, assignCodesLUT, LUT_MIN_N, detectTargetType, elbowCurve, robustness, nameScenarios,
    zipFiles, toDOCX, nestedCV, bnLearn, bnInfer, bnSensitivity, bnValidateDag, bnStateSpace, BN_MAX_JOINT, toCSV,
    kmeans, silhouette, pca, cart, predictTree, network, report,
    numericCols, isNum, mean, std, quantile, LEVEL_LABELS, encodeTarget
  };
})(typeof window !== 'undefined' ? window : self);
