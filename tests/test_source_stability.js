// Behavior checks for source badges, interrupted work, and parameter-only exports.
const {JSDOM,VirtualConsole}=require('jsdom');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const errors=[],vc=new VirtualConsole();
vc.on('jsdomError',e=>errors.push(e.message));
const html=fs.readFileSync(process.env.DAC_SITE_HTML||path.join(root,'workbench/index.html'),'utf8');
const dom=new JSDOM(html,{url:'https://11sj817.github.io/dac-workbench/',runScripts:'outside-only',pretendToBeVisual:true,virtualConsole:vc});
const w=dom.window,d=w.document,$=s=>d.querySelector(s);
w.matchMedia=()=>({matches:false,addEventListener(){}});w.scrollTo=()=>{};
w.TextEncoder=TextEncoder;w.TextDecoder=TextDecoder;
const urls=[],workers=[];
w.URL.createObjectURL=()=>{const url='blob:worker-'+urls.length;urls.push(url);return url;};
const revoked=[];w.URL.revokeObjectURL=url=>revoked.push(url);
w.__WORKER_SRC__='mocked only in this test';
w.Worker=class {constructor(){this.terminated=false;workers.push(this);}postMessage(){}terminate(){this.terminated=true;}};
if(process.env.DAC_SITE_HTML){
 for(const s of d.querySelectorAll('script')) w.eval(s.textContent);
}else{
 for(const p of ['data/samples.js','workbench/preprocess.js','workbench/core.js','workbench/bootstrap.js','workbench/glm.js','workbench/ui.js'])
  w.eval(fs.readFileSync(path.join(root,p),'utf8'));
}
const event=(node,type='change')=>node.dispatchEvent(new w.Event(type,{bubbles:true}));
const pause=ms=>new Promise(r=>setTimeout(r,ms));
let passed=0;
function check(name,f){f();passed++;console.log('PASS '+name);}
async function until(f){for(let i=0;i<600&&!f();i++)await pause(10);assert.ok(f(),'condition timed out');}
(async()=>{
 $('#guidePrimary').click();
 const S=w.__dacState();
 check('official badge requires shipped matching content',()=>{
  assert.equal($('#sourceBadge').textContent,'官方样本已对账');
  assert.ok($('#sourceDetailsBody').textContent.includes('SHA-256'));
  assert.ok(!Object.hasOwn(S.dsMeta,'rows'));
 });
 $('#mobileStepNext').click();check('mobile next advances to calibration',()=>assert.equal(S.step,3));
 $('#mobileStepNext').click();$('#mobileStepNext').click();
 check('analysis has visible busy feedback and prevents duplicate click',()=>assert.equal($('#btnRun').disabled,true));
 // Change dataset before the scheduled main-thread computation starts.
 $('#dsSelect').value='enterprise';event($('#dsSelect'));
 await pause(60);
 check('changing dataset cancels queued work and resets source and filename',()=>{
  assert.equal(S.res,null);assert.equal(S.busy,false);
  assert.equal($('#sourceBadge').textContent,'合成演示数据');
  assert.ok(S.fileName.includes('合成'));assert.equal($('#loadbar').classList.contains('on'),false);
 });
 $('#dsSelect').value='iris';event($('#dsSelect'));
 $('#next2').click();$('#next3').click();$('#btnRun').click();
 await until(()=>S.res&&!S.busy);
 check('long summary is collapsed and strict validation is not invented',()=>{
  assert.equal($('#summary').tagName,'DETAILS');assert.equal($('#summary').open,false);
  assert.equal($('#validationBadge').textContent,'严格 CV 尚未运行');
 });
 $('#k').value='4';event($('#k'),'input');
 check('changing parameters immediately removes stale results without hidden rerun',()=>{
  assert.equal(S.res,null);assert.equal($('#summary').style.display,'none');assert.equal($('#resultBar'),null);
 });
 const wk=w.__WK;
 const active=wk.ensure();
 const firstTask=wk.run('nestedCV',{}), firstId=wk.seq;
 const secondTask=wk.run('bootstrapKmeans',{}), secondId=wk.seq;
 check('all background tasks expose cancellation and actual busy state',()=>{
  assert.equal($('#sb-worker').textContent,'后台计算中');
  assert.equal($('#sb-cancel').style.display,'');
 });
 active.onmessage({data:{id:firstId,status:'done',result:{ok:true}}});
 await firstTask;
 check('finishing one queued task keeps cancellation available for the other',()=>{
  assert.equal($('#sb-cancel').style.display,'');
  assert.equal($('#sb-worker').textContent,'后台计算中');
 });
 active.onmessage({data:{id:secondId,status:'done',result:{ok:true}}});
 await secondTask;
 check('idle worker is ready and cancellation is hidden after every task completes',()=>{
  assert.equal($('#sb-worker').textContent,'后台已就绪');
  assert.equal($('#sb-cancel').style.display,'none');
 });
 const timeout=wk.run('unresponsive',{}, {timeoutMs:15}).then(()=>null,e=>e);
 const timeoutError=await timeout;
 check('timeout terminates worker, rejects pending task and revokes URL',()=>{
  assert.match(timeoutError.message,/超时/);assert.equal(active.terminated,true);
  assert.equal(wk.pending.size,0);assert.equal(wk.worker,null);assert.equal(wk.url,null);assert.ok(revoked.length);
  assert.equal($('#sb-worker').textContent,'按需启动');
  assert.equal($('#sb-cancel').style.display,'none');
 });
 const second=wk.ensure();
 const cancel=wk.run('cancelled',{}).catch(e=>e);
 wk.cancelAll();
 check('cancel allows a fresh worker without orphaned computation',()=>{
  assert.notEqual(active,second);assert.equal(second.terminated,true);assert.equal(wk.pending.size,0);
 });
 await cancel;
 // An earlier slow file read must not overwrite a later sample selection.
 let finishRead;
 Object.defineProperty($('#file'),'files',{value:[{name:'slow.csv',text:()=>new Promise(r=>{finishRead=r;})}],configurable:true});
 event($('#file'));
 $('#dsSelect').value='wine';event($('#dsSelect'));
 finishRead('x,y\n1,0\n2,1');await pause(30);
 check('late upload cannot overwrite a newer dataset choice',()=>{
  assert.equal(S.rows.length,400);assert.equal($('#impOk'),null);
  assert.ok(S.fileName.includes('红酒'));
 });
 const originalParse=w.DACCore.parseXLSXAll;
 w.DACCore.parseXLSXAll=async()=>[
  {name:'source-one',columns:['x','y'],rows:[[1,0],[2,1]]},
  {name:'source-two',columns:['x','y'],rows:[[3,0],[4,1]]}
 ];
 Object.defineProperty($('#file'),'files',{value:[{name:'book.xlsx',arrayBuffer:async()=>new ArrayBuffer(0)}],configurable:true});
 event($('#file'));await until(()=>S.sheets?.length===2);
 $('#btnRoles').click();
 const sheets=[...d.querySelectorAll('select')].find(s=>[...s.options].some(o=>o.textContent.includes('source-two')));
 sheets.value='1';event(sheets);
 check('sheet changes preserve workbook selection and original filename',()=>{
  assert.equal(S.sheets.length,2);assert.equal(S.sheetIdx,1);assert.equal(S.fileName,'book.xlsx');
  assert.equal(S.rows[0][0],3);
 });
 w.DACCore.parseXLSXAll=originalParse;
 // Forged provenance must not turn user-uploaded content into an official sample.
 const fake={format:'dac-project/2.7',name:'forged metadata',dataset:{
  name:'my measurements',columns:['x','y'],data:Array.from({length:30},(_,i)=>[i,i%2]),
  meta:{provenance:{kind:'public',status:'matched'},rows:[[999,999]]}
 },selections:{target:'y',factors:['x'],targetType:'binary'},roles:{x:'num',y:'target'},params:{seed:0}};
 await w.__dacImportProject({text:async()=>JSON.stringify(fake)});
 await until(()=>S.res&&!S.busy);
 check('uploaded source claims are not trusted and raw rows are removed from metadata',()=>{
  assert.equal($('#sourceBadge').textContent,'用户数据 · 来源未核验');
  assert.equal(S.originRecord,null);assert.ok(!Object.hasOwn(S.dsMeta,'rows'));
 });
 check('no DOM exceptions',()=>assert.deepEqual(errors,[]));
 console.log(passed+' source/stability checks passed');w.close();
})().catch(e=>{console.error(e);w.close();process.exitCode=1;});
