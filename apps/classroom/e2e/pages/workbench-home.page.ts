import type { Page, Locator } from '@playwright/test';

/**
 * 登录后的首页工作台（`app/page.tsx` 的登录态分支）。
 *
 * 与 `home.page.ts` 不是一回事：那个对的是**未登录**首页。账户系统恒开
 * （`accountsEnabled()` 永远 true），所以匿名访客拿到的是公共落地页，
 * 上面根本没有造课输入框——造课入口只在登录后出现。
 */
export class WorkbenchHomePage {
  readonly page: Page;
  /**
   * 顶栏品牌字标。原先老用例断的是 `img[alt="OpenMAIC"]`，那张图早随品牌换成
   * 「集智」时删了——现在字标是一段纯文字，不是图片。工作台里只出现这一处。
   */
  readonly wordmark: Locator;
  /** 需求输入框。工作台上唯一的 textarea。 */
  readonly requirement: Locator;
  /** 造课按钮。文案走 i18n（zh-CN 是「进入课堂」）。 */
  readonly enterButton: Locator;
  /** 学习者画像弹层的触发按钮。按钮上会带一句「这门课照着哪本书讲」的摘要。 */
  readonly profileTrigger: Locator;
  /** 弹层里的知识库下拉。选项来自 `/api/skills`。 */
  readonly corpusSelect: Locator;

  constructor(page: Page) {
    this.page = page;
    this.wordmark = page.locator('header').getByText('集智', { exact: true });
    this.requirement = page.locator('textarea').first();
    this.enterButton = page.getByRole('button', { name: /进入课堂|enter classroom/i });
    // 不按可见文字定位：按钮上的文字是画像摘要，会随选中的库变化，
    // 拿它当定位器等于用「待断言的内容」去找「承载它的元素」。
    // 也不按 title 定位：那句 title 是给用户看的说明文案，改一版文案测试就断。
    this.profileTrigger = page.getByTestId('learner-profile-trigger');
    // 不能用 getByLabel：`<label>` 把 `<select>` 整个包在里面，Playwright 取的
    // label 文本会把选项文字一起算进去（「知识库跟随培训领域…」），精确匹配「知识库」永远落空。
    this.corpusSelect = page.getByTestId('learner-profile-corpus');
  }

  async goto() {
    await this.page.goto('/');
  }

  /** 打开画像弹层，把知识库换成指定的库，再关掉弹层。 */
  async pickCorpus(corpus: string) {
    await this.profileTrigger.click();
    await this.corpusSelect.selectOption(corpus);
    await this.page.keyboard.press('Escape');
  }

  async fillRequirement(text: string) {
    await this.requirement.fill(text);
  }

  async submit() {
    await this.enterButton.click();
  }
}
