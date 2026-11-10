CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  amount_sen INTEGER NOT NULL CHECK (amount_sen > 0),
  merchant TEXT NOT NULL,
  item TEXT,
  category TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('shopeepay_qr', 'apple_pay', 'manual')),
  card TEXT,
  occurred_at TEXT NOT NULL,
  local_date TEXT NOT NULL,
  needs_review INTEGER NOT NULL DEFAULT 0,
  reference TEXT,
  raw_text TEXT
);
CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions (local_date);
CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_reference
  ON transactions (reference) WHERE reference IS NOT NULL;

CREATE TABLE IF NOT EXISTS merchant_categories (
  merchant_key TEXT PRIMARY KEY,
  category TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS budgets (
  local_date TEXT PRIMARY KEY,
  amount_sen INTEGER NOT NULL CHECK (amount_sen > 0)
);

-- Each row applies from that pay period onwards, until a newer row replaces it.
CREATE TABLE IF NOT EXISTS income (
  effective_from TEXT PRIMARY KEY,
  amount_sen INTEGER NOT NULL CHECK (amount_sen > 0)
);

-- A commitment counts from effective_from until the pay period starting ended_from.
CREATE TABLE IF NOT EXISTS commitments (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  amount_sen INTEGER NOT NULL CHECK (amount_sen > 0),
  effective_from TEXT NOT NULL,
  ended_from TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS receipts (
  transaction_id TEXT PRIMARY KEY,
  image TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Wrong access keys per client (a hash of the address), used to slow down guessing.
CREATE TABLE IF NOT EXISTS auth_failures (
  client TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  window_start INTEGER NOT NULL
);
