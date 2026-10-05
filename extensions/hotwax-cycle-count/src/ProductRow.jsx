import {memo} from './memo';
import {ActionRow} from './FlowParts.jsx';
function ProductRowContent({item,selected,disabled,onSelect}) {
  const title=item.primary||item.title||item.sku||item.productId;
  const detail=`${item.title||item.sku||item.productId} · ${item.secondary||item.sku||item.productId}${item.isRequested===false?' · Extra product':''}${item.decision==='SKIPPED'?' · Discarded':''}`;
  const quantity=item.quantity==null?'Uncounted':`${item.quantity} counted`;
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
