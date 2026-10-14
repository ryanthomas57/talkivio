/**
 * HTTP plumbing: auth context, decorators, wire-format validation pipe, envelope
 * interceptor, error helpers (ch. 76 error code inventory) and the global filter.
 */
import {
  ArgumentsHost,
  CallHandler,
  Catch,
  createParamDecorator,
  ExceptionFilter,
  ExecutionContext,
  HttpException,
  Injectable,
  Logger,
  NestInterceptor,
  PipeTransform,
  SetMetadata,
} from '@nestjs/common';
import { Prisma, type Role } from '@prisma/client';
import type { NextFunction, Request, Response } from 'express';
import { map, type Observable } from 'rxjs';
import { ZodError, type ZodTypeAny, type z } from 'zod';
import { randomBytes } from 'node:crypto';
import type { Permission } from './permissions';
import { fromWire, isPage, snake, toWire } from './wire';

// ───────── Auth context ─────────
export interface AuthContext {
  tenantId: string;
  userId: string | null;
  membershipId: string | null;
  role: Role;
  permissions: ReadonlySet<Permission>;
  /** 'all' for tenant-wide roles, otherwise department ids the actor serves/monitors. */
  departmentScope: 'all' | string[];
  servedDepartmentIds: string[];
  sessionId: string | null;
  tokenId: string | null;
  actorName: string;
  requestId: string;
  ipHash: string | null;
  userAgent: string | null;
}

export interface UserContext {
  userId: string;
  sessionId: string;
  requestId: string;
  ipHash: string | null;
  userAgent: string | null;
  recentAuthAt: Date;
  emailVerified: boolean;
}

/** Visitor capability (public widget API). */
export interface VisitorContext {
  tenantId: string;
  siteId: string;
  visitorId: string;
  sessionId: string;
  requestId: string;
  /** Keyed hash of the exact address: exact-IP bans match it. */
  ipHash: string | null;
  /** Keyed hash of the address's network (IPv4 address or IPv6 /64): per-network rate limits and IPv6 /64 bans. */
  ipNetHash: string | null;
  origin: string | null;
  /** ISO time the visitor capability expires (set by VisitorGuard; reported as socket capability_expiry). */
  capabilityExpiresAt?: string;
}

export type AppRequest = Request & {
  auth?: AuthContext;
  user?: UserContext;
  visitor?: VisitorContext;
  requestId?: string;
  rawBody?: Buffer;
};

export function can(auth: Pick<AuthContext, 'permissions'>, p: Permission): boolean {
  return auth.permissions.has(p);
}

// ───────── Decorators ─────────
export const IS_PUBLIC = 'rd:public';
export const USER_SCOPED = 'rd:user-scoped';
export const REQUIRE = 'rd:require';
export const ALLOW_PENDING_MFA = 'rd:allow-pending-mfa';
export const TOKEN_ALLOWED = 'rd:token-allowed';
export const RECENT_AUTH = 'rd:recent-auth';
/** Routes that keep working while a workspace's billing blocks it (paying, the account summary, sign-out). */
export const BILLING_EXEMPT = 'rd:billing-exempt';

export const Public = () => SetMetadata(IS_PUBLIC, true);
export const UserScoped = () => SetMetadata(USER_SCOPED, true);
export const Require = (...permissions: Permission[]) => SetMetadata(REQUIRE, permissions);
export const AllowPendingMfa = () => SetMetadata(ALLOW_PENDING_MFA, true);
/** Endpoint may be called with a tenant integration token. */
export const TokenAccess = () => SetMetadata(TOKEN_ALLOWED, true);
/** Requires authentication within the last 15 minutes (credential/ownership changes). */
export const RecentAuth = () => SetMetadata(RECENT_AUTH, true);
export const BillingExempt = () => SetMetadata(BILLING_EXEMPT, true);

const fromReq = <K extends keyof AppRequest>(key: K) =>
  createParamDecorator((_d: unknown, ctx: ExecutionContext) => {
    const req = ctx.switchToHttp().getRequest<AppRequest>();
    const v = req[key];
    if (!v) throw new AppError(401, 'AUTH_REQUIRED', 'Sign in to continue');
    return v;
  })();

export const Auth = () => fromReq('auth');
export const CurrentUser = () => fromReq('user');
export const Visitor = () => fromReq('visitor');

