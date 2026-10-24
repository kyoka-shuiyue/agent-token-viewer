'use strict';
const { app, BrowserWindow, Menu, dialog, session, ipcMain, screen } = require('electron');
const { fork } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

app.setName('Token Viewer');
const smokeReport = process.env.TOKEN_VIEWER_SMOKE_REPORT;
const profile = process.env.TOKEN_VIEWER_TEST_PROFILE || path.join(app.getPath('appData'), 'Token Viewer');
app.setPath('userData', path.resolve(profile));
let window;
let backend;
let origin;
let quitting = false;
let backendReady = false;
let appMenu;
const authToken = randomBytes(32).toString('hex');

function backendPaths() {
  const root = app.isPackaged ? process.resourcesPath : path.resolve(__dirname, '..');
  return {
    node: path.join(root, app.isPackaged ? 'runtime' : 'build/runtime', 'node.exe'),
    script: path.join(root, app.isPackaged ? 'backend/server.js' : 'server.js'),
  };
}

function startBackend() {
  const paths = backendPaths();
  if (!fs.existsSync(paths.node)) throw new Error('缺少内置运行环境，请先运行 npm run prepare:runtime。');
  return new Promise((resolve, reject) => {
    let tail = '';
    backend = fork(paths.script, [], {
      execPath: paths.node,
      env: { ...process.env, TOKEN_VIEWER_PORT: '0', TOKEN_VIEWER_DATA_DIR: app.getPath('userData'), TOKEN_VIEWER_AUTH_TOKEN: authToken },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
    });
    backend.stdout.on('data', () => {});
    backend.stderr.on('data', (chunk) => { tail = (tail + chunk.toString()).slice(-3000); });
    const timeout = setTimeout(() => { backend.kill(); reject(new Error('本地扫描服务启动超时。')); }, 15000);
    backend.once('error', (error) => { clearTimeout(timeout); reject(error); });
    backend.on('message', (message) => {
      if (message?.type !== 'ready' || backendReady) return;
      clearTimeout(timeout);
      backendReady = true;
      origin = `http://127.0.0.1:${message.port}`;
      resolve();
    });
    backend.once('exit', (code) => {
      clearTimeout(timeout);
      if (!backendReady) reject(new Error(`本地扫描服务未能启动（${code}）。\n${tail}`));
      else if (!quitting) {
        dialog.showErrorBox('Token 查看器', '本地扫描服务意外退出，请重新打开软件。');
        app.quit();
      }
    });
  });
}

async function createWindow() {
  const appSession = session.fromPartition('persist:token-viewer');
  // 凭证只附加给本程序的本地 API，不向渲染页暴露 Node 或文件权限。
  appSession.webRequest.onBeforeSendHeaders({urls:[`${origin}/*`]}, (details, callback) => {
    const headers = { ...details.requestHeaders };
    if (new URL(details.url).pathname.startsWith('/api/')) headers['X-Token-Viewer-Auth'] = authToken;
    callback({requestHeaders:headers});
  });
  appSession.setPermissionRequestHandler((contents, permission, callback) => callback(false));
  appSession.setPermissionCheckHandler(() => false);
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  window = new BrowserWindow({
    title: 'Token 查看器', width: Math.min(1600, width), height: Math.min(960, height), minWidth: 390, minHeight: 540,
    titleBarStyle: 'hidden', titleBarOverlay: { color: '#FAF6EF', symbolColor: '#221D18', height: 44 },
    show: false, backgroundColor: '#FAF6EF', icon: path.join(__dirname, 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), session: appSession, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== origin) event.preventDefault();
  });
  window.webContents.on('page-title-updated', (event) => { event.preventDefault(); });
  window.once('ready-to-show', () => { if (!smokeReport) window.show(); });
  window.on('closed', () => { window = null; });
  // 菜单从暖白标题栏按钮弹出，避免 Windows 常驻白色菜单横栏。
  Menu.setApplicationMenu(null);
  appMenu = Menu.buildFromTemplate([
    { label: '文件', submenu: [
      { label: '刷新数据', accelerator: 'CmdOrCtrl+R', click: () => window?.webContents.executeJavaScript('refresh()').catch(() => {}) },
      { type: 'separator' }, { label: '退出', role: 'quit' },
    ] },
    { label: '编辑', submenu: [{label:'撤销',role:'undo'}, {label:'重做',role:'redo'}, {type:'separator'}, {label:'剪切',role:'cut'}, {label:'复制',role:'copy'}, {label:'粘贴',role:'paste'}, {label:'全选',role:'selectAll'}] },
    { label: '视图', submenu: [
      { label:'重新加载界面', role:'reload', accelerator:'CmdOrCtrl+Shift+R' },
      { label:'放大',role:'zoomIn' }, { label:'缩小',role:'zoomOut' }, { label:'重置缩放',role:'resetZoom' },
      {type:'separator'}, {label:'全屏',role:'togglefullscreen'},
    ] },
    { label: '帮助', submenu: [{label:'关于 Token 查看器',click:()=>dialog.showMessageBox(window,{type:'info',title:'Token 查看器',message:`Token 查看器 ${app.getVersion()}`,detail:'本地 Agent 用量统计。原始会话只读，数据不上传。'})}] },
  ]);
  ipcMain.on('token-viewer:menu', (event) => {
    if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) return;
    if (new URL(event.senderFrame.url).origin !== origin) return;
    appMenu.popup({ window, x: 12, y: 42 });
  });
  // 无原生菜单栏时继续提供常用本地快捷键。
  window.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const key = input.key.toLowerCase();
    const ctrl = input.control || input.meta;
    if (ctrl && key === 'r') {
      event.preventDefault();
      if (input.shift) window.webContents.reload();
      else window.webContents.executeJavaScript('refresh()').catch(() => {});
    } else if (ctrl && ['+', '=', '-', '0'].includes(key)) {
      event.preventDefault();
      const level = window.webContents.getZoomLevel();
      window.webContents.setZoomLevel(key === '0' ? 0 : Math.max(-3, Math.min(3, level + (key === '-' ? -.5 : .5))));
    } else if (key === 'f11') {
      event.preventDefault(); window.setFullScreen(!window.isFullScreen());
    }
  });
  await window.loadURL(origin);
}

