# Syncing products to your own website

How to get a shop's stock, prices and images onto a website you wrote yourself,
one way, without polling and without adding anything to this codebase.

Everything here already exists: **Integrations** owns the credentials (API
tokens) and the destination (webhooks). Nothing needs to be switched on in code.

---

## The shape of it, and why

The webhook carries **no business data**. It says _that_ an entity changed, and
your website then reads the records through the same versioned API the shop's
own pages use:

```
POS  --(POST: "items changed")-->  your website
                                        |
                                        +--(GET /api/v1/items)--> POS  --(JSON)--> your website
```

That is deliberate. A webhook body that repeated the catalogue would be a second
copy of the shop's data, stale the moment it was queued, and unreadable to
anything that had not already learned the POS's field names. A signal is small,
cheap to retry and impossible to leak much through: a stolen webhook secret
alone exposes nothing, because the reader still needs its own scoped token.

Your website needs to reach the POS API over **HTTPS** from the public internet.
A till on a shop LAN behind NAT needs a reverse proxy or a tunnel; the webhook
endpoint itself must be HTTPS too (plain `http` is accepted only for
`localhost` / `127.0.0.1`, for local development).

A **paired build supplies the tunnel itself**, which is why a shop that is
paired needs no router configuration. It runs `cloudflared` as a child process
and writes its own config at every launch, so the tunnel always points at the
port the API actually bound — the API asks for 5555 and moves to a derived port
when that is taken.

The tunnel's ingress is deliberately narrow: **`/api/v1/*` and `/uploads/*`
only**, with a catch-all that answers 404. The management API — `/api-tokens`,
`/items`, `/settings` — is therefore not reachable from the public internet even
when the tunnel is up. Product images are served from `/uploads` as static files
and need no token; that is why the website can mirror them with a bare GET.

---

## 1. In the POS: a token, then a webhook

Both live under **Settings → Integrations**. The signed-in user needs
`branch: write` for either — a token is a standing credential for the whole
shop, and a webhook address decides where the shop's change signals go.

> **If this till was shipped already paired**, both halves may already be here
> and are marked as such: the token is named `ShuttleZone website` and the
> webhook is read-only, because the operator decided them before the installer
> was built. Nothing below needs doing by hand in that case — and that is the
> point of the arrangement. Read on only for a self-managed setup, or to
> understand what those rows are.
>
> A paired build also ships a tunnel client, so the shop is reachable without
> anyone configuring a router. The rest of this document assumes you are
> managing both halves yourself, which is the general case.

### The token (what your website reads with)

1. **API tokens → new token.** Name it after the website (`shop-website`).
2. Grant exactly one scope: **`item: read`**. Add **`category: read`** only if
   you also want the category records.
3. Copy the token. It is shown **once**; only its SHA-256 hash is stored.

A provisioned token is minted the same way and stored the same way — same hash,
same scope whitelist. The only difference is where the value came from: an
installer decides it in advance so the website can be told the same string
before the shop exists. If a paired build is ever re-issued with a new value,
the old token is revoked in the same step, so the superseded credential stops
working rather than lingering as a second way in.

### The webhook (what wakes your website up)

1. **Webhooks → New Webhook.**
2. Endpoint URL: `https://your-site.example/posnic/hook`.
3. Tick these entities:
   - **items** — names, prices, images, stock edited by hand
   - **categories** — the category names your pages group by
   - **sales** — **stock moves here, not under `items`**
   - **receivings** — stock comes back in here

   Sales and receivings are the ones people forget. A saved bill decrements
   `available_quantity` on the item document, and that write arrives as a
   `sales` change, so a website subscribed only to `items` will happily show
   yesterday's stock.

4. Copy the **secret**. Also shown once.

`GET /api/webhooks` lists subscriptions (never the secret) and
`GET /api/webhooks/deliveries` lists recent attempts with their status — that is
the first place to look when a site stops updating.

---

## 2. What arrives at your endpoint

```
POST /posnic/hook HTTP/1.1
content-type: application/json
x-posnic-signature: sha256=<HMAC-SHA256 of the raw body, keyed by your secret>
x-posnic-delivery: 66f1c0a3…          (unique per attempt, stable across retries)
x-posnic-event: change

{"event":"change","entity":"items","at":"2026-09-26T09:14:03.221Z","shop":"posnic_shop_ab12"}
```

- `entity` is one of `items`, `categories`, `sales`, `receivings`, … — whatever
  you ticked. Treat unknown entities as "refresh the catalogue", never as an
  error.
