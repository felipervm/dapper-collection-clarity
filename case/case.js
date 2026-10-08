const input=document.getElementById('scenario');
function update(){
  const p={name:'Synthetic player',_source:'Synthetic fixture · interactive example',partial:true,owners:[{username:'Alex',flowAddress:'aa',holdings:2},{username:'Sam',flowAddress:'bb',holdings:9},{username:'Jo',flowAddress:'cc',holdings:4}]};
  const states={available:{entries:[{flowAddress:'aa',lockedScore:100,rank:1},{flowAddress:'bb',lockedScore:0,rank:2}],totalCount:3000},unavailable:null,empty:{entries:[]},malformed:{error:'unavailable'}};
  NumberContext.applyRanking(p,states[input.value]);NumberContext.render(p);
  document.getElementById('mode').textContent=p.rankingMode==='locked'?'Available locked-score view':'Ownership view · locked ranking unavailable';
  const rows=document.getElementById('rows');rows.replaceChildren();
  p.owners.forEach(o=>{const tr=document.createElement('tr');[o.username,o.holdings,o.lockedScore===null?'—':o.lockedScore].forEach(value=>{const td=document.createElement('td');td.textContent=value;tr.appendChild(td)});rows.appendChild(tr)});
  document.getElementById('explanation').textContent=p.rankingMode==='locked'?'Sam has a verified zero. Jo is absent from this response, so Jo’s score stays unknown. Positions describe this loaded subset.':'The collection still works. Holders are ordered by Moments owned, and locked scores stay unknown.';
}
input.addEventListener('change',update);update();
fetch('audit.json').then(r=>{if(!r.ok)throw Error('Audit unavailable');return r.json()}).then(report=>{
  showSnapshot(report);
  const rows=document.getElementById('audit-rows');
  report.samples.forEach(s=>{const tr=document.createElement('tr');[s.player,s.editions.toLocaleString(),s.owners.toLocaleString(),s.observedSerials.toLocaleString(),s.declaredPartial?'Yes':'No'].forEach(v=>{const td=document.createElement('td');td.textContent=v;tr.appendChild(td)});rows.appendChild(tr)});
  document.getElementById('audit-conclusion').textContent='No duplicate serial IDs or holder addresses were found in these three samples.';
}).catch(()=>{document.getElementById('audit-conclusion').textContent='Audit could not load. Serve this folder over HTTP to view the recorded results.'});


const motion=window.matchMedia('(prefers-reduced-motion: reduce)');
if(!motion.matches && 'IntersectionObserver' in window){
 const observer=new IntersectionObserver(entries=>entries.forEach(e=>{if(e.isIntersecting){e.target.classList.remove('pending');observer.unobserve(e.target)}}),{threshold:.06});
 document.querySelectorAll('.intro,.cards article,.visual-story>*,.lab>div,.audit,.next>div,.brand-context>*,.about').forEach((el,i)=>{el.style.setProperty('--delay',el.closest('.cards')?`${i%3*70}ms`:'0ms');el.classList.add('reveal','pending');observer.observe(el)});
}
input.addEventListener('change',()=>{const panel=document.querySelector('.lab-panel');panel.classList.remove('changed');requestAnimationFrame(()=>panel.classList.add('changed'))});
const navLinks=[...document.querySelectorAll('.chapter-nav a')];
if('IntersectionObserver' in window){
 const chapters=new IntersectionObserver(entries=>entries.forEach(e=>{if(e.isIntersecting)navLinks.forEach(a=>{if(a.hash===`#${e.target.id}`)a.setAttribute('aria-current','location');else a.removeAttribute('aria-current')})}),{rootMargin:'-15% 0px -55% 0px',threshold:0});navLinks.forEach(a=>chapters.observe(document.querySelector(a.hash)));}
let scrollQueued=false;
function scrollFrame(){const max=document.documentElement.scrollHeight-innerHeight;document.documentElement.style.setProperty('--reading',max>0?scrollY/max:0);if(!motion.matches){document.documentElement.style.setProperty('--hero-shift',`${Math.min(18,scrollY*.025)}px`)}scrollQueued=false}
addEventListener('scroll',()=>{if(!scrollQueued){scrollQueued=true;requestAnimationFrame(scrollFrame)}},{passive:true});scrollFrame();
function showSnapshot(report){const select=document.getElementById('snapshot'),box=document.getElementById('snapshot-summary');function render(){const s=report.samples[Number(select.value)];box.replaceChildren();[['Editions',s.editions],['Holders',s.owners],['Observed serials',s.observedSerials]].forEach(([label,value])=>{const cell=document.createElement('div');cell.className='snapshot-metric';const strong=document.createElement('strong');strong.textContent=value.toLocaleString();const span=document.createElement('span');span.textContent=label;cell.append(strong,span);box.append(cell)});const note=document.createElement('p');note.className='snapshot-note';note.textContent=s.declaredPartial?'Marked partial by the source. No update timestamp provided.':'Not marked partial. This flag alone does not verify completeness. No update timestamp provided.';box.append(note)}select.addEventListener('change',render);render()}
