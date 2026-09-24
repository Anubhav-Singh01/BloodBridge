import { and, eq, lt, or, sql } from 'drizzle-orm';
import { db } from '../db/connection.js';
import { bloodBanks, facilities, hospitals } from '../db/schema/index.js';

export type FacilityType = 'HOSPITAL' | 'BLOOD_BANK';

export interface FacilityRow {
  id: string;
  facilityType: FacilityType;
  name: string;
  registrationNo: string | null;
  contact: string | null;
  address: string | null;
  hasLocation: boolean;
  verificationStatus: 'PENDING' | 'UNDER_REVIEW' | 'VERIFIED' | 'REJECTED';
  status: 'ACTIVE' | 'SUSPENDED';
  createdBy: string;
  createdAt: Date;
}

const FACILITY_COLUMNS = {
  id: facilities.id,
  facilityType: facilities.facilityType,
  name: facilities.name,
  registrationNo: facilities.registrationNo,
  contact: facilities.contact,
  address: facilities.address,
  hasLocation: sql<boolean>`${facilities.location} IS NOT NULL`,
  verificationStatus: facilities.verificationStatus,
  status: facilities.status,
  createdBy: facilities.createdBy,
  createdAt: facilities.createdAt,
} as const;

export interface RegisterFacilityInput {
  facilityType: FacilityType;
  name: string;
  registrationNo?: string | null | undefined;
  contact?: string | null | undefined;
  address?: string | null | undefined;
  location?: { lat: number; lng: number } | null | undefined;
  createdBy: string;
}

/** One transaction: the facilities row plus its specialized (hospitals/blood_banks) row. */
export async function registerFacility(input: RegisterFacilityInput): Promise<{ id: string }> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(facilities)
      .values({
        facilityType: input.facilityType,
        name: input.name,
        registrationNo: input.registrationNo ?? null,
        contact: input.contact ?? null,
        address: input.address ?? null,
        location: input.location ? sql`ST_SetSRID(ST_MakePoint(${input.location.lng}, ${input.location.lat}), 4326)::geography` : null,
        createdBy: input.createdBy,
      })
      .returning({ id: facilities.id });
    const id = row!.id;

    if (input.facilityType === 'HOSPITAL') {
      await tx.insert(hospitals).values({ facilityId: id });
    } else {
      await tx.insert(bloodBanks).values({ facilityId: id });
    }
    return { id };
  });
}

export async function findById(id: string): Promise<FacilityRow | undefined> {
  const [row] = await db.select(FACILITY_COLUMNS).from(facilities).where(eq(facilities.id, id)).limit(1);
  return row;
}

export interface FacilityProfilePatch {
  name?: string | undefined;
  registrationNo?: string | null | undefined;
  contact?: string | null | undefined;
  address?: string | null | undefined;
  location?: { lat: number; lng: number } | null | undefined;
}

/** resetVerification: whether the caller determined this patch touches a verification-relevant field. */
export async function updateProfile(id: string, patch: FacilityProfilePatch, resetVerification: boolean): Promise<void> {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if ('name' in patch) set.name = patch.name;
  if ('registrationNo' in patch) set.registrationNo = patch.registrationNo;
  if ('contact' in patch) set.contact = patch.contact;
  if ('address' in patch) set.address = patch.address;
  if ('location' in patch) {
    set.location = patch.location ? sql`ST_SetSRID(ST_MakePoint(${patch.location.lng}, ${patch.location.lat}), 4326)::geography` : null;
  }
  if (resetVerification) set.verificationStatus = 'UNDER_REVIEW';
  await db.update(facilities).set(set).where(eq(facilities.id, id));
}

export interface PublicFacilityPage {
  items: FacilityRow[];
  nextCursor: string | null;
}

function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`, 'utf8').toString('base64url');
}
function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  const [iso, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  return { createdAt: new Date(iso!), id: id! };
}

/** API.md 1.3: cursor-based pagination, ordered (created_at DESC, id DESC) for a stable, total order. */
export async function listPublic(facilityType: FacilityType, limit: number, cursor?: string): Promise<PublicFacilityPage> {
  const base = and(eq(facilities.facilityType, facilityType), eq(facilities.verificationStatus, 'VERIFIED'), eq(facilities.status, 'ACTIVE'));
  const where = cursor
    ? and(base, (() => {
        const { createdAt, id } = decodeCursor(cursor);
        return or(lt(facilities.createdAt, createdAt), and(eq(facilities.createdAt, createdAt), lt(facilities.id, id)));
      })())
    : base;

  const rows = await db.select(FACILITY_COLUMNS).from(facilities).where(where).orderBy(sql`${facilities.createdAt} DESC, ${facilities.id} DESC`).limit(limit + 1);
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  return { items, nextCursor: hasMore && last ? encodeCursor(last.createdAt, last.id) : null };
}
