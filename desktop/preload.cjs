'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// 单一、无参数的菜单动作，不暴露通用 IPC、Node 或文件访问。
contextBridge.exposeInMainWorld('tokenViewerDesktop', Object.freeze({
  openMenu: () => ipcRenderer.send('token-viewer:menu'),
}));
