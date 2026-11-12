# pi-mobile

手机端控制多台机器上的 pi coding agent。一个 Node 进程，一个内置全部界面的 Android APK。

```
APK ──WebSocket──> server.js ┬─ spawn ──> 本机 pi --mode rpc
                             └─ ssh2  ──> 远程 pi --mode rpc
```

服务器**只提供 API**，不托管任何网页。

## 快速开始

```bash
npm install

# 首次启动必须设密码（不设则无密码保护）
PI_MOBILE_TOKEN='你的密码' ./service.sh start
```

然后在手机装 APK，打开后填服务器地址即可。

### 1. 起服务

```bash
./service.sh start          # 后台启动
./service.sh status         # 状态 + 健康检查
./service.sh logs           # 跟日志
./service.sh restart        # 重启
./service.sh stop           # 停止
```

首次启动设密码：

```bash
PI_MOBILE_TOKEN='你的密码' ./service.sh start
```

密码只在此次生效，之后写入 `auth.json`（scrypt 哈希，权限 600），
后续启动不再读环境变量。改密码用 App 内「设置 → 修改登录密码」。

### 2. 装 APK

下载地址：`http://<服务器IP>:8848/download/pi-mobile-<版本>.apk`

首次安装后，后续更新在 App 内「设置 → 检查更新」完成。
落后 2 个版本会强制更新。

### 暴露的路径

只有这些，其余一律 404：

| 路径 | 说明 |
|---|---|
| `/api/*` | 接口（需 Bearer token 或 cookie） |
| `/ws` | WebSocket（需 `?token=`） |
| `/download/*.apk` | APK 下载（免登录） |
| `/health` | 健康检查 |

**没有任何网页**：`/`、`/login`、`/index.html` 全部 404。

### 3. 添加远程设备

App 里点顶部设备名 →「＋ 添加 SSH 设备」，填地址、用户名、密码或密钥即可。

**目标机零安装**：不需要部署任何脚本。会话列表和读取通过
`node -e` 执行内联脚本调用 pi 自带的 `SessionManager`，磁盘上不新增文件。

目标机只需：SSH 可登录 + 装了 pi（有 node）。

对应的 `devices.json` 手写方式见下文。

## 多设备（SSH）

`devices.json`：

```json
[
  { "id": "local", "label": "本机", "type": "local", "cwd": "/root" },
  {
    "id": "srv-a", "label": "服务器A", "type": "ssh",
    "host": "192.168.1.100", "port": 22, "username": "root",
    "privateKeyPath": "~/.ssh/id_ed25519",
    "cwd": "/root/projects",
    "sessionDir": "/root/.pi/agent/sessions",
    "pathPrefix": "/root/.nvm/versions/node/v22.19.0/bin"
  }
]
```

| 字段 | 说明 |
|---|---|
| `host` / `port` / `username` | SSH 目标 |
| `privateKeyPath` / `password` | 认证（不填则自动找 `~/.ssh/id_ed25519`、`id_rsa`） |
| `cwd` | pi 的工作目录 |
| `sessionDir` | **远端**的会话目录（不是本机的） |
| `escalate` | `true` 时用 `sudo -n` 提权到 root |
| `pathPrefix` | 远端的 node bin 目录（一般不用填，自动探测） |
| `piBin` | 远端 pi 命令，默认 `pi` |

### 远端零安装

连 SSH 设备**不需要在目标机安装任何东西**。会话列表、读取、重命名、删除都是
通过一条 shell 命令直接操作 pi 的会话文件（`~/.pi/agent/sessions/*.jsonl`）完成。

目标机只需满足：

- SSH 可登录
- 装了 `pi`（会话目录存在）
- 有 `find` / `head` / `awk` / `rm`（任何 Linux 都自带）

不需要 node，不需要拷贝脚本，不需要任何部署步骤。

### 在 App 里添加设备

不用改配置文件。手机端点顶栏设备名 →「＋ 添加 SSH 设备」，填：

| 字段 | 说明 |
|---|---|
| 名称 | 随便填 |
| IP / 主机 | 目标机地址 |
| 端口 | 默认 22 |
| 用户名 | SSH 用户 |
| 认证方式 | **密码** 或 **密钥** |
| 密钥 | 「选择密钥文件」上传，或「粘贴密钥」直接贴 PEM 内容 |
| 提权到 root 运行 | pi 装在 root 下时勾选（需免密 sudo） |

