// --hook-posture / --hook-posture-b: pin any of connect's team-policy hook switches
// (fleetHookPolicy.<name>) in an arm's private profile for one session. --read-trim and
// --read-trim-b are the readTrim=on spellings of the same path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { armConfig, describeSetup, hookPostureAtEnd, postureDriftMessage } from '../lib/agentRun.mjs';
import { armLabel, armsFor, armSetups, controlArgs, parseArgs, requestRecord, slotOptions } from '../run_agent.mjs';

const SIX = 'cache_optimizer,relevance_filter,code_graph,observation_mask,content_census,cache_lint';
const gw = (...more) => ({ ...parseArgs(['--scenario', 's', '--compare', 'gateway', '--kinds', SIX, ...more]), extraHeaders: [] });
const one = (...more) => ({ ...parseArgs(['--scenario', 's', '--kinds', 'observation_mask', ...more]), extraHeaders: [] });
const arms = armsFor('gateway');

// ---- parsing and validation ---------------------------------------------------------

test('--hook-posture-b and --hook-posture: repeatable name=on|off, off by default', () => {
  assert.deepEqual(gw().hookPostureB, {});
  assert.deepEqual(gw().hookPosture, {});
  assert.deepEqual(gw('--hook-posture-b', 'logRead=on').hookPostureB, { logRead: 'on' });
  assert.deepEqual(gw('--hook-posture-b', 'logRead=on', '--hook-posture-b', 'digest=off').hookPostureB, { logRead: 'on', digest: 'off' });
  assert.deepEqual(gw('--hook-posture', 'logRead=on').hookPosture, { logRead: 'on' });
  assert.deepEqual(gw('--hook-posture', 'logRead=on').hookPostureB, {});
  // The same value twice is one switch, not a conflict.
  assert.deepEqual(gw('--hook-posture-b', 'logRead=on', '--hook-posture-b', 'logRead=on').hookPostureB, { logRead: 'on' });
});

test('--hook-posture(-b): the name must be a plain identifier and the value on or off', () => {
  for (const bad of ['logRead', 'logRead=', '=on', 'logRead=yes', 'logRead=ON', 'logRead=true', 'log-read=on', 'log.read=on', '1logRead=on', '__proto__=on', 'logRead=on,digest=off', ' logRead=on']) {
    assert.throws(() => gw('--hook-posture-b', bad), /--hook-posture-b takes name=on\|off/, bad);
    assert.throws(() => gw('--hook-posture', bad), /--hook-posture takes name=on\|off/, bad);
  }
  assert.throws(() => gw('--hook-posture-b'), /--hook-posture-b takes name=on\|off/);
});

test('--hook-posture-b needs --compare gateway; --hook-posture needs a gateway arm', () => {
  assert.throws(() => one('--hook-posture-b', 'logRead=on'), /--hook-posture-b needs --compare gateway/);
  assert.throws(() => parseArgs(['--scenario', 's', '--compare', 'control', '--hook-posture', 'logRead=on']), /--hook-posture needs --compare anyray or gateway/);
  assert.deepEqual(one('--hook-posture', 'logRead=on').hookPosture, { logRead: 'on' });
});

test('a switch set both ways for the same arm is refused', () => {
  assert.throws(() => gw('--hook-posture-b', 'logRead=on', '--hook-posture-b', 'logRead=off'), /logRead is set both on and off for arm B/);
  assert.throws(() => gw('--hook-posture', 'logRead=on', '--hook-posture', 'logRead=off'), /logRead is set both on and off for every Anyray arm/);
  // Across the two flags: --hook-posture reaches B too.
  assert.throws(() => gw('--hook-posture', 'logRead=off', '--hook-posture-b', 'logRead=on'), /logRead is set both on and off for arm B/);
  // The aliases count as readTrim=on.
  assert.throws(() => gw('--read-trim-b', '--hook-posture-b', 'readTrim=off'), /readTrim is set both on and off for arm B/);
  assert.throws(() => gw('--read-trim', '--hook-posture', 'readTrim=off'), /readTrim is set both on and off for every Anyray arm/);
  assert.throws(() => gw('--read-trim', '--hook-posture-b', 'readTrim=off'), /readTrim is set both on and off for arm B/);
  // The same value on both flags is no B-only treatment, as with --read-trim + --read-trim-b.
  assert.throws(() => gw('--hook-posture', 'logRead=on', '--hook-posture-b', 'logRead=on'), /--hook-posture already sets logRead=on on both arms/);
  // Different switches combine.
  assert.deepEqual(gw('--hook-posture', 'digest=off', '--hook-posture-b', 'logRead=on').hookPostureB, { logRead: 'on' });
});

