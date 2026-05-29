// inventory-service — downstream "edge" service. Now multi-topic-aware:
// fulfillment requires BOTH `order-placed` AND `payment-confirmed` for the
// same id. The first message of either kind alone is NOT enough.
//
// In-process the service runs concurrently:
//   * an HTTP server exposing /health, /processed/:id, /fulfilled/:id
//   * a kafkajs consumer subscribed to BOTH topics
//
// Endpoints:
//   GET /health         → 200
//   GET /processed/:id  → 200 once order-placed seen, else 404
//   GET /fulfilled/:id  → 200 once BOTH topics seen (with timestamps),
//                          200 with waitingFor:[…] if only one has arrived,
//                          404 if neither yet.

const express = require('express');
const { Kafka, logLevel } = require('kafkajs');

const PORT           = parseInt(process.env.PORT || '3003', 10);
const KAFKA_BROKERS  = (process.env.KAFKA_BROKERS || 'localhost:9092').split(',');
const ORDER_TOPIC    = process.env.KAFKA_TOPIC          || 'order-placed';
const PAYMENT_TOPIC  = process.env.KAFKA_PAYMENT_TOPIC  || 'payment-confirmed';
const KAFKA_GROUP_ID = process.env.KAFKA_GROUP_ID       || 'inventory-service';

const app = express();

// id → { orderPlacedAt?, paymentConfirmedAt? }
const events = new Map();

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

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// Legacy single-topic endpoint — still useful (Phase 1 tests target this).
app.get('/processed/:id', (req, res) => {
  const id = req.params.id;
  const e = events.get(id);
  if (e && e.orderPlacedAt) {
    return res.json({ id, processed: true, processedAt: e.orderPlacedAt });
  }
  res.status(404).json({ id, processed: false });
});

// Phase 2 endpoint — true convergence point.
app.get('/fulfilled/:id', (req, res) => {
  const s = fulfillmentState(req.params.id);
  if (!s) return res.status(404).json({ id: req.params.id, fulfilled: false, waitingFor: ['order-placed', 'payment-confirmed'] });
  res.status(200).json(s);
});

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
      if (s && s.fulfilled) {
        console.log(`[inventory] FULFILLED id=${id}`);
      }
    },
  });
}

startConsumer().catch((err) => {
  console.error('[inventory] consumer failed to start:', err.message);
});

app.listen(PORT, () => {
  console.log(`[inventory] listening on :${PORT}`);
  console.log(`[inventory] kafka   : ${KAFKA_BROKERS.join(',')}`);
  console.log(`[inventory] topics  : ${ORDER_TOPIC}, ${PAYMENT_TOPIC} group=${KAFKA_GROUP_ID}`);
});

process.on('SIGTERM', async () => {
  console.log('[inventory] shutting down');
  await consumer.disconnect().catch(() => {});
  process.exit(0);
});
