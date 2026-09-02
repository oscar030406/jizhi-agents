import { createAccount, validateCredentials } from '../lib/accounts/store';

async function main() {
  const username = process.env.JIZHI_MANAGER_USERNAME?.trim() ?? '';
  const password = process.env.JIZHI_MANAGER_PASSWORD ?? '';
  delete process.env.JIZHI_MANAGER_PASSWORD;

  const validation = validateCredentials(username, password);
  if (!validation.ok) {
    throw new Error(
      `管理者签发参数无效：${validation.message}。请仅在服务器终端临时设置 JIZHI_MANAGER_USERNAME 与 JIZHI_MANAGER_PASSWORD。`,
    );
  }

  const result = await createAccount(username, password, 'manager');
  if (!result.ok) throw new Error(`管理者账户签发失败：${result.message}`);

  console.log(`管理者账户已签发：${result.account.username} (${result.account.id})`);
}

void main();
