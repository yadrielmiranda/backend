import { Body, Controller, Get, Param, ParseIntPipe, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { Roles } from '@/auth/roles.decorator';
import type { AuthUser } from '@/auth/types/auth-user.type';
import { MaterialStoreCountDto } from './materials-store-inventory.dto';
import { MaterialsStoreInventoryService } from './materials-store-inventory.service';

@Controller('materials/stores')
@Roles('admin', 'operator')
export class MaterialsStoreInventoryController {
  constructor(private readonly inventory: MaterialsStoreInventoryService) {}

  @Get(':storeId/inventory')
  getInventory(@Param('storeId', ParseIntPipe) storeId: number, @Req() req: Request) {
    return this.inventory.getInventory(storeId, req.user as AuthUser);
  }

  @Post(':storeId/count')
  @Roles('admin')
  count(@Param('storeId', ParseIntPipe) storeId: number, @Body() dto: MaterialStoreCountDto, @Req() req: Request) {
    return this.inventory.count(storeId, dto, req.user as AuthUser);
  }
}
