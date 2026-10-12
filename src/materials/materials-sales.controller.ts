import { Body, Controller, Get, HttpException, Param, ParseIntPipe, Post, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { Roles } from '@/auth/roles.decorator';
import { Public } from '@/auth/public.decorator';
import type { AuthUser } from '@/auth/types/auth-user.type';
import { MaterialsSalesService } from './materials-sales.service';
import { CreateMaterialSaleDto, CustomerMaterialOrderDto, MaterialManualPaymentDto, MaterialSaleActionDto } from './materials-sales.dto';

const publicRequests = new Map<string, { count: number; until: number }>();
function admitMaterialWrite(req: Request, kind: 'order' | 'checkout' = 'checkout') {
  const identity = kind === 'order' ? (req.user as AuthUser).id : req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now(), key = `${kind}:${identity}`;
  if (publicRequests.size > 5000) for (const [id, entry] of publicRequests) if (entry.until <= now) publicRequests.delete(id);
  let entry = publicRequests.get(key);
  if (!entry || entry.until <= now) {
    if (!entry && publicRequests.size >= 10000) throw new HttpException('Too many material checkout requests. Please try again shortly.', 429);
    entry = { count: 0, until: now + (kind === 'order' ? 10 : 1) * 60000 }; publicRequests.set(key, entry);
  }
  if (++entry.count > (kind === 'order' ? 10 : 30)) throw new HttpException('Too many material checkout requests. Please try again shortly.', 429);
}

@Controller('materials/sales')
@Roles('admin', 'operator')
export class MaterialsSalesController {
  constructor(private readonly sales: MaterialsSalesService) {}
  @Get() list(@Req() req: Request, @Query() query: { q?: string }) { return this.sales.list(req.user as AuthUser, query); }
  @Get('customers') customers(@Req() req: Request, @Query() query: { q?: string }) { return this.sales.searchCustomers(req.user as AuthUser, query); }
  @Post() create(@Body() dto: CreateMaterialSaleDto, @Req() req: Request) { return this.sales.create(dto, req.user as AuthUser); }
  @Get(':id') get(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.sales.get(id, req.user as AuthUser); }
  @Post(':id/confirm') confirm(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.sales.confirm(id, req.user as AuthUser); }
  @Post(':id/cancel') cancel(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.sales.cancel(id, req.user as AuthUser); }
  @Post(':id/deliver') deliver(@Param('id', ParseIntPipe) id: number, @Body() dto: MaterialSaleActionDto, @Req() req: Request) {
    return this.sales.deliver(id, dto.requestKey, req.user as AuthUser);
  }
  @Roles('admin')
  @Post(':id/payments') recordPayment(@Param('id', ParseIntPipe) id: number, @Body() dto: MaterialManualPaymentDto, @Req() req: Request) {
    return this.sales.recordPayment(id, dto, req.user as AuthUser);
  }
  @Post(':id/checkout-session') checkout(@Param('id', ParseIntPipe) id: number, @Req() req: Request) {
    return this.sales.checkoutForAdmin(id, req.user as AuthUser);
  }
  @Roles('admin')
  @Post(':id/checkout-session/cancel') cancelCheckout(@Param('id', ParseIntPipe) id: number, @Req() req: Request) {
    return this.sales.cancelCheckoutForAdmin(id, req.user as AuthUser);
  }
  @Roles('admin')
  @Post(':id/sync-payments') syncPayments(@Param('id', ParseIntPipe) id: number, @Req() req: Request) {
    return this.sales.syncPaymentsForAdmin(id, req.user as AuthUser);
  }
}

@Public()
@Controller('materials/public/sales')
export class MaterialsPublicSalesController {
  constructor(private readonly sales: MaterialsSalesService) {}
  @Get(':token') get(@Param('token') token: string) { return this.sales.getPublic(token); }
  @Post(':token/checkout-session') checkout(@Param('token') token: string, @Req() req: Request) { admitMaterialWrite(req); return this.sales.checkoutForPublic(token); }
  // Returning from Stripe is informational. Only its verified status can record a payment.
}

@Roles('admin', 'operator', 'client', 'dealer')
@Controller('materials')
export class MaterialsCustomerCatalogController {
  constructor(private readonly sales: MaterialsSalesService) {}
  @Get('catalog') catalog(@Req() req: Request, @Query() query: Record<string, string>) { return this.sales.customerCatalog(req.user as AuthUser, query); }
  @Roles('client', 'dealer')
  @Post('orders') order(@Body() dto: CustomerMaterialOrderDto, @Req() req: Request) { admitMaterialWrite(req, 'order'); return this.sales.createCustomerOrder(dto, req.user as AuthUser); }
  @Get('orders') orders(@Req() req: Request, @Query() query: { page?: string; pageSize?: string }) { return this.sales.listCustomerOrders(req.user as AuthUser, query); }
  @Get('orders/:id') getOrder(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.sales.getCustomerOrder(id, req.user as AuthUser); }
  @Post('orders/:id/cancel') cancelOrder(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { admitMaterialWrite(req); return this.sales.cancelCustomerOrder(id, req.user as AuthUser); }
}
