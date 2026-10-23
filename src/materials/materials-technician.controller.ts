import { Body, Controller, Get, Param, ParseIntPipe, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { Roles } from '@/auth/roles.decorator';
import type { AuthUser } from '@/auth/types/auth-user.type';
import { TechnicianMaterialStoreIssueDto } from './materials-store-issue.dto';
import { MaterialsStoreIssueService } from './materials-store-issue.service';
import { MaterialsStoreInventoryService } from './materials-store-inventory.service';

@Controller('technician/materials')
@Roles('technician')
export class MaterialsTechnicianController {
  constructor(private readonly inventory: MaterialsStoreInventoryService, private readonly issue: MaterialsStoreIssueService) {}

  @Get('stores/:storeId/inventory')
  getInventory(@Param('storeId', ParseIntPipe) storeId: number, @Req() req: Request) {
    return this.inventory.getTechnicianInventory(storeId, req.user as AuthUser);
  }

  @Post('stores/:storeId/internal-use')
  internalUse(@Param('storeId', ParseIntPipe) storeId: number, @Body() dto: TechnicianMaterialStoreIssueDto, @Req() req: Request) {
    return this.issue.technicianInternalUse(storeId, dto, req.user as AuthUser);
  }

  @Get('history')
  history(@Query() query: Record<string, string>, @Req() req: Request) {
    return this.issue.technicianHistory(query, req.user as AuthUser);
  }
}
