import '@shopify/ui-extensions/preact';
import {render} from 'preact';
import {INVENTORY_SANDBOX} from '../../../shared/store-inventory';

export default () => render(<s-button
  disabled={shopify.session.currentSession.shopDomain!==INVENTORY_SANDBOX}
  onClick={()=>shopify.action.presentModal()}
>{shopify.i18n.translate('tile_heading')}</s-button>, document.body);
