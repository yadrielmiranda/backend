-- Preserve only the destination point validated by the server for this charge.
-- Existing deliveries retain NULL and their original distance and pricing snapshots.
ALTER TABLE `order_deliveries` ADD COLUMN `destinationLocation` JSON NULL;
