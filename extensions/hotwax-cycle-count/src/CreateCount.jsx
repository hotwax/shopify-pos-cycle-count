import {useEffect,useRef,useState} from 'preact/hooks';
import {CatalogPicker} from './CatalogPicker.jsx';
import {ActionRow,BackButton} from './FlowParts.jsx';
import {countTypeName} from './count-api';
const id=()=>Array.from({length:15},()=>Math.floor(Math.random()*16).toString(16)).join('');
export function CreateCount({request,storage,owner,timeZone,onCreated,back}) {
  const [step,setStep]=useState('details'),[name,setName]=useState(''),[type,setType]=useState('DYNAMIC_COUNT'),[start,setStart]=useState(''),[due,setDue]=useState('');
  const [selected,setSelected]=useState(new Map()),[busy,setBusy]=useState(true),[error,setError]=useState(''),[duplicates,setDuplicates]=useState(null),[progress,setProgress]=useState('');
  const active=useRef(true),pending=useRef(null),draftKey=`hotwax-count:${owner}:count-draft`,operationKey=`hotwax-count:${owner}:create-count`;
  const zone=timeZone||Intl.DateTimeFormat().resolvedOptions().timeZone;
  useEffect(()=>{(async()=>{
    const [draft,operation]=await Promise.all([storage.get(draftKey),storage.get(operationKey)]);
    if(!active.current)return;
    if(draft){setName(draft.name);setType(draft.type);setStart(draft.start);setDue(draft.due);setSelected(new Map(draft.products.map(p=>[p.productId,p])));}
    pending.current=operation;if(operation)setStep('review');
  })().catch(e=>setError(e instanceof Error?e.message:'Could not complete this action. Your saved work is retained.')).finally(()=>{if(active.current)setBusy(false);});return()=>{active.current=false;};},[]);
  async function saveDraft(){await storage.set(draftKey,{name,type,start,due,products:[...selected.values()].map(({productId,title,sku,primary,secondary})=>({productId,title,sku,primary,secondary}))});}
  async function next(value){try{if(!name.trim())throw new Error('Give the count a name.');if(start&&due&&start>due)throw new Error('The due date must be on or after the start date.');await saveDraft();setError('');setStep(value);}catch(e){setError(e instanceof Error?e.message:'Could not complete this action. Your saved work is retained.');}}
  function choose(product){setSelected(old=>{const next=new Map(old);if(next.has(product.productId))next.delete(product.productId);else if(next.size<2000)next.set(product.productId,product);return next;});}
  async function create(existingCountId=undefined){
    setBusy(true);setError('');
    try{
      if(!pending.current){pending.current={operationId:id(),createdAt:Date.now(),name:name.trim(),type,startDate:start,dueDate:due,timeZone:zone,productIds:type==='DYNAMIC_COUNT'?[]:[...selected.keys()]};await storage.set(operationKey,pending.current);}
      if(existingCountId){pending.current={...pending.current,existingCountId};await storage.set(operationKey,pending.current);}
      for(let n=0;n<5;n++){
        const result=await request('createCount',pending.current);
        if(result.duplicate){setDuplicates(result.duplicate);return;}
        if(result.preparing){setProgress(`${result.remaining} products left to prepare`);continue;}
        await storage.delete(operationKey);await storage.delete(draftKey);onCreated(result);return;
      }
      throw new Error('Your count is saved. Continue to finish preparing its product list.');
    }catch(e){if(active.current)setError(e instanceof Error?e.message:'Could not complete this action. Your saved work is retained.');}finally{if(active.current)setBusy(false);}
  }
  return <s-scroll-box key={step}><s-box padding="large"><s-stack direction="block" gap="large">
    <BackButton loading={busy} disabled={busy} onClick={()=>{if(step==='details'){saveDraft().then(back).catch(e=>setError(e instanceof Error?e.message:'Could not complete this action. Your saved work is retained.'));}else setStep(step==='review'&&type!=='DYNAMIC_COUNT'?'products':'details');}}>{step==='details'?'All counts':'Back'}</BackButton>
    <s-heading>{step==='details'?'Create a count':step==='products'?'Choose products':'Review new count'}</s-heading>
    {error&&<s-banner tone="critical" heading={error}/>}{progress&&<s-text>{progress}</s-text>}
    {step==='details'&&<>
      <s-section><s-stack direction="block" gap="base">
        <s-text-field label="Count name" value={name} disabled={busy||!!pending.current} onInput={e=>setName(e.currentTarget.value)}/>
        <s-choice-list values={[type]} onChange={e=>setType(e.currentTarget.values[0])}><s-choice value="DYNAMIC_COUNT" disabled={busy||!!pending.current}>Dynamic count</s-choice><s-choice value="DIRECTED_COUNT" disabled={busy||!!pending.current}>Directed count</s-choice><s-choice value="HARD_COUNT" disabled={busy||!!pending.current}>Hard count</s-choice></s-choice-list>
        <s-text color="subdued">{type==='DYNAMIC_COUNT'?'Build the list as you scan or hand count. For each product you include, count every unit in the store, including back stock. Products you do not include stay outside this count.':type==='DIRECTED_COUNT'?'Count a selected product list.':'Review the whole store inventory, with an optional starting product list.'}</s-text>
        <s-stack direction="inline" gap="none">
          <s-box inlineSize="50%" paddingInlineEnd="small"><s-date-field label="Start date (optional)" value={start} disabled={busy||!!pending.current} onInput={e=>setStart(e.currentTarget.value)}/></s-box>
          <s-box inlineSize="50%" paddingInlineStart="small"><s-date-field label="Due date (optional)" value={due} disabled={busy||!!pending.current} onInput={e=>setDue(e.currentTarget.value)}/></s-box>
        </s-stack>
        <s-text color="subdued">Leave dates empty to start whenever you are ready, with no deadline. Dates use {zone}.</s-text>
      </s-stack></s-section><s-button variant="primary" disabled={busy} onClick={()=>next(type==='DYNAMIC_COUNT'?'review':'products')}>{type==='DYNAMIC_COUNT'?'Review count':'Choose products'}</s-button>
    </>}
    {step==='products'&&<>
      <s-text type="strong">{selected.size} / 2,000 products selected</s-text>
      <CatalogPicker request={request} scope selected={selected} disabled={busy||!!pending.current} onPick={choose} onSelectAll={items=>{
        const next=new Map(selected);for(const p of items)next.set(p.productId,p);
        if(next.size>2000){setError('Select no more than 2,000 products.');return;}setSelected(next);
      }}/>
      <s-button variant="primary" disabled={busy||type==='DIRECTED_COUNT'&&!selected.size} onClick={()=>next('review')}>Review count</s-button>
    </>}
    {step==='review'&&<>
      <s-section heading={pending.current?.name||name}><s-stack direction="block" gap="base">
        <s-text>{countTypeName(pending.current?.type||type)} · {type==='DYNAMIC_COUNT'?'Products added as you count':`${pending.current?.productIds.length??selected.size} selected products`}</s-text>
        <s-text>{pending.current?.startDate||start?`Starts ${pending.current?.startDate||start}`:'Start when ready'} · {pending.current?.dueDate||due?`Due ${pending.current?.dueDate||due}`:'No deadline'}</s-text>
        {type==='DYNAMIC_COUNT'&&<s-text color="subdued">The combined total from every session must include all units of each counted product across the store. Other products will be left unchanged.</s-text>}
      </s-stack></s-section>
      {duplicates?<><s-text>{type==='DYNAMIC_COUNT'?'A count with this name is already open. Choose a different name, or return to All counts to continue it.':'A count with this name is already open. Add these products to an existing count, or choose a different name.'}</s-text>{type!=='DYNAMIC_COUNT'&&duplicates.map(item=><ActionRow key={item.workEffortId} title={item.name} detail={countTypeName(item.type)} disabled={busy||item.type!==type} onClick={()=>create(item.workEffortId)}/>)}<s-button disabled={busy} onClick={async()=>{await storage.delete(operationKey);pending.current=null;setDuplicates(null);setStep('details');}}>Choose another name</s-button></>:<s-button variant="primary" loading={busy} disabled={busy} onClick={()=>create()}>Create count</s-button>}
    </>}
  </s-stack></s-box></s-scroll-box>;
}
