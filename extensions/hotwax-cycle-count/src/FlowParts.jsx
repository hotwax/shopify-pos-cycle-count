import {useRef,useState} from 'preact/hooks';

export const amount=(value,noun)=>`${value} ${noun}${value===1?'':'s'}`;

export function BackButton({children='Back',disabled,onClick,loading=false}) {
  return <s-stack direction="inline" justifyContent="space-between" alignItems="center">
    <s-clickable disabled={disabled} onClick={onClick}><s-box padding="small" minBlockSize="44px"><s-stack direction="inline" gap="small" alignItems="center"><s-icon type="chevron-left"/><s-text type="strong">{children}</s-text></s-stack></s-box></s-clickable>
    <s-box inlineSize="32px" blockSize="32px">{loading&&<s-spinner accessibilityLabel="Loading"/>}</s-box>
  </s-stack>;
}

export function ActionRow({title,detail,notice,noticeTone='critical',meta,metaTone,onClick,disabled=false,imageUrl,showChevron=true}) {
  return <s-clickable disabled={disabled} onClick={onClick}>
    <s-box padding="base" minBlockSize="64px"><s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="base">
      <s-stack direction="inline" gap="base" alignItems="center">{imageUrl&&<s-box inlineSize="48px" blockSize="48px"><s-image src={imageUrl}/></s-box>}<s-stack direction="block" gap="small"><s-text type="strong">{title}</s-text>{detail&&<s-text color="subdued">{detail}</s-text>}{notice&&<s-text tone={noticeTone==='success'?'success':noticeTone==='neutral'?'neutral':'critical'}>{notice}</s-text>}</s-stack></s-stack>
      <s-stack direction="inline" gap="small" alignItems="center">{meta&&(metaTone?<s-badge tone={metaTone}>{meta}</s-badge>:<s-text>{meta}</s-text>)}{showChevron&&<s-icon type="chevron-right" />}</s-stack>
    </s-stack></s-box>
  </s-clickable>;
}
export function QuantityEditor({item,disabled,onSave}) {
  const value=useRef(item.quantity==null?'':String(item.quantity));
  const [error,setError]=useState('');
  return <s-stack direction="block" gap="large">
    <s-section heading={item.title||item.sku}><s-stack direction="block" gap="base">
      <s-text color="subdued">{item.primary||item.sku||item.productId} · {item.secondary||item.productId}</s-text>
      {item.onHand!=null&&<s-text>On hand {item.onHand}</s-text>}
      <s-number-field label="Total counted in this session" min={0} max={1000000} value={item.quantity==null?'':String(item.quantity)} disabled={disabled} onInput={e=>{value.current=e.currentTarget.value;setError('');}}/>
      <s-text color="subdued">Enter the total for this session, including units already scanned. Enter 0 only after checking the product.</s-text>
    </s-stack></s-section>
    {error&&<s-banner tone="critical" heading={error}/>}
    <s-button variant="primary" disabled={disabled} onClick={()=>{
      const quantity=value.current===''?NaN:Number(value.current);
      if(!Number.isSafeInteger(quantity)||quantity<0||quantity>1000000){setError('Enter a whole quantity between 0 and 1,000,000.');return;}
      onSave({code:item.productIdentifier||item.sku||item.productId,productId:item.productId,quantity,source:'correction'});
    }}>Save quantity</s-button>
  </s-stack>;
}
