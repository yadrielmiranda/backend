-- Antes del catálogo estos dealers internos no tenían un plan de ganancias.
-- La primera migración les asignó FULL_MARKUP automáticamente: se corrige a 0%.
-- No hubo nuevos estimados entre aquella migración y la creación del catálogo.
-- Renombrar/asignar un plan pudo haber reemplazado la copia de algún borrador antiguo.
-- Su fecha de creación permite reconocer que ya existía antes de esta funcionalidad.
-- Se conservan los planes del catálogo, sus asignaciones y las copias de ventas nuevas.
-- No se modifican precios, costos, descuentos, pagos ni estados de las ventas.

-- Prisma reconstruye las migraciones en una base temporal sin _prisma_migrations.
-- La consulta se prepara solo si la tabla existe en la base actual; un IF dentro
-- del UPDATE no basta, porque MySQL resolvería igualmente la tabla inexistente.
SET @dealer_earnings_legacy_cutoff = NULL;
SET @dealer_earnings_legacy_cutoff_sql = IF(
  EXISTS (
    SELECT 1 FROM `information_schema`.`TABLES`
    WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = '_prisma_migrations'
  ),
  'SELECT MIN(`started_at`) INTO @dealer_earnings_legacy_cutoff
   FROM `_prisma_migrations`
   WHERE `migration_name` = ''20260925173000_internal_dealer_earnings''
     AND `finished_at` IS NOT NULL AND `rolled_back_at` IS NULL',
  'SET @dealer_earnings_legacy_cutoff = NULL'
);
PREPARE dealer_earnings_legacy_cutoff_stmt FROM @dealer_earnings_legacy_cutoff_sql;
EXECUTE dealer_earnings_legacy_cutoff_stmt;
DEALLOCATE PREPARE dealer_earnings_legacy_cutoff_stmt;

UPDATE `Estimate`
SET `dealerEarningsPlanSnapshot` = JSON_OBJECT(
  'version', 2,
  'planId', NULL,
  'name', 'No earnings plan assigned',
  'revision', NULL,
  'basis', 'DEALER_MARKUP',
  'percent', '0'
)
WHERE `dealerModeSnapshot` = 'INTERNAL'
  AND (
    `date` < @dealer_earnings_legacy_cutoff
    OR `dealerEarningsPlanSnapshot` IS NULL
    OR JSON_TYPE(`dealerEarningsPlanSnapshot`) = 'NULL'
    OR (
      JSON_UNQUOTE(JSON_EXTRACT(`dealerEarningsPlanSnapshot`, '$.version')) = '1'
      AND JSON_UNQUOTE(JSON_EXTRACT(`dealerEarningsPlanSnapshot`, '$.type')) = 'FULL_MARKUP'
      AND (
        JSON_EXTRACT(`dealerEarningsPlanSnapshot`, '$.percent') IS NULL
        OR JSON_TYPE(JSON_EXTRACT(`dealerEarningsPlanSnapshot`, '$.percent')) = 'NULL'
      )
    )
  );

SET @dealer_earnings_legacy_cutoff = NULL;
SET @dealer_earnings_legacy_cutoff_sql = NULL;
