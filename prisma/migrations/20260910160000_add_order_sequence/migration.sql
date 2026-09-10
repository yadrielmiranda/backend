-- Secuencia independiente para numerar órdenes sin consultar el último Order.id.
CREATE TABLE `OrderSequence` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Conserva las órdenes existentes: reserva solo el mayor número comercial usado.
-- La siguiente inserción automática superará ese número, aunque Order.id difiera.
-- Si no hay órdenes ORD-1001 o superiores, no inserta nada: comenzará en ORD-1001.
-- Aplicar con el backend detenido para que no se creen órdenes durante este paso.
INSERT INTO `OrderSequence` (`id`)
SELECT MAX(CAST(SUBSTRING(`number`, 5) AS UNSIGNED)) - 1000
FROM `Order`
WHERE `number` REGEXP '^ORD-[0-9]+$'
  AND CAST(SUBSTRING(`number`, 5) AS UNSIGNED) > 1000
HAVING COUNT(*) > 0;
