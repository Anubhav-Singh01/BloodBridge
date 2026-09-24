// The ONLY place in this codebase that knows the shape of a Clerk `user.created` / `user.updated`
// webhook event's `data` object. Nothing else should read a Clerk field directly - if Clerk's payload
// shape ever changes, this file is the only one that needs to.
//
// Only the fields BloodBridge actually has a column for, and that Clerk's webhook payload actually
// sends, are read here:
//   - full_name:  first_name + last_name (Clerk's default name fields)
//   - email:      the email_addresses entry matching primary_email_address_id
//   - phone:      the phone_numbers entry matching primary_phone_number_id, and whether Clerk reports
//                 that number's verification status as 'verified'
// date_of_birth and address are never set from this mapping: Clerk's default user object has no such
// fields, and DATABASE.md documents both as collected by the app itself, not synced from Clerk. This
// mapping never invents a value for a field Clerk did not actually send.

export interface ClerkEmailAddress {
  id: string;
  email_address: string;
}

export interface ClerkPhoneNumber {
  id: string;
  phone_number: string;
  verification?: { status?: string | null } | null;
}

/** The subset of Clerk's user object this app reads. Everything else Clerk sends is ignored on purpose. */
export interface ClerkUserData {
  id: string;
  first_name?: string | null;
  last_name?: string | null;
  primary_email_address_id?: string | null;
  email_addresses?: ClerkEmailAddress[];
  primary_phone_number_id?: string | null;
  phone_numbers?: ClerkPhoneNumber[];
}

export interface MappedClerkProfile {
  clerkUserId: string;
  fullName: string | null;
  email: string | null;
  phone: string | null;
  /** True only when a phone number is present AND Clerk reports it as verified. */
  phoneVerified: boolean;
}

export function mapClerkUserToProfile(data: ClerkUserData): MappedClerkProfile {
  const nameParts = [data.first_name, data.last_name].filter((part): part is string => Boolean(part && part.trim().length > 0));
  const fullName = nameParts.length > 0 ? nameParts.join(' ') : null;

  const primaryEmail = data.email_addresses?.find((e) => e.id === data.primary_email_address_id);
  const email = primaryEmail?.email_address ?? null;

  const primaryPhone = data.phone_numbers?.find((p) => p.id === data.primary_phone_number_id);
  const phone = primaryPhone?.phone_number ?? null;
  const phoneVerified = phone !== null && primaryPhone?.verification?.status === 'verified';

  return { clerkUserId: data.id, fullName, email, phone, phoneVerified };
}

/** The minimal shape of a Clerk `user.deleted` event's `data` object: just the id. */
export interface ClerkUserDeletedData {
  id: string;
}
