const { chromium } = require('playwright');
(async()=>{const b=await chromium.launch();
for (const [f,w,h] of [['logo',800,800],['banner',2560,1440]]){
 const p=await b.newPage({viewport:{width:w,height:h}});
 await p.goto('file://'+process.cwd()+'/'+f+'.svg'); await p.screenshot({path:f+'.png',omitBackground:true}); await p.close();}
await b.close();})();
