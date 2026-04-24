import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { ValidationPipe } from "@nestjs/common";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import * as cookieParser from "cookie-parser";
import { NestExpressApplication } from "@nestjs/platform-express";
import { join } from "path";

async function bootstrap() {
  // CLAVE: rawBody true para Stripe webhooks 
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
  });

  app.setGlobalPrefix("api");

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
    origin: ["http://localhost:3000", "http://10.0.0.4:3000"],
    credentials: true,
  });

  app.useStaticAssets(join(process.cwd(), "uploads"), {
    prefix: "/uploads",
  });

  const config = new DocumentBuilder()
    .setTitle("Impact PLUS")
    .setDescription("The Impact PLUS API description")
    .setVersion("1.0")
    .addTag("windows and doors")
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup("api", app, document);

  await app.listen(process.env.PORT ?? 4000);
}

bootstrap();
