import {useEffect,useRef,useState} from 'preact/hooks';
import {ActionRow,BackButton} from './FlowParts.jsx';
import {CompactPager} from './ProductList.jsx';

export function CatalogPicker({request,onPick,selected,scope=false,disabled=false,allowedIds,onSelectAll,renderProduct,memory}) {
  const [input,setInput]=useState(memory?.search||''),[search,setSearch]=useState(memory?.search?.trim()||''),[tags,setTags]=useState([]),[tagOptions,setTagOptions]=useState([]);
  const [result,setResult]=useState(null),[page,setPage]=useState(memory?.page||0),[loading,setLoading]=useState(false),[error,setError]=useState('');
  const [showTags,setShowTags]=useState(false),[tagPage,setTagPage]=useState(0),[tagSearch,setTagSearch]=useState('');
  const [selectedOnly,setSelectedOnly]=useState(false),[collecting,setCollecting]=useState(false);
  const generation=useRef(0),alive=useRef(true);
  useEffect(()=>()=>{alive.current=false;generation.current++;},[]);
  useEffect(()=>{const timer=setTimeout(()=>{if(input.trim()!==search){setSearch(input.trim());setPage(0);}},250);return()=>clearTimeout(timer);},[input,search]);
  useEffect(()=>{if(memory)Object.assign(memory,{search:input,page});},[input,page]);
  useEffect(()=>{
    const token=++generation.current;
    if(selectedOnly){setLoading(false);return;}
    if(!search&&!tags.length){setResult(null);setLoading(false);return;}
    setLoading(true);setError('');
    request('catalog',{search,tags,pageIndex:page,scope}).then(value=>{if(alive.current&&token===generation.current)setResult(value);})
      .catch(e=>{if(alive.current&&token===generation.current)setError(e instanceof Error?e.message:'Could not complete this action. Your saved work is retained.');})
      .finally(()=>{if(alive.current&&token===generation.current)setLoading(false);});
  },[search,tags,page,scope,selectedOnly]);
  async function openTags(){
    setShowTags(true);setError('');if(tagOptions.length)return;
    setLoading(true);
    try{const value=await request('catalog',{scope:true,facets:true});if(alive.current)setTagOptions(value.tags);}
    catch(e){if(alive.current)setError(e instanceof Error?e.message:'Could not complete this action. Your saved work is retained.');}finally{if(alive.current)setLoading(false);}
  }
  async function selectAll(){
    setCollecting(true);setError('');
    try{
      if(result.total>2000)throw new Error('Narrow the search to 2,000 products or fewer before selecting all.');
      let next=0,items=[];
      do{const value=await request('catalog',{search,tags,pageIndex:next,scope});items.push(...value.items);next=value.nextPage;}while(next!==null&&alive.current);
      if(items.length>2000)throw new Error('The product list changed. Narrow your search and try again.');
      if(alive.current)onSelectAll(items);
    }catch(e){if(alive.current)setError(e instanceof Error?e.message:'Could not complete this action. Your saved work is retained.');}finally{if(alive.current)setCollecting(false);}
  }
  const selectedItems=selected?[...selected.values()]:[],products=selectedOnly?selectedItems.slice(page*40,(page+1)*40):(result?.items||[]);
  const tagMatches=tagOptions.filter(t=>t.value.toLowerCase().includes(tagSearch.toLowerCase()));
  if(showTags)return <s-stack direction="block" gap="base">
    <BackButton loading={loading} onClick={()=>setShowTags(false)}>Products</BackButton><s-text type="strong">Filter by tags</s-text>
    <s-text-field label="Find a tag" value={tagSearch} onInput={e=>{setTagSearch(e.currentTarget.value);setTagPage(0);}}/>
    {error&&<s-banner tone="critical" heading={error}/>}
    {tagMatches.slice(tagPage*40,(tagPage+1)*40).map(t=><ActionRow key={t.value} title={t.value} meta={tags.includes(t.value)?'Selected':String(t.count)} onClick={()=>{setTags(old=>old.includes(t.value)?old.filter(v=>v!==t.value):[...old,t.value]);setPage(0);}}/>)}
    <CompactPager page={tagPage} pages={Math.max(1,Math.ceil(tagMatches.length/40))} total={tagMatches.length} label="tags" onPage={setTagPage}/>
    <s-button variant="primary" onClick={()=>setShowTags(false)}>Show products</s-button>
  </s-stack>;
  return <s-stack direction="block" gap="base">
    <s-text-field label="Find an OMS product" placeholder="Product name, SKU or UPC" value={input} disabled={disabled||collecting} onInput={e=>setInput(e.currentTarget.value)}/>
    {scope&&<s-stack direction="inline" gap="base"><s-button disabled={collecting} onClick={openTags}>{tags.length?`${tags.length} tags selected`:'Filter by tags'}</s-button>{tags.length>0&&<s-button onClick={()=>{setTags([]);setPage(0);}}>Clear tags</s-button>}</s-stack>}
    {selected&&<s-stack direction="inline" gap="base"><s-button disabled={collecting} onClick={()=>{setSelectedOnly(v=>!v);setPage(0);}}>{selectedOnly?'Search results':`Selected (${selected.size})`}</s-button>{onSelectAll&&result?.total>0&&!selectedOnly&&<s-button disabled={disabled||loading||collecting} onClick={selectAll}>Select all {result.total} matches</s-button>}</s-stack>}
    {error&&<s-banner tone="critical" heading={error}/>}
    <s-stack direction="inline" alignItems="center" justifyContent="space-between" gap="base">
      <s-text color="subdued">{collecting?'Selecting matching products…':loading?'Finding products…':selectedOnly?`${selectedItems.length} selected products`:result?`${result.total} matching products`:`Search by name or identifier${scope?', or choose a tag':''} to find products.`}</s-text>
      <s-box inlineSize="32px" blockSize="32px">{(loading||collecting)&&<s-spinner accessibilityLabel={collecting?'Selecting products':'Finding products'}/>}</s-box>
    </s-stack>
    {products.map(product=>renderProduct?renderProduct(product,disabled||loading||collecting||!!allowedIds&&!allowedIds.has(product.productId)):<ActionRow key={product.productId} title={product.primary||product.title} detail={`${product.title} · ${product.secondary||product.sku}`} imageUrl={product.imageUrl}
      meta={selected?.has(product.productId)?'Selected':allowedIds&&!allowedIds.has(product.productId)?'Not requested':undefined}
      disabled={disabled||loading||collecting||!!allowedIds&&!allowedIds.has(product.productId)} onClick={()=>onPick(product)}/>)}
    {selectedOnly?<CompactPager page={page} pages={Math.max(1,Math.ceil(selectedItems.length/40))} total={selectedItems.length} onPage={setPage}/>:result&&<CompactPager page={page} pages={Math.max(1,Math.ceil(result.total/40))} total={result.total} onPage={setPage} disabled={disabled||loading||collecting}/>}
  </s-stack>;
}
