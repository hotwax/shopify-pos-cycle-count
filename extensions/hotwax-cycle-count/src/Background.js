import {bindCountRequest,currentCountOwner} from './count-api';
import {syncBackground} from './count-background';

export default () => {
  let running=false;
  async function tick() {
    if(running)return;
    running=true;
    const owner=currentCountOwner();
    try {await syncBackground({native:shopify.storage,owner,request:bindCountRequest(owner),
      connected:shopify.connectivity.current.value.internetConnected==='Connected',isCurrent:()=>currentCountOwner()===owner});}
    finally {running=false;}
  }
  // Shopify owns this runtime for the POS session; no Worker/service worker is registered.
  setInterval(()=>tick().catch(()=>{}),5000);
  shopify.connectivity.current.subscribe(()=>tick().catch(()=>{}));
  shopify.session.staffMember.subscribe(()=>tick().catch(()=>{}));
  tick().catch(()=>{});
};