export const RequestId = createParamDecorator(
  (_d: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest<AppRequest>().requestId ?? '',
);

// ───────── Errors ─────────
export type ErrorCode =
  | 'AUTH_REQUIRED'
  | 'MFA_REQUIRED'
  | 'RECENT_AUTH_REQUIRED'
  | 'TOKEN_EXPIRED'
  | 'TOKEN_USED'
  | 'VALIDATION_FAILED'
  | 'ORIGIN_NOT_ALLOWED'
  | 'CONSENT_REQUIRED'
  | 'PERMISSION_DENIED'
  | 'NOT_FOUND'
  | 'VERSION_CONFLICT'
  | 'PRECONDITION_REQUIRED'
  | 'IDEMPOTENCY_MISMATCH'
  | 'IDEMPOTENCY_IN_PROGRESS'
  | 'CHAT_CLOSED'
  | 'CHAT_ALREADY_ASSIGNED'
  | 'CAPACITY_EXCEEDED'
  | 'OFFER_EXPIRED'
  | 'OFFER_WITHDRAWN'
  | 'DEPARTMENT_UNAVAILABLE'
  | 'QUEUE_FULL'
  | 'VISITOR_OFFLINE'
  | 'CHAT_EXISTS'
  | 'FILE_TOO_LARGE'
  | 'FILE_TYPE_BLOCKED'
  | 'FILE_SCAN_PENDING'
  | 'FILE_REJECTED'
  | 'EXPORT_EXPIRED'
  | 'RATE_LIMITED'
  | 'CURSOR_EXPIRED'
  | 'SERVICE_UNAVAILABLE'
  | 'INTEGRATION_UNAVAILABLE'
  | 'CONFLICT'
  | 'EMAIL_NOT_VERIFIED'
  | 'INVALID_CREDENTIALS'
  | 'PLAN_LIMIT'
  | 'PAYMENT_REQUIRED'
  | 'INTERNAL';

export class AppError extends HttpException {
  constructor(
    status: number,
    readonly code: ErrorCode,
    message: string,
    readonly extra: {
      retryable?: boolean;
      fieldErrors?: Record<string, string[]>;
      details?: unknown;
      retryAfter?: number;
    } = {},
  ) {
    super({ code, message }, status);
  }
}

export const notFound = (what = 'Resource') => new AppError(404, 'NOT_FOUND', `${what} not found`);
export const denied = (message = 'You do not have permission to do that') =>
  new AppError(403, 'PERMISSION_DENIED', message);
export const badRequest = (message: string, fieldErrors?: Record<string, string[]>) =>
  new AppError(422, 'VALIDATION_FAILED', message, { fieldErrors });
export const conflict = (code: ErrorCode, message: string, retryable = false, details?: unknown) =>
  new AppError(409, code, message, { retryable, details });
export const unauthorized = (message = 'Sign in to continue', code: ErrorCode = 'AUTH_REQUIRED') =>
  new AppError(401, code, message);
export const rateLimited = (retryAfter: number) =>
  new AppError(429, 'RATE_LIMITED', 'Too many requests. Please wait and try again.', {
    retryable: true,
    retryAfter,
  });

// ───────── Validation (wire → internal) ─────────
@Injectable()
export class WirePipe<T extends ZodTypeAny> implements PipeTransform {
  constructor(private readonly schema: T) {}
  transform(value: unknown): z.infer<T> {
    const result = this.schema.safeParse(fromWire(value ?? {}));
    if (!result.success) throw zodError(result.error);
    return result.data;
  }
}
export const body = <T extends ZodTypeAny>(schema: T) => new WirePipe(schema);

export function zodError(err: ZodError): AppError {
  const fieldErrors: Record<string, string[]> = {};
  for (const i of err.issues) {
    const path = i.path.map((p) => (typeof p === 'string' ? snake(p) : String(p))).join('.') || '_';
    (fieldErrors[path] ??= []).push(i.message);
  }
  return new AppError(422, 'VALIDATION_FAILED', 'Check the highlighted fields.', { fieldErrors });
}

// ───────── Input hygiene ─────────
/** True when any string in a parsed JSON value contains a NUL character (PostgreSQL text cannot store it). */
export function containsNul(value: unknown, depth = 0): boolean {
  if (typeof value === 'string') return value.includes('\u0000');
  if (depth > 32 || !value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((v) => containsNul(v, depth + 1));
  return Object.entries(value as Record<string, unknown>).some(
    ([k, v]) => k.includes('\u0000') || containsNul(v, depth + 1),
  );
}

/** Rejects NUL in the URL, query or JSON body with a field-level 422 instead of a database error. */
export function nulGuardMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (/%00/.test(req.originalUrl ?? req.url ?? '') || containsNul(req.body)) {
    const e = errorBody(
      new AppError(422, 'VALIDATION_FAILED', 'Text cannot contain control character NUL (U+0000).', {
        fieldErrors: { _: ['Remove the NUL character'] },
      }),
    );
    res.status(e.status).json(e.body);
    return;
  }
  next();
}

// ───────── Request id ─────────
export function requestIdMiddleware(req: AppRequest, res: Response, next: NextFunction): void {
  const incoming = req.header('x-request-id');
  req.requestId =
    incoming && /^[\w.-]{6,64}$/.test(incoming) ? incoming : `req-${randomBytes(6).toString('hex')}`;
  res.setHeader('X-Request-Id', req.requestId);
  next();
}

// ───────── Response envelope ─────────
@Injectable()
export class EnvelopeInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (ctx.getType() !== 'http') return next.handle();
    const req = ctx.switchToHttp().getRequest<AppRequest>();
    const res = ctx.switchToHttp().getResponse<Response>();
    return next.handle().pipe(
      map((value) => {
        if (res.statusCode === 204 || value === undefined) return undefined;
        const meta = { request_id: req.requestId };
        if (isPage(value)) {
          return {
            data: toWire(value.items),
            page: {
              next_cursor: value.nextCursor,
              has_more: value.hasMore,
              ...(value.total !== undefined ? { total: value.total } : {}),
            },
            meta,
          };
        }
        return { data: toWire(value), meta };
      }),
    );
  }
}

