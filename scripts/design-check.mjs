import {chromium} from '@playwright/test';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url), server=require('./serve.cjs');
await new Promise(r=>server.listen(8978,'127.0.0.1',r));
const browser=await chromium.launch({channel:'chrome',headless:true});
try {
 for(const width of [1440,390]){
 const page=await browser.newPage({viewport:{width,height:960},reducedMotion:'reduce'});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:8978/case/index.html');await page.locator('#audit-rows tr').nth(2).waitFor();await page.evaluate(()=>document.fonts.ready);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 assert.ok(await page.locator('.hero-art img').evaluate(e=>e.complete&&e.naturalWidth>0));
 for(const value of ['available','unavailable','empty','malformed']){await page.selectOption('#scenario',value);assert.equal(await page.locator('#rows tr').count(),3);const text=await page.locator('#rows').innerText();assert.ok(text.includes('—'));if(value==='available')assert.ok(text.includes('0'));else assert.ok((await page.locator('#mode').innerText()).includes('Ownership'));}
 await page.selectOption('#scenario','available');
 await page.locator('.insight-detail summary').first().click();assert.ok(await page.locator('.insight-detail').first().evaluate(e=>e.open));
 await page.selectOption('#snapshot','2');assert.ok((await page.locator('#snapshot-summary').innerText()).includes('30,881'));
 await page.selectOption('#snapshot','0');assert.ok((await page.locator('#snapshot-summary').innerText()).includes('7,830'));
 for(const img of await page.locator('img').all()){await img.scrollIntoViewIfNeeded();await img.evaluate(e=>e.decode())};assert.equal(await page.locator('img').evaluateAll(es=>es.every(e=>e.complete&&e.naturalWidth>0)),true);
 assert.deepEqual(errors,[]);
 await page.screenshot({path:`case/case-${width===1440?'desktop':'mobile'}.png`,fullPage:true});await page.close();console.log(`${width}: image, fonts, 4 states, audit, overflow, reduced motion PASS`);
 }
 const page=await browser.newPage();await page.goto('http://127.0.0.1:8978/case/index.html');assert.ok(await page.locator('.hero-art img').evaluate(e=>getComputedStyle(e).animationName==='none'));await page.locator('.about').scrollIntoViewIfNeeded();await page.waitForTimeout(900);assert.ok(!(await page.locator('.about').getAttribute('class')).includes('pending'));console.log('Motion reveal PASS');
 await page.goto('http://127.0.0.1:8978/case/offline-test.html');await page.locator('#audit-rows tr').nth(2).waitFor();await page.selectOption('#snapshot','1');assert.ok((await page.locator('#snapshot-summary').innerText()).includes('29,938'));for(const img of await page.locator('img').all()){await img.scrollIntoViewIfNeeded();await img.evaluate(e=>e.decode())};assert.equal(await page.locator('img').evaluateAll(es=>es.every(e=>e.complete&&e.naturalWidth>0)),true);console.log('Standalone embedded assets, audit and snapshot selector PASS');

}finally{await browser.close();await new Promise(r=>server.close(r))}
