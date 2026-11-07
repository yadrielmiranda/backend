-- Keep series enabled if their administrator previously assigned a French Door
-- design to a configuration. Existing quoted pieces reference the catalog directly.
UPDATE `System` AS s
JOIN `Product` AS p ON p.`id` = s.`idProduct`
SET s.`allowDesign` = TRUE
WHERE p.`kind` = 'GLAZED_UNIT' AND p.`diagramFamily` = 'FRENCH_DOOR'
  AND EXISTS (
    SELECT 1 FROM `sys_conf_door_designs` AS a
    JOIN `Config` AS c ON c.`id` = a.`idConfig`
    WHERE a.`idSystem` = s.`id` AND c.`idProduct` = p.`id`
  );

DROP TABLE `sys_conf_door_designs`;
