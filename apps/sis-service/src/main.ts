import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app/app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const globalPrefix = 'api';
  app.setGlobalPrefix(globalPrefix, {
    exclude: ['livez', 'readyz'],
  });
  app.enableShutdownHooks();
  const port = process.env.SIS_SERVICE_PORT ?? process.env.PORT ?? 3002;
  await app.listen(port);
  Logger.log(
    `sis-service listening on http://localhost:${port} (api prefix: /${globalPrefix})`,
  );
}

bootstrap();
