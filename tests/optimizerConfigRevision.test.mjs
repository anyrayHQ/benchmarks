// The run record names the gateway config its rounds ran against (ANY-1643): strategies and the revision.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { optimizerConfig } from '../lib/traces.mjs';

const serve = (body) =>
  new Promise((resolve) => {
    const s = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(body));
    }).listen(0, '127.0.0.1', () => resolve(s));
  });

test('optimizerConfig carries the config revision', async () => {
  const s = await serve({ config: { strategies: [{ kind: 'observation_mask' }], overrides: null }, revision: 'rev-7' });
  try {
    const c = await optimizerConfig(`http://127.0.0.1:${s.address().port}`, { ANYRAY_ADMIN_KEY: 'aak_synthetic-key' });
    assert.equal(c.revision, 'rev-7');
    assert.deepEqual(c.strategies, [{ kind: 'observation_mask' }]);
  } finally {
    s.close();
  }
});

test('a gateway that predates the revision reads as null, not as missing config', async () => {
  const s = await serve({ config: { strategies: [] } });
  try {
    const c = await optimizerConfig(`http://127.0.0.1:${s.address().port}`, { ANYRAY_ADMIN_KEY: 'aak_synthetic-key' });
    assert.equal(c.revision, null);
    assert.equal(c.unavailable, undefined);
  } finally {
    s.close();
  }
});
