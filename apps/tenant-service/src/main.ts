import './instrumentation';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app/app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const globalPrefix = 'api';

  // Probes outside the API prefix so kubelet hits them directly,
  // matching the gateway's pattern.
  app.setGlobalPrefix(globalPrefix, {
    exclude: ['livez', 'readyz'],
  });

  app.enableShutdownHooks();

  const port = process.env.TENANT_SERVICE_PORT ?? process.env.PORT ?? 3001;
  await app.listen(port);
  Logger.log(
    `tenant-service listening on http://localhost:${port} (api prefix: /${globalPrefix})`,
  );
}

bootstrap();
