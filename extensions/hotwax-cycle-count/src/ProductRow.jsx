import {memo} from './memo';
import {ActionRow,Thumbnail,productDetail} from './FlowParts.jsx';
import {InlineQuantity} from './InlineQuantity.jsx';
import {layout} from './layout';
function ProductRowContent({item,selected,disabled,onSelect,onQuantity,onQuantityInput,onActivate}) {
  const title=item.title||item.primary||item.sku||item.productId;
  // The title already carries the product and variant names; the detail line
  // keeps only identifiers it does not repeat.
  const detail=[productDetail(title,[item.primary,item.secondary||item.sku||item.productId]),
    item.notInSession?'Not in this session yet':item.isRequested===false?'Extra product':'',item.decision==='SKIPPED'?'Discarded':''].filter(Boolean).join(' · ');
  const quantity=item.quantity==null?'Uncounted':`${item.quantity} counted`;
  // On a phone the stepper goes under the name; side by side it would leave the name a few letters wide.
  if(onQuantity)return <s-section>
    <s-stack direction={layout.compact?'block':'inline'} justifyContent="space-between" alignItems={layout.compact?'stretch':'center'} gap="base">
      <s-stack direction="inline" gap="base" alignItems="center" maxInlineSize="480px">
        <Thumbnail src={item.imageUrl}/>
        <s-stack direction="block" gap="small" maxInlineSize="416px"><s-text type="strong">{title}</s-text><s-text color="subdued">{detail}</s-text></s-stack>
      </s-stack>
      {/* A catalog match a directed count did not request explains why it has no stepper. */}
      {item.unavailable?<s-text color="subdued">{item.unavailable}</s-text>
        :<InlineQuantity item={item} disabled={disabled} onQuantity={onQuantity} onQuantityInput={onQuantityInput} onActivate={onActivate}/>}
    </s-stack>
  </s-section>;
  if(selected!==undefined)return <s-choice-list multiple values={selected?[item.productId]:[]} onChange={()=>onSelect?.(item)}>
    <s-choice value={item.productId} disabled={disabled||!onSelect}>
      <s-box padding="base" minBlockSize="64px"><s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="base">
        <s-stack direction="inline" gap="base" alignItems="center">
          <Thumbnail src={item.imageUrl}/>
          <s-stack direction="block" gap="small"><s-text type="strong">{title}</s-text><s-text color="subdued">{detail}</s-text></s-stack>
        </s-stack>
        <s-text>{quantity}</s-text>
      </s-stack></s-box>
    </s-choice>
  </s-choice-list>;
  return <ActionRow title={title} imageUrl={item.imageUrl} thumbnail detail={detail} meta={quantity} showChevron={!!onSelect}
    disabled={disabled||!onSelect} onClick={()=>onSelect?.(item)}/>;
}
export const ProductRow=memo(ProductRowContent);
