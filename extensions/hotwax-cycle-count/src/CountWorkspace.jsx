import {useCallback,useEffect,useRef,useState} from 'preact/hooks';
import {CountState,decodeDocument} from './count-state';
import {CountStorage} from './count-storage';
import {CountLease,leaseKey} from './count-lease';
import {enterForeground} from './count-coordination';
import {statusKey} from './count-background';
import {bindCountRequest,currentCountOwner,currentAuditContext,countStatus,countTypeName,workStatus,isOmsOutageSimulated,simulateOmsOutage,subscribeScans} from './count-api';
import {CountFlow} from './CountFlow.jsx';
import {CreateCount} from './CreateCount.jsx';
import {HandCount} from './HandCount.jsx';
import {CatalogPicker} from './CatalogPicker.jsx';
import {ProductList,CompactPager} from './ProductList.jsx';
import {ActionRow,QuantityEditor,BackButton,amount} from './FlowParts.jsx';
import {ListProbe} from './ListProbe.jsx';
import {HidBarcodeEntry} from './CountInputs.jsx';
import {ScanEventRow} from './ScanEventRow.jsx';
import {ScanFeedback} from './ScanFeedback.jsx';
import {probePagedStorage} from './count-probe-paged';
import {LOCAL_OMS_PREVIEW} from '../../../shared/oms-build-config';

const message=f=>f instanceof Error?f.message:'Could not complete this action. Your saved scans are retained.';
const editable=status=>['SESSION_CREATED','SESSION_ASSIGNED'].includes(status);
const sessionTabs=[['all','All products'],['uncounted','Uncounted'],['scans','Scan events'],['counted','Counted']];

