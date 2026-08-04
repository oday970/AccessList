// ==UserScript==
// @name         Cisco Case Status SLA Color Guard
// @namespace    cisco.internal.tools.odemar
// @version      1.6.1
// @description  SLA color guard + MTTF Smart Histogram, self-fetching via SFDC proxy (zero-click).
// @author       Oday Emar (odemar)
// @updateURL    https://casereview.cc/mttf.user.js
// @downloadURL  https://casereview.cc/mttf.user.js
// @match        https://scripts.cisco.com/app/quicker_csone/case/*
// @grant        GM_xmlhttpRequest
// @connect      quicker-sfdc-proxy.cisco.com
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  const APP_VERSION = '1.6.1';
  const PROXY = 'https://quicker-sfdc-proxy.cisco.com/v1/sfdc/query';
  const AUTH_SOURCE = 'duo-token';
  const APITOKEN_CACHE = 'sla_mttf_apitoken';

  const RESOLVED = new Set([
    'Customer Pending Workaround','DE Pending Workaround','AS Pending Workaround','3rd Party RMA Pending','Release Pending','Restoration of Service','Close Pending','Cust Requested Closure-noOwner','Closed','Solution Provided/Monitoring','CE Pending Workaround','SE Pending Workaround','3rd Party Workaround','Service Order Pending','Failure Analysis Pending','Maintenance Window Pending','Customer Requested Closure','Closed w/o Customer Confirm',
  ]);
  const RESTART = new Set(['3rd Party Pending','CE Pending - No Contact','CE Pending','CE Pending - Lab Recreate','DE Pending','Requeue']);
  const NEUTRAL = new Set(['Customer Pending','Customer Updated']);
  const EXCLUDE = new Set(['Customer Updated']);
  const CLOSURE = new Set(['Close Pending','Customer Requested Closure','Cust Requested Closure-noOwner','Closed','Closed w/o Customer Confirm']);

  const GUARD_YELLOW = RESTART;
  const GUARD_GREEN = new Set([...RESOLVED, ...NEUTRAL]);

  const COLORS = { green:{bg:'#1e6b3a',fg:'#ffffff',caret:'#ffffff'}, yellow:{bg:'#c9a300',fg:'#1a1a1a',caret:'#1a1a1a'} };

  const OPTION_SELECTOR = 'button.mds-rebuild-dropdown-item[role="menuitem"]';
  const TRIGGER_SELECTOR = 'button.mds-rebuild-root-dropdown-button';
  const DEFAULT_CARET = '#8F8F8F';
  const CACHE_PREFIX = 'sla_mttf_v161_';

  let apiToken = null;
  try { apiToken = localStorage.getItem(APITOKEN_CACHE) || null; } catch (e) {}
  let fetchState = 'idle';
  let lastFetchedCase = null;

  function labelOf(el){ return (el.textContent||'').replace(/\s+/g,' ').trim(); }
  function classify(l){ if(GUARD_YELLOW.has(l)) return COLORS.yellow; if(GUARD_GREEN.has(l)) return COLORS.green; return null; }

  function styleCaret(el,color){
    const caret=el.querySelector('.mds-rebuild-ic-caret-down-path'); if(!caret) return;
    caret.setAttribute('stroke',color);
    caret.style.setProperty('stroke',color,'important');
    caret.style.setProperty('stroke-width','2','important');
    caret.style.setProperty('stroke-opacity','1','important');
    caret.style.setProperty('stroke-linecap','round','important');
    caret.style.setProperty('stroke-linejoin','round','important');
  }
  function paint(el,c){
    el.style.setProperty('background-color',c.bg,'important');
    el.style.setProperty('color',c.fg,'important');
    el.style.setProperty('--mds-dropdown-icon-color',c.fg);
    styleCaret(el,c.caret);
  }
  function colorizeOptions(scope){ scope.querySelectorAll(OPTION_SELECTOR).forEach(el=>{ if(el.dataset.slaColored==='1') return; const c=classify(labelOf(el)); if(!c) return; paint(el,c); el.dataset.slaColored='1'; }); }
  function colorizeTrigger(scope){ scope.querySelectorAll(TRIGGER_SELECTOR).forEach(el=>{ const c=classify(labelOf(el)); if(c){ paint(el,c); el.dataset.slaLabel=labelOf(el);} else { el.style.removeProperty('background-color'); el.style.removeProperty('color'); styleCaret(el,DEFAULT_CARET);} }); }
  function colorize(){ colorizeOptions(document); colorizeTrigger(document); }

  function caseId(){ const m=location.pathname.match(/\/case\/([^\/?#]+)/i); return m?m[1]:null; }
  function cacheKey(){ return CACHE_PREFIX+(caseId()||location.pathname); }
  function readCache(){ try{ const r=localStorage.getItem(cacheKey()); return r?JSON.parse(r):null; }catch(e){ return null; } }
  function writeCache(x){ try{ localStorage.setItem(cacheKey(),JSON.stringify(x)); }catch(e){} }

  function getAuthToken(){
    const tryKeys=[['accessToken','token'],['ow_access_token','accessToken'],['accessToken','accessToken'],['ow_access_token','token']];
    for(const [k,f] of tryKeys){
      try{ const raw=localStorage.getItem(k); if(!raw) continue; const o=JSON.parse(raw); if(o&&o[f]&&/^eyJ/.test(o[f])) return o[f]; }catch(e){}
    }
    for(let i=0;i<localStorage.length;i++){ const k=localStorage.key(i); let v=localStorage.getItem(k)||''; if(/^eyJ/.test(v)&&v.length>500) return v; try{ const o=JSON.parse(v); for(const kk in o){ if(typeof o[kk]==='string'&&/^eyJ/.test(o[kk])&&o[kk].length>500) return o[kk]; } }catch(e){} }
    return null;
  }

  function localDayIndex(ms){ const d=new Date(ms); return Math.floor((ms - d.getTimezoneOffset()*60000)/86400000); }
  function daysBetween(a,b){ if(a==null||b==null) return null; return localDayIndex(b)-localDayIndex(a); }

  function rowsFromHistory(records){
    if(!Array.isArray(records)) return [];
    const rows=[]; let anchorMs=null;
    const created=records.find(r=>r.Field==='created'||r.Field==='Created');
    if(created&&created.CreatedDate) anchorMs=Date.parse(created.CreatedDate);
    const statusRecs=records.filter(r=>r.Field==='Status'&&r.NewValue)
      .map(r=>({status:r.NewValue,user:(r.CreatedBy&&r.CreatedBy.Alias)||'',ms:Date.parse(r.CreatedDate)}))
      .filter(r=>!isNaN(r.ms)).sort((a,b)=>a.ms-b.ms);
    if(anchorMs==null){ const f=records.find(r=>r.Field==='Status'&&r.OldValue==='New'); if(f) anchorMs=Date.parse(f.CreatedDate); else if(statusRecs.length) anchorMs=statusRecs[0].ms; }
    if(anchorMs!=null) rows.push({status:'New',user:(created&&created.CreatedBy&&created.CreatedBy.Alias)||'',ms:anchorMs});
    statusRecs.forEach(r=>rows.push(r));
    return rows;
  }

  function computeMttfFromRows(rows){
    const kept=rows.filter(r=>!EXCLUDE.has(r.status));
    if(!kept.length) return {found:false,days:null,flow:[]};
    const newRow=kept.find(r=>r.status==='New')||kept[0]; const newMs=newRow.ms;
    let restartIdx=-1; for(let i=0;i<kept.length;i++) if(RESTART.has(kept[i].status)) restartIdx=i;
    const segment=restartIdx>=0?kept.slice(restartIdx+1):kept.slice();
    const resolutionRow=segment.find(r=>RESOLVED.has(r.status))||null;
    const flow=buildFlow(kept,restartIdx,newMs);
    if(resolutionRow) return {found:true,days:daysBetween(newMs,resolutionRow.ms),flow,anchor:resolutionRow.status};
    const last=kept[kept.length-1];
    if(CLOSURE.has(last.status)) return {found:true,days:daysBetween(newMs,last.ms),flow,closedFallback:true,anchor:last.status};
    return {found:false,days:null,flow};
  }

  function buildFlow(kept,restartIdx,newMs){
    const segment=restartIdx>=0?kept.slice(restartIdx):kept.slice(); const nodes=[];
    segment.forEach(r=>{ const d=daysBetween(newMs,r.ms);
      if(RESTART.has(r.status)) nodes.push({kind:'reset',status:r.status,user:r.user,days:d});
      else if(RESOLVED.has(r.status)) nodes.push({kind:'green',status:r.status,user:r.user,days:d}); });
    return nodes;
  }

  function buildQuery(id){
    return "SELECT CreatedBy.Alias,CreatedBy.Id,CreatedDate,Id,Field,NewValue,OldValue FROM CaseHistory WHERE Case.C3_SR_Number__c = '"+id+"' AND Field in ('Created','Owner','IsAccepted__c','Priority','Status','Previous_Queue__c','Subject','Workgroup__c','Technology_Text__c','Sub_Technology_Text__c','Tag__c','Scheduled_Dispatch_Time__c') ORDER BY CreatedDate ASC";
  }

  (function captureApiToken(){
    const oSet=XMLHttpRequest.prototype.setRequestHeader, oOpen=XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open=function(m,u){ this.__u=u; return oOpen.apply(this,arguments); };
    XMLHttpRequest.prototype.setRequestHeader=function(k,v){
      try{ if(this.__u&&String(this.__u).indexOf('sfdc-proxy')!==-1&&String(k).toLowerCase()==='api-token'&&v){ if(apiToken!==v){ apiToken=v; try{localStorage.setItem(APITOKEN_CACHE,v);}catch(e){} maybeFetch(); } } }catch(e){}
      return oSet.apply(this,arguments);
    };
    const oFetch=window.fetch;
    if(oFetch){ window.fetch=function(...a){ try{ const h=(a[1]&&a[1].headers); if(h){ const hs=new Headers(h); const t=hs.get('api-token'); if(t){ apiToken=t; try{localStorage.setItem(APITOKEN_CACHE,t);}catch(e){} } } }catch(e){} return oFetch.apply(this,a); }; }
  })();

  function gmGet(url, headers){
    return new Promise((resolve,reject)=>{
      GM_xmlhttpRequest({ method:'GET', url, headers,
        onload:(r)=>{ if(r.status>=200&&r.status<300) resolve(r.responseText); else reject(new Error('HTTP '+r.status+' '+(r.responseText||'').slice(0,120))); },
        onerror:()=>reject(new Error('network')),
        ontimeout:()=>reject(new Error('timeout')),
        timeout:20000
      });
    });
  }

  function fetchHistory(){
    const id=caseId(); if(!id) return Promise.reject(new Error('no case id'));
    const auth=getAuthToken();
    if(!auth) return Promise.reject(new Error('no auth-token yet'));
    if(!apiToken) return Promise.reject(new Error('no api-token yet'));
    const url=PROXY+'?q='+encodeURIComponent(buildQuery(id));
    return gmGet(url,{ 'Accept':'application/json, text/plain, */*', 'auth-token':auth, 'auth-token-source':AUTH_SOURCE, 'api-token':apiToken })
      .then(txt=>{ const data=JSON.parse(txt); if(!data||!Array.isArray(data.records)) throw new Error('bad shape'); return data.records; });
  }

  let retryTimers=[];
  function clearRetries(){ retryTimers.forEach(t=>clearTimeout(t)); retryTimers=[]; }

  function maybeFetch(){
    const id=caseId(); if(!id) return;
    if(lastFetchedCase===id && (fetchState==='done'||fetchState==='loading')) return;
    lastFetchedCase=id; fetchState='loading';
    const attempt=(n)=>{
      fetchHistory().then(records=>{
        fetchState='done';
        const result=computeMttfFromRows(rowsFromHistory(records));
        writeCache(result); renderResult(result);
      }).catch(err=>{
        if(n<5){ retryTimers.push(setTimeout(()=>attempt(n+1), [500,1500,3000,6000,10000][n]||10000)); }
        else { fetchState='error'; renderError(); }
      });
    };
    attempt(0);
  }

  function parseTsMs(text){
    const t=(text||'').replace(/\s+/g,' ').trim();
    const m=t.match(/(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})\s+(\d{1,2}):(\d{2})\s*(am|pm)\s*([+\-]\d{2}:\d{2})/i);
    if(!m) return null;
    const months={jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11};
    let hour=parseInt(m[4],10); const ap=m[6].toLowerCase();
    if(ap==='pm'&&hour!==12) hour+=12; if(ap==='am'&&hour===12) hour=0;
    const off=m[7],sign=off[0]==='-'?-1:1,oh=parseInt(off.slice(1,3),10),om=parseInt(off.slice(4,6),10);
    return Date.UTC(parseInt(m[3],10),months[m[2].toLowerCase()],parseInt(m[1],10),hour,parseInt(m[5],10))-sign*(oh*60+om)*60000;
  }
  function findHistoryTable(){
    const tables=document.querySelectorAll('section.mds-container table.mds-rebuild-table, table.mds-rebuild-table');
    for(const tbl of tables){ const head=tbl.querySelector('thead'); if(!head) continue;
      const hs=Array.from(head.querySelectorAll('.mds-rebuild-table-th-name')).map(n=>labelOf(n).toLowerCase());
      if(hs.includes('status')&&hs.some(h=>h.indexOf('date')!==-1)) return tbl; }
    return null;
  }
  function rowsFromDom(tbl){
    const rows=[];
    tbl.querySelectorAll('tbody tr[data-testid="table-row"]').forEach(tr=>{
      const cells=tr.querySelectorAll('td'); if(cells.length<6) return;
      const statusEl=cells[1].querySelector('a.mds-button')||cells[1]; const status=labelOf(statusEl);
      let user=''; const link=cells[3].querySelector('a[href*="quicker_directory"] p'); if(link) user=labelOf(link); else user=labelOf(cells[3]);
      const ms=parseTsMs(labelOf(cells[5])); if(!status||ms==null) return;
      rows.push({status,user,ms});
    });
    return rows;
  }

  const WIDGET_ID='sla-mttf-widget';
  function ensureStyles(){
    if(document.getElementById('sla-mttf-style')) return; if(!document.head) return;
    const s=document.createElement('style'); s.id='sla-mttf-style';
    s.textContent=[
      '#'+WIDGET_ID+'{display:inline-flex;align-items:center;gap:8px;font-family:CiscoSans,system-ui,sans-serif;position:relative;}',
      '#'+WIDGET_ID+' .mttf-chip{display:inline-flex;align-items:center;gap:8px;padding:6px 12px;border-radius:8px;cursor:pointer;font-size:13px;font-weight:600;line-height:1;border:1px solid rgba(255,255,255,.08);transition:transform .12s ease,box-shadow .12s ease;}',
      '#'+WIDGET_ID+' .mttf-chip:hover{transform:translateY(-1px);box-shadow:0 4px 14px rgba(0,0,0,.35);}',
      '#'+WIDGET_ID+' .mttf-found{background:#12351f;color:#5ee08a;}',
      '#'+WIDGET_ID+' .mttf-notfound{background:#3a1414;color:#ff8a8a;}',
      '#'+WIDGET_ID+' .mttf-stale{background:#2a2f36;color:#9aa4af;}',
      '#'+WIDGET_ID+' .mttf-rect{width:14px;height:14px;border-radius:3px;}',
      '#'+WIDGET_ID+' .mttf-rect.g{background:#4bc076;}',
      '#'+WIDGET_ID+' .mttf-rect.r{background:#e05555;}',
      '#'+WIDGET_ID+' .mttf-rect.s{background:#6b7480;}',
      '#'+WIDGET_ID+' .mttf-spin{width:12px;height:12px;border:2px solid #6b7480;border-top-color:transparent;border-radius:50%;animation:mttfspin .7s linear infinite;}',
      '@keyframes mttfspin{to{transform:rotate(360deg)}}',
      '#'+WIDGET_ID+' .mttf-panel{position:absolute;top:calc(100% + 8px);left:0;z-index:99999;min-width:320px;max-width:520px;background:#161a1f;color:#e6e6e6;border:1px solid #2a3038;border-radius:12px;padding:14px;box-shadow:0 12px 40px rgba(0,0,0,.55);display:none;}',
      '#'+WIDGET_ID+'.open .mttf-panel{display:block;}',
      '#'+WIDGET_ID+' .mttf-panel h4{margin:0 0 10px;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#8a94a0;font-weight:700;}',
      '#'+WIDGET_ID+' .mttf-node{display:flex;align-items:flex-start;gap:10px;padding:8px 0;border-bottom:1px solid #21262d;}',
      '#'+WIDGET_ID+' .mttf-node:last-child{border-bottom:none;}',
      '#'+WIDGET_ID+' .mttf-dot{width:10px;height:10px;border-radius:50%;margin-top:4px;flex:0 0 auto;}',
      '#'+WIDGET_ID+' .mttf-dot.g{background:#4bc076;}',
      '#'+WIDGET_ID+' .mttf-dot.o{background:#ffb75d;}',
      '#'+WIDGET_ID+' .mttf-line{font-size:12.5px;line-height:1.45;}',
      '#'+WIDGET_ID+' .mttf-line b{color:#fff;}',
      '#'+WIDGET_ID+' .mttf-user{color:#7fb1ff;}',
      '#'+WIDGET_ID+' .mttf-hint{font-size:11.5px;color:#9aa4af;padding:4px 0;}',
      '#'+WIDGET_ID+' .mttf-footer{margin-top:12px;display:flex;align-items:center;justify-content:space-between;}',
      '#'+WIDGET_ID+' .mttf-beta{font-size:10.5px;color:#8a94a0;font-weight:700;letter-spacing:.04em;}',
      '#'+WIDGET_ID+' .mttf-foot{font-size:10.5px;color:#5b636d;text-align:right;}',
    ].join('');
    document.head.appendChild(s);
  }
  function escapeHtml(s){ return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function dayLabel(d){ return d===null?'—':(d+(d===1?' day':' days')); }
  function footerHtml(){ return '<div class="mttf-footer"><span class="mttf-beta">Beta v'+APP_VERSION+'</span><span class="mttf-foot">Made by Oday (odemar)</span></div>'; }
  function panelWrap(inner){ return '<div class="mttf-panel"><h4>Current Active Flow</h4>'+inner+footerHtml()+'</div>'; }
  function calculatingHtml(){ return '<div class="mttf-chip mttf-stale"><span class="mttf-spin"></span>MTTF: calculating…</div>'+panelWrap('<div class="mttf-hint">Fetching case history…</div>'); }
  function errorHtml(){ return '<div class="mttf-chip mttf-notfound"><span class="mttf-rect r"></span>MTTF: unavailable</div>'+panelWrap('<div class="mttf-hint">Could not load case history. Ensure you are logged into Quicker; it will retry on reload.</div>'); }
  function resultHtml(result){
    const chipClass=result.found?'mttf-found':'mttf-notfound'; const rectClass=result.found?'g':'r';
    const label=result.found?('MTTF: '+dayLabel(result.days)):'Resolution Status Not Found';
    let nodes='';
    (result.flow||[]).forEach(n=>{ if(n.kind==='green') nodes+='<div class="mttf-node"><span class="mttf-dot g"></span><span class="mttf-line"><b>'+escapeHtml(n.status)+'</b> — MTTF at '+dayLabel(n.days)+' by <span class="mttf-user">'+escapeHtml(n.user)+'</span></span></div>';
      else nodes+='<div class="mttf-node"><span class="mttf-dot o"></span><span class="mttf-line"><b>'+escapeHtml(n.status)+'</b> — Reset by <span class="mttf-user">'+escapeHtml(n.user)+'</span> at '+dayLabel(n.days)+'</span></div>'; });
    if(!nodes) nodes='<div class="mttf-node"><span class="mttf-line">No active resolution flow.</span></div>';
    return '<div class="mttf-chip '+chipClass+'"><span class="mttf-rect '+rectClass+'"></span>'+escapeHtml(label)+'</div>'+panelWrap(nodes);
  }

  function findToolbar(){
    const btns=document.querySelectorAll('button, a.mds-button');
    for(const b of btns){ if(labelOf(b)==='Copilot'){ const flex=b.closest('.mds-flex'); if(flex) return {flex,before:b}; } }
    return null;
  }
  function setHtml(html, sig){
    const w=document.getElementById(WIDGET_ID); if(!w) return;
    if(w.dataset.sig===sig) return; w.dataset.sig=sig;
    const open=w.classList.contains('open'); w.innerHTML=html; if(open) w.classList.add('open');
  }
  function renderResult(result){ setHtml(resultHtml(result), JSON.stringify(result)); }
  function renderError(){ setHtml(errorHtml(), 'error'); }

  function tryDomFallback(){
    const tbl=findHistoryTable(); if(!tbl) return false;
    const rows=rowsFromDom(tbl); if(!rows.length) return false;
    const result=computeMttfFromRows(rows); writeCache(result); renderResult(result); fetchState='done'; return true;
  }

  function mountWidget(){
    ensureStyles(); const tb=findToolbar(); if(!tb) return;
    let w=document.getElementById(WIDGET_ID);
    if(!w){
      w=document.createElement('div'); w.id=WIDGET_ID; tb.flex.insertBefore(w,tb.before);
      w.dataset.sig='init'; w.innerHTML=calculatingHtml();
      w.addEventListener('click',e=>{ if(e.target.closest('.mttf-chip')) w.classList.toggle('open'); });
      document.addEventListener('click',e=>{ if(!w.contains(e.target)) w.classList.remove('open'); });
      const cached=readCache(); if(cached){ w.dataset.sig=JSON.stringify(cached); w.innerHTML=resultHtml(cached); }
      maybeFetch();
      [1000,3000,6000].forEach(t=>setTimeout(()=>{ if(fetchState!=='done') tryDomFallback(); },t));
    } else if(w.parentNode!==tb.flex || w.nextSibling!==tb.before){
      tb.flex.insertBefore(w,tb.before);
    }
  }

  let lastPath=location.pathname;
  function tick(){
    if(location.pathname!==lastPath){ lastPath=location.pathname; fetchState='idle'; clearRetries(); const w=document.getElementById(WIDGET_ID); if(w) w.dataset.sig='init'; }
    colorize(); mountWidget(); maybeFetch();
  }

  function boot(){ tick(); const o=new MutationObserver(()=>tick()); o.observe(document.documentElement||document.body,{childList:true,subtree:true,characterData:true}); }
  if(document.body) boot(); else document.addEventListener('DOMContentLoaded',boot);
})();