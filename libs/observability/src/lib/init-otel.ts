/**
 * Single source of truth for OpenTelemetry SDK initialization across
 * services. Call `initOtel({ serviceName: 'sis-service' })` as the very
 * first import in main.ts — auto-instrumentation patches happen at
 * require time, so anything imported BEFORE this call is invisible to
 * tracing forever.
 *
 * Three signals exported:
 *   - traces  → OTLP HTTP /v1/traces
 *   - metrics → OTLP HTTP /v1/metrics (periodic, 30s)
 *   - logs    → OTLP HTTP /v1/logs (BatchLogRecordProcessor)
 *
 * The collector receives all three at the same OTLP endpoint and fans
 * out to Tempo, Prometheus, and Loki respectively.
 *
 * Why a function (not module side-effect): tests don't need OTel; some
 * services may need different config; one-shot init at main.ts top is
 * the pragma the docs recommend.
 */
import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';
import { logs } from '@opentelemetry/api-logs';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import {
  BatchLogRecordProcessor,
  LoggerProvider,
} from '@opentelemetry/sdk-logs';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';

export interface InitOtelOptions {
  /** Service name reported as resource attribute. Required. */
  serviceName: string;
  /** Service version (defaults to env SERVICE_VERSION or '0.0.1'). */
  serviceVersion?: string;
  /** OTLP collector endpoint base URL (defaults to OTEL_EXPORTER_OTLP_ENDPOINT
   *  or http://localhost:4318). The signal-specific path is appended. */
  otlpEndpoint?: string;
  /** Metric export interval (ms). Default 30_000. */
  metricExportIntervalMs?: number;
}

let sdkRef: NodeSDK | null = null;
let loggerProviderRef: LoggerProvider | null = null;

export function initOtel(options: InitOtelOptions): void {
  if (sdkRef) {
    // Idempotent — calling twice is a misuse but shouldn't throw.
    return;
  }

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
    options.otlpEndpoint ??
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT ??
    'http://localhost:4318';

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: options.serviceName,
    [ATTR_SERVICE_VERSION]:
      options.serviceVersion ?? process.env.SERVICE_VERSION ?? '0.0.1',
    'deployment.environment': process.env.NODE_ENV ?? 'development',
  });

  // Logs: separate provider; NodeSDK doesn't manage logs natively yet.
  const loggerProvider = new LoggerProvider({
    resource,
    processors: [
      new BatchLogRecordProcessor(
        new OTLPLogExporter({ url: `${otlpEndpoint}/v1/logs` }),
      ),
    ],
  });
  logs.setGlobalLoggerProvider(loggerProvider);
  loggerProviderRef = loggerProvider;

  const sdk = new NodeSDK({
    resource,
    traceExporter: new OTLPTraceExporter({
      url: `${otlpEndpoint}/v1/traces`,
    }),
    metricReader: new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({
        url: `${otlpEndpoint}/v1/metrics`,
      }),
      exportIntervalMillis: options.metricExportIntervalMs ?? 30_000,
    }),
    instrumentations: [
      getNodeAutoInstrumentations({
        // fs spans are noisy in NestJS bootstrapping and rarely useful.
        '@opentelemetry/instrumentation-fs': { enabled: false },
      }),
    ],
  });

  sdk.start();
  sdkRef = sdk;

  // Flush on graceful shutdown so the last few spans/metrics/logs aren't
  // lost. Best-effort — don't block shutdown for a failed flush.
  const shutdown = async () => {
    try {
      if (sdkRef) await sdkRef.shutdown();
      if (loggerProviderRef) await loggerProviderRef.shutdown();
    } catch (err) {
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
}
