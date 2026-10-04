import {CountState} from './count-state';
import {CountStorage} from './count-storage';

// Isolated synthetic data, native storage and production engine; no OMS traffic.
export async function probePagedStorage(native, owner, report) {
  const prefix = `${owner}:paged-probe`, storage = new CountStorage(native);
  const request = async () => {throw new Error('Storage benchmark cannot contact OMS.');};
  const count = {sessionId: 'paged-benchmark', editable: true, items: [], canViewOnHand: false};
  const engine = new CountState(storage, prefix, request), now = Date.now();
  const clean = async key => {
    await storage.recover(key);
    const raw = await native.get(key), doc = typeof raw === 'string' ? JSON.parse(raw) : raw;
    for (const page of Object.values(doc?.pages || {})) await native.delete(page);
    await native.delete(key);
  };
  try {
    report('Preparing 5,000 products and 49,980 scans…');
    await engine.open(count);
    for (let i = 0; i < 5000; i++) engine.items.items[`p${i}`] = {
      productId: `p${i}`, sku: `benchmark-${i}`, title: `Benchmark product ${i}`, codes: [`benchmark-${i}`],
      productIdentifier: `benchmark-${i}`, uuid: `paged-benchmark:p${i}`, inventoryCountImportId: count.sessionId,
      quantity: 0, revision: 1, syncedRevision: 0, serverQuantity: null, lastEventId: 0, lastCorrectionId: 0,
      createdAt: now, lastScanAt: now, lastUpdatedAt: now, status: 'active', aggApplied: 0,
    };
    engine.events.events = Array.from({length: 49980}, (_, i) => {
      const item = engine.items.items[`p${i % 5000}`]; item.quantity++; item.aggApplied++; item.lastEventId = i + 1;
      return {id: i + 1, inventoryCountImportId: count.sessionId, scannedValue: item.sku, productId: item.productId,
        quantity: 1, mode: 'add', source: 'benchmark', createdAt: now, aggApplied: 1, negatedScanEventId: null};
    });
    engine.events.nextId = 49981;
    report('Saving paged scan history…'); await engine.write(engine.eventKey, engine.events);
    report('Saving product checkpoints…'); await engine.write(engine.itemKey, engine.items); engine.reindex();
    const durable = [], complete = [];
    for (let i = 0; i < 20; i++) {
      report(`Measuring scan ${i + 1} of 20 at full capacity…`);
      const start = performance.now();
      await engine.append({code: `benchmark-${i}`, source: 'benchmark'}); durable.push(performance.now() - start);
      await engine.aggregate(); complete.push(performance.now() - start);
    }
    report('Reopening all saved pages…');
    const restored = new CountState(new CountStorage(native), prefix, request);
    await restored.open(count);
    const items = Object.values(restored.items.items), units = items.reduce((sum, item) => sum + item.quantity, 0);
    if (restored.events.events.length !== 50000 || items.length !== 5000 || units !== 50000 || restored.events.events.some(e => e.aggApplied !== 1))
      throw new Error('Paged storage readback mismatch.');
    const p95 = values => Math.round([...values].sort((a,b)=>a-b)[18]);
    return `PASS (paged): 50,000 events / 5,000 products / 50,000 units reopened. p95 durable ${p95(durable)} ms; including aggregation ${p95(complete)} ms. 20 sequential samples. No OMS calls.`;
  } finally {
    engine.active = false;
    report('Cleaning up only benchmark pages…');
    await clean(engine.eventKey); await clean(engine.itemKey);
  }
}
