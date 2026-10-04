import {CountStorage} from './count-storage';
import {enterBackground} from './count-coordination';
import {controlKey, mailboxKey, readControl, readMailbox, storedLease} from './count-control';

// Sessions found fully synced, by the control revision that was current then.
// Documents only change while the modal runs, and the modal rewrites control
// whenever it opens a session, so an unchanged revision means unchanged documents.
const checked = new Map(), RECHECK = 600000;
const same = (a, b) => a && b && a.state === b.state && a.pending === b.pending && a.sessionId === b.sessionId && Date.now() - a.at < 60000;
/** One bounded turn of the background uploader. It reads the modal's control
 * record and documents and writes only its own mailbox (receipts, leases it
 * claimed, release fences and status), so it never overwrites the modal's data.
 * Resolves to the number of changes still waiting, so the caller polls quickly only then. */
export async function syncBackground({native,owner,request,isCurrent=()=>true,connected=true}) {
  // An operator with no saved sessions costs one read and no coordination writes.
  const first=readControl(await native.get(controlKey(owner)));
  if(!first.catalogue.length){
    // Nothing left to sync: the mailbox has no further use.
    if(await native.get(mailboxKey(owner)))await native.delete(mailboxKey(owner));
    return 0;
  }
  const storage=new CountStorage(native),close=await enterBackground(native,owner);
  if(!close)return 0;
  let pending=0,mailbox,changed=false;
  const post=status=>{if(!same(mailbox.status,status)){mailbox.status={...status,at:Date.now(),background:true};changed=true;}};
  try {
    if(!isCurrent())return pending;
    const control=readControl(await native.get(controlKey(owner))),stored=await readMailbox(native,owner);
    mailbox={...stored,receipts:{...stored.receipts},leases:{...stored.leases},released:{...stored.released}};
    // Forget acknowledgements and leases of sessions the modal no longer keeps.
    const live=new Set(control.catalogue.map(entry=>entry.sessionId));
    for(const field of ['receipts','leases','released'])for(const id of Object.keys(mailbox[field]))if(!live.has(id)){delete mailbox[field][id];changed=true;}
    for(const entry of control.catalogue) {
      if(!isCurrent())return pending;
      const seen=checked.get(entry.itemKey);
      if(seen&&seen.rev===control.rev&&Date.now()-seen.at<RECHECK)continue;
      // Sessions an earlier release saved are uploaded after the modal migrates them.
      const metadata=await storage.metadata(entry.itemKey),journal=await storage.metadata(entry.eventKey);
      if(!metadata.header?.count?.editable||!metadata.header.count.audit?.deviceId||metadata.header.sessionId!==entry.sessionId)continue;
      const doc=await storage.peek(entry.itemKey);
      if(!doc?.header?.count?.editable)continue;
      // Receipts belong to one checkpoint document; revisions restart if it is recreated.
      const box=mailbox.receipts[entry.sessionId],docId=doc.header.docId;
      const receipts={...(await native.get(`${entry.itemKey}:receipts`))?.items,...(box?.docId===docId?box.items:{})},present=new Set();
      // A receipt is no longer needed once the modal has saved that revision as synced.
      for(const item of doc.records){present.add(item.productId);if(receipts[item.productId]&&item.syncedRevision>=receipts[item.productId].revision)delete receipts[item.productId];}
      for(const id of Object.keys(receipts))if(!present.has(id))delete receipts[id];
      const next=Object.keys(receipts).length?{docId,items:receipts}:undefined;
      if(JSON.stringify(next)!==JSON.stringify(box)){changed=true;if(next)mailbox.receipts[entry.sessionId]=next;else delete mailbox.receipts[entry.sessionId];}
      const dirty=doc.records.filter(item=>item.revision>Math.max(item.syncedRevision,receipts[item.productId]?.revision||0));
      const unmatched=journal.summary?.pendingCount??0;
      pending+=dirty.length+unmatched;
      if(!dirty.length&&!unmatched){checked.set(entry.itemKey,{rev:control.rev,at:Date.now()});continue;}
      const report={sessionId:entry.sessionId,name:entry.name,pending,unmatched};
      if(!connected) {post({...report,state:'offline'});return pending;}
      if(!dirty.length) {post({...report,state:'attention'});continue;}
      let lease=storedLease(control,mailbox,entry.sessionId);
      if(!lease || !(lease.expiresAt==null||lease.expiresAt>Date.now())) {
        const previous=lease||mailbox.leases[entry.sessionId];
        lease=await request('leaseClaim',{sessionId:entry.sessionId});
        if(!isCurrent())return pending;
        if(lease.owned)mailbox.leases[entry.sessionId]=lease;
        else {
          // Another terminal holds it: fence this terminal's older copies.
          delete mailbox.leases[entry.sessionId];
          if(previous?.fromDate!=null)mailbox.released[entry.sessionId]=previous.fromDate;
        }
        changed=true;
        post({...report,state:lease.owned?'pending':'locked'});
        return pending; // One bounded network operation per turn of the coordinator.
      }
      const batch=dirty.slice(0,25);
      const result=await request('saveBatch',{sessionId:entry.sessionId,lease,
        items:batch.map(item=>({productId:item.productId,code:item.productIdentifier,quantity:item.quantity,
          expectedQuantity:receipts[item.productId]?.quantity??item.serverQuantity??null}))});
      if(!Array.isArray(result.items)||batch.some(item=>!result.items.some(saved=>saved.productId===item.productId&&saved.quantity===item.quantity)))
        throw new Error('HotWax did not confirm the background batch. Your scans are retained.');
      for(const item of batch)receipts[item.productId]={revision:item.revision,quantity:item.quantity,at:Date.now()};
      mailbox.receipts[entry.sessionId]={docId,items:receipts};changed=true;
      post({...report,pending:pending-batch.length,state:pending>batch.length?'pending':'synced',lastSyncedAt:Date.now()});
      return pending-batch.length;
    }
    if(!pending)post({state:'synced',pending:0});
    return pending;
  } catch(error) {
    if(isCurrent()&&mailbox)post({state:'attention',message:error instanceof Error?error.message:'Open Cycle Count to resume syncing.'});
    return pending;
  } finally {
    // Receipts are kept even if the PIN changed after the server accepted the batch.
    // A lost write only repeats that batch next turn, with the same quantities.
    try {if(mailbox&&changed)await native.set(mailboxKey(owner),mailbox);}
    catch {/* Retried on the next turn. */}
    finally {await close();}
  }
}
