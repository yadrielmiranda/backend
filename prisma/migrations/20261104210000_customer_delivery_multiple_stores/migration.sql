-- Existing preparations retain their source; their saved lines are materialized
-- with that origin when the delivery is upgraded by a new client.
ALTER TABLE `warehouse_customer_delivery_runs`
  ADD COLUMN `multiStore` BOOLEAN NOT NULL DEFAULT false;
