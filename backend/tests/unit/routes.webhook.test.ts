import { beforeEach, describe, expect, it, vi } from 'vitest';
import supertest from 'supertest';
import { Webhook } from 'svix';

// Batch 3.10. HTTP-level test of POST /webhooks/clerk through the real Express app, with a real
// Svix-signed request (no live Clerk endpoint) and clerkSyncService mocked (its own logic is
// covered by tests/unit/clerkSyncService.test.ts) - this file's job is proving the route itself:
// raw-body wiring, signature enforcement, and the response shape.

const WEBHOOK_SECRET = `whsec_${Buffer.from('a-fake-test-signing-secret-000!!').toString('base64')}`;

vi.mock('@clerk/express', () => ({
  clerkMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  getAuth: vi.fn(() => ({ isAuthenticated: false, userId: null })),
}));
vi.mock('../../src/config/env.js', () => ({
  env: {
    NODE_ENV: 'test',
    PORT: 5000,
    FRONTEND_URL: 'http://localhost:5173',
    BACKEND_URL: 'http://localhost:5000',
    DATABASE_URL: 'postgres://fake:fake@localhost:5432/fake',
    CLERK_SECRET_KEY: 'sk_test_fake',
    CLERK_WEBHOOK_SECRET: WEBHOOK_SECRET,
  },
}));
vi.mock('../../src/services/clerkSyncService.js', () => ({ handleClerkWebhookEvent: vi.fn() }));

const { handleClerkWebhookEvent } = await import('../../src/services/clerkSyncService.js');
const { createApp } = await import('../../src/app.js');

const app = createApp();

function signedRequest(body: unknown, id = 'msg_1') {
  const payload = JSON.stringify(body);
  const timestamp = new Date();
  const signature = new Webhook(WEBHOOK_SECRET).sign(id, timestamp, payload);
  return supertest(app)
    .post('/webhooks/clerk')
    .set('svix-id', id)
    .set('svix-timestamp', String(Math.floor(timestamp.getTime() / 1000)))
    .set('svix-signature', signature)
    .set('Content-Type', 'application/json')
    .send(payload);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /webhooks/clerk', () => {
  it('rejects a request with no Svix headers at all with 400, and never reaches the sync service', async () => {
    const res = await supertest(app).post('/webhooks/clerk').set('Content-Type', 'application/json').send(JSON.stringify({ type: 'user.created', data: {} }));
    expect(res.status).toBe(400);
    expect(handleClerkWebhookEvent).not.toHaveBeenCalled();
  });

  it('rejects an incorrectly signed request with 401 INVALID_SIGNATURE, and never reaches the sync service', async () => {
    const res = await supertest(app)
      .post('/webhooks/clerk')
      .set('svix-id', 'msg_bad')
      .set('svix-timestamp', String(Math.floor(Date.now() / 1000)))
      .set('svix-signature', 'v1,not-a-real-signature')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ type: 'user.created', data: {} }));
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_SIGNATURE');
    expect(handleClerkWebhookEvent).not.toHaveBeenCalled();
  });

  it('a correctly signed request is verified, parsed, and handed to the sync service with the svix-id', async () => {
    vi.mocked(handleClerkWebhookEvent).mockResolvedValue({ outcome: 'processed', type: 'user.created' });
    const res = await signedRequest({ type: 'user.created', data: { id: 'clerk_1' } }, 'msg_ok');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true, outcome: 'processed' });
    expect(handleClerkWebhookEvent).toHaveBeenCalledWith({ type: 'user.created', data: { id: 'clerk_1' } }, 'msg_ok');
  });

  it('a duplicate delivery still gets a 200 (so Svix does not retry it), reporting outcome: duplicate', async () => {
    vi.mocked(handleClerkWebhookEvent).mockResolvedValue({ outcome: 'duplicate' });
    const res = await signedRequest({ type: 'user.created', data: { id: 'clerk_1' } }, 'msg_dup');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true, outcome: 'duplicate' });
  });
});
