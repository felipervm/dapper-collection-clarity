import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),server=require('./serve.cjs');
await new Promise(resolve=>server.listen(8767,'127.0.0.1',resolve));
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--enable-unsafe-swiftshader']});
const sample=JSON.parse(fs.readFileSync('data/2544.json','utf8'));
let failures=[];
try {
  for(const scenario of ['unavailable','available','empty','malformed']) {
    const page=await browser.newPage({viewport:{width:1440,height:1000}});
    const errors=[];page.on('pageerror',err=>errors.push(err.message));
    page.on('console',msg=>{if(msg.type()==='error') console.log('BROWSER:',msg.text().slice(0,200));});
    page.on('pageerror',err=>console.log('PAGE ERROR:',err.message));
    await page.route('https://fandom-v3.vercel.app/data/**',route=>route.abort());
    await page.route('**/*',route=>route.request().resourceType()==='image' ? route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'}) : route.fallback());
    await page.route('**/api/leaderboard?**',route=>{
      if(scenario==='unavailable')return route.fulfill({status:503,body:'unavailable'});
      const entries=scenario==='available'?sample.owners.slice(0,3).map((o,i)=>({flowAddress:o.flowAddress,lockedScore:i===2?0:100-i*10,rank:i+1})):[];
      return route.fulfill({contentType:'application/json',body:JSON.stringify(scenario==='malformed'?{error:'bad response'}:{entries,totalCount:sample.owners.length})});
    });
    await page.goto('http://127.0.0.1:8767/fandom.html?player=LeBron+James',{waitUntil:'domcontentloaded'});
    try { await page.waitForFunction(()=>window.__fandomCoverage && document.querySelector('#number-context:not([hidden])'),{},{timeout:45000}); }
    catch(err){await page.screenshot({path:'case/debug.png'});console.log((await page.locator('body').innerText()).slice(-1400));throw err;}
    const text=await page.locator('#number-context').textContent();
    assert.ok(text.includes('Not provided by this dataset'));
    assert.ok(text.includes('Repository sample'));
    assert.ok(text.includes('partial'));
    const locked=scenario==='available';
    assert.ok(text.includes(locked?'Locked score':'Ownership view'));
    assert.equal(await page.locator('.lb-title').textContent(),locked?'Available Score Leaders':'Ownership Leaders');
    const coverage=await page.evaluate(()=>window.__fandomCoverage);
    assert.equal(coverage.M,sample.owners.length); assert.ok(coverage.S>=200);
    const scores=await page.locator('.lb-holdings').allTextContents();
    if(locked){assert.ok(scores.includes('0'));assert.ok(scores.includes('—'));}else{assert.ok(scores.every(v=>v!=='—'&&v!=='0'));}
    await page.locator('#number-context summary').click();
    assert.equal(await page.locator('#number-context').evaluate(el=>el.open),true);
    if(scenario==='unavailable'){
      await page.screenshot({path:'case/graph-desktop.png'});
      await page.setViewportSize({width:390,height:844});
      await page.screenshot({path:'case/graph-mobile.png'});
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
    }
    if(scenario==='unavailable'||scenario==='available'){
      const address=sample.owners[scenario==='available'?2:0].flowAddress;
      await page.evaluate(address=>window.fandomRouter.go('player',{player:'LeBron James',spotlight:address}),address);
      await page.waitForFunction(()=>document.getElementById('spotlight-overlay').style.display==='flex');
      const spotlight=await page.locator('#spotlight-stats').textContent();
      assert.ok(spotlight.includes(scenario==='available'?'locked score of 0':'locked score is unavailable'));
      assert.ok(!spotlight.includes("haven't locked"));
    }
    assert.deepEqual(errors,[]);console.log('PASS graph '+scenario+' · source, null/zero, ranking, coverage, disclosure');
    await page.close();
  }
  const casePage=await browser.newPage({viewport:{width:1440,height:1000}});
  await casePage.goto('http://127.0.0.1:8767/case/index.html',{waitUntil:'networkidle'});
  assert.equal(await casePage.locator('#audit-rows tr').count(),3);
  assert.ok((await casePage.locator('#rows').textContent()).includes('—'));
  for(const state of ['unavailable','empty','malformed']){
    await casePage.selectOption('#scenario',state);
    assert.ok((await casePage.locator('#mode').textContent()).includes('Ownership view'));
    assert.equal(await casePage.locator('#rows td').filter({hasText:/^—$/}).count(),3);
  }
  await casePage.selectOption('#scenario','available');
  await casePage.screenshot({path:'case/case-desktop.png',fullPage:true});
  await casePage.setViewportSize({width:390,height:844});
  assert.ok(await casePage.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
  await casePage.screenshot({path:'case/case-mobile.png',fullPage:true});
  console.log('PASS case · 4 interactive states, recorded audit, desktop and mobile');
  await casePage.close();
} catch(err){failures.push(err.stack);console.error(err.stack)}
finally{await browser.close();server.close();}
if(failures.length)process.exit(1);
