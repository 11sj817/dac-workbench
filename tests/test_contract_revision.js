const fs=require('node:fs'), path=require('node:path'), vm=require('node:vm'), assert=require('node:assert/strict');
global.window={};
for(const name of ['preprocess','core','bootstrap']) eval(fs.readFileSync(path.join(__dirname,'../workbench',name+'.js'),'utf8'));
const C=window.DACCore, B=window.DACBootstrap;
let passed=0;
function test(name,f){f();passed++;console.log('PASS '+name);}
const base={k:4,seed:42,levels:3,drops:30,lowPct:10,highPct:90,treeDepth:3,minLeaf:3,targetType:'binary',impute:'median'};
for(const variant of ['ascending','descending','shuffled','duplicates']){
  test('temporal order: '+variant,()=>{
    let times=Array.from({length:120},(_,i)=>variant==='duplicates'?Math.floor(i/3):i);
    if(variant==='descending')times.reverse();
    if(variant==='shuffled')times=times.map((_,i)=>((i*47)%120));
    const X=times.map((t,i)=>[t,Math.sin(i)]), y=times.map(t=>t%2?10:20);
    const order=times.map((_,i)=>i).sort((a,b)=>times[a]-times[b]);
    const r=C.crossValidateStrict(X,y,['signal','noise'],['10','20'],{...base,timeOrder:order,timeValues:times});
    assert.equal(r.ok,true);
    assert.ok(r.records.length);
    for(const fold of r.records) assert.ok(Math.max(...fold.trainRawIdx.map(i=>times[i]))<Math.min(...fold.testRawIdx.map(i=>times[i])));
    assert.equal(C.leakageAudit(r,X,['signal','noise']).ok,true);
    const broken=structuredClone(r);
    broken.records[0].trainRawIdx=[foldLatest(r,times)];
    assert.equal(C.leakageAudit(broken,X,['signal','noise']).ok,false);
    function foldLatest(result,values){return values.indexOf(Math.max(...values));}
  });
}
test('invalid time values cannot silently fall back to random CV',()=>{
 const timeValues=Array.from({length:60},(_,i)=>i);timeValues[5]=null;
 const r=C.crossValidateStrict(timeValues.map((_,i)=>[i]),timeValues.map((_,i)=>i%2),['x'],['0','1'],{...base,timeValues,timeOrder:Array.from({length:60},(_,i)=>i)});
 assert.equal(r.ok,false);assert.match(r.reason,/时间/);
});
test('six nominal classes survive every cloud level setting',()=>{
 const y=Array.from({length:120},(_,i)=>10+(i%6)*10);
 for(const targetType of ['categorical','nominal','ordinal']){
  const e=C.encodeTarget(y,{levels:2,targetType});
  assert.equal(e.levels,6);assert.deepEqual(e.counts,[20,20,20,20,20,20]);
  const r=C.crossValidateStrict(y.map((v,i)=>[v+Math.sin(i)]),y,['x'],[],{...base,levels:2,targetType});
  assert.equal(r.nLevels,6);assert.equal(r.oof.confusion.length,6);
 }
});
test('nested OOF labels and pooled metrics are independently reproducible',()=>{
 const X=Array.from({length:123},(_,i)=>[Math.sin(i/8),i/123]);
 const y=X.map((r,i)=>i%3?10:20), rowIds=X.map((_,i)=>'row-'+i);
 const r=C.nestedCV(X,y,['x','z'],['10','20'],{...base,k:4,innerK:2,levels:4,drops:35,rowIds,grid:[{treeDepth:2,minLeaf:4},{treeDepth:3,minLeaf:7}]});
 assert.equal(r.ok,true);
 const m=C.evalMetrics(r.oof.true,r.oof.pred,2);
 assert.equal(m.accuracy,r.nestedAccuracy);
 assert.equal(m.balancedAccuracy,r.nestedBalancedAccuracy);
 assert.equal(r.oof.rowId.length,r.oof.n);
 r.oof.rowId.forEach((id,i)=>assert.equal(r.oof.trueLabel[i],y[Number(id.slice(4))]));
 assert.equal(r.config.lowPct,10);assert.equal(r.config.highPct,90);assert.equal(r.config.levels,4);assert.equal(r.config.drops,35);
});
test('nested inner calls preserve time constraints and calibration options',()=>{
 const calls=[], ctx={window:{},console,calls};
 vm.createContext(ctx);
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../workbench/preprocess.js'),'utf8'),ctx);
 let src=fs.readFileSync(path.join(__dirname,'../workbench/core.js'),'utf8');
 src=src.replace('function crossValidateStrict(rawX, yRaw, names, labels, opt, groups) {',
 `function crossValidateStrict(rawX, yRaw, names, labels, opt, groups) {calls.push({n:rawX.length,opt});`);
 vm.runInContext(src,ctx);
 const X=Array.from({length:180},(_,i)=>[180-i,Math.sin(i)]),y=X.map((r,i)=>i%2);
 ctx.window.DACCore.nestedCV(X,y,['timeSignal','noise'],['0','1'],{
   ...base,k:3,innerK:2,levels:4,drops:35,timeOrder:X.map((_,i)=>179-i),timeValues:X.map(r=>r[0]),
   grid:[{treeDepth:2,minLeaf:3}]
 });
 assert.ok(calls.length>2);
 for(const c of calls){assert.equal(c.opt.lowPct,10);assert.equal(c.opt.levels,4);assert.equal(c.opt.drops,35);}
 for(const c of calls.filter(c=>!c.opt.fixedFolds))assert.equal(c.opt.timeOrder.length,c.n);
});
test('BN accepts distinct factor and target cardinalities without phantom target classes',()=>{
 const data=Array.from({length:120},(_,i)=>[i%2,i%3,i%6]);
 const bn=C.bnLearn(data,['binary','cloud','target'],3,{cardinalities:[2,3,6]});
 assert.equal(bn.cpt[0][0].length,2);assert.equal(bn.cpt[2][0].length,6);
 const post=C.bnInfer(bn,{}).posterior;
 assert.equal(post.length,6);assert.ok(Math.abs(post.reduce((a,b)=>a+b,0)-1)<1e-12);
});
test('rule conditions use factor labels independently of six outcome categories',()=>{
 const X=Array.from({length:120},(_,i)=>[i%3]);
 const y=X.map(r=>r[0]*2);
 const r=C.cart(X,y,['signal'],['10','20','30','40','50','60'],{
  maxDepth:3,minLeaf:5,featureLabels:[['低','中','高']]
 });
 assert.ok(r.rules.some(rule=>rule.conditions.length));
 for(const rule of r.rules){
  assert.ok(['10','20','30','40','50','60'].includes(rule.then));
  for(const condition of rule.condRaw) assert.ok(condition.lo>=0&&condition.hi<3);
  assert.ok(rule.conditions.every(condition=>!/\d{2}/.test(condition)));
 }
});
test('Bootstrap rules and BN retain six target categories',()=>{
 const y=Array.from({length:120},(_,i)=>10*(1+i%6));
 const data={X:y.map((v,i)=>[v+Math.sin(i)]),y,names:['x'],yName:'outcome',labels:y.slice(0,6).map(String)};
 for(const task of ['rules','bn']){
  const r=B.run(data,{task,B:4,levels:3,drops:30,seed:42,method:'iid',fraction:1,replacement:true,targetType:'nominal',targetLevels:[10,20,30,40,50,60],maxDepth:3,minLeaf:3});
  assert.equal(r.okCount,4,JSON.stringify(r.runs));
  assert.equal(r.targetContract.levels.length,6);
 }
});
test('parameter robustness keeps all six original outcome categories',()=>{
 const y=Array.from({length:120},(_,i)=>10*(1+i%6));
 const runs=C.robustness(y.map((v,i)=>[v+Math.sin(i)]),y,['x'],[],
  {...base,k:3},{targetType:'categorical',targetLevels:[10,20,30,40,50,60]});
 assert.equal(runs.length,7);
 for(const r of runs){assert.equal(r.error,undefined);assert.equal(r.targetLevels,6);}
});
console.log(`${passed} contract regression groups passed`);
