CREATE TABLE `client_delivery_coverage_checks` (
  `userId` INT NOT NULL,
  `verificationKey` CHAR(64) NOT NULL,
  `locationProof` CHAR(64) NULL,
  `available` BOOLEAN NOT NULL,
  PRIMARY KEY (`userId`),
  CONSTRAINT `client_delivery_coverage_checks_userId_fkey`
    FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `estimate_delivery_acknowledgements` (
  `estimateId` INT NOT NULL,
  `choice` ENUM('PICKUP', 'DELIVERY') NOT NULL,
  `verificationKey` CHAR(64) NULL,
  `acknowledgedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`estimateId`),
  CONSTRAINT `estimate_delivery_acknowledgements_estimateId_fkey`
    FOREIGN KEY (`estimateId`) REFERENCES `Estimate`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
