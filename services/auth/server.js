// auth-service — authorizes order requests by validating a Bearer token
// and the scopes it carries.
//
// Endpoints:
//   GET  /health     → 200 {status:"ok"}   liveness (always responds when up)
//   POST /authorize  → validates the token in the request body or Authorization header
//                       valid + sufficient scope → 200 {authorized:true,scope:[…]}
//                       missing / unknown token   → 401 {error:"invalid_token"}
//                       known token, wrong scope  → 403 {error:"insufficient_scope"}
//
// Configuration:
//   AUTH_REQUIRED_SCOPE — scope a token must carry to authorize an order.
//   AUTH_DEGRADED_MS    — if set > 0, every /authorize waits this many ms
//                         before responding. Used for latency testing.
//
// Tokens are a small static catalogue mapped to scopes, defined below.

const express = require('express');

const PORT             = parseInt(process.env.PORT || '3001', 10);
const DEGRADED_MS      = parseInt(process.env.AUTH_DEGRADED_MS || '0', 10);
const REQUIRED_SCOPE   = process.env.AUTH_REQUIRED_SCOPE || 'orders:create';

// Token → scopes. Static catalogue; an identity provider would replace this.
const TOKENS = {
  'demo-token-good':     ['orders:create'],
  'demo-token-readonly': ['orders:read'],
};

const app = express();
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.post('/authorize', async (req, res) => {
  // Degraded mode: artificial delay BEFORE responding so health stays fast
  // but functional callers time out. Distinguishable from DOWN (which gives
  // connection refused) and REJECT (which returns 401/403 promptly).
  if (DEGRADED_MS > 0) {
    await new Promise((r) => setTimeout(r, DEGRADED_MS));
  }

  const headerToken = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim();
  const bodyToken   = (req.body && req.body.token) || '';
  const token       = headerToken || bodyToken;

  if (!token || !TOKENS[token]) {
    console.warn(`[auth] REJECT 401 invalid_token token=${token ? '<redacted>' : '<missing>'}`);
    return res.status(401).json({ error: 'invalid_token' });
  }

  const scopes = TOKENS[token];
  if (!scopes.includes(REQUIRED_SCOPE)) {
    console.warn(`[auth] REJECT 403 insufficient_scope have=${scopes.join(',')} need=${REQUIRED_SCOPE}`);
    return res.status(403).json({ error: 'insufficient_scope', required: REQUIRED_SCOPE, have: scopes });
  }

  res.json({ authorized: true, scope: scopes });
});

const server = app.listen(PORT, () => {
  console.log(`[auth] listening on :${PORT}`);
  console.log(`[auth] required scope: ${REQUIRED_SCOPE}`);
  if (DEGRADED_MS > 0) console.log(`[auth] DEGRADED mode: ${DEGRADED_MS}ms delay per /authorize`);
});

process.on('SIGTERM', () => {
  console.log('[auth] SIGTERM — shutting down');
  server.close(() => process.exit(0));
});
