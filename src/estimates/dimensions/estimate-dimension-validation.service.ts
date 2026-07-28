import { Injectable, BadRequestException } from '@nestjs/common';
import {
  DimensionMode,
  DimensionRuleType,
  PricingComponentType,
  PrismaClient,
} from '@prisma/client';

import { normalizeInchesToEighthStep } from '@/common/dimensions';
import { CreatePieceDto } from '@/pieces/dto/create-piece.dto';
export type PrismaTransactionClient = Omit<
  PrismaClient,
  | '$connect'
  | '$disconnect'
  | '$on'
  | '$transaction'
  | '$use'
  | '$extends'
>;

export type DimensionValidationResult = {
  ok: boolean;
  reason?: 'NOT_RATED' | 'OVERSIZE';
  dpPos?: number;
  dpNeg?: number;
  anchorsPerJamb?: number;
  extraAnchor?: boolean;
  usedRange?: { w: [number, number]; h: [number, number] };
  suggestion?: {
    maxWidthIn?: number;
    maxHeightIn?: number;
    minWidthIn?: number;
    minHeightIn?: number;
  };
  belowMinimum?: boolean;
  note?: string;
};

type DimensionValidationCheck = {
  ruleType: DimensionRuleType;
  widthIn: number;
  heightIn: number;
  label: string;
};

const MIN_TRANSOM_HEIGHT_IN = 10;
const MIN_WINDOW_HEIGHT_IN = 24.125;
const MIN_FIX_HEIGHT_IN = 12;

@Injectable()
export class EstimateDimensionValidationService {
  numberInchesOrZero(
    value: string | number | null | undefined,
    label: string,
  ) {
    return value == null || value === ''
      ? 0
      : normalizeInchesToEighthStep(value, label, 1);
  }

  resolveEcoNovoOverallWidth(dto: {
    width?: string | number | null;
    doorWidth?: string | number | null;
    leftSideliteWidth?: string | number | null;
    rightSideliteWidth?: string | number | null;
    leftPanels?: number | string | null;
    rightPanels?: number | string | null;
  }) {
    const fallbackWidth = this.numberInchesOrZero(dto.width, 'Width');

    const doorWidth = this.numberInchesOrZero(dto.doorWidth, 'Door Width');
    const leftSideliteWidth = this.numberInchesOrZero(
      dto.leftSideliteWidth,
      'Left Sidelite Width',
    );
    const rightSideliteWidth = this.numberInchesOrZero(
      dto.rightSideliteWidth,
      'Right Sidelite Width',
    );

    const leftPanels = Number(dto.leftPanels ?? 0);
    const rightPanels = Number(dto.rightPanels ?? 0);

    const hasSegmentedWidth =
      doorWidth > 0 || leftSideliteWidth > 0 || rightSideliteWidth > 0;

    if (!hasSegmentedWidth) {
      return fallbackWidth;
    }

    if (doorWidth <= 0) {
      throw new BadRequestException('Door Width is required.');
    }

    if (
      leftSideliteWidth > 0 &&
      (!Number.isFinite(leftPanels) || leftPanels < 1)
    ) {
      throw new BadRequestException('Left Panels is required.');
    }

    if (
      rightSideliteWidth > 0 &&
      (!Number.isFinite(rightPanels) || rightPanels < 1)
    ) {
      throw new BadRequestException('Right Panels is required.');
    }

    return (
      doorWidth +
      leftSideliteWidth * Math.trunc(leftPanels || 0) +
      rightSideliteWidth * Math.trunc(rightPanels || 0)
    );
  }

