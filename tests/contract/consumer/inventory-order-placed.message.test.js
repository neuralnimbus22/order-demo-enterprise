'use strict';

// Message contract: inventory-service consumes the `order-placed` Kafka event
// produced by order-service. inventory needs both order-placed AND
// payment-confirmed for one id to fulfill; this pins the order-placed half.
//
// The event schema is derived from the producer payload
// (services/order/server.js:130): { id, item, qty, at, sku? }. Topic
// `order-placed` and the order->inventory relationship are documented in
// ARCHITECTURE.md.
//
// APP-CODE GAP (intentional, not fixed): inventory's Kafka handler is an inline
// anonymous `eachMessage` closure (services/inventory/server.js:331) and is NOT
// exported, so this test cannot import the production handler. Per the "no
// app-code changes" rule, the handler below is a faithful local mirror of what
// inventory actually does with a message: JSON is already parsed by Pact, and
// inventory only reads `id` (it stringifies it to track convergence). This
// verifies the schema contract, not the production handler binary. See README.

const assert = require('node:assert/strict');
const { MessageConsumerPact, synchronousBodyHandler, MatchersV3 } = require('@pact-foundation/pact');
const { like, integer } = MatchersV3;
const { pactDir } = require('../config');

// Local mirror of inventory-service's eachMessage logic for order-placed.
function handleOrderPlaced(body) {
  const id = String(body.id);
  if (!id || id === 'undefined' || id === 'null') {
    throw new Error('order-placed event has no usable id — inventory cannot track convergence');
  }
  return { recordedId: id };
}

const messagePact = new MessageConsumerPact({
  consumer: 'inventory-service',
  provider: 'order-service',
  dir: pactDir,
});

describe('inventory-service <- order-placed (Kafka message)', () => {
  it('can process an order-placed event', () => {
    return messagePact
      .expectsToReceive('an order-placed event')
      .withContent({
        id: like('order-abc-123'),
        item: like('widget'),
        qty: integer(1),
        at: like('2026-07-04T15:51:20.164Z'),
      })
      .withMetadata({
        contentType: 'application/json',
        kafka_topic: 'order-placed',
      })
      .verify(synchronousBodyHandler((body) => {
        const result = handleOrderPlaced(body);
        assert.equal(result.recordedId, String(body.id));
      }));
  });
});
