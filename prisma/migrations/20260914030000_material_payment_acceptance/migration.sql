-- Aceptación opcional para los pagos nuevos de materiales del cliente.
ALTER TABLE `payments`
    ADD COLUMN `materialAcceptanceText` VARCHAR(255) NULL,
    ADD COLUMN `materialAcceptedAt` DATETIME(3) NULL;
