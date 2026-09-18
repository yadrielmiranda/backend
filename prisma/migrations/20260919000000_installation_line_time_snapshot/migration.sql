-- Conserva el tiempo utilizado en cada línea sin alterar las cotizaciones anteriores.
ALTER TABLE `installation_quote_lines`
    ADD COLUMN `timeSnapshot` JSON NULL;
