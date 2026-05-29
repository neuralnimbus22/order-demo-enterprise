// order-service — middle of the chain. Real, non-fakeable dependencies:
//
//   1. EVERY /orders request first calls auth-service /authorize over real HTTP.
//      If that call fails (network error, timeout, non-2xx, or authorized!=true)
//      we MUST refuse the order and MUST NOT publish anything to Kafka.
//
//   2. ONLY after auth says yes do we publish "order-placed" to Kafka.
//      If publish itself fails we also return an error.
//
// This honesty is the whole point — when auth is down, no message ever reaches
// the topic, so inventory's downstream test will genuinely time out.

const express = require('express');
const { Kafka, logLevel } = require('kafkajs');

const PORT          = parseInt(process.env.PORT || '3002', 10);
const AUTH_URL      = process.env.AUTH_URL      || 'http://localhost:3001';
const AUTH_TOKEN    = process.env.AUTH_TOKEN    || 'demo-token-good';
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
  const { id, item, qty } = req.body || {};
  if (!id || !item) {
    return res.status(400).json({ error: 'id and item are required' });
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
    await producer.send({
      topic: KAFKA_TOPIC,
      messages: [{
        key: String(id),
        value: JSON.stringify({ id, item, qty: qty || 1, at: new Date().toISOString() }),
      }],
    });
  } catch (err) {
    return res.status(502).json({ error: 'kafka publish failed', detail: err.message });
  }

  res.status(201).json({ id, item, qty: qty || 1, status: 'placed' });
});

app.listen(PORT, () => {
  console.log(`[order] listening on :${PORT}`);
  console.log(`[order] auth url    : ${AUTH_URL}`);
  console.log(`[order] kafka       : ${KAFKA_BROKERS.join(',')} topic=${KAFKA_TOPIC}`);
});

process.on('SIGTERM', async () => {
  console.log('[order] shutting down');
  await producer.disconnect().catch(() => {});
  process.exit(0);
});
