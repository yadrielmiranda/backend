import { Body, Controller, Param, ParseIntPipe, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { Roles } from '@/auth/roles.decorator';
import type { AuthUser } from '@/auth/types/auth-user.type';
import { MaterialStoreIssueDto } from './materials-store-issue.dto';
import { MaterialsStoreIssueService } from './materials-store-issue.service';

@Controller('materials/stores')
@Roles('admin', 'operator')
export class MaterialsStoreIssueController {
  constructor(private readonly issue: MaterialsStoreIssueService) {}

  @Post(':storeId/internal-use')
  internalUse(@Param('storeId', ParseIntPipe) storeId: number, @Body() dto: MaterialStoreIssueDto, @Req() req: Request) {
    return this.issue.internalUse(storeId, dto, req.user as AuthUser);
  }
}
