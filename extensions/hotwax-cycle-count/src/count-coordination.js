// Only the modal writes the local journal. Background sync reads committed
// checkpoints and writes receipts. These two flags prevent overlapping uploads.
const FOREGROUND = 'hotwax-count:foreground', BACKGROUND = 'hotwax-count:background-busy';
const delay = ms => new Promise(resolve=>setTimeout(resolve,ms));
const token = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`;
export async function enterForeground(storage,owner) {
  const id = token();
  let stopped = false, renewing = Promise.resolve();
  const renew = () => {renewing = renewing.catch(()=>{}).then(()=>stopped?undefined:storage.set(FOREGROUND,{id,owner,expiresAt:Date.now()+20000}));return renewing;};
  await renew();
  const timer = setInterval(()=>renew().catch(()=>{}),5000);
  const close = async () => {
    stopped = true;clearInterval(timer);await renewing.catch(()=>{});
    if ((await storage.get(FOREGROUND))?.id === id) await storage.delete(FOREGROUND);
  };
  try {
    // Background publishes its busy flag before checking ours. Whichever starts
    // second stands down, including when both start between native bridge reads.
    while ((await storage.get(BACKGROUND))?.expiresAt > Date.now()) await delay(200);
    return close;
  } catch(error) {await close();throw error;}
}
export async function enterBackground(storage,owner) {
  if ((await storage.get(FOREGROUND))?.expiresAt > Date.now()) return null;
  const id = token();
  await storage.set(BACKGROUND,{id,owner,expiresAt:Date.now()+65000});
  const close = async () => {if ((await storage.get(BACKGROUND))?.id === id) await storage.delete(BACKGROUND);};
  if ((await storage.get(FOREGROUND))?.expiresAt > Date.now()) {await close();return null;}
  return close;
}
