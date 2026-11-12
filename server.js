#!/usr/bin/env node
'use strict';

/**
 * pi-mobile —— 手机 Web 控制台
 *
 *  浏览器 ──WS──> 本进程 ──child_process──> pi --mode rpc
 *
 * 设计要点：
 *  - 每个「设备」一个常驻 pi 子进程（这里设备 = 本机 spawn，未来换 ssh2.exec 即可）
 *  - 手机断线重连：relay 保留缓冲，重连时补发历史 + 当前流式状态
 *  - 严格 LF 分帧（不能用 readline，U+2028/U+2029 是合法 JSON 字符）
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

// pi 的 SessionManager（磁盘会话枚举），用于对话列表。找不到也不致命。
let SessionManager = null;
let PI_PKG = null;
try {
  PI_PKG = process.env.PI_PKG || require('child_process')
    .execSync('npm root -g', { encoding: 'utf8' }).trim() + '/@earendil-works/pi-coding-agent';
  ({ SessionManager } = require(PI_PKG));
} catch {
  try {
    ({ SessionManager } = require('@earendil-works/pi-coding-agent'));
    PI_PKG = '@earendil-works/pi-coding-agent';
  } catch { /* 降级：无会话列表 */ }
}

// ---------- 依赖：ws 可缺省，降级为极简实现 ----------
let WebSocketServer;
try {
  ({ WebSocketServer } = require('ws'));
} catch {
  console.error('缺少依赖 ws，请先 npm install');
  process.exit(1);
}

// ---------------------------------------------------------------- 配置
/** 极简 .env 加载（不覆盖已有环境变量） */
function loadEnvFile(file) {
  try {
    if (!fs.existsSync(file)) return;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (!m) continue;
      const k = m[1];
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (process.env[k] === undefined) process.env[k] = v;
    }
  } catch {}
}

/** 极简 .env 加载 */
loadEnvFile(path.join(__dirname, '.env'));

const CONFIG = {
  port: Number(process.env.PORT || 8848),
  host: process.env.HOST || '0.0.0.0',
  token: process.env.PI_MOBILE_TOKEN || '',
  piBin: process.env.PI_BIN || 'pi',
  sessionDir: process.env.PI_SESSION_DIR || path.join(require('os').homedir(), '.pi/agent/sessions'),
  maxBuffered: 400,
  turnTimeoutMs: 30 * 60 * 1000,
  heartbeatMs: 25 * 1000,
};

const log = (...a) => console.log(new Date().toISOString(), ...a);
const warn = (...a) => console.warn(new Date().toISOString(), ...a);
const toastOk = (send, text) => send({ t: 'notice', text });

