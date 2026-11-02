/* 用 node 复算红酒数据的分析结果，产出一份 brief（与网页 compute() 同逻辑） */
const fs = require('fs');
global.window = {};
global.DecompressionStream = undefined;

const ROOT = 'D:/reverse/dac-reverse-research';
eval(fs.readFileSync(ROOT + '/workbench/core.js', 'utf8'));
eval(fs.readFileSync(ROOT + '/data/samples.js', 'utf8'));

const C = global.window.DACCore;
const DS = global.window.__DATASETS__;
const key = process.argv[2] || 'wine';
const ds = DS[key];
const columns = ds.columns;
const rows = ds.rows;
const target = columns[columns.length - 1];
const factors = columns.slice(0, -1);
const idxT = columns.indexOf(target);
const idxF = factors.map(f => columns.indexOf(f));
const keep = rows.filter(r => C.isNum(r[idxT]) && idxF.every(j => C.isNum(r[j])));
const X = keep.map(r => idxF.map(j => r[j]));
const yv = keep.map(r => r[idxT]);

const params = { lowPct: 25, highPct: 75, drops: 500, levels: 3, k: 3, treeDepth: 3, netThreshold: 0.2, seed: 42 };
const cal = {};
factors.forEach((f, i) => { cal[f] = C.calibrate(X.map(r => r[i]), params); });
const calY = C.calibrate(yv, params);
const labels = C.LEVEL_LABELS[params.levels];

const km = C.kmeans(X, params.k, { seed: params.seed });
const sil = C.silhouette(km.Z, km.labels);
const stats = [];
for (let c = 0; c < params.k; c++) {
  const mem = [];
  km.labels.forEach((l, i) => { if (l === c) mem.push(i); });
  const mean = {};
  factors.forEach((f, j) => { mean[f] = mem.reduce((s, i) => s + X[i][j], 0) / (mem.length || 1); });
  mean[target] = mem.reduce((s, i) => s + yv[i], 0) / (mem.length || 1);
  stats.push({ name: 'S' + (c + 1), n: mem.length, mean });
}
const baseMean = {};
factors.forEach((f, k) => baseMean[f] = C.mean(X.map(r => r[k])));
baseMean[target] = C.mean(yv);
const names = C.nameScenarios(stats, factors, target, baseMean);

const Xc = keep.map((_, i) => factors.map(f => cal[f].codes[i]));
const yc = calY.codes.slice();
const minLeaf = Math.max(10, Math.round(keep.length / 40));
const tree = C.cart(Xc, yc, factors, labels, { maxDepth: params.treeDepth, minLeaf });
const cv = C.crossValidate(Xc, yc, factors, labels, { maxDepth: params.treeDepth, minLeaf }, 5);

const discrete = keep.map((_, i) => factors.map(f => cal[f].codes[i]).concat([calY.codes[i]]));
const bn = C.bnLearn(discrete, factors.concat([target]), params.levels);
const sens = factors.map(f => {
  const rowsS = C.bnSensitivity(bn, f, params.levels);
  return { f, rows: rowsS };
});

const brief = {
  dataset: ds.name,
  target, factors,
  rows: rows.length, used: keep.length,
  columns: C.profile(columns, rows).columns.map(c => ({ name: c.name, missing: c.missing, outliers: c.outliers || 0 })),
  params,
  silhouette: sil,
  cv: { mean: cv.mean, std: cv.std },
  accuracy: tree.accuracy,
  importances: tree.importances.slice(0, 6).map(x => ({ name: x.name, value: +x.value.toFixed(3) })),
  rules: tree.rules.slice().sort((a, b) => b.support * b.confidence - a.support * a.confidence).slice(0, 5)
    .map(x => ({ if: x.conditions, then: x.then, n: x.support, conf: +x.confidence.toFixed(3) })),
  scenarios: stats.map((s, i) => ({ name: s.name, tag: names[i].tag, n: s.n, y: +s.mean[target].toFixed(3) })),
  sens: sens.map(({ f, rows }) => ({ var: f, probs: rows.map(x => +(x.posterior[x.posterior.length - 1] * 100).toFixed(1)) })),
  labels
};
fs.writeFileSync(ROOT + '/workbench/_brief.json', JSON.stringify(brief, null, 1), 'utf8');
console.log('brief written:', key, '| silhouette', sil.toFixed(3), '| acc', tree.accuracy.toFixed(3), '| rules', tree.rules.length);
