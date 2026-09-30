-- La suspensión de la red no cambia el estado administrativo de la cuenta.
ALTER TABLE `User` ADD COLUMN `networkSuspended` BOOLEAN NOT NULL DEFAULT false;
