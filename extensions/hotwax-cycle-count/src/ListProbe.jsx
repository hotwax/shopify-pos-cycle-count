import {useEffect,useState,useRef,useCallback} from 'preact/hooks';
import {ProductList} from './ProductList.jsx';

// Development-only UI load, never a product catalogue or OMS API substitute.
export function ListProbe({close}) {
  const [items,setItems]=useState(()=>Array.from({length:5000},(_,i)=>({productId:`list-probe-${i}`,title:`List test product ${String(i+1).padStart(4,'0')}`,sku:`PROBE-${String(i+1).padStart(4,'0')}`,quantity:0,isRequested:true,revision:0,syncedRevision:0})));
  const [running,setRunning]=useState(false),[ticks,setTicks]=useState(0),[timing,setTiming]=useState('');
  const delays=useRef([]);
  useEffect(()=>{
    if(!running)return;
    let expected=performance.now()+250, tick=0;
    const timer=setInterval(()=>{
      delays.current.push(Math.max(0,performance.now()-expected));expected=performance.now()+250;
      tick++;setTicks(n=>n+1);
      setItems(previous=>{const next=[...previous],i=(tick%40);next[i]={...next[i],quantity:next[i].quantity+1,revision:tick,syncedRevision:tick-1};return next;});
      if(tick%20===0){const sorted=[...delays.current].sort((a,b)=>a-b);setTiming(`Worker timer delay p95 ${Math.round(sorted[Math.floor((sorted.length-1)*.95)])} ms · ${sorted.length} updates`);}
    },250);
    return()=>clearInterval(timer);
  },[running]);
  const add=useCallback(async job=>{setItems(previous=>previous.map(item=>item.productId===job.productId?{...item,quantity:job.quantity}:item));return 1;},[]);
  const select=useCallback(item=>add({productId:item.productId,quantity:item.quantity+1}),[add]);
  return <s-box padding="large"><s-stack direction="block" gap="base">
    <s-button onClick={close}>Exit list check</s-button>
    <s-banner tone="info" heading="Synthetic UI load · no OMS writes">Uses the same product rows and paging as real sessions. Background updates simulate quantity and sync changes; this is not a hardware scanner or network benchmark.</s-banner>
    <s-button onClick={()=>setRunning(value=>!value)}>{running?'Stop background updates':'Start background updates'}</s-button>
    <s-text>{ticks} background updates · 40 rows per page</s-text>{timing&&<s-text>{timing}</s-text>}
    <ProductList items={items} onSelect={select}/>
  </s-stack></s-box>;
}
