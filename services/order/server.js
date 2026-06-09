// order-service — middle of the chain. Real, non-fakeable dependencies:
//
//   1. EVERY /orders request first calls auth-service /authorize over real HTTP.
//      If that call fails (network error, timeout, non-2xx, or authorized!=true)
//      we MUST refuse the order and MUST NOT publish anything to Kafka.
//
//   2. ONLY after auth says yes do we publish "order-placed" to Kafka.
//      If publish itself fails we also return an error.
//
//   3. OPTIONAL: when the request includes `sku`, look it up in product-catalog
//      first. Unknown sku → 404; catalog unreachable → opaque 502 (same shape
//      as the auth-side failures, signature-indistinguishable on purpose).
//      When `sku` is absent the catalog is NOT called — that path is
//      byte-identical to the pre-catalog behavior and keeps existing tests
//      (Newman, k6) green without modification.
//
// This honesty is the whole point — when auth is down, no message ever reaches
// the topic, so inventory's downstream test will genuinely time out.

const express = require('express');
const { Kafka, logLevel } = require('kafkajs');

const PORT          = parseInt(process.env.PORT || '3002', 10);
const AUTH_URL      = process.env.AUTH_URL      || 'http://localhost:3001';
const AUTH_TOKEN    = process.env.AUTH_TOKEN    || 'demo-token-good';
const CATALOG_URL   = process.env.CATALOG_URL   || 'http://localhost:3005';
const KAFKA_BROKERS = (process.env.KAFKA_BROKERS || 'localhost:9092').split(',');
const KAFKA_TOPIC   = process.env.KAFKA_TOPIC   || 'order-placed';

const app = express();
app.use(express.json());

const kafka = new Kafka({
  clientId: 'order-service',
  brokers: KAFKA_BROKERS,
  logLevel: logLevel.WARN,
});
const producer = kafka.producer();

// Producer connects asynchronously; track readiness so /orders fails fast if
// Kafka isn't reachable yet rather than hanging the request.
let producerReady = false;
producer.connect()
  .then(() => { producerReady = true; console.log('[order] kafka producer connected'); })
  .catch((err) => console.error('[order] kafka producer connect failed:', err.message));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.post('/orders', async (req, res) => {
  const { id, qty, sku } = req.body || {};
  let { item } = req.body || {};
  // `id` is the per-checkout correlation key inventory converges on; it is
  // NOT the sku. Always required. `item` is required unless `sku` is supplied
  // (in which case we fill it from the catalog's product name).
  if (!id) {
    return res.status(400).json({ error: 'id is required' });
  }
  if (!sku && !item) {
    return res.status(400).json({ error: 'id and item are required' });
  }

  // ---- STEP 0 (optional): catalog lookup when sku is supplied. ---------
  // Absent sku → skip entirely; byte-identical to the pre-catalog path.
  if (sku) {
    let catResp;
    try {
      catResp = await fetch(`${CATALOG_URL}/products/${encodeURIComponent(sku)}`, {
        method: 'GET',
        signal: AbortSignal.timeout(2000),
      });
    } catch (err) {
      // Catalog unreachable → opaque 502, same shape as auth-side failures.
      return res.status(502).json({ error: 'upstream dependency unavailable' });
    }
    if (catResp.status === 404) {
      return res.status(404).json({ error: 'unknown product', sku });
    }
    if (!catResp.ok) {
      return res.status(502).json({ error: 'upstream dependency unavailable' });
    }
    const product = await catResp.json().catch(() => null);
    if (!product || !product.id) {
      return res.status(502).json({ error: 'upstream dependency unavailable' });
    }
    if (!item) item = product.name;  // fill item from catalog when not supplied
  }

  // ---- STEP 1: REAL auth call. Refusal on ANY failure mode. -------------
  let authResp;
  try {
    authResp = await fetch(`${AUTH_URL}/authorize`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Send token as Bearer; auth-service also accepts {token} in body.
        'Authorization': `Bearer ${AUTH_TOKEN}`,
      },
      body: JSON.stringify({ orderId: id, token: AUTH_TOKEN }),
      // Short timeout so a hung/down auth fails fast rather than tying up the
      // request for the default fetch timeout (which is effectively forever).
      signal: AbortSignal.timeout(2000),
    });
  } catch (err) {
    // Network error, DNS failure, timeout, connection refused — all here.
    // Response is intentionally opaque: it must not reveal WHICH upstream
    // failed, so that diagnosis genuinely requires walking the chain.
    return res.status(502).json({ error: 'upstream dependency unavailable' });
  }
  if (!authResp.ok) {
    return res.status(502).json({ error: 'upstream dependency unavailable' });
  }
  const authBody = await authResp.json().catch(() => ({}));
  if (authBody.authorized !== true) {
    // 502 (not 403) — a 403 would still hint at "permissions/auth" and
    // partially leak the cause. Keep every upstream-related failure
    // indistinguishable from the caller's perspective.
    return res.status(502).json({ error: 'upstream dependency unavailable' });
  }

  // ---- STEP 2: only now publish. -----------------------------------------
  if (!producerReady) {
    return res.status(503).json({ error: 'kafka producer not ready' });
  }
  try {
    // sku is included in the published payload only when it was supplied —
    // keeps the no-sku message identical to today. inventory ignores unknown
    // fields, so this is forward-compatible.
    const payload = { id, item, qty: qty || 1, at: new Date().toISOString() };
    if (sku) payload.sku = sku;
    await producer.send({
      topic: KAFKA_TOPIC,
      messages: [{ key: String(id), value: JSON.stringify(payload) }],
    });
  } catch (err) {
    return res.status(502).json({ error: 'kafka publish failed', detail: err.message });
  }

  // Response shape unchanged when sku absent — existing tests are sensitive
  // to the exact field set. Only add sku when it was in the request.
  const responseBody = { id, item, qty: qty || 1, status: 'placed' };
  if (sku) responseBody.sku = sku;
  res.status(201).json(responseBody);
});

app.listen(PORT, () => {
  console.log(`[order] listening on :${PORT}`);
  console.log(`[order] auth url    : ${AUTH_URL}`);
  console.log(`[order] catalog url : ${CATALOG_URL} (used only when sku is supplied)`);
  console.log(`[order] kafka       : ${KAFKA_BROKERS.join(',')} topic=${KAFKA_TOPIC}`);
});

process.on('SIGTERM', async () => {
  console.log('[order] shutting down');
  await producer.disconnect().catch(() => {});
  process.exit(0);
});