  // Estima la altura gobernante.
  // STANDARD usa los flags viejos de Config para no romper Picture/Tombstone/Eyebrow.
  // Los modos nuevos usan dimensionMode desde SysConf.
  async computeGoverningDimsFromConfig(
    pieceDto: {
      idSyst: number;
      idConf: number;
      width?: string | number | null;
      height?: string | number | null;
      heightLeft?: string | number | null;
      heightRight?: string | number | null;
      legHeight?: string | number | null;
      doorWidth?: string | number | null;
      leftSideliteWidth?: string | number | null;
      rightSideliteWidth?: string | number | null;
      leftPanels?: number | string | null;
      rightPanels?: number | string | null;
      panelCount?: number | string | null;
      horizontalHeights?: number[] | null;
    },
    tx: PrismaTransactionClient,
  ): Promise<{ widthIn: number; heightIn: number }> {
    const [cfg, sysConf] = await Promise.all([
      tx.config.findUnique({
        where: { id: pieceDto.idConf },
        select: {
          requiresHeightLeft: true,
          requiresHeightRight: true,
          requiresLegHeight: true,
        },
      }),
      tx.sysConf.findUnique({
        where: {
          idSystem_idConfig: {
            idSystem: pieceDto.idSyst,
            idConfig: pieceDto.idConf,
          },
        },
        select: {
          dimensionMode: true,
        },
      }),
    ]);

    if (!sysConf) {
      throw new BadRequestException(
        'The selected configuration does not belong to the selected system.',
      );
    }

    const dimensionMode = sysConf.dimensionMode ?? DimensionMode.STANDARD;

    const num = (v: any, label: string) =>
      v == null || v === '' ? 0 : normalizeInchesToEighthStep(v, label, 1);

    const h = num(pieceDto.height, 'Height');

    if (dimensionMode === DimensionMode.ECO_WINDOWS_DOOR) {
      return {
        widthIn: num(pieceDto.width, 'Open Width'),
        heightIn: h,
      };
    }

    if (dimensionMode === DimensionMode.ECO_NOVO_DOOR) {
      return {
        widthIn: this.resolveEcoNovoOverallWidth(pieceDto),
        heightIn: h,
      };
    }

    if (dimensionMode === DimensionMode.WINDOW_WALL) {
      return {
        widthIn: num(pieceDto.width, 'Open Width'),
        heightIn: h,
      };
    }

    // comentario en espanol: comportamiento viejo intacto para STANDARD
    const widthIn = num(pieceDto.width, 'Width');

    const hl = cfg?.requiresHeightLeft
      ? num(pieceDto.heightLeft, 'Height Left')
      : 0;

    const hr = cfg?.requiresHeightRight
      ? num(pieceDto.heightRight, 'Height Right')
      : 0;

    const lh = cfg?.requiresLegHeight
      ? num(pieceDto.legHeight, 'Leg Height')
      : 0;

    const heightIn = Math.max(h, hl, hr, lh);

    return { widthIn, heightIn: heightIn || h };
  }

  private async resolveDimensionPolicyReinforcement(
    dto: CreatePieceDto,
    tx: PrismaTransactionClient,
  ): Promise<number | null> {
    const selectedId = dto.idReinforcementOption ?? null;

    const associatedOptions = await tx.sysConfReinforcementOption.findMany({
      where: {
        idSystem: dto.idSyst,
        idConfig: dto.idConf,
      },
      select: {
        optionId: true,
      },
    });

    // comentario en español: si esta SysConf no usa reinforcement,
    // la DimensionPolicy debe buscarse con idReinforcementOption = null.
    if (associatedOptions.length === 0) {
      if (selectedId != null) {
        throw new BadRequestException(
          'Reinforcement option is not allowed for the selected configuration.',
        );
      }

      return null;
    }

    // comentario en español: si esta SysConf sí usa reinforcement,
    // la pieza debe traer una opción válida.
    if (selectedId == null) {
      throw new BadRequestException(
        'Reinforcement option is required for the selected configuration.',
      );
    }

    const isAllowed = associatedOptions.some(
      (option) => option.optionId === selectedId,
    );

    if (!isAllowed) {
      throw new BadRequestException(
        'Reinforcement option is invalid for the selected configuration.',
      );
    }

    return selectedId;
  }

