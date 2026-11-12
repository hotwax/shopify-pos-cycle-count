import './signals';
import {render} from 'preact';
import {useEffect,useState} from 'preact/hooks';
import {currentCountOwner} from './count-api';
import {CountWorkspace} from './CountWorkspace.jsx';
import {QuickCount} from './QuickCount.jsx';
import {readCountPage} from './count-navigation';
import {DEVELOPMENT_PREVIEW} from '../../../shared/oms-build-config';
import {readLayout} from './layout';

export default async () => {await readLayout();render(<CountExtension entry={navigation.currentEntry}/>,document.body);};
function CountExtension({entry}) {
  const [owner,setOwner]=useState(currentCountOwner()),[header,setHeader]=useState({heading:'Cycle count',subheading:'',action:null});
  useEffect(()=>{
    const update=()=>setOwner(currentCountOwner());
    const unsubscribe=shopify.session.staffMember.subscribe(update);
    const timer=setInterval(update,2000);
    return()=>{unsubscribe();clearInterval(timer);};
  },[]);
  const page=readCountPage(entry?.url,entry?.getState(),owner);
  if(!page)return <s-page heading="Cycle count"><s-box padding="large"><s-banner tone="warning" heading="Count unavailable">Go back to open a count for this location and operator.</s-banner></s-box></s-page>;
  const subheading=[header.subheading,DEVELOPMENT_PREVIEW?'Local preview':''].filter(Boolean).join(' · ');
  // Opened from a product page: count that product straight away.
  const variantId=page.kind==='home'?shopify.product?.variantId:undefined;
  return <s-page heading={header.heading} subheading={subheading}>{header.action&&<s-button slot="secondary-actions" variant="primary" loading={header.action.loading} disabled={header.action.disabled} onClick={header.action.onClick}>{header.action.label}</s-button>}
    {Number.isSafeInteger(variantId)&&variantId>0?<QuickCount key={owner} owner={owner} variantId={variantId} setHeader={setHeader}/>
      :<CountWorkspace key={owner} owner={owner} page={page} entryKey={entry?.key} setHeader={setHeader}/>}</s-page>;
}