- `shop` is the tenant's database name. Opaque — store it if you may connect a
  second shop later, ignore it otherwise.
- **Verify the signature** over the exact bytes you received. If you parse JSON
  first and re-serialise, key order and spacing change and the digest will not
  match. In Express that means `express.raw()`, not `express.json()` — or
  `express.json({ verify })` if you need the parsed body too.
- Reply **2xx within 10 seconds** and do the work after replying.

### What happens if you don't answer

| Outcome                                     | What the POS does                                                       |
| ------------------------------------------- | ----------------------------------------------------------------------- |
| `2xx`                                       | Delivered. Done.                                                        |
| `4xx` (except 408, 429)                     | Permanent — the delivery is marked `dead` and not retried.              |
| `408`, `429`, `5xx`, timeout, network error | Retried: 1 min, 5 min, 25 min, ~2 h, ~10 h; five attempts, then `dead`. |

Two behaviours worth designing around:

- **Signals are coalesced per entity while one is pending.** A shop ringing up
  forty bills produces one pending `sales` delivery, not forty — so a burst
  costs you one pull, not forty.
- **Retries drain lazily, on the shop's own API traffic.** An idle shop with no
  other requests may retry later than the table suggests. Retries are a
  courtesy, not a guarantee: never treat a webhook as the only way to notice
  drift. A once-an-hour reconciliation sweep costs almost nothing.

A `dead` row is not silent — it stays visible in Integrations → Deliveries so
somebody can see that your endpoint was refusing for two days.

---

## 3. A receiver, end to end

```js
const express = require("express");
const crypto = require("crypto");

const SECRET = process.env.POSNIC_WEBHOOK_SECRET; // from Integrations, shown once
const POS_API = process.env.POSNIC_API_BASE; // e.g. https://pos.shop.example
const TOKEN = process.env.POSNIC_API_TOKEN; // posnic_…
const ENTITIES = ["items", "categories"]; // what you actually mirror

const app = express();

app.post(
  "/posnic/hook",
  express.raw({ type: "application/json" }), // exact bytes, on purpose
  (req, res) => {
    const expected =
      "sha256=" +
      crypto
        .createHmac("sha256", SECRET)
        .update(req.body) // Buffer, not a string
        .digest("hex");

    const got = String(req.headers["x-posnic-signature"] || "");
    const ok =
      got.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected));
    if (!ok) return res.status(401).end();

    const event = JSON.parse(req.body.toString("utf8"));
    res.status(202).end(); // answer first, then work

    /* x-posnic-delivery is unique per attempt and stable across retries - the
       natural dedupe key if you would rather be safe than sorry. */
    enqueuePull(event.entity, req.headers["x-posnic-delivery"]);
  },
);
```

The pull itself, with the cursor kept between runs:

```js
const CURSORS = new Map(); // entity -> cursor. Persist this in your own DB.

async function pull(entity) {
  if (!ENTITIES.includes(entity)) return;
  for (;;) {
    const url = new URL(`/api/v1/${entity}`, POS_API);
    url.searchParams.set("limit", "200");
    const cursor = CURSORS.get(entity);
    if (cursor) url.searchParams.set("cursor", cursor);

    const res = await fetch(url, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    if (res.status === 429) {
      await sleep(2000);
      continue;
    }
    if (!res.ok)
      throw new Error(`${entity}: ${res.status} ${await res.text()}`);

    const { data, meta } = await res.json();
    await upsert(entity, data); // your own write
    if (!meta.next_cursor) return; // caught up
    CURSORS.set(entity, meta.next_cursor); // persist BEFORE the next call
  }
}
```

---

## 4. The read API

```
GET /api/v1/items?limit=200&cursor=<opaque>
authorization: Bearer posnic_…
```

- **Entities:** `items`, `categories`, `sales`, `customers`, `suppliers`,
  `receivings`, `expenses`. (`POST`/`PATCH` exist for `customers` only — reads
  are what a product sync needs.)
- **Pagination:** `limit` defaults to 50, caps at 200. Pass `meta.next_cursor`
  back as `?cursor=` until it comes back `null`. The cursor is a compound of
  `updated_date` and `_id`, so records never skip or repeat between pages.
- **Ordering:** ascending by `updated_date`. A cursor is therefore also a
  bookmark: resume from it and you receive everything touched since.
- **Scoping:** licence and branch, taken from whoever minted the token. A token
  minted by a manager restricted to one branch sees that branch.
