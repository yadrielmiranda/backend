import { Module } from '@nestjs/common';
import { PrismaModule } from '@/prisma/prisma.module';
import {
  ContractsController,
  PublicContractsController,
} from './contracts.controller';
import { ContractsService } from './contracts.service';
import { ContractPdfService } from './contract-pdf.service';
import { ContractStorageService } from './contract-storage.service';

@Module({
  imports: [PrismaModule],
  controllers: [ContractsController, PublicContractsController],
  providers: [ContractsService, ContractPdfService, ContractStorageService],
})
export class ContractsModule {}
