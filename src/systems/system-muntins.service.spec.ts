import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ApplySystemMuntinsDto } from './dto/system-muntins.dto';
import { SystemMuntinsService } from './system-muntins.service';

function fixture() {
  let nextId = 1;
  const rules: any[] = [];
  const targets: any[] = [];
  const patterns = [
    { id: 1, inputMode: 'NONE', requiresType: false, isActive: true },
    { id: 2, inputMode: 'GRID', requiresType: true, isActive: true },
    { id: 3, inputMode: 'PRESET', requiresType: true, isActive: true },
    { id: 4, inputMode: 'PRESET', requiresType: false, isActive: true },
  ];
  const crystals = [3, 4].map(id => ({ idSystem: 10, idCrystal: id, crystal: { id, isActive: true } }));
  const matches = (rule: any, where: any) => rule.idSystem === where.idSystem &&
    (where.patternId == null || rule.patternId === where.patternId) &&
    (where.availability == null || rule.availability === where.availability) &&
    (where.id == null || (typeof where.id === 'number' ? rule.id === where.id : rule.id !== where.id.not));
  const removeRule = (id: number) => {
    rules.splice(rules.findIndex(rule => rule.id === id), 1);
    for (let i = targets.length - 1; i >= 0; i--) if (targets[i].ruleId === id) targets.splice(i, 1);
  };
  const tx = {
    $queryRaw: jest.fn(async (_query: TemplateStringsArray, ..._values: unknown[]) => [{ id: 10 }]),
    system: { findUnique: jest.fn(async () => ({ id: 10, name: '300',
      sysconfs: [20, 21].map(id => ({ config: { id, conf: String(id) } })), systemCrystals: crystals,
    })) },
    sysConf: { findMany: jest.fn(async ({ where }) => [20, 21].filter(id => where.idConfig.in.includes(id)).map(idConfig => ({ idConfig }))) },
    systemCrystal: { findMany: jest.fn(async ({ where }) => crystals.filter(link => where.idCrystal.in.includes(link.idCrystal))) },
    muntinPattern: {
      findUnique: jest.fn(async ({ where }) => patterns.find(pattern => pattern.id === where.id)),
      findMany: jest.fn(async () => patterns),
    },
    muntinType: { findMany: jest.fn(async (args: any = {}) => [7, 8].filter(id => !args.where || args.where.id.in.includes(id)).map(id => ({ id, isActive: true }))) },
    systemMuntinRule: {
      findMany: jest.fn(async ({ where }) => rules.filter(rule => matches(rule, where)).map(rule => ({ ...rule, targets: targets.filter(target => target.ruleId === rule.id) }))),
      findFirst: jest.fn(async ({ where }) => {
        const rule = rules.find(rule => matches(rule, where));
        return rule ? { ...rule, pattern: patterns.find(pattern => pattern.id === rule.patternId) } : null;
      }),
      create: jest.fn(async ({ data }) => {
        const rule = { ...data, id: nextId++, allowedTypes: data.allowedTypes.create };
        rules.push(rule); return rule;
      }),
      update: jest.fn(async ({ where, data }) => {
        const rule = rules.find(rule => rule.id === where.id)!;
        Object.assign(rule, { availability: data.availability, allowedTypes: data.allowedTypes.create }); return rule;
      }),
      delete: jest.fn(async ({ where }) => { removeRule(where.id); }),
      deleteMany: jest.fn(async ({ where }) => {
        const removable = rules.filter(rule => matches(rule, where) && (!where.targets || !targets.some(target => target.ruleId === rule.id)));
        for (const rule of removable) removeRule(rule.id);
        return { count: removable.length };
      }),
    },
    systemMuntinAssignment: {
      createMany: jest.fn(async ({ data }) => { targets.push(...data); }),
      deleteMany: jest.fn(async ({ where }) => {
        for (let i = targets.length - 1; i >= 0; i--) {
          const target = targets[i];
          if (target.idSystem === where.idSystem && target.patternId === where.patternId &&
            where.OR.some(pair => pair.idConfig === target.idConfig && pair.idCrystal === target.idCrystal)) targets.splice(i, 1);
        }
      }),
      updateMany: jest.fn(async ({ where, data }) => {
        targets.filter(target => target.idSystem === where.idSystem && target.ruleId === where.ruleId).forEach(target => Object.assign(target, data));
      }),
    },
  };
  // In-memory transaction serialization models the row lock; no database is used.
  let queue: Promise<unknown> = Promise.resolve();
  const db = { ...tx, $transaction: jest.fn(work => {
    const result = queue.then(() => work(tx));
    queue = result.catch(() => undefined); return result;
  }) };
  return { service: new SystemMuntinsService(db as any), db, tx, rules, targets, patterns, crystals };
}

const a = { configId: 20, crystalId: 3 };
const b = { configId: 21, crystalId: 4 };
const selected = (targets = [a, b], allowedTypeIds = [7, 8], patternId = 2): ApplySystemMuntinsDto => ({
  targets, allowedTypeIds, patternId, availability: 'SELECTED',
});

