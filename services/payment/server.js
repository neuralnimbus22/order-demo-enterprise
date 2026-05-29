// payment-service — confirms a payment for an order id and publishes a
// `payment-confirmed` event to Kafka. Sits in parallel with order-service:
// inventory needs BOTH `order-placed` AND `payment-confirmed` for the same id
// before it can fulfill.
//
// Endpoints:
//   GET  /health   → 200 {status:"ok"}
//   POST /payments → body {id, amount?}. Publishes payment-confirmed for id.
//                    Returns 201 with {id, status:"confirmed"}.

const express = require('express');
const { Kafka, logLevel } = require('kafkajs');

const PORT          = parseInt(process.env.PORT || '3004', 10);
const KAFKA_BROKERS = (process.env.KAFKA_BROKERS || 'localhost:9092').split(',');
const KAFKA_TOPIC   = process.env.KAFKA_TOPIC   || 'payment-confirmed';

const app = express();
app.use(express.json());

const kafka = new Kafka({
  clientId: 'payment-service',
  brokers: KAFKA_BROKERS,
  logLevel: logLevel.WARN,
});
const producer = kafka.producer();

let producerReady = false;
producer.connect()
  .then(() => { producerReady = true; console.log('[payment] kafka producer connected'); })
  .catch((err) => console.error('[payment] kafka producer connect failed:', err.message));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.post('/payments', async (req, res) => {
  const { id, amount } = req.body || {};
  if (!id) {
    return res.status(400).json({ error: 'id is required' });
  }

  if (!producerReady) {
    return res.status(503).json({ error: 'kafka producer not ready' });
  }
  try {
    await producer.send({
      topic: KAFKA_TOPIC,
      messages: [{
        key: String(id),
        value: JSON.stringify({
          id,
          amount: typeof amount === 'number' ? amount : 0,
          confirmedAt: new Date().toISOString(),
        }),
      }],
    });
  } catch (err) {
    return res.status(502).json({ error: 'kafka publish failed', detail: err.message });
  }

  res.status(201).json({ id, status: 'confirmed' });
});

app.listen(PORT, () => {
  console.log(`[payment] listening on :${PORT}`);
  console.log(`[payment] kafka  : ${KAFKA_BROKERS.join(',')} topic=${KAFKA_TOPIC}`);
});

process.on('SIGTERM', async () => {
  console.log('[payment] shutting down');
  await producer.disconnect().catch(() => {});
  process.exit(0);
});
