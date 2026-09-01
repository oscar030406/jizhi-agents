import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { NextRequest } from 'next/server';
import { SESSION_COOKIE } from '@/lib/accounts/session';
import { accountForSession } from '@/lib/accounts/store';
import { writeJsonFileAtomic } from '@/lib/server/classroom-storage';

function ownersDir(): string {
  return process.env.RENDER_JOB_OWNERS_DIR || path.join(process.cwd(), 'data', 'render-job-owners');
}

export function isValidRenderJobId(jobId: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(jobId);
}

function ownerFile(jobId: string): string {
  if (!isValidRenderJobId(jobId)) throw new Error('Invalid render job id');
  return path.join(ownersDir(), `${jobId}.json`);
}

export async function renderAccountId(req: NextRequest): Promise<string | null> {
  const account = await accountForSession(req.cookies.get(SESSION_COOKIE)?.value);
  return account?.id ?? null;
}

export async function recordRenderJobOwner(jobId: string, ownerAccountId: string): Promise<void> {
  await writeJsonFileAtomic(ownerFile(jobId), { ownerAccountId });
}

export async function readRenderJobOwner(jobId: string): Promise<string | null> {
  try {
    const raw = JSON.parse(await fs.readFile(ownerFile(jobId), 'utf8')) as {
      ownerAccountId?: unknown;
    };
    if (typeof raw.ownerAccountId !== 'string' || !raw.ownerAccountId) {
      throw new Error('Invalid render job owner record');
    }
    return raw.ownerAccountId;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function canAccessRenderJob(req: NextRequest, jobId: string): Promise<boolean> {
  if (!isValidRenderJobId(jobId)) return false;
  let ownerAccountId: string | null;
  try {
    ownerAccountId = await readRenderJobOwner(jobId);
  } catch {
    return false;
  }
  if (!ownerAccountId) return true;
  try {
    return (await renderAccountId(req)) === ownerAccountId;
  } catch {
    return false;
  }
}
