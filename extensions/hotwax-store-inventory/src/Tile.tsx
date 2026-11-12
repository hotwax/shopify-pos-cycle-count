import '@shopify/ui-extensions/preact';
import {render} from 'preact';

export default () => render(<s-tile
  heading={shopify.i18n.translate('tile_heading')}
  subheading={shopify.i18n.translate('tile_subheading')}
  onClick={()=>shopify.action.presentModal()}
/>, document.body);
