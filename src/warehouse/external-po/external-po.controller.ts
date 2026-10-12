import { Body, Controller, Post, Req, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import type { Request } from 'express';
import { Roles } from '@/auth/roles.decorator';
import type { AuthUser } from '@/auth/types/auth-user.type';
import { MAX_FACTORY_FILE_BYTES } from '@/orders/factory-import/factory-import-matching';
import { ExternalPoService } from './external-po.service';

const externalPoFile = FileInterceptor('file', {
  storage: memoryStorage(),
  limits: { fileSize: MAX_FACTORY_FILE_BYTES, files: 1, fields: 3, fieldSize: 1024 * 1024 },
});

@Controller('warehouse/external-po')
@Roles('admin')
export class ExternalPoController {
  constructor(private readonly imports: ExternalPoService) {}

  @Post('preview')
  @UseInterceptors(externalPoFile)
  preview(@UploadedFile() file: Express.Multer.File | undefined, @Req() req: Request) {
    return this.imports.preview(file?.buffer, req.user as AuthUser);
  }

  @Post('confirm')
  @UseInterceptors(externalPoFile)
  confirm(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() fields: { revision?: string; parts?: string; reviewed?: string },
    @Req() req: Request,
  ) {
    return this.imports.confirm(file?.buffer, fields, req.user as AuthUser);
  }
}
