# AdSparkle Browser SDK (`adsparkle-web`)

GA/Pixel-style browser SDK for the AdSparkle affiliate attribution platform:
captures `?click_id=` from the landing URL, persists the click chain (7-day
attribution window, cookie + localStorage), and fires conversion postbacks to
the tracking API. Zero dependencies, UMD, ~10 kB.

## Installation

### Option A — script tag (recommended, self-hosted or CDN)

```html
<script>window.ADSPARKLE_ENDPOINT = "https://api.adsparkle.co/api/tracking/postback";</script>
<script async src="https://unpkg.com/adsparkle-web@2/adsparkle.js"></script>
<script>
  (function(t,d,k){(t[k]=t[k]||[]).push(d);t[d]=t[d]||t[k].f||function(){(t[d].q=t[d].q||[]).push(arguments)}})(window,"adsparkle","AdSparkleObject");
  adsparkle("YOUR_COMPANY_KEY", "click");
</script>
```

The stub on the third line queues any `adsparkle(...)` calls made before the
async script finishes loading; the SDK drains the queue on load (same pattern
as Google Analytics / Facebook Pixel).

### Option B — npm (bundler / module import)

```bash
npm install adsparkle-web
```

```js
window.ADSPARKLE_ENDPOINT = "https://api.adsparkle.co/api/tracking/postback"; // required in module mode
const adsparkle = require("adsparkle-web"); // or: import adsparkle from "adsparkle-web";

adsparkle("YOUR_COMPANY_KEY", "click"); // on every page load
```

> **`window.ADSPARKLE_ENDPOINT` is required in module mode.** In script-tag
> mode the SDK can derive the endpoint from its own `<script src>` origin, but
> an imported module has no script URL — set the endpoint explicitly before
> the first call.

## Usage

```js
// Landing page / every page — capture the click:
adsparkle("co_xxx", "click");

// Conversion (system event key or your custom-event shortId from the panel):
adsparkle("co_xxx", "conversion", {
  conversionType: "purchase",          // or a custom shortId, e.g. "YE2YFSQ"
  transactionId: "ORDER-1",            // required for repeatable events
  amount: { value: 299.90, currency: "TRY" },
  productIds: ["SKU-8842", "SKU-1290"], // optional — product-scoped campaigns
  customParams: { plan: "gold" },       // optional — up to 15 string pairs
  userId: "customer-12345",             // optional — stable anon id otherwise
});
```

- `conversionType` accepts the built-in aliases (`purchase`, `signup`,
  `sign_up`, `install`, `login`, `download`, `subscription`, `refund`, legacy
  `sale`) **or any custom-event shortId** matching `^[A-Za-z0-9_]{1,64}$`.
- Derived events (`first_purchase`, `second_purchase`, `third_purchase`) are
  computed server-side and cannot be sent.
- If no `click_id` was captured (organic visitor), conversion calls are
  silently dropped with `{ ok: false, error: "no_click_id" }` — by design.

The company key is a **publishable** identifier (like a Stripe publishable
key); it is safe to embed in HTML. Never put your HMAC postback secret in
browser code — that secret is for server-to-server postbacks only.

## Docs

Full integration guide: https://docs.adsparkle.co

## License

MIT
