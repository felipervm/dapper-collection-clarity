const { test } = require('node:test');
const assert = require('node:assert/strict');
const { applyRanking, score } = require('../number-context.js');
const player = () => ({ owners: [{flowAddress:'aa',holdings:2}, {flowAddress:'bb',holdings:9}, {flowAddress:'cc',holdings:4}], partial:true });
test('network failure orders by holdings and keeps unknown scores null', () => {
  const p=player(); applyRanking(p,null);
  assert.equal(p.rankingMode,'holdings'); assert.deepEqual(p.owners.map(o=>o.flowAddress),['bb','cc','aa']);
  assert.ok(p.owners.every(o=>o.lockedScore===null)); assert.equal(p.lockedTotalScore,null);
});
test('verified zero differs from holder absent from capped leaderboard', () => {
  const p=player(); applyRanking(p,{entries:[{flowAddress:'AA',lockedScore:0,rank:1000},{flowAddress:'bb',lockedScore:80,rank:3}],totalCount:3000});
  assert.equal(p.rankingMode,'locked'); assert.deepEqual(p.owners.map(o=>o.flowAddress),['bb','aa','cc']);
  assert.equal(p.owners[1].lockedScore,0); assert.equal(p.owners[2].lockedScore,null);
  assert.equal(p.lockedTotalScore,80); assert.equal(p.numberContext.returned,2);
});
for (const [label,response] of Object.entries({empty:{entries:[]},malformed:{error:'down'},invalid:{entries:[{flowAddress:'aa',lockedScore:NaN}]},duplicate:{entries:[{flowAddress:'AA',lockedScore:1},{flowAddress:'aa',lockedScore:1}]},unmatched:{entries:[{flowAddress:'dd',lockedScore:3}]}})) {
  test(label+' response cannot become an authoritative score ranking',()=>{
    const p=player(); applyRanking(p,response); assert.equal(p.rankingMode,'holdings'); assert.equal(p.lockedTotalScore,null);
  });
}
test('missing update time is not replaced with load time',()=>{
  const p=player();p._source='Repository sample';applyRanking(p,null);assert.equal(p.numberContext.updatedAt,null);assert.equal(p.numberContext.source,'Repository sample');
});
test('negative, strings and null are not scores; real zero is a score',()=>{
  for(const v of [null,undefined,'0',-1,Infinity,NaN])assert.equal(score(v),null);
  assert.equal(score(0),0);
});
