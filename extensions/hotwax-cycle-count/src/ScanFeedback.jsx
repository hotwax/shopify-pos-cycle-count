export function ScanFeedback({last,hidMode}) {
  if(!last)return <s-text color="subdued">{hidMode?'Scan a barcode below.':'Scan a barcode or enter quantities.'}</s-text>;
  const heading=last?.discarded?'Scan removed':last?.matched?last.source==='undo'?'Last scan undone':last.source==='correction'?'Quantity saved':'Counted':last?.matchingFailed?'Scan needs matching':last?'Finding product…':hidMode?'Barcode scanner ready':'Ready to scan';
  const detail=last?.discarded?'Removed from this session':last?.matched?`${last.sku||last.code} · ${last.quantity} counted`:last?.matchingFailed?'Saved · check unmatched scans':last?'Saved on this device':'Waiting for a scan';
  const title=last?.title||last?.sku||last?.code||'Scan a product';
  return <s-section heading={heading}>
    <s-box blockSize="88px"><s-stack direction="inline" gap="base" alignItems="center">
      <s-box inlineSize="64px" minInlineSize="64px" blockSize="64px">
        {last?.imageUrl&&<s-image src={last.imageUrl} objectFit="contain"/>}
      </s-box>
      <s-stack direction="block" gap="small">
        <s-box minBlockSize="24px"><s-text type="strong">{title.length>100?`${title.slice(0,97)}…`:title}</s-text></s-box>
        <s-box minBlockSize="24px"><s-text color="subdued">{detail}</s-text></s-box>
      </s-stack>
    </s-stack></s-box>
  </s-section>;
}
