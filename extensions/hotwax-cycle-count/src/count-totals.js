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
