/**
 * AdSparkle SDK — single-function tracking API
 *
 * Queue-based async pattern (similar to GA / FB Pixel):
 *
 *   <!-- Endpoint override: SDK is served from the apex domain, API from the api. subdomain -->
 *   <script>window.ADSPARKLE_ENDPOINT = "https://api.adsparkle.co/api/tracking/postback";</script>
 *   <script async src="https://adsparkle.co/sdk/adsparkle.js"></script>
 *   <script>
 *     (function(t,d,k){(t[k]=t[k]||[]).push(d);t[d]=t[d]||t[k].f||function(){(t[d].q=t[d].q||[]).push(arguments)}})(window,"adsparkle","AdSparkleObject");
 *
 *     // Every page (click tracking):
 *     adsparkle("co_xxx", "click");
 *
 *     // Thank-you page (conversion):
 *     adsparkle("co_xxx", "conversion", { conversionType: "purchase", amount: { value: 299.90, currency: "TRY" }, transactionId: "ORDER-1" });
 *
 *     // Custom event (a company-defined event shortId, e.g. "YE2YFSQ"):
 *     adsparkle("co_xxx", "conversion", { conversionType: "YE2YFSQ", transactionId: "ORDER-2" });
 *   </script>
 *
 * Responsibilities:
 *   1. Parse `?click_id=<uuid>` from the URL and store it in cookie/localStorage
 *   2. Manage the click chain (max 50, TTL 7 days = backend attribution window)
 *   3. POST conversion events directly to the AdSparkle backend
 *
 * What it does NOT do (handled on the backend):
 *   - Fraud detection / decisions (FraudEngine)
 *   - Attribution selection (AttributionResolver)
 *   - Payout computation (LedgerService)
 *
 * NOTES:
 *   - If there is no click_id, the conversion is silently dropped ({ ok: false, error: "no_click_id" }).
 *     This is the expected behavior for organic traffic — only users arriving from an ad click
 *     produce a conversion.
 *   - Endpoint override: if window.ADSPARKLE_ENDPOINT is not set, /api/tracking/postback is
 *     derived from the SDK URL origin. If the SDK and API are on different origins, the override
 *     is mandatory.
 *
 * Build target: ES2015+ (modern browsers + RN/Capacitor JS engines)
 * License: MIT
 */

