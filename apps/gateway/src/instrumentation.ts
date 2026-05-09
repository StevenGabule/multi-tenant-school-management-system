// OpenTelemetry bootstrap. MUST be imported as the very first line of main.ts
// — auto-instrumentations patch modules at require time, so any code that
// imports `http`, `pg`, `@nestjs/core`, etc. before this file runs is invisible
// to tracing forever.
//
// The webpack target is `node`, which externalizes node_modules. That means
// at runtime the auto-instrumentations actually see the real `pg`/`http`
// modules being required and can patch them. If we ever bundle node_modules
// into the output, this stops working — flag in code review.

import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';

// Quiet by default; set OTEL_LOG_LEVEL=debug locally to surface SDK internals.
const logLevel = process.env.OTEL_LOG_LEVEL?.toLowerCase();
diag.setLogger(
  new DiagConsoleLogger(),
  logLevel === 'debug'
    ? DiagLogLevel.DEBUG
    : logLevel === 'info'
      ? DiagLogLevel.INFO
      : DiagLogLevel.ERROR,
);

const otlpEndpoint =
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318';

const sdk = new NodeSDK({
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME ?? 'gateway',
    [ATTR_SERVICE_VERSION]: process.env.SERVICE_VERSION ?? '0.0.1',
    'deployment.environment': process.env.NODE_ENV ?? 'development',
  }),
  traceExporter: new OTLPTraceExporter({
    url: `${otlpEndpoint}/v1/traces`,
  }),
  instrumentations: [
    getNodeAutoInstrumentations({
      // fs spans are noisy in NestJS bootstrapping and rarely useful.
      '@opentelemetry/instrumentation-fs': { enabled: false },
    }),
  ],
});

sdk.start();

// Flush on graceful shutdown so the last few spans don't get lost.
const shutdown = async () => {
  try {
    await sdk.shutdown();
  } catch (err) {
    // Best effort — don't block shutdown for a failed flush.
    // eslint-disable-next-line no-console
    console.error('OpenTelemetry shutdown error', err);
  }
};

process.once('SIGTERM', () => {
  shutdown().finally(() => process.exit(0));
});
process.once('SIGINT', () => {
  shutdown().finally(() => process.exit(0));
});
