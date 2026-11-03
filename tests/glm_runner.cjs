const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const context=vm.createContext({window:{},console});
vm.runInContext(fs.readFileSync(path.join(__dirname,'../workbench/glm.js'),'utf8'),context);
try{
 const payload=JSON.parse(fs.readFileSync(0,'utf8'));
 process.stdout.write(JSON.stringify({ok:true,result:context.window.DACGLM.fit(payload)}));
}catch(error){process.stdout.write(JSON.stringify({ok:false,error:error.message}));process.exitCode=1;}
