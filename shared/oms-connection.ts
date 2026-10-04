export type OmsRow = Record<string, unknown>;

let extensionConfiguration: {url: string; localPreview: boolean} | undefined;

/** Public build configuration only. Credentials come from the current Shopify session. */
export function configureDirectOms(url: string, localPreview = false) {
  const origin = new URL(url);
  if (origin.protocol !== 'https:' || origin.username || origin.password ||
      origin.pathname !== '/' || origin.search || origin.hash) {
    throw new OmsLookupError('The direct OMS URL must be an HTTPS origin.', 503);
  }
  extensionConfiguration = {url: origin.origin, localPreview};
}

export class OmsLookupError extends Error {
  status: number;
  constructor(message: string, status = 422) { super(message); this.status = status; }
}

export function rows(value: unknown): OmsRow[] {
  return Array.isArray(value) ? value.filter((row): row is OmsRow =>
    !!row && typeof row === "object" && !Array.isArray(row)) : [];
}

export function inputRows(value: unknown, label: string, optional = false): OmsRow[] {
  if (optional && value === undefined) return [];
  const result = rows(value);
  if (!Array.isArray(value) || value.length > 100 || result.length !== value.length) {
    throw new OmsLookupError(`Invalid ${label}.`, 400);
  }
  return result;
}

export const text = (value: unknown): string => value == null ? "" : String(value);

export function exactNumeric(value: unknown, label: string): string {
  const candidate = text(value).replace(/^gid:\/\/shopify\/\w+\//, "");
  if (!/^\d+$/.test(candidate)) throw new OmsLookupError(`Invalid ${label}.`, 400);
  return candidate;
}

export function one<T>(matches: T[], label: string): T {
  if (matches.length !== 1) throw new OmsLookupError(`Expected one ${label}; found ${matches.length}.`);
  return matches[0];
}

export function configuredOrigin(): string {
  const value = extensionConfiguration?.url ??
    (typeof process !== 'undefined' ? process.env.OMS_BASE_URL : undefined);
  if (!value) throw new OmsLookupError("OMS_BASE_URL is not configured on the app server.", 503);
  let url: URL;
  try { url = new URL(value); }
  catch { throw new OmsLookupError("OMS_BASE_URL is invalid.", 503); }
  const local = !extensionConfiguration && process.env.NODE_ENV !== "production" && url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !local) || url.username || url.password ||
      url.pathname !== "/" || url.search || url.hash) {
    throw new OmsLookupError("OMS_BASE_URL must be HTTPS, or local HTTP in development.", 503);
  }
  return url.origin;
}

/** A development preview stays on test data. Released apps use their shop's setup. */
export function requireCountConnection(shop: string) {
  const origin = configuredOrigin(), domain = new URL(shop).hostname;
  if (!domain.endsWith('.myshopify.com')) throw new OmsLookupError('Invalid authenticated Shopify shop.', 403);
  if (!extensionConfiguration) throw new OmsLookupError('Open this count from its configured Shopify POS app.', 403);
  if (!extensionConfiguration.localPreview) return;
  if (origin === 'https://test-maarg.hotwax.io' ||
      (origin === 'https://demo-maarg.hotwax.io' && domain === 'hotwax-demo.myshopify.com')) return;
  throw new OmsLookupError('This development preview can only save counts in the configured HotWax test stores.', 403);
}

export type OmsIdentity = {shopifySessionToken: string; shopifyLocationId: unknown; signal?: AbortSignal;
  /** An OMS token from an earlier login in this POS runtime; it skips the app-bridge exchange. */
  omsToken?: string;
  /** Read-phase budget. Large summaries may extend it; writes keep their own deadline. */
  readBudgetMs?: number};

/** One authenticated operation: lazy login, bounded I/O and deduplicated reads.
 * Only the OMS token may be reused by the caller. POST clears reads so write
 * verification is fresh.
 */
export class OmsConnection {
  private origin = configuredOrigin();
  private login?: Promise<string>;
  private reads = new Map<string, Promise<unknown>>();
  private active = 0;
  private waiting: Array<() => void> = [];
  private identity: OmsIdentity;
  private writeStarted = false;
  private clock: () => number;
  private started: number;

  constructor(identity: OmsIdentity, clock = () => performance.now(), arrivedAt = clock()) {
    this.identity = identity; this.clock = clock; this.started = arrivedAt;
    if (identity.omsToken) this.login = Promise.resolve(identity.omsToken);
  }
  get mutationStarted() { return this.writeStarted; }

  async authenticate() { await this.token(); }
  /** The bearer token for reuse by a later operation of the same identity. */
  accessToken(): Promise<string> { return this.token(); }