// ───────── Errors → wire ─────────
type ErrorReporter = (err: unknown) => void;
let reporter: ErrorReporter | null = null;
export function setErrorReporter(fn: ErrorReporter): void {
  reporter = fn;
}
export function reportError(err: unknown): void {
  try {
    reporter?.(err);
  } catch {
    /* never throw from error reporting */
  }
}

/**
 * Error text for logs: the stack is kept, but Prisma messages are reduced to class/code/model,
 * because they can quote query arguments (message bodies, emails, tokens).
 */
export function loggableError(err: unknown): string {
  const frames = (e: Error) =>
    (e.stack ?? '')
      .split('\n')
      .filter((l) => l.trimStart().startsWith('at '))
      .slice(0, 20)
      .join('\n');
  if (err instanceof Prisma.PrismaClientKnownRequestError)
    return `PrismaClientKnownRequestError ${err.code} model=${String(err.meta?.modelName ?? '?')} (message redacted)\n${frames(err)}`;
  if (
    err instanceof Prisma.PrismaClientValidationError ||
    err instanceof Prisma.PrismaClientUnknownRequestError ||
    err instanceof Prisma.PrismaClientRustPanicError ||
    err instanceof Prisma.PrismaClientInitializationError
  )
    return `${err.name} (message redacted)\n${frames(err)}`;
  if (err instanceof Error) return err.stack ?? `${err.name}: ${err.message}`;
  return `non-Error thrown: ${typeof err}`;
}

// Prisma codes for a lost or unreachable database (P1001 can't reach, P1002 timeout, P1008 operation timeout,
// P1017 server closed the connection, P2024 pool timeout) and PostgreSQL SQLSTATEs for shutdown, connection failure
// and connection limits, as they appear in driver messages.
const DB_UNAVAILABLE_CODES = new Set(['P1001', 'P1002', 'P1008', 'P1017', 'P2024']);
const DB_UNAVAILABLE_TEXT =
  /\b(?:57P01|57P02|57P03|53300|08000|08001|08003|08006)\b|not currently accepting connections|can't reach database server|server has closed the connection|connection terminated|ECONNREFUSED|ECONNRESET/i;

/** True when the error means the database is unreachable (an outage), not that the request was wrong. */
export function isDatabaseUnavailable(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientInitializationError) return true;
  if (err instanceof Prisma.PrismaClientKnownRequestError && DB_UNAVAILABLE_CODES.has(err.code)) return true;
  if (
    err instanceof Prisma.PrismaClientKnownRequestError ||
    err instanceof Prisma.PrismaClientUnknownRequestError
  )
    return DB_UNAVAILABLE_TEXT.test(err.message);
  return false;
}

/** Seconds a client should wait before retrying after a dependency outage. */
const DEPENDENCY_RETRY_AFTER_S = 5;

