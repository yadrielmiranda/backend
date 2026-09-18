-- Los servicios sin tiempo base configurado comienzan en cero.
UPDATE `installation_services`
SET `estimatedMinutes` = 0
WHERE `estimatedMinutes` IS NULL;

-- El tiempo base nunca queda vacío; los tiempos específicos de los rangos siguen siendo opcionales.
ALTER TABLE `installation_services`
    MODIFY COLUMN `estimatedMinutes` DECIMAL(12, 4) NOT NULL DEFAULT 0;
