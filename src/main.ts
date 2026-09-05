import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import * as cookieParser from 'cookie-parser';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'path';
import { BrandingType } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';

async function bootstrap() {
  // CLAVE: rawBody true para Stripe webhooks
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
  });

  app.setGlobalPrefix('api');

  app.use(cookieParser());

  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: false,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  app.enableCors({
    origin: process.env.FRONTEND_URL?.split(',') || [],
    credentials: true,
  });

  app.useStaticAssets(join(process.cwd(), 'uploads'), {
    prefix: '/uploads',
  });

  const prisma = app.get(PrismaService);
  const companyBranding = await prisma.branding.findFirst({
    where: { type: BrandingType.COMPANY, isActive: true },
    select: { name: true },
  });
  const companyName = companyBranding?.name?.trim() || 'Company';

  const config = new DocumentBuilder()
    .setTitle(`${companyName} API`)
    .setDescription(`API documentation for ${companyName}.`)
    .setVersion('1.0')
    .addTag('windows and doors')
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('docs', app, document);

  await app.listen(process.env.PORT ?? 4000);
}

bootstrap();
