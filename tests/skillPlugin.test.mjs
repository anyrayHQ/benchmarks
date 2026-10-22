// The anyray-test skill (ANY-1493) ships from this repo as a Claude Code plugin: marketplace
// anyray-benchmarks, plugin anyray-test, skill skills/anyray-test/SKILL.md. The skill drives the
// kit only through its npm scripts with --json, and states its guardrails as explicit rules.
// Everything here reads committed files; no model call, no kit run. The behaviour the rules
// promise is graded by the plugin eval suite under evals/ (`claude plugin eval`).
//
// The source scans are anchored to shapes, not loose substrings: a kit command is an `npm ...
// run <script>` command line inside a shell fence or an inline code span, parsed into tokens;
// a guardrail is a list item under the `## Guardrails` heading that states a fixed phrase.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MARKETPLACE = join(ROOT, '.claude-plugin', 'marketplace.json');
const PLUGIN = join(ROOT, '.claude-plugin', 'plugin.json');
const SKILL = join(ROOT, 'skills', 'anyray-test', 'SKILL.md');
const EVALS = join(ROOT, 'evals');

// The kit's client-flow commands (ANY-1485 freeze/verify, ANY-1486 plan, ANY-1487 the rest), in
// the order the flow first runs them. `verify` has no fixed place: it re-checks the plan
// before any step that depends on it.
const FLOW_ORDER = ['plan', 'freeze', 'noise', 'run', 'verdict', 'report', 'publish-result'];
// `doctor` (ANY-1516) checks the machine in Preflight; it takes no scenarios dir.
const SETUP_SCRIPTS = ['doctor'];
const KIT_SCRIPTS = [...FLOW_ORDER, 'verify', ...SETUP_SCRIPTS];
const PAID = ['noise', 'run'];

// SKILL.md body text has ${CLAUDE_PLUGIN_ROOT} / ${CLAUDE_PLUGIN_DATA} substituted when the
// skill loads, so a literal one of those names the kit on every Bash call. A shell variable set
// in an earlier call (`$KIT`) is gone by the next one: each Bash call is a fresh shell.
const KIT_PREFIX = /^\$\{CLAUDE_PLUGIN_(?:ROOT|DATA)\}(?:\/[A-Za-z0-9._-]+)*$/;
const SCENARIOS_DIR = 'anyray-test';

const SHELL_FENCES = new Set(['', 'bash', 'sh', 'shell', 'zsh', 'console']);
// A pipe, a list operator or a redirect ends a command's arguments (`2>/dev/null`, `| jq`). A
// whole `<budget>` token is a placeholder the agent fills in, not a redirect.
const CONTROL_TOKEN = /^(?:\||&&|;|&$|\d*>|<(?![^<>\s]+>$))/;
const SPEND_GATE_HEADING = /^#{2,4}[^\n]*\bSpend gate\b/m;
const PREFLIGHT_HEADING = /^#{2,4}[^\n]*\bPreflight\b/m;
const LIST_ITEM = /^ ?(?:[-*+]|\d+[.)])[ \t]+/;