describe('shared muntin rules and exact target assignments', () => {
  it('assigns only listed pairs, reuses identical rules and keeps different patterns independent', async () => {
    const f = fixture();
    const result = await f.service.apply(10, selected([a, b], [8, 7]));
    expect(result.rules).toEqual([{ id: 1, patternId: 2, availability: 'SELECTED', allowedTypeIds: [7, 8], targets: [a, b] }]);
    expect(f.targets).toHaveLength(2); // Crossed pairs 20/4 and 21/3 are not implicitly granted.
    await f.service.apply(10, selected([a], [7, 8]));
    expect(f.rules).toHaveLength(1);
    await f.service.apply(10, selected([a], [7], 3));
    expect(f.rules).toHaveLength(2);
    expect(f.targets).toHaveLength(3);
    expect(f.tx.$queryRaw.mock.calls[0][0].join('?')).toContain('FOR UPDATE');
    expect(f.db.$transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: 'Serializable' });
  });

  it('reassigns one pair without changing the shared selection of the other targets', async () => {
    const f = fixture();
    await f.service.apply(10, selected());
    const result = await f.service.apply(10, selected([a], [8]));
    expect(result.rules).toEqual([
      { id: 1, patternId: 2, availability: 'SELECTED', allowedTypeIds: [7, 8], targets: [b] },
      { id: 2, patternId: 2, availability: 'SELECTED', allowedTypeIds: [8], targets: [a] },
    ]);
  });

  it('updates all targets in a shared group, merging an identical rule safely', async () => {
    const f = fixture();
    await f.service.apply(10, selected([a], [7]));
    await f.service.apply(10, selected([b], [8]));
    const result = await f.service.updateRule(10, 1, { availability: 'SELECTED', allowedTypeIds: [8] });
    expect(result.rules).toEqual([{ id: 2, patternId: 2, availability: 'SELECTED', allowedTypeIds: [8], targets: [a, b] }]);
    const updated = await f.service.updateRule(10, 2, { availability: 'ALL', allowedTypeIds: [] });
    expect(updated.rules[0]).toMatchObject({ availability: 'ALL', allowedTypeIds: [], targets: [a, b] });
  });

  it('NONE removes only the selected pattern/pairs and DELETE removes the whole remaining group', async () => {
    const f = fixture();
    await f.service.apply(10, selected());
    await f.service.apply(10, selected([a], [7], 3));
    f.patterns[1].isActive = false;
    f.crystals[0].crystal.isActive = false;
    const result = await f.service.apply(10, { patternId: 2, targets: [a], availability: 'NONE', allowedTypeIds: [] });
    expect(result.rules[0].targets).toEqual([b]);
    expect(result.rules[1].targets).toEqual([a]);
    const afterDelete = await f.service.removeRule(10, 1);
    expect(afterDelete.rules).toHaveLength(1);
    expect(afterDelete.rules[0].patternId).toBe(3);
  });

  it.each([
    selected([a], []), selected([a], [7, 7]), selected([a], [99]),
    selected([a, a]), selected([{ configId: 999, crystalId: 3 }]),
    selected([{ configId: 20, crystalId: 999 }]), selected([a], [7], 1),
    selected([a], [7], 4), { ...selected(), availability: 'ALL', allowedTypeIds: [7] },
  ])('rejects invalid selections before writing %j', async data => {
    const f = fixture();
    await expect(f.service.apply(10, data as any)).rejects.toThrow();
    expect(f.tx.systemMuntinRule.create).not.toHaveBeenCalled();
    expect(f.tx.systemMuntinAssignment.createMany).not.toHaveBeenCalled();
  });

  it('allows patterns without profiles only through an ALL rule with an empty selection', async () => {
    const f = fixture();
    await expect(f.service.apply(10, { patternId: 4, targets: [a], availability: 'ALL', allowedTypeIds: [] }))
      .resolves.toMatchObject({ rules: [{ patternId: 4, allowedTypeIds: [] }] });
  });

  it('checks pattern and crystal activity on assignment but permits removal', async () => {
    const f = fixture();
    f.patterns[1].isActive = false;
    await expect(f.service.apply(10, selected())).rejects.toThrow('active muntin pattern');
    f.patterns[1].isActive = true; f.crystals[0].crystal.isActive = false;
    await expect(f.service.apply(10, selected())).rejects.toThrow('active crystals');
  });

  it('scopes rule edits and deletion to the addressed series', async () => {
    const f = fixture();
    await f.service.apply(10, selected());
    await expect(f.service.updateRule(11, 1, { availability: 'ALL' })).rejects.toThrow('not found for this series');
    await expect(f.service.removeRule(11, 1)).rejects.toThrow('not found for this series');
    expect(f.targets).toHaveLength(2);
  });

  it('serializes concurrent batched assignments without duplicate permissions', async () => {
    const f = fixture();
    await Promise.all([f.service.apply(10, selected()), f.service.apply(10, selected([b, a], [8, 7]))]);
    expect(f.rules).toHaveLength(1);
    expect(f.targets).toHaveLength(2);
    expect(f.tx.$queryRaw).toHaveBeenCalledTimes(2);
  });

  it('retries a serialization failure, but does not retry a validation failure', async () => {
    const f = fixture();
    f.db.$transaction.mockRejectedValueOnce({ code: 'P2034' });
    await f.service.apply(10, selected());
    expect(f.db.$transaction).toHaveBeenCalledTimes(2);
    await expect(f.service.apply(10, selected([a], [99]))).rejects.toThrow('invalid or inactive');
    expect(f.db.$transaction).toHaveBeenCalledTimes(3);
  });

  it('new associations have no implicit rules and management includes inactive catalog entries', async () => {
    const f = fixture(); f.patterns[1].isActive = false;
    const result = await f.service.manage(10);
    expect(result.rules).toEqual([]);
    expect(result.patterns.find(pattern => pattern.id === 2)?.isActive).toBe(false);
  });

  it.each([
    { targets: [] }, { targets: [{ configId: 0, crystalId: 3 }] }, { patternId: 1.5 },
    { availability: 'UNKNOWN' }, { allowedTypeIds: null }, { allowedTypeIds: [7, 7] },
  ])('validates API payloads %j', async overrides => {
    expect((await validate(plainToInstance(ApplySystemMuntinsDto, { ...selected(), ...overrides }))).length).toBeGreaterThan(0);
  });
});