// POSIX shell 单引号转义
function shellQuote(s) {
  return "'" + String(s).replace(/'/g, `'"'"'`) + "'";
}

/** PowerShell 单引号转义（内部单引号写两遍） */
function psQuote(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

/** 设备是否为 Windows（决定用哪个 shell 执行远程命令） */
function isWin(dev) {
  return dev && (dev.platform === 'win32' || dev.platform === 'windows' || dev.shell === 'powershell');
}

/**
 * 生成远端命令前缀：处理提权 + PATH。
 *
 * 提权模式：
 *   ''        → 不堤权
 *   'sudo'    → sudo -n（免密）
 *   'root'    → sudo -n -H -u root（切 HOME 到 /root）
 *
 * 直接用 bash -lc 以加载 root 的登录环境，比手拼 PATH 可靠。
 */
function buildRemotePrefix(dev) {
  const extra = [];
  if (dev.pathPrefix) extra.push(shellQuote(dev.pathPrefix));
  // pi 的 launcher 默认装在 ~/.pi/agent/bin，但 .bashrc 里的 PATH 在非交互 shell 不生效
  extra.push('"$HOME/.pi/agent/bin"');
  extra.push('"$HOME/.local/share/pi-node/current/bin"');
  return `export PATH=${extra.join(':')}:$PATH; `;
}

/** 把一条命令包装成「可能需要 sudo + 登录 shell」的形式 */
function wrapRemoteCmd(dev, inner) {
  const escalate = dev.escalate === true || dev.escalate === 'sudo' || dev.escalate === 'root';
  const prefix = buildRemotePrefix(dev);
  const full = prefix + inner;
  if (!escalate) return `bash -lc ${shellQuote(full)}`;
  // sudo -n：无密码才继续；-H 让 HOME=/root；-i 加载登录环境
  return `sudo -n -H bash -lc ${shellQuote(full)}`;
}

/**
 * 包装成 PowerShell 命令（Windows 设备）。
 * Windows OpenSSH 的默认 shell 通常是 cmd.exe，所以显式调用 powershell。
 * 不加 -ExecutionPolicy Bypass 的话，某些机器上脚本会被策略拦截。
 */
function wrapWinCmd(dev, inner) {
  const prelude = "$ProgressPreference='SilentlyContinue';[Console]::OutputEncoding=[Text.Encoding]::UTF8;";
  const b64 = Buffer.from(prelude + inner, 'utf16le').toString('base64');
  // 不再前置 chcp（那会多起一个 cmd 进程，且每条命令都弹一次控制台）
  // -OutputFormat Text 去掉 CLIXML 噪音
  return `powershell -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -OutputFormat Text -EncodedCommand ${b64}`;
}

/**
 * Windows：直接用 node 执行内联脚本，不经过 cmd / powershell。
 *
 * 为什么不用 wrapWinCmd：
 *   sshd 每执行一条命令都会为 shell 创建控制台，cmd/powershell 会闪窗。
 *   直接调 node.exe（控制台程序，但 sshd 用隐藏控制台）不会弹窗。
 */
function winNodeExec(dev, script, timeoutMs = 30000) {
  const nb = dev.pathPrefix || dev.nodeBin || '';
  const nodeExe = nb ? (nb.replace(/[\\/]+$/, '') + '\\node.exe') : 'node.exe';
  const b64 = Buffer.from(String(script), 'utf8').toString('base64');
  return sshExec(dev, winExecCmd(nodeExe, b64), timeoutMs);
}

/**
 * Windows 命令包装：cmd /c "..." 包裹。
 * sshd 把 exec 命令交给 cmd 解析，多层引号需要显式 cmd /c 才不出错。
 */
function winExecCmd(nodeExe, b64, extraArgs = []) {
  // 不经过 cmd / powershell：sshd 直接执行 node.exe（无控制台窗口）。
  // 参数各自加引号；末尾反斜杠要去掉，否则会转义收尾引号。
  const args = [
    `"${nodeExe}"`,
    '-e',
    '"eval(Buffer.from(process.argv[1],\'base64\').toString())"',
    `"${b64}"`,
    ...extraArgs.map(a => `"${String(a).replace(/"/g, '\\"').replace(/\\+$/, '')}"`),
  ];
  return args.join(' ');
}

/** 统一入口：按设备平台选择包装方式 */
function wrapCmd(dev, inner) {
  return isWin(dev) ? wrapWinCmd(dev, inner) : wrapRemoteCmd(dev, inner);
}

// ---------------------------------------------------------------- 设备池
/**
 * 设备定义。本机即 'local'。
 * 对端可替换为：{ type:'ssh', host, user, keyPath, remoteCmd }
 */
// 设备列表：内置本机 + 配置文件/环境变量追加
// 配置文件：devices.json（可放多台 SSH 设备）
const DEVICES = [
  { id: 'local', label: '本机', type: 'local', cwd: process.env.PI_CWD || process.cwd() },
];

function normalizeDevice(d, idx) {
  const dev = { ...d };
  dev.id = dev.id || (dev.host ? `ssh-${dev.host}` : `dev${idx}`);
  dev.type = dev.type || (dev.host ? 'ssh' : 'local');
  dev.label = dev.label || dev.id;
  if (dev.type === 'ssh') {
    if (!dev.host) throw new Error(`设备 ${dev.id} 缺少 host`);
    if (dev.privateKeyPath && !dev.privateKey) dev.privateKeyPath = dev.privateKeyPath.replace(/^~/, require('os').homedir());
  }
  return dev;
}

function loadDevices() {
  // 1) devices.json
  const cfgPath = process.env.PI_DEVICES_FILE || path.join(__dirname, 'devices.json');
  if (fs.existsSync(cfgPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      const list = Array.isArray(raw) ? raw : (raw.devices || []);
      for (const d of list) {
        try { DEVICES.push(normalizeDevice(d, DEVICES.length)); }
        catch (e) { warn('设备配置无效:', e.message); }
      }
      log(`已加载 devices.json（${list.length} 台）`);
    } catch (e) { warn('devices.json 解析失败:', e.message); }
  }
  // 2) 环境变量（兼容旧方式）
  if (process.env.PI_EXTRA_DEVICES) {
    try {
      for (const d of JSON.parse(process.env.PI_EXTRA_DEVICES)) {
        try { DEVICES.push(normalizeDevice(d, DEVICES.length)); }
        catch (e) { warn('PI_EXTRA_DEVICES 设备无效:', e.message); }
      }
    } catch (e) { warn('PI_EXTRA_DEVICES 解析失败', e.message); }
  }
  // 去重：后加载的覆盖先加载的（配置文件 > 内置默认）
  const byId = new Map();
  for (const d of DEVICES) byId.set(d.id, d); // 静默覆盖：内置 local 被配置覆盖是正常的
  DEVICES.length = 0;
  DEVICES.push(...byId.values());
}
loadDevices();

// ---------------------------------------------------------------- 设备管理（运行时可写）
const DEVICES_FILE = process.env.PI_DEVICES_FILE || path.join(__dirname, 'devices.json');

/** 把当前 DEVICES（除去内置 local 的默认值）写回文件 */
function saveDevices() {
  const out = DEVICES.map(d => {
    const o = {
      id: d.id, label: d.label, type: d.type,
    };
    if (d.type === 'local') {
      if (d.cwd) o.cwd = d.cwd;
    } else {
      o.host = d.host;
      if (d.port && d.port !== 22) o.port = d.port;
      if (d.username) o.username = d.username;
      if (d.privateKeyPath) o.privateKeyPath = d.privateKeyPath;
      if (d.password) o.password = d.password;
      if (d.escalate) o.escalate = true;
      if (d.cwd) o.cwd = d.cwd;
      if (d.sessionDir) o.sessionDir = d.sessionDir;
      if (d.pathPrefix) o.pathPrefix = d.pathPrefix;
      if (d.helperPath) o.helperPath = d.helperPath;
      if (d.piBin && d.piBin !== 'pi') o.piBin = d.piBin;
      if (d.platform) o.platform = d.platform;
    }
    return o;
  });
  fs.writeFileSync(DEVICES_FILE, JSON.stringify(out, null, 2) + '\n', 'utf8');
  log(`设备配置已写入 ${DEVICES_FILE}（${out.length} 台）`);
}

function publicDevice(d) {
  return {
    id: d.id, label: d.label, type: d.type,
    host: d.host, port: d.port, username: d.username,
    cwd: d.cwd, sessionDir: d.sessionDir, pathPrefix: d.pathPrefix,
    escalate: !!d.escalate,
    hasKey: !!(d.privateKey || d.privateKeyPath),
    hasPassword: !!d.password,
    platform: d.platform || '',
  };
}

/** 新增/修改设备 */
function upsertDevice(input) {
  const d = { ...input };
  d.type = d.type || (d.host ? 'ssh' : 'local');
  d.id = (d.id || '').trim() || (d.host ? `ssh-${d.host.replace(/[^a-zA-Z0-9.-]/g, '-')}` : `dev${DEVICES.length}`);
  if (!d.label) d.label = d.host || d.id;
  if (d.type === 'ssh') {
    if (!d.host) throw new Error('SSH 设备必须填 host');
    d.port = Number(d.port) || 22;
    d.username = d.username || 'root';
    d.escalate = d.escalate === true || d.escalate === 'true' || d.escalate === 1;

    // 粘贴的私钥：写入 ~/.pi-mobile/keys/<id>.pem，权限 600
    if (d.privateKeyText) {
      const text = String(d.privateKeyText).trim();
      if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) {
        throw new Error('私钥格式不对（应以 -----BEGIN ... PRIVATE KEY----- 开头）');
      }
      const dir = path.join(require('os').homedir(), '.pi-mobile', 'keys');
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const keyFile = path.join(dir, d.id.replace(/[^a-zA-Z0-9._-]/g, '_') + '.pem');
      fs.writeFileSync(keyFile, text.endsWith('\n') ? text : text + '\n', { mode: 0o600 });
      d.privateKeyPath = keyFile;
    }
    delete d.privateKeyText;

    if (d.privateKeyPath) d.privateKeyPath = d.privateKeyPath.replace(/^~(?=\/)/, require('os').homedir());
    if (d.authMethod === 'password') d.privateKeyPath = '';
    else if (d.authMethod === 'key') d.password = '';
    delete d.authMethod;
  }

  const idx = DEVICES.findIndex(x => x.id === d.id);
  if (idx >= 0) {
    if (DEVICES[idx].type === 'local' && d.type !== 'local') throw new Error('不能修改内置本机设备的类型');
    if (d.type === 'ssh' && !d.privateKeyPath && !d.password) {
      if (DEVICES[idx].privateKeyPath) d.privateKeyPath = DEVICES[idx].privateKeyPath;
      else if (DEVICES[idx].password) d.password = DEVICES[idx].password;
    }
    DEVICES[idx] = { ...DEVICES[idx], ...d };
  } else {
    if (DEVICES.length >= 20) throw new Error('设备数量上限 20');
    DEVICES.push(d);
  }
  saveDevices();
  return publicDevice(DEVICES.find(x => x.id === d.id));
}

/** 保存前自动探测并补齐路径字段 */
async function upsertDeviceAuto(input) {
  const d = { ...input };
  if ((d.type === 'ssh' || d.host) && d.autoProbe !== false) {
    try {
      const probe = await probeDevice({
        ...d,
        port: Number(d.port) || 22,
        username: d.username || 'root',
        escalate: d.escalate === true || d.escalate === 'true' || d.escalate === 1,
        privateKeyPath: d.privateKeyPath?.replace(/^~(?=\/)/, require('os').homedir()),
      });
      if (!d.cwd) d.cwd = probe.cwd;
      if (!d.sessionDir) d.sessionDir = probe.sessionDir;
      if (!d.pathPrefix) d.pathPrefix = probe.nodeBin;
      d._probe = probe;
    } catch (e) {
      warn('自动探测失败，使用默认值:', e.message);
      d._probeError = e.message;
    }
  }
  delete d._probe;
  delete d._probeError;
  delete d.autoProbe;
  return upsertDevice(d);
}

/** 删除设备 */
function removeDevice(id) {
  const idx = DEVICES.findIndex(x => x.id === id);
  if (idx < 0) throw new Error('设备不存在');
  if (DEVICES[idx].type === 'local' && DEVICES.filter(d => d.type === 'local').length === 1) {
    throw new Error('不能删除唯一的本机设备');
  }
  const s = sessions.get(id);
  if (s) { s.stop(); sessions.delete(id); }
  DEVICES.splice(idx, 1);
  saveDevices();
}

/**
 * Windows 探测：输出同样的 __TAG__ 行，供 probeDevice 统一解析。
 * 用 PowerShell 而不是 cmd，便于拿环境变量和路径。
 */
function winProbeScript() {
  return `
$ErrorActionPreference = 'SilentlyContinue'
Write-Output "__PLATFORM__win32"
Write-Output ("__HOME__" + $env:USERPROFILE)
Write-Output ("__WHOAMI__" + $env:USERNAME)
$node = (Get-Command node -ErrorAction SilentlyContinue)
if ($node) {
  Write-Output ("__NODE__" + $node.Source)
  Write-Output ("__NODEV__" + (& node -v))
}
$pi = (Get-Command pi -ErrorAction SilentlyContinue)
if ($pi) {
  Write-Output ("__PI__" + $pi.Source)
  $pv = (& pi --version 2>$null | Select-Object -First 1)
  Write-Output ("__PIVER__" + $pv)
}
if (Test-Path (Join-Path $env:USERPROFILE ".pi")) { Write-Output "__PIHOME__yes" }
$sess = Join-Path $env:USERPROFILE ".pi\\agent\\sessions"
if (Test-Path $sess) {
  Write-Output ("__SESSDIR__" + $sess)
  Write-Output "__SESSREADABLE__yes"
}
# pi 可能的安装位置（npm 全局 / 官方安装器）
$cands = @(
  (Join-Path $env:APPDATA "npm"),
  (Join-Path $env:LOCALAPPDATA "pnpm"),
  (Join-Path $env:USERPROFILE ".bun\\bin"),
  (Join-Path $env:USERPROFILE ".pi\\agent\\bin")
)
foreach ($c in $cands) {
  if (Test-Path (Join-Path $c "node.exe")) { Write-Output ("__CAND__" + $c) }
  elseif (Test-Path (Join-Path $c "pi.cmd")) { Write-Output ("__CAND__" + $c) }
}
`;
}

/** 自动探测远端环境：node 目录 / pi 包位置 / 家目录 / 会话目录 */
async function probeDevice(d) {
  // 未知平台时先探一次：POSIX 命令失败则改走 Windows 探测
  if (!d.platform) {
    try {
      const t = await sshExec(d, 'uname -s 2>/dev/null || echo WINDOWS', 12000);
      const out = String(t.stdout || '').trim();
      // MINGW/MSYS/CYGWIN 自带 bash，走 POSIX 分支即可
      const hasBash = /MINGW|MSYS|CYGWIN/i.test(out);
      const isWinOs = !hasBash && /WINDOWS|^MINGW|^MSYS/i.test(out);
      d.platform = isWinOs ? 'win32' : 'posix';
    } catch {
      d.platform = 'posix';
    }
  }

  if (isWin(d)) return await probeDeviceWin(d);

  const probe = [
    'echo "__HOME__$HOME"',
    'echo "__WHOAMI__$(whoami)"',
    'echo "__NODE__$(command -v node 2>/dev/null)"',
    'echo "__NODEV__$(node -v 2>/dev/null)"',
    // node 候选：nvm / fnm / pi 自带 node / 系统
    'for p in "$HOME"/.nvm/versions/node/*/bin "$HOME"/.fnm/aliases/*/bin "$HOME"/.local/share/fnm/node-versions/*/installation/bin "$HOME"/.local/share/pi-node/current/bin "$HOME"/.local/share/pi-node/*/bin /usr/local/bin /usr/bin; do [ -x "$p/node" ] && echo "__CAND__$p"; done',
    'echo "__PI__$(command -v pi 2>/dev/null)"',
    'echo "__PIVER__$(command -v pi >/dev/null 2>&1 && pi --version 2>/dev/null | head -1 || echo NO)"',
    'echo "__PIHOME__$([ -d "$HOME/.pi" ] && echo yes || echo no)"',
    'ls -d "$HOME"/.pi/agent/sessions 2>/dev/null | head -1 | sed "s/^/__SESSDIR__/"',
    // 会话目录可读性（不需要任何 helper 脚本）
    'D="$HOME/.pi/agent/sessions"; [ -d "$D" ] && echo "__SESSREADABLE__$([ -r "$D" ] && echo yes || echo no)" || true',
  ].join('; ');

  const cmd = wrapRemoteCmd(d, probe);
  const r = await sshExec(d, cmd, 30000);
  const lines = r.stdout.split('\n').map(x => x.trim());
  const pick = (tag) => {
    const l = lines.find(x => x.startsWith(tag));
    return l ? l.slice(tag.length).trim() : '';
  };
  const home = pick('__HOME__');
  const whoami = pick('__WHOAMI__');
  let nodeVer = pick('__NODEV__');
  let nodePath = pick('__NODE__');
  let nodeBin = '';

  const cands = lines.filter(x => x.startsWith('__CAND__')).map(x => x.slice(8));
  const verOk = (v) => { const m = Number((String(v).match(/v(\\d+)/) || [])[1]); return m >= 20; };
  const piVer = pick('__PIVER__');
  const piWorks = !!(piVer && piVer !== 'NO');

  if (!nodePath || !verOk(nodeVer)) {
    // 从候选里挑版本最高的
    const scored = cands.map(p => {
      const m = p.match(/\/node\/(v?\d+\.\d+\.\d+)\//) || p.match(/node-versions\/(v?\d+\.\d+\.\d+)/) || p.match(/pi-node\/(v?\d+\.\d+\.\d+)/);
      return { p, v: m ? m[1].replace(/^v/, '') : '' };
    }).filter(x => x.v).sort((a, b) => {
      const pa = a.v.split('.').map(Number), pb = b.v.split('.').map(Number);
      return (pb[0] - pa[0]) || (pb[1] - pa[1]) || (pb[2] - pa[2]);
    });
    for (const c of scored) {
      if (Number(c.v.split('.')[0]) >= 20) { nodeBin = c.p; nodeVer = 'v' + c.v; break; }
    }
  } else {
    const dir = nodePath.replace(/\/node$/, '');
    if (!/^\/usr\/(local\/)?bin$/.test(dir) && !/^\/bin$/.test(dir)) nodeBin = dir;
  }

  let sessionDir = pick('__SESSDIR__');
  if (!sessionDir && home) sessionDir = home + '/.pi/agent/sessions';

  // 不再依赖任何远端脚本：会话列表/读取都用 shell 直接操作 JSONL
  const sessReadable = pick('__SESSREADABLE__') === 'yes';

  return {
    home,
    whoami,
    nodeBin,
    nodeVer,
    piVer: piWorks ? piVer : '',
    piWorks,
    piPath: pick('__PI__'),
    hasPiHome: pick('__PIHOME__') === 'yes',
    sessionReadable: sessReadable,
    sessionDir,
    cwd: home || '/root',
  };
}

/** 测试设备连通性（不启动 pi） */
async function testDevice(d) {
  if (d.type !== 'ssh') return { ok: true, message: '本机' };
  const steps = [];
  const esc = d.escalate === true || d.escalate === 'sudo' || d.escalate === 'root';
  try {
    // 1) 基础连接（Windows 用 PowerShell，POSIX 用 bash）
    if (isWin(d)) {
      const winChk = await sshExec(d, wrapWinCmd(d,
        '[Console]::OutputEncoding=[Text.Encoding]::UTF8;Write-Output "__ok__";Write-Output $env:COMPUTERNAME;Write-Output $env:USERNAME'), 20000);
      if (!winChk.stdout.includes('__ok__')) throw new Error('shell 无响应：' + String(winChk.stderr || '').slice(0, 150));
      const wl = String(winChk.stdout).split('\n').map(x => x.trim().replace(/\r$/, '')).filter(Boolean);
      steps.push('SSH 连接成功（用户 ' + (wl[2] || d.username || '?') + '）');
      if (wl[1]) steps.push('主机名 ' + wl[1]);
      steps.push('系统 Windows');
    } else {
      const r = await sshExec(d, 'echo __ok__; uname -n 2>/dev/null; whoami', 20000);
      if (!r.stdout.includes('__ok__')) throw new Error('shell 无响应');
      const lines = r.stdout.split('\n').map(x => x.trim()).filter(Boolean);
      steps.push('SSH 连接成功（用户 ' + (lines[2] || d.username || '?') + '）');
      const hostname = lines.find(x => x !== '__ok__' && !x.startsWith('/') && !x.match(/^v\d/) && x !== lines[2]);
      if (hostname) steps.push('主机名 ' + hostname);
    }

    // 2) 提权检查（Windows 无 sudo，跳过）
    if (esc && !isWin(d)) {
      const sudoChk = await sshExec(d, 'sudo -n true 2>&1 && echo SUDO_OK || echo SUDO_FAIL', 15000);
      if (!sudoChk.stdout.includes('SUDO_OK')) {
        return {
          ok: false,
          message: '无法提权到 root（sudo 需要密码）',
          steps: [...steps, '❌ sudo -n 失败，请在目标机配置免密 sudo，或改用 root 用户登录'],
        };
      }
      steps.push('sudo 免密可用（提权到 root）');
    }

    // 3) 环境探测
    const probe = await probeDevice(d);

    // pi 自带 launcher（会自己找 node），所以 node 不是硬性前提
    if (!probe.piWorks) {
      if (!probe.nodeVer) {
        return {
          ok: false,
          message: '找不到 pi，也找不到 node',
          steps: [...steps, '❌ node 未安装', '提示：若 pi 装在 root 下，勾选「提权到 root」'].filter(Boolean),
          checks: [
            { name: 'SSH 连通', ok: true, detail: (d.username || '?') + '@' + d.host + ':' + (d.port || 22) },
            { name: 'node', ok: false, detail: '未安装' },
            { name: 'pi', ok: false, detail: '未安装' },
          ],
        };
      }
      const major = Number((probe.nodeVer.match(/v(\d+)/) || [])[1]);
      if (major && major < 20) {
        return { ok: false, message: `node 版本过低（${probe.nodeVer}，需要 ≥ 20）`, steps: [...steps, '❌ 请在设备配置里指定 pathPrefix'] };
      }
      return {
        ok: false,
        message: '找不到 pi 命令',
        steps: [...steps, `node ${probe.nodeVer}`, '❌ pi 未安装', esc ? '' : '提示：若 pi 装在 root 下，勾选「提权到 root」'].filter(Boolean),
        checks: [
          { name: 'SSH 连通', ok: true, detail: (d.username || '?') + '@' + d.host + ':' + (d.port || 22) },
          { name: 'node', ok: true, detail: probe.nodeVer || '' },
          { name: 'pi', ok: false, detail: '未安装' },
        ],
      };
    }
    steps.push(`pi ${probe.piVer}${probe.piPath ? '（' + probe.piPath + '）' : ''}`);
    if (probe.nodeVer) {
      steps.push(`node ${probe.nodeVer}${probe.nodeBin ? '（' + probe.nodeBin + '）' : ''}`);
    } else {
      steps.push('node 由 pi 自带 launcher 提供');
    }

    // 4.5) Windows：验证 pi RPC 能否启动（有窗口问题会在这里暴露）
    if (isWin(d)) {
      const launcher = probe.piLauncherPath;
      const pnb = probe.nodeBin || probe.pathPrefix;
      const nodeExe = pnb ? (pnb.replace(/[\\/]+$/, '') + '\\node.exe') : 'node.exe';
      if (launcher) {
        const testScript = [
          `$psi = New-Object System.Diagnostics.ProcessStartInfo`,
          `$psi.FileName = ${psQuote(nodeExe)}`,
          `$psi.Arguments = '${launcher.replace(/'/g, "''")} --version'`,
          `$psi.RedirectStandardOutput = $true`,
          `$psi.RedirectStandardError = $true`,
          `$psi.UseShellExecute = $false`,
          `$psi.CreateNoWindow = $true`,
          `$p = [System.Diagnostics.Process]::Start($psi)`,
          `$out = $p.StandardOutput.ReadToEnd()`,
          `$p.WaitForExit(8000) | Out-Null`,
          `Write-Output ("__RPC__" + $out.Trim())`,
        ].join('; ');
        const rr = await sshExec(d, wrapWinCmd(d, testScript), 25000);
        const m = String(rr.stdout || '').match(/__RPC__(.*)/);
        if (m && m[1].trim()) steps.push('pi launcher 可执行：' + m[1].trim().slice(0, 40));
        else steps.push('⚠️ pi launcher 未返回版本，启动可能有问题');
      }
    }

    // 5) 会话目录（不需要 helper，shell 直接读）
    if (probe.sessionReadable) {
      steps.push('会话目录可读');
    } else {
      steps.push('⚠️ 会话目录不可读或不存在（历史对话列表将为空）');
    }
    steps.push(`工作目录 ${probe.cwd}`);
    steps.push(`会话目录 ${probe.sessionDir}`);
    return {
      ok: true,
      message: '全部就绪',
      steps,
      probe,
      checks: [
        { name: 'SSH 连通', ok: true, detail: (d.username || '?') + '@' + d.host + ':' + (d.port || 22) },
        { name: 'node', ok: !!probe.nodeVer || probe.piWorks, detail: probe.nodeVer || '由 pi launcher 提供' },
        { name: 'pi', ok: probe.piWorks, detail: probe.piVer + (probe.piPath ? ' · ' + probe.piPath : '') },
        { name: '会话目录', ok: !!probe.sessionReadable, detail: probe.sessionDir || '' },
      ],
    };
  } catch (e) {
    return { ok: false, message: e.message, steps: [...steps, '❌ ' + e.message] };
  }
}

const sessions = new Map(); // deviceId -> PiSession

// ---------------------------------------------------------------- 远程执行
/** 在设备上跑一条命令，收集 stdout（一次性，不复用连接池的 pi 通道） */
async function sshExec(dev, cmd, timeoutMs = 30000) {
  const { Client } = require('ssh2');
  const fs = require('fs');
  const path = require('path');
  const os = require('os');

  const opts = {
    host: dev.host, port: dev.port || 22, username: dev.username || 'root',
    readyTimeout: dev.readyTimeoutMs || 20000,
  };
  if (dev.privateKey) opts.privateKey = fs.readFileSync(dev.privateKey);
  else if (dev.privateKeyPath) opts.privateKey = fs.readFileSync(dev.privateKeyPath);
  else if (dev.password) opts.password = dev.password;
  else for (const f of ['id_ed25519', 'id_rsa']) {
    const p = path.join(os.homedir(), '.ssh', f);
    if (fs.existsSync(p)) { opts.privateKey = fs.readFileSync(p); break; }
  }

  return new Promise((resolve, reject) => {
    const conn = new Client();
    const timer = setTimeout(() => { try { conn.end(); } catch {} reject(new Error('ssh 超时')); }, timeoutMs);
    let done = false;
    const finish = (fn, v) => { if (done) return; done = true; clearTimeout(timer); try { conn.end(); } catch {} fn(v); };

    conn.on('ready', () => {
      conn.exec(cmd, (err, stream) => {
        if (err) return finish(reject, err);
        let out = '', errOut = '';
        stream.setEncoding('utf8');
        stream.on('data', d => { out += d; });
        stream.stderr.setEncoding('utf8');
        stream.stderr.on('data', d => { errOut += d; });
        stream.on('close', (code) => {
          if (code !== 0 && !out.trim()) return finish(reject, new Error(`exit ${code}: ${errOut.slice(0, 300)}`));
          finish(resolve, { stdout: out, stderr: errOut, code });
        });
      });
    }).once('error', e => finish(reject, e)).connect(opts);
  });
}

/**
 * 远端会话操作：通过 SSH 执行一段【内联 node 脚本】，不落地任何文件。
 *
 * 为什么不用纯 shell 直接改 JSONL：
 *   - session_info / compaction / 分支结构的格式是 pi 的内部约定，
 *     自己拼字符串写文件，格式一变就写坏
 *   - 删除绕过 pi 的逻辑，可能留下悬空引用
 *   - 读消息时不会应用 compaction，展示的和 pi 里看到的不一致
 *
 * 所以这里调用 pi 自带的 SessionManager（只读 + 它自己的写入 API），
 * 脚本经 `node -e '<script>'` 传入，目标机磁盘上不新增任何文件。
 */
function remoteNodeScript(dev, script, timeoutMs = 30000) {
  if (isWin(dev)) {
    // Windows：脚本经 base64 传输，避免任何引号/换行转义问题
    const b64 = Buffer.from(script, 'utf8').toString('base64');
    const nodeCmd = dev.nodeBin
      ? `& ${psQuote(dev.nodeBin + '\\node.exe')}`
      : 'node';
    const inner = [
      `$b64 = ${psQuote(b64)}`,
      `$bytes = [Convert]::FromBase64String($b64)`,
      `$code = [Text.Encoding]::UTF8.GetString($bytes)`,
      `$code | ${nodeCmd} -`,
    ].join('\n');
    return sshExec(dev, wrapWinCmd(dev, inner), timeoutMs);
  }
  const nodeBin = dev.nodeBin ? shellQuote(dev.nodeBin + '/node') : 'node';
  // 单引号包裹，内部单引号用 '\'' 转义
  const quoted = "'" + String(script).replace(/'/g, "'\\''") + "'";
  const inner = `exec ${nodeBin} -e ${quoted}`;
  return sshExec(dev, wrapRemoteCmd(dev, inner), timeoutMs);
}

/** 生成「定位 pi 包」的前置代码（远端执行） */
function piResolverPrelude() {
  return `
const fs=require('fs'),path=require('path'),os=require('os'),cp=require('child_process');
function loadPi(){
  const c=[];
  if(process.env.PI_PKG)c.push(process.env.PI_PKG);
  c.push('@earendil-works/pi-coding-agent');
  const home=os.homedir();
  const root=process.env.PI_MANAGED_INSTALL_ROOT||path.join(home,'.pi/agent/install');
  try{
    const cur=path.join(root,'current-version');
    let v=process.env.PI_VERSION||'';
    if(!v&&fs.existsSync(cur))v=fs.readFileSync(cur,'utf8').trim();
    if(v)c.push(path.join(root,'releases',v,'node_modules/@earendil-works/pi-coding-agent'));
    const rd=path.join(root,'releases');
    if(fs.existsSync(rd)){
      for(const x of fs.readdirSync(rd).filter(x=>/^\\d/.test(x)).sort().reverse().slice(0,5))
        c.push(path.join(rd,x,'node_modules/@earendil-works/pi-coding-agent'));
    }
  }catch{}
  try{const r=cp.execSync('npm root -g',{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();
      c.push(path.join(r,'@earendil-works/pi-coding-agent'));}catch{}
  for(const p of c){try{return require(p)}catch{}}
  throw new Error('找不到 @earendil-works/pi-coding-agent');
}
`;
}

async function remoteSessionOp(dev, op, arg1, arg2, timeoutMs = 30000) {
  const keep = [];
  if (dev.sessionDir) keep.push(`if(!process.env.PI_SESSION_DIR)process.env.PI_SESSION_DIR=${JSON.stringify(dev.sessionDir)};`);

  let body;
  if (op === 'list') {
    body = `
(async()=>{
  const pi=loadPi(); const SM=pi.SessionManager;
  if(!SM) throw new Error('SessionManager 不可用');
  const all=await SM.listAll();
  const byPath=new Map(); for(const s of all) byPath.set(s.path,s.id);
  const out=all.map(s=>({
    path:s.path, id:s.id, cwd:s.cwd||'', name:s.name||'',
    created:String(s.created), modified:String(s.modified),
    messageCount:s.messageCount||0,
    firstMessage:(s.firstMessage||'').slice(0,200),
    parentSessionId:s.parentSessionPath?byPath.get(s.parentSessionPath):undefined,
  }));
  process.stdout.write(JSON.stringify({ok:true,data:out}));
})().catch(e=>process.stdout.write(JSON.stringify({ok:false,error:e.message})));`;
  } else if (op === 'read') {
    body = `
(async()=>{
  const pi=loadPi(); const SM=pi.SessionManager;
  const sm=SM.open(${JSON.stringify(arg1 || '')});
  const entries=sm.getEntries(); const leafId=sm.getLeafId();
  let messages=[];
  if(typeof pi.buildSessionContext==='function'){
    const ctx=pi.buildSessionContext(entries,leafId,null);
    messages=(ctx.messages||[]).map(m=>m.role==='compactionSummary'
      ?{role:'system',content:[{type:'text',text:'（历史已压缩）'}],timestamp:m.timestamp}:m);
  } else {
    messages=entries.filter(e=>e.type==='message'&&e.message).map(e=>e.message);
  }
  process.stdout.write(JSON.stringify({ok:true,data:messages}));
})().catch(e=>process.stdout.write(JSON.stringify({ok:false,error:e.message})));`;
  } else if (op === 'rename') {
    body = `
(async()=>{
  const pi=loadPi(); const SM=pi.SessionManager;
  const sm=SM.open(${JSON.stringify(arg1 || '')});
  sm.appendSessionInfo(String(${JSON.stringify(arg2 || '')}).trim());
  process.stdout.write(JSON.stringify({ok:true,data:{ok:true}}));
})().catch(e=>process.stdout.write(JSON.stringify({ok:false,error:e.message})));`;
  } else if (op === 'delete') {
    body = `
(async()=>{
  const fs=require('fs');
  fs.unlinkSync(${JSON.stringify(arg1 || '')});
  process.stdout.write(JSON.stringify({ok:true,data:{ok:true}}));
})().catch(e=>process.stdout.write(JSON.stringify({ok:false,error:e.message})));`;
  } else {
    throw new Error('未知操作: ' + op);
  }

  const script = piResolverPrelude() + keep.join('') + body;
  const r = await remoteNodeScript(dev, script, timeoutMs);
  const line = r.stdout.trim().split('\n').filter(Boolean).pop();
  if (!line) throw new Error('远端无输出' + (r.stderr ? ': ' + r.stderr.slice(0, 200) : ''));
  let j;
  try { j = JSON.parse(line); } catch { throw new Error('远端输出非 JSON: ' + line.slice(0, 200)); }
  if (!j.ok) throw new Error(j.error || '远端执行失败');
  return j.data;
}


/** Windows 设备探测 */
async function probeDeviceWin(d) {
  const cmd = wrapWinCmd(d, winProbeScript());
  const r = await sshExec(d, cmd, 30000);
  const lines = String(r.stdout || '').split('\n').map(x => x.trim());
  const pick = (tag) => {
    const l = lines.find(x => x.startsWith(tag));
    return l ? l.slice(tag.length).trim() : '';
  };

  const home = pick('__HOME__') || 'C:\\Users\\' + (d.username || '');
  const whoami = pick('__WHOAMI__');
  const nodePath = pick('__NODE__');
  const nodeVer = pick('__NODEV__');
  const piPath = pick('__PI__');
  let piVer = pick('__PIVER__');
  const piWorks = !!(piVer && piVer !== 'NO');
  if (!piVer) piVer = '';

  // pi.cmd 所在目录加入 PATH 前缀（Windows 用 ; 分隔）
  const cands = lines.filter(x => x.startsWith('__CAND__')).map(x => x.slice(8));
  let nodeBin = '';
  if (nodePath) {
    const dir = nodePath.replace(/[\\/]node(\.exe)?$/i, '');
    if (dir && !/\\Windows\\System32/i.test(dir)) nodeBin = dir;
  }
  if (!nodeBin && cands.length) nodeBin = cands[0];

  const sessDir = pick('__SESSDIR__') ||
    (home + '\\.pi\\agent\\sessions');

  // pi-launcher.js 优先（避免 pi.cmd 弹窗）
  let piLauncherPath = '';
  if (piPath) {
    const dir = piPath.replace(/[\\/][^\\/]+$/i, '');
    piLauncherPath = dir + '\\pi-launcher.js';
  }
  const sessReadable = pick('__SESSREADABLE__') === 'yes';
  const hasPiHome = pick('__PIHOME__') === 'yes';

  return {
    home,
    whoami,
    nodeBin,
    nodeVer: nodeVer || '',
    piVer,
    piWorks,
    piPath,
    hasPiHome,
    platform: 'win32',
    sessionDir: sessDir,
    sessionReadable: sessReadable,
    cwd: home,
    piLauncherPath,
    helperPath: '',
  };
}

// ---------------------------------------------------------------- 会话列表
async function listSessions(dev) {
  if (dev && (dev.type === 'ssh' || dev.host)) {
    return await remoteSessionOp(dev, 'list');
  }
  if (!SessionManager) return [];
  const all = await SessionManager.listAll();
  const byPath = new Map();
  for (const s of all) byPath.set(s.path, s.id);
  return all.map(s => ({
    path: s.path,
    id: s.id,
    cwd: s.cwd || '',
    name: s.name || '',
    created: String(s.created),
    modified: String(s.modified),
    messageCount: s.messageCount || 0,
    firstMessage: (s.firstMessage || '').slice(0, 200),
    parentSessionId: s.parentSessionPath ? byPath.get(s.parentSessionPath) : undefined,
  }));
}

async function readSessionMessages(sessionPath, dev) {
  if (dev && (dev.type === 'ssh' || dev.host)) {
    return await remoteSessionOp(dev, 'read', sessionPath);
  }
  if (!SessionManager) return [];
  const sm = SessionManager.open(sessionPath);
  const entries = sm.getEntries();
  const leafId = sm.getLeafId();
  // 用 pi 自己的 context 构建（正确处理 compaction 与分支）
  const out = [];
  const mod = PI_PKG ? require(PI_PKG) : {};
  if (typeof mod.buildSessionContext === 'function') {
    const ctx = mod.buildSessionContext(entries, leafId, null);
    for (const m of (ctx.messages || [])) {
      if (m.role === 'compactionSummary') {
        out.push({ role: 'system', content: [{ type: 'text', text: '（历史已压缩）' }], timestamp: m.timestamp });
      } else out.push(m);
    }
    return out;
  }
  for (const e of entries) {
    if (e.type === 'message' && e.message) out.push(e.message);
  }
  return out;
}

class PiSession {
  constructor(dev) {
    this.dev = dev;
    this.proc = null;
    this.stdoutBuf = '';
    this.seq = 0;
    this.pending = new Map();       // id -> {resolve, reject, timer}
    this.history = [];              // 归一化消息，供重连重放
    this.streaming = null;          // { blocks: [{type,text}], } 正在流式的内容
    this.state = { isStreaming: false, model: null, sessionFile: null, sessionId: null, thinkingLevel: null, messageCount: 0 };
    this.subscribers = new Set();   // ws
    this.alive = false;
    this.stderrTail = [];
    this.spawnAt = 0;
    this.sessionPath = null;       // 当前绑定的会话文件（null = 新会话）
  }

  // 运行中切到另一个会话：优先 RPC switch_session，失败则重启进程
  async switchTo(sessionPath) {
    this.sessionPath = sessionPath;
    this.history = [];
    this.streaming = null;
    if (this.alive && this.proc) {
      try {
        const d = await this.send('switch_session', { sessionPath }, 20000);
        if (d && d.cancelled) throw new Error('扩展取消了会话切换');
        await this.refreshState();
        return 'switched';
      } catch (e) {
        warn(`[${this.dev.id}] switch_session 失败，改为重启进程: ${e.message}`);
      }
    }
    this.stop();
    await new Promise(r => setTimeout(r, 400));
    this.start();
    // 等连接真正建立（最多 20s）
    for (let i = 0; i < 40; i++) {
      if (this.alive) break;
      await new Promise(r => setTimeout(r, 500));
    }
    await this.refreshState().catch(() => {});
    return 'restarted';
  }

  // -------------------------------------------------- 生命周期
  // -------------------------------------------------- transport 抽象
  // 本机 spawn 与远程 ssh2.exec 统一成：{ stdin, stdout, stderr, kill(), onClose(cb) }
  buildArgs() {
    const args = ['--mode', 'rpc'];
    if (CONFIG.sessionDir) args.push('--session-dir', this.remoteSessionDir());
    if (this.sessionPath) args.push('--session', this.remoteSessionPath(this.sessionPath));
    return args;
  }

  remoteSessionDir() {
    return this.dev.sessionDir || CONFIG.sessionDir;
  }

  // 本机路径直接返回；远程设备保持原样（假设两边路径方案一致）
  remoteSessionPath(p) { return p; }

  // 本机：child_process.spawn；ssh：ssh2 exec
  async spawnTransport() {
    if (this.dev.type === 'ssh' || this.dev.host) return this.spawnSsh();
    return this.spawnLocal();
  }

  spawnLocal() {
    const args = this.buildArgs();
    const opts = { stdio: ['pipe', 'pipe', 'pipe'], cwd: this.dev.cwd || process.cwd() };
    log(`[${this.dev.id}] spawn ${CONFIG.piBin} ${args.join(' ')}`);
    const p = spawn(CONFIG.piBin, args, opts);
    return {
      stdin: p.stdin,
      stdout: p.stdout,
      stderr: p.stderr,
      kill: () => { try { p.kill('SIGKILL'); } catch {} },
      endStdin: () => { try { p.stdin.end(); } catch {} },
      onClose: (cb) => p.on('exit', (code, signal) => cb(code, signal)),
    };
  }

  async spawnSsh() {
    const ssh = require('ssh2');
    const fs = require('fs');
    const d = this.dev;
    const args = this.buildArgs();
    const cwd = d.cwd || (isWin(d) ? d.homeHint || '' : '~');
    const piBin = d.piBin || 'pi';

    let cmd;
    if (isWin(d)) {
      // Windows 桥接：SSH exec 通道 ←→ node 桥接 ←→ pi 子进程
      //
      // 已验证：cmd + node -e + base64 桥接脚本能让 pi 的 RPC 正常收发。
      // 不用 PowerShell 直接转发，因为它的管道会缓冲，RPC 逐行 JSON 会被延迟。
      const nb = d.pathPrefix || d.nodeBin || '';
      const nodeExe = nb ? (nb.replace(/[\\/]+$/, '') + '\\node.exe') : 'node.exe';
      let launcher = d.piLauncherPath;
      if (!launcher && d.piBin) {
        launcher = d.piBin.replace(/[\\/][^\\/]+$/i, '') + '\\pi-launcher.js';
      }
      if (!launcher) throw new Error('找不到 pi-launcher.js，请在设备配置里指定 piBin 或 piLauncherPath');

      const bridgeSrc = [
        "const { spawn } = require('child_process');",
        `const child = spawn(${JSON.stringify(nodeExe)}, ${JSON.stringify([launcher, ...args])}, {`,
        "  stdio: ['pipe','pipe','pipe'],",
        `  cwd: ${JSON.stringify(cwd || d.homeHint || '')},`,
        "  windowsHide: true,",
        "});",
        "process.stdin.pipe(child.stdin);",
        "child.stdout.pipe(process.stdout);",
        "child.stderr.pipe(process.stderr);",
        "child.on('exit', c => process.exit(c || 0));",
        "child.on('error', e => { process.stderr.write(String(e.message || e) + '\\n'); process.exit(1); });",
      ].join('\n');

      // 弹窗与进程被杀（0xC000013A）都源于 sshd 为 exec 分配的控制台：
      //   - 直接跑 node.exe 会闪 cmd 窗口
      //   - 会话结束时 conhost 销毁，连带杀掉 node
      //
      // 用 powershell -WindowStyle Hidden 包一层：既隐藏窗口，
      // 又让 node 作为其子进程存活到 PowerShell 退出。
      // 实测：RPC 收发正常（bridge 本身是 node 流式管道，无缓冲问题）。
      const b64 = Buffer.from(bridgeSrc, 'utf8').toString('base64');
      // 与短命令一致：cmd /c 包裹，不再经过 PowerShell（少一层进程，少一次控制台）
      cmd = winExecCmd(nodeExe, b64);
    } else {
      const inner = [
        `cd ${cwd.startsWith('~') ? cwd : shellQuote(cwd)}`,
        `exec ${piBin} ${args.map(shellQuote).join(' ')}`,
      ].join(' && ');
      cmd = wrapRemoteCmd(d, inner);
    }

    log(`[${d.id}] ssh ${d.username || 'root'}@${d.host}:${d.port || 22} → ${cmd}`);

    const conn = await new Promise((resolve, reject) => {
      const c = new ssh.Client();
      const opts = {
        host: d.host,
        port: d.port || 22,
        username: d.username || 'root',
        readyTimeout: d.readyTimeoutMs || 20000,
        keepaliveInterval: 15000,
        keepaliveCountMax: 4,
      };
      if (d.privateKey) opts.privateKey = fs.readFileSync(d.privateKey);
      else if (d.privateKeyPath) opts.privateKey = fs.readFileSync(d.privateKeyPath);
      else if (d.password) opts.password = d.password;
      else for (const f of ['id_ed25519', 'id_rsa']) {
        const p = require('path').join(require('os').homedir(), '.ssh', f);
        if (fs.existsSync(p)) { opts.privateKey = fs.readFileSync(p); break; }
      }
      c.once('ready', () => resolve(c)).once('error', reject).connect(opts);
    });
    this.sshConn = conn;

    const stream = await new Promise((resolve, reject) => {
      conn.exec(cmd, (err, s) => err ? reject(err) : resolve(s));
    });

    return {
      stdin: { write: (buf) => stream.write(buf), end: () => stream.end() },
      stdout: stream,
      stderr: stream.stderr,
      kill: () => { try { stream.close(); } catch {} try { conn.end(); } catch {} },
      endStdin: () => { try { stream.end(); } catch {} },
      onClose: (cb) => {
        stream.on('close', (code, signal) => cb(code, signal));
        conn.on('close', () => cb(null, 'ssh-closed'));
      },
    };
  }

  start() {
    if (this.proc) return;
    this.starting = true;
    this._startPromise = this.spawnTransport().then(t => {
      if (!this.starting) { t.kill(); return; }
      this.starting = false;
      this.proc = t;
      this.spawnAt = Date.now();
      this.alive = true;

      if (t.stdout.setEncoding) t.stdout.setEncoding('utf8');
      t.stdout.on('data', (chunk) => this.onStdout(chunk));
      if (t.stderr) {
        if (t.stderr.setEncoding) t.stderr.setEncoding('utf8');
        t.stderr.on('data', (chunk) => {
          const txt = String(chunk).trim();
          if (!txt) return;
          this.stderrTail.push(txt);
          if (this.stderrTail.length > 20) this.stderrTail.shift();
          this.broadcast({ t: 'stderr', text: txt });
        });
      }
      t.onClose((code, sig) => {
        this.alive = false;
        this.proc = null;
        log(`[${this.dev.id}] pi 退出 code=${code} sig=${sig}`);
        for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error('pi 进程已退出')); }
        this.pending.clear();
        this.broadcast({ t: 'proc_exit', code, signal: sig });
        this.pushSystem(`⚠️ pi 进程退出 (code=${code})，下次发消息会自动重启`);
      });

      // 拉初始状态
      this.send('get_state', {}, 8000).then(d => {
        if (d) {
          Object.assign(this.state, d);
          if (d.sessionFile) this.sessionPath = d.sessionFile;
          this.broadcastState();
        }
      }).catch(() => {});
      this._startPromise = null;
    }).catch(e => {
      this.starting = false;
      this.alive = false;
      this.proc = null;
      this._startPromise = null;
      warn(`[${this.dev.id}] 启动失败: ${e.message}`);
      this.pushSystem(`⚠️ 无法启动 pi: ${e.message}`);
      this.broadcast({ t: 'proc_error', message: e.message });
    });
  }

  ensureAlive() {
    if (this.alive && this.proc) return Promise.resolve();
    // 已有一次启动在进行中：等它
    if (this.starting && this._startPromise) return this._startPromise;
    this.start();
    return this._startPromise || Promise.resolve();
  }

  stop() {
    this.starting = false;
    if (this.proc) {
      const p = this.proc;
      try { p.endStdin(); } catch {}
      setTimeout(() => { try { p.kill(); } catch {} }, 2000).unref?.();
    }
    if (this.sshConn) {
      const c = this.sshConn;
      setTimeout(() => { try { c.end(); } catch {} }, 2500).unref?.();
    }
  }

  // -------------------------------------------------- 分帧
  onStdout(chunk) {
    this.stdoutBuf += chunk;
    let idx;
    while ((idx = this.stdoutBuf.indexOf('\n')) >= 0) {
      const raw = this.stdoutBuf.slice(0, idx).replace(/\r$/, '');
      this.stdoutBuf = this.stdoutBuf.slice(idx + 1);
      if (!raw.trim()) continue;
      let rec;
      try { rec = JSON.parse(raw); }
      catch { warn(`[${this.dev.id}] 无法解析的记录: ${raw.slice(0, 120)}`); continue; }
      try { this.handleRecord(rec); }
      catch (e) { warn(`[${this.dev.id}] handleRecord 异常: ${e.message}`); }
    }
    // 防御：单行异常长时截断
    if (this.stdoutBuf.length > 8 * 1024 * 1024) { warn('stdout 缓冲超限，丢弃'); this.stdoutBuf = ''; }
  }

  handleRecord(rec) {
    // 1) 命令响应
    if (rec.type === 'response') {
      const p = this.pending.get(rec.id);
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(rec.id);
        if (rec.success) p.resolve(rec.data ?? {});
        else p.reject(new Error(rec.error || '命令失败'));
      }
      return;
    }
    // 2) 扩展 UI 交互（select/confirm/input...）
    if (rec.type === 'extension_ui_request') {
      this.broadcast({ t: 'ui_request', rec });
      return;
    }
    if (rec.type === 'extension_ui_response') return;

    // 3) 会话事件
    this.onEvent(rec);
  }

  onEvent(ev) {
    switch (ev.type) {
      case 'agent_start':
        this.state.isStreaming = true;
        this.streaming = { blocks: [] };
        this.broadcast({ t: 'agent_start' });
        this.broadcastState();
        break;

      case 'message_start':
        if (ev.message?.role === 'user') {
          this.pushUser(ev.message.content);
          this.broadcast({ t: 'user_message', message: this.normalize(ev.message) });
        }
        break;

      case 'message_update': {
        const a = ev.assistantMessageEvent;
        if (!a) break;
        if (a.type === 'text_delta') this.appendBlock('text', a.delta);
        else if (a.type === 'thinking_delta') this.appendBlock('thinking', a.delta);
        else if (a.type === 'toolcall_delta') this.appendBlock('tool', a.delta);
        else if (a.type === 'toolcall_start') this.startTool(a.toolName, a.id);
        else if (a.type === 'toolcall_end') this.endTool(a.toolCall);
        else if (a.type === 'text_start') this.startBlock('text');
        else if (a.type === 'thinking_start') this.startBlock('thinking');
        break;
      }

      case 'message_end': {
        const m = ev.message;
        if (m?.role === 'assistant') {
          const norm = this.normalize(m);
          this.history.push(norm);
          if (this.history.length > CONFIG.maxBuffered) this.history.shift();
          this.streaming = null;
          this.broadcast({ t: 'assistant_message', message: norm });
        }
        break;
      }

      case 'tool_execution_start':
        this.broadcast({ t: 'tool_start', id: ev.toolCallId, name: ev.toolName, args: ev.args });
        this.setToolState(ev.toolCallId, 'running');
        break;

      case 'tool_execution_end':
        this.broadcast({
          t: 'tool_end', id: ev.toolCallId, name: ev.toolName,
          isError: !!ev.isError, durationMs: ev.durationMs,
          text: this.resultText(ev.result).slice(0, 2000),
          images: this.saveResultImages(ev.result, ev.toolCallId),
        });
        this.setToolState(ev.toolCallId, ev.isError ? 'error' : 'ok', ev.durationMs);
        break;

      case 'agent_end':
        break;

      case 'agent_settled':
        this.state.isStreaming = false;
        this.streaming = null;
        this.broadcast({ t: 'settled', aborted: !!ev.aborted });
        this.broadcastState();
        this.refreshState();
        break;

      case 'compaction_start':
        this.broadcast({ t: 'notice', text: `压缩上下文… (${ev.reason})` });
        break;

      case 'compaction_end':
        this.broadcast({ t: 'notice', text: ev.errorMessage ? `压缩失败: ${ev.errorMessage}` : '压缩完成' });
        break;

      case 'auto_retry_start':
        this.broadcast({ t: 'notice', text: `重试 ${ev.attempt}/${ev.maxAttempts}: ${ev.errorMessage}` });
        break;

      case 'queue_update':
        this.broadcast({ t: 'queue', steering: ev.steering || [], followUp: ev.followUp || [] });
        break;

      case 'thinking_level_changed':
        this.state.thinkingLevel = ev.level;
        this.broadcastState();
        break;

      case 'session_info_changed':
        this.broadcast({ t: 'notice', text: `会话名: ${ev.name || '(未命名)'}` });
        break;

      case 'extension_error':
        this.broadcast({ t: 'notice', text: `扩展错误 ${ev.extensionPath}: ${ev.error}` });
        break;

      default:
        break;
    }
  }

  // -------------------------------------------------- 流式块累积
  startBlock(type) {
    if (!this.streaming) this.streaming = { blocks: [] };
    this.streaming.blocks.push({ type, text: '' });
    this.broadcast({ t: 'block_start', type, index: this.streaming.blocks.length - 1 });
  }

  appendBlock(type, delta) {
    if (!this.streaming) this.streaming = { blocks: [] };
    let b = this.streaming.blocks[this.streaming.blocks.length - 1];
    if (!b || b.type !== type) { this.startBlock(type); b = this.streaming.blocks[this.streaming.blocks.length - 1]; }
    b.text += delta;
    this.broadcast({ t: 'delta', type, text: delta, index: this.streaming.blocks.length - 1 });
  }

  startTool(name, id) {
    if (!this.streaming) this.streaming = { blocks: [] };
    this.streaming.blocks.push({ type: 'tool', name, id, text: '' });
    this.broadcast({ t: 'block_start', type: 'tool', name, id, index: this.streaming.blocks.length - 1 });
  }

  endTool(toolCall) {
    this.broadcast({ t: 'block_tool_end', toolCall });
  }

  setToolState(id, state, durationMs) {
    this.broadcast({ t: 'tool_state', id, state, durationMs });
  }

  // -------------------------------------------------- 归一化 / 历史
  normalize(m) {
    const out = { role: m.role, content: [], timestamp: m.timestamp };
    const c = m.content;
    if (typeof c === 'string') out.content.push({ type: 'text', text: c });
    else if (Array.isArray(c)) {
      for (const b of c) {
        if (b.type === 'text') out.content.push({ type: 'text', text: b.text });
        else if (b.type === 'thinking') out.content.push({ type: 'thinking', text: b.thinking || b.text || '' });
        else if (b.type === 'toolCall') out.content.push({ type: 'tool', name: b.name, id: b.id, args: b.arguments });
        else if (b.type === 'image') out.content.push({ type: 'image', mimeType: b.mimeType });
        else out.content.push({ type: b.type, text: JSON.stringify(b).slice(0, 500) });
      }
    }
    return out;
  }

  resultText(result) {
    if (!result) return '';
    if (typeof result === 'string') return result;
    if (Array.isArray(result.content)) {
      return result.content.map(c => {
        if (c.type === 'text') return c.text;
        if (c.type === 'image') {
          const sz = c.data ? Math.round(c.data.length * 0.75 / 1024) : 0;
          return `[图片${sz ? ' ' + sz + 'KB' : ''}]`;
        }
        return `[${c.type}]`;
      }).join('\n');
    }
    return JSON.stringify(result).slice(0, 800);
  }

  /** 把工具结果里的图片落盘，返回 URL 列表（不占 WS 带宽，前端按需拉） */
  saveResultImages(result, toolId) {
    if (!result || !Array.isArray(result.content)) return [];
    const out = [];
    for (const c of result.content) {
      if (c.type !== 'image' || !c.data) continue;
      try {
        const mime = c.mimeType || 'image/png';
        const ext = ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' })[mime] || 'png';
        const buf = Buffer.from(c.data, 'base64');
        if (buf.length > TOOL_IMAGE_MAX) { out.push({ error: '图片过大未保存', size: buf.length }); continue; }
        const id = crypto.randomBytes(8).toString('hex') + '-' + String(toolId || '').replace(/[^\w-]/g, '').slice(0, 24);
        const file = path.join(TOOL_IMG_DIR, id + '.' + ext);
        fs.writeFileSync(file, buf);
        TOOL_IMAGES.set(id, { file, mime, ts: Date.now(), size: buf.length });
        out.push({ id, url: '/api/toolimg/' + id, mime, size: buf.length });
      } catch (e) {
        out.push({ error: e.message });
      }
    }
    return out;
  }

  pushUser(content) {
    this.history.push({ role: 'user', content: typeof content === 'string' ? [{ type: 'text', text: content }] : this.normalize({ role: 'user', content }).content });
    if (this.history.length > CONFIG.maxBuffered) this.history.shift();
  }

  pushSystem(text) {
    const msg = { role: 'system', content: [{ type: 'text', text }], timestamp: Date.now() };
    this.history.push(msg);
    if (this.history.length > CONFIG.maxBuffered) this.history.shift();
    this.broadcast({ t: 'system_message', message: msg });
  }

  // -------------------------------------------------- 命令
  async send(type, payload = {}, timeoutMs = 30000) {
    await this.ensureAlive();
    if (!this.proc) throw new Error('pi 未运行');
    const id = `m${++this.seq}`;
    const rec = { id, type, ...payload };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${type} 超时`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.proc.stdin.write(JSON.stringify(rec) + '\n');
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  async prompt(text, streamingBehavior, images) {
    const payload = { message: text };
    if (streamingBehavior) payload.streamingBehavior = streamingBehavior;
    if (images && images.length) payload.images = images;
    return this.send('prompt', payload, 60000);
  }

  async refreshState() {
    try {
      const d = await this.send('get_state', {}, 8000);
      if (d) {
        Object.assign(this.state, d);
        if (d.sessionFile) this.sessionPath = d.sessionFile;
        this.broadcastState();
      }
    } catch {}
  }

  // -------------------------------------------------- 广播
  subscribe(ws) {
    this.subscribers.add(ws);
    ws.on('close', () => this.subscribers.delete(ws));
    // 重连补发
    ws.send(JSON.stringify({ t: 'hello', device: this.dev, state: this.state, history: this.history, sessionPath: this.sessionPath }));
    if (this.streaming) ws.send(JSON.stringify({ t: 'stream_resume', blocks: this.streaming.blocks }));
  }

  broadcast(msg) {
    const s = JSON.stringify(msg);
    for (const ws of this.subscribers) {
      if (ws.readyState === 1) { try { ws.send(s); } catch {} }
    }
  }

  broadcastState() { this.broadcast({ t: 'state', state: this.state }); }
}

// ---------------------------------------------------------------- HTTP + WS
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };

// ---------------------------------------------------------------- 文件浏览
const FS_IGNORE = new Set([
  'node_modules', '.git', '.next', 'dist', 'build', '__pycache__', '.turbo',
  '.cache', 'coverage', '.pytest_cache', '.mypy_cache', 'target', 'vendor',
  '.DS_Store', '.venv', 'venv', '.idea', '.vscode-server',
]);
const FS_IGNORE_SUFFIX = ['.pyc', '.pyo'];
const PREVIEW_TEXT_MAX = 256 * 1024;
const PREVIEW_BIN_MAX = 10 * 1024 * 1024;

const IMAGE_MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif',
  svg: 'image/svg+xml',
};

function humanSize(n) {
  if (!Number.isFinite(n)) return '?';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return (i === 0 ? v : v.toFixed(v < 10 ? 1 : 0)) + ' ' + u[i];
}

function ignoreName(name) {
  if (FS_IGNORE.has(name)) return true;
  const lower = name.toLowerCase();
  return FS_IGNORE_SUFFIX.some(sfx => lower.endsWith(sfx));
}

function isRemote(dev) {
  return dev && (dev.type === 'ssh' || dev.host);
}

/** 规范化路径，禁止越界（本机才做 resolve 校验） */
function normalizeListPath(p, dev) {
  let out = String(p || '').trim();
  // Windows 路径（C:\... / C:/...）原样返回，不能加前缀斜杠
  if (/^[A-Za-z]:[\\/]/.test(out) || /^[A-Za-z]:$/.test(out)) {
    return out.replace(/\//g, '\\');
  }
  // UNC 路径 \\server\share
  if (out.startsWith('\\\\')) return out.replace(/\//g, '\\');
  if (!out) {
    return isWin(dev) ? (dev.cwd || dev.homeHint || 'C:\\') : '/';
  }
  if (!out.startsWith('/') && !out.startsWith('~') && !out.startsWith('\\')) out = '/' + out;
  return out;
}

/** 列出本地目录 */
async function listDirLocal(dir) {
  const fsP = require('fs/promises');
  const resolved = dir.startsWith('~')
    ? require('path').join(require('os').homedir(), dir.slice(1))
    : dir;
  const real = await fsP.realpath(resolved).catch(() => null);
  const stat = await fsP.stat(resolved).catch(() => null);
  if (!stat) throw new Error('目录不存在: ' + dir);
  if (!stat.isDirectory()) throw new Error('不是目录: ' + dir);

  const dirents = await fsP.readdir(resolved, { withFileTypes: true });
  const out = [];
  for (const d of dirents) {
    if (ignoreName(d.name)) continue;
    const full = require('path').join(resolved, d.name);
    let st = null;
    try { st = await fsP.lstat(full); } catch { continue; }
    const isDir = st.isDirectory();
    const isLink = st.isSymbolicLink();
    out.push({
      name: d.name,
      type: isLink ? 'link' : isDir ? 'dir' : 'file',
      size: isDir ? 0 : st.size,
      mtime: st.mtimeMs,
    });
  }
  // 目录优先 + 名称排序
  out.sort((a, b) => {
    const da = a.type !== 'file' ? 0 : 1;
    const db = b.type !== 'file' ? 0 : 1;
    if (da !== db) return da - db;
    return a.name.localeCompare(b.name, 'zh');
  });
  return out;
}

/** 列出远程目录（Windows：node 直接读文件系统，不经过 shell） */
async function listDirRemoteWin(dev, dir) {
  const script = [
    "const fs=require('fs'),path=require('path');",
    "const dir=process.argv[2];",
    "const out=[];",
    "for(const e of fs.readdirSync(dir,{withFileTypes:true})){",
    "  const st=fs.statSync(path.join(dir,e.name),{throwIfNoEntry:false});",
    "  const t=e.isDirectory()?'d':(e.isSymbolicLink()?'l':'f');",
    "  out.push([t, st?st.size:0, st?Math.floor(st.mtimeMs/1000):0, e.name].join(String.fromCharCode(9)));",
    "}",
    "process.stdout.write(out.join(String.fromCharCode(10)));",
  ].join(String.fromCharCode(10));

  const b64 = Buffer.from(script, 'utf8').toString('base64');
  const nb = dev.pathPrefix || dev.nodeBin || '';
  const nodeExe = nb ? (nb.replace(/[\\/]+$/, '') + '\\node.exe') : 'node.exe';
  const r = await sshExec(dev, winExecCmd(nodeExe, b64, [dir]), 25000);

  const lines = String(r.stdout || '').split('\n').map(x => x.replace(/\r$/, '')).filter(Boolean);
  if (r.code !== 0 && !lines.length) {
    throw new Error('目录不存在或无法读取: ' + dir + (r.stderr ? ' (' + String(r.stderr).slice(0, 100) + ')' : ''));
  }

  const out = [];
  for (const line of lines) {
    const parts = line.split('\t');
    if (parts.length < 4) continue;
    const [t, size, mtime, ...rest] = parts;
    const name = rest.join('\t');
    if (!name || ignoreName(name)) continue;
    out.push({
      name,
      type: t === 'd' ? 'dir' : t === 'l' ? 'link' : 'file',
      size: Number(size) || 0,
      mtime: (Number(mtime) || 0) * 1000,
    });
  }
  out.sort((a, b) => {
    const da = a.type !== 'file' ? 0 : 1;
    const db = b.type !== 'file' ? 0 : 1;
    if (da !== db) return da - db;
    return a.name.localeCompare(b.name, 'zh');
  });
  return out;
}

/** 列出远程目录（走 SSH） */
async function listDirRemote(dev, dir) {
  if (isWin(dev)) return listDirRemoteWin(dev, dir);
  const p = dir.startsWith('~') || dir.startsWith('/') ? dir : './' + dir;
  // 用 find 输出：类型|大小|mtime|名字（  分隔避免空格问题）
  const script = [
    `cd ${p.startsWith('~') ? p : shellQuote(p)} 2>/dev/null || { echo "__ERR__no such dir"; exit 0; }`,
    `find . -maxdepth 1 -mindepth 1 -printf '%y\\t%s\\t%T@\\t%f\\n' 2>/dev/null || ls -A`,
  ].join('; ');
  const cmd = wrapRemoteCmd(dev, script);
  const r = await sshExec(dev, cmd, 20000);
  const lines = r.stdout.split('\n').filter(Boolean);
  const out = [];
  for (const line of lines) {
    if (line.startsWith('__ERR__')) throw new Error('目录不存在: ' + dir);
    const parts = line.split('\t');
    if (parts.length < 4) {
      // 兜底 ls -A 输出
      const name = line.trim();
      if (!name) continue;
      if (ignoreName(name)) continue;
      out.push({ name, type: 'file', size: 0, mtime: Date.now() });
      continue;
    }
    const [t, size, mtime, name] = parts;
    if (ignoreName(name)) continue;
    out.push({
      name,
      type: t === 'd' ? 'dir' : t === 'l' ? 'link' : 'file',
      size: Number(size) || 0,
      mtime: (Number(mtime) || 0) * 1000,
    });
  }
  out.sort((a, b) => {
    const da = a.type !== 'file' ? 0 : 1;
    const db = b.type !== 'file' ? 0 : 1;
    if (da !== db) return da - db;
    return a.name.localeCompare(b.name, 'zh');
  });
  return out;
}

async function listDir(dev, dir) {
  const p = normalizeListPath(dir, dev);
  if (isRemote(dev)) return listDirRemote(dev, p);
  return listDirLocal(p);
}

/** 附件上限 */
const ATTACH = {
  maxFiles: 6,
  maxTextBytes: 200 * 1024,      // 单文件文本上限
  maxTotalBytes: 600 * 1024,     // 总计上限
  maxImageBytes: 5 * 1024 * 1024,
  maxImageCount: 4,
};

/**
 * 跨平台远程文件操作（POSIX / Windows）。
 * 返回统一结构，调用方不需要关心平台。
 */

/** 文件大小；不存在返回 null */
async function remoteStatSize(dev, filePath) {
  if (isWin(dev)) {
    const script = `
const fs=require('fs');
try{ process.stdout.write(String(fs.statSync(process.argv[2]).size)) }catch{ process.stdout.write('ERR') }
`;
    const b64 = Buffer.from(script,'utf8').toString('base64');
    const nb = dev.pathPrefix || dev.nodeBin || '';
    const nodeExe = nb ? (nb.replace(/[\\/]+$/,'') + '\\node.exe') : 'node.exe';
    const r = await sshExec(dev, winExecCmd(nodeExe, b64, [filePath]), 15000);
    const v = String(r.stdout || '').trim();
    return /^\d+$/.test(v) ? Number(v) : null;
  }
  const r = await sshExec(dev, wrapRemoteCmd(dev, `stat -c '%s' ${shellQuote(filePath)} 2>/dev/null || echo ERR`), 15000);
  const v = String(r.stdout || '').trim().split('\n').pop();
  if (!v || v === 'ERR' || !/^\d+$/.test(v)) return null;
  return Number(v);
}

/** 读文件前 N 字节（二进制） */
async function remoteReadBytes(dev, filePath, maxBytes) {
  if (isWin(dev)) {
    const script = `
const fs=require('fs');
const fd=fs.openSync(process.argv[2],'r');
try{
  const n=Math.min(Number(process.argv[3]), fs.fstatSync(fd).size);
  const buf=Buffer.alloc(n);
  fs.readSync(fd,buf,0,n,0);
  process.stdout.write(buf.toString('base64'));
}finally{ fs.closeSync(fd) }
`;
    const b64 = Buffer.from(script,'utf8').toString('base64');
    const nb = dev.pathPrefix || dev.nodeBin || '';
    const nodeExe = nb ? (nb.replace(/[\\/]+$/,'') + '\\node.exe') : 'node.exe';
    const r = await sshExec(dev, winExecCmd(nodeExe, b64, [filePath, String(maxBytes)]), 40000);
    return Buffer.from(String(r.stdout || '').replace(/\s+/g, ''), 'base64');
  }
  const r = await sshExec(dev, wrapRemoteCmd(dev, `head -c ${Number(maxBytes)} ${shellQuote(filePath)} | base64 -w0`), 40000);
  return Buffer.from(String(r.stdout || '').trim(), 'base64');
}

/** 读文件全文（二进制，用于图片预览） */
async function remoteReadAll(dev, filePath) {
  if (isWin(dev)) {
    const script = `process.stdout.write(require('fs').readFileSync(process.argv[2]).toString('base64'))`;
    const b64 = Buffer.from(script,'utf8').toString('base64');
    const nb = dev.pathPrefix || dev.nodeBin || '';
    const nodeExe = nb ? (nb.replace(/[\\/]+$/,'') + '\\node.exe') : 'node.exe';
    const r = await sshExec(dev, winExecCmd(nodeExe, b64, [filePath]), 60000);
    return Buffer.from(String(r.stdout || '').replace(/\s+/g, ''), 'base64');
  }
  const r = await sshExec(dev, wrapRemoteCmd(dev, `base64 -w0 ${shellQuote(filePath)}`), 40000);
  return Buffer.from(String(r.stdout || '').trim(), 'base64');
}

/** 读文件文本（前 N 字节） */
async function remoteReadText(dev, filePath, maxBytes) {
  if (isWin(dev)) {
    const script = `
const fs=require('fs');
const fd=fs.openSync(process.argv[2],'r');
try{
  const n=Math.min(Number(process.argv[3]), fs.fstatSync(fd).size);
  const buf=Buffer.alloc(n);
  const r=fs.readSync(fd,buf,0,n,0);
  process.stdout.write(buf.subarray(0,r));
}finally{ fs.closeSync(fd) }
`;
    const b64 = Buffer.from(script,'utf8').toString('base64');
    const nb = dev.pathPrefix || dev.nodeBin || '';
    const nodeExe = nb ? (nb.replace(/[\\/]+$/,'') + '\\node.exe') : 'node.exe';
    const r = await sshExec(dev, winExecCmd(nodeExe, b64, [filePath, String(maxBytes)]), 30000);
    return String(r.stdout || '');
  }
  const r = await sshExec(dev, wrapRemoteCmd(dev, `head -c ${Number(maxBytes)} ${shellQuote(filePath)} 2>/dev/null`), 30000);
  return String(r.stdout || '');
}

/** 读附件原始内容（本机/远程统一） */
async function readAttach(dev, filePath, maxBytes) {
  if (isRemote(dev)) {
    return await remoteReadBytes(dev, filePath, maxBytes);
  }
  const fsP = require('fs/promises');
  const resolved = filePath.startsWith('~')
    ? require('path').join(require('os').homedir(), filePath.slice(1))
    : filePath;
  const fh = await fsP.open(resolved, 'r');
  try {
    const len = Math.min((await fh.stat()).size, maxBytes);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, 0);
    return buf;
  } finally { await fh.close(); }
}

/**
 * 把附件拼成 prompt。
 * - 图片 → images[]（base64），并写明路径
 * - 文本 → ```path
内容``` 代码块
 * - 二进制 → 只给路径和大小提示
 */
async function buildPromptWithFiles(dev, userText, files) {
  const path = require('path');
  const list = files.slice(0, ATTACH.maxFiles);
  const chunks = [];
  const images = [];
  let totalBytes = 0;
  let imageCount = 0;

  // 用户先说话，附件在后面
  if (userText) chunks.push(userText);

  for (const f of list) {
    const fp = String(f.path || '');
    if (!fp) continue;
    const name = path.basename(fp);
    const ext = (name.split('.').pop() || '').toLowerCase();
    const imgMime = IMAGE_MIME[ext];

    try {
      // 目录：展开文件树（受限深度）
      if (f.kind === 'dir' || /\/$/.test(fp)) {
        const tree = await describeDir(dev, fp, 3, 200);
        chunks.push(tree);
        continue;
      }
      if (imgMime) {
        if (imageCount >= ATTACH.maxImageCount) {
          chunks.push(`（图片 ${fp} 超过数量上限，未附加）`);
          continue;
        }
        const buf = await readAttach(dev, fp, ATTACH.maxImageBytes);
        if (buf.length > ATTACH.maxImageBytes) {
          chunks.push(`（图片 ${fp} 太大，未附加）`);
          continue;
        }
        images.push({ type: 'image', data: buf.toString('base64'), mimeType: imgMime });
        imageCount++;
        chunks.push(`（已附加图片：${fp}）`);
        continue;
      }

      const buf = await readAttach(dev, fp, ATTACH.maxTextBytes);
      if (buf.includes(0)) {
        chunks.push(`（二进制文件 ${fp}，${humanSize(buf.length)}，未附加内容）`);
        continue;
      }
      totalBytes += buf.length;
      if (totalBytes > ATTACH.maxTotalBytes) {
        chunks.push(`（累计附件超限，${fp} 未附加）`);
        continue;
      }
      let text = buf.toString('utf8');
      if (text.length >= ATTACH.maxTextBytes) text += '\n...（已截断）';
      chunks.push('```' + fp + '\n' + text + '\n```');
    } catch (e) {
      chunks.push(`（读取 ${fp} 失败：${e.message}）`);
    }
  }

  if (list.length > ATTACH.maxFiles) {
    chunks.push(`（另有 ${list.length - ATTACH.maxFiles} 个文件超出上限被忽略）`);
  }

  return { text: chunks.join('\n\n'), images };
}

/** 生成目录树文本（限制深度和条目数） */
async function describeDir(dev, dirPath, maxDepth = 3, maxEntries = 200) {
  // 远程：一条 find 拿整棵树，避免多次 SSH 往返
  if (isRemote(dev)) {
    const root = String(dirPath).replace(/\/+$/, '');
    const ignore = [...FS_IGNORE].map(n => `-name ${shellQuote(n)}`).join(' -o ');
    const script = [
      `cd ${shellQuote(root)} 2>/dev/null || { echo "__ERR__"; exit 0; }`,
      `find . -maxdepth ${maxDepth + 1} -mindepth 1 \\( ${ignore} \\) -prune -o -printf '%y\\t%s\\t%p\\n' 2>/dev/null | head -n ${maxEntries + 1}`,
    ].join('; ');
    try {
      const r = await sshExec(dev, wrapRemoteCmd(dev, script), 30000);
      if (r.stdout.includes('__ERR__')) return '（目录不存在：' + root + '）';
      const paths = [];
      for (const line of r.stdout.split('\n').filter(Boolean)) {
        const [t, size, p] = line.split('\t');
        if (!p) continue;
        paths.push({ type: t === 'd' ? 'dir' : 'file', size: Number(size) || 0, name: p.replace(/^\.\//, '') });
      }
      return renderTreeText(root, paths, maxDepth, maxEntries);
    } catch (e) {
      return '（读取目录失败：' + e.message + '）';
    }
  }

  const lines = [];
  let count = 0;
  let truncated = false;

  async function walk(dir, depth, prefix) {
    if (depth > maxDepth || count >= maxEntries) { if (count >= maxEntries) truncated = true; return; }
    let entries;
    try { entries = await listDir(dev, dir); } catch (e) { lines.push(prefix + '（无法读取：' + e.message + '）'); return; }
    for (let i = 0; i < entries.length; i++) {
      if (count >= maxEntries) { truncated = true; return; }
      const e = entries[i];
      const last = i === entries.length - 1;
      const branch = prefix + (last ? '└── ' : '├── ');
      if (e.type === 'dir') {
        lines.push(branch + e.name + '/');
        count++;
        await walk(joinPosix(dir, e.name), depth + 1, prefix + (last ? '    ' : '│   '));
      } else {
        lines.push(branch + e.name + (e.size ? ' (' + humanSize(e.size) + ')' : ''));
        count++;
      }
    }
  }

  await walk(String(dirPath).replace(/\/+$/, ''), 0, '');
  let out = '```text\n' + dirPath + '/\n' + lines.join('\n');
  if (truncated) out += '\n...（超过 ' + maxEntries + ' 项，已截断）';
  return out + '\n```';
}

/** 把 [{name:'a/b/c', type}] 平铺列表渲染成树形文本 */
function renderTreeText(root, items, maxDepth, maxEntries) {
  // 建树
  const tree = { children: new Map() };
  for (const it of items) {
    const parts = it.name.split('/');
    if (parts.length > maxDepth + 1) continue;
    let node = tree;
    for (let i = 0; i < parts.length; i++) {
      const isLeaf = i === parts.length - 1;
      const key = parts[i];
      if (!node.children.has(key)) {
        node.children.set(key, {
          name: key,
          type: isLeaf ? it.type : 'dir',
          size: isLeaf ? it.size : 0,
          children: new Map(),
        });
      }
      // 叶子类型以最后一条为准
      if (isLeaf) {
        const n = node.children.get(key);
        n.type = it.type;
        n.size = it.size;
      }
      node = node.children.get(key);
    }
  }

  const lines = [];
  let count = 0;
  let truncated = false;
  function draw(node, prefix) {
    const kids = [...node.children.values()].sort((a, b) => {
      const da = a.type === 'dir' ? 0 : 1, db = b.type === 'dir' ? 0 : 1;
      return da - db || a.name.localeCompare(b.name, 'zh');
    });
    for (let i = 0; i < kids.length; i++) {
      if (count >= maxEntries) { truncated = true; return; }
      const k = kids[i];
      const last = i === kids.length - 1;
      lines.push(prefix + (last ? '└── ' : '├── ') + k.name + (k.type === 'dir' ? '/' : (k.size ? ' (' + humanSize(k.size) + ')' : '')));
      count++;
      if (k.type === 'dir' && k.children.size) draw(k, prefix + (last ? '    ' : '│   '));
    }
  }
  draw(tree, '');
  let out = '```text\n' + root + '/\n' + lines.join('\n');
  if (truncated) out += '\n...（超过 ' + maxEntries + ' 项，已截断）';
  return out + '\n```';
}

function joinPosix(dir, name) {
  return String(dir).replace(/\/+$/, '') + '/' + name;
}

/** 读文件预览：小文本返回内容，图片等返回原始字节 */
async function readFilePreview(dev, filePath) {
  const path = require('path');
  const name = path.basename(filePath);
  const ext = (name.split('.').pop() || '').toLowerCase();
  const mime = IMAGE_MIME[ext] || 'application/octet-stream';

  if (isRemote(dev)) {
    const size = await remoteStatSize(dev, filePath);
    if (size === null) return null;

    if (IMAGE_MIME[ext]) {
      if (size > PREVIEW_BIN_MAX) throw new Error('图片太大（' + humanSize(size) + '）');
      const data = await remoteReadAll(dev, filePath);
      return { binary: true, mime, name, size, data };
    }
    const maxRead = Math.min(size, PREVIEW_TEXT_MAX);
    const text = await remoteReadText(dev, filePath, maxRead);
    return {
      binary: false, name, size,
      truncated: size > PREVIEW_TEXT_MAX,
      mime: 'text/plain; charset=utf-8',
      text,
    };
  }

  const fsP = require('fs/promises');
  const resolved = filePath.startsWith('~')
    ? path.join(require('os').homedir(), filePath.slice(1))
    : filePath;
  const st = await fsP.stat(resolved).catch(() => null);
  if (!st || !st.isFile()) return null;

  if (IMAGE_MIME[ext]) {
    if (st.size > PREVIEW_BIN_MAX) throw new Error('图片太大（' + humanSize(st.size) + '）');
    const data = await fsP.readFile(resolved);
    return { binary: true, mime, name, size: st.size, data };
  }

  const fh = await fsP.open(resolved, 'r');
  try {
    const len = Math.min(st.size, PREVIEW_TEXT_MAX);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, 0);
    // 二进制探测：前 4KB 有 NUL 就当二进制
    const probe = buf.subarray(0, Math.min(4096, buf.length));
    if (probe.includes(0)) {
      return { binary: false, name, size: st.size, truncated: false, mime: 'text/plain', text: '（二进制文件，无法预览）' };
    }
    return {
      binary: false, name, size: st.size,
      truncated: st.size > PREVIEW_TEXT_MAX,
      mime: 'text/plain; charset=utf-8',
      text: buf.toString('utf8'),
    };
  } finally {
    await fh.close();
  }
}

