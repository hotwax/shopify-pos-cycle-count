import assert from 'node:assert/strict';
import {test} from 'node:test';
import {enterForeground} from '../extensions/hotwax-cycle-count/src/count-coordination.js';

function kv() {
  const data = new Map<string, unknown>();
  return {data, get: async (key: string) => structuredClone(data.get(key)), set: async (key: string, value: unknown) => {data.set(key, structuredClone(value));}, delete: async (key: string) => {data.delete(key);}};
}

// These wait out real renew periods, so they need longer than a default 5 s test timeout.
test('a screen that reappears after Back takes over a flag its closed screen stopped renewing', {timeout: 20000}, async () => {
  const storage = kv();
  // A closed task screen left its flag behind with ten seconds still to run.
  await storage.set('hotwax-count:foreground', {id: 'closed-screen', owner: 'owner', expiresAt: Date.now() + 10000});
  const started = Date.now();
  const close = await enterForeground(storage, 'owner', {takeOverStale: true});
  const waited = Date.now() - started;
  assert.ok(waited < 7000, `took over after ${waited} ms instead of waiting for the expiry`);
  assert.notEqual((storage.data.get('hotwax-count:foreground') as any).id, 'closed-screen');
  await close();
});

test('a flag that keeps renewing is never taken over', {timeout: 20000}, async () => {
  const storage = kv();
  const renew = () => storage.set('hotwax-count:foreground', {id: 'live-screen', owner: 'owner', expiresAt: Date.now() + 15000});
  await renew();
  const timer = setInterval(() => void renew(), 1000);
  const entering = enterForeground(storage, 'owner', {takeOverStale: true});
  const outcome = await Promise.race([entering.then(() => 'entered'), new Promise(resolve => setTimeout(() => resolve('waiting'), 7000))]);
  assert.equal(outcome, 'waiting');
  clearInterval(timer);
  await storage.delete('hotwax-count:foreground');
  const close = await entering;
  await close();
});
