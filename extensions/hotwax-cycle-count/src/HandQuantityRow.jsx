import {memo} from './memo';
import {Thumbnail} from './FlowParts.jsx';

const MAX_QUANTITY=1000000;
const quantityError=value=>value!==''&&(!Number.isSafeInteger(Number(value))||Number(value)<0||Number(value)>MAX_QUANTITY)?'Enter a whole number from 0 to 1,000,000.':'';

export function HandProductIdentity({product}) {
  const title=product.title||product.sku||product.primary||product.productId;
  return <s-stack direction="inline" gap="small" alignItems="center" maxInlineSize="480px">
    <Thumbnail src={product.imageUrl}/>
    <s-stack direction="block" gap="none">
      <s-text type="strong">{title}</s-text>
      {product.sku&&product.sku!==title&&<s-text color="subdued">{product.sku}</s-text>}
    </s-stack>
  </s-stack>;
}

function HandQuantityInput({product,value,disabled,notRequested,change}) {
  const units=Number(value)||0;
  return <s-box paddingBlock="small">
    <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="base">
      <HandProductIdentity product={product}/>
      {notRequested?<s-text color="subdued">Not requested in this session</s-text>:<s-stack direction="inline" gap="small" alignItems="start">
        <s-stack blockSize="64px" justifyContent="center"><s-button disabled={disabled||units<=0} onClick={()=>change(product,String(Math.max(0,units-1)))}>−</s-button></s-stack>
        <s-box inlineSize="120px"><s-number-field label="Add units" controls="none" inputMode="numeric" min={0} max={MAX_QUANTITY} value={value} placeholder="0" disabled={disabled} error={quantityError(value)||undefined} onInput={e=>change(product,e.currentTarget.value)}/></s-box>
        <s-stack blockSize="64px" justifyContent="center"><s-button disabled={disabled||units>=MAX_QUANTITY} onClick={()=>change(product,String(Math.min(MAX_QUANTITY,units+1)))}>+</s-button></s-stack>
      </s-stack>}
    </s-stack>
  </s-box>;
}
export const HandQuantityRow=memo(HandQuantityInput);
