'use strict';

// Provider verification: replay the order-service -> auth-service pact against
// the LIVE auth-service. Base URL from AUTH_URL (in-cluster FQDN default;
// override to localhost for a port-forward run).

const path = require('path');
const { Verifier } = require('@pact-foundation/pact');
const { authUrl } = require('../config');

describe('auth-service provider verification', () => {
  it('honours the order-service contract', async function () {
    this.timeout(60000);
    await new Verifier({
      provider: 'auth-service',
      providerBaseUrl: authUrl,
      pactUrls: [path.resolve(__dirname, '..', 'pacts', 'order-service-auth-service.json')],
      // auth-service validates a static token catalogue with no setup endpoint,
      // so the state is a no-op; declaring it keeps the verifier from warning.
      stateHandlers: {
        'token demo-token-good is valid with orders:create scope': async () => {},
      },
    }).verifyProvider();
  });
});
