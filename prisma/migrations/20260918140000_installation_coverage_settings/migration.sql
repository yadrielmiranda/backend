-- Configuración independiente; no modifica cotizaciones ni activa recargos.
CREATE TABLE `installation_coverage` (
    `id` INTEGER NOT NULL DEFAULT 1,
    `revision` INTEGER NOT NULL DEFAULT 1,
    `originStreet` VARCHAR(150) NOT NULL,
    `originCity` VARCHAR(100) NOT NULL,
    `originState` VARCHAR(2) NOT NULL,
    `originPostalCode` VARCHAR(10) NOT NULL,
    `maxDistanceMiles` DECIMAL(10, 2) NOT NULL,
    `includedMiles` DECIMAL(10, 2) NOT NULL,
    `ranges` JSON NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