async function runSmokeTest() {
  const deadline = Date.now() + 180000;
  let status;
  do {
    status = await (await fetch(origin + '/api/status', {headers:{'X-Token-Viewer-Auth':authToken}})).json();
    if (status.phase === 'ready') break;
    if (status.phase === 'error' || Date.now() > deadline) throw new Error('桌面扫描未完成');
    await new Promise((resolve) => setTimeout(resolve, 250));
  } while (true);
  // 只读检查实际渲染结果，完整页面与网页版本共用同一份源码。
  let page;
  do {
    page = await window.webContents.executeJavaScript(`({loaded:document.querySelector('#boot')?.classList.contains('gone'),title:document.title,total:document.querySelector('#heroTotal')?.textContent,cards:document.querySelectorAll('#agents .agent').length,nodeExposed:typeof window.require!=='undefined',animations:!!document.querySelector('.selection-indicator')})`);
    if (page.loaded) break;
    if (Date.now() > deadline) throw new Error('桌面页面未能加载');
    await new Promise((resolve) => setTimeout(resolve, 250));
  } while (true);
  // 验收时实际绘制窗口，避免隐藏窗口截到旧的加载帧。
  window.showInactive();
  const checks = await require('./smoke.cjs')(window, appMenu);
  const unauthorized = await fetch(origin + '/api/data');
  const data = await (await fetch(origin + '/api/data', {headers:{'X-Token-Viewer-Auth':authToken}})).json();
  const sources = Object.values(data.agents).map((a) => ({id:a.id,status:a.status,records:a.records.length,missingTitles:[...new Set(a.records.map(r=>r.s))].filter(s=>!a.sessions[s]?.title).length}));
  const passed = page.loaded && page.cards === 10 && !page.nodeExposed && page.animations && unauthorized.status === 401 && !data.agents.proma && !!data.agents.mirage && sources.every(a=>a.status!=='error');
  const report = {passed,packaged:app.isPackaged,version:app.getVersion(),electron:process.versions.electron,backendPid:backend.pid,page,checks,sources,unauthorizedStatus:unauthorized.status};
  fs.mkdirSync(path.dirname(smokeReport), {recursive:true});
  fs.writeFileSync(smokeReport, JSON.stringify(report,null,2));
  const screenshot = await window.webContents.capturePage();
  fs.writeFileSync(smokeReport.replace(/\.json$/i,'') + '.png', screenshot.toPNG());
  if (passed) window.close();
  else { quitting = true; backend.kill(); app.exit(1); }
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } });
  app.whenReady().then(async () => {
    fs.mkdirSync(app.getPath('userData'), {recursive:true});
    await startBackend();
    await createWindow();
    if (smokeReport) await runSmokeTest();
  }).catch((error) => {
    if (smokeReport) { fs.mkdirSync(path.dirname(smokeReport),{recursive:true}); fs.writeFileSync(smokeReport,JSON.stringify({passed:false,error:error.message})); }
    else dialog.showErrorBox('Token 查看器启动失败', error.message);
    quitting = true;
    backend?.kill();
    app.exit(1);
  });
}
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { quitting = true; backend?.kill(); });
app.on('will-quit', () => { quitting = true; backend?.kill(); });
