import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, FactoryPaymentAccount } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import {
  CreateFactoryManufacturerDto, CreateFactoryPaymentDto, FactoryPaymentStatus,
  ListFactoryPaymentsDto, SaveFactoryPaymentAccountDto, UpdateFactoryManufacturerDto,
} from './factory-payments.dto';
import { factoryBalance, importedFactoryTotal, paymentAmount, paymentDate } from './factory-payments-values';

const orderSelect = {
  id: true, number: true, date: true, poNumber: true, rateReal: true,
  estimate: { select: {
    name: true,
    // FactoryPo rows were backfilled for old manual POs. Imported units prove JSON import.
    pieces: { where: { factoryUnits: { some: {} } }, take: 1, select: { id: true } },
  } },
  factoryPaymentAccount: { include: {
    manufacturer: true,
    payments: { select: { amount: true, voidedAt: true } },
  } },
} satisfies Prisma.OrderSelect;
type SourceOrder = Prisma.OrderGetPayload<{ select: typeof orderSelect }>;
type Db = Prisma.TransactionClient;

export function factoryPaymentRow(order: SourceOrder) {
  const account = order.factoryPaymentAccount;
  const importedTotal = importedFactoryTotal(order.rateReal);
  const imported = !!order.poNumber?.trim() && importedTotal != null && order.estimate.pieces.length > 0;
  const total = account?.total ?? (imported ? importedTotal : null);
  const { paid, remaining } = factoryBalance(total, account?.payments.filter(p => !p.voidedAt).map(p => p.amount) ?? []);
  const status = !imported ? FactoryPaymentStatus.PENDING_IMPORT
    : remaining?.isNegative() ? FactoryPaymentStatus.CREDIT
    : remaining?.isZero() ? FactoryPaymentStatus.PAID
    : paid.isZero() ? FactoryPaymentStatus.UNPAID : FactoryPaymentStatus.PARTIAL;
  return {
    orderId: order.id, orderNumber: order.number, orderDate: order.date,
    projectName: order.estimate.name, poNumber: account?.poNumber ?? order.poNumber,
    imported, manufacturer: account ? { id: account.manufacturer.id, name: account.manufacturer.name } : null,
    accountId: account?.id ?? null, version: account?.version ?? null,
    factoryTotal: total?.toFixed(2) ?? null,
    importedTotal: imported ? importedTotal!.toFixed(2) : null,
    sourceCostChanged: !!account && (order.rateReal == null || !account.sourceCost.eq(order.rateReal) || account.poNumber !== order.poNumber?.trim()),
    paid: paid.toFixed(2), remaining: remaining?.toFixed(2) ?? null, status,
  };
}

@Injectable()
export class FactoryPaymentsService {
  constructor(private readonly prisma: PrismaService) {}

  manufacturers() {
    return this.prisma.factoryManufacturer.findMany({
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
      select: { id: true, name: true, active: true, isDefault: true },
    });
  }

  async saveManufacturer(dto: CreateFactoryManufacturerDto | UpdateFactoryManufacturerDto, actorId: number, id?: number) {
    return this.transaction(async db => {
      await db.$queryRaw`SELECT id FROM factory_payments_settings WHERE id = 1 FOR UPDATE`;
      const before = id == null ? null : await db.factoryManufacturer.findUnique({ where: { id } });
      if (id != null && !before) throw new NotFoundException('Manufacturer not found.');
      const name = dto.name?.trim() ?? before?.name;
      if (!name || name.length > 150) throw new BadRequestException('Enter a manufacturer name with 1 to 150 characters.');
      const active = 'active' in dto ? dto.active ?? before?.active ?? true : before?.active ?? true;
      const isDefault = dto.isDefault ?? before?.isDefault ?? false;
      if (!active && isDefault) throw new BadRequestException('Choose another default manufacturer before deactivating this manufacturer.');
      if (before?.isDefault && !isDefault)
        throw new BadRequestException('Set another manufacturer as default instead.');
      if (isDefault) await db.factoryManufacturer.updateMany({ where: { isDefault: true, id: id == null ? undefined : { not: id } }, data: { isDefault: false } });
      const data = { name, active, isDefault };
      const saved = id == null
        ? await db.factoryManufacturer.create({ data })
        : await db.factoryManufacturer.update({ where: { id }, data });
      await db.factoryPaymentEvent.create({ data: {
        manufacturerId: saved.id, actorId, action: before ? 'MANUFACTURER_UPDATED' : 'MANUFACTURER_CREATED',
        detail: `${before ? 'Updated' : 'Created'} manufacturer ${name}.`,
        data: { before: before ? { name: before.name, active: before.active, isDefault: before.isDefault } : null, after: data },
      } });
      return { id: saved.id, name: saved.name, active: saved.active, isDefault: saved.isDefault };
    });
  }

