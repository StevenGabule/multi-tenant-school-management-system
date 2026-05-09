import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app/app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const globalPrefix = 'api';

  // Probes live at the root, NOT under /api, so kubelet hits them directly
  // and so they don't change shape if the API prefix is later versioned.
  app.setGlobalPrefix(globalPrefix, {
    exclude: ['livez', 'readyz'],
  });

  app.enableShutdownHooks();

  const port = process.env.PORT || 3000;
  await app.listen(port);
  Logger.log(
    `Application listening on http://localhost:${port} (api prefix: /${globalPrefix})`,
  );
}

bootstrap();