  async validateAgainstDimensionPolicy(
    dto: CreatePieceDto,
    tx: PrismaTransactionClient,
  ): Promise<DimensionValidationResult> {
    const idReinforcementOption =
      await this.resolveDimensionPolicyReinforcement(dto, tx);

    const policy = await tx.dimensionPolicy.findFirst({
      where: {
        idSystem: dto.idSyst,
        idConfig: dto.idConf,
        idCrystal: dto.idCryst,
        idReinforcementOption,
        isActive: true,
      },
      include: { rules: true },
    });

    if (!policy || !policy.rules || policy.rules.length === 0) {
      return {
        ok: false,
        reason: 'NOT_RATED',
        note:
          idReinforcementOption == null
            ? 'No dimension policy exists for this System + Config + Crystal.'
            : 'No dimension policy exists for this System + Config + Crystal + Reinforcement.',
      };
    }

    const checks = await this.buildDimensionValidationChecks(
      dto,
      tx,
      policy.rules,
    );

    if (checks.length === 0) {
      return { ok: false, reason: 'NOT_RATED' };
    }

    const passed: Array<{
      check: DimensionValidationCheck;
      result: DimensionValidationResult;
    }> = [];

    for (const check of checks) {
      const result = this.validateDimensionCheckAgainstRules(policy, check);

      if (!result.ok) {
        return {
          ...result,
          note: result.note
            ? `${check.label}: ${result.note}`
            : `${check.label}`,
        };
      }

      passed.push({ check, result });
    }

    const dpPosValues = passed
      .map((x) => x.result.dpPos)
      .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));

    const dpNegValues = passed
      .map((x) => x.result.dpNeg)
      .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));

    const first = passed[0]?.result;
    const main = passed.find(
      (x) => x.check.ruleType === DimensionRuleType.MAIN,
    )?.result;

    return {
      ok: true,
      dpPos:
        main?.dpPos ??
        (dpPosValues.length ? Math.min(...dpPosValues) : first?.dpPos),
      dpNeg:
        main?.dpNeg ??
        (dpNegValues.length ? Math.max(...dpNegValues) : first?.dpNeg),
      usedRange: main?.usedRange ?? first?.usedRange,
      note: passed
        .map((x) => `${x.check.label}: ${x.result.note ?? 'OK'}`)
        .join(' | '),
    };
  }

  private async buildDimensionValidationChecks(
    dto: CreatePieceDto,
    tx: PrismaTransactionClient,
    policyRules: Array<{ ruleType: DimensionRuleType }>,
  ): Promise<DimensionValidationCheck[]> {
    const [cfg, sysConf] = await Promise.all([
      tx.config.findUnique({
        where: { id: dto.idConf },
        select: {
          requiresHeightLeft: true,
          requiresHeightRight: true,
          requiresLegHeight: true,
          requiresWindowHeight: true,
        },
      }),
      tx.sysConf.findUnique({
        where: {
          idSystem_idConfig: {
            idSystem: dto.idSyst,
            idConfig: dto.idConf,
          },
        },
        select: {
          dimensionMode: true,
          requiresDoorWidth: true,
          requiresLeftSideliteWidth: true,
          requiresRightSideliteWidth: true,
          requiresPanelCount: true,
          pricingComponents: {
            select: {
              componentType: true,
              quantity: true,
            },
          },
        },
      }),
    ]);

    if (!sysConf) {
      throw new BadRequestException(
        'The selected configuration does not belong to the selected system.',
      );
    }

    const dimensionMode = sysConf.dimensionMode ?? DimensionMode.STANDARD;

    const num = (value: unknown, label: string) =>
      value == null || value === ''
        ? 0
        : normalizeInchesToEighthStep(value as any, label, 1);

    const heightIn = num(dto.height, 'Height');

    if (dimensionMode === DimensionMode.STANDARD) {
      const widthIn = num(dto.width, 'Width');
      const heightLeft = cfg?.requiresHeightLeft
        ? num(dto.heightLeft, 'Height Left')
        : 0;
      const heightRight = cfg?.requiresHeightRight
        ? num(dto.heightRight, 'Height Right')
        : 0;
      const legHeight = cfg?.requiresLegHeight
        ? num(dto.legHeight, 'Leg Height')
        : 0;

      if (cfg?.requiresWindowHeight) {
        const windowHeightRaw = (dto as any).windowHeight;

        if (windowHeightRaw == null || windowHeightRaw === '') {
          throw new BadRequestException('Window Height is required.');
        }

        const windowHeightIn = num(windowHeightRaw, 'Window Height');

        if (windowHeightIn < MIN_WINDOW_HEIGHT_IN) {
          throw new BadRequestException(
            `Window Height must be at least ${MIN_WINDOW_HEIGHT_IN} inches.`,
          );
        }

        const fixHeightIn = heightIn - windowHeightIn;

        if (fixHeightIn < MIN_FIX_HEIGHT_IN) {
          throw new BadRequestException(
            `FIX Height (Open Height - Window Height) must be at least ${MIN_FIX_HEIGHT_IN} inches.`,
          );
        }
      }

      return [
        {
          ruleType: DimensionRuleType.MAIN,
          widthIn,
          heightIn: Math.max(heightIn, heightLeft, heightRight, legHeight),
          label: 'MAIN',
        },
      ];
    }

    if (dimensionMode === DimensionMode.WINDOW_WALL) {
      const openWidth = num(dto.width, 'Open Width');
      const panelCount = Number((dto as any).panelCount ?? 0);

      if (!Number.isFinite(panelCount) || panelCount < 1) {
        throw new BadRequestException('Panel Count is required.');
      }

      return [
        {
          ruleType: DimensionRuleType.MAIN,
          widthIn: normalizeInchesToEighthStep(
            openWidth / Math.trunc(panelCount),
            'Panel Width',
            1,
          ),
          heightIn,
          label: 'MAIN panel',
        },
      ];
    }

    const policyRuleTypes = new Set(
      policyRules.map((rule) => rule.ruleType),
    );

    const configuredComponentTypes = new Set(
      sysConf.pricingComponents.map(
        (component) => component.componentType,
      ),
    );

    const hasConfiguredComponents =
      configuredComponentTypes.size > 0;

    const expectsDoor = hasConfiguredComponents
      ? configuredComponentTypes.has(PricingComponentType.DOOR)
      : policyRuleTypes.has(DimensionRuleType.DOOR);

    const expectsSidelite = hasConfiguredComponents
      ? configuredComponentTypes.has(PricingComponentType.SIDELITE)
      : policyRuleTypes.has(DimensionRuleType.SIDELITE);

    const expectsMain = policyRuleTypes.has(DimensionRuleType.MAIN);

    const doorWidthRaw = (dto as any).doorWidth;
    const doorHeightRaw = (dto as any).doorHeight;
    const leftSideliteWidthRaw = (dto as any).leftSideliteWidth;
    const rightSideliteWidthRaw = (dto as any).rightSideliteWidth;

    const hasDoorWidth =
      doorWidthRaw != null && doorWidthRaw !== '';

    const hasDoorHeight =
      doorHeightRaw != null && doorHeightRaw !== '';

    const hasLeftSideliteWidth =
      leftSideliteWidthRaw != null &&
      leftSideliteWidthRaw !== '';

    const hasRightSideliteWidth =
      rightSideliteWidthRaw != null &&
      rightSideliteWidthRaw !== '';

    // XT/XXT se valida como una sola pieza: DOOR controla la altura
    // de la puerta y MAIN controla la altura total del frame.
    const validatesDoorAndOpening = expectsDoor && expectsMain;

    let lowerComponentHeightIn = heightIn;

    if (validatesDoorAndOpening) {
      if (!hasDoorHeight) {
        throw new BadRequestException(
          'Door Height is required for this configuration.',
        );
      }

      const doorHeightIn = num(
        doorHeightRaw,
        'Door Height',
      );

      if (doorHeightIn <= 0) {
        throw new BadRequestException(
          'Door Height must be greater than zero.',
        );
      }

      const transomHeightIn = heightIn - doorHeightIn;

      if (transomHeightIn < MIN_TRANSOM_HEIGHT_IN) {
        throw new BadRequestException(
          `Transom Height (Opening Height - Door Height) must be at least ${MIN_TRANSOM_HEIGHT_IN} inches.`,
        );
      }

      lowerComponentHeightIn = doorHeightIn;
    }

    if (dimensionMode === DimensionMode.ECO_WINDOWS_DOOR) {
      const openWidth = num(dto.width, 'Opening Width');
      const checks: DimensionValidationCheck[] = [];

      let resolvedDoorWidth: number | null = null;

      if (expectsDoor) {
        // Eco Windows solamente necesita Door Width cuando existen sidelites.
        if (expectsSidelite && !hasDoorWidth) {
          throw new BadRequestException(
            'Door Width is required when sidelites are used.',
          );
        }

        resolvedDoorWidth = hasDoorWidth
          ? num(doorWidthRaw, 'Door Width')
          : openWidth;

        checks.push({
          ruleType: DimensionRuleType.DOOR,
          widthIn: resolvedDoorWidth,
          heightIn: lowerComponentHeightIn,
          label: 'DOOR',
        });
      }

      if (expectsSidelite) {
        let sideliteWidth: number;

        if (hasConfiguredComponents) {
          const sideliteComponent =
            sysConf.pricingComponents.find(
              (component) =>
                component.componentType ===
                PricingComponentType.SIDELITE,
            );

          const sideliteQuantity = Number(
            sideliteComponent?.quantity ?? 0,
          );

          if (
            !Number.isInteger(sideliteQuantity) ||
            sideliteQuantity < 1
          ) {
            throw new BadRequestException(
              'Sidelite Quantity must be configured for this composite configuration.',
            );
          }

          const occupiedDoorWidth =
            resolvedDoorWidth ?? 0;

          if (occupiedDoorWidth >= openWidth) {
            throw new BadRequestException(
              'Opening Width must be greater than Door Width when sidelites are used.',
            );
          }

          sideliteWidth =
            normalizeInchesToEighthStep(
              (openWidth - occupiedDoorWidth) /
              sideliteQuantity,
              'Sidelite Width',
              1,
            );
        } else {
          // Configuración directa O.
          sideliteWidth = openWidth;
        }

        checks.push({
          ruleType: DimensionRuleType.SIDELITE,
          widthIn: sideliteWidth,
          heightIn: lowerComponentHeightIn,
          label: 'SIDELITE',
        });
      }

      if (validatesDoorAndOpening) {
        checks.push({
          ruleType: DimensionRuleType.MAIN,
          widthIn: openWidth,
          heightIn,
          label: 'MAIN',
        });
      }

      return checks;
    }

    // Los modos que llegan aquí son principalmente ECO_NOVO_DOOR.
    const checks: DimensionValidationCheck[] = [];

    if (expectsDoor) {
      if (hasDoorWidth) {
        checks.push({
          ruleType: DimensionRuleType.DOOR,
          widthIn: num(doorWidthRaw, 'Door Width'),
          heightIn: lowerComponentHeightIn,
          label: 'DOOR',
        });
      } else if (!hasConfiguredComponents && !expectsSidelite) {
        // Configuración directa X/XX o frame completo XT/XXT.
        checks.push({
          ruleType: DimensionRuleType.DOOR,
          widthIn: num(dto.width, 'Door Width'),
          heightIn: lowerComponentHeightIn,
          label: 'DOOR',
        });
      } else {
        throw new BadRequestException(
          'Door Width is required for the composite dimension policy.',
        );
      }
    }

    let hasSideliteCheck = false;

    if (expectsSidelite && hasLeftSideliteWidth) {
      checks.push({
        ruleType: DimensionRuleType.SIDELITE,
        widthIn: num(
          leftSideliteWidthRaw,
          'Left Sidelite Width',
        ),
        heightIn: lowerComponentHeightIn,
        label: 'LEFT SIDELITE',
      });

      hasSideliteCheck = true;
    }

    if (expectsSidelite && hasRightSideliteWidth) {
      checks.push({
        ruleType: DimensionRuleType.SIDELITE,
        widthIn: num(
          rightSideliteWidthRaw,
          'Right Sidelite Width',
        ),
        heightIn: lowerComponentHeightIn,
        label: 'RIGHT SIDELITE',
      });

      hasSideliteCheck = true;
    }

    if (
      expectsSidelite &&
      !hasSideliteCheck &&
      !hasConfiguredComponents &&
      !expectsDoor
    ) {
      // Configuración directa O.
      checks.push({
        ruleType: DimensionRuleType.SIDELITE,
        widthIn: num(dto.width, 'Sidelite Width'),
        heightIn: lowerComponentHeightIn,
        label: 'SIDELITE',
      });

      hasSideliteCheck = true;
    }

    if (
      expectsSidelite &&
      !hasSideliteCheck
    ) {
      throw new BadRequestException(
        'At least one Sidelite Width is required for the composite dimension policy.',
      );
    }

    if (validatesDoorAndOpening) {
      const overallWidth = this.resolveEcoNovoOverallWidth(dto);

      checks.push({
        ruleType: DimensionRuleType.MAIN,
        widthIn: overallWidth,
        heightIn,
        label: 'MAIN',
      });
    }

    return checks;
  }

  private validateDimensionCheckAgainstRules(
    policy: any,
    check: DimensionValidationCheck,
  ): DimensionValidationResult {
    const rules = (policy.rules ?? []).filter(
      (r: any) => r.ruleType === check.ruleType,
    );

    if (rules.length === 0) {
      return {
        ok: false,
        reason: 'NOT_RATED',
        note: `No ${check.ruleType} rules found for this policy.`,
      };
    }

    const allWidths = rules.map((r: any) => Number(r.widthIn));
    const allHeights = rules.map((r: any) => Number(r.heightIn));
    const minW = Math.min(...allWidths);
    const minH = Math.min(...allHeights);

    if (check.widthIn < minW || check.heightIn < minH) {
      return {
        ok: false,
        reason: 'OVERSIZE',
        belowMinimum: true,
        suggestion: {
          minWidthIn: minW,
          minHeightIn: minH,
          maxWidthIn: minW,
          maxHeightIn: minH,
        },
        note: `${check.ruleType} below minimum.`,
      };
    }

    const pickExactRule = (w: number, h: number) =>
      rules.find(
        (r: any) => Number(r.widthIn) === w && Number(r.heightIn) === h,
      ) ?? null;

    const uniqueSorted = (arr: number[]) =>
      [...new Set(arr)].sort((a, b) => a - b);

    const widthValues = uniqueSorted(rules.map((r: any) => Number(r.widthIn)));
    const heightValues = uniqueSorted(rules.map((r: any) => Number(r.heightIn)));

    const nextOrSame = (values: number[], v: number): number | null => {
      for (const val of values) {
        if (val >= v) return val;
      }
      return null;
    };

    const nearest = (values: number[], v: number): number | null => {
      if (!values.length) return null;

      let best = values[0];
      let bestDist = Math.abs(values[0] - v);

      for (const val of values) {
        const d = Math.abs(val - v);
        if (d < bestDist) {
          bestDist = d;
          best = val;
        }
      }

      return best;
    };

    let rule: any | null = pickExactRule(check.widthIn, check.heightIn);
    let suggestion: { maxWidthIn?: number; maxHeightIn?: number } | undefined;

    if (!rule) {
      if (policy.roundingRule === 'ROUND_UP_TO_NEXT') {
        const wNext = nextOrSame(widthValues, check.widthIn);
        const hNext = nextOrSame(heightValues, check.heightIn);

        if (wNext != null && hNext != null) {
          rule = pickExactRule(wNext, hNext);
          if (!rule) {
            suggestion = { maxWidthIn: wNext, maxHeightIn: hNext };
          }
        }
      } else {
        const wNear = nearest(widthValues, check.widthIn);
        const hNear = nearest(heightValues, check.heightIn);

        if (wNear != null && hNear != null) {
          rule = pickExactRule(wNear, hNear);
          if (!rule) {
            suggestion = { maxWidthIn: wNear, maxHeightIn: hNear };
          }
        }
      }
    }

    if (!rule) {
      const maxW = widthValues[widthValues.length - 1];
      const maxH = heightValues[heightValues.length - 1];

      return {
        ok: false,
        reason: 'OVERSIZE',
        suggestion: suggestion ?? {
          maxWidthIn: maxW,
          maxHeightIn: maxH,
        },
        note: `${check.ruleType} exceeds NOA limits.`,
      };
    }

    return {
      ok: true,
      dpPos: Number(rule.dpPosPsf),
      dpNeg: Number(rule.dpNegPsf),
      usedRange: {
        w: [Number(rule.widthIn), Number(rule.widthIn)],
        h: [Number(rule.heightIn), Number(rule.heightIn)],
      },
      note: rule.note ?? undefined,
    };
  }
}
