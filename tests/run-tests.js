const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const root = path.resolve(__dirname, '..');
const suites = fs.readdirSync(__dirname).filter(n => /^test_.*\.js$/.test(n)).sort();
let failed = 0;
for (const suite of suites) {
  const result = spawnSync(process.execPath, [path.join(__dirname,suite)], {
    cwd:root, encoding:'utf8', timeout:120000, maxBuffer:2*1024*1024
  });
  const ok = result.status === 0;
  console.log(`${ok?'PASS':'FAIL'} ${suite}`);
  if(!ok) {
    console.log((result.stdout||'')+(result.stderr||'')+(result.error?.message||''));
    failed++;
  }
}
console.log(`${suites.length-failed}/${suites.length} suites passed`);
if(failed) process.exitCode=1;
