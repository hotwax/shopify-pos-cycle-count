import {bindCountRequest,currentCountOwner} from './count-api';
import {syncBackground} from './count-background';

// Poll quickly only while changes are waiting. An idle register checks rarely;
// connectivity and staff changes still trigger an immediate turn.
const BUSY_DELAY = 5000, IDLE_DELAY = 30000;
// Background uploads stay well inside the coordination flag's heartbeat.
const BACKGROUND_TIMEOUT = 25000;

export default () => {
  let running=false,timer=0;
  async function tick() {
    if(running)return;
    running=true;clearTimeout(timer);
    let pending=0;
    const owner=currentCountOwner();
    try {pending=await syncBackground({native:shopify.storage,owner,request:bindCountRequest(owner,{timeoutMs:BACKGROUND_TIMEOUT}),
      connected:shopify.connectivity.current.value.internetConnected==='Connected',isCurrent:()=>currentCountOwner()===owner});}
    catch {pending=1;}
    finally {running=false;timer=setTimeout(()=>tick().catch(()=>{}),pending?BUSY_DELAY:IDLE_DELAY);}
  }
  // Shopify owns this runtime for the POS session; no Worker/service worker is registered.
  shopify.connectivity.current.subscribe(()=>tick().catch(()=>{}));
  shopify.session.staffMember.subscribe(()=>tick().catch(()=>{}));
  tick().catch(()=>{});
};
