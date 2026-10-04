export const leaseKey = (owner,id) => `hotwax-count:${owner}:lease:${id}`;
// Ownership is lost only when OMS says so. A timeout or an unreachable OMS
// leaves the last confirmed lease in place until it expires.
const ownershipLost = error => [401,403,409].includes(error?.status);
export class CountLease {
  constructor(storage,owner,request,changed=()=>{},isOffline=()=>false) {this.storage=storage;this.owner=owner;this.request=request;this.changed=changed;this.isOffline=isOffline;this.active=true;this.confirmed=false;this.generation=0;}
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
  async open(sessionId,offline=false,claimed=undefined) {
    this.confirmed=false;
    this.sessionId=sessionId;
    this.value=await this.storage.get(leaseKey(this.owner,sessionId));
    if (offline) {this.changed(this.value);return this.value;}
    return this.claim(claimed);
  }
  /** @param {Promise<any>} [claimed] a claim request already started for this session */
  async claim(claimed=undefined) {
    const generation=++this.generation;
    this.confirmed=false;
    const value=await (claimed??this.request('leaseClaim',{sessionId:this.sessionId}));
    if (!this.active||generation!==this.generation) return value;
    this.value=value;
    this.confirmed=true;
    if(value.owned) await this.storage.set(leaseKey(this.owner,this.sessionId),value);
    this.changed(value);return value;
  }
  async renew() {
    if(this.renewing)return this.renewing;
    const generation=this.generation;
    this.renewing=(async()=>{
      if(!this.value?.owned)throw new Error('This session is open on another device. Recheck ownership to continue.');
      const value=await this.request('leaseRenew',{sessionId:this.sessionId,lease:this.value});
      if (!this.active||generation!==this.generation) return value;
      this.value=value;this.confirmed=true;await this.storage.set(leaseKey(this.owner,this.sessionId),value);this.changed(value);return value;
    })().catch(error=>{if(generation===this.generation&&ownershipLost(error))this.confirmed=false;throw error;}).finally(()=>{this.renewing=null;});
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
    await this.storage.delete(leaseKey(this.owner,this.sessionId));this.value=null;this.changed(null);
  }
}