- **Rate limit:** 300 requests/minute per token → `429` with
  `{"error":{"code":"rate_limited"}}`. Back off; 200 rows a page means a full
  catalogue is a handful of calls.
- **Refusals:** `403` `forbidden` when the token lacks the scope for the entity
  (the message names the missing one), `404` `unknown_entity` for a typo.

### Item fields worth mirroring

| Field                                                    | Notes                                                                                      |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `name`, `itemid`, `barcode_id`, `sku`                    | `itemid` is the shop's own code; `barcode_id` may be an in-store code, not a GTIN          |
| `selling_price`, `mrp_price`, `company_price`            | numbers, in the shop's currency                                                            |
| `available_quantity`, `track_inventory`                  | see _stock_ below                                                                          |
| `image`, `multi_image`                                   | see _images_ below                                                                         |
| `category_name`, `unit`, `tax_name`, `tax`               | `category_name` is already denormalised — you rarely need `category_id`                    |
| `item_status`, `show_on_menu`, `ecommerce`               | `active` / `inactive` / `draft` / `instant` / `regular`, plus the shop's own channel flags |
| `del_status`, `updated_date`, `branch_id`, `branch_name` | see _filtering_ below                                                                      |

**Stock.** Only trust `available_quantity` when `track_inventory` is true. When
it is false the shop does not count that item (a service, or a dish sold by the
day), and the number is meaningless — the POS's own schema.org export refuses to
claim availability for those, and your site should too. `negative_stock` says
whether the shop allows selling past zero.

**Filtering.** The list returns what the shop can see, not what the public may
buy, so filter in your own code:

- drop `del_status` of `1`, `'1'` or `true` (deleted; no event is sent for these)
- drop `item_status` of `inactive` or `draft` if you only sell live items
- keep `ecommerce` / `show_on_menu` rows only if your site is the ordering
  channel rather than a catalogue

Deletion has no webhook of its own, which is why the filter matters on every
pull rather than once: a deleted item arrives only as "something changed".

**Images.** `image` and `multi_image` hold whatever the shop stored, which in
live data is one of four shapes: a storage key (`<tenant>/items/<hash>.jpg`), an
already-relative path (`/uploads/item_images/…`), a bare legacy filename, or a
foreign URL such as a CDN. `api/src/utils/image-store.js` is the single place
that knows how to turn each into something a browser can load, and the rule is
short enough to mirror:

- a key or a bare filename → `<POS_API>/uploads/<value>`
- a path already starting `/uploads/` → `<POS_API>` + the path
- any absolute URL whose path is under `/uploads/` → keep the path, drop the
  origin (a `localhost` origin was only ever true on the machine that wrote it)
- any other absolute URL → leave it alone, it is somebody else's origin

`/uploads/<key>` is served publicly with a one-year immutable cache, and keys are
content-addressed, so the bytes behind a URL never change — a new photo is a new
URL. No token is needed to fetch an image.

---

## 5. The first import

There is nothing special about it: call `pull(entity)` with no cursor and let it
walk to the end. Do it for `items` and `categories`, then start handling
webhooks — or the other way round; the cursor makes a missed signal harmless
because the next pull starts where you stopped.

If you would rather have the whole catalogue in one document, the POS also
exports it as schema.org JSON-LD including price, images and availability:

```
GET /api/items/export/jsonld?currency=INR      (item: read)
```

`Product` and `ProductGroup` nodes, so variants arrive as one product with
variants rather than as unrelated rows. Handy for search engines and a good
cross-check against what your puller built.

---

## 6. Running it

**Diagnosing a website that stopped updating**

1. **Integrations → Deliveries.** `dead` rows name the failure class
   (`http_4xx`, `http_5xx`, `timeout`, `network_error`) without leaking your
   URLs or payloads. A `4xx` almost always means a signature or path mistake.
2. Check the last successful pull. If deliveries are green and the site is
   stale, the bug is in your puller or its cursor storage, not the webhook.
3. Re-register the webhook if the secret may have been lost — a new secret is
   minted only by creating a new subscription; delete the old one.

**What not to do**

- Don't poll the whole catalogue every minute. Subscribe to `items` and let the
  cursor do the work; a full sweep once a day is enough to catch anything a
  missed signal hid.
- Don't handle `sales` by mirroring bills. It is a stock signal: pull `items`
  and take the new `available_quantity`.
- Don't put the token in a browser. It reads the shop's data for every branch
  the minting user can see; it belongs on your server.
