/**
 * 演示账号：评委从首页一键进入学习端 / 管理端用的两个固定账号。
 *
 * 「是不是演示会话」不另存标记，直接看会话解出来的账号是不是这两个用户名——
 * 标记存 cookie 会被丢、存会话记录要两套后端各改一遍，而用户名跟着会话走，
 * 谁也伪造不了。用密码正常登录这两个号同样受限，共用账号本来就不该做那些事。
 */

import { API_ERROR_CODES, apiError } from '@/lib/server/api-response';

export type DemoRole = 'learner' | 'manager' | 'learner2' | 'manager2';

/**
 * 四个演示账号：learner / manager 是首页按钮进的甲方培训中心两个号；
 * learner2 / manager2 是乙方智造学院的两个号，只给录屏与跨机构隔离演示用，
 * 首页不放按钮（评委三分钟看不到第二家机构的必要），接口接受即可。
 */
export const DEMO_USERNAMES: Record<DemoRole, string> = {
  learner: 'orgdemo_stu1_vf1',
  manager: 'orgdemo_mgr_vf1',
  learner2: 'orgdemo_stud_vf1',
  manager2: 'orgdemo_mgr2_vf1',
};

export const DEMO_ROLES: readonly DemoRole[] = ['learner', 'manager', 'learner2', 'manager2'];

/** 演示角色对应的账户角色：带 2 的是第二家机构的同类角色。 */
export function accountRoleOfDemo(role: DemoRole): 'learner' | 'manager' {
  return role.startsWith('manager') ? 'manager' : 'learner';
}

export const DEMO_FORBIDDEN_MESSAGE = '演示账号不能做这个操作';

export function isDemoAccount(account: { username: string } | null | undefined): boolean {
  const name = typeof account?.username === 'string' ? account.username.toLowerCase() : '';
  return !!name && Object.values(DEMO_USERNAMES).some((u) => u.toLowerCase() === name);
}

/** 403；正文同时带 `error` 字符串与 errorCode，站内两种前端错误读法都能显示。 */
export function demoForbidden() {
  return apiError(API_ERROR_CODES.UNAUTHORIZED, 403, DEMO_FORBIDDEN_MESSAGE);
}
