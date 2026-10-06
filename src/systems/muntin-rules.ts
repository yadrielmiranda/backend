export const MUNTIN_ASSIGNMENTS_INCLUDE = {
  include: { rule: { include: { allowedTypes: { select: { muntinTypeId: true } } } } },
} as const;

export type MuntinCatalogRule = {
  ruleId: number;
  crystalId: number;
  patternId: number;
  availability: 'ALL' | 'SELECTED';
  allowedTypeIds: number[];
};

type Assignment = {
  ruleId: number;
  idCrystal: number;
  patternId: number;
  rule: { availability: 'ALL' | 'SELECTED'; allowedTypes: Array<{ muntinTypeId: number }> };
};

export function catalogMuntinRules(assignments: Assignment[]): MuntinCatalogRule[] {
  return assignments.map(link => ({
    ruleId: link.ruleId,
    crystalId: link.idCrystal,
    patternId: link.patternId,
    availability: link.rule.availability,
    allowedTypeIds: link.rule.allowedTypes.map(type => type.muntinTypeId).sort((a, b) => a - b),
  }));
}

export function withMuntinRules<T extends { muntinAssignments: Assignment[] }>(sysConf: T) {
  const { muntinAssignments, ...fields } = sysConf;
  return { ...fields, muntinRules: catalogMuntinRules(muntinAssignments) };
}
