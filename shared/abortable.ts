/** Native bridge promises need not observe AbortSignal. Bound the caller's wait
 * as well as fetch, and check again before any subsequent side effect. A write
 * already sent still needs normal acknowledgement/reconciliation; cancellation
 * never implies it failed or permits a blind retry. */
export const REQUEST_TIMEOUT = 'Timed out. Reopen Cycle Count.';
export function assertNotAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw signal.reason;
}
export function abortable<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work();
  return new Promise<T>((resolve,reject)=>{
    const aborted=()=>reject(signal.reason);
    signal.addEventListener('abort',aborted,{once:true});
    Promise.resolve().then(()=>{assertNotAborted(signal);return work();})
      .then(resolve,reject).finally(()=>signal.removeEventListener('abort',aborted));
  });
}