  async list(query: ListFactoryPaymentsDto) {
    return this.prisma.$transaction(async db => this.readList(db, query), {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    });
  }

  private async readList(db: Db, query: ListFactoryPaymentsDto) {
    const orders = await db.order.findMany({
      where: {
        ...(query.manufacturerId ? { factoryPaymentAccount: { manufacturerId: query.manufacturerId } } : {}),
        ...(query.search ? { OR: [
          { number: { contains: query.search } }, { poNumber: { contains: query.search } },
          { estimate: { name: { contains: query.search } } },
          { factoryPaymentAccount: { manufacturer: { name: { contains: query.search } } } },
        ] } : {}),
      },
      select: orderSelect, orderBy: [{ date: 'desc' }, { id: 'desc' }],
    });
    const rows = orders.map(factoryPaymentRow).filter(row => !query.status || query.status === FactoryPaymentStatus.ALL || row.status === query.status);
    const sums = rows.reduce((totals, row) => {
      if (row.factoryTotal != null) totals.factoryTotal = totals.factoryTotal.add(row.factoryTotal);
      totals.paid = totals.paid.add(row.paid);
      if (row.remaining != null) {
        const remaining = new Prisma.Decimal(row.remaining);
        if (remaining.isNegative()) totals.credit = totals.credit.sub(remaining);
        else totals.remaining = totals.remaining.add(remaining);
      }
      return totals;
    }, { factoryTotal: new Prisma.Decimal(0), paid: new Prisma.Decimal(0), remaining: new Prisma.Decimal(0), credit: new Prisma.Decimal(0) });
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 25;
    return {
      rows: rows.slice((page - 1) * pageSize, page * pageSize), total: rows.length, page, pageSize,
      summary: { factoryTotal: sums.factoryTotal.toFixed(2), paid: sums.paid.toFixed(2), remaining: sums.remaining.toFixed(2), credit: sums.credit.toFixed(2) },
    };
  }

  async detail(orderId: number) {
    // One read snapshot keeps balance/version and history consistent during concurrent saves.
    return this.prisma.$transaction(async db => this.readDetail(db, orderId), {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    });
  }

