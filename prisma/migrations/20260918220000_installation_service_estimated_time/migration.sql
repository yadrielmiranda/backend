-- NULL distingue un tiempo pendiente de un cero configurado expresamente.
ALTER TABLE `installation_services`
    ADD COLUMN `estimatedMinutes` DECIMAL(12, 4) NULL;

-- En un rango, NULL indica que se utilizará el tiempo base del servicio.
ALTER TABLE `installation_service_rules`
    ADD COLUMN `estimatedMinutes` DECIMAL(12, 4) NULL;
