import '@shopify/ui-extensions/preact';
import {useEffect, useState} from 'preact/hooks';
import {OmsLookupError} from '../../../shared/oms-connection';
import type {EventState, Variant} from './Inventory';

export const ROWS_PER_PAGE = 50;
export const units = (value: number | null) => value == null ? '—' : String(value);
export const signed = (value: number) => value > 0 ? '+'+value : String(value);

/** The identifiers under a product's name, without repeating the name. */
export function productLabel(product: Variant) {
  const parts = [product.option,product.sku || product.barcode].filter(Boolean) as string[];
  return parts.filter(part=>part!==product.title).join(' · ');
}

/** What store staff see for an event's delivery. */
export const STATE_LABELS: Record<EventState,string> = {
  Unbatched:'Waiting',Queued:'Waiting',Sending:'Sending',Sent:'Sent',Cancelled:'Cancelled',
  Error:'Failed',Missing:'No delivery record',
};
export function stateTone(state: EventState) {
  return state==='Sent' ? 'success' : state==='Error' || state==='Missing' ? 'warning' : 'neutral';
}

export function duration(milliseconds: number) {
  const seconds = Math.max(0,Math.floor(milliseconds/1000));
  const minutes = Math.floor(seconds/60);
  const hours = Math.floor(minutes/60);
  const days = Math.floor(hours/24);
  if (days) return days+'d'+(hours%24 ? ' '+hours%24+'h' : '');
  if (hours) return hours+'h'+(minutes%60 ? ' '+minutes%60+'m' : '');
  if (minutes) return minutes+'m'+(seconds%60 ? ' '+seconds%60+'s' : '');
  return seconds+'s';
}

export function ago(value: number, now: number) {
  return now-value<1000 ? 'just now' : duration(now-value)+' ago';
}

export function useNow() {
  const [now,setNow] = useState(Date.now);
  useEffect(()=>{
    const timer = setInterval(()=>setNow(Date.now()),15000);
    return ()=>clearInterval(timer);
  },[]);
  return now;
}

/** The reason to show: HotWax's own message when it gave one, otherwise the fallback for this step. */
export function errorText(cause: unknown, fallback: string) {
  if (cause instanceof OmsLookupError || (cause instanceof Error && cause.name==='OmsLookupError')) return cause.message;
  if (cause instanceof Error && cause.message && !/abort/i.test(cause.name)) return fallback+' ('+cause.message+')';
  return fallback;
}

/** POS shows only a banner's heading, so the reason is the heading. */
export function Warning({reason}: {reason: string}) {
  return <s-banner tone="warning" heading={reason}/>;
}

export function OfflineBanner() {
  return <Warning reason="POS is offline. Connect to see current inventory."/>;
}

export function Loading({label}: {label: string}) {
  return <s-stack direction="inline" alignItems="center" gap="small" paddingBlock="small">
    <s-spinner accessibilityLabel={label}/>
    <s-text color="subdued">{label}</s-text>
  </s-stack>;
}

export function Quantity({label,value,projected,projecting,projectedLabel}: {
  label: string; value: number | null; projected?: number | null; projecting?: boolean; projectedLabel?: string;
}) {
  return <s-stack direction="block" gap="small-300" inlineSize="33.33%">
    <s-text type="small" color="subdued">{label}</s-text>
    <s-heading>{units(value)}</s-heading>
    {projected!==undefined && <s-text type="small">{projectedLabel ?? 'After'} {projecting ? '…' : units(projected ?? null)}</s-text>}
  </s-stack>;
}

export function LoadMore({onClick,disabled}: {onClick: () => void; disabled?: boolean}) {
  return <s-stack direction="inline">
    <s-button variant="secondary" disabled={disabled} onClick={onClick}>Load more</s-button>
  </s-stack>;
}

export function Row({title,subtitle,detail,timing,imageUrl,state,stateLabel,tone,value,valueLabel,onClick,dimmed}: {
  title: string; subtitle?: string; detail?: string; timing?: string; imageUrl?: string;
  state?: string; stateLabel?: string; tone?: 'success' | 'warning' | 'neutral'; value?: string; valueLabel?: string;
  onClick?: () => void; dimmed?: boolean;
}) {
  const content = <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="base" paddingBlock="base" paddingInline="small">
    <s-stack direction="inline" alignItems="center" gap="base">
      {imageUrl!==undefined && <s-box inlineSize="48px" minInlineSize="48px" blockSize="48px">
        {imageUrl && <s-image src={imageUrl} objectFit="contain"/>}
      </s-box>}
      <s-stack direction="block" gap="small-300">
        <s-text type="strong" color={dimmed?'subdued':undefined}>{title}</s-text>
        {subtitle && <s-text type="small" color="subdued">{subtitle}</s-text>}
        {detail && <s-text type="small" color="subdued">{detail}</s-text>}
        {timing && <s-text type="small" color="subdued">{timing}</s-text>}
      </s-stack>
    </s-stack>
    <s-stack direction="inline" alignItems="center" gap="small">
      {(stateLabel ?? state) && <s-badge tone={tone ?? 'neutral'}>{stateLabel ?? state}</s-badge>}
      {value && <s-box minInlineSize={valueLabel?'64px':'48px'}>
        <s-stack direction="block" alignItems="end" gap="small-300">
          {valueLabel && <s-text type="small" color="subdued">{valueLabel}</s-text>}
          <s-text type="strong" color={dimmed?'subdued':undefined}>{value}</s-text>
        </s-stack>
      </s-box>}
      {onClick && <s-icon type="chevron-right" color="subdued"/>}
    </s-stack>
  </s-stack>;
  return <s-stack direction="block">
    <s-divider/>
    {onClick ? <s-clickable onClick={onClick}>{content}</s-clickable> : content}
  </s-stack>;
}
