// order-service against Prism mocks of auth-service and product-catalog.
// Checks that an order with a sku is placed and that its event reaches
// order-placed. Prism mocks REST only, so the event payload is not checked
// against any contract here: the event is matched by its Kafka key.

const { KAFKA_TOPIC, ensureTopic, waitForEvent, placeOrder, runSuite } = require('./common');

const orderId = `order-${Date.now()}`;
let eventWait;

runSuite('mock-services-prism', [
  {
    name: `create topic ${KAFKA_TOPIC}`,
    stopOnFail: true,
    fn: async () => {
      await ensureTopic();
      eventWait = waitForEvent(orderId, 30000);
      eventWait.catch(() => {});
    },
  },
  {
    name: 'POST /orders with sku BK-001 returns 201 through the Prism mocks',
    stopOnFail: true,
    fn: async () => {
      const { status, body } = await placeOrder({ id: orderId, qty: 2, sku: 'BK-001' });
      if (status !== 201) throw new Error(`expected 201, got ${status} ${JSON.stringify(body)}`);
      if (body.item !== 'Hardcover Notebook') throw new Error(`item not filled from the catalog mock: ${JSON.stringify(body)}`);
      return JSON.stringify(body);
    },
  },
  {
    name: `order-placed event for the order reached ${KAFKA_TOPIC}`,
    fn: async () => (await eventWait).value,
  },
]).then((ok) => process.exit(ok ? 0 : 1));