export function errorBody(
  err: unknown,
  requestId?: string,
): { status: number; body: Record<string, unknown>; retryAfter?: number } {
  const meta = { request_id: requestId };
  if (err instanceof AppError) {
    return {
      status: err.getStatus(),
      retryAfter: err.extra.retryAfter,
      body: {
        error: {
          code: err.code,
          message: err.message,
          retryable: err.extra.retryable ?? false,
          ...(err.extra.fieldErrors ? { field_errors: err.extra.fieldErrors } : {}),
          ...(err.extra.details ? { details: toWire(err.extra.details) } : {}),
        },
        meta,
      },
    };
  }
  if (err instanceof ZodError) return errorBody(zodError(err), requestId);
  // Dependency outages are reported as such (503, retryable), never as a generic server fault.
  if (isDatabaseUnavailable(err)) {
    return errorBody(
      new AppError(
        503,
        'SERVICE_UNAVAILABLE',
        'The service is temporarily unavailable. Please retry shortly.',
        { retryable: true, retryAfter: DEPENDENCY_RETRY_AFTER_S },
      ),
      requestId,
    );
  }
  if ((err as Error | null)?.name === 'StorageUnavailableError') {
    return errorBody(
      new AppError(
        503,
        'SERVICE_UNAVAILABLE',
        'File storage is temporarily unavailable. Please retry shortly.',
        { retryable: true, retryAfter: DEPENDENCY_RETRY_AFTER_S },
      ),
      requestId,
    );
  }
  // express.json / body-parser failures (raised before any controller runs).
  const bodyError = (err as { type?: unknown } | null)?.type;
  if (bodyError === 'entity.too.large')
    return {
      status: 413,
      body: {
        error: { code: 'VALIDATION_FAILED', message: 'Request body is too large.', retryable: false },
        meta,
      },
    };
  if (bodyError === 'entity.parse.failed')
    return {
      status: 400,
      body: {
        error: { code: 'VALIDATION_FAILED', message: 'Request body is not valid JSON.', retryable: false },
        meta,
      },
    };
  if (bodyError === 'charset.unsupported' || bodyError === 'encoding.unsupported')
    return {
      status: 415,
      body: {
        error: { code: 'VALIDATION_FAILED', message: 'Unsupported request encoding.', retryable: false },
        meta,
      },
    };
  // PostgreSQL rejects NUL / invalid UTF-8 in text (SQLSTATE 22021): bad input, not a server fault.
  if (
    (err instanceof Prisma.PrismaClientKnownRequestError ||
      err instanceof Prisma.PrismaClientUnknownRequestError) &&
    /22021|invalid byte sequence/i.test(err.message)
  ) {
    return errorBody(
      new AppError(422, 'VALIDATION_FAILED', 'Text contains characters that cannot be stored.'),
      requestId,
    );
  }
  // A value outside the database bounds — CHECK constraint (23514 / P2004) or over-long value (22001 / P2000) — is
  // input the API should have refused: a client error, never a retryable server fault.
  if (
    (err instanceof Prisma.PrismaClientKnownRequestError && (err.code === 'P2004' || err.code === 'P2000')) ||
    ((err instanceof Prisma.PrismaClientKnownRequestError ||
      err instanceof Prisma.PrismaClientUnknownRequestError) &&
      /\b(23514|22001)\b|violates check constraint|value too long/i.test(err.message))
  ) {
    return errorBody(
      new AppError(422, 'VALIDATION_FAILED', 'A value is outside the allowed length or set of values.'),
      requestId,
    );
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2025') return errorBody(notFound(), requestId);
    if (err.code === 'P2002')
      return errorBody(conflict('CONFLICT', 'A record with these details already exists'), requestId);
    if (err.code === 'P2034')
      return errorBody(conflict('VERSION_CONFLICT', 'Please retry the request', true), requestId);
  }
  if (err instanceof HttpException) {
    const status = err.getStatus();
    const code: ErrorCode =
      status === 404
        ? 'NOT_FOUND'
        : status === 413
          ? 'VALIDATION_FAILED'
          : status === 429
            ? 'RATE_LIMITED'
            : status >= 500
              ? 'INTERNAL'
              : 'VALIDATION_FAILED';
    const r = err.getResponse();
    const message =
      typeof r === 'string' ? r : ((r as { message?: string | string[] }).message ?? err.message);
    return {
      status,
      body: {
        error: { code, message: Array.isArray(message) ? message[0] : message, retryable: status >= 500 },
        meta,
      },
    };
  }
  return {
    status: 500,
    body: {
      error: { code: 'INTERNAL', message: 'Something went wrong. Please try again.', retryable: true },
      meta,
    },
  };
}

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('HTTP');

  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== 'http') return;
    const res = host.switchToHttp().getResponse<Response>();
    const req = host.switchToHttp().getRequest<AppRequest>();
    if (res.headersSent) return;
    const { status, body: payload, retryAfter } = errorBody(exception, req.requestId);
    if (status >= 500) {
      this.logger.error(`${req.method} ${req.path} failed [${req.requestId}]`, loggableError(exception));
      reportError(exception);
    }
    if (retryAfter) res.setHeader('Retry-After', String(retryAfter));
    res.status(status).json(payload);
  }
}
