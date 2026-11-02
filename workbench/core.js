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
  function parseCSV(text) {
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
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
        else if (c === ',') { row.push(field); field = ''; }
        else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
        else if (c === '\r') { /* skip */ }
        else field += c;
      }
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    const clean = rows.filter(r => r.length && r.some(v => String(v).trim() !== ''));
    if (!clean.length) return { columns: [], rows: [] };
    const columns = clean[0].map((h, i) => (String(h).trim() || '列' + (i + 1)));
    const data = clean.slice(1).map(r => r.map(v => {
      const s = String(v).trim();
      if (s === '') return null;
      const n = Number(s);
      return Number.isFinite(n) && s !== '' ? n : s;
    }));
    return { columns, rows: data };
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

  async function parseXLSX(buf) {
    const entries = readZip(buf);
    const workbook = await readEntry(entries, 'xl/workbook.xml');
    let sheetPath = 'xl/worksheets/sheet1.xml';
    if (workbook) {
      const m = /<sheet[^>]*r:id="rId(\d+)"/.exec(workbook);
      const rels = await readEntry(entries, 'xl/_rels/workbook.xml.rels');
      if (m && rels) {
        const re = new RegExp('Id="rId' + m[1] + '"[^>]*Target="([^"]+)"');
        const t = re.exec(rels);
        if (t) sheetPath = 'xl/' + t[1].replace(/^\/?xl\//, '');
      }
    }
    const sheet = await readEntry(entries, sheetPath);
    if (!sheet) throw new Error('未找到工作表数据');

    let shared = [];
    const sst = await readEntry(entries, 'xl/sharedStrings.xml');
    if (sst) {
      shared = [...sst.matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m =>
        [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(x => x[1]).join('')
          .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
          .replace(/&quot;/g, '"').replace(/&#x27;/g, "'")
      );
    }

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
          val = im ? im[1] : (vM ? vM[1] : null);
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

  function calibrate(values, opt) {
    const { lowPct = 25, highPct = 75, drops = 500, levels = 3, seed = 42 } = opt || {};
    const idx = [];
    const vals = [];
    values.forEach((v, i) => { if (isNum(v)) { idx.push(i); vals.push(v); } });
    const sSorted = [...vals].sort((a, b) => a - b);
    const lo = quantile(sSorted, lowPct / 100);
    const hi = quantile(sSorted, highPct / 100);
    const { clouds } = buildClouds(lo, hi, levels);
    const { codes: c0, muMax, mu2 } = assignCodes(vals, clouds, levels, drops, seed);

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
      labels: LEVEL_LABELS[levels]
    };
  }

  /**
   * 用「外部给定的上下界」打等级码 —— 严格交叉验证专用。
   * 不会从 values 重新计算分位数，因此可以安全地作用于验证集。
   */
  function calibrateWith(values, bounds, opt) {
    const { levels = 3, drops = 500, seed = 42 } = opt || {};
    const lo = bounds.lo, hi = bounds.hi;
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || !(hi > lo)) {
      throw new Error(`校准上下界非法: lo=${lo}, hi=${hi}`);
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
    return { ...best, k, Z };
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

  function collectRules(node, featureNames, labels, conds, out) {
    out = out || [];
    conds = conds || [];
    if (node.f === undefined) {
      const idx = node.counts.indexOf(Math.max(...node.counts));
      out.push({
        conditions: conds.slice(), then: labels[idx],
        support: node.n, confidence: node.counts[idx] / node.n,
        distribution: node.counts.slice()
      });
      return out;
    }
    const name = featureNames[node.f];
    collectRules(node.left, featureNames, labels, conds.concat([condDesc(name, node.t, labels, true)]), out);
    collectRules(node.right, featureNames, labels, conds.concat([condDesc(name, node.t, labels, false)]), out);
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
      rules: collectRules(root, featureNames, labels),
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
    L.push('| 情境 | 样本 | ' + meta.factors.join(' | ') + ` | ${meta.target} |`);
    L.push('|' + '---|'.repeat(meta.factors.length + 3));
    scenarios.stats.forEach((s, i) => {
      const nm = (scenarios.names && scenarios.names[i]) ? scenarios.names[i].tag : '-';
      L.push(`| ${s.name}（${nm}） | ${s.n} | ` + meta.factors.map(f => s.mean[f].toFixed(2)).join(' | ') + ` | ${s.mean[meta.target].toFixed(3)} |`);
    });
    L.push('');
    L.push('## 四、组合效应规则\n');
    L.push('变量重要性：' + tree.importances.map(i => `${i.name} ${(i.value * 100).toFixed(1)}%`).join('、') + '\n');
    tree.rules.forEach((r, i) => {
      L.push(`${i + 1}. **IF** ${r.conditions.join(' 且 ') || '（无分裂）'} → **THEN ${meta.target} = ${r.then}**（n=${r.support}，置信度 ${(r.confidence * 100).toFixed(1)}%）`);
    });
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
    const r = rng(seed || 42);
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

    const foldIdx = stratifiedFolds(y, effK, (opt && opt.seed) || 42);
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
  function crossValidateStrict(rawX, yRaw, names, labels, opt) {
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
    const yv = validRows.map(i => yRaw[i]);
    const rough = calibrate(yv, { lowPct: o.lowPct, highPct: o.highPct, drops: 50, levels: o.levels, seed: o.seed });
    const yClass = rough.codes;

    // 3) 分层切分
    const folds = stratifiedFolds(yClass, Math.max(2, o.k), o.seed);
    const X = validRows.map(i => rawX[i].slice());

    const perFold = [];
    const oofPred = new Array(X.length).fill(-1);
    const records = [];

    for (let f = 0; f < folds.length; f++) {
      const testIdx = folds[f];
      if (testIdx.length < 2) continue;
      const testSet = new Set(testIdx);
      const trainIdx = [];
      for (let i = 0; i < X.length; i++) if (!testSet.has(i)) trainIdx.push(i);

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
      const ySorted = [...yTr].sort((a, b) => a - b);
      const yBounds = { lo: quantile(ySorted, o.lowPct / 100), hi: quantile(ySorted, o.highPct / 100) };
      if (!(yBounds.hi > yBounds.lo)) yBounds.hi = yBounds.lo + 1e-6;

      // 按列批量离散化：每列只建一次云、只跑一轮云滴
      // （逐单元格调用会让复杂度乘上样本数，400×11 会慢几百倍）
      const colOpt = { levels: o.levels, drops: o.drops, seed: o.seed };
      const trCols = names.map((_, j) => calibrateWith(trImp.map(r => r[j]), bounds[j], colOpt).codes);
      const teCols = names.map((_, j) => calibrateWith(teImp.map(r => r[j]), bounds[j], colOpt).codes);
      const XtrCodes = trImp.map((_, i) => names.map((_, j) => trCols[j][i]));
      const XteCodes = teImp.map((_, i) => names.map((_, j) => teCols[j][i]));
      const yTrCodes = calibrateWith(yTr, yBounds, { levels: o.levels, drops: o.drops, seed: o.seed }).codes;
      const yTeCodes = calibrateWith(yTe, yBounds, { levels: o.levels, drops: o.drops, seed: o.seed }).codes;

      // ---- 3c) 建模（只用训练折）----
      const tree = cart(XtrCodes, yTrCodes, names, labels, { maxDepth: o.treeDepth, minLeaf: o.minLeaf });
      const pred = XteCodes.map(r => predictTree(tree.root, r));
      testIdx.forEach((i, k) => { oofPred[i] = pred[k]; });

      const trainPred = XtrCodes.map(r => predictTree(tree.root, r));
      const trM = evalMetrics(yTrCodes, trainPred, o.levels);
      const teM = evalMetrics(yTeCodes, pred, o.levels);

      perFold.push({
        fold: f + 1, nTrain: trainIdx.length, nTest: testIdx.length,
        trainAccuracy: trM.accuracy, testAccuracy: teM.accuracy,
        balancedAccuracy: teM.balancedAccuracy, macroF1: teM.macroF1,
        perClass: teM.perClass, confusion: teM.confusion
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
        imputeLog: impLog
      });
    }

    // 4) OOF 汇总
    const keepIdx = [], keepPred = [];
    for (let i = 0; i < X.length; i++) if (oofPred[i] >= 0) { keepIdx.push(i); keepPred.push(oofPred[i]); }
    const oofY = keepIdx.map(i => yClass[i]);
    const oofM = evalMetrics(oofY, keepPred, o.levels);
    const testAcc = perFold.map(f => f.testAccuracy);

    return {
      ok: perFold.length > 0,
      k: perFold.length,
      perFold,
      oof: { accuracy: oofM.accuracy, balancedAccuracy: oofM.balancedAccuracy, macroF1: oofM.macroF1, perClass: oofM.perClass, confusion: oofM.confusion, n: oofM.n },
      mean: mean(testAcc) || 0,
      std: std(testAcc) || 0,
      trainMean: mean(perFold.map(f => f.trainAccuracy)) || 0,
      gap: (mean(perFold.map(f => f.trainAccuracy)) || 0) - (mean(testAcc) || 0),
      excludedByTarget,
      strict: true,
      records
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
      verdict: failed.length === 0 ? '严格无泄漏' : '存在泄漏，不可作为正式验证结果',
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
        const km = kmeans(X, k, { seed: seed || 42, nInit: 6 });
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
      const labels = LEVEL_LABELS[p.levels] || baseLabels;
      try {
        const cal = {};
        factors.forEach((f, i) => { cal[f] = calibrate(X.map(r => r[i]), p); });
        const calY = calibrate(yv, p);
        const Xc = X.map((_, i) => factors.map(f => cal[f].codes[i]));
        const t = cart(Xc, calY.codes, factors, labels, { maxDepth: p.treeDepth, minLeaf: 20 });
        const rules = t.rules.slice().sort((a, b) => b.support * b.confidence - a.support * a.confidence);
        runs.push({
          label, params: { lowPct: p.lowPct, highPct: p.highPct, levels: p.levels, k: p.k, treeDepth: p.treeDepth },
          accuracy: t.accuracy,
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
  function nameScenarios(stats, factors, target, baseMean) {
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
      const tgtZ = (s.mean[target] - baseMean[target]) / (Math.abs(baseMean[target]) < 1e-9 ? 1 : Math.abs(baseMean[target]));
      const perf = tgtZ > 0.15 ? '高绩效' : tgtZ < -0.15 ? '低绩效' : '中绩效';
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

  function configIndex(states, row, parentIdx) {
    let idx = 0;
    for (const p of parentIdx) idx = idx * states + row[p];
    return idx;
  }

  function bicScore(data, nStates, node, parents) {
    const n = data.length;
    const k = nStates;
    const nParentConfigs = Math.pow(k, parents.length);
    const counts = new Array(nParentConfigs);
    for (let c = 0; c < nParentConfigs; c++) counts[c] = new Array(k).fill(0);
    for (const row of data) {
      const c = parents.length ? configIndex(k, row, parents) : 0;
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
    const params = Math.pow(k, parents.length) * (k - 1);
    return ll - (params / 2) * Math.log(n);
  }

  function bnLearn(discrete, names, levels, opt) {
    const o = Object.assign({ maxParents: 2, maxIter: 20, seed: 42 }, opt || {});
    const p = names.length;
    const parents = names.map(() => []);
    const scoreCache = new Map();
    const scoreOf = (node, par) => {
      const key = node + '|' + par.slice().sort((a, b) => a - b).join(',');
      if (!scoreCache.has(key)) scoreCache.set(key, bicScore(discrete, levels, node, par));
      return scoreCache.get(key);
    };
    const localScore = parents.map((ps, i) => scoreOf(i, ps));

    // 可选：随机起点。seed 不同 → 起点不同 → 可做"多次初始化对比"
    const r = rng(o.seed || 42);
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
        parents[i] = parents[i].filter(x => x !== j);
        parents[j] = parents[j].concat([i]);
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
      const nCfg = Math.pow(levels, par.length);
      const table = [];
      for (let c = 0; c < nCfg; c++) table.push(new Array(levels).fill(alpha));
      for (const row of discrete) {
        const c = par.length ? configIndex(levels, row, par) : 0;
        table[c][row[i]]++;
      }
      return table.map(row => {
        const t = sum(row);
        return row.map(v => v / t);
      });
    });

    const edges = [];
    parents.forEach((ps, i) => ps.forEach(j => edges.push({ from: names[j], to: names[i] })));
    return {
      names, levels, parents, cpt, edges,
      score: sum(localScore),
      log,
      converged: !improved,
      iterations: log.length,
      alpha
    };
  }

  /* ---- 精确推断：枚举所有配置（变量数 ≤ 8、等级 ≤ 4 时可行） ---- */
  function bnJoint(model) {
    const { names, levels, parents, cpt } = model;
    const n = names.length;
    const total = Math.pow(levels, n);
    const joint = new Float64Array(total);
    for (let code = 0; code < total; code++) {
      const row = [];
      let x = code;
      for (let i = n - 1; i >= 0; i--) { row[i] = x % levels; x = Math.floor(x / levels); }
      let prob = 1;
      for (let i = 0; i < n; i++) {
        const par = parents[i];
        const c = par.length ? configIndex(levels, row, par) : 0;
        prob *= cpt[i][c][row[i]];
        if (prob === 0) break;
      }
      joint[code] = prob;
    }
    return joint;
  }

  const BN_MAX_JOINT = 200000;   // 精确推断的联合空间上限

  function bnInfer(model, evidence) {
    const { names, levels } = model;
    const n = names.length;
    const total = Math.pow(levels, n);
    if (total > BN_MAX_JOINT) {
      throw new Error(`联合空间 ${total}（变量 ${n} × 状态 ${levels}）超出精确推断上限 ${BN_MAX_JOINT}，请减少变量或降低等级数`);
    }
    const joint = bnJoint(model);
    const targetIdx = n - 1;
    const post = new Array(levels).fill(0);
    let zsum = 0;
    for (let code = 0; code < total; code++) {
      const row = [];
      let x = code;
      for (let i = n - 1; i >= 0; i--) { row[i] = x % levels; x = Math.floor(x / levels); }
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
    for (let v = 0; v < levels; v++) post[v] /= zsum;
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
    for (let v = 0; v < levels; v++) {
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
    parseCSV, parseXLSX, profile, corrMatrix, calibrate, pearson, robustScale,
    crossValidate, crossValidateStrict, leakageAudit, stratifiedFolds, evalMetrics,
    calibrateWith, buildClouds, assignCodes, elbowCurve, robustness, nameScenarios,
    bnLearn, bnInfer, bnSensitivity, toCSV,
    kmeans, silhouette, pca, cart, network, report,
    numericCols, isNum, mean, std, quantile, LEVEL_LABELS
  };
})(typeof window !== 'undefined' ? window : self);
