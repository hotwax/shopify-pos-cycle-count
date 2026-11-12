/**
 * Count-wide totals for the count summary, from quantities saved in every session
 * (the `progress` result). Discarded extra products are left out, as they are of
 * the review. Directed and hard counts measure against their requested products;
 * dynamic counts only grow, so they report what is counted so far.
 */
export function progressTotals(result) {
  const items=(result?.items||[]).filter(item=>item.decision!=='SKIPPED');
  const requested=items.filter(item=>item.isRequested);
  return {
    dynamic:result?.type==='DYNAMIC_COUNT',
    counted:items.filter(item=>item.quantity!=null).length,
    requested:requested.length,
    requestedCounted:requested.filter(item=>item.quantity!=null).length,
    extras:items.filter(item=>!item.isRequested&&item.quantity!=null).length,
    units:items.reduce((total,item)=>total+(item.quantity??0),0),
  };
}

/**
 * Whether a count can be sent for approval, and what is still missing, from the same
 * `progress` result. These are the checks HotWax applies on submit: every live session
 * submitted and every requested product counted (or confirmed zero).
 */
export function submitReadiness(result) {
  const live=(result?.sessions||[]).filter(session=>session.statusId!=='SESSION_VOIDED');
  const unsubmitted=live.filter(session=>session.statusId!=='SESSION_SUBMITTED').length;
  const uncounted=Number(result?.uncounted)||0;
  const missing=[];
  if(!live.length)missing.push('Count and complete at least one session');
  if(unsubmitted)missing.push(`Complete ${unsubmitted} ${unsubmitted===1?'open session':'open sessions'}`);
  if(uncounted)missing.push(`Count or mark out of stock ${uncounted} ${uncounted===1?'product':'products'}`);
  const ready=!!result?.canFinish;
  // HotWax has the last word; a refusal with nothing listed above still explains itself.
  if(!ready&&!missing.length)missing.push('Refresh the count and check it again');
  return {ready,missing:ready?[]:missing};
}
