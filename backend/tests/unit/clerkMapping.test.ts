import { describe, expect, it } from 'vitest';
import { mapClerkUserToProfile, type ClerkUserData } from '../../src/webhooks/clerkMapping.js';

// Batch 3.10. Documents the exact Clerk -> user_profiles mapping this app implements, and proves it
// never invents a field Clerk did not actually send (date_of_birth, address are never touched here).

describe('mapClerkUserToProfile', () => {
  it('maps first_name + last_name to fullName', () => {
    const data: ClerkUserData = { id: 'user_1', first_name: 'Anu', last_name: 'Bhav' };
    expect(mapClerkUserToProfile(data).fullName).toBe('Anu Bhav');
  });

  it('falls back to just first_name, or just last_name, or null when neither is present', () => {
    expect(mapClerkUserToProfile({ id: 'u', first_name: 'Anu', last_name: null }).fullName).toBe('Anu');
    expect(mapClerkUserToProfile({ id: 'u', first_name: null, last_name: 'Bhav' }).fullName).toBe('Bhav');
    expect(mapClerkUserToProfile({ id: 'u', first_name: null, last_name: null }).fullName).toBeNull();
    expect(mapClerkUserToProfile({ id: 'u', first_name: '  ', last_name: '' }).fullName).toBeNull();
  });

  it('maps the email_addresses entry matching primary_email_address_id, never any other entry', () => {
    const data: ClerkUserData = {
      id: 'user_1',
      primary_email_address_id: 'email_2',
      email_addresses: [
        { id: 'email_1', email_address: 'old@example.com' },
        { id: 'email_2', email_address: 'primary@example.com' },
      ],
    };
    expect(mapClerkUserToProfile(data).email).toBe('primary@example.com');
  });

  it('returns null email when there is no primary_email_address_id match', () => {
    const data: ClerkUserData = { id: 'user_1', primary_email_address_id: 'missing', email_addresses: [{ id: 'email_1', email_address: 'a@example.com' }] };
    expect(mapClerkUserToProfile(data).email).toBeNull();
  });

  it('maps the primary phone number and reports phoneVerified only when Clerk marks it verified', () => {
    const verified: ClerkUserData = {
      id: 'user_1',
      primary_phone_number_id: 'phone_1',
      phone_numbers: [{ id: 'phone_1', phone_number: '+911234567890', verification: { status: 'verified' } }],
    };
    expect(mapClerkUserToProfile(verified)).toMatchObject({ phone: '+911234567890', phoneVerified: true });

    const unverified: ClerkUserData = {
      id: 'user_1',
      primary_phone_number_id: 'phone_1',
      phone_numbers: [{ id: 'phone_1', phone_number: '+911234567890', verification: { status: 'unverified' } }],
    };
    expect(mapClerkUserToProfile(unverified)).toMatchObject({ phone: '+911234567890', phoneVerified: false });
  });

  it('reports phoneVerified: false when there is no phone at all', () => {
    expect(mapClerkUserToProfile({ id: 'user_1' })).toMatchObject({ phone: null, phoneVerified: false });
  });
});
