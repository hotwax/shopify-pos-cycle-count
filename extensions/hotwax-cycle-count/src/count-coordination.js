// Only the modal writes the local journal. Background sync reads committed
// checkpoints and writes receipts. These two flags prevent overlapping uploads.
// Both flags are heartbeats: a runtime that stops renewing its flag (suspended
// or killed) releases the other side within one short TTL.
const FOREGROUND = 'hotwax-count:foreground', BACKGROUND = 'hotwax-count:background-busy';
const FLAG_TTL = 15000, FLAG_RENEW = 5000;
const delay = ms => new Promise(resolve=>setTimeout(resolve,ms));
const token = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`;
function heartbeat(storage,key,value) {
  let stopped = false, renewing = Promise.resolve();
  const renew = () => {renewing = renewing.catch(()=>{}).then(()=>stopped?undefined:storage.set(key,{...value,expiresAt:Date.now()+FLAG_TTL}));return renewing;};
  const timer = setInterval(()=>renew().catch(()=>{}),FLAG_RENEW);
  const close = async () => {
    stopped = true;clearInterval(timer);await renewing.catch(()=>{});
    if ((await storage.get(key))?.id === value.id) await storage.delete(key);
  };
  return {renew,close};
}
export async function enterForeground(storage,owner) {
  const flag = heartbeat(storage,FOREGROUND,{id:token(),owner});
  try {
    await flag.renew();
    // Background publishes its busy flag before checking ours. Whichever starts
    // second stands down, including when both start between native bridge reads.
    // Callers await this only before journal work, never before showing data.
    while ((await storage.get(BACKGROUND))?.expiresAt > Date.now()) await delay(200);
    return flag.close;
  } catch(error) {await flag.close();throw error;}
}
export async function enterBackground(storage,owner) {
  if ((await storage.get(FOREGROUND))?.expiresAt > Date.now()) return null;
  const flag = heartbeat(storage,BACKGROUND,{id:token(),owner});
  try {
    await flag.renew();
    if ((await storage.get(FOREGROUND))?.expiresAt > Date.now()) {await flag.close();return null;}
    return flag.close;
  } catch(error) {await flag.close();throw error;}
}
