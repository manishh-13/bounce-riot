import { chromium } from '@playwright/test';
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined),args:['--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-gpu-sandbox','--disable-background-timer-throttling'] });
try {
  const page = await browser.newPage({viewport:{width:1280,height:720}});
  await page.goto('http://localhost:4381/#practice');
  await page.waitForFunction(()=>window.__bounce);
  const metrics = await page.evaluate(async()=>{
    const {sim} = window.__bounce;
    sim.setPlayers(Array.from({length:8},(_,i)=>({id:`b${i}`,name:`Bot ${i+1}`,color:i,bot:true,connected:true})));
    sim.start();
    const events=new Map();const frames=[];
    let last=performance.now(),remaining=240;
    await new Promise(resolve=>{function frame(){const now=performance.now();frames.push(now-last);last=now;for(const e of sim.state.events)events.set(e.id,e.type);if(--remaining>0)requestAnimationFrame(frame);else resolve();}requestAnimationFrame(frame);});
    const ordered=frames.slice(20).sort((a,b)=>a-b);
    return {platform:'headless Chrome, software GPU, 1280x720, auto graphics',phase:sim.state.phase,tick:sim.state.tick,elapsed:sim.state.elapsed,players:sim.state.players.length,events: [...events.values()].reduce((out,type)=>(out[type]=(out[type]??0)+1,out),{}),frameMs:{median:ordered[Math.floor(ordered.length*.5)],p95:ordered[Math.floor(ordered.length*.95)]},scores:sim.state.players.map(p=>p.score),canvas:{width:document.querySelector('canvas').width,height:document.querySelector('canvas').height}};
  });
  console.log(JSON.stringify(metrics,null,2));
} finally {await browser.close();}
