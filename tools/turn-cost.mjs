// Turn cost of thinking-retention policies — the live ablation.
//
// The question no replay can answer: given the same task, does removing the
// model's own prior reasoning make it take MORE TURNS? A recorded transcript's
// turns already happened under one policy, so the counterfactual only exists in
// a live run.
//
// Routes through the Anyray gateway with `x-anyray-optimize: off`, so the
// deployment's own optimizer never touches the bytes; each arm's policy is
// applied here instead. Arms are interleaved and shuffled per run so model
// drift and task drift hit every arm alike.
//
// Auth: the same passthrough OAuth the rest of the suite uses (lib/auth.mjs).
import { resolveAuth, authHeaders, CLAUDE_CODE_SYSTEM } from '../lib/auth.mjs';

const GATEWAY = process.env.ANYRAY_GATEWAY_URL || 'https://gateway.anyray.ai';
const MODEL = process.env.ANYRAY_LIVE_MODEL || 'claude-sonnet-4-6';
const RUNS = Number(process.env.RUNS || 3);
const MAX_TURNS = Number(process.env.MAX_TURNS || 40);
const auth = resolveAuth();

const TH = new Set(['thinking', 'redacted_thinking']);
const MUT = new Set(['edit_file', 'write_file', 'create_file', 'apply_patch',
  'update_file', 'replace_file', 'str_replace_editor']);

const isRealUser = (m) => m.role === 'user' && (typeof m.content === 'string' ||
  (Array.isArray(m.content) && m.content.some((b) => b.type !== 'tool_result')));
const hasTh = (m) => Array.isArray(m.content) && m.content.some((b) => TH.has(b.type));
const emitsTool = (m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_use');
const mutates = (m) => Array.isArray(m.content) && m.content.some((b) =>
  b.type === 'tool_use' && MUT.has(String(b.name).toLowerCase()));
const priorError = (ms, i) => {
  for (let j = i - 1; j >= 0; j--) {
    const p = ms[j];
    if (p.role === 'assistant') return false;
    if (isRealUser(p)) return false;
    if (Array.isArray(p.content) && p.content.some((b) => b.is_error === true)) return true;
  }
  return false;
};

// Each arm is first-sight: own bytes plus strictly-prior prefix, never lookahead.
function applyPolicy(messages, arm) {
  if (arm === 'control') return messages;
  const head = arm === 'pr2114' ? 3 : 1;
  const out = []; let ord = 0, cut = false, drops = 0;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (isRealUser(m)) { ord = 0; cut = false; drops = 0; out.push(m); continue; }
    if (m.role !== 'assistant' || !hasTh(m)) { out.push(m); continue; }
    ord++;
    let keep = false;
    const err = priorError(messages, i), mut = mutates(m), noTool = !emitsTool(m);
    if (ord <= head) keep = true;
    else if (arm !== 'shipped' && (err || mut)) keep = true;                 // A, synthesis, 2114
    else if ((arm === 'synthesis' || arm === 'pr2114') && noTool) keep = true;
    else if (arm === 'pr2114' && drops >= 1) keep = true;                    // one drop per loop
    else if (!cut) { cut = true; drops++; }
    if (keep) { out.push(m); continue; }
    const stripped = m.content.filter((b) => !TH.has(b.type));
    out.push(stripped.length ? { ...m, content: stripped } : m);
  }
  return out;
}

// ---- the task: find the flaky file. Conclusions are formed by the model and
// are NOT written into any tool output, so losing reasoning forces re-derivation.
const FILES = ['tokenStore.ts','sessionGuard.ts','replayCache.ts','clockSkew.ts','renewLease.ts','keyRotation.ts'];
const CULPRIT = 'replayCache.ts';
const body = (n) => [`// src/auth/${n}`, `// integration test: tests/auth/${n.replace('.ts','.test.ts')}`,
  ...Array.from({length:7},(_,i)=>`  const step${i} = resolve(ctx.session, ${i+2});`),
  n===CULPRIT ? '  const seen = new Map(); // module-scope, per-process' : '  const seen = sharedStore.get(ctx);',
  '  return finalize(ctx);'].join('\n');

const TOOLS = [
  { name:'read_file', description:'Read one source file under src/auth/.',
    input_schema:{type:'object',properties:{path:{type:'string'}},required:['path']} },
  { name:'run_tests', description:'Run the auth suite. Reports flake status.',
    input_schema:{type:'object',properties:{},additionalProperties:false} },
  { name:'submit_answer', description:'Submit the file that causes the flake and the fix.',
    input_schema:{type:'object',properties:{file:{type:'string'},fix:{type:'string'}},required:['file','fix']} },
];
// TASK DESIGN — two failure modes had to be designed out, and the second is the
// subtle one.
//
// (1) Batching. Left free, the model reads all six files in ONE turn, so there
//     is no multi-turn reasoning chain to lose. Hence one file per turn.
//
// (2) Prescribing the answer. A first version also said "after you have read all
//     six, run the tests, then submit" -- which fixes the turn count at 6+1+1=8
//     by instruction. It duly returned 8.0 turns, sd 0.0, on all 15 runs across
//     all five arms: a perfect null that measured the prompt, not the policy.
//     The model must decide FOR ITSELF when it has seen enough.
//
// What makes turn count sensitive to retention: the culprit is identified by
// comparing a detail ACROSS files, so the verdict lives in accumulated judgement
// rather than in any single tool result. Tool results are never trimmed, so an
// agent that has lost its reasoning can always recover -- but only by spending
// turns re-reading. That re-read is the measurement.
const TASK = `The auth suite is flaky. Exactly one file under src/auth/ is responsible.

Candidates: ${FILES.join(', ')}

How to work:
- Read ONE file per turn. Never call read_file twice in the same turn.
- The culprit is the ONLY file that keeps its state per-process instead of in the
  shared store. Every other file uses the shared store. You must compare what you
  see against the files you have already read.
- Re-read any file whenever you are not certain what it showed.
- Call run_tests whenever you want to check your current belief.
- Call submit_answer as soon as you are confident, and not before.

Do not guess. Being wrong is worse than spending another turn.`;

