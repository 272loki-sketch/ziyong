import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile, copyFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { SessionManager } from '@liyuan/agent-runtime';
import { DatabasePluginSourceStore } from '../../server/database-plugin-source.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const dist = process.env.LIYUAN_DATABASE_MANAGER_DIST || join(root, 'web/dist');
const upstream = process.env.LIYUAN_DATABASE_PLUGIN_TEST_SOURCE;
const vendor = process.env.LIYUAN_DATABASE_PLUGIN_TEST_VENDOR;
const artifacts = process.env.LIYUAN_DATABASE_MANAGER_ARTIFACTS;
if (!upstream || !vendor) {
 console.log('SKIP original database manager UI: provide verified synthetic source/vendor paths');
 process.exit(0);
}
// The isolated upstream host deliberately presents window.parent as itself.
// Use native DOM click events inside that frame; Playwright's cross-frame pointer traversal can loop on the host facade.
const originalUiClick = async locator => {await locator.waitFor();await locator.evaluate(element=>element.click());};
const awaitHostReady=async page=>{const locator=page.locator('iframe[title="原数据库插件管理台"]');await locator.waitFor();const element=await locator.elementHandle();const host=await element.contentFrame();await host.waitForFunction(()=>window.LiyuanDatabasePluginHost?.ready(),{},{timeout:65000});await host.evaluate(()=>window.LiyuanDatabasePluginHost.flush());};
const canonical = history => history.slice(1).map(({mes,is_user,message_id,__liyuanEntryId}) => ({mes,is_user,message_id,__liyuanEntryId}));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const listener = createServer();
await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
const port = listener.address().port;
await new Promise(resolve => listener.close(resolve));
const base = `http://127.0.0.1:${port}`;
const cwd = await mkdtemp(join(tmpdir(), 'liyuan-database-manager-ui-'));
await mkdir(join(cwd, 'web')); await symlink(dist, join(cwd, 'web/dist'), 'dir');
for (const name of ['src', 'skills', 'node_modules']) await symlink(join(root, name), join(cwd, name), 'dir');
await mkdir(join(cwd, '.liyuan')); await symlink(join(root, '.liyuan/extensions'), join(cwd, '.liyuan/extensions'), 'dir');
const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
await writeFile(join(cwd, 'package.json'), JSON.stringify({ name: 'database-manager-ui-fixture', version, type: 'module' }));
const card = name => ({ spec: 'chara_card_v2', data: { name, description: '仅合成数据库界面测试', first_mes: '青梧在桥边等待。这是合成开场。' } });
await writeFile(join(cwd, 'card-a.json'), JSON.stringify(card('合成数据库卡 A')));
await writeFile(join(cwd, 'card-b.json'), JSON.stringify(card('合成数据库卡 B')));
await writeFile(join(cwd, 'liyuan.config.json'), JSON.stringify({ card: 'card-a.json', userName: 'Fixture', greeting: true, generationMode: 'director', literaryWorldEnabled: false, literaryEcologyEnabled: false, novelDigest: { enabled: false }, researchSearchSchedule: { enabled: false } }));
const sources = new DatabasePluginSourceStore({ cwd, fetch: async () => new Response(await readFile(upstream)) });
const candidate = await sources.downloadSource({}); await sources.activateRef(candidate.sha256);
await mkdir(join(cwd, '.liyuan-database-plugin/vendor'), { recursive: true });
for (const name of ['jquery.min.js', 'sql-wasm.js', 'sql-wasm.wasm']) await copyFile(join(vendor, name), join(cwd, '.liyuan-database-plugin/vendor', name));
const mockGateway=createHttpServer((req,res)=>{if(req.url==='/v1/models'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({data:[{id:'gemini-3.8-flash',object:'model'}]}));return;}res.writeHead(403);res.end('Synthetic model generation must be explicitly intercepted by the browser fixture');});
await new Promise(resolve=>mockGateway.listen(0,'127.0.0.1',resolve));
await writeFile(join(cwd,'liyuan.agent.json'),JSON.stringify({version:1,defaultProvider:'fixture',defaultModel:'gemini-3.8-flash',providers:{fixture:{baseUrl:'http://127.0.0.1:'+mockGateway.address().port+'/v1',api:'openai-completions',apiKey:'SYNTHETIC_NOT_A_REAL_KEY',compat:{streaming:false,supportsTools:false,supportsDeveloperRole:false,supportsReasoningEffort:false},models:[{id:'gemini-3.8-flash',contextWindow:128000,maxTokens:16384}]}}}));
await writeFile(join(cwd, '.liyuan-database-plugin/config.json'), JSON.stringify({version:1,enabled:true,fillModel:{provider:'fixture',id:'gemini-3.8-flash'},recallModel:{provider:'fixture',id:'gemini-3.8-flash'}}));
// Seed canonical synthetic messages before starting the real host; never prompt a real writer.
const sessionDir = join(cwd, 'agent/sessions', '--' + cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-') + '--');
const syntheticSession = SessionManager.create(cwd, sessionDir);
syntheticSession.appendCustomEntry('rp-card', { card: 'card-a.json' });
const bot = (text, details) => ({ role: 'assistant', content: [{ type: 'text', text }], details, api: 'openai-completions', provider: 'fixture', model: 'fixture', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: Date.now() });
syntheticSession.appendMessage(bot('青梧在桥边等待，这是合成开场。', { rpGreeting: true }));
syntheticSession.appendMessage({ role: 'user', content: [{ type: 'text', text: '把合成铜钥匙交给青梧。' }], timestamp: Date.now() });
syntheticSession.appendMessage(bot('青梧接受合成铜钥匙，约好次日归还。', { rpNarrative: '青梧接受合成铜钥匙，约好次日归还。', rpGenerationMode: 'director' }));
const server = spawn(process.execPath, [join(root, 'server/main.ts')], { cwd, env: { ...process.env, HOME: join(cwd, 'home'), LIYUAN_CODING_AGENT_DIR: join(cwd, 'agent'), HOST: '127.0.0.1', PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = '', browser, page, releaseSource, permitFixtureFill = false, fixtureFillCalls = 0;
const errors = [], forbidden = [], writes = [], failedRequests = [], observedBindings = [];
for (const stream of [server.stdout, server.stderr]) stream.on('data', data => { logs += data; });
const api = async (path, method = 'GET', body) => {
 const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
 assert.ok(response.ok, `synthetic ${method} ${path}: ${response.status}`);
 return response.json();
};
const watchdog = setTimeout(() => { console.log('Synthetic manager test deadline exceeded');void browser?.close();server.kill('SIGTERM'); },180000);watchdog.unref();
try {
 for (let i = 0; i < 80; i++) { try { if ((await fetch(base + '/healthz')).ok) break; } catch {} if (server.exitCode !== null) break; await pause(250); }
 const before = await api('/healthz');
 const initialCanonical = canonical(await api('/api/database-plugin/native-chat'));
 assert.equal(initialCanonical.length,3);
 const builtHost = await fetch(base + '/database-plugin-host.html?view=manager');
 assert.match(await builtHost.text(), new RegExp(`database-plugin-host\\.js\\?v=${version.replaceAll('.', '\\.')}`));
 assert.equal((await fetch(base + `/database-plugin-host.js?v=${version}`)).headers.get('cache-control'), 'no-cache');
 browser = await chromium.launch({ headless: true, args: process.getuid?.() === 0 ? ['--no-sandbox'] : [], env: { ...process.env, LD_LIBRARY_PATH: process.env.LIYUAN_DATABASE_BROWSER_LIBS ?? process.env.LD_LIBRARY_PATH ?? '' } });
 const browserContext = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' });
 await browserContext.route('**/*', async route => {
  const req = route.request(), url = new URL(req.url());
  if (url.origin !== base) return route.abort('blockedbyclient');
  if (req.method() !== 'GET' && url.pathname.startsWith('/api/database-plugin')) {
   if ((url.pathname.endsWith('/generate')||url.pathname.endsWith('/completion')) && permitFixtureFill) {
    fixtureFillCalls++;
    const text = '<thought>' + '仅合成界面回归，记录已有合成开场。'.repeat(40) + '</thought><content><tableEdit>\ninsertRow(6,{"0":"AM0001","1":"2026-10-07 08:00 ~ 2026-10-07 08:10","2":"合成开场","3":"青梧在桥边等待，这是合成测试开场，不是真实故事。","4":""})\n</tableEdit></content>';
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(url.pathname.endsWith('/completion')?{model:'gemini-3.8-flash',choices:[{index:0,message:{role:'assistant',content:text},finish_reason:'stop'}]}:{text}) });
   }
   if (/\/(generate|completion|embeddings|external)$/.test(url.pathname)) { forbidden.push(url.pathname); return route.abort('blockedbyclient'); }
   writes.push(url.pathname);
  }
  return route.continue();
 });
 page = await browserContext.newPage(); page.setDefaultTimeout(20000);
 page.on('pageerror', error => errors.push(error.message));
 page.on('console', message => {if(message.text().startsWith('DATABASE_BOOT_MESSAGE'))console.log(message.text());});
 page.on('response', response => { if(new URL(response.url()).pathname==='/api/database-plugin/binding') void response.json().then(value=>observedBindings.push(value)).catch(()=>{}); });
 page.on('requestfailed', request => failedRequests.push({path:new URL(request.url()).pathname,error:request.failure()?.errorText}));
 page.on('dialog', dialog => void dialog.dismiss());
 await page.routeWebSocket('**/ws', ws => {
  const remote = ws.connectToServer();
  ws.onMessage(message => { const f = JSON.parse(String(message)); if (/prompt|reroll|retry|generate/i.test(f.type)) { forbidden.push(f.type); return; } remote.send(message); });
  remote.onMessage(message => ws.send(message));
 });
 await page.goto(base);
 await page.evaluate(()=>window.addEventListener('message',event=>{if(event.data?.type?.startsWith('liyuan-database-'))console.log('DATABASE_BOOT_MESSAGE',event.data.type,event.data.message??'')}));
 let sourceCaptured = false;
 await page.route('**/api/database-plugin/status', async route => {
  if (sourceCaptured) return route.continue();
  sourceCaptured = true; await new Promise(resolve => { releaseSource = resolve; }); await route.continue();
 });
 const entry = page.getByRole('button', { name: '数据库', exact: true });
 await entry.waitFor(); await entry.click();
 const manager = page.getByRole('dialog', { name: '数据库管理台', exact: true });
 await manager.waitFor();
 const desktopBox=await manager.boundingBox();assert.ok(desktopBox.x>0&&desktopBox.y>0&&desktopBox.width<1440&&desktopBox.height<1000,'database must be a bounded popup over the conversation');
 assert.equal(await page.locator('.database-manager-backdrop').count(),1);
 console.log('SYNTHETIC_UI_STEP','main-entry');
 for (let i = 0; i < 100 && !sourceCaptured; i++) await pause(50);
 assert.ok(sourceCaptured, 'management entry must request real upstream status');
 assert.ok(await manager.getByText(/正在.*(?:加载|载入)/).count());
 await page.evaluate(() => window.postMessage({ type: 'liyuan-database-ready' }, location.origin));
 assert.ok(await manager.getByText(/正在.*(?:加载|载入)/).count(), 'same-origin parent spoof must not fake iframe readiness');
 releaseSource(); releaseSource = null;
 // Pause only the small status handshake, not the upstream multi-megabyte script transfer.

 const frame = page.frameLocator('iframe[title="原数据库插件管理台"]');
 console.log('SYNTHETIC_UI_STEP','status-released');
 await frame.locator('.acu-v2-app__shell').waitFor();
 const initializedHost = page.frames().find(f => f.url().includes('database-plugin-host.html'));
 await initializedHost.waitForFunction(() => window.LiyuanDatabasePluginHost?.ready(), {}, {timeout:65000});
 await manager.locator('.database-manager__state').waitFor({state:'hidden'});
 await frame.getByRole('button', { name: '填表模式', exact: true }).waitFor();
 assert.ok(await frame.getByText('重要角色表', { exact: true }).count());
 assert.ok(await frame.getByText('纪要表', { exact: true }).count());
 await originalUiClick(frame.getByRole('button', { name: '填表模式', exact: true }));
 await originalUiClick(frame.getByRole('button', { name: '经典表格模式', exact: true }));
 await frame.getByText('交火模式', { exact: true }).waitFor();
 await originalUiClick(frame.getByRole('button', { name: '经典表格模式', exact: true }));
  await originalUiClick(frame.getByRole('button', { name: 'API', exact: true }));
 assert.match(await frame.locator('.acu-v2-app').innerText(), /API/);
 const modelResponse=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/database-plugin/completion-status');
 await originalUiClick(frame.getByRole('button',{name:'加载模型',exact:true}));
 const loadedModels=await modelResponse;assert.equal(loadedModels.status(),200);assert.ok((await loadedModels.json()).data.some(model=>model.id==='gemini-3.8-flash'));
 console.log('SYNTHETIC_API_CONTROLS',await frame.locator('.acu-v2-app button').evaluateAll(es=>es.map(e=>({text:e.innerText,aria:e.getAttribute('aria-label'),title:e.title}))));
 assert.ok(!String(await frame.locator('.acu-v2-app').innerText()).includes('未知接口'));
 const recallName='梨园 · gemini-3.8-flash · 召回';
 await originalUiClick(frame.getByRole('button',{name:'梨园 · gemini-3.8-flash · 填表',exact:true}));
 await frame.getByText(recallName,{exact:true}).last().waitFor();
 await originalUiClick(frame.getByText(recallName,{exact:true}).last());
 await originalUiClick(frame.getByRole('button',{name:'新建预设',exact:true}));
 await originalUiClick(frame.getByText('自定义',{exact:true}));
 const field=label=>frame.locator('.acu-form-row').filter({has:frame.getByText(label,{exact:true})}).locator('input').first();
 console.log('API_DRAFT_INPUTS',await frame.locator('.acu-v2-app input').evaluateAll(es=>es.map(e=>({placeholder:e.placeholder,type:e.type,label:e.closest('.acu-form-row')?.innerText.split('\n')[0]}))));
 await field('预设名称').fill('合成新API预设');
 await field('端点(基础URL)').fill('http://127.0.0.1:'+mockGateway.address().port+'/v1');
 await field('API 密钥').fill('SYNTHETIC_NOT_A_REAL_KEY');
 const draftModels=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/database-plugin/completion-status');
 await originalUiClick(frame.getByRole('button',{name:'加载模型',exact:true}));assert.equal((await draftModels).status(),200);
 await field('模型名').fill('gemini-3.8-flash');
 await originalUiClick(frame.getByRole('button',{name:'保存并选中预设',exact:true}));
 await frame.getByRole('button',{name:'合成新API预设',exact:true}).waitFor();
 const savedContext=await api('/api/database-plugin/context');assert.ok(!JSON.stringify(savedContext.extensionSettings).includes('SYNTHETIC_NOT_A_REAL_KEY'));
 await originalUiClick(frame.getByRole('button',{name:'合成新API预设',exact:true}));
 await originalUiClick(frame.getByText('梨园 · gemini-3.8-flash · 填表',{exact:true}).last());
 await originalUiClick(frame.getByRole('button', { name: '仪表盘', exact: true }));
 assert.match(await frame.locator('.acu-v2-app').innerText(), /0\s*TK/);
 await originalUiClick(frame.getByRole('button', { name: '数据管理', exact: true }));
 assert.match(await frame.locator('.acu-v2-app').innerText(), /导入|导出/);
 await originalUiClick(frame.getByRole('button', { name: '填表工作台', exact: true }));
 // Only this explicit synthetic fill is allowed; opening/navigation must never invoke a model.
 assert.equal(fixtureFillCalls, 0);
 const hostFrame = page.frames().find(f => f.url().includes('database-plugin-host.html'));
 permitFixtureFill = true;
 let fillTimer;
 try {
  const fill = await Promise.race([hostFrame.evaluate(() => window.LiyuanDatabasePluginHost.after()), new Promise((_,reject) => {fillTimer=setTimeout(()=>reject(new Error('Synthetic original fill deadline exceeded')),60000);})]);
  assert.equal(fill.success, true);
 } finally { clearTimeout(fillTimer); permitFixtureFill = false; }
 assert.equal(fixtureFillCalls, 1);
 console.log('SYNTHETIC_UI_STEP','original-fill');
 await originalUiClick(frame.getByRole('button', { name: '打开可视化表格编辑器', exact: true }));
 await originalUiClick(frame.getByRole('button', { name: /^重要角色表/ }));
 await originalUiClick(frame.getByRole('button', { name: '新增行', exact: true }));
 // The assertions below exercise actual upstream cell editing and durable state, not a mock UI.
 await originalUiClick(frame.locator('.acu-visualizer-surface__field-preview').first());
 await frame.locator('.acu-v2-app textarea').first().fill('合成人物·界面保存验证');
 await frame.locator('.acu-v2-app textarea').first().press('Tab');
 await originalUiClick(frame.getByRole('button', { name: '保存数据到当前消息', exact: true }));
 for (let i = 0; i < 100; i++) { const value = await api('/api/database-plugin/context'); if (JSON.stringify(value.chat).includes('合成人物·界面保存验证')) break; await pause(100); }
 assert.match(JSON.stringify((await api('/api/database-plugin/context')).chat), /合成人物·界面保存验证/);
 console.log('SYNTHETIC_UI_STEP','row-durable');
 assert.ok(writes.includes('/api/database-plugin/state'));
 const saveButton = frame.getByRole('button', { name: '保存数据到当前消息', exact: true });
 for (let i = 0; i < 200 && (!(await saveButton.count()) || await saveButton.isDisabled()); i++) await pause(100);
 assert.ok(await saveButton.count()); assert.equal(await saveButton.isDisabled(), false, 'upstream save must finish, not leave a stuck spinner');
 await originalUiClick(frame.getByRole('button', { name: '关闭数据库编辑器', exact: true }));
 await originalUiClick(frame.getByRole('button', { name: '打开可视化表格编辑器', exact: true }));
 await originalUiClick(frame.getByRole('button', { name: /^重要角色表/ }));
 await frame.getByText('合成人物·界面保存验证', { exact: true }).waitFor();
 if (artifacts) { await mkdir(artifacts, { recursive: true }); await page.screenshot({ path: join(artifacts, 'database-manager-desktop-synthetic.png') }); }
 await page.setViewportSize({ width: 390, height: 844 });
 const mobileBox=await manager.boundingBox();assert.ok(mobileBox.x>=12&&mobileBox.y>=12&&mobileBox.width<=366&&mobileBox.height<=820,'mobile popup also needs a visible backdrop');
 assert.ok(await manager.evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'mobile management workspace must not overflow');
 const shell = frame.locator('.acu-v2-app__shell');
 assert.ok(await shell.evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'original mobile shell must fit iframe viewport');
 const navigation = frame.getByRole('button', { name: '打开数据库导航', exact: true });
 await navigation.click(); await frame.getByRole('button', { name: /^纪要表/ }).last().waitFor();
 if (artifacts) await page.screenshot({ path: join(artifacts, 'database-manager-mobile-synthetic.png') });
 console.log('SYNTHETIC_UI_STEP','desktop-mobile-editor');
 const oldFrame = page.frames().find(f => f.url().includes('database-plugin-host.html'));
 assert.deepEqual(canonical(await api('/api/database-plugin/native-chat')),initialCanonical,'table edits must not rewrite canonical synthetic story');
 await api('/api/card/switch', 'POST', { card: 'card-b.json' });
 for (let i = 0; i < 100 && !oldFrame.isDetached(); i++) await pause(100);
 assert.equal(oldFrame.isDetached(), true, 'card/source changes must detach the old management frame');
 await frame.locator('.acu-v2-app__shell').waitFor();
 // A failed source load must surface a real error, then recover through the same full-size workspace.
 await page.route('**/api/database-plugin/source/index.js', route => route.abort('blockedbyclient'));
 await manager.getByRole('button', { name: '刷新', exact: true }).click();
 await manager.getByRole('alert').waitFor();
 assert.match(await manager.getByRole('alert').innerText(), /失败/);
 await page.unroute('**/api/database-plugin/source/index.js');
 await manager.getByRole('button', { name: '重新读取／重试', exact: true }).click();
 await frame.locator('.acu-v2-app__shell').waitFor();
 await awaitHostReady(page);
 await manager.getByRole('button', { name: '返回对话', exact: true }).click();
 await manager.waitFor({ state: 'detached' });
 assert.ok(await entry.isVisible(), 'closing management must return to the existing conversation');
 console.log('SYNTHETIC_UI_STEP','retry-missing');
 const mainHistory = canonical(await api('/api/database-plugin/native-chat'));
 await page.getByRole('button', { name: '设置', exact: true }).click();
 await page.getByRole('button', { name: '打开独立数据库管理台', exact: true }).click();
 await manager.waitFor();await awaitHostReady(page);await frame.locator('.acu-v2-app__shell').waitFor();
 console.log('SYNTHETIC_UI_STEP','settings-entry');
 await awaitHostReady(page);
 await manager.getByRole('button', { name: '返回对话', exact: true }).click();
 // Missing installation is actionable, not an empty iframe or a fake ready marker.
 await page.route('**/api/database-plugin/status', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ sourceReady: false, config: { enabled: true } }) }));
 await entry.click();
 await manager.getByText('尚未安装已核验的数据库源码', { exact: true }).waitFor();
 assert.equal(await manager.locator('iframe').count(), 0);
 await manager.getByRole('button', { name: '返回对话', exact: true }).click();
 await page.unroute('**/api/database-plugin/status');
 // Standalone presentation also opens the actual original UI without the React application.
 console.log('SYNTHETIC_UI_STEP','pre-standalone');
 const independent = await browserContext.newPage(); independent.setDefaultTimeout(20000);
 independent.on('pageerror', error => errors.push(error.message));
 await independent.goto(base + '/database-plugin-host.html?view=manager');
 await independent.locator('.acu-v2-app__shell').waitFor();
 await independent.getByRole('button', { name: '关闭新 UI', exact: true }).click();
 await independent.getByRole('button', { name: '打开原插件完整界面', exact: true }).click();
 await independent.locator('.acu-v2-app__shell').waitFor();
 const oldIndependentBinding = await independent.evaluate(() => window.LiyuanDatabasePluginHost.binding());
 assert.deepEqual(canonical(await api('/api/database-plugin/native-chat')),mainHistory);
 await api('/api/card/switch', 'POST', { card: 'card-a.json' });
 await independent.waitForFunction(previous => { const binding=window.LiyuanDatabasePluginHost?.binding();return !!binding&&binding.scopeKey!==previous; }, oldIndependentBinding.scopeKey);
 await independent.locator('.acu-v2-app__shell').waitFor();
 console.log('SYNTHETIC_UI_STEP','standalone-rebound');
 await independent.close();
 assert.deepEqual(canonical(await api('/api/database-plugin/native-chat')), initialCanonical, 'management navigation must never rewrite canonical chat');
 const after = await api('/healthz');
 assert.equal(before.version, version); assert.equal(after.version, version);
 assert.deepEqual(errors, []); assert.deepEqual(forbidden, []);
 console.log(JSON.stringify({ version, prominentEntry: true, settingsEntry: true, originalUiVisible: true, desktop: true, mobile: true, characterRowSaved: true, originalModesAndDataManagement: true, apiModelsLoaded: true, apiPresetCreateSaveReload: true, popupBoundsVerified: true, staleCardDetached: true, sourceFailureRetry: true, missingInstall: true, standaloneUi: true, standaloneScopeRebind: true, canonicalStoryPreserved: true, paidModelCalls: 0 }));
} catch (error) {
 console.log('SYNTHETIC_UI_DIAGNOSTICS',JSON.stringify({forbidden,errors,failedRequests,stateWrites:writes.length,observedBindings:observedBindings.slice(-10),iframes:page&&!page.isClosed()?await page.locator('iframe').evaluateAll(es=>es.map(e=>({src:e.src,inert:e.inert}))).catch(()=>[]):[]}));
 if (artifacts && page) { await mkdir(artifacts, { recursive: true }); await page.screenshot({ path: join(artifacts, 'database-manager-failure-synthetic.png') }).catch(() => {}); }
 throw error;
} finally {
 clearTimeout(watchdog);
 if (releaseSource) releaseSource();
 await browser?.close(); server.kill('SIGTERM');
 await Promise.race([new Promise(resolve => server.once('exit', resolve)), pause(5000)]);
 if (artifacts) await writeFile(join(artifacts, 'database-manager-host-synthetic.log'), logs);
 await new Promise(resolve=>mockGateway.close(resolve));
 await rm(cwd, { recursive: true, force: true });
}
