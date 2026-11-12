import '@shopify/ui-extensions/preact';
import {render} from 'preact';

export default () => render(<s-button
  onClick={()=>shopify.action.presentModal()}
>{shopify.i18n.translate('tile_heading')}</s-button>, document.body);
