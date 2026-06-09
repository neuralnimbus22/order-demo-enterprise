// user-session-service — human identity for the Phase 2 UI.
//
// CRITICAL distinction (do not confuse the two):
//   * auth-service  → authorizes ORDERS in the backend pipeline. Static Bearer
//                     token catalogue. order-service calls it. Unrelated to humans.
//   * user-session  → who the USER is. Real registration, login, signed JWTs.
//                     What the UI's login/logout flows use. NOT on the
//                     order/auth path; order-service does not call this.
//
// Backed by the shared Postgres (same db:5432 + inventory creds; new `users`
// table). Hashes passwords with bcryptjs (pure-JS — no native build deps on
// alpine). Signs short-lived JWTs with the `jsonwebtoken` library.
//
// Endpoints:
//   GET  /health    → 200 {status:"ok"}
//   POST /register  → 201 {email} · 409 email_exists · 400 missing_fields
//   POST /login     → 200 {token,email} · 401 invalid_credentials (opaque)
//   GET  /validate  → 200 {email,iat,exp,...} · 401 invalid_token

const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const PORT        = parseInt(process.env.PORT || '3006', 10);
// JWT secret. Local default is intentionally weak — in a real deploy this
// would come from a Kubernetes Secret (same trade-off already recorded for
// the shared DB credentials).
const JWT_SECRET  = process.env.JWT_SECRET   || 'dev-secret-change-me';
const JWT_EXPIRES = process.env.JWT_EXPIRES  || '1h';
const BCRYPT_COST = parseInt(process.env.BCRYPT_COST || '10', 10);

const DB_HOST     = process.env.DB_HOST      || 'localhost';
const DB_PORT     = parseInt(process.env.DB_PORT || '5432', 10);
const DB_USER     = process.env.DB_USER      || 'inventory';
const DB_PASSWORD = process.env.DB_PASSWORD  || 'inventory';
const DB_NAME     = process.env.DB_NAME      || 'inventory';
const DB_POOL_MAX = parseInt(process.env.DB_POOL_MAX || '4', 10);
const DB_TIMEOUT_MS = parseInt(process.env.DB_TIMEOUT_MS || '2000', 10);

// Seeded so the Phase 2 UI has a guaranteed login out of the box.
// Idempotent (ON CONFLICT DO NOTHING) — re-runs / pod restarts don't
// disturb existing rows, so if you've changed the demo user's password
// since seed, that change survives.
const SEED_USER_EMAIL    = process.env.SEED_USER_EMAIL    || 'demo@example.com';
const SEED_USER_PASSWORD = process.env.SEED_USER_PASSWORD || 'demo-password';

const app = express();
app.use(express.json());

const pool = new Pool({
  host: DB_HOST,
  port: DB_PORT,
  user: DB_USER,
  password: DB_PASSWORD,
  database: DB_NAME,
  max: DB_POOL_MAX,
  connectionTimeoutMillis: DB_TIMEOUT_MS,
  idleTimeoutMillis: 10_000,
});
pool.on('error', (err) => console.error('[user-session] pg pool error:', err.message));

let dbReady = false;

// Mirror product-catalog / inventory's initSchema retry-on-boot pattern.
async function initSchemaAndSeed() {
  for (let attempt = 1; attempt <= 30; attempt++) {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
          email         TEXT PRIMARY KEY,
          password_hash TEXT NOT NULL,
          created_at    TIMESTAMP NOT NULL DEFAULT NOW()
        )
      `);
      // Seed demo user. ON CONFLICT DO NOTHING so a re-run with a different
      // SEED_USER_PASSWORD doesn't silently overwrite a user's chosen
      // password — operators have to delete the row to re-seed.
      const seedHash = await bcrypt.hash(SEED_USER_PASSWORD, BCRYPT_COST);
      const r = await pool.query(
        `INSERT INTO users (email, password_hash)
         VALUES ($1, $2)
         ON CONFLICT (email) DO NOTHING
         RETURNING email`,
        [SEED_USER_EMAIL, seedHash]
      );
      dbReady = true;
      const seeded = r.rowCount > 0;
      console.log(`[user-session] postgres schema ready; demo user '${SEED_USER_EMAIL}' ${seeded ? 'seeded' : 'already present'}`);
      return;
    } catch (err) {
      console.warn(`[user-session] db init attempt ${attempt} failed: ${err.message}`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  console.error('[user-session] gave up initializing db schema');
}
initSchemaAndSeed();

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// --- /register -------------------------------------------------------------
app.post('/register', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required' });
  }
  let hash;
  try {
    hash = await bcrypt.hash(password, BCRYPT_COST);
  } catch (err) {
    return res.status(500).json({ error: 'hash failed', detail: err.message });
  }
  let result;
  try {
    // ON CONFLICT DO NOTHING is an atomic existence check — if 0 rows
    // affected we know the email is taken without a separate SELECT.
    result = await pool.query(
      `INSERT INTO users (email, password_hash)
       VALUES ($1, $2)
       ON CONFLICT (email) DO NOTHING
       RETURNING email`,
      [email, hash]
    );
  } catch (err) {
    return res.status(502).json({ error: 'db write failed', detail: err.message });
  }
  if (result.rowCount === 0) {
    return res.status(409).json({ error: 'email_exists' });
  }
  res.status(201).json({ email });
});

// --- /login ----------------------------------------------------------------
app.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    // Same opaque shape as bad-credentials — don't leak whether email exists.
    return res.status(401).json({ error: 'invalid_credentials' });
  }
  let row;
  try {
    const r = await pool.query(
      'SELECT password_hash FROM users WHERE email = $1',
      [email]
    );
    row = r.rows[0];
  } catch (err) {
    return res.status(502).json({ error: 'db read failed', detail: err.message });
  }
  if (!row) {
    // Opaque: don't reveal whether email or password was wrong.
    return res.status(401).json({ error: 'invalid_credentials' });
  }
  let ok = false;
  try {
    ok = await bcrypt.compare(password, row.password_hash);
  } catch (_) {
    ok = false;
  }
  if (!ok) {
    return res.status(401).json({ error: 'invalid_credentials' });
  }
  const token = jwt.sign({ sub: email, email }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
  res.json({ token, email });
});

// --- /validate -------------------------------------------------------------
app.get('/validate', (req, res) => {
  const auth = req.headers['authorization'] || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) {
    return res.status(401).json({ error: 'invalid_token' });
  }
  try {
    const claims = jwt.verify(m[1], JWT_SECRET);
    // Return identity + standard claims (iat, exp). claims.email is what the
    // UI should display; claims.exp is when the session expires (epoch seconds).
    res.json({
      email: claims.email || claims.sub,
      sub:   claims.sub,
      iat:   claims.iat,
      exp:   claims.exp,
    });
  } catch (_) {
    res.status(401).json({ error: 'invalid_token' });
  }
});

app.listen(PORT, () => {
  console.log(`[user-session] listening on :${PORT}`);
  console.log(`[user-session] db        : ${DB_HOST}:${DB_PORT}/${DB_NAME} (table: users)`);
  console.log(`[user-session] jwt       : HS256, expires ${JWT_EXPIRES}`);
  console.log(`[user-session] demo user : ${SEED_USER_EMAIL}`);
});

process.on('SIGTERM', async () => {
  console.log('[user-session] shutting down');
  await pool.end().catch(() => {});
  process.exit(0);
});
