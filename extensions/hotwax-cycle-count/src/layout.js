// Phones get stacked rows: a product's name above its stepper, a session's name above
// its button. POS reports the device once; the modal reads it before its first render.
export const layout={compact:false};
export async function readLayout() {
  try {layout.compact=!(await shopify.device.isTablet());} catch {layout.compact=false;}
}
