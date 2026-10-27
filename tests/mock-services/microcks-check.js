// order-service against Microcks mocks of auth-service and product-catalog,
// then a Microcks async contract test of the order-placed event against
// contracts/order-placed.asyncapi.yaml.

const fs = require('fs');
const path = require('path');
const { KAFKA_BROKERS, KAFKA_TOPIC, sleep, ensureTopic, placeOrder, runSuite } = require('./common');

const MICROCKS_URL  = process.env.MICROCKS_URL || 'http://localhost:8080';
const CONTRACTS_DIR = process.env.CONTRACTS_DIR || path.join(__dirname, '../../contracts');
const CONTRACTS     = ['auth-service.openapi.yaml', 'product-catalog.openapi.yaml', 'order-placed.asyncapi.yaml'];
const EVENT_SERVICE = 'order-placed:1.0.0';

const orderId = `order-${Date.now()}`;

async function microcks(method, route, body) {
  const res = await fetch(`${MICROCKS_URL}${route}`, { method, body });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${route} → ${res.status} ${text}`);
  try { return JSON.parse(text); } catch { return text; }
}

async function importContract(file) {
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(path.join(CONTRACTS_DIR, file))]), file);
  return microcks('POST', '/api/artifact/upload?mainArtifact=true', form);
}

// Start a Microcks ASYNC_API_SCHEMA test and wait for its verdict. The per-run
// broker is fresh, so startOffset=0 reads every event this run produced.
async function runEventContractTest() {
  const endpoint = `kafka://${KAFKA_BROKERS[0]}/${KAFKA_TOPIC}?startOffset=0`;
  const spec = JSON.stringify({ serviceId: EVENT_SERVICE, testEndpoint: endpoint, runnerType: 'ASYNC_API_SCHEMA', timeout: 10000 });
  const res = await fetch(`${MICROCKS_URL}/api/tests`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: spec });
  if (!res.ok) throw new Error(`could not start the Microcks test: ${res.status} ${await res.text()}`);
  const { id } = await res.json();
  for (let i = 0; i < 60; i++) {
    await sleep(2000);
    const result = await microcks('GET', `/api/tests/${id}`);
    if (!result.inProgress) return { id, result };
  }
  throw new Error(`Microcks test ${id} still in progress after 120 s`);
}

function describeFailure(result) {
  const steps = (result.testCaseResults || []).flatMap((c) =>
    (c.testStepResults || []).filter((s) => !s.success).map((s) => `${c.operationName}: ${s.message}`));
  return steps.length ? steps.join(' | ') : 'no step detail returned';
}

runSuite('mock-services-microcks', [
  {
    name: 'import the three contracts into Microcks',
    stopOnFail: true,
    fn: async () => {
      for (const file of CONTRACTS) await importContract(file);
      return CONTRACTS.join(', ');
    },
  },
  {
    name: 'POST /orders with sku BK-001 returns 201 through the Microcks mocks',
    stopOnFail: true,
    fn: async () => {
      await ensureTopic();
      const { status, body } = await placeOrder({ id: orderId, qty: 2, sku: 'BK-001' });
      if (status !== 201) throw new Error(`expected 201, got ${status} ${JSON.stringify(body)}`);
      if (body.item !== 'Hardcover Notebook') throw new Error(`item not filled from the catalog mock: ${JSON.stringify(body)}`);
      return JSON.stringify(body);
    },
  },
  {
    name: `order-placed event matches the AsyncAPI contract ${EVENT_SERVICE} (Microcks async test)`,
    fn: async () => {
      const { id, result } = await runEventContractTest();
      if (!result.success) {
        throw new Error(`order-placed contract (${EVENT_SERVICE}) violated, Microcks test ${id}: ${describeFailure(result)}`);
      }
      return `Microcks test ${id} passed`;
    },
  },
]).then((ok) => process.exit(ok ? 0 : 1));
