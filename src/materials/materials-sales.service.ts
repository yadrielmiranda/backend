import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { MaterialPayment, PaymentMethod, Prisma } from '@prisma/client';
import Stripe = require('stripe');
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { PrismaService } from '@/prisma/prisma.service';
import { NotificationsService } from '@/notifications/notifications.service';
import type { AuthUser } from '@/auth/types/auth-user.type';
import { MaterialsInventoryService } from './materials-inventory.service';
import { materialAvailability, MaterialStockError } from './materials-stock';
import { allocateMaterialSale } from './materials-sale-allocation';
import { CreateMaterialSaleDto, CustomerMaterialOrderDto, MaterialManualPaymentDto } from './materials-sales.dto';
import { materialCatalogPage, MaterialCatalogQuery } from './materials-catalog';
import { MaterialSaleEmailService } from './material-sale-email.service';

const includeSale = { lines: { include: { store: { select: { id: true, name: true } } }, orderBy: { id: 'asc' as const } }, payments: { orderBy: { id: 'asc' as const } }, store: { select: { id: true, name: true, isActive: true } } } satisfies Prisma.MaterialSaleInclude;
type Sale = Prisma.MaterialSaleGetPayload<{ include: typeof includeSale }>;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const money = (value: Prisma.Decimal | number | string) => new Prisma.Decimal(value);
const cents = (value: Prisma.Decimal | number | string) => {
  const result = money(value).mul(100);
  if (!result.isInteger() || result.lt(0) || !Number.isSafeInteger(result.toNumber())) throw new BadRequestException('Invalid monetary amount.');
  return result.toNumber();
};
const paymentBalance = (sale: { total: Prisma.Decimal; paidAmount: Prisma.Decimal }) => Prisma.Decimal.max(0, sale.total.minus(sale.paidAmount));
const payable = (sale: Sale) => ['CONFIRMED', 'DELIVERED'].includes(sale.status);
const stripeId = (value: string | { id: string } | null | undefined) => typeof value === 'string' ? value : value?.id;
const shoppingRoles = ['admin', 'operator', 'client', 'dealer'];
const customerCheckoutRoles = ['client', 'dealer'];
const accountContactSelect = { id: true, username: true, firstName: true, lastName: true, email: true, phone: true, isActive: true, deletedAt: true, role: { select: { name: true } } } satisfies Prisma.UserSelect;
const accountCustomerName = (account: { firstName?: string | null; lastName?: string | null; username: string }) =>
  Array.from([account.firstName?.trim(), account.lastName?.trim()].filter(Boolean).join(' ') || account.username.trim()).slice(0, 200).join('');

/** Prices are snapshots; sale reservations never alter physical stock until delivery. */
@Injectable()
export class MaterialsSalesService {
  private stripeClient?: Stripe;
  private expiring = false;
  constructor(private readonly prisma: PrismaService, private readonly config: ConfigService, private readonly inventory: MaterialsInventoryService, private readonly notifications: NotificationsService, private readonly saleEmails: MaterialSaleEmailService) {}