async function call(messages) {
  const res = await fetch(`${GATEWAY}/v1/messages`, { method:'POST',
    headers:{ 'content-type':'application/json', ...authHeaders(auth), 'x-anyray-optimize':'off' },
    body: JSON.stringify({ model: MODEL, max_tokens: 3000, tools: TOOLS,
      thinking:{ type:'enabled', budget_tokens:1600 },
      // The OAuth credential is bound to Claude Code's request signature: the
      // identity must be the FIRST system block, verbatim and alone. Appending
      // to it as one string breaks the signature and the provider answers 429
      // rate_limit — a misleading error that is really an auth rejection. The
      // array form keeps the identity intact and carries the task separately.
      system: [{ type:'text', text: CLAUDE_CODE_SYSTEM },
               { type:'text', text:'You are debugging a flaky test suite.' }],
      messages }) });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0,200)}`);
  return res.json();
}

async function oneRun(arm) {
  const messages = [{ role:'user', content: TASK }];
  const reads = []; let turns = 0, answered = null, inTok = 0, outTok = 0;
  while (turns < MAX_TURNS) {
    let body_;
    try { body_ = await call(applyPolicy(messages, arm)); }
    catch (e) { return { arm, error: String(e.message).slice(0,120), turns }; }
    turns++;
    inTok += body_.usage?.input_tokens ?? 0; outTok += body_.usage?.output_tokens ?? 0;
    messages.push({ role:'assistant', content: body_.content });
    const uses = (body_.content||[]).filter((b)=>b.type==='tool_use');
    if (!uses.length) {
      messages.push({ role:'user', content:'Continue. Call submit_answer when sure.' });
      continue;
    }
    const results = [];
    for (const u of uses) {
      if (u.name === 'submit_answer') { answered = u.input; break; }
      if (u.name === 'read_file') {
        const f = String(u.input?.path||'').split('/').pop();
        reads.push(f);
        results.push({ type:'tool_result', tool_use_id:u.id,
          content: FILES.includes(f) ? body(f) : `no such file: ${u.input?.path}`,
          ...(FILES.includes(f)?{}:{is_error:true}) });
      } else if (u.name === 'run_tests') {
        results.push({ type:'tool_result', tool_use_id:u.id, content:'FLAKE: 3 of 20 runs failed', is_error:true });
      }
    }
    if (answered) break;
    messages.push({ role:'user', content: results });
  }
  const correct = answered && String(answered.file||'').includes(CULPRIT);
  return { arm, turns, correct: !!correct, reads: reads.length,
    rereads: reads.length - new Set(reads).size, inTok, outTok, answered: !!answered };
}

const ARMS = (process.env.ARMS || 'control,shipped,optionA,synthesis,pr2114').split(',');
const rows = [];
for (let r = 0; r < RUNS; r++) {
  const order = [...ARMS].sort(() => Math.random() - 0.5);   // interleave
  for (const arm of order) {
    const res = await oneRun(arm); res.run = r; rows.push(res);
    console.log(`  run ${r+1}/${RUNS} ${arm.padEnd(10)} ` +
      (res.error ? `ERROR ${res.error}` :
       `${String(res.turns).padStart(2)} turns  reads ${res.reads} (${res.rereads} re-read)  ` +
       `${res.correct?'correct':res.answered?'WRONG':'no answer'}`));
  }
}
console.log(`\n${'arm'.padEnd(11)}${'n'.padStart(3)}${'turns'.padStart(8)}${'sd'.padStart(7)}${'re-reads'.padStart(10)}${'correct'.padStart(9)}`);
const mean = (a)=>a.reduce((x,y)=>x+y,0)/a.length;
let base = null;
for (const arm of ARMS) {
  const rs = rows.filter((x)=>x.arm===arm && !x.error);
  if (!rs.length) { console.log(`${arm.padEnd(11)}  0   (all runs errored)`); continue; }
  const t = rs.map((x)=>x.turns), m = mean(t);
  const sd = t.length>1 ? Math.sqrt(mean(t.map((x)=>(x-m)**2))*t.length/(t.length-1)) : 0;
  if (base === null) base = m;
  console.log(`${arm.padEnd(11)}${String(rs.length).padStart(3)}${m.toFixed(1).padStart(8)}${sd.toFixed(1).padStart(7)}` +
    `${mean(rs.map((x)=>x.rereads)).toFixed(1).padStart(10)}${(rs.filter((x)=>x.correct).length+'/'+rs.length).padStart(9)}` +
    `  ${base? ((m-base)/base*100).toFixed(0)+'%':''}`);
}
console.log(JSON.stringify({ model: MODEL, runs: RUNS, rows }, null, 1).slice(0, 0));
