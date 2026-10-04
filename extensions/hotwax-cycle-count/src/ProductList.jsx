import {memo} from './memo';
import {useId,useMemo,useRef,useState,useEffect} from 'preact/hooks';
import {CountListIndex,PRODUCT_PAGE_SIZE} from './count-list';
import {ProductRow} from './ProductRow.jsx';

export function CompactPager({page,pages,total,onPage,disabled,label='products'}) {
  if(pages<=1)return null;
  return <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between">
    <s-button disabled={disabled||page===0} onClick={()=>onPage(page-1)}>Previous</s-button>
    <s-text color="subdued">{page+1} / {pages} · {total} {label}</s-text>
    <s-button disabled={disabled||page+1>=pages} onClick={()=>onPage(page+1)}>Next</s-button>
  </s-stack>;
}
function ProductListContent({items,disabled=false,directed=false,onSelect,selected,initialView='all',filters=true,showTabs=true,activeView,memory,countExtras=false,renderViewActions,listIndex,search:searchShop,onVisible}) {
  const [search,setSearch]=useState(memory?.search||''),[selectedView,setView]=useState(memory?.view||initialView),[page,setPage]=useState(memory?.page||0);
  const view=activeView??(!directed&&selectedView==='undirected'?'all':selectedView);
  const [sort,setSort]=useState(memory?.sort||'assigned');
  const sortId=useId(),sortOptions=[['assigned','Assigned order'],['alphabetic','Alphabetical'],['lastUpdated','Recently updated']];
  // A caller-owned index survives tab and route remounts, so a large session's
  // search text is not rebuilt each time the list is shown again.
  const timer=useRef(0),index=useRef(null);
  if(!index.current)index.current=listIndex||new CountListIndex();
  useEffect(()=>()=>clearTimeout(timer.current),[]);
  useEffect(()=>{if(memory)Object.assign(memory,{search,view,page,sort});},[search,view,page,sort,memory]);
  // With a query, Shopify search supplies relevance-ordered session products (by
  // variant); local matches on identifiers and known names follow.
  const query=search.trim(),[remote,setRemote]=useState(null);
  useEffect(()=>{
    if(!searchShop||!query){setRemote(null);return;}
    let stale=false;
    setRemote(old=>old?.query===query?{...old,loading:true}:{query,ids:[],complete:false,loading:true});
    // Relevance pages as needed; any other sort applies to the whole result set, so walk it all.
    searchShop(query,sort==='assigned'?(page+2)*PRODUCT_PAGE_SIZE:Infinity).then(found=>{if(!stale)setRemote(found?{query,...found,loading:false}:null);})
      .catch(()=>{if(!stale)setRemote(old=>old&&{...old,complete:true,loading:false});});
    return()=>{stale=true;};
  },[searchShop,query,page,sort,items.length]);
  const result=useMemo(()=>{
    const list=index.current,viewKey=countExtras&&view==='counted'?'countedAll':view;
    list.update(items);
    if(!remote||remote.query!==query)return list.page(search,viewKey,page,sort);
    // Exact identifier or barcode matches first, then Shopify relevance, then other local matches.
    const inView=new Set(list.list('',viewKey)),ordered=[...list.exact(search).filter(id=>inView.has(id)),...remote.ids.filter(id=>inView.has(id))];
    const shown=new Set(ordered),ids=[...shown,...list.list(search,viewKey).filter(id=>!shown.has(id))];
    return list.slice(list.sort(ids,sort),page);
  },[items,search,view,page,sort,countExtras,remote]);
  useEffect(()=>{onVisible?.(result.items);},[result.items,onVisible]);
  const views=[['all','All'],['uncounted','Uncounted'],['counted','Counted'],...(directed?[['undirected','Extra']]:[])];
  return <s-stack direction="block" gap="base">
    <s-text-field label="Find a product" placeholder="Name, SKU or barcode" value={search} onInput={e=>{const value=e.currentTarget.value;clearTimeout(timer.current);timer.current=setTimeout(()=>{setSearch(value);setPage(0);},180);}}/>
    {filters&&showTabs&&<s-tabs value={view} onChange={e=>{setView(e.currentTarget.value);setPage(0);}}><s-tab-list>{views.map(([id,label])=><s-tab key={id} controls={id}>{label}</s-tab>)}</s-tab-list>{views.map(([id])=><s-tab-panel key={id} id={id}/>)}</s-tabs>}
    {renderViewActions?.(view)}
    <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="base">
      <s-text color="subdued">{result.total}{remote&&!remote.complete?'+':''} {result.total===1?'product':'products'}{remote?.loading?' · Searching…':selected?' · Tap to select':onSelect?' · Tap for details':''}</s-text>
      {filters&&<s-button disabled={disabled} command="--show" commandFor={sortId}>Sort · {sortOptions.find(([value])=>value===sort)?.[1]}</s-button>}
    </s-stack>
    {filters&&<s-modal id={sortId} heading="Sort products">
      <s-choice-list values={[sort]} onChange={e=>{const next=e.currentTarget.values[0];if(sortOptions.some(([value])=>value===next)){setSort(next);setPage(0);}}}>
        {sortOptions.map(([value,label])=><s-choice key={value} value={value}>{label}</s-choice>)}
      </s-choice-list>
      <s-button slot="primary-action" command="--hide" commandFor={sortId}>Done</s-button>
    </s-modal>}
    {!result.total&&<s-text>No products match this view.</s-text>}
    <s-stack direction="block" gap="none" key={`${view}:${sort}:${search}:${result.page}`}>
      {result.items.map(item=><ProductRow key={item.productId} item={item} selected={selected?.has(item.productId)} disabled={disabled} onSelect={onSelect}/>)}
    </s-stack>
    {result.total>PRODUCT_PAGE_SIZE&&<CompactPager {...result} disabled={disabled} onPage={setPage}/>}
  </s-stack>;
}
export const ProductList=memo(ProductListContent);
