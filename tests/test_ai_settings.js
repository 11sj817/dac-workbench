// Exercise the connection-test UI with local HTTP-response substitutes.
// This checks rendering and persistence; real-provider evidence is recorded separately.
const {JSDOM,VirtualConsole}=require('jsdom');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),errors=[];
const vc=new VirtualConsole();vc.on('jsdomError',e=>errors.push(e.message));
const source=process.env.DAC_SITE_HTML
 ?fs.readFileSync(process.env.DAC_SITE_HTML,'utf8')
 :fs.readFileSync(path.join(root,'workbench/index.html'),'utf8');
const dom=new JSDOM(source,{url:'https://11sj817.github.io/dac-workbench/',runScripts:'outside-only',virtualConsole:vc});
const w=dom.window,d=w.document,$=s=>d.querySelector(s);
w.matchMedia=()=>({matches:false,addEventListener(){}});w.scrollTo=()=>{};
w.TextEncoder=TextEncoder;w.TextDecoder=TextDecoder;
const saved={provider:'deepseek',baseURL:'https://example.invalid/v1',model:'original-model',key:'local-test-placeholder',persist:true};
w.localStorage.setItem('dac-workbench-ai',JSON.stringify(saved));
if(process.env.DAC_SITE_HTML){
 for(const script of d.querySelectorAll('script'))w.eval(script.textContent);
}else{
 for(const file of ['data/samples.js','workbench/preprocess.js','workbench/core.js','workbench/bootstrap.js','workbench/glm.js','workbench/ui.js'])
  w.eval(fs.readFileSync(path.join(root,file),'utf8'));
}
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(f){for(let i=0;i<300&&!f();i++)await pause(10);assert.ok(f(),'UI did not settle');}
let passed=0;
function check(name,f){f();passed++;console.log('PASS '+name);}
(async()=>{
 $('#tabs button[data-tab="ai"]').click();
 const model=$('input[placeholder="model"]');
 const test=[...d.querySelectorAll('#pane button')].find(b=>b.textContent==='测试连接');
 model.value='invalid-draft-model';
 let requestedModel;
 w.fetch=async(url,opt)=>{
  requestedModel=JSON.parse(opt.body).model;
  return {ok:false,status:400,headers:{get:()=>null},text:async()=>
   'The supported API model names are example-one, example-two, but you passed invalid-draft-model. <img src=x onerror=alert(1)>'};
 };
 test.click();await until(()=>!test.disabled);
 check('connection test uses draft without overwriting saved settings',()=>{
  assert.equal(requestedModel,'invalid-draft-model');
  assert.deepEqual(JSON.parse(w.localStorage.getItem('dac-workbench-ai')),saved);
  assert.equal(w.sessionStorage.getItem('dac-workbench-ai-session'),null);
 });
 check('model error lists actual models without markup or the rejected model as a suggestion',()=>{
  const out=$('#pane .testout');
  const diagnosis=[...out.childNodes].filter(n=>n.nodeType===3).map(n=>n.textContent).join('');
  assert.match(diagnosis,/example-one、example-two/);
  assert.ok(!diagnosis.includes('but you passed'));
  assert.ok(!out.textContent.includes('</code>'));
  assert.equal(out.querySelector('img'),null);
  assert.ok(out.textContent.includes('<img src=x'));
 });
 model.value='<svg onload=alert(1)>';
 w.fetch=async()=>({ok:true,status:200,text:async()=>JSON.stringify({
  choices:[{message:{content:'<img src=x onerror=alert(1)>'},finish_reason:'stop'}]
 })});
 test.click();await until(()=>!test.disabled);
 check('successful response and model name remain plain text and settings stay unchanged',()=>{
  const out=$('#pane .testout');
  assert.ok(out.classList.contains('ok'));
  assert.equal(out.querySelector('img,svg'),null);
  assert.ok(out.textContent.includes('<svg onload=alert(1)>'));
  assert.ok(out.textContent.includes('<img src=x onerror=alert(1)>'));
  assert.deepEqual(JSON.parse(w.localStorage.getItem('dac-workbench-ai')),saved);
 });
 check('connection controls recover without DOM exceptions',()=>{
  assert.equal(test.textContent,'测试连接');assert.deepEqual(errors,[]);
 });
 console.log(passed+' AI settings checks passed');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>w.close());
