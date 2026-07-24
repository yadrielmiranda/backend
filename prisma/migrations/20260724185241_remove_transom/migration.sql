-- Las configuraciones con TRANSOM pasan a utilizar pricing directo.
-- Se eliminan todos sus componentes para evitar sumas parciales.
DELETE components
FROM `sys_conf_pricing_components` AS components
INNER JOIN `sys_conf_pricing_components` AS transom_config
  ON transom_config.`idSystem` = components.`idSystem`
 AND transom_config.`idConfig` = components.`idConfig`
WHERE transom_config.`componentType` = 'TRANSOM';

-- Estas reglas no pueden convertirse automáticamente en MAIN.
DELETE FROM `DimensionRule`
WHERE `ruleType` = 'TRANSOM';

ALTER TABLE `sys_conf_pricing_components`
  DROP PRIMARY KEY,
  MODIFY `componentType` ENUM('DOOR', 'SIDELITE') NOT NULL,
  ADD PRIMARY KEY (`idSystem`, `idConfig`, `componentType`);

ALTER TABLE `DimensionRule`
  MODIFY `ruleType` ENUM('MAIN', 'DOOR', 'SIDELITE') NOT NULL DEFAULT 'MAIN';