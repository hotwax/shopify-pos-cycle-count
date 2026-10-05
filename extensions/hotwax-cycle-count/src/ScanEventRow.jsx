export function ScanEventRow({event,disabled,onUndo,onMatch}) {
  return <s-box id={`scan-event-${event.id}`} padding="base" minBlockSize="64px">
    <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="base">
      <s-stack direction="inline" gap="base" alignItems="center" maxInlineSize="420px">
        <s-box inlineSize="48px" minInlineSize="48px" blockSize="48px">{event.imageUrl&&<s-image src={event.imageUrl} objectFit="contain"/>}</s-box>
        <s-stack direction="block" gap="small">
          <s-text type="strong">{event.title}</s-text>
          <s-text color="subdued">{event.scannedValue} · {new Date(event.createdAt).toLocaleTimeString()} · {event.mode==='set'?'Set total':event.source==='undo'?'Removed':'Added'} {Math.abs(event.quantity)}</s-text>
        </s-stack>
      </s-stack>
      <s-stack direction="inline" gap="small" alignItems="center">
        {event.aggApplied===0&&<s-badge tone={event.matchingFailed?'critical':'neutral'}>{event.matchingFailed?'Unmatched':'Matching'}</s-badge>}
        {event.aggApplied===-1&&<s-badge tone="neutral">Removed</s-badge>}
        {event.aggApplied===0&&onMatch&&<s-button disabled={disabled} onClick={()=>onMatch(event)}>Match</s-button>}
        {(event.canUndo||event.aggApplied===0)&&<s-button disabled={disabled} onClick={()=>onUndo(event)}>Undo</s-button>}
      </s-stack>
    </s-stack>
  </s-box>;
}
