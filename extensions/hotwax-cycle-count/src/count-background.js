import {CountStorage} from './count-storage';
import {enterBackground} from './count-coordination';
import {leaseKey} from './count-lease';

export const statusKey = owner => `hotwax-count:${owner}:status`;
const syncedCheckpoints=new Map();
/** One bounded turn of the background uploader. Resolves to the number of
 * changes still waiting, so the caller can poll quickly only while work remains. */
export async function syncBackground({native,owner,request,isCurrent=()=>true,connected=true}) {
  // An operator with no saved sessions costs one read and no coordination writes.
  if(!(await native.get(`hotwax-count:${owner}:sessions`))?.sessions?.length)return 0;
  const storage=new CountStorage(native),close=await enterBackground(native,owner);
  if(!close)return 0;
  let pending=0;
  try {
    if(!isCurrent())return pending;
    const catalog=await native.get(`hotwax-count:${owner}:sessions`);
    for(const entry of catalog?.sessions || []) {
      if(!isCurrent())return pending;
      const metadata=await storage.metadata(entry.itemKey),journal=await storage.metadata(entry.eventKey);
      if(!metadata.header?.count?.editable||!metadata.header.count.audit?.deviceId)continue;
      const stamp=`${metadata.generation}:${journal.generation}`;
      if(metadata.generation&&syncedCheckpoints.get(entry.itemKey)===stamp)continue;
      const doc=await storage.peek(entry.itemKey);
      if(!doc?.count?.editable || !doc.count.audit?.deviceId)continue;
      const receiptKey=`${entry.itemKey}:receipts`,receipts=await native.get(receiptKey)||{items:{}};
      const dirty=Object.values(doc.items).filter(item=>item.revision>Math.max(item.syncedRevision,receipts.items[item.productId]?.revision||0));
      const unmatched=journal.summary?.pendingCount??journal.header?.events?.filter(event=>event.aggApplied===0).length??0;
      pending+=dirty.length+unmatched;
      if(!dirty.length&&!unmatched){syncedCheckpoints.set(entry.itemKey,stamp);continue;}
      const report={at:Date.now(),sessionId:entry.sessionId,name:entry.name,pending,unmatched,background:true};
      if(!connected) {await native.set(statusKey(owner),{...report,state:'offline'});return pending;}
      if(!dirty.length) {await native.set(statusKey(owner),{...report,state:'attention'});continue;}
      let lease=await native.get(leaseKey(owner,entry.sessionId));
      if(!lease?.owned || !(lease.expiresAt>Date.now())) {
        lease=await request('leaseClaim',{sessionId:entry.sessionId});
        if(!isCurrent())return pending;
        if(lease.owned)await native.set(leaseKey(owner,entry.sessionId),lease);
        await native.set(statusKey(owner),{...report,state:lease.owned?'pending':'locked'});
        return pending; // One bounded network operation per turn of the coordinator.
      }
      const batch=dirty.slice(0,25);
      const result=await request('saveBatch',{sessionId:entry.sessionId,lease,
        items:batch.map(item=>({productId:item.productId,code:item.productIdentifier,quantity:item.quantity,
          expectedQuantity:receipts.items[item.productId]?.quantity??item.serverQuantity??null}))});
      if(!Array.isArray(result.items)||batch.some(item=>!result.items.some(saved=>saved.productId===item.productId&&saved.quantity===item.quantity)))
        throw new Error('HotWax did not confirm the background batch. Your scans are retained.');
      for(const item of batch)receipts.items[item.productId]={revision:item.revision,quantity:item.quantity,at:Date.now()};
      // Retain receipts even if the PIN changes after the server accepts the batch.
      await native.set(receiptKey,receipts);
      if(pending===batch.length)syncedCheckpoints.set(entry.itemKey,stamp);
      await native.set(statusKey(owner),{...report,pending:pending-batch.length,state:pending>batch.length?'pending':'synced',lastSyncedAt:Date.now()});
      return pending-batch.length;
    }
    if(!pending)await native.set(statusKey(owner),{at:Date.now(),state:'synced',pending:0,background:true});
    return pending;
  } catch(error) {
    if(isCurrent())await native.set(statusKey(owner),{at:Date.now(),state:'attention',background:true,message:error instanceof Error?error.message:'Open Cycle Count to resume syncing.'});
    return pending;
  } finally {await close();}
}
