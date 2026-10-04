import {CountState, jsonBytes} from './count-state-baseline';

// Synthetic storage benchmark only: the request callback rejects every OMS call.
export async function probeCountStorage(nativeStorage, owner, report = () => {}, encoding = 'object') {
  const storage = encoding === 'string' ? {
    get: async key => {const value = await nativeStorage.get(key); return typeof value === 'string' ? JSON.parse(value) : value;},
    set: (key, value) => nativeStorage.set(key, JSON.stringify(value)),
    delete: key => nativeStorage.delete(key),
  } : nativeStorage;
  const count = {sessionId: 'local-storage-benchmark', editable: true, items:
    Array.from({length: 100}, (_, id) => ({productId: `p${id}`, sku: `benchmark-${id}`, codes: [`benchmark-${id}`], quantity: 0}))};
  const request = async () => {throw new Error('The local KV benchmark must not contact OMS.');};
  const engine = new CountState(storage, `${owner}:poc-probe:${encoding}`, request);
  const now = Date.now();
  try {
    report('Opening two local KV documents…');
    await engine.open(count);
    // Seed already-aggregated history near the application's per-document bound.
    const events = Array.from({length: 4000}, (_, i) => ({id: i + 1,
      inventoryCountImportId: count.sessionId, scannedValue: `benchmark-${i % 100}`,
      productId: `p${i % 100}`, locationSeqId: null, negatedScanEventId: null,
      quantity: 1, mode: 'add', source: 'benchmark', createdAt: now, aggApplied: 1}));
    const eventDoc = {...engine.events, events};
    while (jsonBytes(eventDoc) > 850000) events.splice(-100);
    eventDoc.nextId = events.length + 1;
    for (const event of events) {
      const item = engine.items.items[event.productId];
      item.quantity++; item.aggApplied++; item.lastEventId = event.id;
      item.revision = event.id; item.syncedRevision = event.id;
    }
    report(`Writing ${events.length} events (${jsonBytes(eventDoc)} bytes)…`);
    await engine.write(engine.eventKey, eventDoc);
    report('Writing 100 count items…');
    await engine.write(engine.itemKey, engine.items);
    report('Reopening the seeded documents…');
    await engine.open(count);
    const initialBytes = jsonBytes(eventDoc), durable = [], complete = [];
    for (let i = 0; i < 20; i++) {
      report(`Measuring scan ${i + 1} of 20…`);
      const start = performance.now();
      await engine.append({code: `benchmark-${i}`, source: 'benchmark'});
      durable.push(performance.now() - start);
      await engine.aggregate();
      complete.push(performance.now() - start);
    }
    const restored = new CountState(storage, `${owner}:poc-probe:${encoding}`, request);
    report('Checking durable readback…');
    await restored.open(count);
    const units = Object.values(restored.items.items).reduce((sum, item) => sum + item.quantity, 0);
    const expected = events.length + 20;
    if (units !== expected || restored.events.events.length !== expected ||
        restored.events.events.some(event => event.aggApplied !== 1)) throw new Error('KV benchmark readback mismatch.');
    const p95 = values => Math.round([...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1]);
    return `PASS (${encoding}): ${events.length} synthetic events (${initialBytes} bytes), then 20 repeated scans through the real count engine. Reopened: ${expected} events / 100 items / ${units} units. p95 durable scan ${p95(durable)} ms; including aggregation ${p95(complete)} ms. Final event document ${jsonBytes(restored.events)} bytes. Worker ${typeof globalThis.Worker}; IndexedDB ${typeof globalThis.indexedDB}. No OMS calls.`;
  } finally {
    engine.active = false;
    await storage.delete(engine.eventKey).catch(() => {});
    await storage.delete(engine.itemKey).catch(() => {});
  }
}
