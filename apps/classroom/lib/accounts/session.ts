/** 会话 cookie 名与读取助手（服务端专用）。 */

import type { IncomingMessage } from 'node:http';

export const SESSION_COOKIE = 'jizhi_session';

/** 从原始 cookie 头里取会话 token。 */
export function sessionTokenFromCookieHeader(header: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === SESSION_COOKIE) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}

export function sessionTokenFromRequest(req: IncomingMessage): string | undefined {
  return sessionTokenFromCookieHeader(req.headers.cookie);
}
