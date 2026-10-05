import {HandQuantityRow} from './HandQuantityRow.jsx';
import {useCallback,useEffect,useMemo,useRef,useState} from 'preact/hooks';
import {CatalogPicker} from './CatalogPicker.jsx';
import {BackButton,amount} from './FlowParts.jsx';
import {CompactPager} from './ProductList.jsx';
import {controlFor} from './count-control';

const MAX_QUANTITY=1000000;
const quantityError=value=>value!==''&&(!Number.isSafeInteger(Number(value))||Number(value)<0||Number(value)>MAX_QUANTITY)?'Enter a whole number from 0 to 1,000,000.':'';
const failureMessage=e=>e instanceof Error?e.message:'Could not save your hand count. Your draft is retained.';
// Drafts keep only identities and entered quantities; names and images stay in memory.
const compact=entries=>entries.map(({product,quantity})=>({productId:product.productId,variantId:product.shopifyVariantId??product.variantId,
  identifier:product.identifier||product.sku||product.productId,quantity}));

export function HandCount({request,engine,storage,owner,count,done,disabled=false,setHeader,onBusyChange}) {
  const [entries,setEntries]=useState([]),[step,setStep]=useState('search'),[error,setError]=useState(''),[busy,setBusy]=useState(true),[page,setPage]=useState(0),[locked,setLocked]=useState(false);
  const control=controlFor(storage.native||storage,owner),sessionId=count.sessionId;
  // A draft product with the display this runtime knows (Shopify, then HotWax).
  const productOf=entry=>({...engine.view({productId:entry.productId,variantId:entry.variantId,productIdentifier:entry.identifier}),
    shopifyVariantId:entry.variantId,identifier:entry.identifier,restored:true});
  const operation=useRef(''),active=useRef(true),current=useRef([]),queue=useRef(Promise.resolve()),timer=useRef(null),running=useRef(false),completed=useRef(false),ready=useRef(false),lockedRef=useRef(false),blocked=useRef(true),searchMemory=useRef({search:'',page:0});
  blocked.current=disabled||busy||locked;
  // Serialize draft snapshots so a slower earlier write cannot erase later edits.
  function persist(next=current.current,saving=lockedRef.current) {
    if(!operation.current)operation.current=`hand-${Date.now()}-${Math.random()}`;
    const snapshot={id:operation.current,entries:compact(next),saving};
    const task=queue.current.catch(()=>{}).then(()=>control.setEntry('drafts',sessionId,snapshot));
    queue.current=task;return task;
  }
  useEffect(()=>{
    active.current=true;
    // An earlier release saved full product objects under its own key: keep their
    // display in memory and move the compact draft into control.
    control.adopt('drafts',sessionId,'hand-draft',legacy=>{legacy.entries.forEach(entry=>engine.remember(entry.product));return {...legacy,entries:compact(legacy.entries)};}).then(value=>{
      if(!active.current||!value)return;
      operation.current=value.id;current.current=value.entries.map(entry=>({product:productOf(entry),quantity:String(entry.quantity)}));setEntries(current.current);lockedRef.current=!!value.saving;setLocked(!!value.saving);if(value.saving)setStep('review');
    }).then(()=>{ready.current=true;}).catch(e=>{if(active.current)setError(failureMessage(e));}).finally(()=>{if(active.current)setBusy(false);});
    return()=>{active.current=false;clearTimeout(timer.current);if(ready.current&&!completed.current&&!running.current&&operation.current)persist().catch(()=>{});};
  },[]);
  useEffect(()=>{onBusyChange?.(busy);return()=>onBusyChange?.(false);},[busy]);
  // A restored draft keeps only identities: fetch names and images for the review
  // page on screen (Shopify by variant, else HotWax), then refresh those rows.
  useEffect(()=>{
    const shown=entries.slice(page*40,(page+1)*40).filter(entry=>entry.product.restored);
    if(step!=='review'||!shown.length)return;
    let stale=false;
    const missing=shown.filter(entry=>!engine.displayOf(entry.product.productId)).map(entry=>entry.product.productId);
    Promise.all([engine.hydrate(shown.map(entry=>entry.product.shopifyVariantId)),
      missing.length&&request('products',{productIds:missing}).then(result=>result.items.forEach(product=>engine.remember(product))).catch(()=>{})]).then(()=>{
      if(stale||!active.current)return;
      const ids=new Set(shown.map(entry=>entry.product.productId));
      current.current=current.current.map(entry=>ids.has(entry.product.productId)?{...entry,product:{...productOf({productId:entry.product.productId,variantId:entry.product.shopifyVariantId,identifier:entry.product.identifier}),restored:false}}:entry);
      setEntries(current.current);
    }).catch(()=>{});
    return()=>{stale=true;};
  },[step,page,entries.length]);
  useEffect(()=>{setHeader?.({heading:step==='review'?'Review hand count':'Hand count',subheading:count.name});},[step]);
  const change=useCallback((product,value)=>{
    if(blocked.current||!ready.current)return;
    const next=current.current.filter(entry=>entry.product.productId!==product.productId);
    if(value!==''&&Number(value)!==0)next.push({product,quantity:value});
    if(next.length>2000){setError('Review and save these products before adding more.');return;}
    current.current=next;setEntries(next);setError('');clearTimeout(timer.current);
    timer.current=setTimeout(()=>persist(next).catch(e=>{if(active.current)setError(failureMessage(e));}),250);
  },[]);
  function discard(product) {
    if(blocked.current||!ready.current)return;
    change(product,'0');
    setPage(page=>Math.min(page,Math.max(0,Math.ceil(current.current.length/40)-1)));
  }
  async function run(action) {
    if(running.current||busy)return;
    running.current=true;setBusy(true);setError('');clearTimeout(timer.current);
    try{await action();}catch(e){if(active.current)setError(failureMessage(e));}
    finally{running.current=false;if(active.current)setBusy(false);}
  }
  async function review() {
    if(disabled)return;
    await run(async()=>{
      if(!current.current.length||current.current.some(entry=>quantityError(entry.quantity)))throw new Error('Enter a whole quantity for each product before reviewing.');
      await persist();if(active.current){setPage(0);setStep('review');}
    });
  }
  async function save() {
    if(disabled)return;
    await run(async()=>{
      const batch=current.current.map(entry=>({...entry,quantity:Number(entry.quantity)}));
      if(!batch.length||batch.some(entry=>!Number.isSafeInteger(entry.quantity)||entry.quantity<=0||entry.quantity>MAX_QUANTITY))throw new Error('Enter a whole quantity for each product before saving.');
      await persist(current.current,true);lockedRef.current=true;setLocked(true);
      await engine.addBatch(batch,operation.current);
      await queue.current.catch(()=>{});await control.setEntry('drafts',sessionId,null);completed.current=true;if(active.current)done(true);
    });
  }
  async function back() {
    if(step==='review'&&!locked){setStep('search');return;}
    await run(async()=>{if(operation.current)await persist();completed.current=true;done();});
  }
  const allowed=useMemo(()=>count.countType==='DIRECTED_COUNT'?new Set(count.items.filter(i=>i.isRequested).map(i=>i.productId)):undefined,[count.countType,count.items]);
  const counted=useMemo(()=>new Map(count.items.map(item=>[item.productId,item.quantity??0])),[count.items]);
  const quantities=useMemo(()=>new Map(entries.map(entry=>[entry.product.productId,entry.quantity])),[entries]);
  const batchRecorded=locked&&engine.events.events.some(event=>event.batchId===operation.current);
  const units=entries.reduce((sum,entry)=>sum+(quantityError(entry.quantity)?0:Number(entry.quantity)),0),invalid=entries.some(entry=>quantityError(entry.quantity));
  return <s-stack direction="block" gap="large">
    <BackButton loading={busy} disabled={busy} onClick={back}>{step==='review'&&!locked?'Hand count':'Count items'}</BackButton>
    <s-heading>{step==='review'?'Review hand count':'Hand count'}</s-heading>
    {error&&<s-banner tone="critical" heading={error}/>}
    {step==='search'&&<>
      <s-text>Enter additional units counted by hand. These are added to your existing session quantities when you save.</s-text>
      <s-stack direction="inline" alignItems="center" justifyContent="space-between" gap="base">
        <s-text type="strong">{amount(entries.length,'product')} · {amount(units,'unit')} to add</s-text>
        <s-button variant="primary" disabled={busy||disabled||invalid||!entries.length} onClick={review}>Review and save</s-button>
      </s-stack>
      <CatalogPicker request={request} allowedIds={allowed} memory={searchMemory.current} disabled={busy||disabled||locked} renderProduct={(product,rowDisabled)=><HandQuantityRow key={product.productId} product={product} value={quantities.get(product.productId)||''} already={counted.get(product.productId)||0} disabled={rowDisabled} notRequested={!!allowed&&!allowed.has(product.productId)} canViewOnHand={count.canViewOnHand} change={change}/>}/>
    </>}
    {step==='review'&&<>
      <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="base">
        <s-text type="strong">{amount(entries.length,'product')} · {amount(units,'additional unit')}</s-text>
        <s-button variant="primary" loading={busy} disabled={busy||disabled||!entries.length} onClick={save}>Save</s-button>
      </s-stack>
      <s-text>Save adds these quantities as hand-count scan events in this session.</s-text>
      {locked&&<s-banner tone="info" heading="Finish saving this batch">The quantities are locked for a safe retry. Saving again will not count them twice.</s-banner>}
      {!entries.length&&<s-text>No pending products. Go back to Hand count to add products.</s-text>}
      {entries.slice(page*40,(page+1)*40).map(entry=><s-section key={entry.product.productId}>
        <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="base">
          <s-stack direction="inline" gap="base" alignItems="center" maxInlineSize="360px">
            {entry.product.imageUrl&&<s-box inlineSize="48px" minInlineSize="48px" blockSize="48px"><s-image src={entry.product.imageUrl} objectFit="contain"/></s-box>}
            <s-stack direction="block" gap="small" maxInlineSize="296px">
              <s-text type="strong">{entry.product.title||entry.product.sku}</s-text>
              <s-text color="subdued">{entry.product.primary||entry.product.sku||entry.product.productId}</s-text>
              <s-text>Add {entry.quantity} units</s-text>
            </s-stack>
          </s-stack>
          <s-stack direction="inline" gap="base" alignItems="center">
            <s-stack direction="block" gap="small"><s-text color="subdued">{batchRecorded?'Counted in session':'Already counted'}</s-text><s-text type="strong">{counted.get(entry.product.productId)||0}</s-text></s-stack>
            <s-stack direction="block" gap="small"><s-text color="subdued">{batchRecorded?'Saved total':'After saving'}</s-text><s-text type="strong">{Number(counted.get(entry.product.productId)||0)+(batchRecorded?0:Number(entry.quantity))}</s-text></s-stack>
            <s-button disabled={busy||disabled||locked} onClick={()=>discard(entry.product)}>Discard</s-button>
          </s-stack>
        </s-stack>
      </s-section>)}
      <CompactPager page={page} pages={Math.max(1,Math.ceil(entries.length/40))} total={entries.length} onPage={setPage} disabled={busy}/>
    </>}
  </s-stack>;
}
