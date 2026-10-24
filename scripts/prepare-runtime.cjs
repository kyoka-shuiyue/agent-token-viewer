'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const NODE_VERSION = 'v22.22.3';
const root = path.resolve(__dirname, '..');
const target = path.join(root, 'build/runtime');

async function download(url) {
  const response = await fetch(url, {signal:AbortSignal.timeout(120000)});
  if (!response.ok) throw new Error(`${response.status}: ${url}`);
  return Buffer.from(await response.arrayBuffer());
}
async function main() {
  // Electron 44 在第一次 require 时安装二进制，构建复用已核验的本地版本。
  const electronBinary = require('electron');
  const electronVersion = (await fs.readFile(path.join(path.dirname(electronBinary),'version'),'utf8')).trim();
  const expectedElectron = require('../package.json').devDependencies.electron;
  if (electronVersion !== expectedElectron) throw new Error('Electron 本地版本与锁定版本不一致');
  await fs.mkdir(target, {recursive:true});
  const base = `https://nodejs.org/dist/${NODE_VERSION}/`;
  const [sums, license] = await Promise.all([
    download(base + 'SHASUMS256.txt'),
    download(`https://raw.githubusercontent.com/nodejs/node/${NODE_VERSION}/LICENSE`),
  ]);
  const expected = sums.toString().split('\n').find((line) => line.endsWith('  win-x64/node.exe'))?.split(/\s+/)[0];
  if (!expected) throw new Error('官方校验文件中没有 win-x64/node.exe');
  const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
  let binary = await fs.readFile(path.join(target,'node.exe')).catch(()=>null);
  if (!binary || hash(binary) !== expected) {
    if (process.platform === 'win32' && process.arch === 'x64' && process.version === NODE_VERSION) binary = await fs.readFile(process.execPath);
    if (!binary || hash(binary) !== expected) binary = await download(base + 'win-x64/node.exe');
  }
  if (hash(binary) !== expected) throw new Error('Node.js 官方运行环境 SHA-256 校验失败');
  await fs.writeFile(path.join(target,'node.exe'), binary);
  await fs.writeFile(path.join(target,'LICENSE.node.txt'), license);
  await fs.writeFile(path.join(target,'runtime.json'), JSON.stringify({version:NODE_VERSION,arch:'x64',sha256:expected},null,2));
  console.log(`内置 Node.js ${NODE_VERSION} 已通过官方 SHA-256 校验`);
}
main().catch((error)=>{console.error(error.message);process.exitCode=1;});
