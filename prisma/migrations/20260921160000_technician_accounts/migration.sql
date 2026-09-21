-- Cuenta interna independiente: los contactos ausentes se guardan como NULL.
-- Los índices únicos se conservan; no se modifican usuarios existentes.
ALTER TABLE `User`
  MODIFY `email` VARCHAR(191) NULL,
  MODIFY `phone` VARCHAR(191) NULL,
  MODIFY `street` VARCHAR(150) NULL,
  MODIFY `city` VARCHAR(100) NULL,
  MODIFY `state` VARCHAR(50) NULL,
  MODIFY `postalCode` VARCHAR(20) NULL;

INSERT INTO `Role` (`name`, `markup`, `createdAt`, `updatedAt`)
SELECT 'technician', 0, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)
WHERE NOT EXISTS (SELECT 1 FROM `Role` WHERE `name` = 'technician');
