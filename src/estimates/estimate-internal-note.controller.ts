import { Body, Controller, Get, Param, ParseIntPipe, Patch, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '@/auth/guards/auth/auth.guard';
import type { AuthUser } from '@/auth/types/auth-user.type';
import { UpdateEstimateInternalNoteDto } from './dto/estimate-internal-note.dto';
import { EstimateInternalNoteService } from './estimate-internal-note.service';

@UseGuards(JwtAuthGuard)
@Controller('estimates')
export class EstimateInternalNoteController {
  constructor(private readonly notes: EstimateInternalNoteService) {}

  @Get(':id/internal-note')
  get(@Param('id', ParseIntPipe) id: number, @Req() req: Request) {
    return this.notes.getForEstimate(id, req.user as AuthUser);
  }

  @Patch(':id/internal-note')
  save(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateEstimateInternalNoteDto, @Req() req: Request) {
    return this.notes.saveForEstimate(id, dto, req.user as AuthUser);
  }
}
