/* CSV 解析契约测试
 * 覆盖用户第 7 点要求：
 *   逗号 / 分号 / TSV / 竖线；引号内分隔符与换行；BOM；空行；行宽不齐；稳定 rowId
 */
const fs = require('fs');
const path = require('path');
global.window = {};
eval(fs.readFileSync(path.join(__dirname, '..', 'workbench', 'core.js'), 'utf8'));
const C = global.window.DACCore;

let pass = 0, fail = 0;
const ok = (name, cond, info) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  → ' + (info === undefined ? '' : info)}`);
  cond ? pass++ : fail++;
};
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want), `得到 ${JSON.stringify(got)} 期望 ${JSON.stringify(want)}`);

console.log('=== 1. 分隔符自动检测 ===');
eq('逗号', C.parseCSV('a,b,c\n1,2,3\n4,5,6').meta.delimiter, ',');
eq('分号', C.parseCSV('a;b;c\n1;2;3\n4;5;6').meta.delimiter, ';');
eq('TSV', C.parseCSV('a\tb\tc\n1\t2\t3\n4\t5\t6').meta.delimiter, '\t');
eq('竖线', C.parseCSV('a|b|c\n1|2|3\n4|5|6').meta.delimiter, '|');
{
  const r = C.parseCSV('a;b;c\n1;2;3\n4;5;6');
  eq('分号 → 3 列', r.columns.length, 3);
  eq('分号 → 首行数值化', r.rows[0], [1, 2, 3]);
}
{
  const r = C.parseCSV('a\tb\n1\t2');
  eq('TSV → 2 列', r.columns.length, 2);
}

console.log('\n=== 2. 引号处理 ===');
{
  const r = C.parseCSV('a,b\n"x,y",2\n3,4');
  eq('引号内逗号不当分隔', r.rows[0], ['x,y', 2]);
  eq('列数仍为 2', r.columns.length, 2);
}
{
  const r = C.parseCSV('a,b\n"line1\nline2",2');
  eq('引号内换行不切行', r.rows.length, 1);
  ok('内容保留换行', String(r.rows[0][0]).indexOf('\n') > 0, JSON.stringify(r.rows[0][0]));
}
{
  const r = C.parseCSV('a\n"he said ""hi"""');
  eq('转义双引号', r.rows[0][0], 'he said "hi"');
}

console.log('\n=== 3. BOM 与空行 ===');
{
  const r = C.parseCSV('\uFEFFa;b\n1;2');
  eq('BOM 不污染首列名', r.columns[0], 'a');
  eq('BOM + 分号仍识别', r.meta.delimiter, ';');
}
{
  const r = C.parseCSV('a,b\n\n1,2\n\n3,4\n');
  eq('空行不计入数据', r.rows.length, 2);
  eq('skippedBlank 计数', r.meta.skippedBlank, 2);
}

console.log('\n=== 4. 稳定 rowId ===');
{
  const r = C.parseCSV('a,b\n1,2\n3,4\n5,6');
  eq('rowId 从 1 连续', r.meta.rowIds, [1, 2, 3]);
  eq('rowId 数 = 数据行数', r.meta.rowIds.length, r.rows.length);
}
{
  // 跳过的空行不应占号
  const r = C.parseCSV('a,b\n1,2\n\n3,4');
  eq('空行跳过后 rowId 仍连续', r.meta.rowIds, [1, 2]);
}
{
  // 同一个文件解析两次，rowId 必须一致（可复现）
  const t = 'x,y\n10,20\n30,40';
  eq('两次解析 rowId 一致', C.parseCSV(t).meta.rowIds, C.parseCSV(t).meta.rowIds);
}

console.log('\n=== 5. 行宽不齐 ===');
{
  const r = C.parseCSV('a,b,c\n1,2\n3,4,5,6');
  eq('列数以表头为准', r.columns.length, 3);
  eq('缺列补 null/空', r.rows[0], [1, 2, null]);
  eq('多列被截断', r.rows[1], [3, 4, 5]);
  eq('widthMismatch 计数', r.meta.widthMismatch, 2);
}

console.log('\n=== 6. 手动指定分隔符 ===');
{
  // 数据里同时有逗号和分号，强制用分号
  const r = C.parseCSV('a;b\n1,5;2', { delimiter: ';' });
  eq('强制分号', r.meta.delimiter, ';');
  eq('逗号保留在单元格里', r.rows[0][0], '1,5');
}

console.log('\n=== 7. 数值/字符串判定 ===');
{
  const r = C.parseCSV('a,b,c\n1,abc,\n 2 ,,x');
  eq('整数转数值', r.rows[0][0], 1);
  eq('文本保留', r.rows[0][1], 'abc');
  eq('空单元格为 null', r.rows[0][2], null);
  eq('带空格数字仍转数值', r.rows[1][0], 2);
}

console.log('\n=== 8. 空文件与纯表头 ===');
{
  const r = C.parseCSV('');
  eq('空文本 → 0 列', r.columns.length, 0);
  const r2 = C.parseCSV('a,b,c');
  eq('只有表头 → 0 数据行', r2.rows.length, 0);
  eq('表头仍解析', r2.columns, ['a', 'b', 'c']);
}

console.log(`\n总计 ${pass + fail} 项，通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
