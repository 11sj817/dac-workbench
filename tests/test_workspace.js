// DOM integration tests exercise the actual UI handlers, not a duplicated pipeline.
// jsdom does not validate browser layout, Web Workers, or a real AI provider.
const {JSDOM,VirtualConsole}=require('jsdom');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const errors=[];
const virtualConsole=new VirtualConsole();
virtualConsole.on('jsdomError',e=>errors.push(e.message));
const source=process.env.DAC_SITE_HTML
 ?fs.readFileSync(process.env.DAC_SITE_HTML,'utf8')
 :fs.readFileSync(path.join(root,'workbench/index.html'),'utf8');
const dom=new JSDOM(source,{url:'https://11sj817.github.io/dac-workbench/',runScripts:'outside-only',pretendToBeVisual:true,virtualConsole});
const w=dom.window,d=w.document;
w.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});
w.scrollTo=()=>{};
w.TextEncoder=TextEncoder;w.TextDecoder=TextDecoder;
w.CompressionStream=CompressionStream;w.DecompressionStream=DecompressionStream;w.Response=Response;
// jsdom's FileReader works for downloads; native Blob streams power ZIP compression.
w.Blob.prototype.stream=function(){
 const blob=this;
 return new ReadableStream({async start(controller){controller.enqueue(await bytes(blob));controller.close();}});
};
w.console.error=(...a)=>errors.push(a.map(e=>e.stack||String(e)).join(' '));
const blobs=new Map(),downloads=[];
w.URL.createObjectURL=blob=>{const url='blob:test-'+blobs.size;blobs.set(url,blob);return url;};
w.URL.revokeObjectURL=()=>{};
w.HTMLAnchorElement.prototype.click=function(){downloads.push({name:this.download,blob:blobs.get(this.href)});};
if(process.env.DAC_SITE_HTML){
 for(const script of [...d.querySelectorAll('script')])w.eval(script.textContent);
}else{
 for(const file of ['data/samples.js','workbench/preprocess.js','workbench/core.js','workbench/bootstrap.js','workbench/glm.js','workbench/ui.js'])
  w.eval(fs.readFileSync(path.join(root,file),'utf8'));
}
const $=s=>d.querySelector(s);
const event=(node,type='change')=>node.dispatchEvent(new w.Event(type,{bubbles:true}));
const button=(text,scope='#pane')=>[...d.querySelectorAll(scope+' button')].find(b=>b.textContent.includes(text));
const tab=name=>$(`#tabs button[data-tab="${name}"]`).click();
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const bytes=blob=>new Promise((resolve,reject)=>{
 const reader=new w.FileReader();reader.onerror=reject;
 reader.onload=()=>resolve(Buffer.from(reader.result));reader.readAsArrayBuffer(blob);
});
async function until(f,ms=15000){let start=Date.now();while(!f()){if(Date.now()-start>ms)throw Error('Timed out: '+f.toString()+' '+JSON.stringify({toast:$('#toast').textContent,status:$('#status').textContent,errors}));await pause(25);}}
async function exportFile(label){
 const before=downloads.length;button(label).click();
 await until(()=>downloads.length>before);
 const file=downloads.at(-1);file.bytes=await bytes(file.blob);
 if(process.env.DAC_UI_ARTIFACTS){
  fs.mkdirSync(process.env.DAC_UI_ARTIFACTS,{recursive:true});
  fs.writeFileSync(path.join(process.env.DAC_UI_ARTIFACTS,file.name),file.bytes);
 }
 return file;
}
let pass=0;
function check(name,f){f();pass++;console.log('PASS '+name);}
(async()=>{
 check('initial workspace is usable and keyboard targets exist',()=>{
  assert.ok($('#guidePrimary'));assert.equal($('#drop').getAttribute('tabindex'),'0');
  assert.ok($('.skip-link'));assert.equal($('#paneTitle').textContent,'开始一次分析');
 });
 $('#guidePrimary').click();
 const S=w.__dacState();
 check('sample loads without running analysis implicitly',()=>{
  assert.equal(S.rows.length,150);assert.equal(S.step,2);assert.equal(S.res,null);
 });
 const inputs=[...d.querySelectorAll('#factors input')];
 for(const cb of inputs.slice(2)){cb.checked=false;event(cb);}
 check('unchecked columns stay excluded',()=>assert.equal(S.factors.length,2));
 $('#next2').click();
 check('calibration step does not start hidden analysis',()=>{assert.equal(S.step,3);assert.equal(S.res,null);});
 $('#next3').click();$('#btnRun').click();
 await until(()=>S.res);
 check('main model retains original target categories',()=>{
  assert.equal(S.res.calibration.target.levels,3);
  assert.equal(S.res.meta.factors.length,2);assert.equal(S.step,5);
  assert.equal($('#panel-4').style.display,'');
  assert.equal($('#paneTitle').textContent,'数据体检');
 });
 for(const name of ['calib','scene','rules','net','bn','robust','ai','report'])tab(name);
 check('all result pages render without JavaScript errors',()=>assert.deepEqual(errors,[]));
 tab('report');
 check('reports can be downloaded',()=>assert.ok(button('Word')||button('DOCX')));

 // Actual file-change and import-preview path, then six-class target.
 const csv='chosen,discard,outcome\n'+Array.from({length:120},(_,i)=>`${Math.sin(i)},${i%6},${10*(1+i%6)}`).join('\n');
 Object.defineProperty($('#file'),'files',{value:[{name:'six_classes.csv',text:async()=>csv}],configurable:true});
 event($('#file'));
 await until(()=>$('#impOk'));
 $('#impOk').click();
 $('#targetType').value='categorical';event($('#targetType'));
 const discard=[...d.querySelectorAll('#factors input')].find(b=>b.value==='discard');
 discard.checked=false;event(discard);
 $('#next2').click();$('#next3').click();$('#btnRun').click();
 await until(()=>S.res&&S.res.meta.target==='outcome');
 check('six-class upload preserves all target labels',()=>{
  assert.equal(S.res.calibration.target.levels,6);assert.equal(S.res.calibration.target.counts.length,6);
  assert.deepEqual(Array.from(S.factors),['chosen']);
 });
 tab('quality');
 button('运行严格').click();
 await until(()=>S.extra.quality?.strict);
 check('strict validation uses the selected variables and six classes',()=>{
  const r=S.extra.quality.strict;
  assert.equal(r.ok,true,r.reason);assert.equal(r.nLevels,6);
  assert.deepEqual(Array.from(r.config.names),['chosen']);
  assert.ok(r.oof.rowId.every(id=>id>=1&&id<=120));
 });
 button('运行嵌套').click();
 await until(()=>S.extra.quality?.nested);
 check('nested validation uses the same selection and re-computable OOF metrics',()=>{
  const r=S.extra.quality.nested;assert.equal(r.ok,true,r.reason);
  assert.deepEqual(Array.from(r.config.names),['chosen']);assert.equal(r.targetLevels.length,6);
  const correct=r.oof.pred.reduce((n,v,i)=>n+(v===r.oof.true[i]?1:0),0)/r.oof.n;
  assert.equal(correct,r.nestedAccuracy);
 });
 tab('bn');
 check('BN shows each original target category and explicit conditional sensitivity',()=>{
  assert.equal(S.res.bn.cardinalities.at(-1),6);
  assert.ok($('#pane select[aria-label="观察目标类别"]'));
 });
 tab('boot');
 let task=[...d.querySelectorAll('#pane select')].find(n=>[...n.options].some(o=>o.value==='rules'));
 task.value='rules';event(task);
 const count=[...d.querySelectorAll('#pane input[type=number]')][0];count.value='10';event(count);
 button('开始 Bootstrap').click();
 await until(()=>S.extra.boot?.result||S.extra.boot?.error);
 check('Bootstrap follows the same target contract and input selection',()=>{
  const r=S.extra.boot.result;assert.ok(r,S.extra.boot.error);assert.equal(r.okCount,10);
  assert.equal(r.targetContract.levels.length,6);assert.equal(r.summary.task,'rules');
 });
 tab('report');
 const word=await exportFile('Word 报告');
 const session=await exportFile('导出会话');
 check('Word and session exports generate real ZIP documents',()=>{
  for(const file of [word,session]){
   assert.equal(file.bytes.readUInt32LE(0),0x04034b50);
   assert.ok(file.bytes.includes(Buffer.from('word/document.xml')));
  }
 });
 const excel=await exportFile('Excel');
 const parsed=await w.DACCore.parseXLSX(excel.bytes.buffer.slice(excel.bytes.byteOffset,excel.bytes.byteOffset+excel.bytes.length));
 check('exported Excel retains factor-state labels and original outcome categories',()=>{
  assert.equal(parsed.rows.length,120);
  assert.ok(parsed.rows.every(row=>['低','中','高'].includes(row[1])));
  assert.deepEqual([...new Set(parsed.rows.map(row=>Number(row[2])))].sort((a,b)=>a-b),[10,20,30,40,50,60]);
 });
 const exported=await exportFile('导出项目（含数据）');
 const project=JSON.parse(exported.bytes.toString('utf8'));
 check('project export contains data, type, selected variables and a data fingerprint',()=>{
  assert.equal(project.format,'dac-project/2.7');
  assert.equal(project.app.version,'6.5.0');
  assert.equal(project.dataset.data.length,120);assert.ok(project.dataset.hash);
  assert.deepEqual(project.selections.factors,['chosen']);
 });
 const before=S.factors.slice();
 const oldResult=S.res;S.target='discard';S.factors=['discard'];
 project.params.seed=0;
 await w.__dacImportProject({text:async()=>JSON.stringify(project)});
 await until(()=>S.res&&S.res!==oldResult&&S.res.meta.target==='outcome');
 check('project reopen restores target type and variable selection',()=>{
  assert.equal(S.target,'outcome');assert.equal(S.targetType,'categorical');
  assert.deepEqual(Array.from(S.factors),Array.from(before));
  assert.equal($('#targetType').value,'categorical');
  assert.equal(S.params.seed,0);assert.equal(S.projVerified.hash,project.dataset.hash);
  assert.equal(S.res.calibration.target.levels,6);
 });
 check('light and dark themes both remain available',()=>{
  const wasLight=d.body.classList.contains('light');$('#btnTheme').click();
  assert.notEqual(d.body.classList.contains('light'),wasLight);
  $('#btnPalette').click();assert.equal($('#palettePanel').hidden,false);
 });
 check('no uncaught UI errors across the integration path',()=>assert.deepEqual(errors,[]));
 console.log(`${pass} UI integration groups passed${process.env.DAC_SITE_HTML?' against supplied bundled HTML':''}`);
})().catch(e=>{console.error(e.stack);process.exitCode=1;}).finally(()=>w.close());
