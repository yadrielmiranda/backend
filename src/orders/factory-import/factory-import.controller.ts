import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Req,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import type { Request } from 'express';
import { Roles } from '@/auth/roles.decorator';
import type { AuthUser } from '@/auth/types/auth-user.type';
import { FactoryImportService } from './factory-import.service';
import { MAX_FACTORY_FILE_BYTES } from './factory-import-matching';

// El archivo existe solamente en memoria durante la solicitud.
const factoryFile = FileInterceptor('file', {
  storage: memoryStorage(),
  limits: {
    fileSize: MAX_FACTORY_FILE_BYTES,
    files: 1,
    fields: 3,
    fieldSize: 1024 * 1024,
  },
});

@Controller('orders/:orderId/factory-import')
@Roles('admin')
export class FactoryImportController {
  constructor(private readonly imports: FactoryImportService) {}

  @Get()
  get(@Param('orderId', ParseIntPipe) orderId: number, @Req() req: Request) {
    return this.imports.get(orderId, req.user as AuthUser);
  }

  @Post('preview')
  @UseInterceptors(factoryFile)
  preview(
    @Param('orderId', ParseIntPipe) orderId: number,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Req() req: Request,
  ) {
    return this.imports.preview(orderId, file?.buffer, req.user as AuthUser);
  }

  @Post('confirm')
  @UseInterceptors(factoryFile)
  confirm(
    @Param('orderId', ParseIntPipe) orderId: number,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body()
    fields: { revision?: string; assignments?: string; reviewed?: string },
    @Req() req: Request,
  ) {
    return this.imports.confirm(
      orderId,
      file?.buffer,
      fields,
      req.user as AuthUser,
    );
  }
}
