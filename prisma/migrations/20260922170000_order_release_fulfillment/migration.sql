-- Agrega los estados posteriores a produccion sin alterar ordenes existentes.
INSERT INTO `OrderStatus` (`name`)
SELECT 'Awaiting release'
WHERE NOT EXISTS (SELECT 1 FROM `OrderStatus` WHERE `name` = 'Awaiting release');

INSERT INTO `OrderStatus` (`name`)
SELECT 'Preparing for pickup'
WHERE NOT EXISTS (SELECT 1 FROM `OrderStatus` WHERE `name` = 'Preparing for pickup');

-- Distingue pickup en nuestro warehouse de pickup directo en fabrica.
ALTER TABLE `Order`
  MODIFY `fulfillmentMethod` ENUM(
    'UNDECIDED',
    'CUSTOMER_PICKUP',
    'FACTORY_PICKUP',
    'COMPANY_DELIVERY',
    'INSTALLATION_DELIVERY'
  ) NOT NULL DEFAULT 'UNDECIDED';
