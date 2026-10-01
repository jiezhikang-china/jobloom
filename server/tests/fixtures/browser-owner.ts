import { BrowserService } from '../../src/services/browser.service.js';

const profile = process.env.BOSS_LIFECYCLE_TEST_PROFILE;
if (!profile) throw new Error('缺少测试资料目录');
const service = new BrowserService(profile, { headless: true });
async function main(): Promise<void> {
  const page = await service.getWorkerPage();
  await page.goto('data:text/html;charset=utf-8,<body>local lifecycle fixture</body>');
  process.on('message', (message) => {
    if (message === 'exit') process.exit(0);
  });
  process.send?.({ ready: true });
}
main().catch(async (error) => {
  console.error(error);
  await service.close();
  process.exit(1);
});