export function CountWorkspace({owner,setHeader}) {
  const [route,setRoute]=useState('home'),[workId,setWorkId]=useState(null),[history,setHistory]=useState(null),[group,setGroup]=useState('active');
  const [opening,setOpening]=useState(null);
  const [matchingFeedback,setMatchingFeedback]=useState(null);
  const [hidMode,setHidMode]=useState(false);
  const [count,setCount]=useState(null),[stats,setStats]=useState(null),[catalog,setCatalog]=useState([]),[busy,setBusy]=useState(true),[error,setError]=useState('');
  const [saving,setSaving]=useState(false),[syncError,setSyncError]=useState(''),[lastSynced,setLastSynced]=useState(null);
  const [lease,setLease]=useState(null),[leaseProblem,setLeaseProblem]=useState(''),[connected,setConnected]=useState(shopify.connectivity.current.value.internetConnected==='Connected');
  const [leaseNow,setLeaseNow]=useState(Date.now());
  const [showLockDetails,setShowLockDetails]=useState(false);
  const [sources,setSources]=useState(shopify.scanner.sources.current.value),[outage,setOutage]=useState(false),[productId,setProductId]=useState(null);
  const [contextProduct,setContextProduct]=useState(null),[conflicts,setConflicts]=useState([]),[issueId,setIssueId]=useState(null),[localPage,setLocalPage]=useState(0),[probe,setProbe]=useState('');
  const [scanPage,setScanPage]=useState(0),[scanSearch,setScanSearch]=useState(''),[scanFilter,setScanFilter]=useState('all');
  const [sessionTab,setSessionTab]=useState('all');
  const [editName,setEditName]=useState(''),[editArea,setEditArea]=useState('register'),[cameraMode,setCameraMode]=useState('rapid'),[cameraCode,setCameraCode]=useState(''),[cameraQuantity,setCameraQuantity]=useState('1'),[cameraProduct,setCameraProduct]=useState(null);
  const cameraRef=useRef({mode:'rapid',code:'',at:0});
  cameraRef.current.mode=cameraMode;
  const storage=useRef(new CountStorage(shopify.storage)).current,request=useRef(bindCountRequest(owner)).current;
  const engine=useRef(null),ownership=useRef(null),alive=useRef(true),running=useRef(false),gate=useRef(false),latest=useRef(null),context=useRef(null);
  const key=`hotwax-count:${owner}`;
  const listMemory=useRef({search:'',view:'all',page:0});
  const selectProduct=useCallback(item=>{setProductId(item.productId);go('product');},[]);
  const own=()=>alive.current&&currentCountOwner()===owner;
  const hasScanLock=()=>own()&&!!engine.current?.active&&!!engine.current.count?.editable&&!!ownership.current?.canScan(engine.current.count.sessionId,currentAuditContext().deviceId);
  const canCount=!!count?.editable&&hasScanLock();
  const leaseActive=!!lease&&!lease.available&&(lease.expiresAt==null||lease.expiresAt>leaseNow);
  const lockUnverified=!connected||outage||!!leaseProblem||!lease||!ownership.current?.confirmed;
  const lockLabel=lockUnverified?'Lock needs recheck':!leaseActive?'Session not locked':lease.owned?'Locked to this terminal':'Locked on another terminal';
  const lockTone=lockUnverified||!leaseActive?'warning':lease.owned?'success':'critical';
  const sessionRoute=count?.statusId==='SESSION_SUBMITTED'?'submitted':count?.editable?'count':'readonly';
  latest.current={route,count,stats,canCount,busy,connected,outage,hidMode};
  gate.current=canCount&&!busy&&route==='count';
  const titles={opening:'Opening session',home:'Cycle Count',new:'Create count',hand:'Hand count',match:'Match OMS product',editSession:'Edit session',discard:'Discard session',forceRelease:'Take over session',camera:'Camera counting',cameraConfirm:'Confirm quantity',work:'Count summary',count:count?.name||'Count items',readonly:count?.name||'Session details',product:'Count quantity',submitted:'Session submitted',issue:'Check this scan',compare:'Resolve quantity',options:count?'Session options':'Count options',saved:'Saved sessions',remove:'Remove local copy',diagnostics:'Diagnostics',probe:'Large-list check',context:'Count this product'};
  useEffect(()=>{if(!['work','hand'].includes(route))setHeader({heading:titles[route]||'Cycle Count',subheading:history?`${history.facilityName} · ${history.userName}`:''});},[route,count?.name,history?.facilityName,history?.userName]);
  function go(next) {gate.current=false;shopify.scanner.hideCameraScanner();setError('');setMatchingFeedback(null);setRoute(next);}
  function selectSessionTab(next) {
    if(!sessionTabs.some(([id])=>id===next))return;
    if(next!==sessionTab){listMemory.current.page=0;setScanPage(0);}
    setSessionTab(next);
  }
  async function run(fn) {
    if(running.current||!own())return;
    running.current=true;setBusy(true);setError('');gate.current=false;
    try {return await fn();}catch(failure){if(own())setError(message(failure));}
    finally{running.current=false;if(own())setBusy(false);}
  }
  async function refresh(pageIndex=0,selectedGroup=group) {
    const local=await storage.get(`${key}:sessions`);
    if(own())setCatalog(local?.sessions||[]);
    const result=await request('storeCounts',{pageIndex,group:selectedGroup});
    if(own())setHistory(result);
    return result;
  }
  async function settle() {
    const previous=engine.current;
    if(previous?.syncing)await previous.syncing.catch(()=>{});
    if(previous)previous.active=false;
    if(previous?.aggregating)await previous.aggregating.catch(()=>{});
    await previous?.tail.catch(()=>{});
    if(ownership.current)ownership.current.active=false;
  }
  async function attach(result) {
    await settle();if(!own())return;
    setStats(null);setLease(null);setLeaseProblem('');setShowLockDetails(false);setSyncError('');setConflicts([]);setLastSynced(null);
    listMemory.current={search:'',view:'all',page:0};
    setSessionTab('all');setScanSearch('');setScanPage(0);setScanFilter('all');
    const selected=context.current;
    if(selected&&result.editable&&!result.items.some(item=>item.productId===selected.productId))
      result={...result,items:[...result.items,{...selected,quantity:null,isRequested:result.countType!=='DIRECTED_COUNT'}]};
    const claim=new CountLease(storage,owner,request,value=>{if(own())setLease(value);});
    ownership.current=claim;
    if(result.editable)try{await claim.open(result.sessionId,!latest.current.connected||await isOmsOutageSimulated());}catch(failure){if(own())setLeaseProblem(message(failure));}
    const send=(action,payload)=>['saveBatch','submit','editSession','discardSession'].includes(action)?claim.write(action,payload):request(action,payload);
    send.lookupBatch=request.lookupBatch;
    send.lookupIdentityBatch=request.lookupIdentityBatch;
    send.enrichScan=request.enrichScan;
    const state=new CountState(storage,owner,send,(value,nextStats)=>{
      if(!own()||!state.active)return;
      setCount({...value});setStats(nextStats);
    },currentAuditContext(),()=>{
      if(!own()||ownership.current!==claim)throw new Error('Reopen this session to acquire its lock.');
      claim.assertCanScan(result.sessionId,currentAuditContext().deviceId);
    });
    engine.current=state;
    await state.open(result);if(!own()){state.active=false;return;}
    if(result.editable)state.aggregate().catch(failure=>{if(own())setSyncError(message(failure));});
    setRoute(!result.editable?(result.statusId==='SESSION_SUBMITTED'?'submitted':'readonly'):selected?'context':'count');
    if(selected)setProductId(selected.productId);
  }
  async function open(sessionId,provided=undefined,name='') {
    return run(async()=>{
      // Acknowledge the tap before OMS, lease or local-storage work starts.
      setOpening({sessionId,name:provided?.name||name||catalog.find(item=>item.sessionId===sessionId)?.name||'Session',from:route==='opening'?opening.from:route});
      setHidMode(false);go('opening');
      let result=provided;
      if(!result)try{result=await request('detail',{sessionId});}catch(failure){
        if(latest.current.connected&&!await isOmsOutageSimulated())throw failure;
        const saved=await storage.get(`${key}:sessions`),entry=saved?.sessions.find(item=>item.sessionId===sessionId);
        const cached=entry&&decodeDocument(await storage.get(entry.itemKey));
        if(!cached?.count)throw failure;
        result={...cached.count,items:Object.values(cached.items)};
      }
      await attach(result);
    });
  }
  async function leave(toWork=true) {
    return run(async()=>{
      const id=engine.current?.count.workEffortId;
      await settle();engine.current=null;ownership.current=null;setCount(null);setStats(null);setLease(null);
      setWorkId(toWork?id:null);go(toWork?'work':'home');
      if(!toWork)await refresh();
    });
  }
  const enqueue=useCallback(async job=>{
    const state=engine.current;
    try {
      if(!hasScanLock()||!state?.active)throw new Error('Scanning is paused. Acquire this terminal’s session lock before scanning.');
      const id=await state.append(job);
      if(own()&&engine.current===state&&state.active&&job.source!=='correction')showRecordedScans();
      state.aggregate().catch(failure=>{if(own())setSyncError(message(failure));});
      return id;
    }catch(failure){if(own())setError(message(failure));}
  },[]);
  function showRecordedScans() {
    setScanSearch('');setScanPage(0);setScanFilter('all');setSessionTab('scans');
  }
  function showUnmatchedScans() {
    setScanFilter('unmatched');setScanPage(0);setSessionTab('scans');go(sessionRoute);
  }
  async function sync() {
    const state=engine.current;
    if(!own()||!state?.active||state.syncing||!latest.current.count?.editable||!ownership.current?.value?.owned||running.current)return;
    setSaving(true);
    try{await state.sync();if(own()){setLastSynced(Date.now());setSyncError('');}}
    catch(failure){if(own())setSyncError(message(failure));}
    finally{if(own())setSaving(false);}
  }
  async function retryMatching(target=undefined) {
    return run(async()=>{
      const state=engine.current;
      setMatchingFeedback({id:target?.id,code:target?.code,pending:true});
      try {
        const result=await state.retryMatching(target?.id);
        if(own()&&engine.current===state)setMatchingFeedback({id:target?.id,code:target?.code,...result});
      } catch(failure) {
        if(own())setMatchingFeedback({id:target?.id,code:target?.code,failed:true,reason:message(failure)});
      }
    });
  }
  async function reclaim() {
    await run(async()=>{const value=await ownership.current.claim();if(own())setLeaseProblem(value.owned?'':'This session is locked on another terminal. Tap the lock badge for details.');});
  }
  async function compare() {
    await run(async()=>{
      const state=engine.current;
      if(state.syncing)await state.syncing.catch(()=>{});
      await state.aggregate(true);
      if(state.events.events.some(e=>e.aggApplied===0))throw new Error('Check unmatched scans before comparing quantities.');
      const remote=await request('detail',{sessionId:state.count.sessionId});
      if(!remote.editable){await attach(remote);return;}
      const differences=state.itemList.filter(item=>item.revision!==item.syncedRevision).map(item=>({...item,serverQuantity:remote.items.find(row=>row.productId===item.productId)?.quantity??null}));
      setConflicts(differences);go('compare');
    });
  }
  async function submit() {
    await run(async()=>{
      await engine.current.prepareSubmission();
      const result=await ownership.current.write('submit',{sessionId:count.sessionId});
      await ownership.current.release().catch(()=>{});
      context.current=null;setContextProduct(null);await attach(result);
    });
  }
  async function removeLocal() {
    await run(async()=>{
      const state=engine.current;
      if(state.syncing)await state.syncing;if(state.aggregating)await state.aggregating;await state.tail;
      if(state.events.events.some(e=>e.aggApplied===0)||state.itemList.some(i=>i.revision!==i.syncedRevision))throw new Error('Sync and resolve all scans before removing a local copy.');
      const remote=await request('detail',{sessionId:count.sessionId});
      if(remote.editable||remote.statusId!=='SESSION_SUBMITTED'||state.itemList.some(i=>!remote.items.some(saved=>saved.productId===i.productId&&saved.quantity===i.quantity)))throw new Error('HotWax has not confirmed every submitted quantity. Your local copy was kept.');
      state.active=false;await storage.removeDocument(state.eventKey);await storage.removeDocument(state.itemKey);
      await storage.delete(`${state.itemKey}:receipts`);await storage.delete(leaseKey(owner,count.sessionId));
      const saved=await storage.get(`${key}:sessions`);
      await storage.set(`${key}:sessions`,{...saved,active:null,sessions:saved.sessions.filter(s=>s.sessionId!==count.sessionId)});
      engine.current=null;setCount(null);setStats(null);go('home');await refresh();
    });
  }
  useEffect(()=>{
    let releaseForeground=async()=>{},stopped=false;
    (async()=>{
      releaseForeground=await enterForeground(shopify.storage,owner);
      if(stopped){await releaseForeground();return;}
      if(LOCAL_OMS_PREVIEW)setOutage(await isOmsOutageSimulated());
      if(shopify.product?.variantId)try{const selected=await request('contextProduct',{variantId:shopify.product.variantId});if(own()){context.current=selected;setContextProduct(selected);}}catch(failure){if(own())setError(message(failure));}
      await refresh();
    })().catch(failure=>{if(own())setError(message(failure));}).finally(()=>{if(own())setBusy(false);});
    const unSources=shopify.scanner.sources.current.subscribe(setSources);
    const unConnection=shopify.connectivity.current.subscribe(value=>{if(own())setConnected(value.internetConnected==='Connected');});
    const unScans=subscribeScans(shopify.scanner,scan=>{
      if(!gate.current||!hasScanLock()||latest.current.hidMode)return;
      if(scan.source==='camera'){
        const now=Date.now();if(cameraRef.current.code===scan.data&&now-cameraRef.current.at<1000)return;
        cameraRef.current.code=scan.data;cameraRef.current.at=now;
        if(cameraRef.current.mode==='confirm'){
          shopify.scanner.hideCameraScanner();gate.current=false;setCameraCode(scan.data);setCameraQuantity('1');setCameraProduct(null);setRoute('cameraConfirm');
          const cached=engine.current?.items.items[engine.current.codes.get(scan.data.toLowerCase())];
          if(cached)setCameraProduct(cached);else request('lookup',{code:scan.data}).then(product=>{if(own())setCameraProduct(product);}).catch(()=>{});
          return;
        }
      }
      enqueue({code:scan.data,source:scan.source}).catch(failure=>{if(own())setError(message(failure));});
    });
    const syncTimer=setInterval(()=>{
      const current=latest.current;
      if(!current.connected||current.outage||current.busy||!current.canCount)return;
      if(current.stats?.pending||current.stats?.dirty)sync();
    },5000);
    const heartbeat=setInterval(()=>{
      if(!ownership.current?.value?.owned||!engine.current?.count.editable||!own())return;
      ownership.current.renew().then(()=>{if(own())setLeaseProblem('');}).catch(failure=>{if(own())setLeaseProblem(message(failure));});
    },30000);
    const status=setInterval(()=>{
      const current=latest.current;if(!own()||!current.count)return;
      setLeaseNow(Date.now());
      shopify.storage.set(statusKey(owner),{at:Date.now(),sessionId:current.count.sessionId,name:current.count.name,
        pending:(current.stats?.pending||0)+(current.stats?.dirty||0),unmatched:current.stats?.pending||0,
        state:!current.connected?'offline':current.stats?.pending?'attention':current.stats?.dirty?'pending':current.count.editable?'counting':'submitted'}).catch(()=>{});
    },5000);
    return()=>{
      stopped=true;alive.current=false;gate.current=false;clearInterval(syncTimer);clearInterval(heartbeat);clearInterval(status);
      unSources();unConnection();unScans();shopify.scanner.hideCameraScanner();
      const state=engine.current;if(state)state.active=false;
      if(ownership.current)ownership.current.active=false;
      // Keep background uploads out until an in-flight foreground save finishes.
      Promise.allSettled([state?.syncing,state?.aggregating,state?.tail]).then(()=>releaseForeground?.()).catch(()=>{});
    };
  },[]);
  const isSessionDetail=['count','submitted','readonly'].includes(route);
  const scanHistory=isSessionDetail&&sessionTab==='scans'?engine.current?.historyPage(scanSearch,scanPage,scanFilter):null;
  const resume=catalog.find(item=>editable(item.statusId));
  const selected=count?.items.find(item=>item.productId===productId);
  const issue=stats?.issues?.find(item=>item.id===issueId);
  const last=stats?.lastScan;
  const posScannerConnected=sources.includes('external')||sources.includes('embedded');
  const pending=(stats?.dirty||0)+(stats?.pending||0);
  const syncText=!count?.editable?'Saved in HotWax':saving?'Syncing with HotWax…':stats?.pending?`${stats.pending} scans to check · other products can still be counted`:stats?.dirty?`${stats.dirty} products saved on this device · sync pending`:lastSynced?'All quantities synced with HotWax':'Scans are saved on this device, then synced automatically';
  function back() {
    if(route==='opening'){go(opening?.from||'home');return;}
    if(['count','submitted','readonly','context'].includes(route)){leave(true);return;}
    if(route==='product'){go(sessionRoute);return;}
    if(route==='issue'){showUnmatchedScans();return;}
    if(route==='match'){go('issue');return;}
    if(['editSession','discard','forceRelease','camera'].includes(route)){go('options');return;}
    if(route==='diagnostics'||route==='saved'||route==='remove'){go('options');return;}
    go(count?sessionRoute:'home');
  }
  if(route==='new')return <CreateCount request={request} storage={storage} owner={owner} timeZone={history?.timeZone} back={()=>go('home')} onCreated={result=>{setWorkId(result.workEffortId);go('work');}}/>;
  if(route==='work')return <CountFlow key={workId} workEffortId={workId} setHeader={setHeader} openSession={open} storage={storage} owner={owner} request={request} back={()=>{setWorkId(null);go('home');run(()=>refresh());}}/>;
  return <>
    <s-button slot="secondary-actions" loading={busy} disabled={busy||route==='opening'} onClick={()=>go(route==='options'?(count?sessionRoute:'home'):'options')}>{route==='options'?'Done':'More'}</s-button>
    <s-scroll-box key={`${route}:${count?.sessionId||'home'}:${route==='product'?productId:''}`}><s-box padding="large"><s-stack direction="block" gap="large">
      {!['home','probe','options','hand'].includes(route)&&<BackButton disabled={busy} onClick={back}>{['count','submitted','readonly','context'].includes(route)?'Count summary':route==='product'?'Session details':'Back'}</BackButton>}
      {count&&(isSessionDetail||route==='context')?<s-stack direction="inline" justifyContent="space-between" alignItems="start" gap="large">
        <s-stack direction="block" gap="small">
          <s-heading>{count.countName||'Cycle count'}</s-heading>
          <s-text type="strong" color="subdued">{count.name||'Counting session'}</s-text>
        </s-stack>
        <s-stack direction="block" gap="small" alignItems="end">
          <s-clickable onClick={()=>setShowLockDetails(value=>!value)}><s-box minBlockSize="44px"><s-stack direction="inline" alignItems="center" minBlockSize="44px"><s-badge tone={count.editable?lockTone:'neutral'}>{count.editable?lockLabel:'Session unlocked'}</s-badge></s-stack></s-box></s-clickable>
          <s-badge tone={posScannerConnected?'success':'neutral'}>{posScannerConnected?'POS scanner connected':'POS scanner not connected'}</s-badge>
          {showLockDetails&&<s-stack direction="block" gap="small"><s-text color="subdued">POS terminal ID: {lease?.deviceId||currentAuditContext().deviceId}</s-text><s-text color="subdued">Count ID: {count.workEffortId}</s-text><s-text color="subdued">Session ID: {count.sessionId}</s-text>{lease?.operator&&<s-text color="subdued">{lease.operator}</s-text>}</s-stack>}
        </s-stack>
      </s-stack>:route!=='hand'&&<s-heading>{titles[route]||'Cycle Count'}</s-heading>}
      {error&&<s-banner tone="critical" heading={error}/>}
      {!connected&&<s-banner tone="warning" heading="Offline">Saved sessions and known products are available. Sync resumes after reconnecting.</s-banner>}
      {outage&&<s-banner tone="warning" heading="Development test: HotWax unavailable"/>}
      {route==='opening'&&<s-section heading={opening?.name||'Session'}><s-stack direction="block" gap="base">
        <s-text>{busy?'Opening session…':'The session could not be opened.'}</s-text>
        {busy?<s-text color="subdued">Loading saved quantities and checking session access.</s-text>:<s-button variant="primary" onClick={()=>open(opening.sessionId,undefined,opening.name)}>Try again</s-button>}
      </s-stack></s-section>}
      {route==='home'&&<>
        {contextProduct&&<s-banner tone="info" heading={`Count ${contextProduct.sku||contextProduct.title}`}>Choose a session or start a count. Product identity has been confirmed in HotWax.</s-banner>}
        {resume&&<s-section heading="Continue your count"><s-stack direction="block" gap="base"><s-text>{resume.name}</s-text><s-button variant="primary" disabled={busy} onClick={()=>open(resume.sessionId)}>Resume counting</s-button></s-stack></s-section>}
        {history?.canCreate&&<s-stack direction="inline"><s-button variant={resume?'secondary':'primary'} disabled={busy} onClick={()=>go('new')}>Create count</s-button></s-stack>}
        <s-section heading="Store counts"><s-stack direction="block" gap="base">
          <s-tabs value={group} disabled={busy} onChange={e=>{const next=e.currentTarget.value;setGroup(next);run(()=>refresh(0,next));}}><s-tab-list><s-tab controls="active">Active</s-tab><s-tab controls="submitted">Approval</s-tab><s-tab controls="history">History</s-tab></s-tab-list><s-tab-panel id="active"/><s-tab-panel id="submitted"/><s-tab-panel id="history"/></s-tabs>
          {history?.counts.map(item=><ActionRow key={item.workEffortId} title={item.name} detail={`${countTypeName(item.type)} · ${amount(item.sessions,'session')}${item.mySessions?` · ${item.mySessions} yours`:''}`} meta={workStatus(item.statusId)} disabled={busy} onClick={()=>{setWorkId(item.workEffortId);go('work');}}/>)}
          {history&&!history.counts.length&&<s-text color="subdued">{group==='active'?'No counts are scheduled for this store. Start a hard count when you are ready.':'No counts in this view.'}</s-text>}
          {history&&(history.pageIndex>0||history.nextPage!==null)&&<s-stack direction="inline" gap="base"><s-button disabled={busy||!history.pageIndex} onClick={()=>run(()=>refresh(history.pageIndex-1))}>Previous</s-button><s-text>Page {history.pageIndex+1}</s-text><s-button disabled={busy||history.nextPage===null} onClick={()=>run(()=>refresh(history.nextPage))}>Next</s-button></s-stack>}
        </s-stack></s-section>
        {!history&&error&&<s-button variant="primary" disabled={busy} onClick={()=>run(()=>refresh())}>Reconnect to HotWax</s-button>}
      </>}
      {count&&['count','context'].includes(route)&&<s-stack direction="block" gap="large">
        {count.countType==='DYNAMIC_COUNT'&&<s-text color="subdued">Dynamic count · Count all units of each product across the store, including back stock. Your team’s sessions are added together.</s-text>}
        {(!leaseActive||lockUnverified||!lease?.owned)&&count.editable&&<s-section heading={leaseActive&&!lease.owned?'Session in use':'Check device ownership'}><s-stack direction="block" gap="base"><s-text>{leaseProblem||(!connected||outage?'Reconnect to confirm this terminal’s lock.':leaseActive&&!lease.owned?'This session is locked on another terminal. Tap the lock badge for details.':'No active lock is confirmed. Recheck ownership to continue.')}</s-text><s-button disabled={busy||!connected} onClick={reclaim}>Recheck ownership</s-button></s-stack></s-section>}
        {route==='context'&&selected?<s-section heading={selected.title}><s-stack direction="block" gap="base"><s-text>{selected.sku} · {selected.quantity??0} counted here</s-text><s-button variant="primary" disabled={busy||!canCount} onClick={async()=>{if(await enqueue({code:selected.sku||selected.productId,productId:selected.productId,source:'product-context'})){context.current=null;setContextProduct(null);go('count');}}}>Count one unit</s-button><s-button disabled={busy||!canCount} onClick={()=>go('product')}>Enter a total quantity</s-button></s-stack></s-section>:<>
          <ScanFeedback last={last} hidMode={hidMode}/>
          <s-stack direction="inline" gap="base">
            {sources.includes('camera')&&<s-button disabled={busy||!canCount} onClick={()=>{setHidMode(false);shopify.scanner.showCameraScanner();}}>Scan with camera</s-button>}
            <s-button variant={hidMode?'primary':'secondary'} disabled={busy||!canCount} onClick={()=>{shopify.scanner.hideCameraScanner();setHidMode(value=>!value);}}>Use HID scanner</s-button>
            <s-button disabled={busy||!canCount} onClick={()=>{setHidMode(false);go('hand');}}>Hand count</s-button>
          </s-stack>
          {hidMode&&<HidBarcodeEntry key={count.sessionId} disabled={busy||!canCount} add={enqueue}/>}
          <s-box minBlockSize="24px"><s-clickable onClick={()=>go('options')}><s-text color="subdued" tone={syncError?'critical':'auto'}>{syncError?'Sync needs attention':saving?'Syncing…':stats?.dirty?`${amount(stats.dirty,'product')} pending sync`:stats?.pending?'Matching scans…':'Up to date'}</s-text></s-clickable></s-box>
          <s-button variant="primary" loading={busy} disabled={busy||saving||!canCount||!count.canSubmit||!count.items.some(item=>item.quantity!=null)||stats?.pending>0} onClick={submit}>Submit session</s-button>
        </>}
      </s-stack>}
      {count&&route==='hand'&&<HandCount setHeader={setHeader} onBusyChange={setBusy} disabled={!canCount} request={request} engine={engine.current} storage={storage} owner={owner} count={count} done={saved=>{if(saved)showRecordedScans();go(sessionRoute);}}/>}
      {count&&route==='match'&&issue&&<><s-text>Match {issue.code} to the correct OMS product. Its saved quantity will be kept.</s-text><CatalogPicker request={request} disabled={busy||!canCount} onPick={product=>run(async()=>{await engine.current.matchUnmatched(issue.id,product);showUnmatchedScans();})}/></>}
      {count&&route==='editSession'&&<>
        <s-text-field label="Session name" value={editName} disabled={busy} onInput={e=>setEditName(e.currentTarget.value)}/>
        <s-choice-list values={[editArea]} onChange={e=>setEditArea(e.currentTarget.values[0])}>{[['back_stock','Back stock'],['display','Display'],['floor_wall','Floor wall'],['floor_shelf','Floor shelf'],['overflow','Overflow'],['register','Register']].map(([id,label])=><s-choice key={id} value={id} disabled={busy}>{label}</s-choice>)}</s-choice-list>
        <s-button variant="primary" disabled={busy||!canCount} onClick={()=>run(async()=>{await engine.current.prepareSubmission();const result=await ownership.current.write('editSession',{sessionId:count.sessionId,name:editName,area:editArea});await attach(result);})}>Save session</s-button>
      </>}
      {count&&route==='discard'&&<><s-text>Discard {count.name}? Its quantities will be excluded from the team count. Other sessions stay available.</s-text><s-button variant="primary" disabled={busy||!canCount} onClick={()=>run(async()=>{await engine.current.prepareSubmission();const result=await ownership.current.write('discardSession',{sessionId:count.sessionId});await ownership.current.release();await attach(result);})}>Discard this session</s-button></>}
      {count&&route==='forceRelease'&&<><s-text>Make sure counting has stopped on {lease?.deviceId}. Taking over ends its current lock; unsynced scans on that register must be reconciled before use.</s-text><s-button variant="primary" disabled={busy} onClick={()=>run(async()=>{await request('leaseForceRelease',{sessionId:count.sessionId,lease});await ownership.current.claim();setLeaseProblem('');go('count');})}>Release lock and take over</s-button></>}
      {route==='camera'&&<><s-text type="strong">Camera counting mode</s-text><s-choice-list values={[cameraMode]} onChange={e=>setCameraMode(e.currentTarget.values[0])}><s-choice value="rapid">Rapid: add one unit per scan</s-choice><s-choice value="confirm">Confirm: enter a quantity after each scan</s-choice></s-choice-list><s-text color="subdued">Rapid mode ignores the same camera barcode for one second. Hardware scanner repeats remain separate scans.</s-text><s-button variant="primary" onClick={()=>go('count')}>Done</s-button></>}
      {route==='cameraConfirm'&&<><s-section heading={cameraProduct?.title||cameraCode}><s-stack direction="block" gap="base"><s-text>{cameraCode}</s-text><s-text color="subdued">{cameraProduct?.productId?`${count?.items.find(p=>p.productId===cameraProduct.productId)?.quantity||0} already counted`:'The scan will be saved and matched in HotWax.'}</s-text><s-number-field label="Additional units" value={cameraQuantity} min={1} max={1000000} onInput={e=>setCameraQuantity(e.currentTarget.value)}/></s-stack></s-section><s-button variant="primary" disabled={busy||!canCount} onClick={async()=>{if(await enqueue({code:cameraCode,quantity:Number(cameraQuantity),product:cameraProduct,productId:cameraProduct?.productId,source:'camera-confirm'}))go('count');}}>Add units</s-button></>}
      {count&&route==='product'&&selected&&(canCount?<QuantityEditor key={selected.productId} item={selected} disabled={busy} onSave={async job=>{if(await enqueue(job)){await engine.current.aggregate();go(sessionRoute);}}}/>:<s-section heading={selected.title}><s-stack direction="block" gap="base"><s-text>{selected.sku} · {selected.quantity==null?'Not counted':`${selected.quantity} counted`}</s-text>{count.canViewOnHand&&<s-text>On hand {selected.onHand??'unavailable'}</s-text>}</s-stack></s-section>)}
      {count&&route==='submitted'&&<><s-banner tone="success" heading="Saved in HotWax"/><s-text>Your session is submitted. Return to the count summary to finish the whole count and send it for approval.</s-text><s-button variant="primary" disabled={busy} onClick={()=>leave(true)}>Count summary</s-button></>}
      {count&&route==='readonly'&&<><s-section heading={countStatus(count)}><s-stack direction="block" gap="base"><s-text>You can view this session. Use session options to reopen a submitted session while the count is in progress.</s-text></s-stack></s-section><ActionRow title="Count summary" onClick={()=>leave(true)}/></>}
      {route==='issue'&&(issue||matchingFeedback?.id===issueId)&&<>
        <s-section heading={issue?.code||matchingFeedback?.code}><s-stack direction="block" gap="base">
          <s-text type="strong">{matchingFeedback?.pending?'Checking HotWax…':matchingFeedback?.failed?'Matching could not finish':matchingFeedback?.remaining?'Still unmatched':!issue?'Scan matched':'Unmatched scan'}</s-text>
          <s-text>{matchingFeedback?.pending?'Looking for a matching OMS product.':matchingFeedback?.reason||(!issue&&matchingFeedback?.product?`${matchingFeedback.product.title} · ${matchingFeedback.product.quantity} counted in this session`:issue?.message)}</s-text>
          <s-text color="subdued">{issue?'Your scan is saved. Find the correct OMS product or check its barcode. Removing this scan excludes it from your count.':'The matched quantity is saved on this device and will sync automatically.'}</s-text>
        </s-stack></s-section>
        {issue?<>
          <s-button variant="primary" disabled={busy||!canCount} onClick={()=>go('match')}>Find the correct OMS product</s-button>
          <s-button loading={!!matchingFeedback?.pending} disabled={busy||!canCount} onClick={()=>retryMatching(issue)}>Retry matching</s-button>
          <s-button disabled={busy||!canCount} onClick={()=>run(async()=>{await engine.current.discardUnmatched(issue.id);showUnmatchedScans();})}>Remove this unmatched scan</s-button>
        </>:<s-button variant="primary" disabled={busy} onClick={()=>showUnmatchedScans()}>Back to unmatched scans</s-button>}
      </>}
      {route==='compare'&&<>{conflicts.length?<s-section heading={`${conflicts.length} quantities to reconcile`}><s-stack direction="block" gap="base"><s-text type="strong">{conflicts[0].sku||conflicts[0].title}</s-text><s-text>This device: {conflicts[0].quantity} · HotWax: {conflicts[0].serverQuantity??'Not counted'}</s-text>{[false,true].map(useServer=><s-button key={String(useServer)} disabled={busy} onClick={()=>run(async()=>{const item=conflicts[0];await engine.current.reconcile(item.productId,item.serverQuantity,useServer);setConflicts(old=>old.slice(1));if(conflicts.length===1){setSyncError('');go('count');}})}>{useServer?'Use HotWax quantity':'Keep this device’s quantity'}</s-button>)}</s-stack></s-section>:<s-banner tone="success" heading="No unsynced quantities to reconcile"/>}</>}
      {route==='options'&&<>
        {count?<>
          {count.editable&&<ActionRow title="Edit session" detail="Change session details" disabled={busy||!canCount} onClick={()=>{setEditName(count.name);setEditArea(count.area);go('editSession');}}/>}
          {count.editable&&<ActionRow title="Discard session" detail="Exclude this session from the count" disabled={busy||!canCount} onClick={()=>go('discard')}/>}
          {count.statusId==='SESSION_SUBMITTED'&&count.countStatusId==='CYCLE_CNT_IN_PRGS'&&<ActionRow title="Reopen session" detail="Continue counting or correct submitted quantities" disabled={busy} onClick={()=>run(async()=>{const result=await request('reopenSession',{sessionId:count.sessionId});await attach(result);})}/>}
          {count.editable&&!lease?.owned&&lease?.fromDate&&(count.canRelease||lease.operator===count.currentOperator)&&<ActionRow title="Take over session" detail="Release the current device lock" disabled={busy} onClick={()=>go('forceRelease')}/>}
          {count.editable&&sources.includes('camera')&&<ActionRow title="Camera counting" detail={cameraMode==='rapid'?'Rapid scanning':'Confirm quantity after scanning'} onClick={()=>go('camera')}/>}
          <s-text color="subdued">{syncText}</s-text>{syncError&&<s-banner tone="warning" heading={syncError}/>}
          {count.editable&&<><ActionRow title="Retry sync" detail={`${pending} pending changes`} disabled={busy||saving} onClick={sync}/><ActionRow title="Compare with HotWax" detail="Resolve a quantity changed on another device" disabled={busy||saving} onClick={compare}/><ActionRow title="Save and release this session" detail="Let another register resume it" disabled={busy||saving||!canCount} onClick={()=>run(async()=>{await engine.current.prepareSubmission();await ownership.current.release();await settle();setCount(null);engine.current=null;go('home');await refresh();})}/></>}
          {!count.editable&&count.statusId==='SESSION_SUBMITTED'&&<ActionRow title="Remove local copy" detail="Only after HotWax confirms the submitted quantities" onClick={()=>go('remove')}/>}
          <ActionRow title="All store counts" onClick={()=>leave(false)}/>
          <s-text color="subdued">{shopify.device.name} · {shopify.device.registerName}</s-text>
          {count.editable&&<s-stack direction="block" gap="small"><s-stack direction="inline"><s-badge tone={lockTone}>{lockLabel}</s-badge></s-stack>{lease?.deviceId&&<s-text>Lock terminal: {lease.deviceId}{lease.operator?` · ${lease.operator}`:''}</s-text>}{lease?.lastHeartbeatAt&&<s-text color="subdued">Last heartbeat: {new Date(lease.lastHeartbeatAt).toLocaleTimeString()}</s-text>}</s-stack>}
        </>:<><ActionRow title="Refresh store counts" onClick={()=>run(async()=>{await refresh();go('home');})}/><ActionRow title="Saved sessions on this device" meta={String(catalog.length)} onClick={()=>go('saved')}/></>}
        {LOCAL_OMS_PREVIEW&&<ActionRow title="Development diagnostics" onClick={()=>go('diagnostics')}/>}
      </>}
      {route==='saved'&&<>{catalog.slice(localPage*20,(localPage+1)*20).map(item=><ActionRow key={item.sessionId} title={item.name||item.sessionId} meta={editable(item.statusId)?'Resume':'View'} disabled={busy} onClick={()=>open(item.sessionId)}/>)}{!catalog.length&&<s-text>No saved sessions for this operator at this store.</s-text>}<CompactPager page={localPage} pages={Math.max(1,Math.ceil(catalog.length/20))} total={catalog.length} label="sessions" onPage={setLocalPage}/></>}
      {route==='remove'&&<><s-text>This removes this session’s scan history from this register. Submitted quantities stay in HotWax.</s-text><s-button variant="primary" disabled={busy} onClick={removeLocal}>Remove verified local copy</s-button></>}
      {LOCAL_OMS_PREVIEW&&route==='diagnostics'&&<><s-text>{stats?`${stats.events} saved events · ${stats.pending} unmatched · ${stats.dirty} products to sync`:'No session open'}</s-text><s-button disabled={busy} onClick={()=>go('probe')}>Check 5,000-product list</s-button><s-button disabled={busy} onClick={()=>run(async()=>setProbe(await probePagedStorage(shopify.storage,owner,setProbe)))}>Check 50,000-scan storage</s-button><s-button disabled={busy} onClick={()=>run(async()=>{await simulateOmsOutage(!outage);setOutage(!outage);})}>{outage?'Restore HotWax connection':'Simulate HotWax outage'}</s-button>{probe&&<s-text>{probe}</s-text>}</>}
      {LOCAL_OMS_PREVIEW&&route==='probe'&&<ListProbe close={()=>go('diagnostics')}/>}
      {count&&isSessionDetail&&<s-tabs value={sessionTab} onChange={e=>selectSessionTab(e.currentTarget.value)}>
        <s-tab-list>{sessionTabs.map(([id,label])=><s-tab key={id} controls={id}>{label}</s-tab>)}</s-tab-list>
        {sessionTabs.map(([id])=><s-tab-panel key={id} id={id}>
          {sessionTab===id&&(id==='scans'?<s-stack direction="block" gap="base">
            <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="base">
              <s-stack direction="inline" gap="small">
                <s-button variant={scanFilter==='all'?'primary':'secondary'} onClick={()=>{setScanFilter('all');setScanPage(0);setMatchingFeedback(null);}}>All events</s-button>
                <s-button variant={scanFilter==='unmatched'?'primary':'secondary'} onClick={()=>{setScanFilter('unmatched');setScanPage(0);setMatchingFeedback(null);}}>Unmatched ({stats?.pending||0})</s-button>
              </s-stack>
              {scanFilter==='unmatched'&&<s-button loading={!!matchingFeedback?.pending} disabled={busy||!canCount||!stats?.pending} onClick={()=>retryMatching()}>Retry matching</s-button>}
            </s-stack>
            {scanFilter==='unmatched'&&matchingFeedback&&!matchingFeedback.pending&&<s-banner tone={matchingFeedback.failed?'critical':matchingFeedback.remaining?'warning':'success'} heading={matchingFeedback.failed?'Matching could not finish':`${amount(matchingFeedback.matched,'scan')} matched · ${matchingFeedback.remaining} still unmatched`}>{matchingFeedback.reason||'Matched quantities are saved on this device and will sync automatically.'}</s-banner>}
            <s-text-field label="Find a scan event" value={scanSearch} onInput={e=>{setScanSearch(e.currentTarget.value);setScanPage(0);}}/>
            <s-text color="subdued">Scan history saved on this register</s-text>
            {scanHistory?.items.map(event=><ScanEventRow key={event.id} event={event} disabled={busy||!canCount} onMatch={event=>{setIssueId(event.id);go('issue');}} onUndo={event=>run(async()=>{if(event.aggApplied===0)await engine.current.discardUnmatched(event.id);else await engine.current.undoScan(event.id);})}/>)}
            {!scanHistory?.total&&<s-text>No scan events match this view.</s-text>}
            {scanHistory&&<CompactPager {...scanHistory} label="events" disabled={busy} onPage={setScanPage}/>}
          </s-stack>:<ProductList key={id} items={count.items} disabled={busy} memory={listMemory.current} activeView={id} showTabs={false} countExtras onSelect={selectProduct}/>)}
        </s-tab-panel>)}
      </s-tabs>}
    </s-stack></s-box></s-scroll-box>
  </>;
}
