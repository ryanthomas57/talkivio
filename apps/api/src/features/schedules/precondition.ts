import { AppError, badRequest } from '../../common/http';

/** Parses an `If-Match` entity version: `3`, `"3"` or `W/"3"`. */
export function parseIfMatch(header: string | undefined | null): number | null {
  if (!header) return null;
  const m = /^\s*(?:W\/)?"?(\d{1,9})"?\s*$/.exec(header);
  if (!m) throw badRequest('If-Match must be the entity version, e.g. "3"', { if_match: ['Invalid entity version'] });
  return Number(m[1]);
}

/**
 * Entity-version precondition (ch. 40): PATCH and destructive configuration
 * commands use If-Match (or `expected_version`); a missing precondition is 428
 * when required, a stale one is 409 (checked by the caller against the row).
 */
export function precondition(ifMatch: string | undefined | null, expectedVersion: number | null | undefined, required: boolean): number | null {
  const header = parseIfMatch(ifMatch);
  if (header !== null && expectedVersion != null && header !== expectedVersion) {
    throw badRequest('If-Match and expected_version disagree', { expected_version: ['Does not match If-Match'] });
  }
  const v = expectedVersion ?? header;
  if (v == null && required) throw new AppError(428, 'PRECONDITION_REQUIRED', 'Send If-Match or expected_version with the version you loaded');
  return v ?? null;
}
