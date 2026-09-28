-- Conserva los estimados cancelados y su historial firmado.
INSERT INTO `EstimateStatus` (`name`) VALUES ('Canceled')
ON DUPLICATE KEY UPDATE `name` = 'Canceled';
