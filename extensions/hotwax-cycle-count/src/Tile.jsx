import "@shopify/ui-extensions/preact";
import {render} from 'preact';
import {useEffect,useState} from 'preact/hooks';
import {currentCountOwner} from './count-api';
import {statusKey} from './count-background';
import {DEVELOPMENT_PREVIEW} from '../../../shared/oms-build-config';
export default () => render(<CountTile/>,document.body);
function CountTile() {
  const [status,setStatus]=useState(null);
  useEffect(()=>{
    let active=true;
    const update=async()=>{const owner=currentCountOwner(),value=await shopify.storage.get(statusKey(owner));if(active&&owner===currentCountOwner())setStatus(value);};
    update().catch(()=>{});const timer=setInterval(()=>update().catch(()=>{}),5000);
    const unStaff=shopify.session.staffMember.subscribe(()=>{setStatus(null);update().catch(()=>{});});
    return()=>{active=false;clearInterval(timer);unStaff();};
  },[]);
  const fresh=status&&Date.now()-status.at<120000;
  const subtitle=!fresh?'Open your store counts':status.state==='attention'?'Scans need attention':status.state==='locked'?'Session open on another register':status.state==='offline'?`${status.pending||0} saved · offline`:status.pending?`${status.pending} changes syncing`:status.state==='submitted'?'Session submitted':status.state==='counting'?`Resume ${status.name||'counting'}`:'All quantities synced';
  return <s-tile heading={DEVELOPMENT_PREVIEW?'Cycle Count (local)':'HotWax Cycle Count'} subheading={subtitle} onClick={()=>shopify.action.presentModal()}/>;
}