test('--hook-posture(-b) is refused where no connect hooks run', () => {
  assert.throws(() => gw('--hook-posture-b', 'logRead=on', '--integration-level', 'gateway'), /--hook-posture needs connect's hooks: --integration-level gateway installs none/);
  assert.throws(() => one('--hook-posture', 'logRead=on', '--integration-level', 'gateway'), /--hook-posture needs connect's hooks/);
  assert.deepEqual(gw('--hook-posture-b', 'logRead=on', '--integration-level', 'gateway_hooks').hookPostureB, { logRead: 'on' });
  assert.throws(() => parseArgs(['--scenario', 's', '--bare', '--hook-posture', 'logRead=on']), /--bare runs without anyray-connect, whose hooks --hook-posture sets/);
  assert.throws(() => parseArgs(['--scenario', 's', '--compare', 'gateway', '--bare', '--hook-posture-b', 'logRead=on']), /--bare runs without anyray-connect, whose hooks --hook-posture sets/);
  assert.throws(() => parseArgs(['--scenario', 'sdk-docs', '--provider', 'bedrock', '--kinds', 'observation_mask', '--hook-posture', 'logRead=on']), /sdk-docs supports/);
});

// ---- the aliases ------------------------------------------------------------------------

test('--read-trim-b is --hook-posture-b readTrim=on, and --read-trim is --hook-posture readTrim=on', () => {
  const alias = gw('--read-trim-b');
  const spelled = gw('--hook-posture-b', 'readTrim=on');
  assert.deepEqual(spelled, alias);
  assert.equal(spelled.readTrimB, true);
  assert.deepEqual(alias.hookPostureB, { readTrim: 'on' });
  for (const slot of ['a', 'b']) assert.deepEqual(slotOptions(spelled, arms, slot), slotOptions(alias, arms, slot));
  assert.deepEqual(requestRecord(spelled), requestRecord(alias));
  assert.equal(armLabel(spelled, arms, 'b'), 'anyray + read-trim');
  // The legacy checks hold for either spelling.
  assert.throws(() => gw('--hook-posture-b', 'readTrim=on', '--integration-level', 'gateway_hooks'), /--read-trim-b needs --integration-level gateway_hooks_mcp/);
  assert.deepEqual(one('--hook-posture', 'readTrim=on'), one('--read-trim'));
  assert.equal(one('--hook-posture', 'readTrim=on').readTrim, true);
});

test('--read-trim and a second switch: one profile write carries both', () => withCfg((dir) => {
  const c = armConfig({ arm: 'anyray', gatewayUrl: GW, runTag: TAG, readTrim: true, hookPosture: { logRead: 'on' }, cfgDir: dir, deps: deps(GW) });
  assert.deepEqual(profileAt(c.trimHome.home).fleetHookPolicy, { digest: 'on', logRead: 'on', readTrim: 'on' });
  assert.throws(() => armConfig({ arm: 'anyray', gatewayUrl: GW, runTag: TAG, readTrim: true, hookPosture: { readTrim: 'off' }, cfgDir: dir, deps: deps(GW) }), /readTrim is set both on and off/);
}));

// ---- slot routing -------------------------------------------------------------------------

test('slot routing: --hook-posture-b reaches B only; --hook-posture reaches every Anyray arm', () => {
  const b = gw('--hook-posture-b', 'logRead=on');
  assert.equal('hookPosture' in slotOptions(b, arms, 'a'), false);
  assert.equal(slotOptions(b, arms, 'a').readTrim, false);
  assert.deepEqual(slotOptions(b, arms, 'b').hookPosture, { logRead: 'on' });
  assert.equal(slotOptions(b, arms, 'b').readTrim, false);
  const both = gw('--hook-posture', 'logRead=on');
  assert.deepEqual(slotOptions(both, arms, 'a').hookPosture, { logRead: 'on' });
  assert.deepEqual(slotOptions(both, arms, 'b').hookPosture, { logRead: 'on' });
  // B adds its own switch to the both-arms one.
  assert.deepEqual(slotOptions(gw('--hook-posture', 'digest=off', '--hook-posture-b', 'logRead=on'), arms, 'b').hookPosture, { digest: 'off', logRead: 'on' });
  assert.deepEqual(slotOptions(gw('--hook-posture', 'digest=off', '--hook-posture-b', 'logRead=on'), arms, 'a').hookPosture, { digest: 'off' });
  // --compare anyray: the direct arm has no hooks to pin.
  const anyray = one('--hook-posture', 'logRead=on');
  assert.equal('hookPosture' in slotOptions(anyray, armsFor('anyray'), 'a'), false);
  assert.deepEqual(slotOptions(anyray, armsFor('anyray'), 'b').hookPosture, { logRead: 'on' });
  // readTrim pinned off travels as a posture, not as readTrim.
  const off = slotOptions(gw('--hook-posture-b', 'readTrim=off'), arms, 'b');
  assert.equal(off.readTrim, false);
  assert.deepEqual(off.hookPosture, { readTrim: 'off' });
});

// ---- the profile write ----------------------------------------------------------------------

const PROFILE = { gateway: 'https://enrolled.example', clientKey: 'ark_synthetic_test', fleetHookPolicy: { digest: 'on' }, hookPolicies: { x: 1 } };
const HOOKS = {
  SessionStart: [{ hooks: [{ type: 'command', command: '/bin/anyray-connect refresh' }] }],
  PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: '/bin/anyray-connect __anyray-hook' }] }],
};
const deps = (enrolledOn) => ({
  connect: () => structuredClone({ ...PROFILE, gateway: enrolledOn }),
  clientKey: () => 'ark_synthetic_test',
  anyrayHooks: () => structuredClone(HOOKS),
  binExists: () => true,
  bin: '/bin/anyray-connect',
});
const GW = 'https://gw.example';
const TAG = { sessionId: 's1' };
const withCfg = (fn) => {
  const dir = mkdtempSync(join(tmpdir(), 'hook-posture-test-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
const profileAt = (home) => JSON.parse(readFileSync(join(home, '.anyray', 'connect.json'), 'utf8'));

test('profile write: a non-readTrim switch goes into fleetHookPolicy the way readTrim does', () => withCfg((dir) => {
  const c = armConfig({ arm: 'anyray', gatewayUrl: GW, runTag: TAG, hookPosture: { logRead: 'on' }, cfgDir: dir, deps: deps(GW) });
  const home = c.trimHome.home;
  assert.ok(home.startsWith(dir));
  // Enrolled on this gateway: the cached posture is kept, the switch added, hookPolicies dropped.
  const profile = profileAt(home);
  assert.deepEqual(profile.fleetHookPolicy, { digest: 'on', logRead: 'on' });
  assert.equal(profile.hookPolicies, undefined);
  assert.deepEqual(c.trimHome.posture, { digest: 'on', logRead: 'on' });
  assert.deepEqual(c.trimHome.pinned, { logRead: 'on' });
  // A switch on: the hook may read the transcript, and no policy sync may rewrite the copy.
  assert.equal(c.persistSession, true);
  for (const h of c.settings.hooks.PostToolUse[0].hooks) assert.equal(h.command, `HOME='${home}' ANYRAY_REFRESH_DISABLE='true' /bin/anyray-connect __anyray-hook`);
  assert.deepEqual(c.mcp.mcpServers.anyray.env, { HOME: home, ANYRAY_REFRESH_DISABLE: 'true' });
}));

test('profile write: off this gateway, digest goes off too, so the pinned switch is the only hook change', () => withCfg((dir) => {
  const c = armConfig({ arm: 'anyray', gatewayUrl: GW, runTag: TAG, hookPosture: { logRead: 'on' }, cfgDir: dir, deps: deps('https://elsewhere.example') });
  assert.deepEqual(profileAt(c.trimHome.home).fleetHookPolicy, { digest: 'off', logRead: 'on' });
  // An explicit digest pin wins over that default.
  const d = armConfig({ arm: 'anyray', gatewayUrl: GW, runTag: TAG, hookPosture: { logRead: 'on', digest: 'on' }, cfgDir: dir, deps: deps('https://elsewhere.example') });
  assert.deepEqual(profileAt(d.trimHome.home).fleetHookPolicy, { digest: 'on', logRead: 'on' });
}));

test('profile write: switches pinned only off keep key refresh off but need no transcript', () => withCfg((dir) => {
  const c = armConfig({ arm: 'anyray', gatewayUrl: GW, runTag: TAG, hookPosture: { logRead: 'off' }, cfgDir: dir, deps: deps(GW) });
  assert.deepEqual(profileAt(c.trimHome.home).fleetHookPolicy, { digest: 'on', logRead: 'off' });
  assert.equal(c.persistSession, false);
  assert.deepEqual(c.trimHome.env, { HOME: c.trimHome.home, ANYRAY_REFRESH_DISABLE: 'true' });
}));

test('profile write: no posture leaves the arm as it was, and the direct arm ignores one', () => withCfg((dir) => {
  const c = armConfig({ arm: 'anyray', gatewayUrl: GW, runTag: TAG, hookPosture: {}, cfgDir: dir, deps: deps(GW) });
  assert.equal(c.trimHome, null);
  assert.equal(c.persistSession, false);
  assert.deepEqual(c.settings.hooks, HOOKS);
  const d = armConfig({ arm: 'direct', gatewayUrl: GW, runTag: TAG, hookPosture: { logRead: 'on' }, cfgDir: dir, deps: deps(GW) });
  assert.equal(d.trimHome, null);
  assert.equal(d.persistSession, false);
  assert.throws(
    () => armConfig({ arm: 'anyray', gatewayUrl: GW, runTag: TAG, hookPosture: { logRead: 'on' }, cfgDir: dir, deps: { ...deps(GW), binExists: () => false } }),
    /--hook-posture logRead=on needs anyray-connect installed/,
  );
}));

// ---- drift ----------------------------------------------------------------------------------

test('hookPostureAtEnd: a profile that still holds the pin has not drifted', () => withCfg((dir) => {
  const c = armConfig({ arm: 'anyray', gatewayUrl: GW, runTag: TAG, hookPosture: { logRead: 'on', digest: 'off' }, cfgDir: dir, deps: deps(GW) });
  const p = hookPostureAtEnd(c.trimHome);
  assert.deepEqual(p, { set: { digest: 'off', logRead: 'on' }, pinned: { logRead: 'on', digest: 'off' }, atEnd: { logRead: 'on', digest: 'off' }, drifted: [] });
  assert.equal(postureDriftMessage(p), null);
}));

test('hookPostureAtEnd: a pin rewritten, dropped or unreadable at the end is drift, and fails the round', () => withCfg((dir) => {
  const c = armConfig({ arm: 'anyray', gatewayUrl: GW, runTag: TAG, hookPosture: { logRead: 'on', digest: 'off' }, cfgDir: dir, deps: deps(GW) });
  const file = join(c.trimHome.home, '.anyray', 'connect.json');
  const profile = profileAt(c.trimHome.home);
  writeFileSync(file, JSON.stringify({ ...profile, fleetHookPolicy: { digest: 'off', logRead: 'off' } }));
  let p = hookPostureAtEnd(c.trimHome);
  assert.deepEqual(p.atEnd, { logRead: 'off', digest: 'off' });
  assert.deepEqual(p.drifted, ['logRead']);
  assert.match(postureDriftMessage(p), /hook posture did not hold.*logRead set on, ended off/);
  // Policy sync writes only the switches it knows: an unknown pin disappears.
  writeFileSync(file, JSON.stringify({ ...profile, fleetHookPolicy: { digest: 'off' } }));
  p = hookPostureAtEnd(c.trimHome);
  assert.deepEqual(p.drifted, ['logRead']);
  assert.match(postureDriftMessage(p), /logRead set on, ended absent/);
  writeFileSync(file, '{not json');
  p = hookPostureAtEnd(c.trimHome);
  assert.deepEqual(p.drifted, ['logRead', 'digest']);
  assert.match(postureDriftMessage(p), /logRead set on, ended unreadable/);
}));

test('hookPostureAtEnd covers readTrim the same way', () => withCfg((dir) => {
  const c = armConfig({ arm: 'anyray', gatewayUrl: GW, runTag: TAG, readTrim: true, cfgDir: dir, deps: deps(GW) });
  assert.deepEqual(hookPostureAtEnd(c.trimHome).drifted, []);
  writeFileSync(join(c.trimHome.home, '.anyray', 'connect.json'), JSON.stringify({ fleetHookPolicy: { digest: 'on' } }));
  assert.deepEqual(hookPostureAtEnd(c.trimHome).drifted, ['readTrim']);
}));

// ---- the record and the label ---------------------------------------------------------------

test('requestRecord: hookPostureB and hookPosture, only when set', () => {
  const rec = requestRecord(gw('--hook-posture-b', 'logRead=on'));
  assert.deepEqual(rec.hookPostureB, { logRead: 'on' });
  assert.equal('hookPosture' in rec, false);
  assert.equal('readTrimB' in rec, false);
  assert.deepEqual(requestRecord(gw('--hook-posture', 'digest=off')).hookPosture, { digest: 'off' });
  const none = requestRecord(gw());
  assert.equal('hookPostureB' in none, false);
  assert.equal('hookPosture' in none, false);
});

test('armLabel: B names each pinned switch; A stays the baseline', () => {
  assert.equal(armLabel(gw('--hook-posture-b', 'logRead=on'), arms, 'a'), 'anyray (baseline)');
  assert.equal(armLabel(gw('--hook-posture-b', 'logRead=on'), arms, 'b'), 'anyray + hook:logRead');
  assert.equal(armLabel(gw('--hook-posture-b', 'logRead=off'), arms, 'b'), 'anyray + hook:logRead=off');
  assert.equal(armLabel(gw('--read-trim-b', '--hook-posture-b', 'logRead=on'), arms, 'b'), 'anyray + read-trim + hook:logRead');
  // A both-arms posture is not B's treatment.
  assert.equal(armLabel(gw('--hook-posture', 'logRead=on'), arms, 'b'), 'anyray (baseline)');
});

test('armSetups: each arm records the switches it pins', () => {
  const s = armSetups(gw('--hook-posture-b', 'logRead=on'), arms, { model: 'm', gatewayUrl: GW }, { maxTurns: 40 }, { enrolled: true });
  assert.equal('hookPosture' in s.a, false);
  assert.deepEqual(s.b.hookPosture.pinned, { logRead: 'on' });
  assert.match(s.b.hookPosture.how, /^for this session only: .*cached posture \+ logRead on.*key refresh off.*session persistence on/);
  assert.match(s.b.readTrim, /^fleet policy/);
  assert.deepEqual(Object.keys(s.b.hooks).sort(), ['PostToolUse', 'PostToolUseFailure']);
  const off = armSetups(gw('--hook-posture-b', 'logRead=off'), arms, { model: 'm', gatewayUrl: GW }, { maxTurns: 40 }, { enrolled: false });
  assert.match(off.b.hookPosture.how, /\{digest: off\} \+ logRead off/);
  assert.doesNotMatch(off.b.hookPosture.how, /session persistence/);
  const pinnedOff = armSetups(gw('--hook-posture-b', 'readTrim=off'), arms, { model: 'm', gatewayUrl: GW }, { maxTurns: 40 }, { enrolled: true });
  assert.match(pinnedOff.b.readTrim, /^off for this session only/);
  const d = { arm: 'direct', model: 'm', gatewayUrl: GW, runTag: 't', maxTurns: 1, enrolled: true };
  assert.deepEqual(describeSetup({ ...d, hookPosture: { logRead: 'on' } }), describeSetup(d));
});

test('controlArgs drops both postures, so the control pins nothing', () => {
  const c = controlArgs(gw('--hook-posture', 'digest=off', '--hook-posture-b', 'logRead=on', '--read-trim-b'));
  assert.deepEqual(c.hookPosture, {});
  assert.deepEqual(c.hookPostureB, {});
  assert.equal(c.readTrimB, false);
  const both = armsFor('control');
  for (const slot of ['a', 'b']) assert.equal('hookPosture' in slotOptions(c, both, slot), false);
  const rec = requestRecord(c);
  assert.equal('hookPosture' in rec, false);
  assert.equal('hookPostureB' in rec, false);
});
