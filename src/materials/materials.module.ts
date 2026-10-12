import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '@/prisma/prisma.module';
import { NotificationsModule } from '@/notifications/notifications.module';
import { MaterialsController } from './materials.controller';
import { MaterialsInventoryService } from './materials-inventory.service';
import { MaterialsStoreInventoryService } from './materials-store-inventory.service';
import { MaterialsStoreInventoryController } from './materials-store-inventory.controller';
import { MaterialsStoreIssueController } from './materials-store-issue.controller';
import { MaterialsStoreIssueService } from './materials-store-issue.service';
import { MaterialsImagesController } from './materials-images.controller';
import { MaterialsSalesService } from './materials-sales.service';
import { MaterialSaleEmailService } from './material-sale-email.service';
import { MaterialsSalesController, MaterialsPublicSalesController, MaterialsCustomerCatalogController } from './materials-sales.controller';

@Module({
  imports: [PrismaModule, ConfigModule, NotificationsModule],
  controllers: [MaterialsController, MaterialsStoreInventoryController, MaterialsStoreIssueController, MaterialsImagesController, MaterialsSalesController, MaterialsPublicSalesController, MaterialsCustomerCatalogController],
  providers: [MaterialsInventoryService, MaterialsStoreInventoryService, MaterialsStoreIssueService, MaterialsSalesService, MaterialSaleEmailService],
  exports: [MaterialsInventoryService, MaterialsSalesService],
})
export class MaterialsModule {}
