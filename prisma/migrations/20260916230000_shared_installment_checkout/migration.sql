-- Una sesión de Stripe puede liquidar varias cuotas, cada una con su importe.
-- La unicidad por estimate, tipo y secuencia permanece intacta.
CREATE INDEX `payments_stripeSessionId_idx` ON `payments`(`stripeSessionId`);
CREATE INDEX `payments_stripePaymentIntentId_idx` ON `payments`(`stripePaymentIntentId`);
DROP INDEX `payments_stripeSessionId_key` ON `payments`;
DROP INDEX `payments_stripePaymentIntentId_key` ON `payments`;
