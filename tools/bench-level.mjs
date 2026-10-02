#!/usr/bin/env node
import { createBenchLevel, LEVELS, redactLevelError } from '../lib/benchLevel.mjs';

async function main(argv = process.argv.slice(2), env = process.env) {
  const args = [...argv];
  let agent, user;
  for (const flag of ['--agent', '--user']) {
    const i = args.indexOf(flag);
    if (i >= 0) {
      const value = args.splice(i, 2)[1];
      if (!value) throw new Error(`${flag} needs an id`);
      if (flag === '--agent') agent = value;
      else user = value;
    }
  }
  const [command = 'show', level, ...rest] = args;
  if (rest.length || !['show', 'set', 'clear'].includes(command) || (command === 'set' && !LEVELS.includes(level)) || (command !== 'set' && level)) {
    throw new Error(`usage: bench-level show | set ${LEVELS.join('|')} | clear [--agent <id> | --user <id>]`);
  }
  const tool = createBenchLevel({ gatewayUrl: env.ANYRAY_GATEWAY_URL, adminKey: env.ANYRAY_ADMIN_KEY, clientKey: env.ANYRAY_BENCH_CLIENT_KEY || env.ANYRAY_CLIENT_KEY, agent: agent ?? (user ? undefined : env.ANYRAY_BENCH_AGENT_ID), user: user ?? (agent ? undefined : env.ANYRAY_BENCH_USER_ID) });
  if (command === 'show') {
    const report = await tool.show();
    console.log(`${report.target.scope}/${report.target.id}: assigned ${report.assigned ?? 'none'}; effective ${report.effective.level} (${report.effective.source})`);
  } else if (command === 'set') {
    const change = await tool.set(level);
    console.log(`${change.target.scope}/${change.target.id}: set ${level}; prior assignment saved in results/integration-level.before.json`);
  } else {
    await tool.clear();
    console.log('prior integration-level assignment restored');
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((error) => {
  console.error(redactLevelError(error));
  process.exitCode = 1;
});

export { main };
