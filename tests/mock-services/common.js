// Shared helpers for the mock-services checks: place an order through a
// running order-service, watch Kafka, and write a JUnit report.

const fs = require('fs');
const path = require('path');
const { Kafka, logLevel } = require('kafkajs');

const ORDER_URL     = process.env.ORDER_URL     || 'http://localhost:3002';
const KAFKA_BROKERS = (process.env.KAFKA_BROKERS || 'localhost:9092').split(',');
const KAFKA_TOPIC   = process.env.KAFKA_TOPIC   || 'order-placed';
const REPORT_DIR    = process.env.REPORT_DIR    || 'target/mock-services';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const kafka = new Kafka({ clientId: 'mock-services-check', brokers: KAFKA_BROKERS, logLevel: logLevel.WARN });

// Create the topic up front so the consumer and order-service never race auto-create.
async function ensureTopic() {
  const admin = kafka.admin();
  await admin.connect();
  await admin.createTopics({ topics: [{ topic: KAFKA_TOPIC, numPartitions: 1 }], waitForLeaders: true });
  await admin.disconnect();
}

// Resolve with the first message whose key is `key`, or reject after `timeoutMs`.
async function waitForEvent(key, timeoutMs) {
  const consumer = kafka.consumer({ groupId: `mock-services-check-${Date.now()}` });
  await consumer.connect();
  await consumer.subscribe({ topic: KAFKA_TOPIC, fromBeginning: true });
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no ${KAFKA_TOPIC} event with key ${key} in ${timeoutMs} ms`)), timeoutMs);
      consumer.run({
        eachMessage: async ({ message }) => {
          if (message.key && message.key.toString() === key) {
            clearTimeout(timer);
            resolve({ key, value: message.value.toString() });
          }
        },
      }).catch(reject);
    });
  } finally {
    await consumer.disconnect().catch(() => {});
  }
}

// order-service answers 503 until its Kafka producer connects, so retry until
// it gives a real answer.
async function placeOrder(order, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  let last = 'order-service not reachable';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${ORDER_URL}/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(order),
      });
      const body = await res.json().catch(() => ({}));
      if (res.status !== 503) return { status: res.status, body };
      last = `503 ${JSON.stringify(body)}`;
    } catch (err) {
      last = err.message;
    }
    await sleep(2000);
  }
  throw new Error(`order-service never answered: ${last}`);
}

// Run named checks in order, print each result and write one JUnit file.
// A check throws to fail; later checks still run unless `stopOnFail` is set.
async function runSuite(suiteName, checks) {
  const results = [];
  let blocked = null;
  for (const { name, fn, stopOnFail } of checks) {
    const started = Date.now();
    if (blocked) {
      results.push({ name, seconds: 0, skipped: `skipped because "${blocked}" failed` });
      console.log(`SKIP  ${name}`);
      continue;
    }
    try {
      const detail = await fn();
      results.push({ name, seconds: (Date.now() - started) / 1000 });
      console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`);
    } catch (err) {
      results.push({ name, seconds: (Date.now() - started) / 1000, failure: err.message });
      console.log(`FAIL  ${name} — ${err.message}`);
      if (stopOnFail) blocked = name;
    }
  }
  writeJUnit(suiteName, results);
  return results.every((r) => !r.failure && !r.skipped);
}

function writeJUnit(suiteName, results) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const failures = results.filter((r) => r.failure).length;
  const skipped = results.filter((r) => r.skipped).length;
  const total = results.reduce((s, r) => s + r.seconds, 0).toFixed(3);
  const cases = results.map((r) => {
    const open = `    <testcase classname="${esc(suiteName)}" name="${esc(r.name)}" time="${r.seconds.toFixed(3)}"`;
    if (r.failure) return `${open}>\n      <failure message="${esc(r.failure)}">${esc(r.failure)}</failure>\n    </testcase>`;
    if (r.skipped) return `${open}>\n      <skipped message="${esc(r.skipped)}"/>\n    </testcase>`;
    return `${open}/>`;
  });
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites tests="${results.length}" failures="${failures}" skipped="${skipped}" time="${total}">`,
    `  <testsuite name="${esc(suiteName)}" tests="${results.length}" failures="${failures}" skipped="${skipped}" time="${total}">`,
    ...cases,
    '  </testsuite>',
    '</testsuites>',
    '',
  ].join('\n');
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const file = path.join(REPORT_DIR, `${suiteName}.xml`);
  fs.writeFileSync(file, xml);
  console.log(`JUnit report: ${file}`);
}

module.exports = { KAFKA_BROKERS, KAFKA_TOPIC, sleep, ensureTopic, waitForEvent, placeOrder, runSuite };
