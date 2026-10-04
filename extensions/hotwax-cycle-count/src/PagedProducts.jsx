import {memo} from 'preact/compat';
import {useMemo,useRef,useState,useCallback,useEffect} from 'preact/hooks';
import {ProductRow} from './ProductRow.jsx';
import {CountListIndex,PRODUCT_PAGE_SIZE} from './count-list';

export function Pager({page,pages,total,onPage,disabled,label='products'}) {
  return <s-stack direction="inline" gap="base" alignItems="center">
    <s-button disabled={disabled || page===0} onClick={()=>onPage(page-1)}>Previous</s-button>
    <s-text>Page {page+1} of {pages} · {total} {label}</s-text>
    <s-button disabled={disabled || page+1>=pages} onClick={()=>onPage(page+1)}>Next</s-button>
  </s-stack>;
}
function ProductPages({items,editable=false,blind=true,reviewing=false,disabled=false,add,directed=false,selected,select,contribute,onView}) {
  const [search,setSearch] = useState(''), [view,setView] = useState('all'), [page,setPage] = useState(0);
  const timer = useRef(0), index = useRef(new CountListIndex());
  useEffect(()=>()=>clearTimeout(timer.current),[]);
  const filtered = useMemo(()=>{index.current.update(items); return index.current.page(search,view,page);},[items,search,view,page]);
  const filter = useCallback(next=>{setView(next);setPage(0);onView?.(next);},[onView]);
  return <s-stack direction="block" gap="base">
    <s-text-field label="Find a product" placeholder="Product name, SKU, or barcode" onInput={e=>{const value=e.currentTarget.value;clearTimeout(timer.current);timer.current=setTimeout(()=>{setSearch(value);setPage(0);},180);}} />
    <s-stack direction="inline" gap="small">
      {['all','uncounted','counted',...(directed?['undirected']:[])].map(key=><s-button key={key} variant={view===key?'primary':'secondary'} onClick={()=>filter(key)}>{key==='all'?'All products':key==='uncounted'?'Uncounted':key==='counted'?'Counted':'Undirected'}</s-button>)}
    </s-stack>
    <Pager {...filtered} disabled={disabled} onPage={setPage} />
    {!filtered.total && <s-text color="subdued">No products match this view.</s-text>}
    <s-stack direction="block" gap="base" key={`${view}:${filtered.page}`}>
      {filtered.items.map(item=><ProductRow key={item.productId} item={item} editable={editable} blind={blind} reviewing={reviewing} disabled={disabled} add={add} selected={selected?.has(item.productId)} select={select} contribute={contribute} />)}
    </s-stack>
    {filtered.total>PRODUCT_PAGE_SIZE && <Pager {...filtered} disabled={disabled} onPage={setPage} />}
  </s-stack>;
}
export const PagedProducts = memo(ProductPages);
