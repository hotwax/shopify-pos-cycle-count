export const COUNT_SUMMARY = 'CycleCountSummary';
export const COUNT_SESSION = 'CycleCountSession';

export function readCountPage(url, state, owner) {
  const screen = url?.split(/[?#]/)[0].split('/').pop();
  if (screen !== COUNT_SUMMARY && screen !== COUNT_SESSION) return {kind: 'home'};
  if (state?.owner !== owner) return null;
  const variantId = Number.isSafeInteger(state.variantId) && state.variantId > 0 ? state.variantId : undefined;
  if (screen === COUNT_SUMMARY) {
    return typeof state.workEffortId === 'string' && state.workEffortId
      ? {kind: 'work', workEffortId: state.workEffortId, ...(variantId ? {variantId} : {})} : null;
  }
  if (typeof state.sessionId !== 'string' || !state.sessionId) return null;
  return {
    kind: 'session',
    sessionId: state.sessionId,
    fromSummary: state.fromSummary === true,
    name: typeof state.name === 'string' ? state.name : '',
    variantId,
  };
}
