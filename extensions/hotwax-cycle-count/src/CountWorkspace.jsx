import {useCallback,useEffect,useRef,useState} from 'preact/hooks';
import {CountState,readSavedSession} from './count-state';
import {CountStorage} from './count-storage';
import {CountLease} from './count-lease';
import {enterForeground} from './count-coordination';
import {controlFor} from './count-control';
import {IdentityMap} from './count-identity';
import {bindCountRequest,currentCountOwner,currentAuditContext,countStatus,countTypeName,workStatus,subscribeScans,omsScope,createMemberSearch,AREAS} from './count-api';
import {CountFlow} from './CountFlow.jsx';
import {CreateCount} from './CreateCount.jsx';
import {HandCount} from './HandCount.jsx';
import {CatalogPicker} from './CatalogPicker.jsx';
import {ProductList,CompactPager} from './ProductList.jsx';
import {ActionRow,QuantityEditor,BackButton,DividedRows,amount} from './FlowParts.jsx';
import {HidBarcodeEntry} from './CountInputs.jsx';
import {ScanEventRow} from './ScanEventRow.jsx';
import {ScanFeedback} from './ScanFeedback.jsx';
import {pruneLocalSessions,removeLocalSession,localCopyRemovable} from './count-cleanup';
import {recoverSubmission,sessionSubmitted} from './count-submission';
import {CountListIndex} from './count-list';
import {COUNT_SESSION,COUNT_SUMMARY} from './count-navigation';
import {CountQuantityEdits} from './count-quantity-edits';
import {abortable,assertNotAborted,REQUEST_TIMEOUT} from '../../../shared/abortable';

const message=f=>f instanceof Error?f.message:'Could not complete this action. Your saved work is retained.';
const editable=status=>['SESSION_CREATED','SESSION_ASSIGNED'].includes(status);
// Same view names as the count summary's product list, plus this session's scans.
const sessionTabs=[['all','All'],['uncounted','Uncounted'],['counted','Counted'],['scans','Scans']];
// The native stack owns count summaries and sessions. These back targets
// keep in-session tools with the active count engine.
const ROUTES={
  scanHistory:{title:'Scan history',back:'session'},opening:{title:'Opening session'},home:{title:'Cycle count'},new:{title:'Create count'},hand:{title:'Hand count'},
  match:{title:'Match product',back:'issue'},editSession:{title:'Edit session',back:'options'},discard:{title:'Discard session',back:'options'},
  forceRelease:{title:'Take over session',back:'options'},camera:{title:'Camera counting',back:'options'},cameraConfirm:{title:'Confirm quantity'},
  work:{title:'Count summary'},count:{back:'summary'},readonly:{back:'summary'},submitted:{title:'Session submitted',back:'summary'},
  context:{title:'Count this product',back:'summary'},product:{title:'Count quantity',back:'session'},issue:{title:'Check this scan',back:'unmatched'},
  compare:{title:'Resolve quantity'},options:{},saved:{title:'Saved sessions',back:'options'},remove:{title:'Remove local copy',back:'options'},
};
const BACK_LABELS={summary:'Count summary',session:'Session details'};
const OPEN_CANCELLED=Symbol('open cancelled');

