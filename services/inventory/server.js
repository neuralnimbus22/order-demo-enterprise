// inventory-service — downstream "edge" service.
//
// Phases on the same code path:
//  * Phase 2: subscribes to BOTH `order-placed` and `payment-confirmed`.
//             /processed/:id and /fulfilled/:id report convergence state.
//  * Phase 3: stock lookups go through a Redis read-through cache backed by a
//             source-of-truth stock store. The "stale cache" failure surfaces
//             as a DATA_INCONSISTENCY error at fulfillment time — distinct
//             from any connectivity or missing-message failure.
//  * Phase 4 (later): swap the in-process stock store for Postgres.
//
// Endpoints:
//   GET  /health                    → 200 liveness
//   GET  /processed/:id             → 200 once order-placed seen, else 404
//   GET  /fulfilled/:id             → convergence state across both topics
//   POST /stock/seed   {sku,qty}    → set qty in the source-of-truth store
//   POST /cache/seed   {sku,qty}    → set qty in Redis ONLY (used to induce stale cache)
//   POST /cache/flush               → drop all stock:* keys in Redis
//   GET  /stock/:sku                → cache-aside read; {sku, qty, source:"cache"|"db"}
//   POST /fulfill   {id,sku,qty}    → cache-then-db check; returns
//                                       200 fulfilled OR 409 DATA_INCONSISTENCY on stale cache
//   GET  /consistency/check         → compares cache vs DB for every known sku

const express = require('express');
const { Kafka, logLevel } = require('kafkajs');
const Redis = require('ioredis');

const PORT            = parseInt(process.env.PORT || '3003', 10);
const KAFKA_BROKERS   = (process.env.KAFKA_BROKERS || 'localhost:9092').split(',');
const ORDER_TOPIC     = process.env.KAFKA_TOPIC          || 'order-placed';
const PAYMENT_TOPIC   = process.env.KAFKA_PAYMENT_TOPIC  || 'payment-confirmed';
const KAFKA_GROUP_ID  = process.env.KAFKA_GROUP_ID       || 'inventory-service';
const REDIS_HOST      = process.env.REDIS_HOST           || 'localhost';
const REDIS_PORT      = parseInt(process.env.REDIS_PORT  || '6379', 10);
const CACHE_TTL_S     = parseInt(process.env.CACHE_TTL_S || '60', 10);

const app = express();
app.use(express.json());

// id → { orderPlacedAt?, paymentConfirmedAt? }
const events = new Map();
// Source-of-truth stock store (Phase 4 will swap this for Postgres).
const stockDb = new Map();

const redis = new Redis({
  host: REDIS_HOST,
  port: REDIS_PORT,
  lazyConnect: false,
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
});
let redisReady = false;
redis.on('ready', () => { redisReady = true; console.log('[inventory] redis connected'); });
redis.on('error', (err) => console.error('[inventory] redis error:', err.message));

function record(id, key, ts) {
  const cur = events.get(id) || {};
  cur[key] = ts;
  events.set(id, cur);
}
function fulfillmentState(id) {
  const e = events.get(id);
  if (!e) return null;
  const haveOrder = !!e.orderPlacedAt;
  const havePay   = !!e.paymentConfirmedAt;
  const waitingFor = [];
  if (!haveOrder) waitingFor.push('order-placed');
  if (!havePay)   waitingFor.push('payment-confirmed');
  return {
    id,
    orderPlaced:      haveOrder ? e.orderPlacedAt      : null,
    paymentConfirmed: havePay   ? e.paymentConfirmedAt : null,
    fulfilled: haveOrder && havePay,
    waitingFor,
  };
}

// --- HTTP routes ----------------------------------------------------------

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.get('/processed/:id', (req, res) => {
  const e = events.get(req.params.id);
  if (e && e.orderPlacedAt) return res.json({ id: req.params.id, processed: true, processedAt: e.orderPlacedAt });
  res.status(404).json({ id: req.params.id, processed: false });
});

app.get('/fulfilled/:id', (req, res) => {
  const s = fulfillmentState(req.params.id);
  if (!s) return res.status(404).json({ id: req.params.id, fulfilled: false, waitingFor: ['order-placed', 'payment-confirmed'] });
  res.status(200).json(s);
});

// --- stock store helpers --------------------------------------------------

async function getCachedStock(sku) {
  if (!redisReady) return null;
  const v = await redis.get(`stock:${sku}`);
  return v === null ? null : parseInt(v, 10);
}
async function setCachedStock(sku, qty) {
  if (!redisReady) return;
  await redis.set(`stock:${sku}`, String(qty), 'EX', CACHE_TTL_S);
}
function getDbStock(sku) {
  return stockDb.has(sku) ? stockDb.get(sku) : null;
}

// --- stock + cache endpoints ----------------------------------------------

app.post('/stock/seed', (req, res) => {
  const { sku, qty } = req.body || {};
  if (!sku || typeof qty !== 'number') return res.status(400).json({ error: 'sku and numeric qty required' });
  stockDb.set(sku, qty);
  res.json({ sku, qty, source: 'db' });
});

app.post('/cache/seed', async (req, res) => {
  const { sku, qty } = req.body || {};
  if (!sku || typeof qty !== 'number') return res.status(400).json({ error: 'sku and numeric qty required' });
  try {
    await setCachedStock(sku, qty);
    res.json({ sku, qty, source: 'cache' });
  } catch (err) {
    res.status(502).json({ error: 'redis write failed', detail: err.message });
  }
});

