'use strict';

// Base-URL resolution for PROVIDER verification. Same convention as the BDD
// suite: an env var wins; otherwise the in-cluster FQDN default (order-demo
// namespace). Override to localhost for `kubectl port-forward` runs.
//
//   AUTH_URL              default http://auth.order-demo.svc.cluster.local:3001
//   PRODUCT_CATALOG_URL   default http://product-catalog.order-demo.svc.cluster.local:3005
//   (CATALOG_URL is accepted as an alias — it's the env name order-service uses)

const path = require('path');

function resolve(value, fallback) {
  return value && value.trim() ? value.trim().replace(/\/+$/, '') : fallback;
}

module.exports = {
  authUrl: resolve(process.env.AUTH_URL, 'http://auth.order-demo.svc.cluster.local:3001'),
  catalogUrl: resolve(
    process.env.PRODUCT_CATALOG_URL || process.env.CATALOG_URL,
    'http://product-catalog.order-demo.svc.cluster.local:3005'
  ),
  pactDir: path.resolve(__dirname, 'pacts'),
};
