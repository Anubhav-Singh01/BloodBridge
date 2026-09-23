import { describe, expect, it } from 'vitest';
import {
  GuardError,
  parseTarget,
  resolveConfirmedTarget,
  resolveConfirmedTestTarget,
} from '../../src/db/guard.js';

// Fake hosts on the reserved .invalid domain: nothing here can resolve or connect.
const PASSWORD = 'secretpw';
const DEV_DIRECT = `postgresql://user:${PASSWORD}@ep-dev-123.example.invalid/devdb?sslmode=require`;
const DEV_POOLED = `postgresql://user:${PASSWORD}@ep-dev-123-pooler.example.invalid/devdb?sslmode=require`;
const TEST = `postgresql://user:${PASSWORD}@ep-test-456.example.invalid/testdb?sslmode=require`;

function messageOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof GuardError) return error.message;
    throw error;
  }
  throw new Error('expected a GuardError');
}

describe('parseTarget', () => {
  it('returns only the lower-case host and the database name', () => {
    expect(parseTarget('postgres://u:p@EP-Dev-123.Example.invalid:5432/devdb?sslmode=require')).toEqual({
      host: 'ep-dev-123.example.invalid',
      database: 'devdb',
    });
  });

  it('rejects anything that is not a postgres URL, never echoing the input', () => {
    for (const bad of ['', 'not a url', `mysql://u:${PASSWORD}@host.invalid/db`, `postgres://u:${PASSWORD}@host.invalid`]) {
      expect(messageOf(() => parseTarget(bad))).not.toContain(PASSWORD);
    }
  });
});

describe('resolveConfirmedTarget', () => {
  it('refuses in production even when confirmed', () => {
    const env = { NODE_ENV: 'production', DATABASE_URL_DIRECT: DEV_DIRECT, CONFIRM_DB_HOST: 'ep-dev-123.example.invalid' };
    expect(messageOf(() => resolveConfirmedTarget(env, 'migrate'))).toContain('NODE_ENV=production');
  });

  it('refuses when no URL is set', () => {
    expect(messageOf(() => resolveConfirmedTarget({}, 'migrate'))).toContain('DATABASE_URL_DIRECT');
  });

  it('refuses without a confirmation, and tells you which host to confirm (never the password)', () => {
    const message = messageOf(() => resolveConfirmedTarget({ DATABASE_URL_DIRECT: DEV_DIRECT }, 'migrate'));
    expect(message).toContain('CONFIRM_DB_HOST=ep-dev-123.example.invalid');
    expect(message).not.toContain(PASSWORD);
  });

  it('refuses a confirmation for a different host, without echoing what was typed', () => {
    const message = messageOf(() => resolveConfirmedTarget({ DATABASE_URL_DIRECT: DEV_DIRECT, CONFIRM_DB_HOST: 'other.example.invalid' }, 'seed'));
    expect(message).toContain('does not match');
    expect(message).not.toContain('other.example.invalid');
  });

  it('refuses a confirmation that looks like a pasted URL, without echoing it', () => {
    const message = messageOf(() => resolveConfirmedTarget({ DATABASE_URL_DIRECT: DEV_DIRECT, CONFIRM_DB_HOST: DEV_DIRECT }, 'seed'));
    expect(message).toContain('host only');
    expect(message).not.toContain(PASSWORD);
  });

  it('accepts a matching confirmation (case-insensitive) and prefers the direct URL', () => {
    const env = { DATABASE_URL: DEV_POOLED, DATABASE_URL_DIRECT: DEV_DIRECT, CONFIRM_DB_HOST: ' EP-DEV-123.example.invalid ' };
    expect(resolveConfirmedTarget(env, 'migrate')).toEqual({ host: 'ep-dev-123.example.invalid', database: 'devdb' });
  });

  it('falls back to DATABASE_URL when the direct URL is empty', () => {
    const env = { DATABASE_URL: DEV_POOLED, DATABASE_URL_DIRECT: '', CONFIRM_DB_HOST: 'ep-dev-123-pooler.example.invalid' };
    expect(resolveConfirmedTarget(env, 'probe').host).toBe('ep-dev-123-pooler.example.invalid');
  });
});

describe('resolveConfirmedTestTarget', () => {
  const ok = { DATABASE_URL_DIRECT: DEV_DIRECT, TEST_DATABASE_URL: TEST, CONFIRM_TEST_DB_HOST: 'ep-test-456.example.invalid' };

  it('accepts a confirmed test database that is not the dev database', () => {
    expect(resolveConfirmedTestTarget(ok)).toEqual({ host: 'ep-test-456.example.invalid', database: 'testdb' });
  });

  it('refuses the same database as dev, including the pooled twin of the dev host', () => {
    for (const same of [DEV_DIRECT, DEV_POOLED]) {
      const message = messageOf(() => resolveConfirmedTestTarget({ ...ok, TEST_DATABASE_URL: same, CONFIRM_TEST_DB_HOST: 'ep-dev-123.example.invalid' }));
      expect(message).toContain('same database');
      expect(message).not.toContain(PASSWORD);
    }
  });

  it('refuses in production, without a URL, and without a matching confirmation', () => {
    expect(messageOf(() => resolveConfirmedTestTarget({ ...ok, NODE_ENV: 'production' }))).toContain('NODE_ENV=production');
    expect(messageOf(() => resolveConfirmedTestTarget({}))).toContain('TEST_DATABASE_URL');
    expect(messageOf(() => resolveConfirmedTestTarget({ ...ok, CONFIRM_TEST_DB_HOST: undefined }))).toContain('CONFIRM_TEST_DB_HOST=');
    expect(messageOf(() => resolveConfirmedTestTarget({ ...ok, CONFIRM_TEST_DB_HOST: 'wrong.example.invalid' }))).toContain('does not match');
  });
});