app.post('/cache/flush', async (_req, res) => {
  if (!redisReady) return res.status(503).json({ error: 'redis not ready' });
  try {
    const keys = await redis.keys('stock:*');
    if (keys.length) await redis.del(...keys);
    res.json({ flushed: keys.length });
  } catch (err) {
    res.status(502).json({ error: 'redis flush failed', detail: err.message });
  }
});

app.get('/stock/:sku', async (req, res) => {
  const sku = req.params.sku;
  try {
    const cached = await getCachedStock(sku);
    if (cached !== null) return res.json({ sku, qty: cached, source: 'cache' });
    const dbQty = getDbStock(sku);
    if (dbQty === null) return res.status(404).json({ sku, error: 'unknown sku' });
    await setCachedStock(sku, dbQty);
    res.json({ sku, qty: dbQty, source: 'db' });
  } catch (err) {
    res.status(502).json({ error: 'stock lookup failed', detail: err.message });
  }
});

// Fulfill an order against stock. Cache-then-DB-verify so stale cache surfaces
// as a clean DATA_INCONSISTENCY response (not a connection error, not a
// missing-message error).
app.post('/fulfill', async (req, res) => {
  const { id, sku, qty } = req.body || {};
  if (!id || !sku || typeof qty !== 'number') {
    return res.status(400).json({ error: 'id, sku, numeric qty required' });
  }
  let cacheQty;
  try { cacheQty = await getCachedStock(sku); }
  catch (err) { return res.status(502).json({ error: 'redis lookup failed', detail: err.message }); }

  const dbQty = getDbStock(sku);
  if (dbQty === null) {
    return res.status(404).json({ error: 'unknown sku', sku });
  }

  // The deceptive failure: cache says we have stock, DB disagrees.
  if (cacheQty !== null && cacheQty !== dbQty) {
    return res.status(409).json({
      error: 'DATA_INCONSISTENCY',
      detail: 'cache and source-of-truth disagree on stock level',
      sku,
      cacheQty,
      dbQty,
    });
  }

  // If cache had no entry, populate it from DB then proceed.
  if (cacheQty === null) {
    try { await setCachedStock(sku, dbQty); } catch (_) {}
  }

  if (dbQty < qty) {
    return res.status(409).json({ error: 'insufficient_stock', sku, available: dbQty, requested: qty });
  }

  stockDb.set(sku, dbQty - qty);
  try { await setCachedStock(sku, dbQty - qty); } catch (_) {}
  res.json({ id, sku, qty, fulfilled: true, remaining: dbQty - qty });
});

// Cache-vs-DB consistency check. Pure read; for every known sku in DB,
// report whether cache agrees or diverges.
app.get('/consistency/check', async (_req, res) => {
  const mismatches = [];
  const checks = [];
  for (const [sku, dbQty] of stockDb.entries()) {
    let cacheQty = null;
    try { cacheQty = await getCachedStock(sku); } catch (_) {}
    const item = { sku, dbQty, cacheQty, agree: cacheQty === null || cacheQty === dbQty };
    checks.push(item);
    if (!item.agree) mismatches.push(item);
  }
  res.status(mismatches.length ? 409 : 200).json({
    consistent: mismatches.length === 0,
    mismatches,
    checked: checks.length,
    details: checks,
  });
});

// --- kafka consumer (unchanged from Phase 2) ------------------------------

const kafka = new Kafka({
  clientId: 'inventory-service',
  brokers: KAFKA_BROKERS,
  logLevel: logLevel.WARN,
});
const consumer = kafka.consumer({ groupId: KAFKA_GROUP_ID });

async function startConsumer() {
  await consumer.connect();
  console.log('[inventory] kafka consumer connected');
  await consumer.subscribe({ topic: ORDER_TOPIC,   fromBeginning: true });
  await consumer.subscribe({ topic: PAYMENT_TOPIC, fromBeginning: true });
  await consumer.run({
    eachMessage: async ({ topic, message }) => {
      const payload = JSON.parse(message.value.toString());
      const id = String(payload.id);
      const ts = new Date().toISOString();
      if (topic === ORDER_TOPIC) {
        record(id, 'orderPlacedAt', ts);
        console.log(`[inventory] order-placed   id=${id}`);
      } else if (topic === PAYMENT_TOPIC) {
        record(id, 'paymentConfirmedAt', ts);
        console.log(`[inventory] payment-confirmed id=${id}`);
      }
      const s = fulfillmentState(id);
      if (s && s.fulfilled) console.log(`[inventory] FULFILLED id=${id}`);
    },
  });
}
startConsumer().catch((err) => console.error('[inventory] consumer failed to start:', err.message));

app.listen(PORT, () => {
  console.log(`[inventory] listening on :${PORT}`);
  console.log(`[inventory] kafka  : ${KAFKA_BROKERS.join(',')}`);
  console.log(`[inventory] topics : ${ORDER_TOPIC}, ${PAYMENT_TOPIC} group=${KAFKA_GROUP_ID}`);
  console.log(`[inventory] redis  : ${REDIS_HOST}:${REDIS_PORT} ttl=${CACHE_TTL_S}s`);
});

process.on('SIGTERM', async () => {
  console.log('[inventory] shutting down');
  await consumer.disconnect().catch(() => {});
  await redis.quit().catch(() => {});
  process.exit(0);
});
