import {useEffect,useRef,useState} from 'preact/hooks';

export function InlineQuantity({item,disabled,onActivate,onQuantity,onQuantityInput}) {
  const saved=item.quantity==null?'':String(item.quantity);
  const [value,setValue]=useState(saved),[error,setError]=useState(''),[saving,setSaving]=useState(false);
  const writing=useRef(false),editing=useRef(false);
  useEffect(()=>{if(!editing.current&&!writing.current)setValue(saved);},[saved]);
  async function commit(change) {
    if(disabled||writing.current)return;
    onActivate(item.productId);
    writing.current=true;setSaving(true);setError('');
    try {const quantity=await onQuantity(item,change);if(quantity!=null)setValue(String(quantity));}
    catch(failure){setError(failure.message);}
    finally {writing.current=false;setSaving(false);}
  }
  return <s-stack direction="inline" gap="small" alignItems="start">
    <s-stack blockSize="64px" justifyContent="center"><s-button disabled={disabled||saving||item.quantity==null||item.quantity<=0} onClick={()=>commit({adjustment:-1})}>−</s-button></s-stack>
    {/* An empty field means "not counted yet", which is different from a count of 0. */}
    <s-box inlineSize="136px"><s-number-field label="Quantity" controls="none" inputMode="numeric" min={0} max={1000000} value={value} placeholder="Not counted" disabled={disabled||saving} error={error||undefined}
      onFocus={()=>{editing.current=true;onActivate(item.productId);}}
      onInput={e=>{const text=e.currentTarget.value;onQuantityInput(item,text);setValue(text);setError('');}}
      onChange={e=>{editing.current=false;const text=e.currentTarget.value;onQuantityInput(item,text);if(text===''){setValue(saved);return;}const quantity=Number(text);if(quantity!==item.quantity)commit({quantity});}}
      onBlur={()=>{editing.current=false;}}/></s-box>
    <s-stack blockSize="64px" justifyContent="center"><s-button disabled={disabled||saving||item.quantity>=1000000} onClick={()=>commit({adjustment:1})}>+</s-button></s-stack>
  </s-stack>;
}
