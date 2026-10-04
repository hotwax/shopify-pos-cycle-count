import {memo} from 'preact/compat';
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
function ProductListContent({items,disabled=false,directed=false,onSelect,selected,initialView='all',filters=true,showTabs=true,activeView,memory,countExtras=false,renderViewActions}) {
  const [search,setSearch]=useState(memory?.search||''),[selectedView,setView]=useState(memory?.view||initialView),[page,setPage]=useState(memory?.page||0);
  const view=activeView??(!directed&&selectedView==='undirected'?'all':selectedView);
  const [sort,setSort]=useState(memory?.sort||'assigned');
  const sortId=useId(),sortOptions=[['assigned','Assigned order'],['alphabetic','Alphabetical'],['lastUpdated','Recently updated']];
  const timer=useRef(0),index=useRef(new CountListIndex());
  useEffect(()=>()=>clearTimeout(timer.current),[]);
  useEffect(()=>{if(memory)Object.assign(memory,{search,view,page,sort});},[search,view,page,sort,memory]);
  const result=useMemo(()=>{index.current.update(items);return index.current.page(search,countExtras&&view==='counted'?'countedAll':view,page,sort);},[items,search,view,page,sort,countExtras]);
  const views=[['all','All'],['uncounted','Uncounted'],['counted','Counted'],...(directed?[['undirected','Extra']]:[])];
  return <s-stack direction="block" gap="base">
    <s-text-field label="Find a product" placeholder="Name, SKU or barcode" value={search} onInput={e=>{const value=e.currentTarget.value;clearTimeout(timer.current);timer.current=setTimeout(()=>{setSearch(value);setPage(0);},180);}}/>
    {filters&&showTabs&&<s-tabs value={view} onChange={e=>{setView(e.currentTarget.value);setPage(0);}}><s-tab-list>{views.map(([id,label])=><s-tab key={id} controls={id}>{label}</s-tab>)}</s-tab-list>{views.map(([id])=><s-tab-panel key={id} id={id}/>)}</s-tabs>}
    {renderViewActions?.(view)}
    <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="base">
      <s-text color="subdued">{result.total} {result.total===1?'product':'products'}{selected?' · Tap to select':onSelect?' · Tap for details':''}</s-text>
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
