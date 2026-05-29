// inventory-service — downstream "edge" service.
//
// Phases on the same code path:
//  * Phase 2: subscribes to BOTH `order-placed` and `payment-confirmed`.
//             /processed/:id and /fulfilled/:id report convergence state.
//  * Phase 3: stock lookups go through a Redis read-through cache backed by
//             a Postgres source-of-truth store. "Stale cache" surfaces as
//             DATA_INCONSISTENCY at fulfillment time.
//  * Phase 4: Postgres backing store. Two distinct DB failure signatures:
//             DOWN     — clean connection error on `/db/health`
//             DEGRADED — `/db/health` passes when pool not exhausted; under
//                        load the pool stalls and queries time out (queries
//                        wait for a connection, never time out as "down")
//
// Endpoints:
//   GET  /health                    → 200 liveness (does NOT touch DB)
//   GET  /db/health                 → SELECT 1; distinguishes DB-up vs DB-down
//   GET  /processed/:id             → 200 once order-placed seen, else 404
//   GET  /fulfilled/:id             → convergence state across both topics
//   POST /stock/seed   {sku,qty}    → upsert in Postgres
//   POST /cache/seed   {sku,qty}    → set qty in Redis only (induces stale cache)
//   POST /cache/flush               → drop all stock:* keys
//   GET  /stock/:sku                → cache-aside read; {sku, qty, source:"cache"|"db"}
//   POST /fulfill   {id,sku,qty}    → cache-then-db check; 409 DATA_INCONSISTENCY on stale
//   GET  /consistency/check         → cache vs DB across all known skus
//   POST /db/exhaust  {hold?, n?}   → hold N connections busy for `hold` ms,
//                                      starves the pool to demonstrate DB DEGRADED

const express = require('express');
const { Kafka, logLevel } = require('kafkajs');
const Redis = require('ioredis');
const { Pool } = require('pg');

const PORT            = parseInt(process.env.PORT || '3003', 10);
const KAFKA_BROKERS   = (process.env.KAFKA_BROKERS || 'localhost:9092').split(',');
const ORDER_TOPIC     = process.env.KAFKA_TOPIC          || 'order-placed';
const PAYMENT_TOPIC   = process.env.KAFKA_PAYMENT_TOPIC  || 'payment-confirmed';
const KAFKA_GROUP_ID  = process.env.KAFKA_GROUP_ID       || 'inventory-service';
const REDIS_HOST      = process.env.REDIS_HOST           || 'localhost';
const REDIS_PORT      = parseInt(process.env.REDIS_PORT  || '6379', 10);
const CACHE_TTL_S     = parseInt(process.env.CACHE_TTL_S || '60', 10);
const DB_HOST         = process.env.DB_HOST              || 'localhost';
const DB_PORT         = parseInt(process.env.DB_PORT     || '5432', 10);
const DB_USER         = process.env.DB_USER              || 'inventory';
const DB_PASSWORD     = process.env.DB_PASSWORD          || 'inventory';
const DB_NAME         = process.env.DB_NAME              || 'inventory';
// Small pool intentionally — makes the degraded scenario easy to demonstrate.
const DB_POOL_MAX     = parseInt(process.env.DB_POOL_MAX || '2', 10);
const DB_TIMEOUT_MS   = parseInt(process.env.DB_TIMEOUT_MS || '2000', 10);

const app = express();
app.use(express.json());

// id → { orderPlacedAt?, paymentConfirmedAt? }
const events = new Map();

// --- Postgres pool --------------------------------------------------------
const pool = new Pool({
  host: DB_HOST,
  port: DB_PORT,
  user: DB_USER,
  password: DB_PASSWORD,
  database: DB_NAME,
  max: DB_POOL_MAX,
  connectionTimeoutMillis: DB_TIMEOUT_MS,
  idleTimeoutMillis: 10_000,
});
pool.on('error', (err) => console.error('[inventory] pg pool error:', err.message));

