import type { Page, Locator } from '@playwright/test';

import {
  E2E_CORPUS,
  E2E_CORPUS_SCOPE,
  E2E_INTAKE_FILE,
} from '../fixtures/test-data/knowledge-pipeline';

/**
 * 管理端 · 知识库接入表单（`/admin/knowledge`）。
 *
 * 这一页是服务端组件 + 登录闸：没有管理者会话时整页换成「只对管理者账号开放」，
 * 表单一个字段都不渲染。所以定位器全部落在接入区里面——进不去的时候
 * `intakeHeading` 先失败，报错直接指向「没拿到管理者会话」，
 * 而不是让人对着「找不到 input[name=corpus]」猜半天。
 */
export class KnowledgeIntakePage {
  readonly page: Page;
  /** 接入区标题。它可见 = 过了登录闸，表单在场。 */
  readonly intakeHeading: Locator;
  readonly corpusInput: Locator;
  readonly scopeInput: Locator;
  readonly filesInput: Locator;
  readonly submitButton: Locator;
  /** 确认弹层。真花钱的那一步在这里，库名、投料、档数都在弹层里回显。 */
  readonly confirmDialog: Locator;
  readonly confirmButton: Locator;

  constructor(page: Page) {
    this.page = page;
    this.intakeHeading = page.getByRole('heading', { name: '接入新知识库' });
    this.corpusInput = page.locator('input[name="corpus"]');
    this.scopeInput = page.locator('input[name="scope"]');
    this.filesInput = page.locator('input[name="files"]');
    this.submitButton = page.getByRole('button', { name: '发起接入' });
    this.confirmDialog = page.getByRole('dialog');
    this.confirmButton = page.getByRole('button', { name: '确认发起' });
  }

  async goto() {
    await this.page.goto('/admin/knowledge');
  }

  /** 按新建一个库来填：库名、领域范围、一份文档。档位沿用默认的两档。 */
  async fillNewCorpus() {
    await this.corpusInput.fill(E2E_CORPUS);
    await this.scopeInput.fill(E2E_CORPUS_SCOPE);
    await this.filesInput.setInputFiles({
      name: E2E_INTAKE_FILE.name,
      mimeType: E2E_INTAKE_FILE.mimeType,
      buffer: Buffer.from(E2E_INTAKE_FILE.body, 'utf-8'),
    });
  }

  /** 点「发起接入」。这一下只弹确认层，不发请求。 */
  async submit() {
    await this.submitButton.click();
  }

  /** 点「确认发起」。这一下才真的 POST。 */
  async confirm() {
    await this.confirmButton.click();
  }
}
