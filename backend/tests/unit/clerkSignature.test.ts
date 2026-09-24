import { Webhook } from 'svix';
import { describe, expect, it } from 'vitest';
import { AppError } from '../../src/utils/appError.js';
import { verifyClerkWebhookSignature } from '../../src/webhooks/clerkSignature.js';

// Batch 3.10. Uses svix's own Webhook.sign() to produce a real, valid signature offline (no network,
// no live Clerk endpoint) so these tests exercise the actual verification algorithm, not a stub of it.

const SECRET = `whsec_${Buffer.from('a-fake-test-signing-secret-000!!').toString('base64')}`;

function sign(id: string, timestamp: Date, payload: string, secret = SECRET): string {
  return new Webhook(secret).sign(id, timestamp, payload);
}

function headersFor(id: string, timestamp: Date, signature: string) {
  return { 'svix-id': id, 'svix-timestamp': String(Math.floor(timestamp.getTime() / 1000)), 'svix-signature': signature };
}

describe('verifyClerkWebhookSignature', () => {
  it('accepts a correctly signed payload', () => {
    const payload = JSON.stringify({ type: 'user.created', data: { id: 'user_1' } });
    const id = 'msg_1';
    const timestamp = new Date();
    const signature = sign(id, timestamp, payload);
    expect(() => verifyClerkWebhookSignature(payload, headersFor(id, timestamp, signature), SECRET)).not.toThrow();
  });

  it('rejects a payload that was tampered with after signing', () => {
    const payload = JSON.stringify({ type: 'user.created', data: { id: 'user_1' } });
    const id = 'msg_2';
    const timestamp = new Date();
    const signature = sign(id, timestamp, payload);
    const tampered = JSON.stringify({ type: 'user.created', data: { id: 'user_2' } });

    let caught: unknown;
    try {
      verifyClerkWebhookSignature(tampered, headersFor(id, timestamp, signature), SECRET);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).status).toBe(401);
    expect((caught as AppError).code).toBe('INVALID_SIGNATURE');
  });

  it('rejects a signature produced with a different secret', () => {
    const payload = JSON.stringify({ type: 'user.created', data: { id: 'user_1' } });
    const id = 'msg_3';
    const timestamp = new Date();
    const otherSecret = `whsec_${Buffer.from('a-completely-different-secret!!').toString('base64')}`;
    const signature = sign(id, timestamp, payload, otherSecret);
    expect(() => verifyClerkWebhookSignature(payload, headersFor(id, timestamp, signature), SECRET)).toThrow(AppError);
  });

  it('rejects when the svix-id header does not match the one that was signed', () => {
    const payload = JSON.stringify({ type: 'user.created', data: { id: 'user_1' } });
    const timestamp = new Date();
    const signature = sign('msg_4', timestamp, payload);
    expect(() => verifyClerkWebhookSignature(payload, headersFor('msg_4_wrong', timestamp, signature), SECRET)).toThrow(AppError);
  });

  it('rejects a request missing a required Svix header entirely', () => {
    const payload = JSON.stringify({ type: 'user.created', data: { id: 'user_1' } });
    const id = 'msg_5';
    const timestamp = new Date();
    const signature = sign(id, timestamp, payload);
    const headers = headersFor(id, timestamp, signature) as Record<string, string>;
    delete headers['svix-signature'];
    // @ts-expect-error - deliberately incomplete headers to prove verification fails closed.
    expect(() => verifyClerkWebhookSignature(payload, headers, SECRET)).toThrow();
  });
});
