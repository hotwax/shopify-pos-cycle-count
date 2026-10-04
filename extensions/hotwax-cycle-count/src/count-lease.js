import {controlFor, readMailbox, storedLease} from './count-control';

// Earlier releases stored each lease under its own key; it is moved into control on open.
export const leaseKey = (owner,id) => `hotwax-count:${owner}:lease:${id}`;
// Ownership is lost only when OMS says so. A timeout or an unreachable OMS
// leaves the last confirmed lease in place until it expires.
const ownershipLost = error => [401,403,409].includes(error?.status);
export class CountLease {
  constructor(storage,owner,request,changed=()=>{},isOffline=()=>false) {
    this.native=storage.native||storage;this.control=controlFor(this.native,owner);this.owner=owner;this.request=request;this.changed=changed;this.isOffline=isOffline;
    this.active=true;this.confirmed=false;this.generation=0;
  }
  canScan(sessionId,deviceId,now=Date.now()) {
    const value=this.value;
    if(!(this.active&&this.sessionId===sessionId&&deviceId&&value?.owned&&!value.available&&value.deviceId===deviceId))return false;
    // Offline, scans only append to this device's journal. Only a lease that OMS
    // confirmed for this terminal is stored, and every sync renews that exact
    // lease first, so a takeover elsewhere is detected before any write.
    if(this.isOffline())return true;
    return this.confirmed&&(value.expiresAt===null||(Number.isFinite(value.expiresAt)&&value.expiresAt>now));
  }
  assertCanScan(sessionId,deviceId) {
    if(!this.canScan(sessionId,deviceId))throw new Error('Scanning is paused. Acquire this terminal’s session lock before scanning.');
  }
  async stored(sessionId) {
    await this.control.adopt('leases',sessionId,'lease',value=>value?.owned?value:undefined);
    return storedLease(await this.control.read(),await readMailbox(this.native,this.owner),sessionId);
  }
  /** End every stored copy of this terminal's lease, including the background's. */
  async forget() {
    const mailbox=await readMailbox(this.native,this.owner),dates=[this.value?.fromDate,mailbox.leases[this.sessionId]?.fromDate,(await this.control.read()).leases[this.sessionId]?.fromDate]
      .filter(date=>date!=null).map(date=>typeof date==='number'?date:Number(date)||Date.parse(date));
    await this.control.release(this.sessionId,dates.length?Math.max(...dates):undefined);
  }
  async open(sessionId,offline=false,claimed=undefined) {
    this.confirmed=false;
    this.sessionId=sessionId;
    this.value=await this.stored(sessionId);
    if (offline) {this.changed(this.value);return this.value;}
    return this.claim(claimed);
  }
  /** @param {Promise<any>} [claimed] a claim request already started for this session */
  async claim(claimed=undefined) {
    const generation=++this.generation;
    this.confirmed=false;
    const value=await (claimed??this.request('leaseClaim',{sessionId:this.sessionId}));
    if (!this.active||generation!==this.generation) return value;
    // Keep only a lease this terminal owns; another terminal's lock ends any older copy here.
    if(value.owned) await this.control.holdLease(this.sessionId,value);
    else await this.forget();
    this.value=value;
    this.confirmed=true;
    this.changed(value);return value;
  }
  async renew() {
    if(this.renewing)return this.renewing;
    const generation=this.generation;
    this.renewing=(async()=>{
      if(!this.value?.owned)throw new Error('This session is open on another device. Recheck ownership to continue.');
      const value=await this.request('leaseRenew',{sessionId:this.sessionId,lease:this.value});
      if (!this.active||generation!==this.generation) return value;
      this.value=value;this.confirmed=true;await this.control.holdLease(this.sessionId,value);this.changed(value);return value;
    })().catch(async error=>{
      // OMS says another terminal owns it now: fence every copy this device holds.
      if(generation===this.generation&&ownershipLost(error)){this.confirmed=false;await this.forget().catch(()=>{});this.value={...this.value,owned:false};this.changed(this.value);}
      throw error;
    }).finally(()=>{this.renewing=null;});
    return this.renewing;
  }
  async write(action,payload) {
    if(!this.active || !this.value?.owned)throw new Error('Recheck device ownership before syncing this session. Your scans are saved.');
    // The count adapter renews this exact lease in OMS before each write
    // (manageLease). OMS must still enforce ownership for other clients.
    return this.request(action,{...payload,lease:this.value});
  }
  async release() {
    this.confirmed=false;++this.generation;
    if(this.value?.owned)await this.request('leaseRelease',{sessionId:this.sessionId,lease:this.value});
    await this.forget();this.value=null;this.changed(null);
  }
}