// ---------------------------------------------------------------- 图床上传
// 上传图片到 GitHub 仓库，返回可直接引用的链接。
// 令牌从环境变量读，绝不写进代码：PI_GITHUB_TOKEN
const IMGHOST = {
  token: process.env.PI_GITHUB_TOKEN || '',
  repo: process.env.PI_GITHUB_REPO || 'freedom2599/Pics',   // owner/name
  branch: process.env.PI_GITHUB_BRANCH || '',                // 空=默认分支
  dir: process.env.PI_GITHUB_DIR || 'assets/pi',             // 仓库内目录
  cdnBase: process.env.PI_IMGHOST_CDN || '',                 // 空=用 raw.githubusercontent
};

function imgHostReady() {
  return !!IMGHOST.token && /^[^/]+\/[^/]+$/.test(IMGHOST.repo);
}

function ghHeaders() {
  return {
    'authorization': 'Bearer ' + IMGHOST.token,
    'accept': 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'pi-mobile',
  };
}

/** 极简 https 请求（避免引入依赖） */
function httpsJson(method, urlStr, body) {
  return new Promise((resolve, reject) => {
    const https = require('https');
    const u = new URL(urlStr);
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const headers = ghHeaders();
    if (data) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = data.length;
    }
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search,
      method, headers, timeout: 30000,
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('timeout', () => { req.destroy(new Error('GitHub 请求超时')); });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

/** 上传一张图片，返回 { ok, url, path, cdn } */
async function uploadToImageHost(buf, filename, mime) {
  if (!imgHostReady()) throw new Error('图床未配置（缺少 PI_GITHUB_TOKEN 或 PI_GITHUB_REPO）');

  const ext = (filename.split('.').pop() || 'png').toLowerCase().replace(/[^a-z0-9]/g, '') || 'png';
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const rand = crypto.randomBytes(3).toString('hex');
  const safeName = String(filename).replace(/\.[^.]+$/, '')
    .replace(/[^\w\u4e00-\u9fa5-]/g, '_').slice(0, 40) || 'img';
  const remotePath = [IMGHOST.dir.replace(/^\/+|\/+$/g, ''), `${stamp}-${rand}-${safeName}.${ext}`]
    .filter(Boolean).join('/');

  // 查默认分支
  let branch = IMGHOST.branch;
  if (!branch) {
    const info = await httpsJson('GET', `https://api.github.com/repos/${IMGHOST.repo}`);
    if (info.status !== 200) throw new Error('读取仓库失败: HTTP ' + info.status + ' ' + (info.json?.message || ''));
    branch = info.json.default_branch || 'main';
  }

  const api = `https://api.github.com/repos/${IMGHOST.repo}/contents/${encodeURIComponent(remotePath).replace(/%2F/g, '/')}`;
  const put = await httpsJson('PUT', api, {
    message: `upload: ${remotePath}`,
    content: buf.toString('base64'),
    branch,
  });

  if (put.status !== 200 && put.status !== 201) {
    throw new Error('上传失败: HTTP ' + put.status + ' ' + (put.json?.message || put.text.slice(0, 200)));
  }

  const cdn = IMGHOST.cdnBase
    ? IMGHOST.cdnBase.replace(/\/+$/, '') + '/' + remotePath
    : `https://raw.githubusercontent.com/${IMGHOST.repo}/${branch}/${remotePath}`;

  return { url: cdn, path: remotePath, branch };
}

// ---------------------------------------------------------------- APK 版本
const RELEASES_DIR = path.join(__dirname, 'releases');
const APK_LATEST = path.join(__dirname, 'apk-version.json');

/** 读取 APK 版本信息（写 releases/ 或 apk-version.json 后自动生效） */
function readApkInfo() {
  let meta = null;
  try {
    if (fs.existsSync(APK_LATEST)) meta = JSON.parse(fs.readFileSync(APK_LATEST, 'utf8'));
  } catch (e) { warn('apk-version.json 解析失败:', e.message); }

  // 自动挑 releases 里最新的 apk
  let latestFile = null;
  try {
    if (fs.existsSync(RELEASES_DIR)) {
      const files = fs.readdirSync(RELEASES_DIR).filter(f => f.endsWith('.apk'));
      if (files.length) {
        files.sort((a, b) => {
          const sa = fs.statSync(path.join(RELEASES_DIR, a)).mtimeMs;
          const sb = fs.statSync(path.join(RELEASES_DIR, b)).mtimeMs;
          return sb - sa;
        });
        latestFile = files[0];
      }
    }
  } catch {}

  const out = {
    versionCode: meta?.versionCode || 0,
    versionName: meta?.versionName || '0',
    notes: meta?.notes || '',
    publishedAt: meta?.publishedAt || '',
    url: latestFile ? '/download/' + latestFile : (meta?.url || ''),
    size: 0,
  };
  if (latestFile) {
    try { out.size = fs.statSync(path.join(RELEASES_DIR, latestFile)).size; } catch {}
  }
  return out;
}

// ---------------------------------------------------------------- 认证
const AUTH_FILE = path.join(__dirname, 'auth.json');

// 只提供 API（/ws、/api/*、/download/*），不托管任何网页。
// UI 全部内置在 APK 里，服务器不对外暴露 HTML 页面。

// 图片缩略图缓存
const THUMB_DIR = path.join(__dirname, 'cache', 'thumbs');
try { fs.mkdirSync(THUMB_DIR, { recursive: true }); } catch {}

/**
 * 生成缩略图（ffmpeg），带缓存。失败返回 null 由调用方退回原图。
 * 目的：WebView 直接解码 4MB/1728x2304 的 PNG 要 ~16MB 内存，容易失败。
 */
async function makeThumb(srcFile, srcMtimeMs, maxW = 1200) {
  const crypto2 = require('crypto');
  const key = crypto2.createHash('sha1')
    .update(srcFile + ':' + srcMtimeMs + ':' + maxW).digest('hex').slice(0, 20);
  const out = path.join(THUMB_DIR, key + '.jpg');
  if (fs.existsSync(out)) return out;

  return await new Promise((resolve) => {
    const args = [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', srcFile,
      '-vf', `scale='min(${maxW},iw)':-2`,
      '-q:v', '4', '-frames:v', '1', '-update', '1',
      out,
    ];
    const cp = require('child_process').spawn('ffmpeg', args, { stdio: 'ignore' });
    const timer = setTimeout(() => { try { cp.kill('SIGKILL'); } catch {} }, 15000);
    cp.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && fs.existsSync(out) && fs.statSync(out).size > 512) resolve(out);
      else { try { fs.unlinkSync(out); } catch {} resolve(null); }
    });
    cp.on('error', () => { clearTimeout(timer); resolve(null); });
  });
}

