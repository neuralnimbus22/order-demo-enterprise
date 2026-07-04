'use strict';

// Consumer contract: order-service -> product-catalog.
// Mirrors the optional sku-validation call order-service makes when a request
// includes a sku (services/order/server.js:69): GET /products/:sku, reading
// product.id and product.name from a 200 response.

const assert = require('node:assert/strict');
const { PactV3, MatchersV3 } = require('@pact-foundation/pact');
const { like, integer } = MatchersV3;
const { pactDir } = require('../config');

const pact = new PactV3({
  consumer: 'order-service',
  provider: 'product-catalog',
  dir: pactDir,
});

describe('order-service -> product-catalog (HTTP)', () => {
  it('resolves a known sku to a product', async () => {
    pact
      .given('product BK-001 exists')
      .uponReceiving('a lookup for product BK-001')
      .withRequest({
        method: 'GET',
        path: '/products/BK-001',
      })
      .willRespondWith({
        status: 200,
        headers: { 'Content-Type': like('application/json') },
        body: {
          id: 'BK-001',
          name: like('Hardcover Notebook'),
          category: like('books'),
          price: like(14.99),
          description: like('200-page lined hardcover notebook.'),
          stock: integer(42),
        },
      });

    await pact.executeTest(async (mock) => {
      const res = await fetch(`${mock.url}/products/BK-001`);
      assert.equal(res.status, 200);
      const product = await res.json();
      // What order-service reads from the response.
      assert.equal(product.id, 'BK-001');
      assert.equal(typeof product.name, 'string');
    });
  });
});
