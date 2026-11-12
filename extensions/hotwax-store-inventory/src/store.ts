import {useEffect, useRef, useState} from 'preact/hooks';
import {inventoryScope, sameInventoryScope, type InventoryScope} from '../../../shared/store-inventory';
import {inventoryLocation, type Location, type Variant} from './Inventory';
import {errorText} from './ui';

export const SEARCH_SCREEN = 'StoreInventorySearch';
export const PRODUCT_SCREEN = 'StoreInventoryProduct';
export type HistoryTab = 'events' | 'proposals' | 'sales';
export type ProductPage = {owner: string; product: Variant; tab?: HistoryTab};

export function currentScope() {
  return inventoryScope({...shopify.session.currentSession,staffId:shopify.session.staffMember.value?.id});
}

export function scopeKey() {
  try {return JSON.stringify(currentScope());} catch {return '';}
}

/** The HotWax store for this register, reopened when connectivity returns or on refresh. */
export function useStoreLocation(scope: InventoryScope) {
  const [connected,setConnected] = useState(shopify.connectivity.current.value.internetConnected==='Connected');
  const [location,setLocation] = useState<Location>();
  const [locationError,setLocationError] = useState('');
  const [refresh,setRefresh] = useState(0);

  useEffect(()=>shopify.connectivity.current.subscribe(state=>setConnected(state.internetConnected==='Connected')),[]);
  useEffect(()=>{
    if (!connected) return;
    const controller = new AbortController();
    setLocationError('');
    inventoryLocation(scope,()=>shopify.session.getSessionToken(),controller.signal)
      .then(result=>{
        if (!controller.signal.aborted && sameInventoryScope(scope,currentScope())) setLocation(result);
      })
      .catch(cause=>{
        if (!controller.signal.aborted) {
          setLocation(undefined);
          setLocationError(errorText(cause,'HotWax could not open inventory for this Shopify location.'));
        }
      });
    return ()=>controller.abort();
  },[connected,refresh]);

  return {connected,location,locationError,refreshLocation:()=>setRefresh(value=>value+1)};
}
export type Store = ReturnType<typeof useStoreLocation>;

export function useScreenNavigation(owner: string) {
  const pending = useRef(false);
  const [navigationError,setNavigationError] = useState('');

  async function open(screen: string, product?: Variant, tab?: HistoryTab) {
    if (pending.current) return;
    pending.current = true;
    setNavigationError('');
    try {
      await navigation.navigate(screen, product ? {state:{owner,product,tab}} : undefined);
    } catch {
      setNavigationError('Shopify POS could not open the page. Try again.');
    } finally {
      pending.current = false;
    }
  }

  return {open,navigationError};
}
