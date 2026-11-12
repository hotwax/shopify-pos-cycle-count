import {useEffect,useMemo,useRef,useState} from 'preact/hooks';
import {bindCountRequest,countTypeName} from './count-api';
import {COUNT_SESSION} from './count-navigation';
import {fetchVariantDisplays} from './scan-products';
import {layout} from './layout';

const operationId=()=>Array.from({length:15},()=>Math.floor(Math.random()*16).toString(16)).join('');
const message=failure=>failure?.message||'HotWax could not complete the request.';
const MAX=1000000;

/**
 * Opened from a product page: count this one product straight away. While the quantity is set, HotWax finds the count
 * it belongs in (a directed count asking for it, an open dynamic count, or a new dynamic count) and the operator's
 * open session there. Save to list writes the quantity to that session and opens it, where it is submitted as usual.
 */
export function QuickCount({owner,variantId,setHeader}) {
  const request=useMemo(()=>bindCountRequest(owner),[owner]);
  const [display,setDisplay]=useState(null),[target,setTarget]=useState(null),[error,setError]=useState('');
  const [value,setValue]=useState('1'),[mode,setMode]=useState(''),[saving,setSaving]=useState(false);
  const pending=useRef(null),alive=useRef(true),left=useRef(false),entryKey=useRef(navigation.currentEntry?.key);

  function find() {
    setError('');
    const lookup=request('quickCountTarget',{variantId,operationId:operationId()}).then(found=>{
      if(alive.current){setTarget(found);setMode('');}
      return found;
    });
    lookup.catch(failure=>{if(alive.current&&pending.current===lookup){pending.current=null;setError(message(failure));}});
    pending.current=lookup;
    return lookup;
  }
  useEffect(()=>{
    alive.current=true;
    fetchVariantDisplays(shopify.productSearch,[variantId]).then(found=>{if(alive.current)setDisplay(found.get(variantId)||null);}).catch(()=>{});
    find();
    // Back from the session page: its counting may have changed this product, so read the count again.
    // POS sends navigatesuccess to the screen that reappears; some builds send only currententrychange.
    const shown=()=>{if(alive.current&&left.current&&navigation.currentEntry?.key===entryKey.current){left.current=false;setMode('');find();}};
    navigation.addEventListener('navigatesuccess',shown);
    navigation.addEventListener('currententrychange',shown);
    return()=>{alive.current=false;navigation.removeEventListener('navigatesuccess',shown);navigation.removeEventListener('currententrychange',shown);};
  },[variantId]);
  useEffect(()=>{setHeader({heading:'Count product',subheading:'',action:null});},[target]);

  const quantity=value.trim()===''?null:Number(value);
  const valid=quantity!==null&&Number.isSafeInteger(quantity)&&quantity>=0&&quantity<=MAX;
  const before=target?.counted??null;
  // Counted before in this session: the operator decides whether this replaces or adds to it.
  const needsChoice=before!==null;
  const total=valid?(mode==='add'?before+quantity:quantity):null;
  const ready=valid&&(!needsChoice||mode)&&(total===null||total<=MAX);

  async function save() {
    if(!ready||saving)return;
    setSaving(true);setError('');
    try {
      const found=await (pending.current||find());
      if(found.counted!==before){setError('This product was counted again meanwhile. Choose replace or add again.');return;}
      const result=await request('quickCountSave',{workEffortId:found.workEffortId,sessionId:found.sessionId,productId:found.product.productId,
        quantity:total,expectedQuantity:found.counted});
      if(!alive.current)return;
      // What HotWax now holds, in case the screen is shown again before it is read again.
      const saved={...found,counted:total};
      pending.current=Promise.resolve(saved);setTarget(saved);setMode('');setValue('1');
      left.current=true;
      await navigation.navigate(COUNT_SESSION,{state:{owner,sessionId:result.sessionId,name:result.sessionName||found.sessionName,listed:true}});
    } catch(failure) {
      if(!alive.current)return;
      setError(message(failure));
      // A changed count or session is found again; the quantity stays.
      if(failure?.status===409||/changed/i.test(message(failure)))find();
    } finally {if(alive.current)setSaving(false);}
  }

  const title=display?.title||target?.product.title||'Loading product…';
  const sku=display?.sku||target?.product.sku||'';
  const image=display?.imageUrl||target?.product.imageUrl||undefined;
  const where=target?`${target.created?'New ':''}${countTypeName(target.countType).toLowerCase()}`:error?'':'Finding a count for this product…';
  const step=change=>{const next=Math.min(MAX,Math.max(0,(valid?quantity:0)+change));setValue(String(next));};

  const picture=<s-box blockSize={layout.compact?'240px':'360px'} borderRadius="large" background="subdued" padding="base">
    <s-image src={image} alt={title} inlineSize="fill" objectFit="contain"/>
  </s-box>;
  const details=<s-stack direction="block" gap="large">
    <s-stack direction="block" gap="small-200">
      <s-heading>{title}</s-heading>
      {sku&&<s-text color="subdued">{sku}</s-text>}
    </s-stack>
    <s-stack direction="block" gap="small-200">
      <s-text type="strong">{target?target.countName:''}</s-text>
      <s-text color="subdued">{where.charAt(0).toUpperCase()+where.slice(1)}</s-text>
    </s-stack>
    <s-divider/>
    <s-stack direction="inline" gap="base" alignItems="center">
      <s-button disabled={saving||!valid||quantity<=0} onClick={()=>step(-1)}>−</s-button>
      <s-box inlineSize="140px"><s-number-field label="Quantity" controls="none" inputMode="numeric" min={0} max={MAX} value={value} disabled={saving}
        error={value.trim()!==''&&!valid?'Whole number':undefined} onInput={e=>setValue(e.currentTarget.value)} onChange={e=>setValue(e.currentTarget.value)}/></s-box>
      <s-button disabled={saving||(valid&&quantity>=MAX)} onClick={()=>step(1)}>+</s-button>
    </s-stack>
    {needsChoice&&<s-stack direction="block" gap="small">
      <s-text type="strong">{`You counted ${before} here before`}</s-text>
      <s-choice-list name="quick-count-mode" values={mode?[mode]:[]} disabled={saving} onChange={e=>setMode(e.currentTarget.values?.[0]||'')}>
        <s-choice value="replace">{`Replace it${valid?` · total ${quantity}`:''}`}</s-choice>
        <s-choice value="add">{`Add to it${valid?` · total ${before+quantity}`:''}`}</s-choice>
      </s-choice-list>
    </s-stack>}
    {error&&<s-banner tone="critical" heading={error}>{!target&&<s-button slot="secondary-actions" onClick={find}>Try again</s-button>}</s-banner>}
    {/* Two 48% halves without a gap fit one row at any width; 50% halves plus a gap wrap. */}
    <s-stack direction="inline" justifyContent="space-between">
      <s-box inlineSize="48%"><s-button variant="secondary" inlineSize="fill" disabled={saving} onClick={()=>window.close()}>Discard</s-button></s-box>
      <s-box inlineSize="48%"><s-button variant="primary" inlineSize="fill" loading={saving} disabled={!ready||(!target&&!!error)} onClick={save}>Save to list</s-button></s-box>
    </s-stack>
  </s-stack>;
  // Tablets put the picture beside the details so the actions stay on screen; phones stack them.
  return <s-scroll-box><s-box padding="large">{layout.compact
    ?<s-stack direction="block" gap="large">{picture}{details}</s-stack>
    :<s-stack direction="inline" gap="large" alignItems="start">
      <s-box inlineSize="42%">{picture}</s-box>
      <s-box inlineSize="55%">{details}</s-box>
    </s-stack>}</s-box></s-scroll-box>;
}
