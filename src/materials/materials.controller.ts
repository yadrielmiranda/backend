import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { Roles } from '@/auth/roles.decorator';
import type { AuthUser } from '@/auth/types/auth-user.type';
import { MaterialsInventoryService } from './materials-inventory.service';
import {
  MaterialAdjustmentDto, MaterialInternalUseDto, MaterialPresentationCreateDto, MaterialPresentationUpdateDto,
  MaterialProductCreateDto, MaterialProductUpdateDto, MaterialReceiptDto, MaterialRepackDto, MaterialTransferDto,
  MaterialUnitCreateDto, MaterialUnitUpdateDto,
  MaterialCategoryCreateDto, MaterialCategoryUpdateDto,
} from './materials.dto';

@Controller('materials')
@Roles('admin', 'operator')
export class MaterialsController {
  constructor(private readonly inventory: MaterialsInventoryService) {}
  @Get('categories') categories(@Req() req: Request) { return this.inventory.categories(req.user as AuthUser); }
  @Post('categories') @Roles('admin') createCategory(@Body() dto: MaterialCategoryCreateDto, @Req() req: Request) { return this.inventory.createCategory(dto, req.user as AuthUser); }
  @Patch('categories/:id') @Roles('admin') updateCategory(@Param('id', ParseIntPipe) id: number, @Body() dto: MaterialCategoryUpdateDto, @Req() req: Request) { return this.inventory.updateCategory(id, dto, req.user as AuthUser); }
  @Get('units') units(@Req() req: Request) { return this.inventory.units(req.user as AuthUser); }
  @Post('units') @Roles('admin') createUnit(@Body() dto: MaterialUnitCreateDto, @Req() req: Request) { return this.inventory.createUnit(dto, req.user as AuthUser); }
  @Patch('units/:id') @Roles('admin') updateUnit(@Param('id', ParseIntPipe) id: number, @Body() dto: MaterialUnitUpdateDto, @Req() req: Request) { return this.inventory.updateUnit(id, dto, req.user as AuthUser); }
  @Get('products') products(@Query() query: Record<string, string>, @Req() req: Request) { return this.inventory.products(query, req.user as AuthUser); }
  @Get('inventory') listInventory(@Query() query: Record<string, string>, @Req() req: Request) { return this.inventory.products(query, req.user as AuthUser); }
  @Get('products/:id') product(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.inventory.product(id, req.user as AuthUser); }
  @Get('barcode/:barcode') barcode(@Param('barcode') barcode: string, @Req() req: Request) { return this.inventory.findBarcode(barcode, req.user as AuthUser); }
  @Post('products') @Roles('admin') createProduct(@Body() dto: MaterialProductCreateDto, @Req() req: Request) { return this.inventory.createProduct(dto, req.user as AuthUser); }
  @Patch('products/:id') @Roles('admin') updateProduct(@Param('id', ParseIntPipe) id: number, @Body() dto: MaterialProductUpdateDto, @Req() req: Request) { return this.inventory.updateProduct(id, dto, req.user as AuthUser); }
  @Post('products/:id/presentations') @Roles('admin') createPresentation(@Param('id', ParseIntPipe) id: number, @Body() dto: MaterialPresentationCreateDto, @Req() req: Request) { return this.inventory.createPresentation(id, dto, req.user as AuthUser); }
  @Patch('presentations/:id') @Roles('admin') updatePresentation(@Param('id', ParseIntPipe) id: number, @Body() dto: MaterialPresentationUpdateDto, @Req() req: Request) { return this.inventory.updatePresentation(id, dto, req.user as AuthUser); }
  @Post('receipts') receive(@Body() dto: MaterialReceiptDto, @Req() req: Request) { return this.inventory.receive(dto, req.user as AuthUser); }
  @Post('internal-use') internalUse(@Body() dto: MaterialInternalUseDto, @Req() req: Request) { return this.inventory.internalUse(dto, req.user as AuthUser); }
  @Post('repacks') repack(@Body() dto: MaterialRepackDto, @Req() req: Request) { return this.inventory.repack(dto, req.user as AuthUser); }
  @Post('transfers') transfer(@Body() dto: MaterialTransferDto, @Req() req: Request) { return this.inventory.transfer(dto, req.user as AuthUser); }
  @Post('adjustments') @Roles('admin') adjust(@Body() dto: MaterialAdjustmentDto, @Req() req: Request) { return this.inventory.adjust(dto, req.user as AuthUser); }
  @Get('history') history(@Query() query: Record<string, string>, @Req() req: Request) { return this.inventory.history(query, req.user as AuthUser); }
}
