-- Descuento manual del estimado y condiciones conservadas después del pago.
ALTER TABLE `Estimate` ADD COLUMN `manualDiscount` JSON NULL;
