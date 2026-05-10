import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ZodValidationPipe } from 'nestjs-zod';
import { AppModule } from './app/app.module';
import { DomainExceptionFilter } from './common/domain-exception.filter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const globalPrefix = 'api';
  app.setGlobalPrefix(globalPrefix, {
    exclude: ['livez', 'readyz'],
  });
  // Validate every @Body / @Query / @Param against its Zod schema
  // (the schema attached via createZodDto). Throws ZodValidationException
  // → 400 with the full issue list.
  app.useGlobalPipes(new ZodValidationPipe());
  // Map DomainError subclasses to proper HTTP codes. Without this, an
  // InvariantViolation thrown from a value-object factory (e.g.,
  // DateOfBirth refusing a future date) propagates as a 500.
  app.useGlobalFilters(new DomainExceptionFilter());
  app.enableShutdownHooks();

  // OpenAPI at /api-docs. nestjs-zod + @nestjs/swagger pull schemas from
  // createZodDto wrappers automatically.
  const swaggerConfig = new DocumentBuilder()
    .setTitle('SMS — sis-service')
    .setDescription('Student Information System (Phase 1.3)')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  const doc = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api-docs', app, doc);

  const port = process.env.SIS_SERVICE_PORT ?? process.env.PORT ?? 3002;
  await app.listen(port);
  Logger.log(
    `sis-service listening on http://localhost:${port} ` +
      `(api: /${globalPrefix}, docs: /api-docs)`,
  );
}

bootstrap();