let dbReady = false;
async function initSchema() {
  for (let attempt = 1; attempt <= 30; attempt++) {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS stock (
          sku TEXT PRIMARY KEY,
          qty INTEGER NOT NULL DEFAULT 0
        )
      `);
      dbReady = true;
      console.log('[inventory] postgres schema ready');
      return;
    } catch (err) {
      console.warn(`[inventory] db init attempt ${attempt} failed: ${err.message}`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  console.error('[inventory] gave up initializing db schema');
}
initSchema();

// --- Redis client ---------------------------------------------------------
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

// --- kafka convergence ----------------------------------------------------
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

// DB-aware health. Distinguishes DB-up from DB-down. Uses a short timeout
// so a long pg-pool wait surfaces as a clear timeout rather than hanging
// /db/health forever (the spec wants db-down and db-degraded distinguishable).
app.get('/db/health', async (_req, res) => {
  if (!dbReady) return res.status(503).json({ db: 'not_ready' });
  const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('db_health_timeout')), 1500));
  try {
    await Promise.race([pool.query('SELECT 1'), timeout]);
    res.json({ db: 'ok' });
  } catch (err) {
    res.status(503).json({ db: 'unreachable', detail: err.message });
  }
});

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
async function getDbStock(sku) {
  const r = await pool.query('SELECT qty FROM stock WHERE sku = $1', [sku]);
  return r.rows.length ? r.rows[0].qty : null;
}
async function upsertDbStock(sku, qty) {
  await pool.query(
    `INSERT INTO stock(sku, qty) VALUES($1, $2)
     ON CONFLICT (sku) DO UPDATE SET qty = EXCLUDED.qty`,
    [sku, qty]
  );
}

// --- stock + cache endpoints ----------------------------------------------

app.post('/stock/seed', async (req, res) => {
  const { sku, qty } = req.body || {};
  if (!sku || typeof qty !== 'number') return res.status(400).json({ error: 'sku and numeric qty required' });
  try {
    await upsertDbStock(sku, qty);
    res.json({ sku, qty, source: 'db' });
  } catch (err) {
    res.status(502).json({ error: 'db write failed', detail: err.message });
  }
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
    const dbQty = await getDbStock(sku);
    if (dbQty === null) return res.status(404).json({ sku, error: 'unknown sku' });
    await setCachedStock(sku, dbQty);
    res.json({ sku, qty: dbQty, source: 'db' });
  } catch (err) {
    res.status(502).json({ error: 'stock lookup failed', detail: err.message });
  }
});

app.post('/fulfill', async (req, res) => {
  const { id, sku, qty } = req.body || {};
  if (!id || !sku || typeof qty !== 'number') {
    return res.status(400).json({ error: 'id, sku, numeric qty required' });
  }
  let cacheQty;
  try { cacheQty = await getCachedStock(sku); }
  catch (err) { return res.status(502).json({ error: 'redis lookup failed', detail: err.message }); }

  let dbQty;
  try { dbQty = await getDbStock(sku); }
  catch (err) {
    // DB unreachable / pool starved → clean error, distinct from data mismatch.
    return res.status(503).json({ error: 'db_unavailable', detail: err.message });
  }
  if (dbQty === null) {
    return res.status(404).json({ error: 'unknown sku', sku });
  }

  if (cacheQty !== null && cacheQty !== dbQty) {
    return res.status(409).json({
      error: 'DATA_INCONSISTENCY',
      detail: 'cache and source-of-truth disagree on stock level',
      sku, cacheQty, dbQty,
    });
  }
  if (cacheQty === null) {
    try { await setCachedStock(sku, dbQty); } catch (_) {}
  }
  if (dbQty < qty) {
    return res.status(409).json({ error: 'insufficient_stock', sku, available: dbQty, requested: qty });
  }

  try {
    await upsertDbStock(sku, dbQty - qty);
    try { await setCachedStock(sku, dbQty - qty); } catch (_) {}
    res.json({ id, sku, qty, fulfilled: true, remaining: dbQty - qty });
  } catch (err) {
    res.status(502).json({ error: 'db update failed', detail: err.message });
  }
});

app.get('/consistency/check', async (_req, res) => {
  let rows;
  try {
    rows = (await pool.query('SELECT sku, qty FROM stock')).rows;
  } catch (err) {
    return res.status(502).json({ error: 'db read failed', detail: err.message });
  }
  const mismatches = [];
  const checks = [];
  for (const { sku, qty: dbQty } of rows) {
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

// Active pool exhaustion — induces DB DEGRADED. Spawns N "long" queries
// that each hold a pooled connection for `hold` ms. While these run, the
// pool is saturated and any other query waits, eventually exceeding
// connectionTimeoutMillis.
app.post('/db/exhaust', async (req, res) => {
  const hold = parseInt(req.body?.hold ?? '5000', 10);
  const n    = parseInt(req.body?.n    ?? String(DB_POOL_MAX), 10);
  console.log(`[inventory] /db/exhaust hold=${hold}ms n=${n}`);
  // Fire-and-forget; we just want them holding connections.
  const promises = Array.from({ length: n }, async (_, i) => {
    try {
      await pool.query(`SELECT pg_sleep(${hold / 1000.0})`);
      console.log(`[inventory] /db/exhaust worker ${i} released`);
    } catch (err) {
      console.warn(`[inventory] /db/exhaust worker ${i} error: ${err.message}`);
    }
  });
  Promise.allSettled(promises); // do not await — return to caller immediately
  res.json({ started: n, hold });
});

// --- kafka consumer (unchanged) -------------------------------------------

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
  console.log(`[inventory] db     : ${DB_HOST}:${DB_PORT}/${DB_NAME} pool=${DB_POOL_MAX} timeout=${DB_TIMEOUT_MS}ms`);
});

process.on('SIGTERM', async () => {
  console.log('[inventory] shutting down');
  await consumer.disconnect().catch(() => {});
  await redis.quit().catch(() => {});
  await pool.end().catch(() => {});
  process.exit(0);
});