export function CountWorkspace({owner,page,entryKey,setHeader}) {
  const [route,setRoute]=useState(page.kind==='session'?'opening':page.kind),[workId,setWorkId]=useState(page.workEffortId||null),[history,setHistory]=useState(null),[group,setGroup]=useState('active');
  const [workRevision,setWorkRevision]=useState(0);
  const [opening,setOpening]=useState(page.kind==='session'?page:null),[completing,setCompleting]=useState(false);
  const [matchingFeedback,setMatchingFeedback]=useState(null);
  const [hidMode,setHidMode]=useState(false);
  const [count,setCount]=useState(null),[stats,setStats]=useState(null),[catalog,setCatalog]=useState([]),[busy,setBusy]=useState(true),[error,setError]=useState('');
  const [saving,setSaving]=useState(false),[syncError,setSyncError]=useState(''),[lastSynced,setLastSynced]=useState(null);
  const [lease,setLease]=useState(null),[leaseProblem,setLeaseProblem]=useState(''),[connected,setConnected]=useState(shopify.connectivity.current.value.internetConnected==='Connected');
  const [leaseNow,setLeaseNow]=useState(Date.now());
  const [showLockDetails,setShowLockDetails]=useState(false);
  const quantityEdits=useRef(null);
  const [sources,setSources]=useState(shopify.scanner.sources.current.value),[productId,setProductId]=useState(null);
  const [contextProduct,setContextProduct]=useState(null),[conflicts,setConflicts]=useState([]),[issueId,setIssueId]=useState(null),[localPage,setLocalPage]=useState(0);
  const [scanPage,setScanPage]=useState(0),[scanSearch,setScanSearch]=useState(''),[scanFilter,setScanFilter]=useState('all');
  const [sessionTab,setSessionTab]=useState('all');
  const [editName,setEditName]=useState(''),[editArea,setEditArea]=useState('register'),[cameraMode,setCameraMode]=useState('rapid'),[cameraCode,setCameraCode]=useState(''),[cameraQuantity,setCameraQuantity]=useState('1'),[cameraProduct,setCameraProduct]=useState(null);
  const cameraRef=useRef({mode:'rapid',code:'',at:0});
  cameraRef.current.mode=cameraMode;
  const services=useRef(null);
  if(!services.current){
    const storage=new CountStorage(shopify.storage);
    services.current={storage,request:bindCountRequest(owner),listIndex:new CountListIndex(),control:controlFor(shopify.storage,owner),
      identity:new IdentityMap(storage),search:createMemberSearch(shopify.productSearch)};
  }
  const {storage,request,control,identity}=services.current;
  const engine=useRef(null),ownership=useRef(null),alive=useRef(true),running=useRef(false),gate=useRef(false),latest=useRef(null),context=useRef(null);
  // Journal access waits for the background uploader; showing counts does not.
  const foreground=useRef(null),pruning=useRef(Promise.resolve()),removal=useRef(Promise.resolve()),opened=useRef(false),cancelOpen=useRef(null),navigating=useRef(false);
  async function migrateSaved() {
    // Oldest first: each open moves its session to the front, which rebuilds the
    // newest-first order (an interrupted pass is completed the same way next time).
    for(const entry of [...(await control.read()).catalogue].reverse()){
      if(!own()||opened.current)return;
      const [items,events]=[await storage.metadata(entry.itemKey),await storage.metadata(entry.eventKey)];
      if(!items.legacy&&!events.legacy)continue;
      let saved;
      try {saved=await readSavedSession(storage,entry);} catch {continue;}
      if(!saved||!own()||opened.current)continue;
      const state=new CountState(storage,owner,()=>Promise.reject(new Error('Migration does not contact HotWax.')),()=>{},saved.audit||{},()=>{},{control});
      await (removal.current=state.open(saved)).catch(()=>{});
    }
  }
  const hydrateRows=useCallback(rows=>{engine.current?.hydrate(rows.map(row=>row.variantId)).catch(()=>{});},[]);
  // Product search through Shopify, limited to this session's products by variant.
  const searchMembers=useCallback((query,needed,wanted)=>{
    const state=engine.current;
    // Product search is not available offline; local matches still show.
    if(!state||shopify.connectivity.current.value.internetConnected!=='Connected')return Promise.resolve(null);
    return services.current.search(query,needed,state.itemList,(variantId,display)=>state.rememberVariant(variantId,display),wanted);
  },[]);
  const listMemory=useRef({search:'',view:'all',page:0});
  const selectProduct=useCallback(item=>{setProductId(item.productId);go('product');},[]);
  const own=()=>alive.current&&currentCountOwner()===owner;
  const hasScanLock=()=>own()&&!!engine.current?.active&&!!engine.current.count?.editable&&!!ownership.current?.canScan(engine.current.count.sessionId,currentAuditContext().deviceId);
  const canCount=!!count?.editable&&hasScanLock();
  const leaseActive=!!lease&&!lease.available&&(lease.expiresAt==null||lease.expiresAt>leaseNow);
  const offlineCounting=!connected&&canCount;
  const lockedElsewhere=!!lease&&!lease.available&&!lease.owned;
  const lockUnverified=!connected||!!leaseProblem||!lease||!ownership.current?.confirmed;
  const lockLabel=offlineCounting?'Offline · saving on this terminal':lockedElsewhere?'Locked on another terminal':lockUnverified?'Lock needs recheck':!leaseActive?'Session not locked':'Locked to this terminal';
  const lockTone=lockedElsewhere?'critical':lockUnverified||!leaseActive?'warning':'success';
  const sessionRoute=count?.statusId==='SESSION_SUBMITTED'?'submitted':count?.editable?'count':'readonly';
  latest.current={route,count,stats,canCount,busy,connected,hidMode,group,pageIndex:history?.pageIndex||0};
  gate.current=canCount&&!busy&&route==='count';
  const title=route==='count'?count?.name||'Count items':route==='readonly'?count?.name||'Session details':route==='options'?(count?'Session options':'Count options'):ROUTES[route]?.title||'Cycle count';
  const sessionToolbar=route==='count'&&!!count?.editable;
  const emptySession=sessionToolbar&&count.items.length===0&&!stats?.pending;
  const completionDisabled=busy||!connected||!canCount||!count?.canSubmit||emptySession;
  useEffect(()=>{
    if(['work','hand'].includes(route))return;
    // The toolbar stays in place when iPadOS dismisses the keyboard on a tap.
    const action=sessionToolbar
      ?{label:'Complete session',loading:completing,disabled:completionDisabled,onClick:completeSession}
      :route==='new'?null:{label:route==='options'?'Done':'More',loading:busy,disabled:busy||route==='opening',
        onClick:()=>go(route==='options'?(count?sessionRoute:'home'):'options')};
    setHeader({heading:title,subheading:history?.facilityName||'',action});
  },[route,title,history?.facilityName,busy,sessionRoute,sessionToolbar,completionDisabled,completing]);
  function go(next) {gate.current=false;shopify.scanner.hideCameraScanner();setError('');setMatchingFeedback(null);setRoute(next);}
  async function releaseForeground() {
    const held=foreground.current;
    if(!held)return;
    foreground.current=null;
    try {await (await held)?.();} catch { /* The heartbeat expires if its cleanup fails. */ }
  }
  async function openPage(screen,state) {
    if(navigating.current||!own())return false;
    navigating.current=true;setError('');
    try {
      // Stop home-screen maintenance before a child runtime can write the same journal.
      opened.current=true;
      await removal.current.catch(()=>{});
      await releaseForeground();
      if(!own()||navigation.currentEntry?.key!==entryKey)return false;
      const variantId=page.variantId||shopify.product?.variantId;
      await navigation.navigate(screen,{state:{owner,variantId,...state}});
      return true;
    } catch {
      if(own())setError('Shopify POS could not open the page. Try again.');
      return false;
    } finally {navigating.current=false;}
  }
  function open(sessionId,name='') {
    return openPage(COUNT_SESSION,{sessionId,name,fromSummary:route==='work'});
  }
  function returnToParent() {
    if(own()&&navigation.currentEntry?.key===entryKey)navigation.back();
  }
  function selectSessionTab(next) {
    if(!sessionTabs.some(([id])=>id===next))return;
    if(next!==sessionTab){listMemory.current.page=0;setScanPage(0);}
    setSessionTab(next);
  }
  async function run(fn) {
    if(running.current||!own())return;
    running.current=true;setBusy(true);setError('');gate.current=false;
    try {return await fn();}catch(failure){if(own()&&failure!==OPEN_CANCELLED)setError(message(failure));}
    finally{running.current=false;if(own())setBusy(false);}
  }
  async function refresh(pageIndex=0,selectedGroup=group) {
    const local=await control.read(true);
    if(own())setCatalog(local.catalogue);
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
  async function attach(result,claimed=undefined,signal=undefined) {
    const step=work=>abortable(work,signal);
    await step(()=>foreground.current);
    await step(settle);if(!own())return;
    quantityEdits.current=new CountQuantityEdits(writeQuantity);
    setStats(null);setLease(null);setLeaseProblem('');setShowLockDetails(false);setSyncError('');setConflicts([]);setLastSynced(null);
    listMemory.current={search:'',view:'all',page:0};
    setSessionTab('all');setScanSearch('');setScanPage(0);setScanFilter('all');
    const selected=context.current;
    if(selected&&result.editable&&!result.items.some(item=>item.productId===selected.productId))
      result={...result,items:[...result.items,{...selected,quantity:null,isRequested:result.countType!=='DIRECTED_COUNT'}]};
    // The shared variant -> HotWax mapping belongs to this shop and OMS connection.
    const scope=await step(omsScope);if(scope.oms)await step(()=>identity.load(scope));
    const claim=new CountLease(storage,owner,request,value=>{if(own()&&!signal?.aborted)setLease(value);},
      ()=>shopify.connectivity.current.value.internetConnected!=='Connected');
    ownership.current=claim;
    if(result.editable)try{await step(()=>claim.open(result.sessionId,!latest.current.connected,claimed));}catch(failure){assertNotAborted(signal);if(own())setLeaseProblem(message(failure));}
    const send=(action,payload)=>['saveBatch','submit','editSession','discardSession'].includes(action)?claim.write(action,payload):request(action,payload);
    Object.assign(send,request);
    const state=new CountState(storage,owner,send,(value,nextStats)=>{
      if(!own()||!state.active||signal?.aborted)return;
      setCount({...value});setStats(nextStats);
    },currentAuditContext(),()=>{
      if(!own()||ownership.current!==claim)throw new Error('Reopen this session to acquire its lock.');
      claim.assertCanScan(result.sessionId,currentAuditContext().deviceId);
    },{control,identity:scope.oms?identity:null});
    engine.current=state;
    try {await step(()=>state.open(result));}catch(failure){state.active=false;claim.active=false;throw failure;}
    if(!own()){state.active=false;claim.active=false;return;}
    if(result.editable)state.aggregate().catch(failure=>{if(own())setSyncError(message(failure));});
    setRoute(!result.editable?(result.statusId==='SESSION_SUBMITTED'?'submitted':'readonly'):selected?'context':'count');
    if(selected)setProductId(selected.productId);
  }
  async function loadSession(sessionId,name='') {
    return run(async()=>{
      // Acknowledge the tap before OMS, lease or local-storage work starts.
      setOpening({sessionId,name:name||'Session'});
      setHidMode(false);go('opening');
      // Back covers local loading too. A late native acknowledgement must not
      // publish a session or accept scans after the user has left this screen.
      const controller=new AbortController(),signal=controller.signal;
      const cancel=()=>controller.abort(OPEN_CANCELLED);
      cancelOpen.current=cancel;
      const timer=setTimeout(()=>controller.abort(new Error(REQUEST_TIMEOUT)),65000);
      const step=work=>abortable(work,signal);
      try {
        const online=latest.current.connected;
        // The lease claim and the session detail are independent, so start both now.
        const claimed=online?request('leaseClaim',{sessionId},{signal}):undefined;
        claimed?.catch(()=>{});
        let result;
        try{result=await step(()=>request('detail',{sessionId},{signal}));}catch(failure){
          assertNotAborted(signal);
          if(online)throw failure;
          const entry=(await step(()=>control.read())).catalogue.find(item=>item.sessionId===sessionId);
          const cached=entry&&await step(()=>readSavedSession(storage,entry));
          if(!cached)throw failure;
          result=cached;
        }
        // Cleanup stops at its next session; only a removal already under way is awaited.
        opened.current=true;
        await step(()=>removal.current.catch(()=>{}));
        await attach(result,result.editable?claimed:undefined,signal);
      }finally{clearTimeout(timer);if(cancelOpen.current===cancel)cancelOpen.current=null;}
    });
  }
  async function closeSession() {
    await settle();
    engine.current=null;ownership.current=null;
    setCount(null);setStats(null);setLease(null);
    await identity.flush().catch(()=>{});
    await releaseForeground();
  }
  async function leave(toWork=true) {
    return run(async()=>{
      const id=engine.current?.count.workEffortId;
      await closeSession();
      if(!toWork||page.fromSummary)returnToParent();
      else if(own()){setWorkId(id);go('work');}
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
  const writeQuantity=useCallback(async(item,change)=>{
    const state=engine.current;
    const id=await enqueue({productId:item.productId,code:item.productIdentifier||item.sku||item.productId,source:'correction',...change});
    if(!id)return null;
    try {await state.aggregate();return state.items.items[item.productId]?.quantity;}
    catch(failure){if(own())setError(message(failure));return null;}
  },[]);
  const changeQuantity=useCallback((item,change)=>quantityEdits.current.commit(item,change),[]);
  const editQuantity=useCallback((item,text)=>quantityEdits.current.setDraft(item,text),[]);
  function showRecordedScans() {
    if(latest.current.count?.countType==='DYNAMIC_COUNT')return;
    setScanSearch('');setScanPage(0);setScanFilter('all');setSessionTab('scans');
  }
  function showUnmatchedScans() {
    setScanFilter('unmatched');setScanPage(0);setSessionTab('scans');
    go(count?.countType==='DYNAMIC_COUNT'?'scanHistory':sessionRoute);
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
      const differences=state.itemList.filter(item=>item.revision!==item.syncedRevision).map(item=>({...state.view(item),serverQuantity:remote.items.find(row=>row.productId===item.productId)?.quantity??null}));
      setConflicts(differences);go('compare');
    });
  }
  async function completeSession() {
    await run(async()=>{
      const state=engine.current,claim=ownership.current,sessionId=state.count.sessionId,workEffortId=state.count.workEffortId;
      const current=()=>own()&&engine.current===state&&navigation.currentEntry?.key===entryKey;
      setCompleting(true);
      try {
        const result=await recoverSubmission({
          read:()=>request('submissionStatus',{sessionId}),
          prepare:async()=>{
            await quantityEdits.current.flush();
            await state.prepareSubmission();
            if(!state.itemList.some(item=>item.quantity!=null))throw new Error('Count at least one product before completing this session.');
          },
          write:()=>claim.write('submit',{sessionId,compact:true}),
          done:sessionSubmitted,current,
        });
        await claim.release().catch(()=>{});
        await state.open({...state.count,...result,editable:false,items:state.itemViews});
        context.current=null;setContextProduct(null);setLeaseProblem('');
        await closeSession();
        if(page.fromSummary)returnToParent();
        else if(own()){setWorkId(workEffortId);go('work');}
      } finally {if(own())setCompleting(false);}
    });
  }
  async function removeLocal() {
    await run(async()=>{
      const state=engine.current;
      if(state.syncing)await state.syncing;if(state.aggregating)await state.aggregating;await state.tail;
      const remote=await request('localCopyStatus',{sessionId:count.sessionId});
      const local={pending:state.events.events.filter(e=>e.aggApplied===0).length,dirty:state.itemList.filter(i=>i.revision!==i.syncedRevision).length,items:state.itemList};
      if(!localCopyRemovable(remote,local))throw new Error(remote.editable?'This session is open in HotWax. Sync and submit it before removing the local copy.':'HotWax has not confirmed every submitted quantity. Your local copy was kept.');
      state.active=false;
      await removeLocalSession(storage,owner,{sessionId:count.sessionId,eventKey:state.eventKey,itemKey:state.itemKey});
      await closeSession();returnToParent();
    });
  }
  useEffect(()=>{
    if(page.kind!=='work') {
      // Converting control first frees the legacy status key even on a full register.
      foreground.current=control.read(true).catch(()=>{}).then(()=>enterForeground(shopify.storage,owner));
      foreground.current.catch(()=>{});
    }
    (async()=>{
      if(page.kind==='work')return;
      const variantId=page.variantId||shopify.product?.variantId;
      if(variantId)try{const selected=await request('contextProduct',{variantId});if(own()){context.current=selected;setContextProduct(selected);}}catch(failure){if(own())setError(message(failure));}
      if(!own())return;
      if(page.kind==='session'){await loadSession(page.sessionId,page.name);return;}
      await refresh();
      // Bring earlier saved sessions into the current journal format and prune finished copies.
      pruning.current=foreground.current.then(migrateSaved).then(()=>pruneLocalSessions({storage,owner,request,keep:engine.current?.count?.sessionId,
        isCurrent:()=>own()&&!opened.current,track:task=>(removal.current=task)}))
        .then(removed=>{if(removed&&own())return control.read().then(local=>{if(own())setCatalog(local.catalogue);});}).catch(()=>{});
    })().catch(failure=>{if(own())setError(message(failure));}).finally(()=>{if(own())setBusy(false);});
    const onEntryChange=event=>{
      if(!own())return;
      if(navigation.currentEntry?.key!==entryKey) {
        gate.current=false;
        cancelOpen.current?.();
        return;
      }
      if(event.from?.key===entryKey)return;
      const current=latest.current;
      if(current.route==='work')setWorkRevision(value=>value+1);
      if(current.route==='home')void run(()=>refresh(current.pageIndex,current.group));
      if(current.route==='saved')void run(async()=>{const local=await control.read(true);if(own())setCatalog(local.catalogue);});
    };
    navigation.addEventListener('currententrychange',onEntryChange);
    const unSources=shopify.scanner.sources.current.subscribe(setSources);
    const unConnection=shopify.connectivity.current.subscribe(value=>{
      if(!own())return;
      const online=value.internetConnected==='Connected';setConnected(online);
      // Counting continued offline on this terminal's lease. Confirm it with OMS
      // as soon as the connection returns so sync can resume.
      const claim=ownership.current;
      if(online&&claim?.value?.owned&&!claim.confirmed&&engine.current?.count?.editable)
        claim.claim().then(lease=>{if(own())setLeaseProblem(lease.owned?'':'This session is locked on another terminal. Tap the lock badge for details.');}).catch(failure=>{if(own())setLeaseProblem(message(failure));});
    });
    const unScans=subscribeScans(shopify.scanner,scan=>{
      if(!gate.current||!hasScanLock()||latest.current.hidMode)return;
      if(scan.source==='camera'){
        const now=Date.now();if(cameraRef.current.code===scan.data&&now-cameraRef.current.at<1000)return;
        cameraRef.current.code=scan.data;cameraRef.current.at=now;
        if(cameraRef.current.mode==='confirm'){
          shopify.scanner.hideCameraScanner();gate.current=false;setCameraCode(scan.data);setCameraQuantity('1');setCameraProduct(null);setRoute('cameraConfirm');
          const cached=engine.current?.view(engine.current.items.items[engine.current.codes.get(scan.data.toLowerCase())]);
          if(cached)setCameraProduct(cached);else request('lookup',{code:scan.data}).then(product=>{if(own())setCameraProduct(product);}).catch(()=>{});
          return;
        }
      }
      enqueue({code:scan.data,source:scan.source}).catch(failure=>{if(own())setError(message(failure));});
    });
    const syncTimer=setInterval(()=>{
      const current=latest.current;
      if(!current.connected||current.busy||!current.canCount)return;
      if(current.stats?.pending||current.stats?.dirty)sync();
    },5000);
    const heartbeat=setInterval(()=>{
      if(running.current||!ownership.current?.value?.owned||!engine.current?.active||!engine.current.count.editable||!own())return;
      ownership.current.renew().then(()=>{if(own())setLeaseProblem('');}).catch(failure=>{if(own())setLeaseProblem(message(failure));});
    },30000);
    const status=setInterval(()=>{
      const current=latest.current;if(!own()||!current.count)return;
      setLeaseNow(Date.now());
      // The tile's status lives in control: write it when it changes, or once a minute to stay fresh.
      const {pending=0,dirty=0}=current.stats||{};
      const next={sessionId:current.count.sessionId,name:current.count.name,pending:pending+dirty,unmatched:pending,
        state:!current.connected?'offline':pending?'attention':dirty?'pending':current.count.editable?'counting':'submitted'};
      control.update(state=>state.status&&Date.now()-state.status.at<60000&&['sessionId','state'].every(field=>state.status[field]===next[field])
        ?null:{...state,status:{...next,at:Date.now()}}).catch(()=>{});
    },5000);
    return()=>{
      alive.current=false;gate.current=false;clearInterval(syncTimer);clearInterval(heartbeat);clearInterval(status);
      navigation.removeEventListener('currententrychange',onEntryChange);
      unSources();unConnection();unScans();shopify.scanner.hideCameraScanner();
      const state=engine.current;if(state)state.active=false;
      if(ownership.current)ownership.current.active=false;
      // Keep background uploads out until an in-flight foreground save finishes.
      cancelOpen.current?.();
      Promise.allSettled([state?.syncing,state?.aggregating,state?.tail,pruning.current,identity.flush()]).then(releaseForeground).catch(()=>{});
    };
  },[]);
  const isSessionDetail=['count','submitted','readonly'].includes(route);
  const dynamic=count?.countType==='DYNAMIC_COUNT';
  const scanHistory=route==='scanHistory'||isSessionDetail&&!dynamic&&sessionTab==='scans'
    ?engine.current?.historyPage(scanSearch,scanPage,scanFilter):null;
  // Names and images are fetched again by Shopify variant for what is on screen only.
  const visibleVariants=[stats?.lastScan?.variantId,...(scanHistory?.items||[]).map(event=>event.variantId)].filter(id=>id!=null).join(',');
  useEffect(()=>{if(visibleVariants)engine.current?.hydrate(visibleVariants.split(',')).catch(()=>{});},[visibleVariants]);
  const resume=catalog.find(item=>editable(item.statusId));
  const selected=count?.items.find(item=>item.productId===productId);
  const issue=stats?.issues?.find(item=>item.id===issueId);
  const last=stats?.lastScan;
  const cameraAvailable=sources.includes('camera');
  const posScannerConnected=sources.includes('external')||sources.includes('embedded');
  function handCount(){setHidMode(false);go('hand');}
  function scanWithCamera(){setHidMode(false);shopify.scanner.showCameraScanner();}
  const pending=(stats?.dirty||0)+(stats?.pending||0);
  // Directed counts measure progress against the requested list; dynamic counts
  // only grow, so they show what has been counted so far.
  // Computed each render: the session engine may update item rows in place.
  const progressText=(()=>{
    if(!count)return '';
    const scope=count.countType==='DIRECTED_COUNT'?count.items.filter(item=>item.isRequested!==false):count.items;
    const counted=scope.filter(item=>item.quantity!=null).length;
    const units=count.items.reduce((total,item)=>total+(item.quantity||0),0);
    return count.countType==='DYNAMIC_COUNT'
      ?`${amount(counted,'product')} counted · ${amount(units,'unit')}`
      :`${counted} of ${amount(scope.length,'product')} counted · ${amount(units,'unit')}`;
  })();
  const saveText=syncError?'Save needs attention':saving?'Saving…':stats?.dirty?`${amount(stats.dirty,'product')} waiting to save`:stats?.pending?'Finding products…':'All changes saved';
  const syncText=!count?.editable?'Saved in HotWax':saving?'Syncing with HotWax…':stats?.pending?`${stats.pending} scans to check · other products can still be counted`:stats?.dirty?`${stats.dirty} products saved on this device · sync pending`:lastSynced?'All quantities synced with HotWax':'Scans are saved on this device, then synced automatically';
  const backTarget=ROUTES[route]?.back;
  function back() {
    if(backTarget==='summary'){leave(true);return;}
    if(backTarget==='unmatched'){showUnmatchedScans();return;}
    if(backTarget==='session'){go(sessionRoute);return;}
    go(backTarget||(count?sessionRoute:'home'));
  }
  if(route==='new')return <CreateCount request={request} storage={storage} owner={owner} timeZone={history?.timeZone} back={()=>go('home')} onCreated={async(result,startNow)=>{
    const opened=startNow?await open(result.sessionId):await openPage(COUNT_SUMMARY,{workEffortId:result.workEffortId});
    if(!own())return;
    setRoute('home');
    if(!opened)await refresh();
  }}/>;
  if(route==='work')return <CountFlow key={workId} workEffortId={workId} refreshVersion={workRevision} setHeader={setHeader} openSession={open} storage={storage} owner={owner} request={request} navigationError={error}/>;
  if(count&&route==='hand')return <HandCount setHeader={setHeader} onBusyChange={setBusy} disabled={!canCount} request={request} engine={engine.current} storage={storage} owner={owner} count={count} done={saved=>{if(saved)setSessionTab('all');go(sessionRoute);}}/>;
  const scanHistoryList=<s-stack direction="block" gap="base">
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
            <DividedRows>{scanHistory?.items.map(event=><ScanEventRow key={event.id} event={event} disabled={busy||!canCount} onMatch={event=>{setIssueId(event.id);go('issue');}} onUndo={event=>run(async()=>{if(event.aggApplied===0)await engine.current.discardUnmatched(event.id);else await engine.current.undoScan(event.id);})}/>)}</DividedRows>
            {!scanHistory?.total&&<s-text>No scan events match this view.</s-text>}
            {scanHistory&&<CompactPager {...scanHistory} label="events" disabled={busy} onPage={setScanPage}/>}
          </s-stack>;
  // filters shows the sort control; the session tabs above replace the list's own tabs.
  const sessionProducts=view=><ProductList key={view} items={count.items} filters listIndex={services.current.listIndex} memory={listMemory.current} activeView={view} showTabs={false} countExtras onSelect={selectProduct}
    onQuantity={count.editable?changeQuantity:undefined} onQuantityInput={editQuantity} disabled={busy||(count.editable&&!canCount)} search={searchMembers} onVisible={hydrateRows}/>;
  return <>
    <s-scroll-box key={`${route}:${count?.sessionId||'home'}:${route==='product'?productId:''}`}><s-box padding="large"><s-stack direction="block" gap="large">
      {!['home','options','hand','opening'].includes(route)&&!(page.kind==='session'&&isSessionDetail)&&<BackButton disabled={busy} onClick={back}>{BACK_LABELS[backTarget]||'Back'}</BackButton>}
      {count&&count.name!==count.countName&&isSessionDetail&&<s-text color="subdued">{count.countName}</s-text>}
      {error&&<s-banner tone="critical" heading={error}/>}
      {count?.editable&&!canCount&&<s-banner tone="critical" heading={lockedElsewhere?'Open on another register':'Counting paused'}>
        <s-button slot="primary-action" disabled={busy||!connected} onClick={reclaim}>Reconnect</s-button>
      </s-banner>}
      {!connected&&<s-banner tone="warning" heading="Offline">{canCount?'Keep counting. Scans are saved on this terminal and match and sync after reconnecting.':'Saved sessions are available. Sessions this terminal already holds can keep counting; sync resumes after reconnecting.'}</s-banner>}
      {route==='opening'&&<s-section heading={opening?.name||'Session'}><s-stack direction="block" gap="base">
        <s-text>{busy?'Opening session…':'The session could not be opened.'}</s-text>
        {busy?<s-text color="subdued">Loading saved quantities and checking session access.</s-text>:<s-button variant="primary" onClick={()=>loadSession(opening.sessionId,opening.name)}>Try again</s-button>}
      </s-stack></s-section>}
      {route==='home'&&<>
        {contextProduct&&<s-banner tone="info" heading={`Count ${contextProduct.sku||contextProduct.title}`}>Choose a session or start a count. Product identity has been confirmed in HotWax.</s-banner>}
        {resume&&<s-section heading="Continue your count"><s-stack direction="block" gap="base"><s-text>{resume.name}</s-text><s-button variant="primary" disabled={busy} onClick={()=>open(resume.sessionId,resume.name)}>Resume counting</s-button></s-stack></s-section>}
        {history?.canCreate&&<s-stack direction="inline"><s-button variant={resume?'secondary':'primary'} disabled={busy} onClick={()=>go('new')}>Create count</s-button></s-stack>}
        <s-section heading="Store counts"><s-stack direction="block" gap="base">
          <s-tabs value={group} disabled={busy} onChange={e=>{const next=e.currentTarget.value;setGroup(next);run(()=>refresh(0,next));}}><s-tab-list><s-tab controls="active">Active</s-tab><s-tab controls="submitted">Approval</s-tab><s-tab controls="history">History</s-tab></s-tab-list><s-tab-panel id="active"/><s-tab-panel id="submitted"/><s-tab-panel id="history"/></s-tabs>
          <DividedRows>{history?.counts.map(item=><ActionRow key={item.workEffortId} title={item.name} detail={`${countTypeName(item.type)} · ${amount(item.sessions,'session')}${item.mySessions?` · ${item.mySessions} yours`:''}`} meta={workStatus(item.statusId)} disabled={busy} onClick={()=>openPage(COUNT_SUMMARY,{workEffortId:item.workEffortId})}/>)}</DividedRows>
          {history&&!history.counts.length&&<s-text color="subdued">{group==='active'?'No active counts. Create a count to get started.':'No counts in this view.'}</s-text>}
          {history&&(history.pageIndex>0||history.nextPage!==null)&&<s-stack direction="inline" gap="base"><s-button disabled={busy||!history.pageIndex} onClick={()=>run(()=>refresh(history.pageIndex-1))}>Previous</s-button><s-text>Page {history.pageIndex+1}</s-text><s-button disabled={busy||history.nextPage===null} onClick={()=>run(()=>refresh(history.nextPage))}>Next</s-button></s-stack>}
        </s-stack></s-section>
        {!history&&error&&<s-button variant="primary" disabled={busy} onClick={()=>run(()=>refresh())}>Reconnect to HotWax</s-button>}
      </>}
      {count&&['count','context'].includes(route)&&<s-stack direction="block" gap="large">
        {route==='context'&&selected?<s-section heading={selected.title}><s-stack direction="block" gap="base"><s-text>{selected.sku} · {selected.quantity??0} counted here</s-text><s-button variant="primary" disabled={busy||!canCount} onClick={async()=>{if(await enqueue({code:selected.sku||selected.productId,productId:selected.productId,source:'product-context'})){context.current=null;setContextProduct(null);go('count');}}}>Count one unit</s-button><s-button disabled={busy||!canCount} onClick={()=>go('product')}>Enter a total quantity</s-button></s-stack></s-section>:<>
          {canCount&&((last&&last.source!=='correction')||posScannerConnected||hidMode)&&<ScanFeedback last={last?.source==='correction'?null:last} hidMode={hidMode}/>}
          {emptySession?<s-empty-state heading="Count your first product" subheading={cameraAvailable||posScannerConnected||hidMode?'Scan a barcode or use Hand count to find a product and enter its quantity.':'Use Hand count to find a product and enter its quantity.'}>
            <s-button slot="primary-action" variant="primary" disabled={busy||!canCount} onClick={handCount}>Hand count</s-button>
            {cameraAvailable&&<s-button slot="secondary-actions" disabled={busy||!canCount} onClick={scanWithCamera}>Scan with camera</s-button>}
          </s-empty-state>:<s-stack direction="inline" gap="base">
            {/* POS allows one header button (Complete session), so More stays here as the quietest action. */}
            <s-button variant="primary" disabled={busy||!canCount} onClick={handCount}>Hand count</s-button>
            {cameraAvailable&&<s-button disabled={busy||!canCount} onClick={scanWithCamera}>Scan with camera</s-button>}
            {sessionToolbar&&<s-button variant="tertiary" disabled={busy} onClick={()=>go('options')}>More</s-button>}
          </s-stack>}
          {/* One status line; badges appear only for a connected scanner or a lock that needs attention. */}
          <s-stack direction="inline" gap="base" alignItems="center">
            {!emptySession&&<s-clickable onClick={()=>go('options')}><s-box minBlockSize="24px"><s-text color="subdued" tone={syncError?'critical':'auto'}>{`${progressText} · ${saveText}`}</s-text></s-box></s-clickable>}
            {posScannerConnected&&<s-badge tone="success">Scanner connected</s-badge>}
            {lockTone!=='success'&&<s-badge tone={lockTone}>{lockLabel}</s-badge>}
            {emptySession&&<s-button variant="tertiary" disabled={busy} onClick={()=>go('options')}>More</s-button>}
          </s-stack>
          {hidMode&&<HidBarcodeEntry key={count.sessionId} disabled={busy||!canCount} add={enqueue}/>}
        </>}
      </s-stack>}
      {count&&route==='match'&&issue&&<><s-text>Match {issue.code} to the correct product. Its saved quantity will be kept.</s-text><CatalogPicker request={request} disabled={busy||!canCount} onPick={product=>run(async()=>{await engine.current.matchUnmatched(issue.id,product);showUnmatchedScans();})}/></>}
      {count&&route==='editSession'&&<>
        <s-text-field label="Session name" value={editName} disabled={busy} onInput={e=>setEditName(e.currentTarget.value)}/>
        <s-text type="strong">Session location</s-text>
        {/* Sessions created elsewhere (for example in the Ionic app) can have no location. */}
        {!AREAS.some(area=>area.id===editArea)&&<s-text color="subdued">No location is set for this session yet. Choose where it counts before saving.</s-text>}
        <s-choice-list values={[editArea]} onChange={e=>setEditArea(e.currentTarget.values[0])}>{AREAS.map(area=><s-choice key={area.id} value={area.id} disabled={busy}>{area.name}</s-choice>)}</s-choice-list>
        <s-button variant="primary" disabled={busy||!canCount} onClick={()=>run(async()=>{await engine.current.prepareSubmission();const result=await ownership.current.write('editSession',{sessionId:count.sessionId,name:editName,area:editArea});await attach(result);})}>Save session</s-button>
      </>}
      {count&&route==='discard'&&<><s-text>Discard {count.name}? Its quantities will be excluded from the team count. Other sessions stay available.</s-text><s-button variant="primary" disabled={busy||!canCount} onClick={()=>run(async()=>{await engine.current.prepareSubmission();const result=await ownership.current.write('discardSession',{sessionId:count.sessionId});await ownership.current.release();await attach(result);})}>Discard this session</s-button></>}
      {count&&route==='forceRelease'&&<><s-text>Make sure counting has stopped on {lease?.deviceId}. Taking over ends its current lock; unsynced scans on that register must be reconciled before use.</s-text><s-button variant="primary" disabled={busy} onClick={()=>run(async()=>{await request('leaseForceRelease',{sessionId:count.sessionId,lease});await ownership.current.claim();setLeaseProblem('');go('count');})}>Release lock and take over</s-button></>}
      {route==='camera'&&<><s-text type="strong">Camera counting mode</s-text><s-choice-list values={[cameraMode]} onChange={e=>setCameraMode(e.currentTarget.values[0])}><s-choice value="rapid">Rapid: add one unit per scan</s-choice><s-choice value="confirm">Confirm: enter a quantity after each scan</s-choice></s-choice-list><s-text color="subdued">Rapid mode ignores the same camera barcode for one second. Hardware scanner repeats remain separate scans.</s-text><s-button variant="primary" onClick={()=>go('count')}>Done</s-button></>}
      {route==='cameraConfirm'&&<><s-section heading={cameraProduct?.title||cameraCode}><s-stack direction="block" gap="base"><s-text>{cameraCode}</s-text><s-text color="subdued">{cameraProduct?.productId?`${count?.items.find(p=>p.productId===cameraProduct.productId)?.quantity||0} already counted`:'The scan will be saved and matched in HotWax.'}</s-text><s-number-field label="Additional units" value={cameraQuantity} min={1} max={1000000} onInput={e=>setCameraQuantity(e.currentTarget.value)}/></s-stack></s-section><s-button variant="primary" disabled={busy||!canCount} onClick={async()=>{if(await enqueue({code:cameraCode,quantity:Number(cameraQuantity),product:cameraProduct,productId:cameraProduct?.productId,source:'camera-confirm'}))go('count');}}>Add units</s-button></>}
      {count&&route==='product'&&selected&&(canCount?<QuantityEditor key={selected.productId} item={selected} disabled={busy} onSave={async job=>{if(await enqueue(job)){await engine.current.aggregate();go(sessionRoute);}}}/>:<s-section heading={selected.title}><s-stack direction="block" gap="base"><s-text>{selected.sku} · {selected.quantity==null?'Not counted':`${selected.quantity} counted`}</s-text>{count.canViewOnHand&&<s-text>On hand {selected.onHand??'unavailable'}</s-text>}</s-stack></s-section>)}
      {count&&route==='submitted'&&<><s-banner tone="success" heading="Saved in HotWax"/><s-text>Your part is saved. Finish the count from its summary.</s-text><s-button variant="primary" disabled={busy} onClick={()=>leave(true)}>Count summary</s-button></>}
      {count&&route==='readonly'&&<><s-section heading={countStatus(count)}><s-stack direction="block" gap="base"><s-text>You can view this session. Use session options to reopen a submitted session while the count is in progress.</s-text></s-stack></s-section><ActionRow title="Count summary" onClick={()=>leave(true)}/></>}
      {route==='issue'&&(issue||matchingFeedback?.id===issueId)&&<>
        <s-section heading={issue?.code||matchingFeedback?.code}><s-stack direction="block" gap="base">
          <s-text type="strong">{matchingFeedback?.pending?'Checking HotWax…':matchingFeedback?.failed?'Matching could not finish':matchingFeedback?.remaining?'Still unmatched':!issue?'Scan matched':'Unmatched scan'}</s-text>
          <s-text>{matchingFeedback?.pending?'Looking for a matching product.':matchingFeedback?.reason||(!issue&&matchingFeedback?.product?`${matchingFeedback.product.title} · ${matchingFeedback.product.quantity} counted in this session`:issue?.message)}</s-text>
          <s-text color="subdued">{issue?'Your scan is saved. Find the correct product or check its barcode. Removing this scan excludes it from your count.':'The matched quantity is saved on this device and will sync automatically.'}</s-text>
        </s-stack></s-section>
        {issue?<>
          <s-button variant="primary" disabled={busy||!canCount} onClick={()=>go('match')}>Find the correct product</s-button>
          <s-button loading={!!matchingFeedback?.pending} disabled={busy||!canCount} onClick={()=>retryMatching(issue)}>Retry matching</s-button>
          <s-button disabled={busy||!canCount} onClick={()=>run(async()=>{await engine.current.discardUnmatched(issue.id);showUnmatchedScans();})}>Remove this unmatched scan</s-button>
        </>:<s-button variant="primary" disabled={busy} onClick={()=>showUnmatchedScans()}>Back to unmatched scans</s-button>}
      </>}
      {route==='compare'&&<>{conflicts.length?<s-section heading={`${conflicts.length} quantities to reconcile`}><s-stack direction="block" gap="base"><s-text type="strong">{conflicts[0].sku||conflicts[0].title}</s-text><s-text>This device: {conflicts[0].quantity} · HotWax: {conflicts[0].serverQuantity??'Not counted'}</s-text>{[false,true].map(useServer=><s-button key={String(useServer)} disabled={busy} onClick={()=>run(async()=>{const item=conflicts[0];await engine.current.reconcile(item.productId,item.serverQuantity,useServer);setConflicts(old=>old.slice(1));if(conflicts.length===1){setSyncError('');go('count');}})}>{useServer?'Use HotWax quantity':'Keep this device’s quantity'}</s-button>)}</s-stack></s-section>:<s-banner tone="success" heading="No unsynced quantities to reconcile"/>}</>}
      {route==='options'&&<>
        {count?<>
          {/* Everyday actions first; sync and lock diagnostics sit in Troubleshooting at the end. */}
          {count.editable&&<s-section heading="Counting"><DividedRows>
            <ActionRow title="Barcode scanner" detail={hidMode?'Keyboard scanner on':'Use a keyboard scanner'} onClick={()=>{setHidMode(value=>!value);go('count');}}/>
            {sources.includes('camera')&&<ActionRow title="Camera counting" detail={cameraMode==='rapid'?'Rapid scanning':'Confirm quantity after scanning'} onClick={()=>go('camera')}/>}
            <ActionRow title="Scan history" onClick={()=>{setSessionTab('scans');go(dynamic?'scanHistory':'count');}}/>
          </DividedRows></s-section>}
          <s-section heading="Session"><DividedRows>
            {count.editable&&<ActionRow title="Edit session" detail="Change the name or location" disabled={busy||!canCount} onClick={()=>{setEditName(count.name);setEditArea(count.area);go('editSession');}}/>}
            {count.statusId==='SESSION_SUBMITTED'&&count.countStatusId==='CYCLE_CNT_IN_PRGS'&&<ActionRow title="Reopen session" detail="Continue counting or correct submitted quantities" disabled={busy} onClick={()=>run(async()=>{const result=await request('reopenSession',{sessionId:count.sessionId});await attach(result);})}/>}
            {count.editable&&<ActionRow title="Save and release this session" detail="Let another register continue it" disabled={busy||saving||!canCount} onClick={()=>run(async()=>{await engine.current.prepareSubmission();await ownership.current.release();await closeSession();returnToParent();})}/>}
            {count.editable&&!lease?.owned&&lease?.fromDate&&(count.canRelease||lease.operator===count.currentOperator)&&<ActionRow title="Take over session" detail="Continue a session open on another register" disabled={busy} onClick={()=>go('forceRelease')}/>}
            <ActionRow title={page.fromSummary?"Count summary":"All store counts"} onClick={()=>leave(false)}/>
            {count.editable&&<ActionRow title="Discard session" detail="Leave this session out of the count" disabled={busy||!canCount} onClick={()=>go('discard')}/>}
          </DividedRows></s-section>
          <s-section heading="Troubleshooting"><s-stack direction="block" gap="base">
            <s-text color="subdued">{syncText}</s-text>{syncError&&<s-banner tone="warning" heading={syncError}/>}
            <DividedRows>
              {count.editable&&<ActionRow title="Retry sync" detail={`${pending} pending changes`} disabled={busy||saving} onClick={sync}/>}
              {count.editable&&<ActionRow title="Compare with HotWax" detail="Resolve a quantity changed on another register" disabled={busy||saving} onClick={compare}/>}
              {!count.editable&&<ActionRow title="Remove local copy" detail="Only after HotWax has finished with this session" onClick={()=>go('remove')}/>}
            </DividedRows>
            <s-text color="subdued">{shopify.device.name} · {shopify.device.registerName}</s-text>
            {count.editable&&<s-stack direction="block" gap="small"><s-stack direction="inline"><s-badge tone={lockTone}>{lockLabel}</s-badge></s-stack>{lease?.deviceId&&<s-text color="subdued">Lock terminal: {lease.deviceId}{lease.operator?` · ${lease.operator}`:''}</s-text>}{lease?.lastHeartbeatAt&&<s-text color="subdued">Last heartbeat: {new Date(lease.lastHeartbeatAt).toLocaleTimeString()}</s-text>}</s-stack>}
          </s-stack></s-section>
        </>:<><ActionRow title="Refresh store counts" onClick={()=>run(async()=>{await refresh();go('home');})}/><ActionRow title="Saved sessions on this device" meta={String(catalog.length)} onClick={()=>go('saved')}/></>}
      </>}
      {route==='saved'&&<><DividedRows>{catalog.slice(localPage*20,(localPage+1)*20).map(item=><ActionRow key={item.sessionId} title={item.name||item.sessionId} meta={editable(item.statusId)?'Resume':'View'} disabled={busy} onClick={()=>open(item.sessionId,item.name)}/>)}</DividedRows>{!catalog.length&&<s-text>No saved sessions for this operator at this store.</s-text>}<CompactPager page={localPage} pages={Math.max(1,Math.ceil(catalog.length/20))} total={catalog.length} label="sessions" onPage={setLocalPage}/></>}
      {route==='remove'&&<><s-text>This removes this session’s scan history from this register. Submitted quantities stay in HotWax.</s-text><s-button variant="primary" disabled={busy} onClick={removeLocal}>Remove verified local copy</s-button></>}
      {route==='scanHistory'&&scanHistoryList}
      {count&&isSessionDetail&&count.items.length>0&&(dynamic?sessionProducts('all'):<s-tabs value={sessionTab} onChange={e=>selectSessionTab(e.currentTarget.value)}>
        <s-tab-list>{sessionTabs.map(([id,label])=><s-tab key={id} controls={id}>{label}</s-tab>)}</s-tab-list>
        {sessionTabs.map(([id])=><s-tab-panel key={id} id={id}>
          {sessionTab===id&&(id==='scans'?scanHistoryList:sessionProducts(id))}
        </s-tab-panel>)}
      </s-tabs>)}
    </s-stack></s-box></s-scroll-box>
  </>;
}