function readJson(path) {
  assert.ok(existsSync(path), `${path.slice(ROOT.length + 1)} is missing`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

function readSkill() {
  assert.ok(existsSync(SKILL), 'skills/anyray-test/SKILL.md is missing');
  return readFileSync(SKILL, 'utf8');
}

/** The `---` YAML block a skill file starts with. */
function frontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  assert.ok(m, 'SKILL.md starts with a --- frontmatter block');
  return yaml.load(m[1]) ?? {};
}

/** Fenced code blocks: { info, body, start, offset, end }; offset = index of the body in `text`. */
function fences(text) {
  const out = [];
  // A fence may be indented (one nested in a list item, as the Preflight bullets nest theirs).
  const re = /^([ \t]*)(`{3,}|~{3,})([^\n]*)\n([\s\S]*?)^[ \t]*\2[ \t]*$/gm;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    out.push({ info: m[3].trim().split(/\s+/)[0].toLowerCase(), body: m[4], start: m.index, offset: m.index + m[1].length + m[2].length + m[3].length + 1, end: m.index + m[0].length });
  }
  return out;
}

/** Shell-ish split: whitespace separates, quotes group and are kept as `quote`. */
function tokens(line) {
  const out = [];
  let i = 0;
  while (i < line.length) {
    while (i < line.length && /\s/.test(line[i])) i++;
    if (i >= line.length) break;
    let value = '';
    let quote = null;
    while (i < line.length && !/\s/.test(line[i])) {
      const c = line[i];
      if (c === '"' || c === "'") {
        if (value === '') quote = c;
        const close = line.indexOf(c, i + 1);
        const stop = close === -1 ? line.length : close;
        value += line.slice(i + 1, stop);
        i = stop + 1;
      } else {
        value += c;
        i++;
      }
    }
    out.push({ value, quote });
  }
  return out;
}

/**
 * One `npm ... run <script> [-- args]` command line -> its parts, or null when the line runs no
 * npm script (`npm ci` is not a script run).
 */
function parseNpmRun(line) {
  const toks = tokens(line.replace(/^\s*\$\s+/, ''));
  const npmAt = toks.findIndex((t) => t.value === 'npm');
  if (npmAt === -1) return null;
  const runAt = toks.findIndex((t, i) => i > npmAt && (t.value === 'run' || t.value === 'run-script'));
  if (runAt === -1) return null;
  let scriptAt = runAt + 1;
  const npmFlags = toks.slice(npmAt + 1, runAt).map((t) => t.value);
  while (scriptAt < toks.length && toks[scriptAt].value.startsWith('-')) npmFlags.push(toks[scriptAt++].value);
  const script = toks[scriptAt]?.value ?? null;
  const rest = toks.slice(scriptAt + 1);
  const cut = rest.findIndex((t) => !t.quote && CONTROL_TOKEN.test(t.value));
  const tail = cut === -1 ? rest : rest.slice(0, cut);
  const sep = tail.findIndex((t) => t.value === '--');
  const prefixAt = toks.findIndex((t, i) => i > npmAt && i < runAt && t.value === '--prefix');
  return {
    line: line.trim(),
    script,
    env: toks.slice(0, npmAt).map((t) => t.value),
    silent: npmFlags.includes('-s') || npmFlags.includes('--silent'),
    prefix: prefixAt === -1 ? null : toks[prefixAt + 1] ?? null,
    beforeSeparator: (sep === -1 ? tail : tail.slice(0, sep)).map((t) => t.value),
    args: sep === -1 ? [] : tail.slice(sep + 1).map((t) => t.value),
  };
}

/**
 * Every npm script run SKILL.md tells the agent to make: each command line of a shell fence
 * (continuations joined) and each inline code span outside fences. `offset` orders them.
 */
function npmRuns(text) {
  const found = [];
  const blocks = fences(text);
  for (const b of blocks) {
    if (!SHELL_FENCES.has(b.info)) continue;
    let at = b.offset;
    const lines = b.body.split('\n');
    for (let i = 0; i < lines.length; i++) {
      let line = lines[i];
      const start = at;
      at += lines[i].length + 1;
      while (/\\\s*$/.test(line) && i + 1 < lines.length) {
        line = line.replace(/\\\s*$/, ' ') + lines[++i];
        at += lines[i].length + 1;
      }
      const run = parseNpmRun(line);
      if (run) found.push({ ...run, offset: start, where: 'fence' });
    }
  }
  const inFence = (i) => blocks.some((b) => i >= b.start && i < b.end);
  const span = /(?<!`)`([^`\n]+)`(?!`)/g;
  for (let m = span.exec(text); m; m = span.exec(text)) {
    if (inFence(m.index)) continue;
    const run = parseNpmRun(m[1]);
    if (run) found.push({ ...run, offset: m.index, where: 'inline' });
  }
  return found.sort((a, b) => a.offset - b.offset);
}

/** Lines of shell fences, for the "never around the npm scripts" check. */
function shellLines(text) {
  return fences(text).filter((b) => SHELL_FENCES.has(b.info)).flatMap((b) => b.body.split('\n'));
}

