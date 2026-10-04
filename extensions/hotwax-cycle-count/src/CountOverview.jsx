import {useEffect,useRef,useState,useCallback} from 'preact/hooks';
import {countRequest,countStatus,countTypeName,workStatus} from './count-api';
import {PagedProducts,Pager} from './PagedProducts.jsx';
const operationId=()=>Array.from({length:15},()=>Math.floor(Math.random()*16).toString(16)).join('');
const date=value=>value?new Date(Number(value)).toLocaleDateString():'Not scheduled';

export function CountOverview({workEffortId,openSession,back,storage,owner,blind}) {
  const [info,setInfo]=useState(null),[progress,setProgress]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [creating,setCreating]=useState(false),[area,setArea]=useState('register'),[sessionPage,setSessionPage]=useState(0);
  const [selected,setSelected]=useState(new Set()),[confirmation,setConfirmation]=useState(''),[contributions,setContributions]=useState(null);
  const [contributionPage,setContributionPage]=useState(0);
  const name=useRef(''),active=useRef(true),running=useRef(false);
  async function run(fn) {
    if(running.current)return;
    running.current=true;setBusy(true);setError('');
    try {await fn();} catch(failure){if(active.current)setError(failure instanceof Error ? failure.message : 'Could not complete this operation.');}
    finally {running.current=false;if(active.current)setBusy(false);}
  }
  useEffect(()=>{active.current=true;run(async()=>{const result=await countRequest('overview',{workEffortId});if(active.current)setInfo(result);});return()=>{active.current=false;};},[workEffortId]);
  async function refresh(showProgress=false) {
    const result=await countRequest(showProgress?'progress':'overview',{workEffortId});
    if(!active.current)return;
    setInfo(result);if(showProgress)setProgress(result);setSelected(new Set());setConfirmation('');setContributions(null);
  }
  async function create() {
    const key=`hotwax-count:${owner}:create-session:${workEffortId}`;
    let pending=await storage.get(key);
    if(!pending){pending={workEffortId,operationId:operationId(),name:name.current.trim(),area};if(!pending.name)throw new Error('Enter a session name.');await storage.set(key,pending);}
    for(let attempt=0;attempt<6;attempt++) {
      const result=await countRequest('createSession',pending);
      if(!result.preparing){await storage.delete(key);await openSession(result.session.sessionId,result.session);return;}
      setError(`Preparing the requested list · ${result.remaining} products remaining. Your session is saved.`);
    }
    throw new Error('Session preparation is saved. Tap Create session again to continue.');
  }
  const toggle=useCallback(id=>setSelected(old=>{const next=new Set(old);if(next.has(id))next.delete(id);else if(next.size<25)next.add(id);return next;}),[]);
  const contribute=useCallback(item=>run(async()=>{const result=await countRequest('contributions',{workEffortId,productId:item.productId});setContributions({name:item.sku,items:result.items});setContributionPage(0);}),[workEffortId]);
  async function confirm() {
    if(confirmation==='completeCount') {await countRequest('completeCount',{workEffortId});await refresh(true);return;}
    const key=`hotwax-count:${owner}:decision:${workEffortId}`;
    let pending=await storage.get(key);
    if(!pending){pending={action:confirmation,workEffortId,operationId:operationId(),productIds:[...selected]};await storage.set(key,pending);}
    if (pending.action !== confirmation || [...pending.productIds].sort().join(',') !== [...selected].sort().join(',')) throw new Error('A previous decision is saved for retry. Select the same products and decision to finish it before making another.');
    await countRequest(pending.action,pending);await storage.delete(key);await refresh(true);
  }
  if(!info)return <s-stack direction="block" gap="base">{busy&&<s-spinner/>}{error&&<s-banner tone="critical" heading={error}/>}<s-button disabled={busy} onClick={()=>run(()=>refresh())}>Retry count</s-button><s-button disabled={busy} onClick={back}>Store counts</s-button></s-stack>;
  const chosen=progress?.items.filter(item=>selected.has(item.productId)) || [];
  const canZero=chosen.length>0 && chosen.every(item=>item.isRequested && item.quantity===null);
  const canDiscard=chosen.length>0 && chosen.every(item=>!item.isRequested && item.quantity!==null && item.decision!=='SKIPPED');
  const list=info.sessions.slice(sessionPage*20,(sessionPage+1)*20),allSubmitted=progress?.allSubmitted;
  return <s-stack direction="block" gap="large">
    <s-stack direction="inline" gap="base"><s-button disabled={busy} onClick={back}>Store counts</s-button><s-button disabled={busy} onClick={()=>run(()=>refresh(!!progress))}>Refresh count</s-button></s-stack>
    {error&&<s-banner tone="critical" heading={error}/>}{busy&&<s-spinner/>}
    <s-section heading={info.name}><s-stack direction="block" gap="base">
      <s-stack direction="inline" gap="base"><s-badge>{countTypeName(info.type)}</s-badge><s-badge>{workStatus(info.statusId)}</s-badge></s-stack>
      <s-text>Start {date(info.startDate)} · Due {date(info.dueDate)}</s-text><s-text>{info.sessions.length} sessions · {info.workEffortId}</s-text>
      {info.canStart&&<s-button disabled={busy} onClick={()=>run(async()=>{setInfo(await countRequest('startCount',{workEffortId}));})}>Start scheduled count</s-button>}
      {info.canCreateSession&&<s-button disabled={busy} variant="primary" onClick={()=>setCreating(v=>!v)}>{creating?'Cancel new session':'New session'}</s-button>}
      <s-button disabled={busy} onClick={()=>progress?setProgress(null):run(()=>refresh(true))}>{progress?'Back to sessions':info.statusId==='CYCLE_CNT_IN_PRGS'?'Count progress and completion':'View results'}</s-button>
    </s-stack></s-section>
    {creating&&<s-section heading="New counting session"><s-stack direction="block" gap="base">
      <s-text-field label="Session name" placeholder="For example, Front display — Aditya" disabled={busy} onInput={e=>{name.current=e.currentTarget.value;}}/>
      <s-text type="strong">Session location</s-text><s-choice-list values={[area]} onChange={e=>setArea(e.currentTarget.values[0])}>{info.areas.map(a=><s-choice key={a.id} value={a.id} disabled={busy}>{a.name}</s-choice>)}</s-choice-list>
      <s-text>{info.type==='DIRECTED_COUNT'?'The requested product list will be available in this session.':'Scan products in this session. Each session contributes to the store total.'}</s-text>
      <s-button disabled={busy} variant="primary" onClick={()=>run(create)}>Create session</s-button>
    </s-stack></s-section>}
    {!progress&&<s-section heading="Counting sessions"><s-stack direction="block" gap="base">
      <Pager page={sessionPage} pages={Math.max(1,Math.ceil(info.sessions.length/20))} total={info.sessions.length} label="sessions" onPage={setSessionPage} disabled={busy}/>
      {!info.sessions.length&&<s-text>No sessions yet. Start a new session.</s-text>}
      {list.map(s=><s-section key={s.sessionId} heading={s.name||s.sessionId}><s-stack direction="block" gap="small">
        <s-text>{info.areas.find(a=>a.id===s.area)?.name || s.area || 'No session location'} · {s.operator}{s.mine?' · Yours':''}</s-text>
        <s-text>{countStatus(s)}</s-text>
        <s-button disabled={busy} onClick={()=>openSession(s.sessionId)}>{s.editable?'Resume session':'View session'}</s-button>
      </s-stack></s-section>)}
    </s-stack></s-section>}
    {progress&&<s-stack direction="block" gap="large">
      <s-section heading={info.statusId==='CYCLE_CNT_IN_PRGS'?'Count progress':'Count results'}><s-stack direction="block" gap="base">
        <s-text type="strong">{progress.items.length-progress.uncounted} of {progress.items.length} products counted · {progress.units} units</s-text>
        <s-text>{progress.openSessions} open sessions · {progress.uncounted} uncounted · {progress.undirected} undirected</s-text>
        {info.statusId==='CYCLE_CNT_CMPLTD'&&<s-banner tone="info" heading="Awaiting approval in HotWax">Submitted quantities are ready for the review team. Inventory changes require approval in HotWax.</s-banner>}
        {info.statusId==='CYCLE_CNT_IN_PRGS'&&<s-text>Submit all sessions before completing this count. Missing products need an explicit count or confirmed zero. Undirected products stay in the review unless discarded.</s-text>}
        {info.canComplete&&info.statusId==='CYCLE_CNT_IN_PRGS'&&<s-stack direction="block" gap="base">
          <s-text>{selected.size} selected · maximum 25 at a time</s-text>
          <s-stack direction="inline" gap="base">
            <s-button disabled={busy||!allSubmitted||!canZero} onClick={()=>setConfirmation('confirmZero')}>Confirm selected as zero</s-button>
            {info.type==='DIRECTED_COUNT'&&<s-button disabled={busy||!allSubmitted||!canDiscard} onClick={()=>setConfirmation('discardUndirected')}>Discard selected extras</s-button>}
            <s-button disabled={busy||!progress.canFinish} variant="primary" onClick={()=>setConfirmation('completeCount')}>Complete count for approval</s-button>
          </s-stack>
        </s-stack>}
      </s-stack></s-section>
      {confirmation&&<s-section heading={confirmation==='completeCount'?'Send the whole count for approval?':confirmation==='confirmZero'?'Confirm these products were checked and none were found?':'Discard these undirected products?'}><s-stack direction="block" gap="base">
        <s-text>{confirmation==='completeCount'?'This completes the count across all sessions. It does not apply inventory changes.':`${selected.size} selected products. This decision is recorded in HotWax.`}</s-text>
        <s-stack direction="inline" gap="base"><s-button disabled={busy} variant="primary" onClick={()=>run(confirm)}>Confirm {confirmation==='completeCount'?'count completion':confirmation==='confirmZero'?'zero quantities':'discard'}</s-button><s-button disabled={busy} onClick={()=>setConfirmation('')}>Cancel</s-button></s-stack>
      </s-stack></s-section>}
      {contributions&&<s-section heading={`Sessions for ${contributions.name}`}><s-stack direction="block" gap="small">
        {contributions.items.slice(contributionPage*20,(contributionPage+1)*20).map(s=><s-text key={s.sessionId}>{s.name} · {s.operator} · {s.quantity??'Not counted'} · {countStatus(s)}</s-text>)}
        <Pager page={contributionPage} pages={Math.max(1,Math.ceil(contributions.items.length/20))} total={contributions.items.length} label="sessions" onPage={setContributionPage} disabled={busy}/>
        <s-button onClick={()=>setContributions(null)}>Close contributions</s-button>
      </s-stack></s-section>}
      <PagedProducts key={workEffortId} items={progress.items} blind={blind} directed={info.type==='DIRECTED_COUNT'} disabled={busy} selected={selected} select={info.canComplete&&info.statusId==='CYCLE_CNT_IN_PRGS'?toggle:undefined} contribute={contribute}/>
    </s-stack>}
  </s-stack>;
}
