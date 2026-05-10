import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import {
  DomainError,
  InvariantViolation,
  StudentNotFound,
} from '../modules/students/domain/errors';

/**
 * Maps domain-layer errors to HTTP responses. The domain stays
 * framework-agnostic; this filter is the seam where its language
 * ("invariant violation", "not found") meets HTTP status codes.
 *
 *   InvariantViolation → 400 Bad Request
 *   StudentNotFound    → 404 Not Found
 *   any other DomainError → 422 Unprocessable Entity (sane catch-all
 *     for "the request was well-formed but the domain refused")
 */
@Catch(DomainError)
export class DomainExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(DomainExceptionFilter.name);

  catch(error: DomainError, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse();
    const req = host.switchToHttp().getRequest<{ url?: string }>();

    let status = HttpStatus.UNPROCESSABLE_ENTITY;
    if (error instanceof InvariantViolation) status = HttpStatus.BAD_REQUEST;
    else if (error instanceof StudentNotFound) status = HttpStatus.NOT_FOUND;

    this.logger.debug(
      `${error.constructor.name} on ${req?.url ?? '?'}: ${error.message}`,
    );
    res.status(status).json({
      statusCode: status,
      error: error.constructor.name,
      message: error.message,
    });
  }
}
