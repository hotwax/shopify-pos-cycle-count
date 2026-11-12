import '@shopify/ui-extensions';

//@ts-ignore
declare module './src/Tile.tsx' {
  const shopify: import('@shopify/ui-extensions/pos.home.tile.render').Api;
  const globalThis: { shopify: typeof shopify };
}

//@ts-ignore
declare module './src/Modal.tsx' {
  const shopify:
    | import('@shopify/ui-extensions/pos.home.modal.render').Api
    | import('@shopify/ui-extensions/pos.product-details.action.render').Api;
  const globalThis: { shopify: typeof shopify };
}

//@ts-ignore
declare module './src/ProductAction.tsx' {
  const shopify: import('@shopify/ui-extensions/pos.product-details.action.menu-item.render').Api;
  const globalThis: { shopify: typeof shopify };
}

//@ts-ignore
declare module './src/ProductModal.tsx' {
  const shopify: import('@shopify/ui-extensions/pos.product-details.action.render').Api;
  const globalThis: { shopify: typeof shopify };
}

//@ts-ignore
declare module './src/Inventory.ts' {
  const shopify:
    | import('@shopify/ui-extensions/pos.home.modal.render').Api
    | import('@shopify/ui-extensions/pos.product-details.action.render').Api;
  const globalThis: { shopify: typeof shopify };
}

//@ts-ignore
declare module './src/InventoryEventSources.ts' {
  const shopify:
    | import('@shopify/ui-extensions/pos.home.modal.render').Api
    | import('@shopify/ui-extensions/pos.product-details.action.render').Api;
  const globalThis: { shopify: typeof shopify };
}

//@ts-ignore
declare module './src/InventoryProjection.ts' {
  const shopify:
    | import('@shopify/ui-extensions/pos.home.modal.render').Api
    | import('@shopify/ui-extensions/pos.product-details.action.render').Api;
  const globalThis: { shopify: typeof shopify };
}
