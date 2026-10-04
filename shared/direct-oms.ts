import {configureDirectOms, OmsConnection, OmsLookupError} from './oms-connection';
import {LOCAL_OMS_PREVIEW} from './oms-build-config';
import {getShopOmsUrl} from './oms-shop-config';

type PosSession = {getSessionToken(): Promise<string | undefined | null>};

export async function openDirectOms(session: PosSession, locationId: unknown,
  signal?: AbortSignal, arrivedAt = performance.now()) {
  const [omsUrl, token] = await Promise.all([getShopOmsUrl(signal, LOCAL_OMS_PREVIEW), session.getSessionToken()]);
  configureDirectOms(omsUrl, LOCAL_OMS_PREVIEW);
  if (!token) throw new OmsLookupError('Your Shopify session is unavailable. Reopen this extension.', 401);
  const oms = new OmsConnection({shopifySessionToken: token, shopifyLocationId: locationId, signal},
    () => performance.now(), arrivedAt);
  // OMS verifies the signature and provisions the user. Decoding below only reads
  // the identity after that exchange; it is not a client-side signature check.
  await oms.authenticate();
  let claims: {dest?: string; sub?: string};
  try {
    const segment = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    claims = JSON.parse(atob(segment.padEnd(Math.ceil(segment.length / 4) * 4, '=')));
  } catch {
    throw new OmsLookupError('Shopify session identity could not be read.', 401);
  }
  if (!claims.dest || !claims.sub) throw new OmsLookupError('Shopify session identity is incomplete.', 401);
  return {oms, identity: {shop: claims.dest, shopifyUserId: String(claims.sub),
    shopifySessionToken: token, shopifyLocationId: locationId, signal}};
}
