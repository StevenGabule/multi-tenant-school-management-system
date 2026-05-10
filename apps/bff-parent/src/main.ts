import './instrumentation';
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
  const port = process.env.BFF_PARENT_PORT ?? process.env.PORT ?? 3005;
  await app.listen(port);
  Logger.log(
    `bff-parent listening on http://localhost:${port} (api prefix: /${globalPrefix})`,
  );
}

bootstrap();
