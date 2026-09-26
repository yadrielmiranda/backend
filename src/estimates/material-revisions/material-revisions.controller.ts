import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '@/auth/guards/auth/auth.guard';
import type { AuthUser } from '@/auth/types/auth-user.type';
import { MaterialRevisionsService } from './material-revisions.service';
import { BeginMaterialRevisionDto, MaterialRevisionDecisionDto, MaterialRevisionPieceDto, SubmitMaterialRevisionDto } from './material-revision.dto';

@UseGuards(JwtAuthGuard)
@Controller('estimates/:estimateId/material-revisions')
export class MaterialRevisionsController {
  constructor(private readonly service: MaterialRevisionsService) {}

  @Get()
  get(@Param('estimateId', ParseIntPipe) id: number, @Req() req: Request) {
    return this.service.get(id, req.user as AuthUser);
  }
  @Post()
  begin(@Param('estimateId', ParseIntPipe) id: number, @Body() dto: BeginMaterialRevisionDto, @Req() req: Request) {
    return this.service.begin(id, dto, req.user as AuthUser);
  }
  @Post(':revisionId/calculate-piece')
  calculate(@Param('estimateId', ParseIntPipe) id: number, @Param('revisionId', ParseIntPipe) revisionId: number,
    @Body() dto: MaterialRevisionPieceDto, @Req() req: Request) {
    return this.service.previewPiece(id, revisionId, dto, req.user as AuthUser);
  }
  @Post(':revisionId/pieces')
  save(@Param('estimateId', ParseIntPipe) id: number, @Param('revisionId', ParseIntPipe) revisionId: number,
    @Body() dto: MaterialRevisionPieceDto, @Req() req: Request) {
    return this.service.savePiece(id, revisionId, dto, req.user as AuthUser);
  }
  @Delete(':revisionId/items/:key')
  remove(@Param('estimateId', ParseIntPipe) id: number, @Param('revisionId', ParseIntPipe) revisionId: number,
    @Param('key') key: string, @Req() req: Request) {
    return this.service.removeItem(id, revisionId, key, req.user as AuthUser);
  }
  @Post(':revisionId/submit')
  submit(@Param('estimateId', ParseIntPipe) id: number, @Param('revisionId', ParseIntPipe) revisionId: number,
    @Body() dto: SubmitMaterialRevisionDto, @Req() req: Request) {
    return this.service.submit(id, revisionId, dto.accepted, req.user as AuthUser);
  }
  @Post(':revisionId/decision')
  decide(@Param('estimateId', ParseIntPipe) id: number, @Param('revisionId', ParseIntPipe) revisionId: number,
    @Body() dto: MaterialRevisionDecisionDto, @Req() req: Request) {
    return this.service.decide(id, revisionId, dto, req.user as AuthUser);
  }
}
