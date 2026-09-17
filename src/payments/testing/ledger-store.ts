// Persistencia en memoria para pruebas de servicios; no sustituye pruebas MySQL/Stripe de despliegue.
import { Prisma } from '@prisma/client';
export function attachLedgerStore(tx: any, payments: () => any[]) {
  const receipts: any[] = [],
    refunds: any[] = [],
    allocations: any[] = [];
  const money = (value: any) => new Prisma.Decimal(value ?? 0);
  const matching = (row: any, where: any = {}): boolean =>
    Object.entries(where).every(([key, value]: [string, any]) => {
      if (key === 'idEst_type_sequence') return matching(row, value);
      if (value && typeof value === 'object' && !(value instanceof Date)) {
        if ('in' in value) return value.in.includes(row[key]);
        if ('notIn' in value) return !value.notIn.includes(row[key]);
        if ('not' in value) return row[key] !== value.not;
      }
      return row[key] === value;
    });
  const refundView = (r: any) => ({
    ...r,
    allocations: allocations
      .filter((a) => a.refundId === r.id)
      .map((a) => ({
        ...a,
        receipt: {
          ...receipts.find((p) => p.id === a.receiptId),
          payment: payments().find(
            (p) =>
              p.id === receipts.find((r) => r.id === a.receiptId)?.paymentId,
          ),
        },
      })),
  });
  const receiptView = (r: any) => ({
    ...r,
    payment: payments().find((p) => p.id === r.paymentId),
    allocations: allocations
      .filter((a) => a.receiptId === r.id)
      .map((a) => ({ ...a, refund: refunds.find((r) => r.id === a.refundId) })),
  });
  tx.paymentReceipt = {
    create: jest.fn(async ({ data }) => {
      const r = { id: receipts.length + 1, ...data };
      receipts.push(r);
      return r;
    }),
    upsert: jest.fn(async ({ where, create, update }) => {
      const r = receipts.find((r) => matching(r, where));
      if (r) return Object.assign(r, update);
      return tx.paymentReceipt.create({ data: create });
    }),
    findFirst: jest.fn(async ({ where }) => {
      const r = receipts.find((r) => matching(r, where));
      return r ? receiptView(r) : null;
    }),
    findMany: jest.fn(async ({ where }) =>
      receipts.filter((r) => matching(r, where)).map(receiptView),
    ),
    updateMany: jest.fn(async ({ where, data }) => {
      receipts
        .filter((r) => matching(r, where))
        .forEach((r) => Object.assign(r, data));
      return {};
    }),
  };
  tx.paymentRefund = {
    findUnique: jest.fn(async ({ where }) => {
      const r = refunds.find((r) => matching(r, where));
      return r ? refundView(r) : null;
    }),
    upsert: jest.fn(async ({ where, create, update }) => {
      const r = refunds.find((r) => matching(r, where));
      if (r) return Object.assign(r, update);
      const row = { reviewedAt: null, reviewNote: null, ...create };
      refunds.push(row);
      return row;
    }),
    update: jest.fn(async ({ where, data }) =>
      Object.assign(
        refunds.find((r) => matching(r, where)),
        data,
      ),
    ),
    findMany: jest.fn(async ({ where }) =>
      refunds.filter((r) => matching(r, where)).map(refundView),
    ),
  };
  tx.paymentRefundAllocation = {
    create: jest.fn(async ({ data }) => {
      const row = {
        id: allocations.length + 1,
        creditAmount: money(0),
        ...data,
      };
      allocations.push(row);
      return row;
    }),
    update: jest.fn(async ({ where, data }) =>
      Object.assign(
        allocations.find((a) => matching(a, where)),
        { ...data, creditAmount: money(data.creditAmount) },
      ),
    ),
  };
  const find = tx.payment.findUniqueOrThrow ?? tx.payment.findUnique;
  tx.payment.findUniqueOrThrow = jest.fn(async (args) => {
    const p = await find(args);
    if (!p) throw new Error('Missing payment');
    return {
      ...p,
      receipts: receipts.filter((r) => r.paymentId === p.id).map(receiptView),
    };
  });
  tx.payment.count = jest.fn(
    async ({ where }) => payments().filter((p) => matching(p, where)).length,
  );
  tx.payment.findFirst = jest.fn(
    async ({ where }) => payments().find((p) => matching(p, where)) ?? null,
  );
  return { receipts, refunds, allocations };
}