  private async request(path: string, init: RequestInit, mutation = false): Promise<unknown> {
    if (!path.startsWith("/rest/") || path.includes("\\") || path.includes("#") ||
        path.split('?')[0].split('/').some((segment) => /^(\.|%2e){1,2}$/i.test(segment))) {
      throw new OmsLookupError("Invalid OMS resource path.", 400);
    }
    if (this.active >= 6) await new Promise<void>((resolve) => this.waiting.push(resolve));
    else this.active++;
    try {
      const remaining = this.started + (this.writeStarted ? 48000 : Math.min(this.identity.readBudgetMs ?? 20000, 45000)) - this.clock();
      if (remaining <= 0) throw new OmsLookupError('OMS operation exceeded its time budget before this request.', 503);
      if (mutation) {
        if (!this.writeStarted && this.identity.signal?.aborted) throw new OmsLookupError("OMS operation was cancelled before writing.", 503);
        this.writeStarted = true;
        this.reads.clear();
      }
      const budget = this.started + 48000 - this.clock();
      const signals = [AbortSignal.timeout(Math.max(1, Math.min(mutation ? 25000 : 12000, mutation ? budget : remaining)))];
      if (!this.writeStarted && this.identity.signal) signals.push(this.identity.signal);
      const response = await fetch(`${this.origin}${path}`, {
        ...init, redirect: "manual", signal: AbortSignal.any(signals),
        headers: {Accept: "application/json", ...init.headers},
      }).catch(() => { throw new OmsLookupError(`OMS cannot be reached (${new URL(this.origin).host}).`, 503); });
      if (response.status >= 300 && response.status < 400) throw new OmsLookupError("OMS redirected the request.", 502);
      if (path === "/rest/s1/app-bridge/login" && response.status === 400 &&
          (await response.text()).includes("App Config Not found")) {
        throw new OmsLookupError("OMS could not match this Shopify app and shop to its registration.", 424);
      }
      if (!response.ok) {
        // Identify the failed operation without exposing response bodies or credentials.
        const step = path.endsWith('/lock') ? 'acquiring the count lock' : path.endsWith('/release') ? 'releasing the count lock' :
          path.endsWith('/items') ? 'saving count quantities' : path.includes('/shopProducts?') ? 'checking shop products' :
          path.includes('/inventory?') ? 'reading store inventory' : path.includes('/count?') ? 'reading saved quantities' : 'accessing the count';
        throw new OmsLookupError(`HotWax failed while ${step} (HTTP ${response.status}).`,
          [400, 401, 403, 409].includes(response.status) ? response.status : 502);
      }
      const body: unknown = await response.json().catch(() => {
        throw new OmsLookupError("OMS returned an invalid response.", 502);
      });
      if (!body || typeof body !== "object") throw new OmsLookupError("OMS returned an invalid response.", 502);
      return body;
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }

  private token(): Promise<string> {
    return this.login ??= (async () => {
      if (!this.identity.shopifySessionToken) throw new OmsLookupError("Shopify session token is unavailable.", 401);
      const login = await this.request("/rest/s1/app-bridge/login", {
        method: "POST", headers: {"Content-Type": "application/json"},
        body: JSON.stringify({sessionToken: this.identity.shopifySessionToken,
          locationId: exactNumeric(this.identity.shopifyLocationId, "Shopify location ID")}),
      }) as OmsRow;
      const token = text(login.token ?? (login.data as OmsRow | undefined)?.token);
      if (!token) throw new OmsLookupError("OMS login did not return a token.", 502);
      return token;
    })();
  }

  get<T = OmsRow>(path: string): Promise<T> {
    let read = this.reads.get(path);
    if (!read) {
      read = this.token().then((token) => this.request(path, {headers: {Authorization: `Bearer ${token}`}}));
      this.reads.set(path, read);
    }
    return read as Promise<T>;
  }

  async postRead(path: string, body: OmsRow): Promise<OmsRow> {
    if (!['/rest/s1/admin/search/query', '/rest/s1/shopify/graphql', '/rest/s1/oms/dataDocumentView'].includes(path) ||
        (path === '/rest/s1/oms/dataDocumentView' && !['ProductFacilityAndInventoryItem','InventoryCountImportLock'].includes(text(body.dataDocumentId))) ||
        (path === '/rest/s1/shopify/graphql' && (!/^\s*query\b/.test(text(body.queryText)) ||
          /\b(mutation|subscription)\b/.test(text(body.queryText)) || 'operationName' in body))) {
      throw new OmsLookupError('This resource is not an OMS read operation.', 400);
    }
    const token = await this.token();
    return await this.request(path, {method: "POST",
      headers: {Authorization: `Bearer ${token}`, "Content-Type": "application/json"}, body: JSON.stringify(body),
    }) as OmsRow;
  }

  async mutate(path: string, body: OmsRow, method: 'POST' | 'PUT' = 'POST'): Promise<OmsRow> {
    const token = await this.token();
    try {
      return await this.request(path, {method,
        headers: {Authorization: `Bearer ${token}`, "Content-Type": "application/json"}, body: JSON.stringify(body),
      }, true) as OmsRow;
    } finally {
      this.reads.clear();
    }
  }
}
