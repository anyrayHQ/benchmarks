/**
 * A scenario's `pastes` filled in: `pastes: { ciLog: ci-log.txt }` reads that file (beside
 * scenario.yaml) and puts its text wherever `{{ciLog}}` stands in `task` or a follow-up, so
 * a block the user pastes into several turns is kept once and sent byte for byte the same.
 * `read` maps a file name to its text; a placeholder with no paste, or a paste no turn
 * uses, is an error.
 */
export function fillPastes(scenario, read) {
  if (!scenario.pastes) return scenario;
  for (const file of Object.values(scenario.pastes)) if (!/^[\w.-]+$/.test(String(file))) throw new Error(`paste file ${JSON.stringify(file)} must be a file name beside scenario.yaml`);
  const text = Object.fromEntries(Object.entries(scenario.pastes).map(([name, file]) => [name, read(file).replace(/\n$/, '')]));
  const used = new Set();
  const fill = (turn) => (typeof turn !== 'string' ? turn : turn.replace(/\{\{(\w+)\}\}/g, (_, name) => {
    if (!(name in text)) throw new Error(`scenario turn names {{${name}}}, which is not in pastes`);
    used.add(name);
    return text[name];
  }));
  const filled = { ...scenario, task: fill(scenario.task), ...(scenario.followups ? { followups: scenario.followups.map(fill) } : {}) };
  const unused = Object.keys(text).filter((name) => !used.has(name));
  if (unused.length) throw new Error(`pastes ${unused.join(', ')} appear in no turn`);
  return filled;
}

