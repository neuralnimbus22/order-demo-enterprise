// order-load.js — k6 load test driving sustained POST /orders traffic at the
// order service. Designed to push order-service CPU usage high enough that a
// Horizontal Pod Autoscaler on the deployment will scale it out.
//
// Profile:  ramp 0→50 VUs over 1m, hold 50 VUs for 3m, ramp down to 0 over 1m.
// SLOs   :  p95 latency < 800ms, request failure rate < 5%.
//
// Each iteration posts a unique-id order so the consumer doesn't deduplicate
// or hot-spot on a single key.
//
// Standalone run:
//   ORDER_URL=http://localhost:3002 k6 run tests/load/order-load.js

import http from 'k6/http';
import { sleep } from 'k6';

const BASE = __ENV.ORDER_URL || 'http://localhost:3002';

export const options = {
  stages: [
    { duration: '30s', target: 500 },
    { duration: '2m', target: 500 },
    { duration: '30s', target: 0 },
  ],
  thresholds: {
    http_req_duration: ['p(95)<800'],
    http_req_failed: ['rate<0.05'],
  },
};

export default function () {
  // Unique per (VU, iteration, wall-clock) so every request creates a fresh
  // order id — avoids any consumer-side dedup confusing the load profile.
  const id = `load-vu${__VU}-it${__ITER}-${Date.now()}`;
  const body = JSON.stringify({ id, item: 'widget', qty: 1 });

  http.post(`${BASE}/orders`, body, {
    headers: { 'Content-Type': 'application/json' },
  });

  sleep(0.1);
}
