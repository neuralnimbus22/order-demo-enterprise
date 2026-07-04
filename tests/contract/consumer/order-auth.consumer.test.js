'use strict';

// Consumer contract: order-service -> auth-service.
// Mirrors the real call order-service makes before publishing an order
// (services/order/server.js:93): POST /authorize with the token as a Bearer
// header AND in the body, refusing the order unless the response says
// authorized === true.

const assert = require('node:assert/strict');
const { PactV3, MatchersV3 } = require('@pact-foundation/pact');
const { like, eachLike } = MatchersV3;
const { pactDir } = require('../config');

const AUTH_TOKEN = 'demo-token-good';

const pact = new PactV3({
  consumer: 'order-service',
  provider: 'auth-service',
  dir: pactDir,
});

describe('order-service -> auth-service (HTTP)', () => {
  it('authorizes an order when the token is valid', async () => {
    pact
      .given('token demo-token-good is valid with orders:create scope')
      .uponReceiving('an authorization request for an order')
      .withRequest({
        method: 'POST',
        path: '/authorize',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${AUTH_TOKEN}`,
        },
        body: { orderId: like('order-abc-123'), token: AUTH_TOKEN },
      })
      .willRespondWith({
        status: 200,
        headers: { 'Content-Type': like('application/json') },
        body: { authorized: true, scope: eachLike('orders:create') },
      });

    await pact.executeTest(async (mock) => {
      const res = await fetch(`${mock.url}/authorize`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${AUTH_TOKEN}`,
        },
        body: JSON.stringify({ orderId: 'order-abc-123', token: AUTH_TOKEN }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      // The one field order-service actually branches on.
      assert.equal(body.authorized, true);
    });
  });
});
