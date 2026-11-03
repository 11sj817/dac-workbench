const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
global.window={};eval(fs.readFileSync(path.join(__dirname,'../workbench/glm.js'),'utf8'));
const G=window.DACGLM,spec={numCols:[{name:'x',idx:0}]};
let checks=0;
function near(a,b,tol=1e-7){assert.ok(Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a-b)<=tol*Math.max(1,Math.abs(a),Math.abs(b)),`${a} != ${b}`);checks++;}
near(G.pTwoSidedT(2.2,8),0.0589939,1e-7);
near(G.tCrit(8,.975),2.3060041352,1e-9);
near(G.pTwoSidedT(G.tCrit(8,.975),8),.05,1e-12);
const rows=Array.from({length:48},(_,i)=>[(i-24)/25]),weights=rows.map((_,i)=>i%5);
for(const family of ['gaussian','binomial','poisson','gamma','gamma-inverse','negbin']){
 const y=rows.map(([x],i)=>family==='binomial'?(i%3===0?1:0)
   :['poisson','negbin'].includes(family)?1+(i%4)
   :family==='gamma-inverse'?1/(1.2+.08*x)*(1+.08*Math.sin(i))
   :Math.exp(.2+.12*x)*(1+.08*Math.sin(i)));
 const common={spec,family,theta:family==='negbin'?2.5:undefined,maxIter:120,tol:1e-10};
 const weighted=G.fit({...common,rows,y,weights});
 const duplicated=[],dy=[];
 rows.forEach((r,i)=>{for(let j=0;j<weights[i];j++){duplicated.push(r);dy.push(y[i]);}});
 const full=G.fit({...common,rows:duplicated,y:dy});
 assert.ok(weighted.converged&&full.converged);
 assert.equal(weighted.nFreq,dy.length);assert.equal(weighted.dfResid,full.dfResid);
 for(let j=0;j<weighted.coef.length;j++){
  for(const key of ['est','se','stat','p','lo','hi'])near(weighted.coef[j][key],full.coef[j][key],1e-6);
 }
 for(const key of ['deviance','pearson','dispersion','logLik','aic','bic','nullDeviance'])near(weighted[key],full[key],1e-7);
 console.log('PASS frequency replication: '+family);
}
assert.throws(()=>G.fit({rows:[[0],[1],[2],[3]],y:[1,2,3,4],spec,family:'gaussian',weights:[1,-1,1,1]}),/非负/);
console.log(`${checks} numerical comparisons passed`);
