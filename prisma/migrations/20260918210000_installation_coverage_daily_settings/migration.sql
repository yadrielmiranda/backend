-- Jornada configurable; los cargos diarios se guardan en el JSON de rangos.
-- Los rangos anteriores conservan sus importes y parten de un cargo diario cero.
ALTER TABLE `installation_coverage`
    ADD COLUMN `hoursPerDay` DECIMAL(4, 2) NOT NULL DEFAULT 8.00;