(function (global, factory) {
  // UMD-ish: install on window OR export as module
  if (typeof exports === "object" && typeof module !== "undefined") {
    module.exports = factory();
    return;
  }
  if (typeof define === "function" && define.amd) {
    define(factory);
    return;
  }
  // Browser path: replace stub (with .q queue) with real impl + drain queue
  var realImpl = factory();
  var stub = global.adsparkle;
  global.adsparkle = realImpl;
  if (stub && stub.q && stub.q.length) {
    for (var i = 0; i < stub.q.length; i++) {
      try { realImpl.apply(null, stub.q[i]); }
      catch (e) { console.warn("[adsparkle] queued call failed:", e); }
    }
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ─── Constants ───────────────────────────────────────────────────────────

  var ATTRIBUTION_WINDOW_DAYS = 7;
  var MAX_CHAIN_SIZE = 50;
  var STORAGE_KEY_CHAIN = "adsparkle:click_ids";
  var STORAGE_KEY_USER = "adsparkle:user_id";
  var STORAGE_KEY_QUEUE = "adsparkle:retry_queue";
  var COOKIE_NAME = "adsparkle_click_ids";
  var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  // conversionType (AdSparkle API) → backend event_type
  // Derived events (first_purchase, second_purchase, third_purchase) are auto-emitted by the
  // backend, so they are NOT EXPOSED HERE — even if you tried to send them, the backend would
  // reject them.
  // NOTE: This map is a convenience alias table, NOT the sole list of valid events.
  // A conversionType not in the map may be a company CUSTOM event shortId
  // (format ^[A-Za-z0-9_]{1,64}$) and is passed through as-is by mapEventType().
  var EVENT_TYPE_MAP = {
    install: "install",
    "sign_up": "sign_up",
    signup: "sign_up",
    "sign-up": "sign_up",
    register: "sign_up",
    login: "login",
    "log-in": "login",
    "log_in": "login",
    download: "download",
    purchase: "purchase",
    order: "purchase",
    sale: "purchase",
    subscription: "subscription",
    subscribe: "subscription",
    refund: "refund",
    "chargeback": "refund",
  };

  // ─── Endpoint detection ──────────────────────────────────────────────────

  /**
   * Derive the backend endpoint from the <script src> URL.
   *   <script src="https://api.adsparkle.co/sdk/adsparkle.js"> → https://api.adsparkle.co/api/tracking/postback
   * window.ADSPARKLE_ENDPOINT can be set for a manual override (debug/testing).
   */
  function deriveEndpoint() {
    if (typeof window !== "undefined" && window.ADSPARKLE_ENDPOINT) {
      return String(window.ADSPARKLE_ENDPOINT);
    }
    if (typeof document === "undefined") return "/api/tracking/postback";
    try {
      var scripts = document.getElementsByTagName("script");
      for (var i = scripts.length - 1; i >= 0; i--) {
        var src = scripts[i].src || "";
        if (/\/sdk\/adsparkle(\.min)?\.js\b/.test(src)) {
          var u = new URL(src, window.location.href);
          return u.origin + "/api/tracking/postback";
        }
      }
    } catch (e) { /* ignore */ }
    return "/api/tracking/postback";
  }

  // ─── Storage (web localStorage + cookie) ─────────────────────────────────

  function getStorage() {
    if (typeof window === "undefined" || !window.localStorage) {
      // Fallback in-memory store (won't persist)
      var mem = {};
      return {
        get: function (k) { return mem[k]; },
        set: function (k, v) { mem[k] = v; },
        remove: function (k) { delete mem[k]; },
      };
    }
    return {
      get: function (k) {
        try {
          var raw = window.localStorage.getItem(k);
          if (!raw) return null;
          var parsed = JSON.parse(raw);
          if (parsed && parsed._exp && Date.now() > parsed._exp) {
            window.localStorage.removeItem(k);
            return null;
          }
          return parsed && parsed._v != null ? parsed._v : parsed;
        } catch (e) { return null; }
      },
      set: function (k, v, ttlMs) {
        try {
          var wrap = ttlMs ? { _v: v, _exp: Date.now() + ttlMs } : { _v: v };
          window.localStorage.setItem(k, JSON.stringify(wrap));
        } catch (e) { /* quota exceeded etc. */ }
      },
      remove: function (k) {
        try { window.localStorage.removeItem(k); } catch (e) { /* ignore */ }
      },
    };
  }

  var storage = getStorage();

  function writeCookie(name, value, days) {
    if (typeof document === "undefined") return;
    try {
      var d = new Date();
      d.setTime(d.getTime() + days * 24 * 60 * 60 * 1000);
      var secure = window.location.protocol === "https:" ? "; Secure" : "";
      document.cookie = name + "=" + encodeURIComponent(value) +
        "; expires=" + d.toUTCString() + "; path=/; SameSite=Lax" + secure;
    } catch (e) { /* ignore */ }
  }

  function readCookie(name) {
    if (typeof document === "undefined") return null;
    try {
      var match = document.cookie.match(new RegExp("(^|;)\\s*" + name + "=([^;]+)"));
      return match ? decodeURIComponent(match[2]) : null;
    } catch (e) { return null; }
  }

  // ─── Click chain management ──────────────────────────────────────────────

  function getClickIds() {
    var stored = storage.get(STORAGE_KEY_CHAIN);
    if (stored && stored.ids) return stored.ids.slice();
    // Cookie fallback (cross-subdomain)
    var cookie = readCookie(COOKIE_NAME);
    if (cookie) {
      try {
        var parsed = JSON.parse(cookie);
        return Array.isArray(parsed) ? parsed.slice() : [];
      } catch (e) { /* invalid */ }
    }
    return [];
  }

  function saveClickIds(ids) {
    var ttlMs = ATTRIBUTION_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    storage.set(STORAGE_KEY_CHAIN, { ids: ids, ts: Date.now() }, ttlMs);
    writeCookie(COOKIE_NAME, JSON.stringify(ids), ATTRIBUTION_WINDOW_DAYS);
  }

  function addClickId(clickId) {
    if (!UUID_RE.test(clickId)) return;
    var current = getClickIds();
    var idx = current.indexOf(clickId);
    if (idx !== -1) current.splice(idx, 1); // move to end (most recent)
    current.push(clickId);
    if (current.length > MAX_CHAIN_SIZE) {
      current = current.slice(current.length - MAX_CHAIN_SIZE);
    }
    saveClickIds(current);
  }

  function captureFromUrl() {
    if (typeof window === "undefined") return null;
    try {
      var url = new URL(window.location.href);
      var clickId = url.searchParams.get("click_id");
      if (clickId && UUID_RE.test(clickId)) {
        addClickId(clickId);
        // Clean URL cosmetically (optional)
        try {
          url.searchParams.delete("click_id");
          window.history.replaceState({}, "", url.toString());
        } catch (e) { /* ignore */ }
        return clickId;
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  // ─── User ID handling ────────────────────────────────────────────────────

  function getUserId() {
    return storage.get(STORAGE_KEY_USER) || null;
  }

  function setUserId(userId) {
    if (userId) storage.set(STORAGE_KEY_USER, String(userId));
  }

  /**
   * Anonymous session ID generator (when merchant doesn't pass user_id).
   * Persists per browser, allows backend to track repeat anonymous conversions.
   */
  function getOrCreateAnonId() {
    var existing = getUserId();
    if (existing) return existing;
    var anon = "anon_" + Date.now().toString(36) +
      Math.random().toString(36).slice(2, 10);
    setUserId(anon);
    return anon;
  }

  // ─── POST to backend ─────────────────────────────────────────────────────

  function sendEvent(payload, endpoint, companyKey) {
    if (typeof fetch === "undefined") return Promise.resolve({ ok: false, error: "no_fetch" });
    return fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Company-Key": companyKey,
      },
      body: JSON.stringify(payload),
      credentials: "omit",
      keepalive: true,
    }).then(function (res) {
      return res.json().catch(function () { return null; })
        .then(function (body) { return { ok: res.ok, status: res.status, body: body }; });
    }).catch(function (err) {
      enqueueRetry(payload, endpoint, companyKey);
      return { ok: false, error: String(err && err.message) || "network_error" };
    });
  }

  // ─── Offline retry queue ─────────────────────────────────────────────────

  var MAX_QUEUE_SIZE = 100;

  function enqueueRetry(payload, endpoint, companyKey) {
    try {
      var queue = storage.get(STORAGE_KEY_QUEUE) || [];
      if (queue.length >= MAX_QUEUE_SIZE) queue.shift();
      queue.push({ payload: payload, endpoint: endpoint, companyKey: companyKey, ts: Date.now() });
      storage.set(STORAGE_KEY_QUEUE, queue);
    } catch (e) { /* storage full, drop */ }
  }

  function flushQueue() {
    var queue = storage.get(STORAGE_KEY_QUEUE) || [];
    if (!queue.length) return Promise.resolve({ flushed: 0, remaining: 0 });
    var promises = queue.map(function (item) {
      return sendEvent(item.payload, item.endpoint, item.companyKey);
    });
    return Promise.all(promises).then(function (results) {
      var failed = [];
      for (var i = 0; i < results.length; i++) {
        if (!results[i] || !results[i].ok) failed.push(queue[i]);
      }
      storage.set(STORAGE_KEY_QUEUE, failed);
      return { flushed: queue.length - failed.length, remaining: failed.length };
    });
  }

  // Auto-flush when browser comes online
  if (typeof window !== "undefined") {
    window.addEventListener("online", function () { flushQueue(); });
  }

  // ─── Event type mapping ──────────────────────────────────────────────────

  // Custom event shortId format (backend: /^[a-zA-Z0-9_]+$/, 1-64 chars) — MIXED CASE.
  // shortIds are UPPERCASE (YE2YFSQ), system keys are lowercase (purchase).
  var CUSTOM_EVENT_RE = /^[A-Za-z0-9_]{1,64}$/;

  function mapEventType(conversionType) {
    if (!conversionType) return null;
    var normalized = String(conversionType).toLowerCase().trim();
    var mapped = EVENT_TYPE_MAP[normalized];
    if (mapped) return mapped;
    // Not in EVENT_TYPE_MAP: may be a company CUSTOM event shortId (e.g. "YE2YFSQ").
    // If the trimmed original (case PRESERVED — shortIds are uppercase) passes the format
    // check, pass it through as event_type as-is; otherwise still null (invalid_conversion_type).
    var raw = String(conversionType).trim();
    if (CUSTOM_EVENT_RE.test(raw)) return raw;
    return null;
  }

  // ─── Value resolver (AdSparkle sources) ────────────────────────────
  //
  // Usage:
  //   transactionId: "ORDER-123"                       → fixed value
  //   transactionId: { queryParam: "order_id" }        → read ?order_id=XYZ from the URL
  //   transactionId: { cookieParam: "tx_cookie" }      → read from a cookie
  //
  // Radically simplifies the merchant's integration code — instead of writing their own
  // extraction logic, they just declare the source to the SDK.

  function resolveValue(input) {
    if (input == null) return null;
    if (typeof input !== "object") return input; // fixed value (string/number)

    // { queryParam: "name" } → read from the URL
    if (typeof input.queryParam === "string" && typeof window !== "undefined") {
      try {
        var u = new URL(window.location.href);
        var qv = u.searchParams.get(input.queryParam);
        return qv != null ? qv : null;
      } catch (e) { return null; }
    }

    // { cookieParam: "name" } → read from a cookie
    if (typeof input.cookieParam === "string") {
      return readCookie(input.cookieParam);
    }

    // A regular object like amount: { value: ..., currency: ... } — the caller handles it
    return input;
  }

  // ─── Automatic product capture (GA4 / dataLayer) ───────────────────────────
  //
  // The web equivalent of Adjust AUTOMATICALLY reading the purchased product from the store
  // receipt on mobile. There is no central receipt authority on the web; but most sites already
  // push a "purchase" ecommerce event to window.dataLayer for GA4/GTM. If the merchant does not
  // pass productIds, we automatically extract the item_ids from the most recent ecommerce event —
  // so product info is recorded without the merchant writing extra code on every sale.
  //
  // Supported schemas:
  //   GA4:  { event:"purchase", ecommerce:{ items:[{ item_id:"SKU" }] } }
  //   UA:   { event:"purchase", ecommerce:{ purchase:{ products:[{ id:"SKU" }] } } }
  //
  // Only runs for product-bearing events (purchase/subscription/refund) and can be disabled with
  // params.autoCaptureProducts === false.

  var AUTO_CAPTURE_EVENTS = { purchase: 1, subscription: 1, refund: 1 };

  function autoCaptureProductIds() {
    if (typeof window === "undefined" || !Array.isArray(window.dataLayer)) return null;
    // Newest event first: scan from end to start, find the first ecommerce purchase.
    for (var i = window.dataLayer.length - 1; i >= 0; i--) {
      var entry = window.dataLayer[i];
      if (!entry || typeof entry !== "object") continue;
      var ec = entry.ecommerce;
      if (!ec || typeof ec !== "object") continue;
      // GA4: ecommerce.items[] — UA: ecommerce.purchase.products[]
      var items = ec.items;
      if (!Array.isArray(items) && ec.purchase && Array.isArray(ec.purchase.products)) {
        items = ec.purchase.products;
      }
      if (!Array.isArray(items) || !items.length) continue;
      var ids = items
        .map(function (it) {
          if (!it || typeof it !== "object") return null;
          return it.item_id || it.id || it.sku || null; // GA4 | UA | custom
        })
        .filter(function (v) { return v != null; })
        .map(String);
      if (ids.length) return ids;
    }
    return null;
  }

  // ─── Main entry point ────────────────────────────────────────────────────

  /**
   * adsparkle(companyKey, action, params?)
   *
   * @param {string} companyKey  - public company key in "co_..." format
   * @param {string} action      - "click" | "conversion"
   * @param {Object} [params]    - parameters depending on the action
   *
   *   For "conversion":
   *     conversionType: "purchase" | "signup" | "login" | "subscription" | "refund" | "install" | "download"
   *                     OR a company CUSTOM event shortId (e.g. "YE2YFSQ").
   *                     Built-in names are convenience aliases; additionally, any shortId
   *                     matching ^[A-Za-z0-9_]{1,64}$ is sent as event_type as-is.
   *                     (product_ids / custom_params (customParams) are already supported.)
   *     transactionId?: Value          - REQUIRED for purchase/subscription/refund
   *     externalId?: Value             - transactionId alias (field alias)
   *     amount?: { value: Value, currency?: Value } OR amount: Value (number)
   *     currency?: Value               - amount.currency alias
   *     currencyCode?: Value           - currency alias (field alias, ISO 4217)
   *     userId?: Value                 - falls back to an anon session ID if omitted
   *     customerId?: Value             - userId alias (field alias)
   *     productIds?: Value[]            - list of purchased product IDs/SKUs. If omitted,
   *                                       it is captured AUTOMATICALLY from the GA4/GTM
   *                                       dataLayer for purchase/subscription/refund (Adjust-style).
   *     autoCaptureProducts?: boolean   - disable automatic dataLayer product capture (default: on)
   *     customParams?: { [k: string]: Value }  - hidden custom tags (merchant-defined private tags)
   *
   *   Value = string | number | { queryParam: string } | { cookieParam: string }
   *
   *   Value resolver (AdSparkle):
   *     "ORDER-123"                       → fixed value
   *     { queryParam: "order_id" }        → automatically read ?order_id=XYZ from the URL
   *     { cookieParam: "user_session" }   → automatically read from a cookie
   */
  function adsparkle(companyKey, action, params) {
    // Validation
    if (typeof companyKey !== "string" || !companyKey) {
      console.warn("[adsparkle] companyKey gerekli (string)");
      return;
    }
    if (typeof action !== "string") {
      console.warn("[adsparkle] action 'click' veya 'conversion' olmali");
      return;
    }

    var endpoint = deriveEndpoint();

    // ─── action: "click" ───
    if (action === "click") {
      var clickId = captureFromUrl();
      // Whether or not a click was captured, we return immediately
      // (we do not POST to the backend for clicks — the chain is kept locally and
      // sent together with click_ids when a conversion fires).
      return Promise.resolve({ ok: true, clickId: clickId, chainSize: getClickIds().length });
    }

    // ─── action: "conversion" ───
    if (action === "conversion") {
      params = params || {};
      var eventType = mapEventType(params.conversionType);
      if (!eventType) {
        console.warn("[adsparkle] gecersiz conversionType:", params.conversionType,
          "Gecerli: purchase, signup, login, subscription, refund, install, download " +
          "veya bir custom event shortId'i (^[A-Za-z0-9_]{1,64}$)");
        return Promise.resolve({ ok: false, error: "invalid_conversion_type" });
      }

      // ─── Field resolution (queryParam/cookieParam/fixed) ───
      // userId aliases: userId | user_id | customerId (field alias)
      var resolvedUserId = resolveValue(params.userId || params.user_id || params.customerId);
      var userId = resolvedUserId || getOrCreateAnonId();
      // Only persist if the merchant provides it explicitly (the anon ID is already stored automatically)
      if (resolvedUserId) setUserId(userId);

      // transactionId aliases: transactionId | transaction_id | externalId (field alias)
      var transactionId = resolveValue(params.transactionId || params.transaction_id || params.externalId);

      // amount — accepts { value, currency }, a direct number/string, or { queryParam }
      var amount;
      var currency;
      if (params.amount != null) {
        if (typeof params.amount === "object" && params.amount.value !== undefined) {
          // { value: ..., currency: ... } — value may also be queryParam/cookieParam
          var resolvedAmt = resolveValue(params.amount.value);
          amount = resolvedAmt != null ? Number(resolvedAmt) : undefined;
          currency = params.amount.currency;
        } else {
          // direct number/string/queryParam
          var resolvedAmt2 = resolveValue(params.amount);
          amount = resolvedAmt2 != null ? Number(resolvedAmt2) : undefined;
        }
      }
      // currency aliases: currency | currencyCode (field alias) | amount.currency
      if (params.currency) currency = resolveValue(params.currency) || currency;
      if (params.currencyCode) currency = resolveValue(params.currencyCode) || currency;

      // productIds can also be resolved (array of values, each item resolved)
      var productIds;
      var rawProducts = params.productIds || params.product_ids;
      if (Array.isArray(rawProducts)) {
        productIds = rawProducts.map(function (v) { return resolveValue(v); })
          .filter(function (v) { return v != null; }).map(String);
      }
      // If the merchant did not pass productIds explicitly → Adjust-style AUTOMATIC capture:
      // pull product IDs from the ecommerce event in the GA4/GTM dataLayer.
      // Only for product-bearing events and when autoCaptureProducts is not disabled.
      if ((!productIds || !productIds.length) &&
          params.autoCaptureProducts !== false &&
          AUTO_CAPTURE_EVENTS[eventType]) {
        var autoProducts = autoCaptureProductIds();
        if (autoProducts && autoProducts.length) productIds = autoProducts;
      }

      // customParams — equivalent of advS1-5: hidden tags visible only to the merchant
      // Each field is resolved (fixed/queryParam/cookieParam)
      var customParams;
      if (params.customParams && typeof params.customParams === "object") {
        customParams = {};
        for (var k in params.customParams) {
          if (Object.prototype.hasOwnProperty.call(params.customParams, k)) {
            var resolved = resolveValue(params.customParams[k]);
            if (resolved != null) customParams[k] = String(resolved);
          }
        }
        if (!Object.keys(customParams).length) customParams = undefined;
      }

      var chain = getClickIds();
      var clickId = chain.length ? chain[chain.length - 1] : null;
      if (!clickId) {
        console.warn("[adsparkle] click_id yok — bu kullaniciya conversion yazilamaz (organic)");
        return Promise.resolve({ ok: false, error: "no_click_id" });
      }

      var payload = {
        click_id: clickId,
        click_ids: chain,
        event_type: eventType,
        user_id: userId,
      };
      if (transactionId) payload.transaction_id = String(transactionId);
      if (amount != null && !isNaN(amount)) payload.amount = amount;
      if (currency) payload.currency = String(currency);
      if (productIds && productIds.length) payload.product_ids = productIds;
      if (customParams) payload.custom_params = customParams;

      return sendEvent(payload, endpoint, companyKey);
    }

    // Future actions: "identify", "set", etc.
    console.warn("[adsparkle] bilinmeyen action:", action,
      "Gecerli: click, conversion");
    return Promise.resolve({ ok: false, error: "unknown_action" });
  }

  // Expose helpers for advanced users (optional, namespaced)
  adsparkle.getClickIds = getClickIds;
  adsparkle.getUserId = getUserId;
  adsparkle.setUserId = setUserId;
  adsparkle.flushQueue = flushQueue;
  adsparkle.autoCaptureProductIds = autoCaptureProductIds;
  adsparkle.version = "2.2.1";

  return adsparkle;
});