// 工具结果里的图片：落盘缓存，前端按需拉取
const TOOL_IMG_DIR = path.join(__dirname, 'cache', 'toolimg');
const TOOL_IMAGE_MAX = 12 * 1024 * 1024;      // 单张上限 12MB
const TOOL_IMAGE_TTL = 6 * 3600 * 1000;       // 保留 6 小时
const TOOL_IMAGES = new Map();                 // id -> {file, mime, ts, size}
try { fs.mkdirSync(TOOL_IMG_DIR, { recursive: true }); } catch {}

/** 定期清理过期工具图片 */
setInterval(() => {
  const now = Date.now();
  for (const [id, v] of TOOL_IMAGES) {
    if (now - v.ts > TOOL_IMAGE_TTL) {
      try { fs.unlinkSync(v.file); } catch {}
      TOOL_IMAGES.delete(id);
    }
  }
}, 30 * 60 * 1000).unref();

const AUTH = {
  cookieName: 'pi_session',
  maxAgeMs: 30 * 24 * 3600 * 1000,   // 30 天
  failWindowMs: 10 * 60 * 1000,
  maxFails: 10,
  // 当前密码的哈希 + 派生的 cookie 签名密钥
  hash: null,
  salt: null,
  secret: null,
  source: '',      // 'file' | 'env' | 'none'
};

