-- Sample "shop" database for pg-lens demos.
-- Deliberate flaw: orders.customer_id has NO index, so
-- "orders by customer" queries do a sequential scan — that is the
-- slow query the demo diagnoses. Everything else is indexed normally.

CREATE TABLE customers (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email       TEXT NOT NULL UNIQUE,
  full_name   TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE products (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sku         TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0)
);

CREATE TABLE orders (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_id BIGINT NOT NULL REFERENCES customers(id),
  status      TEXT NOT NULL DEFAULT 'paid',
  total_cents INTEGER NOT NULL CHECK (total_cents >= 0),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  -- NOTE: intentionally no index on customer_id (demo flaw, see above)
);

CREATE TABLE order_items (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id   BIGINT NOT NULL REFERENCES orders(id),
  product_id BIGINT NOT NULL REFERENCES products(id),
  quantity   INTEGER NOT NULL CHECK (quantity > 0)
);
CREATE INDEX order_items_order_id_idx ON order_items(order_id);

INSERT INTO customers (email, full_name)
SELECT 'customer' || g || '@example.com', 'Customer ' || g
FROM generate_series(1, 200) AS g;

INSERT INTO products (sku, name, price_cents)
SELECT 'SKU-' || g, 'Product ' || g, 500 + (g * 37) % 20000
FROM generate_series(1, 50) AS g;

INSERT INTO orders (customer_id, status, total_cents, created_at)
SELECT 1 + (g % 200),
       CASE WHEN g % 10 = 0 THEN 'refunded' ELSE 'paid' END,
       1000 + (g * 91) % 50000,
       now() - (g || ' minutes')::interval
FROM generate_series(1, 20000) AS g;

INSERT INTO order_items (order_id, product_id, quantity)
SELECT 1 + (g % 20000), 1 + (g % 50), 1 + (g % 3)
FROM generate_series(1, 20000) AS g;

ANALYZE customers;
ANALYZE products;
ANALYZE orders;
ANALYZE order_items;
