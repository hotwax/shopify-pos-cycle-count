export const COUNT_SUMMARY = 'CycleCountSummary';
export const COUNT_SESSION = 'CycleCountSession';
export const COUNT_SAVED = 'CycleCountSaved';
export const COUNT_CREATE = 'CycleCountCreate';
/** Screens a count summary can push onto the POS navigation stack. */
export const COUNT_VIEWS = ['products', 'product', 'contribution', 'zero', 'extras'];
/** Session tasks that open as their own screen. Each reopens the session there. */
export const SESSION_TOOLS = ['editSession', 'discard', 'forceRelease', 'troubleshoot', 'issue'];

const text = value => typeof value === 'string' ? value : '';
const quantity = value => Number.isFinite(value) ? value : null;
/** The product a details screen shows first, before its contributions load. */
function productSnapshot(value) {
  if (!value || typeof value !== 'object' || !text(value.productId)) return undefined;
  return {productId: value.productId, title: text(value.title), sku: text(value.sku),
    quantity: quantity(value.quantity), onHand: quantity(value.onHand), delta: quantity(value.delta)};
}
/** One session's part of a product total, shown and edited on its own screen. */
function contributionSnapshot(value) {
  if (!value || typeof value !== 'object' || !text(value.sessionId)) return undefined;
  return {sessionId: value.sessionId, name: text(value.name), operator: text(value.operator), statusId: text(value.statusId),
    countStatusId: text(value.countStatusId), quantity: quantity(value.quantity), editable: value.editable === true};
}

export function readCountPage(url, state, owner) {
  const screen = url?.split(/[?#]/)[0].split('/').pop();
  if (![COUNT_SUMMARY, COUNT_SESSION, COUNT_SAVED, COUNT_CREATE].includes(screen)) return {kind: 'home'};
  if (state?.owner !== owner) return null;
  if (screen === COUNT_SAVED) return {kind: 'saved'};
  if (screen === COUNT_CREATE) return {kind: 'new'};
  const variantId = Number.isSafeInteger(state.variantId) && state.variantId > 0 ? state.variantId : undefined;
  if (screen === COUNT_SUMMARY) {
    if (typeof state.workEffortId !== 'string' || !state.workEffortId) return null;
    const view = COUNT_VIEWS.includes(state.view) ? state.view : undefined;
    const product = view === 'product' || view === 'contribution' ? productSnapshot(state.product) : undefined;
    const contribution = view === 'contribution' ? contributionSnapshot(state.contribution) : undefined;
    if ((view === 'product' || view === 'contribution') && !product) return null;
    if (view === 'contribution' && !contribution) return null;
    return {kind: 'work', workEffortId: state.workEffortId, ...(variantId ? {variantId} : {}),
      ...(view ? {view} : {}), ...(product ? {product} : {}), ...(contribution ? {contribution} : {})};
  }
  if (typeof state.sessionId !== 'string' || !state.sessionId) return null;
  const tool = SESSION_TOOLS.includes(state.tool) ? state.tool : undefined;
  if (tool === 'issue' && !Number.isSafeInteger(state.issueId)) return null;
  return {
    kind: 'session',
    sessionId: state.sessionId,
    fromSummary: state.fromSummary === true,
    name: typeof state.name === 'string' ? state.name : '',
    variantId,
    ...(tool ? {tool} : {}),
    ...(tool === 'issue' ? {issueId: state.issueId} : {}),
  };
}