  private transaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>) {
    return this.prisma.$transaction(work, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 20000 });
  }

  private get stripe() {
    if (!this.stripeClient) {
      const key = this.config.get<string>('STRIPE_SECRET_KEY');
      if (!key) throw new ConflictException('Stripe payments are not configured.');
      this.stripeClient = new Stripe(key, { apiVersion: '2026-08-26.dahlia', timeout: 20000, maxNetworkRetries: 1 });
    }
    return this.stripeClient;
  }
  private admin(actor: AuthUser) { if (actor?.role?.name !== 'admin') throw new ForbiddenException('Only administrators can manage material sales.'); }
  private staff(actor: AuthUser) { if (!['admin', 'operator'].includes(actor?.role?.name)) throw new ForbiddenException('Only warehouse staff can manage material sales.'); }
  private customer(actor: AuthUser) {
    if (!Number.isSafeInteger(actor?.id) || actor.id <= 0 || !['admin', 'operator', 'client', 'dealer'].includes(actor.role?.name)) {
      throw new ForbiddenException('Sign in with an authorized account to shop for materials.');
    }
  }
  private frontend() { return String(this.config.get('PUBLIC_FRONTEND_URL') || this.config.get('FRONTEND_URL') || 'http://localhost:3000').split(',')[0].replace(/\/+$/, ''); }
  private async sale(db: Prisma.TransactionClient, id: number, lock = false): Promise<Sale> {
    if (lock) await db.$queryRaw`SELECT id FROM material_sales WHERE id = ${id} FOR UPDATE`;
    const sale = await db.materialSale.findUnique({ where: { id }, include: includeSale });
    if (!sale) throw new NotFoundException('Material sale not found.');
    return sale;
  }
  private async tokenSale(token: string) {
    if (!/^[a-f0-9]{64}$/.test(token)) throw new NotFoundException('Material sale not found.');
    const sale = await this.prisma.materialSale.findUnique({ where: { publicToken: token }, include: includeSale });
    if (!sale || sale.status === 'DRAFT') throw new NotFoundException('Material sale not found.');
    return sale;
  }
  private view(sale: Sale, publicView = false) {
    const balance = paymentBalance(sale);
    return {
      id: sale.id, code: sale.code, status: sale.status,
      customerName: sale.customerName, customerEmail: sale.customerEmail, customerPhone: sale.customerPhone,
      subtotal: sale.subtotal.toFixed(2), discountAmount: sale.discountAmount.toFixed(2), taxRate: sale.taxRate.toString(),
      taxAmount: sale.taxAmount.toFixed(2), total: sale.total.toFixed(2), paidAmount: sale.paidAmount.toFixed(2), balance: balance.toFixed(2),
      currency: sale.currency, paymentStatus: balance.eq(0) ? 'PAID' : sale.paidAmount.gt(0) ? 'PARTIAL' : 'UNPAID',
      fulfillmentStatus: sale.status === 'DELIVERED' ? 'DELIVERED' : sale.status === 'CANCELED' ? 'CANCELED' : 'PENDING',
      lines: sale.lines.map(l => ({ id: l.id, productId: l.productId, presentationId: l.presentationId, productName: l.productName, productCode: l.productCode, presentationName: l.presentationName, multiplier: l.multiplier, quantity: l.quantity, unitPrice: l.unitPrice.toFixed(2), lineTotal: l.lineTotal.toFixed(2), ...(!publicView ? { storeId: l.storeId, storeName: l.store?.name ?? sale.store.name } : {}) })),
      payments: sale.payments.map(p => ({ id: p.id, receiptCode: `MR-${p.id}`, status: p.status, source: p.source, amount: p.amount.toFixed(2), refundedAmount: p.refundedAmount.toFixed(2), paymentMethod: p.paymentMethod, paidAt: p.paidAt, createdAt: p.createdAt, ...(!publicView ? { reference: p.reference, note: p.note } : {}) })),
      createdAt: sale.createdAt, confirmedAt: sale.confirmedAt, deliveredAt: sale.deliveredAt, canceledAt: sale.canceledAt, expiresAt: sale.expiresAt,
      ...(!publicView ? { customerUserId: sale.customerUserId, storeId: sale.storeId, store: { id: sale.store.id, name: sale.store.name }, note: sale.note, requireFullPayment: sale.requireFullPayment, publicToken: sale.publicToken, publicUrl: `${this.frontend()}/public/material-sales/${sale.publicToken}`, version: sale.version } : {}),
    };
  }
  async list(actor: AuthUser, query: { q?: string } = {}) {
    this.staff(actor);
    const q = String(query.q ?? '').trim().slice(0, 200);
    const where: Prisma.MaterialSaleWhereInput = q ? { OR: [{ code: { contains: q } }, { customerName: { contains: q } }, { customerEmail: { contains: q } }] } : {};
    return (await this.prisma.materialSale.findMany({ where, include: includeSale, orderBy: { id: 'desc' }, take: 200 })).map(s => this.view(s));
  }
  async get(id: number, actor: AuthUser) { this.staff(actor); return this.view(await this.sale(this.prisma, id)); }
  async getPublic(token: string) { return this.view(await this.tokenSale(token), true); }

  async searchCustomers(actor: AuthUser, query: { q?: string } = {}) {
    this.staff(actor);
    const q = String(query.q ?? '').trim().slice(0, 200);
    if (q.length < 2) return [];
    const accounts = await this.prisma.user.findMany({
      where: { isActive: true, deletedAt: null, role: { name: { in: shoppingRoles } },
        AND: q.split(/\s+/).filter(Boolean).map(term => ({ OR: [
          { firstName: { contains: term } }, { lastName: { contains: term } }, { username: { contains: term } }, { email: { contains: term } },
        ] })),
      },
      select: { id: true, username: true, firstName: true, lastName: true, email: true, phone: true },
      orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }, { id: 'asc' }], take: 20,
    });
    return accounts.map(account => ({ id: account.id, name: accountCustomerName(account), email: account.email, phone: account.phone }));
  }

  private assertCustomerOwner(sale: Sale, actor: AuthUser) {
    // A payment link permits viewing/paying, but never grants cancellation rights.
    if (sale.customerUserId !== actor.id || sale.status === 'DRAFT') throw new NotFoundException('Material order not found.');
  }
  private hasReceivedPayment(sale: Sale) {
    return sale.paidAmount.gt(0) || sale.payments.some(payment => payment.status === 'PAID' || payment.paidAt || payment.refundedAmount.gt(0));
  }
  private customerOrderView(sale: Sale) {
    return { ...this.view(sale, true), publicUrl: `${this.frontend()}/public/material-sales/${sale.publicToken}`, canCancel: sale.status === 'CONFIRMED' && !!sale.expiresAt && !this.hasReceivedPayment(sale) };
  }
  async getCustomerOrder(id: number, actor: AuthUser) {
    this.customer(actor);
    const sale = await this.sale(this.prisma, id);
    this.assertCustomerOwner(sale, actor);
    return this.customerOrderView(sale);
  }

  async listCustomerOrders(actor: AuthUser, query: { page?: string; pageSize?: string } = {}) {
    this.customer(actor);
    const integer = (value: string | undefined, fallback: number, max: number) => {
      if (value === undefined) return fallback;
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed < 1) throw new BadRequestException('Enter a valid order page and page size.');
      return Math.min(parsed, max);
    };
    const page = integer(query.page, 1, 1_000_000), pageSize = integer(query.pageSize, 20, 50);
    return this.prisma.$transaction(async tx => {
      const where: Prisma.MaterialSaleWhereInput = { customerUserId: actor.id, status: { not: 'DRAFT' } };
      const total = await tx.materialSale.count({ where });
      const sales = await tx.materialSale.findMany({ where, include: includeSale, orderBy: { id: 'desc' }, take: pageSize, skip: (page - 1) * pageSize });
      return { items: sales.map(sale => this.customerOrderView(sale)), total, page, pageSize };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 20000 });
  }

  private assertCustomerCancellation(sale: Sale) {
    if (this.hasReceivedPayment(sale)) throw new ConflictException('This order has received a payment. Contact the store for assistance.');
    // Only catalog orders receive an expiry; staff-created sales use their own workflow.
    if (!sale.expiresAt) throw new ConflictException('This order cannot be canceled online. Contact the store for assistance.');
    if (!['CONFIRMED', 'CANCELED'].includes(sale.status)) throw new ConflictException('Only an unpaid, undelivered order can be canceled.');
  }

  async cancelCustomerOrder(id: number, actor: AuthUser) {
    this.customer(actor);
    const initial = await this.sale(this.prisma, id);
    this.assertCustomerOwner(initial, actor);
    this.assertCustomerCancellation(initial);
    if (initial.status === 'CANCELED') return this.customerOrderView(initial);

    // Resolve even an unlinked attempt using its durable Stripe idempotency key.
    // Unknown/processing provider states throw and keep the inventory reserved.
    await this.cancelCheckout(id);
    return this.transaction(async tx => {
      const sale = await this.sale(tx, id, true);
      this.assertCustomerOwner(sale, actor);
      this.assertCustomerCancellation(sale);
      if (sale.status === 'CANCELED') return this.customerOrderView(sale);
      // Checkout creation and webhook reconciliation also lock this sale row.
      // A new attempt since cancelCheckout's snapshot must prevent release.
      if (sale.payments.some(payment => payment.status === 'PENDING')) throw new ConflictException('A Stripe payment is still processing. Try again after its final status is confirmed.');
      await this.inventory.lockProducts(tx, sale.lines.map(line => line.productId));
      await tx.materialSale.update({ where: { id }, data: { status: 'CANCELED', canceledAt: new Date(), version: { increment: 1 } } });
      await this.audit(tx, id, actor.id, 'Customer canceled an unpaid material order; inventory reservations released.');
      return this.customerOrderView(await this.sale(tx, id));
    });
  }

  private async taxTerms(tx: Prisma.TransactionClient, subtotal: Prisma.Decimal) {
    const setting = await tx.globalParameter.findUnique({ where: { key: 'SALES_TAX' } });
    if (!setting) throw new ConflictException('The sales tax setting is missing.');
    const fraction = money(setting.value);
    if (!fraction.isFinite() || fraction.lt(0) || fraction.gt(1)) throw new ConflictException('The sales tax setting is invalid.');
    const taxRate = fraction.mul(100), taxAmount = subtotal.mul(fraction).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
    return { taxRate, taxAmount, total: subtotal.add(taxAmount) };
  }

  async customerCatalog(actor: AuthUser, query: MaterialCatalogQuery = {}) {
    this.customer(actor);
    return this.prisma.$transaction(tx => this.catalogSnapshot(tx, query), { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 20000 });
  }

  private async catalogSnapshot(tx: Prisma.TransactionClient, query: MaterialCatalogQuery) {
    const [catalog, taxes] = await Promise.all([
      materialCatalogPage(tx, query),
      this.taxTerms(tx, money(0)),
    ]);
    return { taxRate: taxes.taxRate.toString(), currency: 'usd', ...catalog };
  }

  async createCustomerOrder(dto: CustomerMaterialOrderDto, actor: AuthUser) {
    this.customer(actor);
    if (!customerCheckoutRoles.includes(actor.role.name)) throw new ForbiddenException('Staff must select a customer and create a material sale.');
    // Recheck even when replaying a prior request; staff may browse the catalog,
    // but their account must never become the implicit buyer of a new sale.
    const account = await this.prisma.user.findUnique({ where: { id: actor.id }, select: accountContactSelect });
    if (!account?.isActive || account.deletedAt || !customerCheckoutRoles.includes(account.role.name)) throw new ForbiddenException('This account cannot place material orders.');
    // Bind retries to the account and cart, not to editable profile details.
    const request = { requestKey: dto.requestKey, lines: dto.lines?.map(line => ({ presentationId: line.presentationId, quantity: line.quantity })) };
    return this.inventory.operation(dto.requestKey, request, actor.id, 'CUSTOMER_SALE_CREATE', async tx => {
      if (!dto.lines?.length || dto.lines.length > 100) throw new BadRequestException('Choose material quantities.');
      const customerName = accountCustomerName(account);
      const ids = dto.lines.map(l => l.presentationId);
      if (new Set(ids).size !== ids.length) throw new BadRequestException('Combine repeated presentations into one line.');
      const initial = await tx.materialPresentation.findMany({ where: { id: { in: ids } } });
      if (initial.length !== ids.length) throw new BadRequestException('An item in your cart is no longer available.');
      await this.inventory.lockProducts(tx, initial.map(p => p.productId));
      const presentations = await tx.materialPresentation.findMany({ where: { id: { in: ids } }, include: { product: true } });
      const stores = await tx.warehouseStore.findMany({ where: { isActive: true }, orderBy: { id: 'asc' } });
      if (!stores.length) throw new ConflictException('Materials are not currently available for pickup.');
      await this.inventory.lockStores(tx, stores.map(store => store.id));
      const activeForAccount = await tx.materialSale.count({ where: { customerUserId: actor.id, expiresAt: { not: null }, status: 'CONFIRMED', paidAmount: 0 } });
      if (activeForAccount >= 5) throw new ConflictException('You already have pending material orders. Complete or wait for those checkouts to expire first.');
      const lines: Prisma.MaterialSaleLineCreateWithoutSaleInput[] = [];
      for (const input of dto.lines) {
        const p = presentations.find(p => p.id === input.presentationId)!;
        if (!p.isActive || !p.isSaleEnabled || !p.product.isActive || !p.product.isSaleEnabled || !p.salePrice?.gt(0)) throw new ConflictException('An item in your cart is no longer available for sale.');
        if (!Number.isSafeInteger(input.quantity) || input.quantity < 1 || input.quantity > 1000000) throw new BadRequestException('Material quantities must be positive whole numbers.');
      }
      for (const productId of [...new Set(presentations.map(p => p.productId))].sort((a, b) => a - b)) {
        const locations = [];
        for (const store of stores) locations.push({ storeId: store.id, stock: await this.inventory.loadStock(tx, productId, store.id) });
        const requested = dto.lines.filter(line => presentations.find(p => p.id === line.presentationId)!.productId === productId);
        for (const allocation of allocateMaterialSale(locations, requested)) {
          const p = presentations.find(p => p.id === allocation.presentationId)!;
          const { quantity, storeId } = allocation;
          lines.push({ product: { connect: { id: p.productId } }, presentation: { connect: { id: p.id } }, store: { connect: { id: storeId } }, productName: p.product.name, productCode: p.product.code, presentationName: p.name, multiplier: p.multiplier, quantity, unitPrice: p.salePrice, lineTotal: p.salePrice.mul(quantity) });
        }
      }
      const subtotal = lines.reduce((sum, line) => sum.add(String(line.lineTotal)), money(0));
      const { taxRate, taxAmount, total } = await this.taxTerms(tx, subtotal);
      if (total.gt('9999999999.99')) throw new BadRequestException('The sale total exceeds the supported limit.');
      const sale = await tx.materialSale.create({ data: {
        code: `MS-${randomBytes(6).toString('hex').toUpperCase()}`, publicToken: randomBytes(32).toString('hex'), storeId: Number(lines[0].store.connect.id),
        customerUserId: actor.id, customerName, customerEmail: account.email?.trim().toLowerCase() || null, customerPhone: account.phone?.trim() || null,
        subtotal, taxRate, taxAmount, total, status: 'CONFIRMED', confirmedAt: new Date(), expiresAt: new Date(Date.now() + 30 * 60000),
        requireFullPayment: true, createdById: actor.id, lines: { create: lines },
      }, include: includeSale });
      return { ...this.view(sale, true), publicUrl: `${this.frontend()}/public/material-sales/${sale.publicToken}` };
    });
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async expireUnpaidOnlineOrders() {
    if (this.expiring) return;
    this.expiring = true;
    try {
      const expired = await this.prisma.materialSale.findMany({ where: { status: 'CONFIRMED', paidAmount: 0, expiresAt: { lte: new Date() } }, select: { id: true }, take: 50, orderBy: { expiresAt: 'asc' } });
      for (const item of expired) {
        try {
          // A reservation is released only after every provider checkout has a terminal state.
          await this.cancelCheckout(item.id);
          await this.transaction(async tx => {
            const sale = await this.sale(tx, item.id, true);
            if (sale.status !== 'CONFIRMED' || sale.paidAmount.gt(0) || !sale.expiresAt || sale.expiresAt > new Date() || sale.payments.some(p => p.status === 'PENDING')) return;
            await this.inventory.lockProducts(tx, sale.lines.map(l => l.productId));
            await tx.materialSale.update({ where: { id: sale.id }, data: { status: 'CANCELED', canceledAt: new Date(), version: { increment: 1 } } });
          });
        } catch { /* Keep reservations when Stripe is unavailable or its payment is processing. */ }
      }
    } finally { this.expiring = false; }
  }

  async create(dto: CreateMaterialSaleDto, actor: AuthUser) {
    this.staff(actor);
    return this.inventory.operation(dto.requestKey, dto, actor.id, 'SALE_CREATE', async tx => {
      const store = await tx.warehouseStore.findUnique({ where: { id: dto.storeId } });
      if (!store?.isActive) throw new BadRequestException('Choose an active Store.');
      if (!dto.lines?.length || dto.lines.length > 100) throw new BadRequestException('Sale lines are required.');
      let contact: { customerUserId: number | null; customerName: string; customerEmail: string | null; customerPhone: string | null };
      if (dto.customerUserId != null) {
        if (!Number.isSafeInteger(dto.customerUserId) || dto.customerUserId <= 0) throw new BadRequestException('Choose a valid customer account.');
        if (dto.customerName !== undefined || dto.customerEmail !== undefined || dto.customerPhone !== undefined) throw new BadRequestException('Choose a registered customer or enter manual customer details, not both.');
        const account = await tx.user.findUnique({ where: { id: dto.customerUserId }, select: accountContactSelect });
        if (!account?.isActive || account.deletedAt || !shoppingRoles.includes(account.role.name)) throw new BadRequestException('Choose an active customer account authorized to purchase materials.');
        contact = { customerUserId: account.id, customerName: accountCustomerName(account), customerEmail: account.email?.trim().toLowerCase() || null, customerPhone: account.phone?.trim() || null };
      } else {
        if (!dto.customerName?.trim()) throw new BadRequestException('Enter the customer name.');
        contact = { customerUserId: null, customerName: dto.customerName.trim(), customerEmail: dto.customerEmail?.trim().toLowerCase() || null, customerPhone: dto.customerPhone?.trim() || null };
      }
      const ids = dto.lines.map(l => l.presentationId);
      if (new Set(ids).size !== ids.length) throw new BadRequestException('Combine repeated presentations into one sale line.');
      const presentations = await tx.materialPresentation.findMany({ where: { id: { in: ids } }, include: { product: true } });
      if (presentations.length !== ids.length) throw new BadRequestException('Unknown material presentation.');
      await this.inventory.lockProducts(tx, presentations.map(p => p.productId));
      await this.inventory.lockStores(tx, [dto.storeId]);
      // Re-read under the product locks used by catalog edits and stock operations.
      const locked = await tx.materialPresentation.findMany({ where: { id: { in: ids } }, include: { product: true } });
      const lines = dto.lines.map(input => {
        const p = locked.find(p => p.id === input.presentationId)!;
        if (!p.isActive || !p.isSaleEnabled || !p.product.isActive || !p.product.isSaleEnabled || !p.salePrice?.gt(0)) throw new BadRequestException(`${p.product.name}: this presentation is not enabled for sale with a positive price.`);
        if (!Number.isSafeInteger(input.quantity) || input.quantity < 1 || input.quantity > 1000000) throw new BadRequestException('Sale quantities must be positive whole numbers.');
        return { storeId: dto.storeId, productId: p.productId, presentationId: p.id, productName: p.product.name, productCode: p.product.code, presentationName: p.name, multiplier: p.multiplier, quantity: input.quantity, unitPrice: p.salePrice, lineTotal: p.salePrice.mul(input.quantity) };
      });
      const subtotal = lines.reduce((sum, line) => sum.add(line.lineTotal), money(0));
      const { taxRate, taxAmount, total } = await this.taxTerms(tx, subtotal);
      if (total.gt('9999999999.99')) throw new BadRequestException('The sale total exceeds the supported limit.');
      const sale = await tx.materialSale.create({ data: {
        code: `MS-${randomBytes(6).toString('hex').toUpperCase()}`, publicToken: randomBytes(32).toString('hex'), storeId: dto.storeId,
        ...contact,
        note: dto.note?.trim() || null, subtotal, discountAmount: 0, taxRate, taxAmount, total, requireFullPayment: true,
        createdById: actor.id, lines: { create: lines },
      }, include: includeSale });
      return this.view(sale);
    });
  }

  async confirm(id: number, actor: AuthUser) {
    this.staff(actor);
    return this.transaction(async tx => {
      const sale = await this.sale(tx, id, true);
      if (sale.status === 'CONFIRMED' || sale.status === 'DELIVERED') return this.view(sale);
      if (sale.status !== 'DRAFT') throw new ConflictException('Only a draft sale can be confirmed.');
      if (!sale.store.isActive) throw new ConflictException('The Store is inactive.');
      const productIds = [...new Set(sale.lines.map(l => l.productId))];
      await this.inventory.lockProducts(tx, productIds);
      await this.inventory.lockStores(tx, sale.lines.map(l => l.storeId));
      const presentations = await tx.materialPresentation.findMany({ where: { id: { in: sale.lines.map(l => l.presentationId) } }, include: { product: true } });
      for (const line of sale.lines) {
        const p = presentations.find(p => p.id === line.presentationId);
        if (!p?.isActive || !p.isSaleEnabled || !p.product.isActive || !p.product.isSaleEnabled || p.multiplier !== line.multiplier) throw new ConflictException('A product or presentation in this draft is no longer available.');
      }
      try {
        const groups = new Map(sale.lines.map(l => [`${l.productId}:${l.storeId}`, { productId: l.productId, storeId: l.storeId }]));
        for (const { productId, storeId } of groups.values()) {
          const stock = await this.inventory.loadStock(tx, productId, storeId, sale.id);
          materialAvailability({ ...stock, reservations: [...stock.reservations, ...sale.lines.filter(l => l.productId === productId && l.storeId === storeId).map(l => ({ presentationId: l.presentationId, quantity: l.quantity }))] });
        }
      } catch (error) { if (error instanceof MaterialStockError) throw new ConflictException(error.message); throw error; }
      await tx.materialSale.update({ where: { id }, data: { status: 'CONFIRMED', confirmedAt: new Date(), version: { increment: 1 } } });
      await this.audit(tx, id, actor.id, 'Material sale confirmed; inventory reserved.');
      return this.view(await this.sale(tx, id));
    });
  }

  async deliver(id: number, requestKey: string, actor: AuthUser) {
    this.staff(actor);
    return this.inventory.operation(requestKey, { id }, actor.id, 'SALE_DELIVERY', async tx => {
      const sale = await this.sale(tx, id, true);
      if (sale.status === 'DELIVERED') return this.view(sale);
      if (sale.status !== 'CONFIRMED') throw new ConflictException('Only a confirmed sale can be delivered.');
      if (sale.requireFullPayment && paymentBalance(sale).gt(0)) throw new ConflictException('Full payment is required before delivery.');
      await this.inventory.deliverSale(tx, sale, requestKey, actor.id);
      await tx.materialSale.update({ where: { id }, data: { status: 'DELIVERED', deliveredAt: new Date(), version: { increment: 1 } } });
      await this.audit(tx, id, actor.id, 'Material sale delivered.');
      return this.view(await this.sale(tx, id));
    });
  }

  async cancel(id: number, actor: AuthUser) {
    this.staff(actor);
    await this.cancelCheckout(id);
    return this.transaction(async tx => {
      const sale = await this.sale(tx, id, true);
      if (sale.status === 'CANCELED') return this.view(sale);
      if (sale.status === 'DELIVERED') throw new ConflictException('Delivered sales cannot be canceled.');
      if (sale.paidAmount.gt(0)) throw new ConflictException('This sale has received payments. Refund them before canceling.');
      if (sale.payments.some(p => p.status === 'PENDING')) throw new ConflictException('A Stripe payment is still processing. Try again after its final status is confirmed.');
      await this.inventory.lockProducts(tx, sale.lines.map(l => l.productId));
      await tx.materialSale.update({ where: { id }, data: { status: 'CANCELED', canceledAt: new Date(), version: { increment: 1 } } });
      await this.audit(tx, id, actor.id, 'Material sale canceled; inventory reservations released.');
      return this.view(await this.sale(tx, id));
    });
  }

  async recordPayment(id: number, dto: MaterialManualPaymentDto, actor: AuthUser) {
    this.admin(actor);
    if (!dto.fundsVerified || dto.paymentMethod === PaymentMethod.CARD) throw new BadRequestException('Verify received funds; card payments must be confirmed through Stripe.');
    const amount = money(dto.amount);
    if (!amount.isFinite() || amount.lte(0) || amount.decimalPlaces() > 2) throw new BadRequestException('Enter a positive payment amount with at most two decimals.');
    const requestHash = hash({ saleId: id, amount: amount.toFixed(2), paymentMethod: dto.paymentMethod, reference: dto.reference || null, note: dto.note || null, paidAt: dto.paidAt || null, actorId: actor.id });
    return this.transaction(async tx => {
      const sale = await this.sale(tx, id, true);
      const existing = await tx.materialPayment.findUnique({ where: { requestKey: dto.requestKey } });
      if (existing) {
        if (existing.requestHash !== requestHash || existing.saleId !== id) throw new ConflictException('This payment request was already used for different information.');
        return this.view(sale);
      }
      if (!payable(sale)) throw new ConflictException('Confirm the sale before receiving payment.');
      if (sale.payments.some(p => p.status === 'PENDING')) throw new ConflictException('Close the active Stripe checkout before recording another payment.');
      if (amount.gt(paymentBalance(sale))) throw new BadRequestException('The payment exceeds the outstanding balance.');
      const paidAt = dto.paidAt ? new Date(dto.paidAt) : new Date();
      if (!Number.isFinite(paidAt.getTime()) || paidAt.getTime() > Date.now() + 60000) throw new BadRequestException('The payment date cannot be in the future.');
      await tx.materialPayment.create({ data: { saleId: id, requestKey: dto.requestKey, requestHash, status: 'PAID', source: 'MANUAL', amount, paymentMethod: dto.paymentMethod, reference: dto.reference?.trim() || null, note: dto.note?.trim() || null, recordedById: actor.id, paidAt } });
      await this.refreshPaid(tx, id);
      await this.audit(tx, id, actor.id, `Material payment received: $${amount.toFixed(2)} (${dto.paymentMethod}).`);
      return this.view(await this.sale(tx, id));
    });
  }

  async checkoutForAdmin(id: number, actor: AuthUser) { this.staff(actor); return this.checkout(id); }
  async checkoutForPublic(token: string) { return this.checkout((await this.tokenSale(token)).id); }
  async cancelCheckoutForAdmin(id: number, actor: AuthUser) { this.admin(actor); await this.cancelCheckout(id); return this.get(id, actor); }

  async syncPaymentsForAdmin(id: number, actor: AuthUser) {
    this.admin(actor);
    const sale = await this.sale(this.prisma, id);
    for (const payment of sale.payments.filter(p => p.source === 'STRIPE' && p.status === 'PENDING')) {
      if (payment.stripeSessionId) {
        const session = await this.stripe.checkout.sessions.retrieve(payment.stripeSessionId);
        this.validateSession(payment, sale, session);
        await this.reconcileSession(session);
      } else if (Date.now() - payment.createdAt.getTime() > 23 * 3600000) {
        await this.recoverUnlinkedCheckout(sale, payment, actor.id);
      }
    }
    return this.get(id, actor);
  }

  /** Recover an unknown create response without ever issuing another chargeable session. */
  private async recoverUnlinkedCheckout(sale: Sale, payment: MaterialPayment, actorId: number) {
    const beginning = Math.floor(payment.createdAt.getTime() / 1000) - 300;
    // resolveCheckout refuses new create calls after 23 hours. The margin tolerates provider clock skew.
    const end = Math.ceil((payment.createdAt.getTime() + 23 * 3600000) / 1000) + 300;
    const matches = new Map<string, Stripe.Checkout.Session>();
    const visitedCursors = new Set<string>();
    let cursor: string | undefined, complete = false;
    for (let page = 0; page < 100; page++) {
      const sessions = await this.stripe.checkout.sessions.list({ limit: 100, created: { gte: beginning, lte: end }, ...(cursor ? { starting_after: cursor } : {}) });
      for (const session of sessions.data) {
        if (session.metadata?.materialSaleId === String(sale.id) && session.metadata?.materialPaymentId === String(payment.id)) matches.set(session.id, session);
      }
      if (matches.size > 1) throw new ConflictException('Multiple Stripe sessions match this payment attempt. Keep the payment blocked and review the sessions in Stripe.');
      if (!sessions.has_more) { complete = true; break; }
      cursor = sessions.data[sessions.data.length - 1]?.id;
      if (!cursor || visitedCursors.has(cursor)) throw new ConflictException('Stripe returned an incomplete checkout search. The payment remains pending.');
      visitedCursors.add(cursor);
    }
    if (!complete) throw new ConflictException('The Stripe checkout search could not be completed. The payment remains pending.');
    const match = [...matches.values()][0];
    if (match) {
      const session = await this.stripe.checkout.sessions.retrieve(match.id);
      await this.linkCheckout(sale, payment, session);
      await this.reconcileSession(session);
      await this.transaction(tx => this.audit(tx, sale.id, actorId, `Recovered Stripe session for material payment ${payment.id}.`));
      return;
    }
    await this.transaction(async tx => {
      await this.sale(tx, sale.id, true);
      const current = await tx.materialPayment.findUniqueOrThrow({ where: { id: payment.id } });
      // A concurrent webhook or recovery always takes precedence over an empty earlier search.
      if (current.status !== 'PENDING' || current.stripeSessionId) return;
      await tx.materialPayment.update({ where: { id: payment.id }, data: { status: 'FAILED', checkoutUrl: null } });
      await this.audit(tx, sale.id, actorId, `Stripe search confirmed no checkout for material payment ${payment.id}; the payment attempt was closed.`);
    });
  }

  private async checkout(id: number): Promise<{ url: string; sessionId: string }> {
    const { sale, payment } = await this.transaction(async tx => {
      const sale = await this.sale(tx, id, true);
      if (!payable(sale)) throw new ConflictException('This sale is not available for payment.');
      if (sale.paidAmount.eq(0) && sale.expiresAt && sale.expiresAt <= new Date()) throw new ConflictException('This online reservation has expired. Start a new order after its inventory is released.');
      const balance = paymentBalance(sale);
      if (balance.lte(0)) throw new ConflictException('This sale is already paid.');
      if (balance.lt('0.50') || balance.gt('999999.99')) throw new BadRequestException('Stripe card payments must be between $0.50 and $999,999.99. Please contact the store for another payment method.');
      let payment = sale.payments.find(p => p.status === 'PENDING');
      if (!payment) {
        const key = randomUUID();
        payment = await tx.materialPayment.create({ data: { saleId: id, requestKey: key, requestHash: hash({ id, balance: balance.toFixed(2), key }), source: 'STRIPE', paymentMethod: 'CARD', amount: balance, expiresAt: new Date(Date.now() + 60 * 60000) } });
      }
      return { sale, payment };
    });
    const session = await this.resolveCheckout(sale, payment);
    this.validateSession(payment, sale, session);
    if (session.payment_status === 'paid' || session.status === 'expired') {
      await this.reconcileSession(session);
      if (session.payment_status === 'paid') throw new ConflictException('Payment confirmed. Refresh the sale.');
      return this.checkout(id);
    }
    if (session.status !== 'open' || !session.url) throw new ConflictException('A Stripe payment is processing. Wait for its final confirmation.');
    return { url: session.url, sessionId: session.id };
  }

  private async resolveCheckout(sale: Sale, payment: MaterialPayment): Promise<Stripe.Checkout.Session> {
    if (payment.stripeSessionId) return this.stripe.checkout.sessions.retrieve(payment.stripeSessionId);
    if (Date.now() - payment.createdAt.getTime() > 23 * 3600000) throw new ConflictException('An administrator must sync Stripe payments for this sale before another payment can be opened.');
    const returnUrl = `${this.frontend()}/public/material-sales/${sale.publicToken}`;
    let session: Stripe.Checkout.Session;
    try {
      session = await this.stripe.checkout.sessions.create({
        mode: 'payment', payment_method_types: ['card'], customer_email: sale.customerEmail || undefined,
        client_reference_id: sale.code, success_url: `${returnUrl}?payment=returned`, cancel_url: `${returnUrl}?payment=canceled`,
        expires_at: Math.floor(payment.expiresAt.getTime() / 1000),
        metadata: { materialSaleId: String(sale.id), materialPaymentId: String(payment.id) },
        payment_intent_data: { metadata: { materialSaleId: String(sale.id), materialPaymentId: String(payment.id) } },
        line_items: [{ quantity: 1, price_data: { currency: payment.currency, unit_amount: cents(payment.amount), product_data: { name: `Materials sale ${sale.code}`, description: `Outstanding balance for ${sale.customerName}` } } }],
      }, { idempotencyKey: `materials:${payment.requestKey}` });
    } catch (error) {
      // Network/unknown failures keep the durable attempt: retrying reuses Stripe's idempotency key.
      if (error?.type === 'StripeInvalidRequestError' && error?.code !== 'idempotency_key_in_use') {
        await this.transaction(async tx => {
          await this.sale(tx, sale.id, true);
          await tx.materialPayment.updateMany({ where: { id: payment.id, status: 'PENDING', stripeSessionId: null }, data: { status: 'FAILED' } });
        });
      }
      throw error;
    }
    await this.linkCheckout(sale, payment, session);
    return session;
  }

  private async linkCheckout(sale: Sale, payment: MaterialPayment, session: Stripe.Checkout.Session) {
    this.validateSession(payment, sale, session);
    await this.transaction(async tx => {
      await this.sale(tx, sale.id, true);
      const current = await tx.materialPayment.findUniqueOrThrow({ where: { id: payment.id } });
      this.validateSession(current, sale, session);
      await tx.materialPayment.update({ where: { id: payment.id }, data: { stripeSessionId: session.id, checkoutUrl: current.status === 'PAID' ? null : session.url, stripePaymentIntentId: stripeId(session.payment_intent) || current.stripePaymentIntentId || null } });
    });
  }

  private validateSession(payment: MaterialPayment, sale: Sale, session: Stripe.Checkout.Session) {
    if (session.mode !== 'payment' || session.metadata?.materialSaleId !== String(sale.id) || session.metadata?.materialPaymentId !== String(payment.id) || session.currency !== payment.currency || session.amount_total !== cents(payment.amount) || payment.source !== 'STRIPE' || payment.saleId !== sale.id || payment.stripeSessionId && payment.stripeSessionId !== session.id) throw new ConflictException('Stripe checkout amount or ownership does not match this material payment.');
    const intentId = stripeId(session.payment_intent);
    if (payment.stripePaymentIntentId && intentId && payment.stripePaymentIntentId !== intentId) throw new ConflictException('Stripe payment intent does not match this material payment.');
  }

  private async cancelCheckout(id: number) {
    const sale = await this.sale(this.prisma, id);
    for (const payment of sale.payments.filter(p => p.status === 'PENDING')) {
      let session = await this.resolveCheckout(sale, payment);
      this.validateSession(payment, sale, session);
      if (session.status === 'open') {
        try { session = await this.stripe.checkout.sessions.expire(session.id); }
        catch { session = await this.stripe.checkout.sessions.retrieve(session.id); }
      }
      await this.reconcileSession(session);
      if (session.status !== 'expired' && session.payment_status !== 'paid') throw new ConflictException('The Stripe payment is processing; its reservation must remain until confirmation.');
    }
  }

  /** Called only after PaymentsService has verified the webhook signature. */
  async handleVerifiedStripeEvent(event: Stripe.Event): Promise<boolean> {
    if (event.type.startsWith('checkout.session.')) {
      const eventSession = event.data.object as Stripe.Checkout.Session;
      if (!eventSession.metadata?.materialSaleId) return false;
      if (!['checkout.session.completed', 'checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed', 'checkout.session.expired'].includes(event.type)) return true;
      // Retrieve the current provider state so late failure/expiry events cannot undo a paid receipt.
      const session = await this.stripe.checkout.sessions.retrieve(eventSession.id);
      await this.reconcileSession(session, event.type === 'checkout.session.async_payment_failed');
      return true;
    }
    if (['refund.created', 'refund.updated', 'refund.failed', 'charge.refunded', 'charge.updated'].includes(event.type)) {
      const object = event.data.object as Stripe.Refund | Stripe.Charge;
      const chargeId = object.object === 'charge' ? object.id : stripeId(object.charge);
      if (chargeId) return this.reconcileCharge(chargeId);
    }
    return false;
  }

  private async reconcileSession(session: Stripe.Checkout.Session, failed = false) {
    const id = Number(session.metadata?.materialSaleId), paymentId = Number(session.metadata?.materialPaymentId);
    if (!Number.isSafeInteger(id) || id < 1 || !Number.isSafeInteger(paymentId) || paymentId < 1) throw new BadRequestException('Invalid material payment metadata.');
    return this.transaction(async tx => {
      const sale = await this.sale(tx, id, true);
      const payment = await tx.materialPayment.findUnique({ where: { id: paymentId } });
      if (!payment) throw new NotFoundException('Material payment attempt not found.');
      this.validateSession(payment, sale, session);
      if (payment.status === 'PAID') return;
      const intentId = stripeId(session.payment_intent);
      if (session.payment_status === 'paid') {
        if (session.status !== 'complete' || !intentId) throw new ConflictException('Stripe has not completed this payment.');
        if (!payable(sale)) throw new ConflictException('A payment arrived for a sale that is not payable.');
        if (payment.amount.gt(paymentBalance(sale))) throw new ConflictException('The Stripe payment exceeds the remaining material sale balance.');
        await tx.materialPayment.update({ where: { id: paymentId }, data: { status: 'PAID', stripeSessionId: session.id, stripePaymentIntentId: intentId, paidAt: new Date(), checkoutUrl: null } });
        await this.refreshPaid(tx, id);
      } else if (session.status === 'expired' || failed) {
        await tx.materialPayment.update({ where: { id: paymentId }, data: { status: session.status === 'expired' ? 'EXPIRED' : 'FAILED', stripeSessionId: session.id, stripePaymentIntentId: intentId || null, checkoutUrl: null } });
      }
    });
  }

  private async reconcileCharge(chargeId: string): Promise<boolean> {
    const charge = await this.stripe.charges.retrieve(chargeId);
    const intentId = stripeId(charge.payment_intent);
    if (!intentId) return false;
    let payment = await this.prisma.materialPayment.findFirst({ where: { OR: [{ stripeChargeId: chargeId }, { stripePaymentIntentId: intentId }] } });
    if (!payment) {
      const intent = await this.stripe.paymentIntents.retrieve(intentId);
      const paymentId = Number(intent.metadata?.materialPaymentId);
      if (!intent.metadata?.materialSaleId || !Number.isSafeInteger(paymentId) || paymentId < 1) return false;
      payment = await this.prisma.materialPayment.findUnique({ where: { id: paymentId } });
      if (!payment || String(payment.saleId) !== intent.metadata.materialSaleId) throw new ConflictException('Refund ownership does not match the material payment.');
      const sessions = await this.stripe.checkout.sessions.list({ payment_intent: intentId, limit: 100 });
      const session = sessions.data.find(s => s.metadata?.materialPaymentId === String(payment.id));
      if (!session) throw new ConflictException('Stripe checkout for this material refund has not been found.');
      await this.reconcileSession(session);
    }
    if (charge.currency !== payment.currency || charge.amount !== cents(payment.amount)) throw new ConflictException('Stripe refund amount or currency does not match the material payment.');
    let refundedCents = 0, startingAfter: string | undefined;
    do {
      const refunds = await this.stripe.refunds.list({ charge: charge.id, limit: 100, ...(startingAfter ? { starting_after: startingAfter } : {}) });
      for (const refund of refunds.data) {
        if (refund.status !== 'succeeded') continue;
        if (refund.currency !== payment.currency || !Number.isSafeInteger(refund.amount) || refund.amount < 0) throw new ConflictException('Stripe refund currency or amount is invalid.');
        refundedCents += refund.amount;
      }
      startingAfter = refunds.has_more ? refunds.data[refunds.data.length - 1]?.id : undefined;
      if (refunds.has_more && !startingAfter) throw new ConflictException('Stripe returned an incomplete refund page.');
    } while (startingAfter);
    await this.transaction(async tx => {
      await this.sale(tx, payment.saleId, true);
      const current = await tx.materialPayment.findUniqueOrThrow({ where: { id: payment.id } });
      if (current.status !== 'PAID') throw new ConflictException('The original material payment must be confirmed before its refund.');
      const refunded = Prisma.Decimal.max(current.refundedAmount, money(refundedCents).div(100));
      if (refunded.gt(current.amount)) throw new ConflictException('The refund exceeds its original payment.');
      await tx.materialPayment.update({ where: { id: payment.id }, data: { refundedAmount: refunded, stripeChargeId: charge.id } });
      await this.refreshPaid(tx, payment.saleId, false);
    });
    return true;
  }

  private async refreshPaid(tx: Prisma.TransactionClient, id: number, notifyPurchase = true) {
    const receipts = await tx.materialPayment.findMany({ where: { saleId: id, status: 'PAID' } });
    const paidAmount = receipts.reduce((sum, p) => sum.add(p.amount.minus(p.refundedAmount)), money(0));
    await tx.materialSale.update({ where: { id }, data: { paidAmount, ...(paidAmount.gt(0) ? { expiresAt: null } : {}), version: { increment: 1 } } });
    if (!notifyPurchase) return;
    const sale = await this.sale(tx, id);
    if (!payable(sale) || !sale.total.gt(0) || paidAmount.lt(sale.total)) return;
    // Durable independently of dismissible bell notifications and payment/refund retries.
    // Callers hold the sale lock; the marker and every recipient's outbox commit together.
    const requestKey = `material-sale-paid:${id}`;
    if (await tx.materialOperation.findUnique({ where: { requestKey } })) return;
    await tx.materialOperation.create({ data: { requestKey, requestHash: hash({ kind: 'MATERIAL_SALE_PAID', saleId: id }), kind: 'MATERIAL_SALE_PAID', actorId: sale.createdById, result: { saleId: id } } });
    const buyer = sale.customerUserId ? await tx.user.findUnique({ where: { id: sale.customerUserId }, select: { id: true, isActive: true, deletedAt: true } }) : null;
    const buyerId = buyer?.isActive && !buyer.deletedAt ? buyer.id : undefined;
    await this.notifications.createAndSendToRoles(['admin'], {
      actorId: sale.createdById ?? undefined, notifyActor: true,
      dedupeKey: `material-sale:${id}:paid`,
      message: `Material order #${sale.code} from ${sale.customerName} is fully paid (${sale.currency.toUpperCase()} ${sale.total.toFixed(2)}). ${sale.status === 'DELIVERED' ? 'The order has been delivered.' : 'Ready to prepare for warehouse pickup.'}`,
      actionUrl: `/warehouse/materials/sales/${id}`, actionLabel: 'View material order',
    }, { db: tx, ...(buyerId ? { excludeUserIds: [buyerId] } : {}) });
    if (buyerId) await this.notifications.createAndSend({
      recipientId: buyerId, actorId: buyerId, notifyActor: true,
      dedupeKey: `material-sale:${id}:paid:customer`,
      message: `Your material order #${sale.code} is paid in full (${sale.currency.toUpperCase()} ${sale.total.toFixed(2)}). ${sale.status === 'DELIVERED' ? 'Your order has been delivered.' : 'Show your order number or invoice at warehouse pickup.'}`,
      actionUrl: `/public/material-sales/${sale.publicToken}`, actionLabel: 'View order and invoice',
    }, tx);
    else if (!sale.customerUserId && sale.customerEmail) await this.saleEmails.enqueue(sale, tx);
  }
  private async audit(tx: Prisma.TransactionClient, id: number, actorId: number, message: string) {
    await tx.eventLog.create({ data: { entityType: 'MaterialSale', entityId: id, action: 'UPDATE', userId: actorId, message } });
  }
}