const norm = (s) => s.replace(/\*/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

/** The `## Guardrails` section's top-level list items (sub-items stay inside), or null without one. */
function guardrailItemsOf(text) {
  const head = /^##[ \t]+Guardrails[ \t]*$/m.exec(text);
  if (!head) return null;
  const after = text.slice(head.index + head[0].length);
  const next = /^##[ \t]/m.exec(after);
  const items = [];
  for (const line of (next ? after.slice(0, next.index) : after).split('\n')) {
    if (LIST_ITEM.test(line)) items.push(line.replace(LIST_ITEM, ''));
    else if (items.length && line.trim() !== '') items[items.length - 1] += `\n${line}`;
  }
  return items;
}

function guardrail(phrase) {
  const items = guardrailItemsOf(readSkill());
  assert.ok(items, 'SKILL.md has a "## Guardrails" section stating its rules');
  const item = items.find((it) => norm(it).includes(norm(phrase)));
  assert.ok(item, `the Guardrails section has no rule stating "${phrase}" (${items.length} rule(s) found)`);
  return item;
}

const offsetOf = (re, text) => re.exec(text)?.index ?? -1;

// --- the command parser judges the shapes it is meant to judge (so the scans below cannot pass
//     vacuously on a parser that finds nothing or reads everything as fine) ---

test('the command parser reads npm script runs from shell fences and inline code, and nothing else', () => {
  const md = [
    '# x',
    '```bash',
    'npm --prefix "${CLAUDE_PLUGIN_ROOT}" run -s plan -- --scenarios-dir anyray-test --budget-usd <budget> --session-cost-usd 0.2 --json',
    'npm ci --prefix "${CLAUDE_PLUGIN_ROOT}"',
    'npm --prefix "${CLAUDE_PLUGIN_ROOT}" run -s freeze -- \\',
    '  --scenarios-dir anyray-test --json 2>/dev/null | cat',
    'npm --prefix "${CLAUDE_PLUGIN_ROOT}" run verdict --json',
    '```',
    '```yaml',
    'check: npm run lint',
    '```',
    '- A nested step:',
    '  ```bash',
    '  npm --prefix "${CLAUDE_PLUGIN_ROOT}" run -s doctor -- --json',
    '  ```',
    'Then run `npm --prefix "${CLAUDE_PLUGIN_ROOT}" run -s noise -- --scenarios-dir anyray-test --json`.',
    '',
  ].join('\n');
  const runs = npmRuns(md);
  assert.deepEqual(runs.map((r) => [r.where, r.script]), [['fence', 'plan'], ['fence', 'freeze'], ['fence', 'verdict'], ['fence', 'doctor'], ['inline', 'noise']]);
  const [plan, freeze, verdict, doctor, noise] = runs;
  assert.deepEqual(doctor.args, ['--json'], 'a fence indented under a list item is still a fence');
  assert.equal(plan.silent, true);
  assert.deepEqual(plan.prefix, { value: '${CLAUDE_PLUGIN_ROOT}', quote: '"' });
  assert.deepEqual(plan.args, ['--scenarios-dir', 'anyray-test', '--budget-usd', '<budget>', '--session-cost-usd', '0.2', '--json'], 'a <placeholder> is an argument');
  assert.deepEqual(freeze.args, ['--scenarios-dir', 'anyray-test', '--json'], 'a continuation joins; a pipe or redirect ends the args');
  assert.equal(verdict.silent, false, 'no -s');
  assert.deepEqual(verdict.args, [], 'no -- separator: npm itself would take --json');
  assert.deepEqual(verdict.beforeSeparator, ['--json']);
  assert.equal(noise.silent, true);
  assert.deepEqual(
    guardrailItemsOf('## Guardrails\n\n- One rule,\n  still the same rule.\n  - a sub-point of it\n2. Two `noise`\n\n## Next\n- not a rule\n'),
    ['One rule,\n  still the same rule.\n  - a sub-point of it', 'Two `noise`'],
  );
  assert.equal(guardrailItemsOf('## Guardrail notes\n- x\n'), null, 'only the Guardrails heading itself');
});

// --- the plugin and marketplace manifests ---

test('the marketplace is anyray-benchmarks and lists the anyray-test plugin at the kit root', () => {
  const market = readJson(MARKETPLACE);
  assert.equal(market.name, 'anyray-benchmarks');
  assert.ok(typeof market.owner?.name === 'string' && market.owner.name.trim(), 'the marketplace names its owner');
  assert.ok(Array.isArray(market.plugins), 'plugins is a list');
  const entries = market.plugins.filter((p) => p?.name === 'anyray-test');
  assert.equal(entries.length, 1, 'exactly one anyray-test entry');
  const [entry] = entries;
  assert.equal(typeof entry.source, 'string', 'the plugin is sourced from this repo by a relative path');
  // The skill runs the kit from the plugin root, so the plugin root IS the kit checkout.
  assert.equal(resolve(ROOT, entry.source), resolve(ROOT), 'the plugin source is the repo root (the kit)');
});

test('plugin.json names anyray-test with a version the marketplace entry agrees with', () => {
  const plugin = readJson(PLUGIN);
  assert.equal(plugin.name, 'anyray-test');
  assert.match(String(plugin.version), /^\d+\.\d+\.\d+$/, 'a semver version');
  assert.ok(typeof plugin.description === 'string' && plugin.description.trim(), 'a description');
  const entry = readJson(MARKETPLACE).plugins?.find((p) => p?.name === 'anyray-test');
  if (entry?.version !== undefined) assert.equal(entry.version, plugin.version, '`claude plugin tag` refuses a marketplace entry that disagrees');
  if (plugin.skills !== undefined) {
    const dirs = [plugin.skills].flat().map((s) => resolve(ROOT, s));
    assert.ok(dirs.some((d) => d === join(ROOT, 'skills') || d === join(ROOT, 'skills', 'anyray-test')), 'a skills override still covers skills/anyray-test');
  }
});

test('SKILL.md frontmatter: name anyray-test, and a description that triggers on testing Anyray savings on your own scenarios and on the kit\'s verdict', () => {
  const meta = frontmatter(readSkill());
  assert.equal(meta.name, 'anyray-test');
  const d = meta.description;
  assert.ok(typeof d === 'string' && d.trim(), 'a description');
  assert.ok(d.length <= 1024, 'a skill description is at most 1024 characters');
  assert.match(d, /\bAnyray\b/, 'names Anyray');
  assert.match(d, /\b(?:test|tests|testing|evaluat\w*|measur\w*)\b/i, 'is about testing or evaluating');
  assert.match(d, /\b(?:sav\w*|cost\w*|spend\w*)\b/i, 'is about savings or cost');
  assert.match(d, /\bown\b/i, 'on the user\'s own test or scenarios');
  assert.match(d, /\b(?:verdict|results?|report)\b/i, 'also when the user brings back the kit\'s verdict or report (the verdict-verbatim eval)');
});

// --- the kit, only through its npm scripts, always --json ---

test('every kit command SKILL.md runs is a kit npm script, run silently from the kit root with --json after --', () => {
  const runs = npmRuns(readSkill());
  assert.ok(runs.length >= KIT_SCRIPTS.length, `found ${runs.length} npm script run(s); the flow needs at least one per kit command`);
  const pkg = readJson(join(ROOT, 'package.json'));
  for (const r of runs) {
    const at = `\`${r.line}\``;
    assert.ok(KIT_SCRIPTS.includes(r.script), `${at}: ${r.script} is not a kit command (${KIT_SCRIPTS.join(', ')})`);
    assert.equal(pkg.scripts?.[r.script], `node tools/kit.mjs ${r.script}`, `${at}: package.json has no kit script "${r.script}"`);
    assert.ok(r.prefix, `${at}: runs from the kit with --prefix`);
    assert.match(r.prefix.value, KIT_PREFIX, `${at}: the kit is \${CLAUDE_PLUGIN_ROOT} or under \${CLAUDE_PLUGIN_DATA}, never a shell variable from an earlier call`);
    assert.equal(r.prefix.quote, '"', `${at}: the kit path is double-quoted`);
    assert.equal(r.silent, true, `${at}: -s, or npm's banner lands on stdout ahead of the JSON`);
    assert.ok(r.args.includes('--json'), `${at}: --json after the -- separator (before it, npm takes --json for itself)`);
    if (SETUP_SCRIPTS.includes(r.script)) {
      assert.ok(!r.args.includes('--scenarios-dir'), `${at}: ${r.script} checks the machine, not a plan`);
      continue;
    }
    const dir = r.args.indexOf('--scenarios-dir');
    assert.ok(dir !== -1, `${at}: --scenarios-dir`);
    assert.match(r.args[dir + 1] ?? '', /^(?:\.\/)?anyray-test\/?$/, `${at}: the scenarios dir is ${SCENARIOS_DIR} (relative to where npm runs)`);
  }
  assert.equal(new Set(runs.map((r) => r.prefix?.value)).size, 1, 'one kit location for every command');
  for (const script of KIT_SCRIPTS) assert.ok(runs.some((r) => r.script === script), `the flow never runs ${script}`);
});

test('SKILL.md never drives the kit around its npm scripts', () => {
  const offenders = shellLines(readSkill()).filter((l) => /\b(?:tools\/kit|run_agent|report_agent)\.mjs\b/.test(l));
  assert.deepEqual(offenders, [], 'node tools/kit.mjs / run_agent.mjs directly skips the npm scripts the checks above pin');
});

// ANY-1516 changes this contract on purpose (SPEC K1/K2): the plan asks for the budget only, the
// noise rounds measure the session cost, and noise and run carry the budget their runtime guard
// stops at. Before, plan carried --session-cost-usd from a cost the user had to guess.
test('plan carries the budget and never a session cost, noise and run carry the budget, report is --redact, and no command line carries a credential', () => {
  const runs = npmRuns(readSkill());
  const of = (s) => runs.filter((r) => r.script === s);
  assert.ok(of('plan').length > 0 && of('report').length > 0, 'the flow runs plan and report');
  for (const r of of('plan')) {
    assert.ok(r.args.includes('--budget-usd'), `\`${r.line}\`: plan takes the budget`);
    assert.ok(!r.args.includes('--session-cost-usd'), `\`${r.line}\`: plan asks for the budget only; noise measures the session cost`);
  }
  for (const s of PAID) {
    assert.ok(of(s).length > 0, `the flow runs ${s}`);
    for (const r of of(s)) assert.ok(r.args.includes('--budget-usd'), `\`${r.line}\`: ${s} carries the budget its guard stops at`);
  }
  for (const r of of('report')) assert.ok(r.args.includes('--redact'), `\`${r.line}\`: --redact is the only report mode`);
  for (const r of runs) {
    assert.ok(!r.env.some((e) => /^[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET)=/.test(e)), `\`${r.line}\`: a credential belongs in the environment, not on the command line`);
    assert.ok(!r.args.some((a) => /^--(?:admin-key|token|key|api-key)(?:=|$)/.test(a)), `\`${r.line}\`: no key flag (the kit refuses one, and the transcript keeps it)`);
  }
});

test('the flow runs plan, freeze, the spend gate, then noise, run, verdict, report, publish-result, in that order', () => {
  const text = readSkill();
  const runs = npmRuns(text);
  const first = (s) => runs.find((r) => r.script === s)?.offset ?? -1;
  for (const s of FLOW_ORDER) assert.ok(first(s) !== -1, `the flow never runs ${s}`);
  const gate = offsetOf(SPEND_GATE_HEADING, text);
  assert.ok(gate !== -1, 'a "Spend gate" step heading');
  assert.ok(first('plan') < first('freeze'), 'plan before freeze');
  assert.ok(first('freeze') < gate, 'the plan is frozen before the spend gate');
  for (const s of PAID) assert.ok(gate < first(s), `${s} is paid: no ${s} command appears before the spend gate`);
  for (let i = 1; i < FLOW_ORDER.length; i++) {
    assert.ok(first(FLOW_ORDER[i - 1]) < first(FLOW_ORDER[i]), `${FLOW_ORDER[i - 1]} before ${FLOW_ORDER[i]}`);
  }
  const preflight = offsetOf(PREFLIGHT_HEADING, text);
  assert.ok(preflight !== -1 && preflight < first('plan'), 'a Preflight step heading before the first kit command');
});

// --- the guardrails, each an explicit rule (phrases in CONTRACT.md) ---

test('guardrail: the client\'s scenario is recorded verbatim as source: client and never dropped or rewritten', () => {
  const item = guardrail('never dropped or rewritten');
  assert.ok(item.includes('source: client'), 'the rule names `source: client`');
});

test('guardrail: no paid command (noise, run) before an explicit Start, and Start is never a default', () => {
  const item = guardrail('no paid command before an explicit Start');
  for (const t of PAID) assert.ok(item.includes(`\`${t}\``), `the rule names \`${t}\``);
  assert.ok(norm(item).includes('never a default'), 'the rule says Start is never a default');
});

test('guardrail: verdict words are copied from the kit and never reworded or rounded', () => {
  const item = guardrail('never reworded or rounded');
  assert.ok(norm(item).includes('verdict'), 'the rule is about the verdict words');
});

test('guardrail: nothing leaves the machine except publish-result', () => {
  const item = guardrail('nothing leaves the machine except');
  assert.ok(item.includes('`publish-result`'), 'the rule names `publish-result`');
});

test('guardrail: after freeze, any change is a new plan', () => {
  const item = guardrail('any change is a new plan');
  assert.ok(norm(item).includes('freeze'), 'the rule ties it to the freeze');
});

test('guardrail: the skill\'s own session is not an arm', () => {
  const item = guardrail('is not an arm');
  assert.ok(norm(item).includes('session'), 'the rule says which session');
});

test('guardrail: never retry a losing pair', () => {
  guardrail('never retry a losing pair');
});

// --- the flow's other fixed points ---

test('questions go through AskUserQuestion with a (Recommended) default; scenarios live in anyray-test/ as client-<n> and proposed-<n>; background runs resume, never restart', () => {
  const text = readSkill();
  assert.ok(text.includes('AskUserQuestion'), 'asks through AskUserQuestion');
  assert.ok(text.includes('(Recommended)'), 'marks the clearly best option (Recommended)');
  assert.ok(text.includes('anyray-test/client-<n>/scenario.yaml'), 'client scenarios are anyray-test/client-<n>/scenario.yaml');
  assert.ok(text.includes('proposed-<n>'), 'proposed scenarios are proposed-<n>');
  assert.ok(text.includes('`anyray-connect`'), 'preflight checks `anyray-connect`');
  assert.ok(norm(text).includes('never restart'), 'a background run resumes, never restarts');
});

// --- the eval suite (claude plugin eval) the guardrails are graded by ---

test('the eval suite covers the client test kept, no spend before Start, verdict verbatim, and one should-not-fire case', () => {
  assert.ok(existsSync(EVALS), 'evals/ is missing');
  const cases = new Map();
  for (const name of readdirSync(EVALS)) {
    const file = join(EVALS, name, 'case.yaml');
    if (!statSync(join(EVALS, name)).isDirectory() || !existsSync(file)) continue;
    const c = yaml.load(readFileSync(file, 'utf8'));
    cases.set(c.name, c);
  }
  for (const name of ['client-test-kept', 'no-spend-before-start', 'verdict-verbatim', 'plain-coding-task-no-fire']) {
    const c = cases.get(name);
    assert.ok(c, `evals/ has no case named ${name}`);
    assert.equal(c.schema_version, '1.0', `${name}: schema_version`);
    assert.ok(Number.isInteger(c.runs) && c.runs >= 3, `${name}: at least 3 runs`);
    assert.ok(c.graders.some((g) => g.type !== 'tool_used'), `${name}: an outcome grader, not only tool_used`);
  }
  const noFire = cases.get('plain-coding-task-no-fire').graders.find((g) => g.type === 'tool_used' && g.tool === 'Skill');
  assert.ok(noFire && noFire.max === 0 && noFire.arm === 'both', 'the should-not-fire case scores a Skill call (arm: both, max 0)');
});

// Claude Code's auto-updater re-points the `claude` symlink. On the first live run (2026-10-22)
// it moved 2.1.307 to 2.1.308 minutes after freeze, and noise refused the plan's pin. The real
// versioned file stays put, so preflight resolves it once and every command reuses it.
test('preflight pins Claude Code by its resolved real path, not the auto-updated symlink', () => {
  const text = readSkill();
  const start = text.indexOf('## Preflight');
  const section = text.slice(start, text.indexOf('\n## ', start + 1));
  assert.ok(start !== -1, 'SKILL.md has a Preflight section');
  assert.ok(/realpath/.test(section), 'preflight resolves the Claude Code binary with realpath');
  assert.ok(/auto-?update/i.test(section), 'preflight says why: the auto-updater moves the symlink');
});

// --- ANY-1516: one test key from Connect, a doctor, and no admin token in the client flow ---

/** Inline code spans outside fences, with their offsets. */
function inlineSpans(text) {
  const blocks = fences(text);
  const out = [];
  const span = /(?<!`)`([^`\n]+)`(?!`)/g;
  for (let m = span.exec(text); m; m = span.exec(text)) {
    if (!blocks.some((b) => m.index >= b.start && m.index < b.end)) out.push({ line: m[1], offset: m.index, where: 'inline' });
  }
  return out;
}

/** Each line of a shell fence, with its offset in `text`. */
function shellLinesAt(text) {
  const out = [];
  for (const b of fences(text)) {
    if (!SHELL_FENCES.has(b.info)) continue;
    let at = b.offset;
    for (const line of b.body.split('\n')) {
      out.push({ line, offset: at, where: 'fence' });
      at += line.length + 1;
    }
  }
  return out;
}

/** Every `anyray-connect test-key ...` command SKILL.md tells the agent to run: { line, offset, args }. */
function connectTestKeyRuns(text) {
  const found = [];
  for (const { line, offset, where } of [...shellLinesAt(text), ...inlineSpans(text)]) {
    const toks = tokens(line.replace(/^\s*\$\s+/, ''));
    const at = toks.findIndex((t) => /(?:^|\/)anyray-connect\}?$/.test(t.value));
    if (at === -1 || toks[at + 1]?.value !== 'test-key') continue;
    const rest = toks.slice(at + 2);
    const cut = rest.findIndex((t) => !t.quote && CONTROL_TOKEN.test(t.value));
    found.push({ line: line.trim(), offset, where, args: (cut === -1 ? rest : rest.slice(0, cut)).map((t) => t.value) });
  }
  return found.sort((a, b) => a.offset - b.offset);
}

test('preflight mints the test key with `anyray-connect test-key --json` when none exists, then runs the kit doctor --json and maps each failing code to its fix, before the plan', () => {
  // The finder judges the shapes it is meant to (so the scan below cannot pass vacuously).
  const sample = [
    '```bash',
    '"${ANYRAY_CONNECT_BIN:-$HOME/.anyray/bin/anyray-connect}" test-key --json',
    '~/.anyray/bin/anyray-connect status --json',
    '```',
    'Run `anyray-connect test-key --json 2>/dev/null` first.',
    '',
  ].join('\n');
  assert.deepEqual(connectTestKeyRuns(sample).map((r) => [r.where, r.args]), [['fence', ['--json']], ['inline', ['--json']]]);

  const text = readSkill();
  const start = offsetOf(PREFLIGHT_HEADING, text);
  assert.ok(start !== -1, 'a Preflight step heading');
  const end = text.indexOf('\n## ', start + 1);
  const inPreflight = (r) => r.offset > start && (end === -1 || r.offset < end);
  const section = text.slice(start, end === -1 ? text.length : end);

  const mint = connectTestKeyRuns(text).filter(inPreflight);
  assert.ok(mint.length > 0, 'preflight runs `anyray-connect test-key`');
  for (const r of mint) {
    assert.ok(r.args.includes('--json'), `\`${r.line}\`: --json (connect then prints the path and expiry, never the key)`);
    assert.ok(!r.args.some((a) => /^--(?:key|token|api-key|admin-key)(?:=|$)/.test(a)), `\`${r.line}\`: no key on the command line`);
  }
  assert.match(section, /\b(?:no|without|missing|expired)\b[^.\n]{0,60}\btest key\b|\btest key\b[^.\n]{0,60}\b(?:missing|absent|expired|exists?)\b/i,
    'preflight says when to mint one: when no test key exists (or it expired)');

  const runs = npmRuns(text);
  const doctor = runs.filter((r) => r.script === 'doctor');
  assert.ok(doctor.some(inPreflight), 'preflight runs the kit doctor through its npm script');
  const plan = runs.find((r) => r.script === 'plan');
  assert.ok(plan, 'the flow runs plan');
  assert.ok(mint[0].offset < doctor[0].offset, 'the test key is minted before the doctor checks it');
  assert.ok(doctor[0].offset < plan.offset, 'the doctor passes before the first plan');
  assert.ok(/\bcode\b/i.test(section) && /\bfix\b/i.test(section), 'preflight maps each failing check\'s code to its fix');

  const reads = [...shellLinesAt(text), ...inlineSpans(text)].filter(({ line }) => /test-kit\.env/.test(line) && /(?:^|[\s;&|(])(?:cat|source|\.|head|tail|less|more|grep|sed|awk|bat)\s/.test(line));
  assert.deepEqual(reads.map((r) => r.line), [], 'the test key file is never read into the transcript: the kit reads it itself');
});

test('the client flow needs no admin token: SKILL.md names no admin token variable and no /admin/ route', () => {
  const text = readSkill();
  for (const name of ['ANYRAY_ADMIN_KEY', 'ANYRAY_TRACE_KEY', 'ANYRAY_TRACE_TOKEN']) assert.ok(!text.includes(name), `SKILL.md asks for ${name}`);
  assert.ok(!text.includes('/admin/'), 'SKILL.md reaches an /admin/ route');
});
