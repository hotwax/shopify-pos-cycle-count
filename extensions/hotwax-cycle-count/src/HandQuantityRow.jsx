import {memo} from 'preact/compat';

const MAX_QUANTITY=1000000;
const quantityError=value=>value!==''&&(!Number.isSafeInteger(Number(value))||Number(value)<0||Number(value)>MAX_QUANTITY)?'Enter a whole number from 0 to 1,000,000.':'';

function HandQuantityInput({product,value,already,disabled,notRequested,canViewOnHand,change}) {
  const units=Number(value)||0;
  return <s-section>
    <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="base">
      <s-stack direction="inline" gap="base" alignItems="center" maxInlineSize="480px">
        {product.imageUrl&&<s-box inlineSize="48px" minInlineSize="48px" blockSize="48px"><s-image src={product.imageUrl} objectFit="contain"/></s-box>}
        <s-stack direction="block" gap="small" maxInlineSize="416px">
          <s-text type="strong">{product.title||product.primary||product.sku}</s-text>
          <s-text color="subdued">{product.primary||product.sku||product.productId}{product.secondary?` · ${product.secondary}`:''} · {already} already counted</s-text>
          {canViewOnHand&&product.onHand!=null&&<s-text color="subdued">On hand {product.onHand}</s-text>}
        </s-stack>
      </s-stack>
      {notRequested?<s-text color="subdued">Not requested in this session</s-text>:<s-stack direction="inline" gap="small" alignItems="start">
        <s-stack blockSize="64px" justifyContent="center"><s-button disabled={disabled||units<=0} onClick={()=>change(product,String(Math.max(0,units-1)))}>−</s-button></s-stack>
        <s-box inlineSize="120px"><s-number-field label="Add units" controls="none" inputMode="numeric" min={0} max={MAX_QUANTITY} value={value} placeholder="0" disabled={disabled} error={quantityError(value)||undefined} onInput={e=>change(product,e.currentTarget.value)}/></s-box>
        <s-stack blockSize="64px" justifyContent="center"><s-button disabled={disabled||units>=MAX_QUANTITY} onClick={()=>change(product,String(Math.min(MAX_QUANTITY,units+1)))}>+</s-button></s-stack>
      </s-stack>}
    </s-stack>
  </s-section>;
}
export const HandQuantityRow=memo(HandQuantityInput);