**工作目录、会话目录、node 目录、helper 路径全部自动探测**，不用管。
点「测试连接」会逐项检查：SSH → sudo → pi → node → helper。

### 提权到 root

很多机器的 pi 是用 root 装的（`~/.pi/agent/bin/pi`），普通用户看不到。
勾上「提权到 root 运行」后，所有远程命令变成：

```bash
sudo -n -H bash -lc '<cmd>'
```

要求目标机配好**免密 sudo**：

```bash
# 在目标机上
echo "ubuntu ALL=(ALL) NOPASSWD:ALL" | sudo tee /etc/sudoers.d/pi-mobile
sudo chmod 440 /etc/sudoers.d/pi-mobile
```

不满足时「测试连接」会明确报 `无法提权到 root（sudo 需要密码）`。

### ⚠️ pathPrefix 是多设备最容易踩的坑

SSH 非交互式 shell 的 `PATH` **和你登录时不一样**。典型症状：

```
SyntaxError: Invalid regular expression flags   ← node v18 跑 pi
pi: command not found                            ← 找不到 pi
```

原因：`pi` 的 shebang 是 `#!/usr/bin/env node`，走 `PATH`。nvm/fnm 装的 node 不在
SSH 的默认 `PATH` 里，于是用了系统的老 node。

解决：在 `devices.json` 里写死 node bin 目录。

```bash
# 在被控机上查
ssh srv-a 'which node; node -v'
# 如果输出 /usr/bin/node + v18，而 pi 需要 v22：
ssh srv-a 'ls ~/.nvm/versions/node/*/bin/node'
# → 把那个目录填进 pathPrefix
```

本项目的实现是把 `export PATH=<pathPrefix>:$PATH` 前置到远程命令，所以
`pi` 和它的 shebang node 都会用对版本。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `8848` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `PI_MOBILE_TOKEN` | 空 | 初始登录密码（仅首次启动用，之后读 auth.json） |
| `PI_BIN` | `pi` | 本机 pi 路径 |
| `PI_CWD` | 当前目录 | 本机 pi 工作目录 |
| `PI_SESSION_DIR` | `~/.pi/agent/sessions` | 本机会话目录 |
| `PI_DEVICES_FILE` | `./devices.json` | 设备配置文件 |
| `PI_EXTRA_DEVICES` | 空 | JSON 数组，追加设备（可与文件并存） |

## 功能

**对话**
- 流式输出，文本 / 思考 / 工具调用分块
- 工具卡片：命令 + 耗时 + 输出，失败标红
- 中断（`abort` + `clear_queue`）
- 流式中再发消息自动 `followUp` 排队

**对话列表**（顶栏「☰ 对话」）
- 列出当前设备上所有历史会话
- 打开 = RPC `switch_session`（失败自动重启进程 + `--session`）
- 重命名、删除
- **跨设备**：切到 SSH 设备后列表读的是那台机器的会话

**断线恢复**
- 手机断网重连补发历史 + 正在流式的块
- 页面从后台恢复自动重连

**文件**
- 目录浏览 + 文本/图片预览（本机 fs、远程 SSH）
- 文件/目录「加入对话」：文本拼 prompt、图片走 images、目录展开成树

**其它**
- 设备切换（本机 / 任意 SSH 机）
- 模型切换、压缩、新会话、重启 pi 子进程
- 扩展 UI 交互（`select`/`confirm`/`input`）转底部对话框

## 文件浏览

顶栏「🗀 文件」打开当前设备的目录浏览器。

- **本机**：直接读磁盘（`fs`）
- **远程**：走 SSH（`find -printf` / `base64`），自动提权
- 目录优先、名称排序，面包屑可点回退
- 点文件预览：文本（≤256KB）/ 图片（≤10MB）
- 自动忽略 `node_modules` `.git` `dist` `__pycache__` `.venv` 等
- **只读**，不提供写/删

### 加入对话

文件浏览器里每行右侧的 `＋` 可多选（最多 6 项），底部「加入对话」把内容挂到输入框上方，
下次发消息时一起送给模型。也可在文件预览页点右上角「加入对话」。

| 类型 | 处理方式 |
|---|---|
| 文本文件 | 内容以 ```` ```路径\n内容``` ```` 形式拼进 prompt（单文件 ≤200KB） |
| 图片 | 走 RPC 的 `images` 字段（base64，≤5MB，最多 4 张） |
| 目录 | **递归展开成树形文本**（深度 ≤3，最多 200 项），自动忽略 `node_modules` 等 |
| 二进制 | 只给出路径和大小提示 |