  private async readDetail(db: Db, orderId: number) {
    const order = await this.getOrder(db, orderId);
    const accountId = order.factoryPaymentAccount?.id;
    if (accountId == null) return { order: factoryPaymentRow(order), payments: [], events: [] };
    const [payments, events] = await Promise.all([
      db.factoryPayment.findMany({ where: { accountId }, orderBy: [{ paidOn: 'desc' }, { id: 'desc' }] }),
      db.factoryPaymentEvent.findMany({ where: { accountId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] }),
    ]);
    const actorIds = [...new Set([...payments.flatMap(p => [p.createdById, p.voidedById].filter((id): id is number => id != null)), ...events.map(e => e.actorId)])];
    const users = await db.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, username: true, firstName: true, lastName: true } });
    const names = new Map(users.map(u => [u.id, `${u.firstName} ${u.lastName}`.trim() || u.username]));
    return {
      order: factoryPaymentRow(order),
      payments: payments.map(p => ({
        id: p.id, requestId: p.requestId, amount: p.amount.toFixed(2), paidOn: p.paidOn.toISOString().slice(0, 10),
        invoiceNumber: p.invoiceNumber, kind: p.kind, reference: p.reference, note: p.note,
        createdAt: p.createdAt, createdByName: names.get(p.createdById) ?? `User ${p.createdById}`,
        voidedAt: p.voidedAt, voidReason: p.voidReason,
        voidedByName: p.voidedById == null ? null : names.get(p.voidedById) ?? `User ${p.voidedById}`,
      })),
      events: events.map(e => ({ id: e.id, action: e.action, detail: e.detail, createdAt: e.createdAt, actorName: names.get(e.actorId) ?? `User ${e.actorId}` })),
    };
  }

  async saveAccount(orderId: number, dto: SaveFactoryPaymentAccountDto, actorId: number) {
    await this.transaction(async db => {
      const order = await this.lockOrder(db, orderId);
      this.assertImported(order);
      const manufacturer = await this.activeManufacturer(db, dto.manufacturerId);
      const account = order.factoryPaymentAccount;
      if (!account) {
        this.assertNewVersion(dto.version);
        await this.createAccount(db, order, dto.manufacturerId, actorId);
        return;
      }
      this.assertVersion(account, dto.version);
      this.assertPo(order, account);
      if (account.manufacturerId === dto.manufacturerId) return;
      await db.factoryPaymentAccount.update({ where: { id: account.id }, data: { manufacturerId: dto.manufacturerId, version: { increment: 1 } } });
      await this.event(db, account.id, actorId, 'MANUFACTURER_CHANGED', `Changed the manufacturer from ${account.manufacturer.name} to ${manufacturer.name}.`, { before: account.manufacturerId, after: dto.manufacturerId });
    });
    return this.detail(orderId);
  }

  async syncTotal(orderId: number, version: number, actorId: number) {
    await this.transaction(async db => {
      const order = await this.lockOrder(db, orderId);
      this.assertImported(order);
      const account = order.factoryPaymentAccount;
      if (!account) throw new BadRequestException('Assign a manufacturer first.');
      this.assertVersion(account, version);
      this.assertPo(order, account);
      if (account.sourceCost.eq(order.rateReal!)) return;
      const total = importedFactoryTotal(order.rateReal)!;
      await db.factoryPaymentAccount.update({ where: { id: account.id }, data: { sourceCost: order.rateReal!, total, version: { increment: 1 } } });
      await this.event(db, account.id, actorId, 'TOTAL_SYNCED', `Updated the control total from ${account.total.toFixed(2)} to ${total.toFixed(2)} using the imported PO.`, { before: account.sourceCost.toString(), after: order.rateReal!.toString() });
    });
    return this.detail(orderId);
  }

  async addPayment(orderId: number, dto: CreateFactoryPaymentDto, actorId: number) {
    const amount = paymentAmount(dto.amount);
    const paidOn = paymentDate(dto.paidOn);
    await this.transaction(async db => {
      const order = await this.lockOrder(db, orderId);
      const previous = await db.factoryPayment.findUnique({ where: { requestId: dto.requestId }, include: { account: true } });
      if (previous) {
        if (previous.account.orderId !== orderId || previous.account.manufacturerId !== dto.manufacturerId || !previous.amount.eq(amount) || previous.paidOn.getTime() !== paidOn.getTime() ||
            previous.invoiceNumber !== dto.invoiceNumber || previous.kind !== dto.kind ||
            (previous.reference ?? '') !== (dto.reference ?? '') || (previous.note ?? '') !== (dto.note ?? ''))
          throw new ConflictException('This payment request was already used with different details. Refresh and try again.');
        return; // Retry after a lost response must not record another charge.
      }
      this.assertImported(order);
      await this.activeManufacturer(db, dto.manufacturerId);
      let account: FactoryPaymentAccount;
      if (order.factoryPaymentAccount) {
        account = order.factoryPaymentAccount;
        this.assertVersion(account, dto.version);
        this.assertPo(order, account);
        if (account.manufacturerId !== dto.manufacturerId)
          throw new ConflictException('The manufacturer changed. Refresh the PO before recording a payment.');
        if (!account.sourceCost.eq(order.rateReal!))
          throw new ConflictException('The imported factory cost changed. Review and update the control total before recording another payment.');
      } else {
        this.assertNewVersion(dto.version);
        account = await this.createAccount(db, order, dto.manufacturerId, actorId);
      }
      const payment = await db.factoryPayment.create({ data: {
        accountId: account.id, requestId: dto.requestId, amount, paidOn,
        invoiceNumber: dto.invoiceNumber, kind: dto.kind, reference: dto.reference || null, note: dto.note || null, createdById: actorId,
      } });
      await db.factoryPaymentAccount.update({ where: { id: account.id }, data: { version: { increment: 1 } } });
      await this.event(db, account.id, actorId, 'PAYMENT_RECORDED', `Recorded ${amount.toFixed(2)} for invoice ${dto.invoiceNumber}.`, { paymentId: payment.id, amount: amount.toFixed(2), paidOn: dto.paidOn, invoiceNumber: dto.invoiceNumber, kind: dto.kind });
    });
    return this.detail(orderId);
  }

  async voidPayment(paymentId: number, reason: string, actorId: number) {
    reason = reason.trim();
    if (!reason || reason.length > 500) throw new BadRequestException('Enter a reason with 1 to 500 characters.');
    const payment = await this.prisma.factoryPayment.findUnique({ where: { id: paymentId }, select: { account: { select: { orderId: true } } } });
    if (!payment) throw new NotFoundException('Payment not found.');
    const orderId = payment.account.orderId;
    await this.transaction(async db => {
      await this.lockOrder(db, orderId);
      const before = await db.factoryPayment.findUnique({ where: { id: paymentId } });
      if (!before) throw new NotFoundException('Payment not found.');
      if (before.voidedAt) return;
      await db.factoryPayment.update({ where: { id: paymentId }, data: { voidedAt: new Date(), voidedById: actorId, voidReason: reason } });
      await db.factoryPaymentAccount.update({ where: { id: before.accountId }, data: { version: { increment: 1 } } });
      await this.event(db, before.accountId, actorId, 'PAYMENT_VOIDED', `Voided ${before.amount.toFixed(2)} for invoice ${before.invoiceNumber}. Reason: ${reason}`, { paymentId, reason });
    });
    return this.detail(orderId);
  }

  private async getOrder(db: Db, id: number) {
    const order = await db.order.findUnique({ where: { id }, select: orderSelect });
    if (!order) throw new NotFoundException('Order not found.');
    return order;
  }

  private async lockOrder(db: Db, id: number) {
    // Locking only: never write Order, FactoryPo, Estimate or customer Payment.
    await db.$queryRaw`SELECT id FROM \`Order\` WHERE id = ${id} FOR UPDATE`;
    return this.getOrder(db, id);
  }

  private assertImported(order: SourceOrder) {
    if (!factoryPaymentRow(order).imported)
      throw new BadRequestException('Import this order\'s PO JSON, including factory cost and unit links, before recording manufacturer payments.');
  }

  private assertPo(order: SourceOrder, account: FactoryPaymentAccount) {
    if (account.poNumber !== order.poNumber?.trim())
      throw new ConflictException('The imported PO no longer matches this payment history. Review the original PO before continuing.');
  }

  private assertVersion(account: FactoryPaymentAccount, version?: number) {
    if (account.version !== version)
      throw new ConflictException('This PO changed in another session. Refresh before saving.');
  }

  private assertNewVersion(version?: number) {
    if (version != null) throw new ConflictException('This PO changed. Refresh before saving.');
  }

  private async activeManufacturer(db: Db, id: number) {
    await db.$queryRaw`SELECT id FROM factory_manufacturers WHERE id = ${id} FOR UPDATE`;
    const manufacturer = await db.factoryManufacturer.findUnique({ where: { id } });
    if (!manufacturer?.active) throw new BadRequestException('Choose an active manufacturer.');
    return manufacturer;
  }

  private async createAccount(db: Db, order: SourceOrder, manufacturerId: number, actorId: number) {
    const total = importedFactoryTotal(order.rateReal)!;
    const account = await db.factoryPaymentAccount.create({ data: {
      orderId: order.id, manufacturerId, poNumber: order.poNumber!.trim(), sourceCost: order.rateReal!, total,
    } });
    await this.event(db, account.id, actorId, 'ACCOUNT_CREATED', `Started payment tracking for PO ${account.poNumber} with factory total ${total.toFixed(2)}.`, { manufacturerId, sourceCost: account.sourceCost.toString(), total: total.toFixed(2) });
    return account;
  }

  private event(db: Db, accountId: number, actorId: number, action: string, detail: string, data: Prisma.InputJsonValue) {
    return db.factoryPaymentEvent.create({ data: { accountId, actorId, action, detail, data } });
  }

  private async transaction<T>(run: (db: Db) => Promise<T>): Promise<T> {
    try {
      return await this.prisma.$transaction(run, {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        maxWait: 10000, timeout: 20000,
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        if (error.code === 'P2002')
          throw new ConflictException('This manufacturer, PO or payment request already exists. Refresh before saving.');
        if (error.code === 'P2034')
          throw new ConflictException('Another change is being saved. Refresh and try again.');
      }
      throw error;
    }
  }
}
