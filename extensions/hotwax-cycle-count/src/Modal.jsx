import './signals';
import {render} from 'preact';
import {useEffect,useState} from 'preact/hooks';
import {currentCountOwner} from './count-api';
import {CountWorkspace} from './CountWorkspace.jsx';
import {DEVELOPMENT_PREVIEW} from '../../../shared/oms-build-config';

export default () => render(<CountExtension/>,document.body);
function CountExtension() {
  const [owner,setOwner]=useState(currentCountOwner()),[header,setHeader]=useState({heading:'Cycle Count',subheading:''});
  useEffect(()=>{
    const update=()=>setOwner(currentCountOwner());
    const unsubscribe=shopify.session.staffMember.subscribe(update);
    const timer=setInterval(update,2000);
    return()=>{unsubscribe();clearInterval(timer);};
  },[]);
  // Keep the native page host stable across every navigation. A PIN/store change
  // replaces only the operator workspace, stopping its old scanners and uploads.
  const subheading=[header.subheading,DEVELOPMENT_PREVIEW?'Local preview':''].filter(Boolean).join(' · ');
  return <s-page heading={header.heading} subheading={subheading}><CountWorkspace key={owner} owner={owner} setHeader={setHeader}/></s-page>;
}
