import type { Request, Response } from 'express';
import { getReadinessReport } from '../services/readiness.service.js';

// Probe responses must never be cached.
const NO_STORE = 'no-store';

export function getHealth(_req: Request, res: Response): void {
  res.set('Cache-Control', NO_STORE);
  res.status(200).json({ status: 'ok' });
}

export async function getReady(_req: Request, res: Response): Promise<void> {
  const report = await getReadinessReport();
  res.set('Cache-Control', NO_STORE);
  res.status(report.status === 'ready' ? 200 : 503).json(report);
}