远程设备上的目录用一条 `find` 拿整棵树，不会多次开 SSH。
pi 收到后直接就能看到内容，**不需要自己再 `ls` / `read`**，省一轮工具调用。

API：

```bash
GET /api/files?device=local&path=/root/project    # 列目录
GET /api/file?device=local&path=/root/a.js        # 预览（文本 JSON / 图片二进制）
```

切换设备后文件浏览器自动跟到那台机器的 `cwd`。

## 斜杠命令

本地命令不走模型：`/new` `/compact` `/stop` `/model` `/status` `/help`。
其它 `/xxx`（如 pi-goal-x 的 `/goal`）原样转发给 pi。

## 登录

配置 `PI_MOBILE_TOKEN` 后整个站点需要登录：

```bash
PI_MOBILE_TOKEN=$(openssl rand -hex 16) node server.js
```

- 访问任何页面都会跳转 `/login`
- 输入密码 = `PI_MOBILE_TOKEN`
- 登录后签发 **HttpOnly + SameSite=Lax** 的会话 cookie，有效期 30 天
- 会话用 HMAC-SHA256 签名，服务器**不存 session**，重启不掉线
- 同一 IP 10 分钟内错 10 次 → 锁定 10 分钟（429）
- WS 连接同样校验 cookie（也兼容旧的 `?token=xxx` 链接）
- 菜单「退出登录」清 cookie

### 修改密码

菜单 →「修改登录密码」，输入当前密码 + 新密码（≥6 位）。

- 密码以 **scrypt** 哈希存于 `auth.json`（权限 600），不存明文
- 改完后**所有设备立即掉线**（cookie 签名密钥由密码派生，一变全废）
- 改完当前页面自动续签新 cookie，无需重新登录

首次启动时若设置了 `PI_MOBILE_TOKEN`，会**自动写入 auth.json**，之后就不再读环境变量了：

```bash
PI_MOBILE_TOKEN=初始密码 node server.js
# → 生成 auth.json，日志提示"已将 PI_MOBILE_TOKEN 写入 auth.json"
```

想重置密码就删掉 `auth.json` 重启。

### 登录日志

菜单 →「登录日志」，记录最近 120 条（磁盘保留不限）：

| 事件 | 颜色 |
|---|---|
| 登录成功 | 绿 |
| 密码错误 | 红（多次会标「第 N 次」） |
| 触发限流 | 黄 |
| 修改密码 / 改密失败 | 蓝 / 红 |
| 退出登录 | 灰 |

每条含时间、IP、设备（UA 粗解析，如 `iPhone · Safari`）。
存储位置 `logs/auth.log`（JSONL，权限 600），可直接 `tail -f`：

```bash
tail -f logs/auth.log | jq -r '"\(.ts) \(.event) \(.ip) \(.ua)"'
```

也可从 API 拉：`GET /api/audit?limit=200`

未设密码且没有 `auth.json` 时**不启用登录**，谁都能访问 —— 局域网自用可以，公网千万别。

## 安全

- `PI_MOBILE_TOKEN` 为空时，任何能访问端口的人都能控制你的 pi —— **别裸奔公网**
- 登录 cookie 走明文 HTTP 时仍可被中间人截获，公网请配 HTTPS 反代
- 建议：只监听内网 / 走 WireGuard / 前置 HTTPS
- SSH 私钥只在 server 端读取，手机不接触私钥
- 上传的私钥存于 `~/.pi-mobile/keys/*.pem`，权限 600

## 结构

```
server.js                    后端：WS + 双 transport（spawn / ssh2）
service.sh                   服务管理（start/stop/restart/status/logs）
publish-apk.sh               发版：读 APK 版本 → 更新 apk-version.json
devices.example.json         设备配置示例
releases/                    APK 存放（不发到 git）
```

## 已知限制

- 历史超 150 条只渲染尾部（防手机卡顿）
- 远端会话读取依赖目标机有 node（`node -e` 内联脚本），可用 `PI_PKG` 指定 pi 包位置
- 每个设备一个常驻 pi 进程，`maxSessions` 未做上限控制
- 图片全屏查看会生成 1600px JPEG 缩略图，缓存 6 小时后清理
