import {configureDirectOms, OmsConnection, OmsLookupError} from './oms-connection';
import {LOCAL_OMS_PREVIEW} from './oms-build-config';
import {getShopOmsUrl, OmsSettingUnavailable, validateOmsOrigin} from './oms-shop-config';

type PosSession = {getSessionToken(): Promise<string | undefined | null>};
type KeyValue = {get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<unknown>};
export type DirectOmsOptions = {signal?: AbortSignal; arrivedAt?: number; readBudgetMs?: number; storage?: KeyValue};

// A POS target keeps one JavaScript runtime between actions. Reusing the shop's
// OMS origin and login there removes two round trips from every scan, sync and
// lease renewal. Entries expire well before an OMS session would.
const ORIGIN_TTL = 5 * 60000, LOGIN_TTL = 4 * 60000;
export const OMS_ORIGIN_KEY = 'hotwax-count:oms-origin';
let origin: {value: string; until: number} | undefined;
const logins = new Map<string, {token: string; until: number}>();

/** The OMS origin this runtime last resolved from the shop's setting, if any. */
export const currentOmsOrigin = () => origin?.value;

/** Drop a reused OMS login after OMS rejects it, or every login on an identity change. */
export function forgetOmsLogin(key?: string) {
  if (key) logins.delete(key); else logins.clear();
}

async function omsOrigin(signal?: AbortSignal, storage?: KeyValue) {
  if (origin && origin.until > Date.now()) return origin.value;
  try {
    const value = await getShopOmsUrl(signal, LOCAL_OMS_PREVIEW);
    if (origin?.value !== value) await Promise.resolve(storage?.set(OMS_ORIGIN_KEY, value)).catch(() => {});
    origin = {value, until: Date.now() + ORIGIN_TTL};
    return value;
  } catch (error) {
    // The background target may not offer Admin API access. Only when Shopify
    // cannot answer, reuse the origin this device resolved in the modal.
    if (!(error instanceof OmsSettingUnavailable) || !storage) throw error;
    const saved = await Promise.resolve(storage.get(OMS_ORIGIN_KEY)).catch(() => undefined);
    if (typeof saved !== 'string') throw error;
    return validateOmsOrigin(saved, LOCAL_OMS_PREVIEW);
  }
}

function sessionClaims(token: string) {
  let claims: {dest?: string; sub?: string};
  try {
    const segment = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    claims = JSON.parse(atob(segment.padEnd(Math.ceil(segment.length / 4) * 4, '=')));
  } catch {
    throw new OmsLookupError('Shopify session identity could not be read.', 401);
  }
  if (!claims.dest || !claims.sub) throw new OmsLookupError('Shopify session identity is incomplete.', 401);
  return {dest: claims.dest, sub: String(claims.sub)};
}

export async function openDirectOms(session: PosSession, locationId: unknown, options: DirectOmsOptions = {}) {
  const {signal, arrivedAt = performance.now(), readBudgetMs, storage} = options;
  const [omsUrl, token] = await Promise.all([omsOrigin(signal, storage), session.getSessionToken()]);
  configureDirectOms(omsUrl, LOCAL_OMS_PREVIEW);
  if (!token) throw new OmsLookupError('Your Shopify session is unavailable. Reopen this extension.', 401);
  // OMS verifies the token signature during login. These claims only label the
  // reusable login and identify the shop and user; they are not a signature check.
  const claims = sessionClaims(token);
  const loginKey = [omsUrl, claims.dest, claims.sub, String(locationId)].join('|');
  const cached = logins.get(loginKey), reusedLogin = !!cached && cached.until > Date.now();
  const oms = new OmsConnection({shopifySessionToken: token, shopifyLocationId: locationId, signal, readBudgetMs,
    omsToken: reusedLogin ? cached!.token : undefined}, () => performance.now(), arrivedAt);
  if (!reusedLogin) logins.set(loginKey, {token: await oms.accessToken(), until: Date.now() + LOGIN_TTL});
  return {oms, loginKey, reusedLogin, identity: {shop: claims.dest, shopifyUserId: claims.sub,
    shopifySessionToken: token, shopifyLocationId: locationId, signal}};
}
