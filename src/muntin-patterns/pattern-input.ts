import { BadRequestException } from '@nestjs/common';

type Input = { inputMode?: 'NONE' | 'GRID' | 'PRESET'; requiresType?: boolean; requiresLites?: boolean };

export function resolvePatternInput(data: Input, current?: Required<Input>): Required<Input> {
  const inputMode = data.inputMode ?? (data.requiresLites !== undefined
    ? data.requiresLites ? 'GRID' : 'NONE' : current?.inputMode ?? 'GRID');
  if (!['NONE', 'GRID', 'PRESET'].includes(inputMode))
    throw new BadRequestException('Invalid muntin input mode.');
  const requiresLites = inputMode === 'GRID';
  if (data.requiresLites !== undefined && data.requiresLites !== requiresLites)
    throw new BadRequestException('requiresLites must be true for GRID and false for NONE or PRESET.');
  const requiresType = data.requiresType ?? (inputMode === 'NONE' ? false : current?.requiresType ?? true);
  if (typeof requiresType !== 'boolean' || (inputMode === 'NONE' && requiresType))
    throw new BadRequestException('Full View (NONE) cannot require a muntin type.');
  return { inputMode, requiresType, requiresLites };
}