/** scrypt 哈希密码 */
function hashPassword(password, salt) {
  const s = salt || crypto.randomBytes(16).toString('hex');
  const h = crypto.scryptSync(password, s, 32).toString('hex');
  return { hash: h, salt: s };
}

/** 校验密码（恒定时间比较） */
function verifyPassword(password) {
  if (!AUTH.hash || !AUTH.salt) return false;
  const { hash } = hashPassword(password, AUTH.salt);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(AUTH.hash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** 由 salt+hash 派生 cookie 签名密钥，改密码后旧 cookie 自动失效 */
function deriveSecret(salt, hash) {
  return crypto.createHash('sha256').update('pi-mobile:' + salt + ':' + hash).digest();
}

function applyCredentials(hash, salt, source) {
  AUTH.hash = hash;
  AUTH.salt = salt;
  AUTH.secret = deriveSecret(salt, hash);
  AUTH.source = source;
  AUTH.enabled = true;
}

/** 启动时加载：优先 auth.json，否则用 PI_MOBILE_TOKEN 播种并落盘 */
function loadAuth() {
  try {
    if (fs.existsSync(AUTH_FILE)) {
      const j = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
      if (j && j.hash && j.salt) {
        applyCredentials(j.hash, j.salt, 'file');
        log('已加载密码（auth.json）');
        return;
      }
    }
  } catch (e) { warn('读取 auth.json 失败:', e.message); }

  if (CONFIG.token) {
    const { hash, salt } = hashPassword(CONFIG.token);
    applyCredentials(hash, salt, 'env');
    try {
      fs.writeFileSync(AUTH_FILE, JSON.stringify({ hash, salt, updatedAt: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600 });
      fs.chmodSync(AUTH_FILE, 0o600);
      log('已将 PI_MOBILE_TOKEN 写入 auth.json（以后改密码用 /api/password）');
    } catch (e) { warn('写 auth.json 失败（改密码将不可用）:', e.message); }
    return;
  }

  AUTH.enabled = false;
  AUTH.source = 'none';
  warn('⚠️  未设置密码，登录已禁用。设置 PI_MOBILE_TOKEN 或手动创建 auth.json 以启用。');
}

/** 修改密码：写文件 + 刷新内存 + 作废所有旧会话 */
function changePassword(newPassword) {
  const pw = String(newPassword || '');
  if (pw.length < 6) throw new Error('密码至少 6 位');
  if (pw.length > 200) throw new Error('密码太长');
  const { hash, salt } = hashPassword(pw);
  fs.writeFileSync(AUTH_FILE, JSON.stringify({ hash, salt, updatedAt: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600 });
  try { fs.chmodSync(AUTH_FILE, 0o600); } catch {}
  applyCredentials(hash, salt, 'file');
  log('密码已修改，所有旧会话失效');
}

function hmac(data) {
  return crypto.createHmac('sha256', AUTH.secret).update(data).digest('base64url');
}

/** 生成 session cookie 值：base64(payload).sig */
function makeSession(ip) {
  const payload = Buffer.from(JSON.stringify({ t: Date.now(), ip })).toString('base64url');
  return payload + '.' + hmac(payload);
}

/** 校验 cookie，返回 {ok, expired} */
function verifySession(cookieVal) {
  if (!cookieVal) return { ok: false };
  const i = cookieVal.lastIndexOf('.');
  if (i < 0) return { ok: false };
  const payload = cookieVal.slice(0, i);
  const sig = cookieVal.slice(i + 1);
  let expect;
  try { expect = hmac(payload); } catch { return { ok: false }; }
  const a = Buffer.from(sig), b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false };
  let obj;
  try { obj = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { return { ok: false }; }
  if (!obj.t || Date.now() - obj.t > AUTH.maxAgeMs) return { ok: false, expired: true };
  return { ok: true, data: obj };
}

/** 从请求里取会话令牌：优先 Authorization: Bearer，其次 cookie */
function extractToken(req) {
  const auth = req.headers['authorization'];
  if (typeof auth === 'string' && /^Bearer\s+/i.test(auth)) {
    return auth.replace(/^Bearer\s+/i, '').trim();
  }
  // <img>/<a> 等原生请求无法自定义头，允许 ?token= 传递
  try {
    const u = new URL(req.url, 'http://x');
    const q = u.searchParams.get('token');
    if (q) return q;
  } catch {}
  const ck = parseCookies(req);
  return ck[AUTH.cookieName] || '';
}

/** 是否已通过认证 */
function reqAuthed(req) {
  if (!AUTH.enabled) return true;
  return verifySession(extractToken(req)).ok;
}

/** CORS：允许 App 跨域访问（电容壳的 origin 不固定） */
function applyCors(req, res) {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('access-control-allow-credentials', 'true');
    res.setHeader('vary', 'Origin');
  } else {
    res.setHeader('access-control-allow-origin', '*');
  }
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type, authorization, x-pi-token');
  res.setHeader('access-control-max-age', '86400');
}

function parseCookies(req) {
  const out = {};
  const h = req.headers.cookie;
  if (!h) return out;
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim();
  return req.socket.remoteAddress || '?';
}

const failLog = new Map(); // ip -> {count, until}

// ---------------------------------------------------------------- 登录日志
const AUDIT_FILE = path.join(__dirname, 'logs', 'auth.log');
const CLIENT_LOG_FILE = path.join(__dirname, 'logs', 'client.log');
const AUDIT_MAX_LINES = 5000;
const auditBuf = [];      // 内存里保留最近的
let auditWriteStream = null;

function ensureAuditDir() {
  try {
    fs.mkdirSync(path.dirname(AUDIT_FILE), { recursive: true });
    try { fs.chmodSync(path.dirname(AUDIT_FILE), 0o700); } catch {}
  } catch (e) { warn('创建日志目录失败:', e.message); }
}

function addAudit(event, extra = {}) {
  const rec = {
    ts: new Date().toISOString(),
    event,
    ...extra,
  };
  auditBuf.push(rec);
  if (auditBuf.length > AUDIT_MAX_LINES) auditBuf.shift();
  try {
    ensureAuditDir();
    fs.appendFileSync(AUDIT_FILE, JSON.stringify(rec) + '\n', { mode: 0o600 });
    try { fs.chmodSync(AUDIT_FILE, 0o600); } catch {}
  } catch (e) { warn('写登录日志失败:', e.message); }
  return rec;
}

function readAudit(limit = 100) {
  try {
    if (!fs.existsSync(AUDIT_FILE)) return auditBuf.slice(-limit);
    const raw = fs.readFileSync(AUDIT_FILE, 'utf8').trim();
    if (!raw) return [];
    const lines = raw.split('\n');
    const out = [];
    for (let i = Math.max(0, lines.length - limit); i < lines.length; i++) {
      try { out.push(JSON.parse(lines[i])); } catch {}
    }
    return out.reverse();   // 最新在前
  } catch (e) {
    warn('读登录日志失败:', e.message);
    return [];
  }
}

/** 从 UA 粗解析设备 */
function describeUA(ua) {
  if (!ua) return '未知';
  const s = String(ua);
  const os =
    /iPhone/.test(s) ? 'iPhone' :
    /iPad/.test(s) ? 'iPad' :
    /Android/.test(s) ? 'Android' :
    /Mac OS X/.test(s) ? 'macOS' :
    /Windows/.test(s) ? 'Windows' :
    /Linux/.test(s) ? 'Linux' : '其他';
  const br =
    /Edg\//.test(s) ? 'Edge' :
    /MicroMessenger/.test(s) ? '微信' :
    /CriOS|Chrome\//.test(s) ? 'Chrome' :
    /FxiOS|Firefox\//.test(s) ? 'Firefox' :
    /Safari\//.test(s) ? 'Safari' : '';
  return br ? `${os} · ${br}` : os;
}

function isRateLimited(ip) {
  const r = failLog.get(ip);
  if (!r) return false;
  if (Date.now() > r.until) { failLog.delete(ip); return false; }
  return r.count >= AUTH.maxFails;
}

function noteFail(ip) {
  const r = failLog.get(ip) || { count: 0, until: Date.now() + AUTH.failWindowMs };
  r.count++;
  r.until = Date.now() + AUTH.failWindowMs;
  failLog.set(ip, r);
  if (failLog.size > 5000) failLog.clear();
}

function safeEq(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

/** 是否需要鉴权（token 未配置时全放开） */
function authRequired(url) {
  if (!AUTH.enabled) return false;
  if (url.pathname === '/api/login' || url.pathname === '/api/logout') return false;
  if (url.pathname === '/api/meta') return false;
  if (url.pathname === '/api/me') return false;
  if (url.pathname === '/api/version') return false;
  if (url.pathname === '/api/clientlog') return false;   // 日志上报：登录前也可能需要
  if (url.pathname.startsWith('/download/')) return false;   // APK 下载不需要登录
  // 工具图片：<img> 无法带 Authorization 头，改用 ?token= 由各自校验
  if (url.pathname.startsWith('/api/toolimg/')) return !url.searchParams.get('token');
  if (url.pathname === '/health') return false;
  return true;
}

function readBodyRaw(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const chunks = [];
    req.on('data', c => {
      n += c.length;
      if (n > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function readBody(req, limit = 8192) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const chunks = [];
    req.on('data', c => {
      n += c.length;
      if (n > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const DEBUG_REQ = process.env.PI_DEBUG_REQ === '1' || process.env.PI_DEBUG_REQ === 'true';

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const ip = clientIp(req);

  // 调试：记录所有 /api/file 请求（含是否带 token、UA、来源）
  if (DEBUG_REQ && (url.pathname === '/api/file' || url.pathname.startsWith('/api/toolimg/'))) {
    const hasTokQuery = !!url.searchParams.get('token');
    const hasAuthHdr = /^Bearer\s+/i.test(req.headers['authorization'] || '');
    const hasCookie = !!parseCookies(req)[AUTH.cookieName];
    const t0 = Date.now();
    log(`[req] ${req.method} ${url.pathname} ip=${ip} tokenQ=${hasTokQuery} authHdr=${hasAuthHdr} cookie=${hasCookie} ` +
        `ua="${(req.headers['user-agent'] || '').slice(0, 60)}" path=${url.searchParams.get('path') || ''}`);
    res.on('finish', () => log(`[req] → ${res.statusCode} ${url.pathname} ${Date.now() - t0}ms`));
  }

  // CORS 预检（APK 内置页面跨域访问）
  if (url.pathname.startsWith('/api/') || url.pathname === '/health') applyCors(req, res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // ---------- 登录 / 登出 ----------
  if (url.pathname === '/api/login' && req.method === 'POST') {
    if (!AUTH.enabled) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, note: '未配置 token，无需登录' }));
      return;
    }
    if (isRateLimited(ip)) {
      addAudit('login_blocked', { ip, ua: describeUA(req.headers['user-agent']) });
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: '尝试次数过多，请 10 分钟后再试' }));
      return;
    }
    let pw = '';
    try {
      const ct = req.headers['content-type'] || '';
      if (ct.includes('application/json')) {
        const body = JSON.parse(await readBody(req) || '{}');
        pw = String(body.password || body.token || '');
      } else {
        const q = url.searchParams.get('password') || '';
        pw = q;
      }
    } catch { /* 忽略 */ }

    if (!pw) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: '请输入访问密码' }));
      return;
    }
    if (!verifyPassword(pw)) {
      noteFail(ip);
      const fails = (failLog.get(ip) || {}).count || 1;
      addAudit('login_failed', {
        ip, ua: describeUA(req.headers['user-agent']),
        attempt: fails, reason: '密码错误',
      });
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: '密码错误' }));
      return;
    }
    failLog.delete(ip);
    const session = makeSession(ip);
    const cookie = `${AUTH.cookieName}=${encodeURIComponent(session)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(AUTH.maxAgeMs / 1000)}`;
    addAudit('login_success', { ip, ua: describeUA(req.headers['user-agent']) });
    res.writeHead(200, {
      'content-type': 'application/json',
      'set-cookie': cookie,
    });
    // token 供 APK/第三方客户端用（不走 cookie）
    res.end(JSON.stringify({ ok: true, token: session, expiresIn: Math.floor(AUTH.maxAgeMs / 1000) }));
    return;
  }

  if (url.pathname === '/api/logout') {
    addAudit('logout', { ip, ua: describeUA(req.headers['user-agent']) });
    res.writeHead(200, {
      'content-type': 'application/json',
      'set-cookie': `${AUTH.cookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
    });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // ---------- 改密码 ----------
  if (url.pathname === '/api/password' && req.method === 'POST') {
    if (!reqAuthed(req)) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: '未登录' }));
      return;
    }
    if (isRateLimited(ip)) {
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: '尝试次数过多，请稍后再试' }));
      return;
    }
    let oldPw = '', newPw = '';
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      oldPw = String(body.oldPassword || '');
      newPw = String(body.newPassword || '');
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: '请求格式错误' }));
      return;
    }
    if (!newPw) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: '新密码不能为空' }));
      return;
    }
    // 已有密码时必须验证原密码；初始无密码时允许直接设
    if (AUTH.enabled && !verifyPassword(oldPw)) {
      noteFail(ip);
      addAudit('password_change_failed', { ip, ua: describeUA(req.headers['user-agent']), reason: '原密码错误' });
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: '原密码错误' }));
      return;
    }
    try {
      changePassword(newPw);
    } catch (e) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
      return;
    }
    failLog.delete(ip);
    addAudit('password_change', { ip, ua: describeUA(req.headers['user-agent']) });
    // 旧 cookie 因 secret 变化自动失效，这里顺手签发新会话
    const session = makeSession(ip);
    const cookie = `${AUTH.cookieName}=${encodeURIComponent(session)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(AUTH.maxAgeMs / 1000)}`;
    res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': cookie });
    res.end(JSON.stringify({ ok: true, token: session, expiresIn: Math.floor(AUTH.maxAgeMs / 1000) }));
    return;
  }

  // ---------- 登录日志 ----------
  if (url.pathname === '/api/audit') {
    if (!reqAuthed(req)) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: '未登录' }));
      return;
    }
    const limit = Math.min(Number(url.searchParams.get('limit')) || 100, 1000);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, entries: readAudit(limit) }));
    return;
  }

  // ---------- 鉴权拦截 ----------
  if (authRequired(url)) {
    const cookies = parseCookies(req);
    const session = verifySession(cookies[AUTH.cookieName]);
    // 兼容旧方式：?token=xxx 也放行，并补种 cookie
    const qToken = url.searchParams.get('token');
    let authed = session.ok || reqAuthed(req);
    if (!authed && qToken && AUTH.enabled && verifySession(qToken).ok) {
      authed = true;
      res.setHeader('set-cookie',
        `${AUTH.cookieName}=${encodeURIComponent(makeSession(ip))}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(AUTH.maxAgeMs / 1000)}`);
    }
    if (!authed) {
      // 页面请求跳登录页；API 返回 401
      if (url.pathname.startsWith('/api/')) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: '未登录' }));
      } else {
        // 没有登录页可跳，直接 404（不泄露页面是否存在）
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Not Found. This server is API-only.');
        return;
      }
      return;
    }
  }

  if (url.pathname === '/api/devices') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(DEVICES.map(publicDevice)));
    return;
  }

  // ---------- 文件浏览 ----------
  if (url.pathname === '/api/files' || url.pathname === '/api/file') {
    const devId = url.searchParams.get('device') || 'local';
    const dev = DEVICES.find(d => d.id === devId) || DEVICES[0];
    const target = url.searchParams.get('path') || (dev.cwd || '/');
    try {
      if (url.pathname === '/api/files') {
        const entries = await listDir(dev, target);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, path: target, entries, home: dev.cwd || '/' }));
      } else {
        const t0 = Date.now();
        const f = await readFilePreview(dev, target);
        if (!f) {
          log(`[file] 404 dev=${devId} path=${target}`);
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: '文件不存在' }));
          return;
        }
        log(`[file] dev=${devId} path=${target} binary=${f.binary} mime=${f.mime} size=${f.size} ` +
            `dataLen=${f.data?.length ?? '-'} ${Date.now() - t0}ms msg=${f.messages ? 'has-msg' : ''}`);
        if (f.binary) {
          // ?thumb=1：转成小尺寸 JPG，避免 WebView 解码大图失败
          const wantThumb = url.searchParams.get('thumb') === '1';
          // w 参数：指定最大宽度（默认 1200）；view=1 表示全屏查看（1600）
          const reqW = Number(url.searchParams.get('w') || 0);
          const viewMode = url.searchParams.get('view') === '1';
          const maxW = reqW > 0 ? Math.min(reqW, 2400) : (viewMode ? 1600 : 1200);
          if ((wantThumb || viewMode || reqW > 0) && /^image\//.test(f.mime) && f.mime !== 'image/svg+xml') {
            let thumb = null;
            try {
              // 本地文件直接用路径；远程设备已拿到 buffer，先落临时文件
              const localPath = isRemote(dev) ? null : (target.startsWith('~')
                ? require('path').join(require('os').homedir(), target.slice(1))
                : target);
              if (localPath && fs.existsSync(localPath)) {
                const st2 = fs.statSync(localPath);
                thumb = await makeThumb(localPath, st2.mtimeMs, maxW);
              } else {
                const tmp = path.join(THUMB_DIR, 'src-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.bin');
                fs.writeFileSync(tmp, f.data);
                thumb = await makeThumb(tmp, Date.now(), maxW);
                try { fs.unlinkSync(tmp); } catch {}
              }
            } catch (e) { warn('缩略图生成失败:', e.message); }

            if (thumb) {
              const tb = fs.readFileSync(thumb);
              log(`[thumb] ${f.name} ${f.size} → ${tb.length} 字节`);
              res.writeHead(200, {
                'content-type': 'image/jpeg',
                'content-length': tb.length,
                'cache-control': 'private, max-age=86400, immutable',
                'etag': '"' + Buffer.from(f.name).toString('hex').slice(0, 16) + '-' + maxW + '-' + tb.length + '"',
                'x-content-type-options': 'nosniff',
                'x-thumb': '1',
                'x-width': String(maxW),
              });
              res.end(tb);
              return;
            }
            log(`[thumb] 生成失败，回退原图: ${f.name}`);
          }

          // 直接返回二进制（图片等）
          res.writeHead(200, {
            'content-type': f.mime,
            'cache-control': 'no-cache',
            'content-disposition': 'inline; filename="' + encodeURIComponent(f.name) + '"',
            'x-content-type-options': 'nosniff',
            'x-orig-size': String(f.size),
          });
          res.end(f.data);
        } else {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            ok: true, name: f.name, size: f.size, truncated: f.truncated,
            binary: false, mime: f.mime, text: f.text,
          }));
        }
      }
    } catch (e) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }
  // ---------- 图床：状态 / 上传 ----------
  if (url.pathname === '/api/imghost/status') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      configured: imgHostReady(),
      repo: IMGHOST.repo,
      dir: IMGHOST.dir,
      cdn: IMGHOST.cdnBase || 'raw.githubusercontent.com',
    }));
    return;
  }

  if (url.pathname === '/api/imghost/upload' && req.method === 'POST') {
    try {
      if (!imgHostReady()) throw new Error('图床未配置');
      // 请求体：{ filename, mime, data(base64) }，也可直接上传原始二进制
      const ct = String(req.headers['content-type'] || '');
      let buf, filename, mime;

      if (ct.includes('application/json')) {
        const body = JSON.parse(await readBody(req, 24 * 1024 * 1024) || '{}');
        if (!body.data) throw new Error('缺少 data（base64）');
        buf = Buffer.from(String(body.data).replace(/^data:[^;]+;base64,/, ''), 'base64');
        filename = body.filename || 'image.png';
        mime = body.mime || 'application/octet-stream';
      } else {
        buf = await readBodyRaw(req, 24 * 1024 * 1024);
        filename = String(url.searchParams.get('filename') || 'image.png');
        mime = ct || 'application/octet-stream';
      }

      if (!buf || !buf.length) throw new Error('空文件');
      if (buf.length > 20 * 1024 * 1024) throw new Error('文件过大（上限 20MB）');

      const r = await uploadToImageHost(buf, filename, mime);
      log(`[imghost] 上传成功 ${r.path} (${buf.length} 字节)`);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ...r, size: buf.length }));
    } catch (e) {
      warn('[imghost] 上传失败:', e.message);
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // ---------- 客户端日志上报 ----------
  if (url.pathname === '/api/clientlog' && req.method === 'POST') {
    try {
      const body = await readBody(req, 256 * 1024);
      let payload;
      try { payload = JSON.parse(body); } catch { payload = { raw: body }; }

      const ua = req.headers['user-agent'] || '';
      const rec = {
        ts: new Date().toISOString(),
        ip: clientIp(req),
        ua: ua.slice(0, 120),
        appVersion: payload.appVersion || '',
        platform: payload.platform || '',
        kind: payload.kind || 'log',
        message: String(payload.message || '').slice(0, 4000),
        context: payload.context ? String(JSON.stringify(payload.context)).slice(0, 8000) : '',
        logs: Array.isArray(payload.logs) ? payload.logs.slice(-200).map(l => String(l).slice(0, 1000)) : [],
      };

      // 保证目录存在
      try { fs.mkdirSync(path.dirname(CLIENT_LOG_FILE), { recursive: true }); } catch {}

      // 轮转：超过 5MB 就移走
      try {
        if (fs.existsSync(CLIENT_LOG_FILE) && fs.statSync(CLIENT_LOG_FILE).size > 5 * 1024 * 1024) {
          fs.renameSync(CLIENT_LOG_FILE, CLIENT_LOG_FILE + '.1');
        }
      } catch {}

      fs.appendFileSync(CLIENT_LOG_FILE, JSON.stringify(rec) + '\n');
      log(`[clientlog] ${rec.kind} v${rec.appVersion} ${rec.message.slice(0, 120)}`);

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  if (url.pathname === '/api/me') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ authEnabled: AUTH.enabled, authed: reqAuthed(req), version: 1 }));
    return;
  }
  // ---------- 工具结果图片 ----------
  if (url.pathname.startsWith('/api/toolimg/')) {
    const id = url.pathname.slice('/api/toolimg/'.length).replace(/[^\w-]/g, '');
    const rec = TOOL_IMAGES.get(id);
    if (!rec || !fs.existsSync(rec.file)) { res.writeHead(404); res.end('not found'); return; }
    const st = fs.statSync(rec.file);
    res.writeHead(200, {
      'content-type': rec.mime,
      'content-length': st.size,
      'cache-control': 'private, max-age=3600',
    });
    fs.createReadStream(rec.file).pipe(res);
    return;
  }

  // ---------- APK 版本 / 下载 ----------
  if (url.pathname === '/api/version') {
    const info = readApkInfo();
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(info));
    return;
  }
  if (url.pathname.startsWith('/download/') && url.pathname.endsWith('.apk')) {
    const name = path.basename(url.pathname);
    const file = path.join(__dirname, 'releases', name);
    if (!fs.existsSync(file)) { res.writeHead(404); res.end('not found'); return; }
    const st = fs.statSync(file);
    res.writeHead(200, {
      'content-type': 'application/vnd.android.package-archive',
      'content-length': st.size,
      'content-disposition': 'attachment; filename="' + name + '"',
      'cache-control': 'no-cache',
    });
    fs.createReadStream(file).pipe(res);
    return;
  }

  if (url.pathname === '/health') { res.writeHead(200); res.end('ok'); return; }

  // 不托管任何网页：所有非 API 路径一律 404
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('Not Found. This server is API-only.\n安装 APK 使用：/download/pi-mobile-<版本>.apk');
});

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  const url = new URL(req.url, 'http://x');
  const token = url.searchParams.get('token') || req.headers['x-pi-token'];
  if (AUTH.enabled) {
    // token 参数 / 会话 cookie / Bearer 任一种
    let ok = !!(token && verifySession(token).ok) || reqAuthed(req);
    if (!ok) {
      ws.send(JSON.stringify({ t: 'fatal', message: '未登录或会话已过期' }));
      ws.close(4001, 'unauthorized');
      return;
    }
  }

  const send = (o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
  send({ t: 'devices', devices: DEVICES.map(publicDevice) });

  let cur = null;
  const attach = (deviceId) => {
    const dev = DEVICES.find(d => d.id === deviceId) || DEVICES[0];
    if (!sessions.has(dev.id)) {
      const s = new PiSession(dev);
      s.start();
      sessions.set(dev.id, s);
    }
    const s = sessions.get(dev.id);
    if (cur && cur !== s) cur.subscribers.delete(ws);
    cur = s;
    s.subscribe(ws);
    send({ t: 'attached', deviceId: dev.id });
  };

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return send({ t: 'fatal', message: 'bad json' }); }

    try {
      switch (msg.t) {
        case 'attach':
          attach(msg.deviceId || 'local');
          break;

        case 'add_device': {
          try {
            const dev = await upsertDeviceAuto(msg.device || {});
            send({ t: 'devices', devices: DEVICES.map(publicDevice) });
            // 回探测到的路径信息
            const full = DEVICES.find(x => x.id === dev.id);
            send({ t: 'device_saved', device: dev, probed: {
              cwd: full.cwd, sessionDir: full.sessionDir,
              pathPrefix: full.pathPrefix, helperPath: full.helperPath,
            }});
          } catch (e) {
            send({ t: 'error', message: '添加失败: ' + e.message, command: 'add_device' });
          }
          break;
        }

        case 'update_device': {
          try {
            const dev = await upsertDeviceAuto(msg.device || {});
            send({ t: 'devices', devices: DEVICES.map(publicDevice) });
            const full = DEVICES.find(x => x.id === dev.id);
            send({ t: 'device_saved', device: dev, probed: {
              cwd: full.cwd, sessionDir: full.sessionDir,
              pathPrefix: full.pathPrefix, helperPath: full.helperPath,
            }});
          } catch (e) {
            send({ t: 'error', message: '保存失败: ' + e.message, command: 'update_device' });
          }
          break;
        }

        case 'delete_device': {
          try {
            const id = String(msg.deviceId || '');
            if (cur && cur.dev.id === id) cur = null;
            removeDevice(id);
            send({ t: 'devices', devices: DEVICES.map(publicDevice) });
            send({ t: 'notice', text: '已删除设备 ' + id });
          } catch (e) {
            send({ t: 'error', message: '删除失败: ' + e.message, command: 'delete_device' });
          }
          break;
        }

        case 'test_device': {
          try {
            const id = msg.deviceId ? String(msg.deviceId) : null;
            const dev = id ? DEVICES.find(d => d.id === id) : { ...(msg.device || {}), type: 'ssh', port: Number(msg.device?.port) || 22, username: msg.device?.username || 'root', privateKeyPath: msg.device?.privateKeyPath?.replace(/^~(?=\/)/, require('os').homedir()) };
            if (!dev) throw new Error('设备不存在');
            send({ t: 'device_test_start', deviceId: dev.id, label: dev.label });
            const r = await testDevice(dev);
            send({ t: 'device_test_result', deviceId: dev.id, label: dev.label || dev.host || dev.id, ...r });
          } catch (e) {
            send({ t: 'error', message: '测试失败: ' + e.message, command: 'test_device' });
          }
          break;
        }

        case 'list_devices':
          send({ t: 'devices', devices: DEVICES.map(publicDevice) });
          break;

        case 'prompt': {
          if (!cur) return send({ t: 'fatal', message: '未连接设备' });
          let text = String(msg.text || '').trim();
          const files = Array.isArray(msg.files) ? msg.files : [];

          // 附件：文本直接拼进 prompt，图片走 images 字段
          let images = [];
          if (files.length) {
            const built = await buildPromptWithFiles(cur.dev, text, files);
            text = built.text;
            images = built.images;
          }
          if (!text && !images.length) return;

          // 斜杠命令原样转发（带附件时不走这条）
          const behavior = cur.state.isStreaming ? (msg.mode === 'steer' ? 'steer' : 'followUp') : undefined;
          await cur.prompt(text, behavior, images);
          break;
        }

        case 'abort':
          if (cur) { await cur.send('clear_queue', {}, 8000).catch(() => {}); await cur.send('abort', {}, 15000).catch(() => {}); }
          break;

        case 'new_session':
          if (cur) { cur.history = []; cur.streaming = null; await cur.send('new_session', {}, 15000); await cur.refreshState(); send({ t: 'cleared' }); }
          break;

        case 'list_sessions':
          try {
            const sessions = await listSessions(cur?.dev);
            send({ t: 'sessions', sessions, currentPath: cur?.sessionPath || null });
          } catch (e) {
            send({ t: 'error', message: '列取会话失败: ' + e.message, command: 'list_sessions' });
          }
          break;

        case 'open_session': {
          if (!cur) return send({ t: 'error', message: '未连接设备' });
          const sp = msg.path;
          if (!sp) return send({ t: 'error', message: '缺少会话路径' });
          try {
            const mode = await cur.switchTo(sp);
            const msgs = await readSessionMessages(sp, cur.dev);
            cur.history = msgs.map(m => cur.normalize(m));
            send({ t: 'session_opened', path: sp, mode, messages: cur.history, state: cur.state });
            await cur.refreshState();
            send({ t: 'sessions', sessions: await listSessions(cur.dev), currentPath: cur.sessionPath });
          } catch (e) {
            send({ t: 'error', message: '打开会话失败: ' + e.message, command: 'open_session' });
          }
          break;
        }

        case 'rename_session': {
          try {
            const sp = String(msg.path || '');
            const name = String(msg.name || '').trim();
            if (!sp) throw new Error('缺少路径');
            const dev = cur?.dev;
            if (dev && (dev.type === 'ssh' || dev.host)) {
              await remoteSessionOp(dev, 'rename', sp, name);
            } else {
              if (!SessionManager) throw new Error('SessionManager 不可用');
              SessionManager.open(sp).appendSessionInfo(name);
            }
            send({ t: 'sessions', sessions: await listSessions(dev), currentPath: cur?.sessionPath || null });
            toastOk(send, '已重命名');
          } catch (e) {
            send({ t: 'error', message: '重命名失败: ' + e.message, command: 'rename_session' });
          }
          break;
        }

        case 'delete_session': {
          try {
            const sp = String(msg.path || '');
            if (!sp) throw new Error('缺少路径');
            if (cur && cur.sessionPath === sp) throw new Error('不能删除当前正在使用的会话');
            const dev = cur?.dev;
            if (dev && (dev.type === 'ssh' || dev.host)) {
              await remoteSessionOp(dev, 'delete', sp);
            } else {
              fs.unlinkSync(sp);
            }
            send({ t: 'sessions', sessions: await listSessions(dev), currentPath: cur?.sessionPath || null });
            toastOk(send, '已删除');
          } catch (e) {
            send({ t: 'error', message: '删除失败: ' + e.message, command: 'delete_session' });
          }
          break;
        }

        case 'get_messages':
          if (cur) {
            const d = await cur.send('get_messages', {}, 15000);
            send({ t: 'messages', messages: (d.messages || []).map(m => cur.normalize(m)) });
          }
          break;

        case 'get_state':
          if (cur) {
            const d = await cur.send('get_state', {}, 10000);
            if (d) {
              Object.assign(cur.state, d);
              // pi 不返回 cwd，从设备配置补
              if (!cur.state.cwd) cur.state.cwd = cur.dev.cwd || '';
              cur.broadcastState();
            }
          }
          break;

        case 'get_models':
          if (cur) {
            const d = await cur.send('get_available_models', {}, 15000);
            send({ t: 'models', models: d.models || d || [] });
          }
          break;

        case 'set_model':
          if (cur) {
            await cur.send('set_model', { provider: msg.provider, modelId: msg.modelId }, 20000);
            await cur.refreshState();
          }
          break;

        case 'cycle_model':
          if (cur) { await cur.send('cycle_model', {}, 20000); await cur.refreshState(); }
          break;

        case 'compact':
          if (cur) { await cur.send('compact', {}, 60000); }
          break;

        case 'restart_proc':
          if (cur) { cur.stop(); setTimeout(() => cur.start(), 500); send({ t: 'notice', text: '重启中…' }); }
          break;

        case 'ui_response':
          if (cur) { cur.send('noop', {}).catch(()=>{}); }
          if (cur && cur.proc) {
            cur.proc.stdin.write(JSON.stringify({ type: 'extension_ui_response', ...msg.payload }) + '\n');
          }
          break;

        case 'ping':
          send({ t: 'pong', ts: Date.now() });
          break;

        default:
          send({ t: 'fatal', message: `未知命令 ${msg.t}` });
      }
    } catch (e) {
      send({ t: 'error', message: e.message, command: msg.t });
    }
  });

  attach('local');
});

// 心跳，清理僵尸连接
const hb = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, CONFIG.heartbeatMs);
hb.unref?.();

loadAuth();

server.listen(CONFIG.port, CONFIG.host, () => {
  log(`pi-mobile 已启动: http://${CONFIG.host}:${CONFIG.port}  [仅 API，不托管页面]`);
  log(`pi bin: ${CONFIG.piBin}  sessionDir: ${CONFIG.sessionDir}`);
});

function shutdown(sig) {
  log(`收到 ${sig}，退出`);
  for (const s of sessions.values()) s.stop();
  setTimeout(() => process.exit(0), 800);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (e) => warn('uncaught', e));
process.on('unhandledRejection', (e) => warn('unhandled', e && e.message));
