import { NextRequest, NextResponse } from 'next/server';

import { accountForSession, exportAccountData } from '@/lib/accounts/store';
import { SESSION_COOKIE } from '@/lib/accounts/session';
import { createLogger } from '@/lib/logger';

const log = createLogger('Account export API');

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  try {
    const account = await accountForSession(req.cookies.get(SESSION_COOKIE)?.value);
    if (!account) return NextResponse.json({ error: '未登录' }, { status: 401 });
    const data = await exportAccountData(account);
    return new NextResponse(JSON.stringify(data, null, 2), {
      headers: {
        'Cache-Control': 'no-store',
        'Content-Disposition': `attachment; filename="jizhi-${account.username}-data.json"`,
        'Content-Type': 'application/json; charset=utf-8',
      },
    });
  } catch (error) {
    log.error('account export failed:', error);
    return NextResponse.json({ error: '账户数据导出失败' }, { status: 500 });
  }
}
