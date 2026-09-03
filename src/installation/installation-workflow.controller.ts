import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { Request } from 'express';
import type { AuthUser } from '@/auth/types/auth-user.type';
import { Roles } from '@/auth/roles.decorator';
import { InstallationWorkflowService } from './installation-workflow.service';
import {
  AddInstallationLineDto,
  AddInstallationMeasurementDto,
  CancelInstallationDto,
  InstallationApprovalDto,
  ProposeInstallationMeasurementPieceDto,
  ProposeInstallationAppointmentDto,
  RequestInstallationDto,
  RespondInstallationAppointmentDto,
  SubmitInstallationQuoteDto,
  UpdateInstallationMeasurementDto,
  UpdateInstallationPermitDto,
  UpdateInstallationRequestDto,
} from './dto/installation-workflow.dto';
import { FindInstallationJobsQueryDto } from './dto/find-installation-jobs-query.dto';

@Controller()
export class InstallationWorkflowController {
  constructor(private readonly workflow: InstallationWorkflowService) {}

  @Get('installations')
  findAll(
    @Query() query: FindInstallationJobsQueryDto,
    @Req() req: Request,
  ) {
    return this.workflow.findJobs(query, req.user as AuthUser);
  }

  @Get('installations/:id')
  findOne(
    @Param('id', ParseIntPipe) id: number,
    @Req() req: Request,
  ) {
    return this.workflow.findJob(id, req.user as AuthUser);
  }

  @Get('estimates/:estimateId/installation')
  findByEstimate(
    @Param('estimateId', ParseIntPipe) estimateId: number,
    @Req() req: Request,
  ) {
    return this.workflow.findJobByEstimate(estimateId, req.user as AuthUser);
  }

  @Post('estimates/:estimateId/installation')
  requestInstallation(
    @Param('estimateId', ParseIntPipe) estimateId: number,
    @Body() dto: RequestInstallationDto,
    @Req() req: Request,
  ) {
    return this.workflow.requestInstallation(
      estimateId,
      dto,
      req.user as AuthUser,
    );
  }

  @Patch('installations/:id/request')
  updateInstallationRequest(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateInstallationRequestDto,
    @Req() req: Request,
  ) {
    return this.workflow.updateInstallationRequest(
      id,
      dto,
      req.user as AuthUser,
    );
  }

  @Post('installations/:id/cancel')
  cancelInstallation(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CancelInstallationDto,
    @Req() req: Request,
  ) {
    return this.workflow.cancelInstallation(
      id,
      dto,
      req.user as AuthUser,
    );
  }

  @Roles('admin', 'operator')
  @Post('installations/:id/measurements')
  addMeasurement(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: AddInstallationMeasurementDto,
    @Req() req: Request,
  ) {
    return this.workflow.addMeasurement(id, dto, req.user as AuthUser);
  }

  @Roles('admin', 'operator')
  @Patch('installations/:id/measurements/:measurementId')
  updateMeasurement(
    @Param('id', ParseIntPipe) id: number,
    @Param('measurementId', ParseIntPipe) measurementId: number,
    @Body() dto: UpdateInstallationMeasurementDto,
    @Req() req: Request,
  ) {
    return this.workflow.updateMeasurement(
      id,
      measurementId,
      dto,
      req.user as AuthUser,
    );
  }

  @Roles('admin', 'operator')
  @Patch('installations/:id/measurements/:measurementId/piece')
  proposeMeasurementPiece(
    @Param('id', ParseIntPipe) id: number,
    @Param('measurementId', ParseIntPipe) measurementId: number,
    @Body() dto: ProposeInstallationMeasurementPieceDto,
    @Req() req: Request,
  ) {
    return this.workflow.proposeMeasurementPiece(
      id,
      measurementId,
      dto,
      req.user as AuthUser,
    );
  }

  @Post('installations/:id/lines')
  addLine(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: AddInstallationLineDto,
    @Req() req: Request,
  ) {
    return this.workflow.addLine(id, dto, req.user as AuthUser);
  }

  @Delete('installations/:id/lines/:lineId')
  removeLine(
    @Param('id', ParseIntPipe) id: number,
    @Param('lineId', ParseIntPipe) lineId: number,
    @Req() req: Request,
  ) {
    return this.workflow.removeLine(id, lineId, req.user as AuthUser);
  }

  @Roles('admin', 'operator')
  @Post('installations/:id/rebuild')
  rebuild(
    @Param('id', ParseIntPipe) id: number,
    @Req() req: Request,
  ) {
    return this.workflow.rebuildQuote(id, req.user as AuthUser);
  }

  @Roles('admin', 'operator')
  @Post('installations/:id/submit')
  submit(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: SubmitInstallationQuoteDto,
    @Req() req: Request,
  ) {
    return this.workflow.submitQuote(id, dto, req.user as AuthUser);
  }

  @Roles('admin')
  @Post('installations/:id/admin-decision')
  adminDecision(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: InstallationApprovalDto,
    @Req() req: Request,
  ) {
    return this.workflow.adminDecision(id, dto, req.user as AuthUser);
  }

  @Post('installations/:id/customer-decision')
  customerDecision(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: InstallationApprovalDto,
    @Req() req: Request,
  ) {
    return this.workflow.customerDecision(id, dto, req.user as AuthUser);
  }

  @Roles('admin', 'operator')
  @Patch('installations/:id/permit')
  updatePermit(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateInstallationPermitDto,
    @Req() req: Request,
  ) {
    return this.workflow.updatePermit(id, dto, req.user as AuthUser);
  }

  @Roles('admin', 'operator')
  @Post('installations/:id/appointments')
  proposeAppointment(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ProposeInstallationAppointmentDto,
    @Req() req: Request,
  ) {
    return this.workflow.proposeAppointment(id, dto, req.user as AuthUser);
  }

  @Post('installation-appointments/:appointmentId/respond')
  respondAppointment(
    @Param('appointmentId', ParseIntPipe) appointmentId: number,
    @Body() dto: RespondInstallationAppointmentDto,
    @Req() req: Request,
  ) {
    return this.workflow.respondAppointment(
      appointmentId,
      dto,
      req.user as AuthUser,
    );
  }

  @Roles('admin', 'operator')
  @Post('installations/:id/start')
  start(
    @Param('id', ParseIntPipe) id: number,
    @Req() req: Request,
  ) {
    return this.workflow.startJob(id, req.user as AuthUser);
  }

  @Roles('admin', 'operator')
  @Post('installations/:id/complete')
  complete(
    @Param('id', ParseIntPipe) id: number,
    @Req() req: Request,
  ) {
    return this.workflow.completeJob(id, req.user as AuthUser);
  }
}
