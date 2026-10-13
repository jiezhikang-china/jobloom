import './fixtures/activate-isolated-safety.js';
import assert from 'node:assert/strict';
import path from 'node:path'; import os from 'node:os';
import { chromium } from 'playwright-core';
import { BrowserService, browserService } from '../src/services/browser.service.js';
async function main() {
  assert.ok((browserService as any).profileDir.startsWith(path.resolve(os.tmpdir()) + path.sep), '离线测试不可使用用户的真实BOSS资料目录');
  assert.equal(await browserService.closeAfterTask(), false, '没有测试浏览器时不能重连并关闭真实浏览器');
  const browser=await chromium.launch({executablePath:'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',headless:true});
  try{
    const page=await browser.newPage();
    await page.route('**/*',r=>r.fulfill({contentType:'text/html; charset=utf-8',body:'<meta charset="utf-8"><div class="chat-user"><div class="user-list">全部 未读 新招呼</div></div><div class="chat-conversation">请选择一个联系人</div>'}));
    await page.goto('https://www.zhipin.com/web/geek/chat');
    await page.evaluate(()=>{(document.querySelector('.chat-conversation') as any).__vue__={$store:{state:{userInfo:{userId:'fixture-account'}}}};});
    const service=new BrowserService(process.env.BOSS_PROFILE_DIR);
    let cookie=true;
    (service as any).port=1;(service as any).workerPage={isClosed:()=>false,refreshUrl:async()=>page.url(),evaluate:page.evaluate.bind(page)};
    (service as any).listTabs=async()=>[{type:'page',id:'fixture',url:page.url()}];(service as any).hasSessionCookie=async()=>cookie;
    (service as any).recordVerifiedSession=async()=>{};
    assert.equal((await service.checkLoginStatus({restore:false})).isLoggedIn,true,'消息页有认证账号绑定和cookie即可核对会话，不强制切职位页');
    cookie=false;assert.equal((await service.checkLoginStatus({restore:false})).isLoggedIn,false,'仅有消息DOM不能绕过登录cookie核对');
    cookie=true;await page.evaluate(()=>delete (document.querySelector('.chat-conversation') as any).__vue__.$store.state.userInfo.userId);
    assert.equal((await service.checkLoginStatus({restore:false})).isLoggedIn,false,'空账号壳不能冒充登录');
    await page.evaluate(()=>{(document.querySelector('.chat-conversation') as any).__vue__.$store.state.userInfo.userId='fixture-account';const m=document.createElement('div');m.className='login-register-box';m.textContent='请登录';document.body.appendChild(m);});
    assert.equal((await service.checkLoginStatus({restore:false})).isLoggedIn,false,'消息账号绑定存在时仍尊重可见登录窗口');
    console.log('PASS | mock profile isolation, authenticated chat login, cookies/account/login modal checks; no production browser cleanup');
  }finally{await browser.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});

