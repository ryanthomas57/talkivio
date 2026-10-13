import { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { loggableError } from './http';
import { productionRefusals } from '../config/env';

describe('loggableError', () => {
  it('never includes Prisma messages (they can quote argument values)', () => {
    const known = new Prisma.PrismaClientKnownRequestError('Invalid `prisma.message.create()` invocation: { body: "my card 4242" }', { code: 'P2003', clientVersion: 'x', meta: { modelName: 'Message' } });
    const text = loggableError(known);
    expect(text).toContain('P2003');
    expect(text).toContain('model=Message');
    expect(text).not.toContain('4242');
    const validation = new Prisma.PrismaClientValidationError('Argument `email`: Invalid value provided: "someone@example.com"', { clientVersion: 'x' });
    expect(loggableError(validation)).not.toContain('example.com');
  });

  it('keeps ordinary error stacks', () => {
    expect(loggableError(new Error('boom'))).toContain('boom');
  });
});

describe('productionRefusals', () => {
  it('refuses development-only providers in production', () => {
    expect(productionRefusals({ NODE_ENV: 'production', EMAIL_PROVIDER: 'console', SCAN_MODE: 'dev_unscanned' })).toHaveLength(2);
    expect(productionRefusals({ NODE_ENV: 'production', EMAIL_PROVIDER: 'smtp', SCAN_MODE: 'clamav' })).toEqual([]);
    expect(productionRefusals({ NODE_ENV: 'development', EMAIL_PROVIDER: 'console', SCAN_MODE: 'dev_unscanned' })).toEqual([]);
  });
});
