import { beforeEach, describe, expect, it, vi } from 'vitest';

// Batch 3.10. The webhook idempotency gate and event dispatch, tested against mocked repositories -
// no database. Proves: a genuinely new delivery is processed and marked processed; a delivery whose
// earlier attempt failed before being marked processed is retried using the SAME row rather than
// being silently dropped as "already handled"; and a true duplicate (already processed) is skipped.

vi.mock('../../src/repositories/webhookEvents.repository.js', () => ({
  recordIfNew: vi.fn(),
  findUnprocessed: vi.fn(),
  markProcessed: vi.fn(),
  markFailed: vi.fn(),
}));
vi.mock('../../src/repositories/users.repository.js', () => ({
  findByClerkUserId: vi.fn(),
  upsertFromClerk: vi.fn(),
}));
vi.mock('../../src/services/usersService.js', () => ({ requestDeletion: vi.fn() }));

const webhookEventsRepository = await import('../../src/repositories/webhookEvents.repository.js');
const usersRepository = await import('../../src/repositories/users.repository.js');
const usersService = await import('../../src/services/usersService.js');
const { handleClerkWebhookEvent } = await import('../../src/services/clerkSyncService.js');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('handleClerkWebhookEvent', () => {
  it('a new delivery is inserted first, processed, and marked processed', async () => {
    vi.mocked(webhookEventsRepository.recordIfNew).mockResolvedValue({ id: 'evt-1' });
    vi.mocked(usersRepository.upsertFromClerk).mockResolvedValue({ id: 'user-1' });

    const result = await handleClerkWebhookEvent({ type: 'user.created', data: { id: 'clerk_1', first_name: 'Anu' } }, 'msg_1');

    expect(result).toEqual({ outcome: 'processed', type: 'user.created' });
    expect(webhookEventsRepository.recordIfNew).toHaveBeenCalledWith('clerk', 'msg_1', 'user.created');
    expect(usersRepository.upsertFromClerk).toHaveBeenCalled();
    expect(webhookEventsRepository.markProcessed).toHaveBeenCalledWith('evt-1');
  });

  it('a genuine duplicate (already processed) is skipped: no reprocessing, no markProcessed call', async () => {
    vi.mocked(webhookEventsRepository.recordIfNew).mockResolvedValue(null);
    vi.mocked(webhookEventsRepository.findUnprocessed).mockResolvedValue(null); // already processed, so not "unprocessed"

    const result = await handleClerkWebhookEvent({ type: 'user.created', data: { id: 'clerk_1' } }, 'msg_2');

    expect(result).toEqual({ outcome: 'duplicate' });
    expect(usersRepository.upsertFromClerk).not.toHaveBeenCalled();
  });

  it('a delivery recorded but not yet processed (an earlier attempt failed) is retried using the same row, not dropped', async () => {
    vi.mocked(webhookEventsRepository.recordIfNew).mockResolvedValue(null); // conflict: row already exists
    vi.mocked(webhookEventsRepository.findUnprocessed).mockResolvedValue({ id: 'evt-3' }); // ...but not processed yet
    vi.mocked(usersRepository.upsertFromClerk).mockResolvedValue({ id: 'user-1' });

    const result = await handleClerkWebhookEvent({ type: 'user.created', data: { id: 'clerk_1' } }, 'msg_3');

    expect(result).toEqual({ outcome: 'processed', type: 'user.created' });
    expect(webhookEventsRepository.markProcessed).toHaveBeenCalledWith('evt-3');
  });

  it('marks the row failed and re-throws when processing itself throws, without acknowledging success', async () => {
    vi.mocked(webhookEventsRepository.recordIfNew).mockResolvedValue({ id: 'evt-4' });
    vi.mocked(usersRepository.upsertFromClerk).mockRejectedValue(new Error('db down'));

    await expect(handleClerkWebhookEvent({ type: 'user.created', data: { id: 'clerk_1' } }, 'msg_4')).rejects.toThrow('db down');
    expect(webhookEventsRepository.markFailed).toHaveBeenCalledWith('evt-4', 'db down');
    expect(webhookEventsRepository.markProcessed).not.toHaveBeenCalled();
  });

  it('user.deleted looks up the user by clerkUserId and calls requestDeletion with source CLERK_WEBHOOK', async () => {
    vi.mocked(webhookEventsRepository.recordIfNew).mockResolvedValue({ id: 'evt-5' });
    vi.mocked(usersRepository.findByClerkUserId).mockResolvedValue({ id: 'user-1', clerkUserId: 'clerk_1', status: 'ACTIVE' });

    const result = await handleClerkWebhookEvent({ type: 'user.deleted', data: { id: 'clerk_1' } }, 'msg_5');

    expect(result).toEqual({ outcome: 'processed', type: 'user.deleted' });
    expect(usersService.requestDeletion).toHaveBeenCalledWith('user-1', 'CLERK_WEBHOOK');
  });

  it('user.deleted for a Clerk user we have no record of at all is a harmless no-op', async () => {
    vi.mocked(webhookEventsRepository.recordIfNew).mockResolvedValue({ id: 'evt-6' });
    vi.mocked(usersRepository.findByClerkUserId).mockResolvedValue(undefined);

    const result = await handleClerkWebhookEvent({ type: 'user.deleted', data: { id: 'clerk_unknown' } }, 'msg_6');

    expect(result).toEqual({ outcome: 'processed', type: 'user.deleted' });
    expect(usersService.requestDeletion).not.toHaveBeenCalled();
  });

  it('an event type this app does not handle is recorded and marked processed as "ignored", never retried forever', async () => {
    vi.mocked(webhookEventsRepository.recordIfNew).mockResolvedValue({ id: 'evt-7' });
    const result = await handleClerkWebhookEvent({ type: 'organization.created', data: {} }, 'msg_7');
    expect(result).toEqual({ outcome: 'ignored', type: 'organization.created' });
    expect(webhookEventsRepository.markProcessed).toHaveBeenCalledWith('evt-7');
  });
});
