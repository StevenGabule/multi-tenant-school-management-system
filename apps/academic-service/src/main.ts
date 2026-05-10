import './instrumentation';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ZodValidationPipe } from 'nestjs-zod';
import { AppModule } from './app/app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const globalPrefix = 'api';
  app.setGlobalPrefix(globalPrefix, {
    exclude: ['livez', 'readyz'],
  });
  app.useGlobalPipes(new ZodValidationPipe());
  app.enableShutdownHooks();
  const port = process.env.ACADEMIC_SERVICE_PORT ?? process.env.PORT ?? 3003;
  await app.listen(port);
  Logger.log(
    `academic-service listening on http://localhost:${port} (api prefix: /${globalPrefix})`,
  );
}

bootstrap();
