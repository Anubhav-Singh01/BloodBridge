import { and, eq, lt, or, sql } from 'drizzle-orm';
import { db } from '../db/connection.js';
import { donationHistory } from '../db/schema/index.js';

export type DonationType = 'WHOLE_BLOOD';
export type DonationSource = 'SELF_REPORTED' | 'REQUESTER_CONFIRMED' | 'FACILITY_RECORDED';
export type DonationVerificationStatus = 'UNVERIFIED' | 'VERIFIED' | 'REJECTED';

export interface DonationHistoryRow {
  id: string;
  donorId: string;
  donationType: DonationType;
  donatedAt: Date;
  source: DonationSource;
  facilityId: string | null;
  verificationStatus: DonationVerificationStatus;
  verifiedBy: string | null;
  verifiedAt: Date | null;
}

const DONATION_COLUMNS = {
  id: donationHistory.id,
  donorId: donationHistory.donorId,
  donationType: donationHistory.donationType,
  donatedAt: donationHistory.donatedAt,
  source: donationHistory.source,
  facilityId: donationHistory.facilityId,
  verificationStatus: donationHistory.verificationStatus,
  verifiedBy: donationHistory.verifiedBy,
  verifiedAt: donationHistory.verifiedAt,
} as const;

/** Batch 3.12 decision C: donor self-report only. No facility_id, no recorded_by - satisfies
 * donation_history_facility_required / _recorder_required (both are OR'd with source = SELF_REPORTED). */
export async function createSelfReported(donorId: string, donatedAt: Date, donationType: DonationType): Promise<{ id: string }> {
  const [row] = await db.insert(donationHistory).values({ donorId, donatedAt, donationType, source: 'SELF_REPORTED' }).returning({ id: donationHistory.id });
  return row!;
}

export async function findById(id: string): Promise<DonationHistoryRow | undefined> {
  const [row] = await db.select(DONATION_COLUMNS).from(donationHistory).where(eq(donationHistory.id, id)).limit(1);
  return row;
}

/** The one row the eligibility engine reads: the latest VERIFIED donation of this type. */
export async function findLatestVerified(donorId: string, donationType: DonationType): Promise<DonationHistoryRow | undefined> {
  const [row] = await db
    .select(DONATION_COLUMNS)
    .from(donationHistory)
    .where(and(eq(donationHistory.donorId, donorId), eq(donationHistory.donationType, donationType), eq(donationHistory.verificationStatus, 'VERIFIED')))
    .orderBy(sql`${donationHistory.donatedAt} DESC`)
    .limit(1);
  return row;
}

export async function setVerification(id: string, status: 'VERIFIED' | 'REJECTED', verifiedBy: string): Promise<void> {
  await db.update(donationHistory).set({ verificationStatus: status, verifiedBy, verifiedAt: new Date() }).where(eq(donationHistory.id, id));
}

export interface DonationHistoryPage {
  items: DonationHistoryRow[];
  nextCursor: string | null;
}

function encodeCursor(donatedAt: Date, id: string): string {
  return Buffer.from(`${donatedAt.toISOString()}|${id}`, 'utf8').toString('base64url');
}
function decodeCursor(cursor: string): { donatedAt: Date; id: string } {
  const [iso, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  return { donatedAt: new Date(iso!), id: id! };
}

/** API.md 1.3: cursor-based, ordered (donated_at DESC, id DESC) for a stable, total order. Own records only. */
export async function listByDonor(donorId: string, limit: number, cursor?: string): Promise<DonationHistoryPage> {
  const base = eq(donationHistory.donorId, donorId);
  const where = cursor
    ? and(base, (() => {
        const { donatedAt, id } = decodeCursor(cursor);
        return or(lt(donationHistory.donatedAt, donatedAt), and(eq(donationHistory.donatedAt, donatedAt), lt(donationHistory.id, id)));
      })())
    : base;

  const rows = await db.select(DONATION_COLUMNS).from(donationHistory).where(where).orderBy(sql`${donationHistory.donatedAt} DESC, ${donationHistory.id} DESC`).limit(limit + 1);
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  return { items, nextCursor: hasMore && last ? encodeCursor(last.donatedAt, last.id) : null };
}
