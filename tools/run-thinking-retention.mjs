import { readFileSync } from 'node:fs';
const URL_='http://localhost:8098', ADMIN='synthetic-local-admin-token';
const HOME=process.env.HOME;
const payload=JSON.parse(readFileSync(`${HOME}/benchmarks/agent-ops/payloads/44-thinking-load-bearing.json`,'utf8'));
const facts=JSON.parse(readFileSync(`${HOME}/benchmarks/keyfacts.json`,'utf8'))['44-thinking-load-bearing'].keyFacts;
const base=JSON.parse(readFileSync(`${HOME}/../gidisteinberg/monorepo/optimizer/optimizer.config.json`,'utf8'));

const ARMS={
 control:  {enabled:false,params:{}},
 shipped:  {enabled:true,params:{keepLoopHead:1,cutOpaqueChain:true,skipOnErrorTurn:false,protectMutationToolCalls:false,keepDecisionTurns:false}},
 optionA:  {enabled:true,params:{keepLoopHead:1,cutOpaqueChain:true,skipOnErrorTurn:true, protectMutationToolCalls:true, keepDecisionTurns:false}},
 synthesis:{enabled:true,params:{keepLoopHead:1,cutOpaqueChain:true,skipOnErrorTurn:true, protectMutationToolCalls:true, keepDecisionTurns:true}},
 pr2114:   {enabled:true,params:{keepLoopHead:3,cutOpaqueChain:true,skipOnErrorTurn:true, protectMutationToolCalls:true, keepDecisionTurns:true}},
};
const put=async(b)=>{const r=await fetch(`${URL_}/admin/optimizer/settings`,{method:'PUT',
  headers:{'content-type':'application/json',authorization:`Bearer ${ADMIN}`},body:JSON.stringify(b)});
  if(!r.ok) throw new Error(`${r.status} ${await r.text()}`); };
const opt=async(req)=>{const r=await fetch(`${URL_}/v1/optimize`,{method:'POST',
  headers:{'content-type':'application/json'},
  body:JSON.stringify({request:req,endpoint:'/v1/messages',metadata:{tenantId:'bench-'+Math.random().toString(36).slice(2,8)}})});
  if(!r.ok) throw new Error(`${r.status} ${await r.text()}`); return r.json(); };
const tchars=(req)=>(req.messages||[]).reduce((n,m)=>n+(Array.isArray(m.content)?
  m.content.reduce((k,b)=>k+(b.type==='thinking'||b.type==='redacted_thinking'
    ?(b.thinking||'').length+(b.signature||'').length:0),0):0),0);

// Isolate thinking_trim: disable every OTHER strategy so nothing else edits bytes.
const others=base.strategies.filter(s=>s.kind!=='thinking_trim').map(s=>({kind:s.kind,enabled:false}));
const B=tchars(payload);
console.log('arm'.padEnd(11),'kept turns'.padStart(11),'think tok'.padStart(10),'saved%'.padStart(7),'facts'.padStart(9),'verdict'.padStart(9));
for(const [name,cfg] of Object.entries(ARMS)){
  await put({strategies:[...others,{kind:'thinking_trim',...cfg}]});
  // Unique first user turn per arm: identical payloads hit the optimizer's
  // response cache, and every arm after the first silently replays arm 1's
  // answer. That is what made a first pass report 0% saved for every policy.
  const req0=JSON.parse(JSON.stringify(payload));
  req0.messages[0].content=`[${name}] `+req0.messages[0].content;
  const out=await opt(req0);
  const req=out.request;
  const turns=req.messages.filter(m=>m.role==='assistant'&&Array.isArray(m.content));
  const kept=turns.filter(m=>m.content.some(b=>b.type==='thinking')).length;
  const blob=JSON.stringify(req);
  const f=facts.filter(x=>blob.includes(x)).length;
  const pct=Math.round(100*f/facts.length);
  console.log(name.padEnd(11), `${kept}/${turns.length}`.padStart(11),
    String(Math.round(tchars(req)/3.3)).padStart(10),
    (Math.round(100*(B-tchars(req))/B)+'%').padStart(7),
    `${f}/${facts.length} (${pct}%)`.padStart(9),
    (pct>=90?'PASS':pct>=75?'MARGINAL':'FAIL').padStart(9));
}
