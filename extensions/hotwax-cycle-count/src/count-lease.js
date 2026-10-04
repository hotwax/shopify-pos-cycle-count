export const leaseKey = (owner,id) => `hotwax-count:${owner}:lease:${id}`;
export class CountLease {
  constructor(storage,owner,request,changed=()=>{}) {this.storage=storage;this.owner=owner;this.request=request;this.changed=changed;this.active=true;this.confirmed=false;this.generation=0;}
  canScan(sessionId,deviceId,now=Date.now()) {
    const value=this.value;
    return !!(this.active&&this.confirmed&&this.sessionId===sessionId&&deviceId&&value?.owned&&!value.available&&
      value.deviceId===deviceId&&(value.expiresAt===null||(Number.isFinite(value.expiresAt)&&value.expiresAt>now)));
  }
  assertCanScan(sessionId,deviceId) {
    if(!this.canScan(sessionId,deviceId))throw new Error('Scanning is paused. Acquire this terminal’s session lock before scanning.');
  }
  async open(sessionId,offline=false) {
    this.confirmed=false;
    this.sessionId=sessionId;
    this.value=await this.storage.get(leaseKey(this.owner,sessionId));
    if (offline) {this.changed(this.value);return this.value;}
    return this.claim();
  }
  async claim() {
    const generation=++this.generation;
    this.confirmed=false;
    const value=await this.request('leaseClaim',{sessionId:this.sessionId});
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
    })().catch(error=>{if(generation===this.generation)this.confirmed=false;throw error;}).finally(()=>{this.renewing=null;});
    return this.renewing;
  }
  async write(action,payload) {
    if(!this.active || !this.value?.owned)throw new Error('Recheck device ownership before syncing this session. Your scans are saved.');
    // The server adapter validates this exact lease generation before each write.
    return this.request(action,{...payload,lease:this.value});
  }
  async release() {
    this.confirmed=false;++this.generation;
    if(this.value?.owned)await this.request('leaseRelease',{sessionId:this.sessionId,lease:this.value});
    await this.storage.delete(leaseKey(this.owner,this.sessionId));this.value=null;this.changed(null);
  }
}
