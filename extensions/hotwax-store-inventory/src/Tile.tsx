import '@shopify/ui-extensions/preact';
import {render} from 'preact';
import {INVENTORY_SANDBOX} from '../../../shared/store-inventory';

export default () => render(<s-tile
  heading={shopify.i18n.translate('tile_heading')}
  subheading={shopify.i18n.translate('tile_subheading')}
  disabled={shopify.session.currentSession.shopDomain!==INVENTORY_SANDBOX}
  onClick={()=>shopify.action.presentModal()}
/>, document.body);
