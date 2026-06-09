// product-catalog-service — read-only catalog of generic retail products.
// Stores products in Postgres (same db as inventory, separate `products` table)
// and seeds ~20 mundane items on startup. The product `id` IS the SKU — the
// same key inventory's `stock` table uses. This service does NOT participate
// in fulfillment; it's a lookup surface so order-service can validate an
// incoming `sku` when one is supplied.
//
// Endpoints:
//   GET  /health           → 200 {status:"ok"}
//   GET  /products         → 200 [ {id,name,category,price,description,stock}, ... ]
//   GET  /products/:id     → 200 product · 404 unknown sku
//
// Catalog `stock` is display data only. inventory's `stock` table is the
// source of truth for fulfillment; do NOT validate order quantity here.

const express = require('express');
const { Pool } = require('pg');

const PORT          = parseInt(process.env.PORT || '3005', 10);
const DB_HOST       = process.env.DB_HOST     || 'localhost';
const DB_PORT       = parseInt(process.env.DB_PORT || '5432', 10);
const DB_USER       = process.env.DB_USER     || 'inventory';
const DB_PASSWORD   = process.env.DB_PASSWORD || 'inventory';
const DB_NAME       = process.env.DB_NAME     || 'inventory';
const DB_POOL_MAX   = parseInt(process.env.DB_POOL_MAX || '4', 10);
const DB_TIMEOUT_MS = parseInt(process.env.DB_TIMEOUT_MS || '2000', 10);

// Seed catalog — 20 generic retail products. Set dressing only; no brands,
// no theme. Stock numbers are arbitrary display data — inventory's stock
// table is the source of truth for actual fulfillment.
const SEED_PRODUCTS = [
  // Books
  { id: 'BK-001', name: 'Hardcover Notebook',       category: 'books',      price: 14.99, description: '200-page lined hardcover notebook.', stock: 42 },
  { id: 'BK-002', name: 'Paperback Novel',          category: 'books',      price:  9.99, description: 'Trade paperback fiction.',           stock: 60 },
  { id: 'BK-003', name: 'Illustrated Cookbook',     category: 'books',      price: 24.99, description: 'Hardcover cookbook with photos.',    stock: 18 },
  // Kitchen
  { id: 'KT-001', name: 'Stainless Steel Skillet',  category: 'kitchen',    price: 39.99, description: '10-inch stainless skillet.',         stock: 24 },
  { id: 'KT-002', name: 'Ceramic Mug Set (4)',      category: 'kitchen',    price: 18.99, description: 'Set of four 12 oz ceramic mugs.',    stock: 36 },
  { id: 'KT-003', name: 'Digital Kitchen Scale',    category: 'kitchen',    price: 24.50, description: 'Up to 5 kg, gram precision.',        stock: 21 },
  // Home goods
  { id: 'HG-001', name: 'Bath Towel Set (3)',       category: 'home',       price: 29.99, description: 'Cotton bath, hand, and face towels.',stock: 30 },
  { id: 'HG-002', name: 'Throw Pillow',             category: 'home',       price: 17.50, description: '18-inch decorative throw pillow.',   stock: 45 },
  { id: 'HG-003', name: 'LED Desk Lamp',            category: 'home',       price: 34.99, description: 'Adjustable LED desk lamp.',          stock: 22 },
  { id: 'HG-004', name: 'Area Rug 5x7',             category: 'home',       price: 74.99, description: 'Woven indoor area rug.',             stock:  8 },
  // Stationery
  { id: 'ST-001', name: 'Gel Pen 5-pack',           category: 'stationery', price:  6.49, description: 'Five fine-point gel pens, black.',   stock: 99 },
  { id: 'ST-002', name: 'Sticky Notes Variety',     category: 'stationery', price:  4.99, description: 'Assorted sizes and colors.',         stock: 80 },
  { id: 'ST-003', name: 'Manila Folders (25)',      category: 'stationery', price:  8.99, description: 'Letter-size manila file folders.',   stock: 55 },
  { id: 'ST-004', name: 'Desk Organizer',           category: 'stationery', price: 19.99, description: 'Mesh metal desk organizer.',         stock: 27 },
  // Garden / outdoor
  { id: 'GD-001', name: 'Garden Trowel',            category: 'garden',     price: 11.99, description: 'Stainless trowel with wood handle.', stock: 33 },
  { id: 'GD-002', name: 'Watering Can 1 Gal',       category: 'garden',     price: 14.99, description: '1-gallon plastic watering can.',     stock: 19 },
  // Office
  { id: 'OF-001', name: 'Chair Cushion',            category: 'office',     price: 22.99, description: 'Memory-foam seat cushion.',          stock: 25 },
  { id: 'OF-002', name: 'Cable Management Kit',     category: 'office',     price:  9.99, description: 'Sleeves, clips, ties — assorted.',   stock: 47 },
  // Hardware
  { id: 'HW-001', name: 'LED Bulb 4-pack',          category: 'hardware',   price: 13.99, description: 'Soft-white A19 LED, 9W.',            stock: 65 },
  { id: 'HW-002', name: 'Picture Hanging Kit',      category: 'hardware',   price:  7.99, description: 'Nails, hooks, hangers, level.',      stock: 70 },
];

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
pool.on('error', (err) => console.error('[product-catalog] pg pool error:', err.message));

let dbReady = false;

// Mirror inventory's initSchema retry-on-boot pattern — Postgres pod may not
// be reachable yet on a fresh-cluster bring-up.
async function initSchemaAndSeed() {
  for (let attempt = 1; attempt <= 30; attempt++) {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS products (
          id          TEXT PRIMARY KEY,
          name        TEXT NOT NULL,
          category    TEXT NOT NULL,
          price       NUMERIC(10,2) NOT NULL,
          description TEXT,
          stock       INTEGER NOT NULL DEFAULT 0
        )
      `);
      // Idempotent seed: ON CONFLICT DO NOTHING so re-runs / pod restarts
      // don't disturb existing rows (or overwrite them if someone edited live).
      for (const p of SEED_PRODUCTS) {
        await pool.query(
          `INSERT INTO products (id, name, category, price, description, stock)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (id) DO NOTHING`,
          [p.id, p.name, p.category, p.price, p.description, p.stock]
        );
      }
      dbReady = true;
      console.log(`[product-catalog] postgres schema ready, ${SEED_PRODUCTS.length} products seeded (idempotent)`);
      return;
    } catch (err) {
      console.warn(`[product-catalog] db init attempt ${attempt} failed: ${err.message}`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  console.error('[product-catalog] gave up initializing db schema');
}
initSchemaAndSeed();

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.get('/products', async (_req, res) => {
  try {
    const r = await pool.query(
      'SELECT id, name, category, price::float AS price, description, stock FROM products ORDER BY id'
    );
    res.json(r.rows);
  } catch (err) {
    res.status(502).json({ error: 'db read failed', detail: err.message });
  }
});

app.get('/products/:id', async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT id, name, category, price::float AS price, description, stock FROM products WHERE id = $1',
      [req.params.id]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'unknown product', sku: req.params.id });
    res.json(r.rows[0]);
  } catch (err) {
    res.status(502).json({ error: 'db read failed', detail: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`[product-catalog] listening on :${PORT}`);
  console.log(`[product-catalog] db    : ${DB_HOST}:${DB_PORT}/${DB_NAME} (table: products)`);
});

process.on('SIGTERM', async () => {
  console.log('[product-catalog] shutting down');
  await pool.end().catch(() => {});
  process.exit(0);
});
