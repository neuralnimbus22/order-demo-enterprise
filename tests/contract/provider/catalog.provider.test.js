'use strict';

// Provider verification: replay the order-service -> product-catalog pact
// against the LIVE product-catalog. Base URL from PRODUCT_CATALOG_URL /
// CATALOG_URL (in-cluster FQDN default; override to localhost for a
// port-forward run).

const path = require('path');
const { Verifier } = require('@pact-foundation/pact');
const { catalogUrl } = require('../config');

describe('product-catalog provider verification', () => {
  it('honours the order-service contract', async function () {
    this.timeout(60000);
    await new Verifier({
      provider: 'product-catalog',
      providerBaseUrl: catalogUrl,
      pactUrls: [path.resolve(__dirname, '..', 'pacts', 'order-service-product-catalog.json')],
      // BK-001 is part of product-catalog's idempotent seed, so the state needs
      // no setup — declaring it silences the verifier warning.
      stateHandlers: {
        'product BK-001 exists': async () => {},
      },
    }).verifyProvider();
  });
});
