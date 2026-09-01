import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { NextRequest } from 'next/server';
import { SESSION_COOKIE } from '@/lib/accounts/session';
import { accountForSession } from '@/lib/accounts/store';
import { writeJsonFileAtomic } from '@/lib/server/classroom-storage';

export const RENDER_ANON_COOKIE = 'jizhi_render_anon';

const ANONYMOUS_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PRINCIPAL_PATTERN =
  /^(?:account:[A-Za-z0-9_-]{1,128}|anon:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

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

async function renderAccountPrincipal(req: NextRequest): Promise<string | null> {
  const account = await accountForSession(req.cookies.get(SESSION_COOKIE)?.value);
  return account?.id ? `account:${account.id}` : null;
}

function renderAnonymousPrincipal(req: NextRequest): string | null {
  const id = req.cookies.get(RENDER_ANON_COOKIE)?.value;
  return id && ANONYMOUS_ID_PATTERN.test(id) ? `anon:${id}` : null;
}

export async function createRenderJobPrincipal(
  req: NextRequest,
): Promise<{ principal: string; anonymousCookie?: string }> {
  const account = await renderAccountPrincipal(req);
  if (account) return { principal: account };
  const existing = renderAnonymousPrincipal(req);
  if (existing) return { principal: existing };
  const anonymousCookie = randomUUID();
  return { principal: `anon:${anonymousCookie}`, anonymousCookie };
}

export async function recordRenderJobOwner(jobId: string, ownerPrincipal: string): Promise<void> {
  if (!PRINCIPAL_PATTERN.test(ownerPrincipal)) throw new Error('Invalid render job principal');
  await writeJsonFileAtomic(ownerFile(jobId), { ownerPrincipal });
}

export async function readRenderJobOwner(jobId: string): Promise<string | null> {
  try {
    const raw = JSON.parse(await fs.readFile(ownerFile(jobId), 'utf8')) as {
      ownerPrincipal?: unknown;
      ownerAccountId?: unknown;
    };
    const ownerPrincipal =
      typeof raw.ownerPrincipal === 'string'
        ? raw.ownerPrincipal
        : typeof raw.ownerAccountId === 'string'
          ? `account:${raw.ownerAccountId}`
          : '';
    if (!PRINCIPAL_PATTERN.test(ownerPrincipal)) {
      throw new Error('Invalid render job owner record');
    }
    return ownerPrincipal;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function canAccessRenderJob(req: NextRequest, jobId: string): Promise<boolean> {
  if (!isValidRenderJobId(jobId)) return false;
  let ownerPrincipal: string | null;
  try {
    ownerPrincipal = await readRenderJobOwner(jobId);
  } catch {
    return false;
  }
  if (!ownerPrincipal) return false;
  try {
    const principals = [await renderAccountPrincipal(req), renderAnonymousPrincipal(req)];
    return principals.includes(ownerPrincipal);
  } catch {
    return false;
  }
}
