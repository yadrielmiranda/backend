import { BadRequestException, Controller, Get, Param, Post, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import type { Response } from 'express';
import { Roles } from '@/auth/roles.decorator';
import { MATERIAL_IMAGE_LIMIT, readMaterialImage, saveMaterialImage } from './materials-images';

@Controller('materials/images')
@Roles('admin', 'operator', 'client', 'dealer')
export class MaterialsImagesController {
  @Post()
  @Roles('admin')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: MATERIAL_IMAGE_LIMIT, files: 1, fields: 0 } }))
  upload(@UploadedFile() file?: Express.Multer.File) {
    if (!file?.buffer) throw new BadRequestException('Choose a product image.');
    return saveMaterialImage(file.buffer);
  }

  @Get(':key')
  async image(@Param('key') key: string, @Res() response: Response) {
    const { buffer, contentType } = await readMaterialImage(key);
    response.setHeader('Content-Type', contentType);
    response.setHeader('Content-Length', buffer.length);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Disposition', 'inline');
    response.setHeader('Cache-Control', 'private, no-store');
    response.send(buffer);
  }
}
