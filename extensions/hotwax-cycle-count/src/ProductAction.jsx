import '@shopify/ui-extensions/preact';
import {render} from 'preact';
export default () => render(<s-button onClick={()=>shopify.action.presentModal()}>Count this product</s-button>,document.body);
