import '@shopify/ui-extensions/preact';
import {render} from 'preact';
import {useEffect, useState} from 'preact/hooks';
import type {InventoryScope} from '../../../shared/store-inventory';
import {InventoryHistory} from './EventList';
import {ProductDetail, RefreshAction} from './ProductDetail';
import {ProductSearch} from './ProductSearch';
import {PRODUCT_SCREEN, SEARCH_SCREEN, scopeKey, useScreenNavigation, useStoreLocation, type ProductPage} from './store';
import {OfflineBanner, Warning} from './ui';

export default () => renderStoreInventory();

export function renderStoreInventory(productContext?: {variantId?: number}) {
  if (productContext) {
    const {variantId} = productContext;
    const selection: ProductPage | undefined =
      typeof variantId==='number' && Number.isSafeInteger(variantId) && variantId>0
        ? {owner:scopeKey(),product:{title:'',variantId:String(variantId)}}
        : undefined;
    render(<Extension screen={PRODUCT_SCREEN} state={selection}/>, document.body);
    return;
  }
  const entry = navigation.currentEntry;
  const url = entry?.url;
  const screen = url?.includes(PRODUCT_SCREEN) ? PRODUCT_SCREEN : url?.includes(SEARCH_SCREEN) ? SEARCH_SCREEN : undefined;
  render(<Extension screen={screen} state={entry?.getState()}/>, document.body);
}

function Extension({screen,state}: {screen?: string; state: unknown}) {
  const [owner,setOwner] = useState(scopeKey);
  useEffect(()=>{
    // A different staff member pinning in closes the previous one's view.
    const check = () => setOwner(scopeKey());
    const unsubscribe = shopify.session.staffMember.subscribe(check);
    const timer = setInterval(check,1500);
    return () => {unsubscribe();clearInterval(timer);};
  },[]);

  const scope = owner ? JSON.parse(owner) as InventoryScope : null;
  if (!scope || scope.staffId!==scope.userId) return <s-page heading="Store inventory"><s-box padding="large">
    <Warning reason="Sign in to Shopify POS with your own account and pin in to continue."/>
  </s-box></s-page>;

  if (screen===PRODUCT_SCREEN) {
    const selection = state as ProductPage | undefined;
    if (selection?.owner===owner && (selection.product?.itemId || selection.product?.variantId || selection.product?.hotWaxProductId)) {
      const product = selection.product;
      return <ProductDetail key={owner+':'+(product.itemId || product.variantId || product.hotWaxProductId)}
        scope={scope} selected={product} initialTab={selection.tab}/>;
    }
    return <s-page heading="Product details"><s-box padding="large">
      <Warning reason="Go back and select a product for this location."/>
    </s-box></s-page>;
  }
  if (screen===SEARCH_SCREEN) return <ProductSearch key={owner} scope={scope} owner={owner}/>;
  return <InventoryHome key={owner} scope={scope} owner={owner}/>;
}

function InventoryHome({scope,owner}: {scope: InventoryScope; owner: string}) {
  const store = useStoreLocation(scope);
  const {open,navigationError} = useScreenNavigation(owner);
  return <s-page heading="Store inventory" subheading={store.location?.name}>
    <RefreshAction store={store}/>
    <s-scroll-box>
      <s-box padding="large">
        <s-stack direction="block" gap="base">
          {!store.connected && <OfflineBanner/>}
          {navigationError && <Warning reason={navigationError}/>}
          <InventoryHistory store={store} onSearch={()=>open(SEARCH_SCREEN)}
            openProduct={(product,tab)=>open(PRODUCT_SCREEN,product,tab)}/>
        </s-stack>
      </s-box>
    </s-scroll-box>
  </s-page>;
}
