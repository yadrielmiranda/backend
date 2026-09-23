// Almacén en memoria para verificar transacciones y el flujo HTTP sin datos reales.
export function warehouseFixture() {
  const users = [
    { id: 1, firstName: 'Admin', lastName: 'Test' },
    { id: 2, firstName: 'Operator', lastName: 'Test' },
    { id: 3, firstName: 'Technician', lastName: 'Test' },
  ];
  const order = {
    id: 1,
    idEst: 7,
    number: '1001',
    poNumber: '281374',
    status: { name: 'Ready to pick up' },
    fulfillmentMethod: 'CUSTOMER_PICKUP',
    payment: { status: 'PAID' },
    estimate: { installationJob: null as any, paymentPlanSnapshot: null },
    deliveries: [],
  };
  const orders: any[] = [order];
  const definitions = [
    ['1029975', 'F3', 'French Door', 'FRENCH_DOOR', 'OX', 3],
    ['1029967', 'B2', 'Sliding Glass Door', 'SLIDING_DOOR', 'XXX', 4],
    ['1029968', 'B3', 'Horizontal Rolling', 'HORIZONTAL_SLIDER', 'OX', 1],
    ['1096240', 'W1', 'Fixed Window', 'FIXED_SHAPE', 'PW', 1],
  ];
  const pieces = definitions.map((d, index) => ({
    id: index + 10,
    idEst: 7,
    mark: d[1],
    panelCount: null,
    prod: { name: d[2], diagramFamily: d[3], kind: 'GLAZED_UNIT' },
    conf: { conf: d[4], fixedPanelCount: null },
    syst: { name: 'ECO' },
    estim: {
      name: 'Warehouse project',
      customerFirstName: 'Pepe',
      customerLastName: 'Test',
      installationJob: null as any,
      user: users[0],
      order,
    },
  }));
  const stocks: any[] = definitions.map((d, i) => ({
    lineNumber: d[0],
    expectedParts: d[5],
    inTransit: 0,
    onHand: 0,
    unassigned: 0,
    released: 0,
    version: 0,
    updatedAt: new Date(),
    pieceId: pieces[i].id,
  }));
  const stores: any[] = [
    { id: 1, name: 'Main', isActive: true, version: 0, createdAt: new Date(), updatedAt: new Date() },
    { id: 2, name: 'Overflow', isActive: true, version: 0, createdAt: new Date(), updatedAt: new Date() },
  ];
  const balances: any[] = [];
  const movements: any[] = [],
    counts: any[] = [],
    countLines: any[] = [],
    pickupRuns: any[] = [],
    pickupRunOrders: any[] = [],
    pickupRunLines: any[] = [];
  const clone = <T>(v: T): T => structuredClone(v);
  const stockView = (s) =>
    s
      ? {
          ...s,
          storeBalances: balances.filter((b) => b.lineNumber === s.lineNumber).map((b) => ({
            ...b, store: clone(stores.find((store) => store.id === b.storeId)),
          })),
          unit: {
            lineNumber: s.lineNumber,
            pieceId: s.pieceId,
            piece: (() => {
              const piece = clone(pieces.find((p) => p.id === s.pieceId));
              if (piece) piece.estim.installationJob = piece.estim.order?.estimate?.installationJob ?? null;
              return piece;
            })(),
          },
        }
      : null;
  const movementView = (m) =>
    m
      ? {
          ...m,
          fromStore: clone(stores.find((s) => s.id === m.fromStoreId) ?? null),
          toStore: clone(stores.find((s) => s.id === m.toStoreId) ?? null),
          actor: users.find((u) => u.id === m.actorId),
          reversal: movements.find((x) => x.reversalOfId === m.id) ?? null,
          stock: stockView(stocks.find((s) => s.lineNumber === m.lineNumber)),
        }
      : null;
  const countView = (c) =>
    c
      ? {
          ...c,
          store: clone(stores.find((s) => s.id === c.storeId) ?? null),
          startedBy: users.find((u) => u.id === c.startedById),
          closedBy: users.find((u) => u.id === c.closedById) ?? null,
        }
      : null;
  const countLineView = (l) =>
    l
      ? {
          ...l,
          stock: stockView(stocks.find((s) => s.lineNumber === l.lineNumber)),
        }
      : null;
  const pickupRunOrderView = (row) =>
    row
      ? {
          ...row,
          order: clone(orders.find((value) => value.id === row.orderId) ?? null),
        }
      : null;
  const pickupRunLineView = (row) =>
    row
      ? {
          ...row,
          stock: stockView(stocks.find((s) => s.lineNumber === row.lineNumber)),
        }
      : null;
  const compare = (value, condition, row): boolean => {
    if (condition === undefined) return true;
    if (condition === null || typeof condition !== 'object')
      return value === condition;
    if ('some' in condition) return Array.isArray(value) && value.some((v) => matches(v, condition.some));
    if ('_ref' in condition) return value === row[condition._ref];
    if ('equals' in condition && !compare(value, condition.equals, row))
      return false;
    if ('not' in condition && compare(value, condition.not, row)) return false;
    for (const op of ['gt', 'gte', 'lt', 'lte'])
      if (op in condition) {
        const operand =
          typeof condition[op] === 'object'
            ? row[condition[op]._ref]
            : condition[op];
        if (
          value === null ||
          operand === null ||
          !(op === 'gt'
            ? value > operand
            : op === 'gte'
              ? value >= operand
              : op === 'lt'
                ? value < operand
                : value <= operand)
        )
          return false;
      }
    if ('in' in condition && !condition.in.includes(value)) return false;
    if (
      'contains' in condition &&
      !String(value ?? '')
        .toLowerCase()
        .includes(condition.contains.toLowerCase())
    )
      return false;
    if (
      Object.keys(condition).some(
        (k) =>
          ![
            'equals',
            'not',
            'gt',
            'gte',
            'lt',
            'lte',
            'in',
            'contains',
          ].includes(k),
      )
    )
      return matches(value, condition);
    return true;
  };
  const matches = (row, where): boolean =>
    !where ||
    Object.entries(where).every(([key, value]: [string, any]) => {
      if (value === undefined) return true;
      if (key === 'OR') return value.some((v) => matches(row, v));
      if (key === 'AND')
        return (Array.isArray(value) ? value : [value]).every((v) =>
          matches(row, v),
        );
      if (key === 'NOT') return !matches(row, value);
      if (key === 'lineNumber_storeId')
        return row?.lineNumber === value.lineNumber && row?.storeId === value.storeId;
      if (key === 'countId_lineNumber')
        return (
          row?.countId === value.countId && row?.lineNumber === value.lineNumber
        );
      if (key === 'technicianId_activeSlot')
        return row?.technicianId === value.technicianId && row?.activeSlot === value.activeSlot;
      if (key === 'pickupRunId_orderId')
        return row?.pickupRunId === value.pickupRunId && row?.orderId === value.orderId;
      if (key === 'orderId_activeSlot')
        return row?.orderId === value.orderId && row?.activeSlot === value.activeSlot;
      if (key === 'pickupRunId_lineNumber')
        return row?.pickupRunId === value.pickupRunId && row?.lineNumber === value.lineNumber;
      return compare(row?.[key], value, row);
    });
  const change = (row, data) => {
    for (const [key, v] of Object.entries(data) as [string, any][]) {
      if (v === undefined) continue;
      row[key] =
        v && typeof v === 'object' && ('increment' in v || 'decrement' in v)
          ? row[key] + (v.increment ?? 0) - (v.decrement ?? 0)
          : v;
    }
    if ('updatedAt' in row) row.updatedAt = new Date();
  };
  const model = (rows: any[], view, defaults: (data: any) => any) => ({
    findUnique: async ({ where }) =>
      clone(view(rows.find((r) => matches(view(r), where)))),
    findFirst: async ({ where } = {} as any) =>
      clone(view(rows.find((r) => matches(view(r), where)))),
    findUniqueOrThrow: async ({ where }) => {
      const row = rows.find((r) => matches(view(r), where));
      if (!row) throw new Error('Missing test record');
      return clone(view(row));
    },
    findMany: async (
      { where, orderBy, skip = 0, take = Infinity } = {} as any,
    ) => {
      let result = rows.map(view).filter((r) => matches(r, where));
      if (orderBy) {
        const [key, direction] = Object.entries(orderBy)[0];
        result = [...result].sort(
          (a, b) =>
            (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0) *
            (direction === 'desc' ? -1 : 1),
        );
      }
      return clone(result.slice(skip, skip + take));
    },
    count: async ({ where } = {} as any) =>
      rows.filter((r) => matches(view(r), where)).length,
    groupBy: async ({ by, where, _sum, _count }) => {
      const groups = new Map<string, any[]>();
      for (const row of rows.filter((r) => matches(view(r), where))) {
        const key = JSON.stringify(by.map((k) => row[k]));
        groups.set(key, [...(groups.get(key) ?? []), row]);
      }
      return [...groups.values()].map((group) => ({
        ...Object.fromEntries(by.map((k) => [k, group[0][k]])),
        _sum: Object.fromEntries(Object.keys(_sum ?? {}).map((k) => [k, group.reduce((sum, r) => sum + r[k], 0)])),
        ...(_count ? { _count: { _all: group.length } } : {}),
      }));
    },
    aggregate: async ({ where, _sum }) => ({
      _sum: Object.fromEntries(
        Object.keys(_sum).map((k) => [
          k,
          rows
            .filter((r) => matches(view(r), where))
            .reduce((sum, r) => sum + (r[k] ?? 0), 0),
        ]),
      ),
    }),
    create: async ({ data }) => {
      const row = defaults(data);
      rows.push(row);
      return clone(view(row));
    },
    createMany: async ({ data }) => {
      rows.push(...data.map(defaults));
      return { count: data.length };
    },
    update: async ({ where, data }) => {
      const row = rows.find((r) => matches(view(r), where));
      if (!row) throw new Error('Missing test record');
      change(row, data);
      return clone(view(row));
    },
    updateMany: async ({ where, data }) => {
      const selected = rows.filter((r) => matches(view(r), where));
      selected.forEach((r) => change(r, data));
      return { count: selected.length };
    },
    upsert: async ({ where, create, update }) => {
      let row = rows.find((r) => matches(view(r), where));
      if (row) change(row, update);
      else {
        row = defaults(create);
        rows.push(row);
      }
      return clone(view(row));
    },
  });
  let queue: Promise<any> = Promise.resolve();
  const db: any = {
    warehouseStore: model(stores, (s) => s ?? null, (d) => ({
      id: Math.max(0, ...stores.map((s) => s.id)) + 1, isActive: true, version: 0,
      createdAt: new Date(), updatedAt: new Date(), ...d,
    })),
    warehouseStoreStock: model(balances, (b) => b ? {
      ...b, stock: stockView(stocks.find(s => s.lineNumber === b.lineNumber)),
    } : null, (d) => ({
      onHand: 0, updatedAt: new Date(), ...d,
    })),
    warehouseStock: model(stocks, stockView, (d) => ({
      inTransit: 0,
      onHand: 0,
      unassigned: 0,
      released: 0,
      version: 0,
      updatedAt: new Date(),
      ...d,
    })),
    warehouseMovement: model(movements, movementView, (d) => ({
      id: movements.length + 1,
      transitDelta: 0,
      onHandDelta: 0,
      releasedDelta: 0,
      countDelta: 0,
      quantity: 0,
      fromStoreId: null,
      toStoreId: null,
      installationJobId: null,
      installationAddress: null,
      reversalOfId: null,
      countId: null,
      reason: null,
      createdAt: new Date(),
      ...d,
    })),
    warehouseCount: model(counts, countView, (d) => ({
      id: counts.length + 1,
      status: 'OPEN',
      scope: 'ALL',
      storeId: null,
      startedAt: new Date(),
      closedAt: null,
      closedById: null,
      reason: null,
      ...d,
    })),
    warehouseCountLine: model(countLines, countLineView, (d) => ({
      counted: 0,
      ...d,
    })),
    factoryPickupRun: model(pickupRuns, (r) => r ?? null, (d) => ({
      id: pickupRuns.length + 1,
      status: 'ACTIVE',
      activeSlot: 1,
      startedAt: new Date(),
      finishedAt: null,
      partialReason: null,
      note: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...d,
    })),
    factoryPickupRunOrder: model(pickupRunOrders, pickupRunOrderView, (d) => ({
      activeSlot: 1,
      addedDuringPickup: false,
      addedAt: new Date(),
      ...d,
    })),
    factoryPickupRunLine: model(pickupRunLines, pickupRunLineView, (d) => ({
      addedAt: new Date(),
      ...d,
    })),
    order: {
      findUnique: async ({ where }) => clone(orders.find((value) => matches(value, where)) ?? null),
    },
    estimate: { findUnique: async () => null },
    payment: { findMany: async () => [] },
    $queryRaw: async () => [],
    $transaction: (callback) => {
      const result = queue.then(async () => {
        const lists = [stocks, movements, counts, countLines, stores, balances, pickupRuns, pickupRunOrders, pickupRunLines],
          before = lists.map(clone);
        try {
          return await callback(db);
        } catch (e) {
          lists.forEach((list, i) => list.splice(0, list.length, ...before[i]));
          throw e;
        }
      });
      queue = result.catch(() => undefined);
      return result;
    },
  };
  db.warehouseStock.fields = { expectedParts: { _ref: 'expectedParts' } };
  db.warehouseCountLine.fields = { expected: { _ref: 'expected' } };
  return {
    db, stocks, movements, counts, countLines, pieces, order, orders, stores, balances,
    pickupRuns, pickupRunOrders, pickupRunLines,
  };
}
