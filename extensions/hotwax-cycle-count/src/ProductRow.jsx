import {memo} from './memo';
import {ActionRow} from './FlowParts.jsx';
import {InlineQuantity} from './InlineQuantity.jsx';
function ProductRowContent({item,selected,disabled,onSelect,onQuantity,onActivate}) {
  const title=item.title||item.primary||item.sku||item.productId;
  const detail=`${[item.primary,item.secondary||item.sku||item.productId].filter(value=>value&&value!==title).join(' · ')}${item.isRequested===false?' · Extra product':''}${item.decision==='SKIPPED'?' · Discarded':''}`;
  const quantity=item.quantity==null?'Uncounted':`${item.quantity} counted`;
  if(onQuantity)return <s-section>
    <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="base">
      <s-stack direction="inline" gap="base" alignItems="center" maxInlineSize="480px">
        {item.imageUrl&&<s-box inlineSize="48px" minInlineSize="48px" blockSize="48px"><s-image src={item.imageUrl} objectFit="contain"/></s-box>}
        <s-stack direction="block" gap="small" maxInlineSize="416px"><s-text type="strong">{title}</s-text><s-text color="subdued">{detail}</s-text></s-stack>
      </s-stack>
      <InlineQuantity item={item} disabled={disabled} onQuantity={onQuantity} onActivate={onActivate}/>
    </s-stack>
  </s-section>;
  if(selected!==undefined)return <s-choice-list multiple values={selected?[item.productId]:[]} onChange={()=>onSelect?.(item)}>
    <s-choice value={item.productId} disabled={disabled||!onSelect}>
      <s-box padding="base" minBlockSize="64px"><s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="base">
        <s-stack direction="inline" gap="base" alignItems="center">
          {item.imageUrl&&<s-box inlineSize="48px" blockSize="48px"><s-image src={item.imageUrl}/></s-box>}
          <s-stack direction="block" gap="small"><s-text type="strong">{title}</s-text><s-text color="subdued">{detail}</s-text></s-stack>
        </s-stack>
        <s-text>{quantity}</s-text>
      </s-stack></s-box>
    </s-choice>
  </s-choice-list>;
  return <ActionRow title={title} imageUrl={item.imageUrl} detail={detail} meta={quantity} showChevron={!!onSelect}
    disabled={disabled||!onSelect} onClick={()=>onSelect?.(item)}/>;
}
export const ProductRow=memo(ProductRowContent);
