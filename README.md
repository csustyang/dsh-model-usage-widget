# dsh-model-usage-widget

在 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）Web 界面侧边栏底部，聚合展示**模型配置里所有提供方**的大模型用量。

适配 DSH 0.1.5-rc.1。静态双面组合插件（host route + 预构建 client bundle），无动态 Cordis runner、无会话唤醒——进程内只渲染一次，用户全程无感。

## 功能特性

- **数据来源 = 模型配置**：读取 settings 服务 `llm-deepseek`（内置 DeepSeek 路由）与 `llm-pi-ai`（自定义提供方字典，即「模型」面板编辑的列表），密钥经凭据 seam（`.credentials.yaml` refs / 环境变量）解析，插件自身不存储任何凭据
- **紧凑行**：每排 3 个 chip，≤3 个模型占一行、更多自动折为多排（每排 3 个），无截断
  - **宽栏**：每模型一个「品牌图标 + 代表数字」chip（DeepSeek 鲸鱼 / MiniMax / 火山方舟火山标 / StepFun，Simple Icons 与官网 favicon 内联，无图标的提供方回退品牌色字母徽章） —— DeepSeek 显余额、MiniMax/方舟显**水位最高的窗口**百分比（多限额窗口动态取最大，颜色按水位）
  - **窄栏 rail（折叠态）**：一个用量图标 + 数量角标（任一提供方异常时角标变红）
- **详情弹窗**：点击聚合行弹出，顶部为模型 Tab（品牌色徽章，超高自动换行、限高滚动）；点 Tab 只看该模型的详情卡 —— 余额 / 用量进度条 + 重置倒计时 / 登录认证按钮
- **支持三类提供方**：
  - **DeepSeek**：官方 `GET /user/balance` → 余额（CNY）
  - **MiniMax**：`GET /v1/api/openplatform/coding_plan/remains` → Coding Plan 近5小时/近一周用量（剩余百分比语义，用量 = 100 − 剩余）
  - **火山方舟**：走本机 `arkcli` CLI 读取（usage plan + 席位里程碑）；未登录/过期时点「登录认证」在本机拉起 `arkcli auth login volc-sso`（浏览器 SSO + 本地回环回调），完成后状态自动刷新。支持**多账号**：
    - IAM 子账号（默认）：arkcli SSO 登录态
    - 个人账号（独立 profile）：先 `arkcli --profile <名字> auth login volc-sso`（浏览器里**用个人账号**登录一次），再在凭据 seam 增加引用 `<apiKeyEnv>_PROFILE: <名字>`，widget 即按该 profile 的身份查询
  - **StepFun**：`GET /v1/accounts` → 账户余额（CNY，含代金券）
- **水位居色**：用量按「用量 vs 周期时间进度」编码 —— 绿=充足（落后于时间节奏）/ 黄=超额使用 / 红=明显超额（领先 15pt 以上）或 ≥90%
- 样式跟随 DSH 主题（`--dsw-alias-*` token）；60s 轮询 + host 侧 60s 缓存；`?force=1` 强刷

## 前置条件

1. DSH ≥ 0.1.5-rc.1（`dsh` CLI 在 PATH），使用 web（或任意）profile
2. DeepSeek / MiniMax 用量：对应提供方的 API Key（见下文「配置」）
3. 火山方舟用量：本机已安装并登录 `arkcli`：

   ```bash
   npm i -g @volcengine/ark-cli
   arkcli auth login volc-sso
   arkcli usage plan --format json   # 能返回 JSON 即可
   ```

   无 arkcli 时方舟行降级为「未配置」提示，不影响其他提供方

## 安装

本地目录安装（开发机推荐，`link:` 指向源码目录，改完重启即生效）：

```bash
dsh plugin --profile web add link:C:/workspace/github/dsh-model-usage-widget
```

`dsh plugin add` 会把包写入 profile 依赖，并因包声明了 `dsh.bundle` 自动追加到 `dsh.profile.bundles` 层列表。然后**重启 DSH** 生效。

也可从其他来源安装（`lib/client.js` 为预构建产物，目标机无需构建）：

```bash
pnpm pack                                                    # 包目录内打出 tgz
dsh plugin --profile web add ./dsh-model-usage-widget-0.1.0.tgz
# 或 git / npm 源
```

> 本插件设计上**取代** dsh-ark-usage-widget（同槽位 `sidebar.footer.action`），装好后建议移除旧 widget：
>
> ```bash
> dsh plugin --profile web remove dsh-ark-usage-widget
> ```

## 配置

### DeepSeek / MiniMax（API Key 型）

1. 打开 DSH「模型」面板，确认提供方条目的 `apiKeyEnv` 字段（即凭据引用名，内置 DeepSeek 默认 `DEEPSEEK_API_KEY`）
2. 凭据二选一：
   - DSH 凭据 seam：在 `.credentials.yaml` 写入该引用名对应的密钥
   - 环境变量：直接设同名环境变量（fallback 路径）

> 安全规则：密钥只走 `Authorization: Bearer` 头，绝不放 query string（query 会进错误/代理/访问日志）。

### 火山方舟（SSO 型 / AK-SK 型）

Coding Plan 用量与 API 密钥体系不通（SSO/STS），**无需配置模型密钥**；只需本机 `arkcli` 已登录（见前置条件）。登录过期时点弹窗里的「登录认证」重新授权。

**多账号**：可同时配置多个火山提供方（如 IAM 子账号 + 个人账号）：
- IAM 子账号：走 arkcli 默认 profile 的 SSO 登录态（零配置）
- 个人账号：两步——① `arkcli --profile volcengine-p auth login volc-sso`（浏览器里用**个人账号**登录，profile 名自定义）；② `.credentials.yaml` 增加引用 `VOLCENGINE_P_API_KEY_PROFILE: volcengine-p`（`<apiKeyEnv>_PROFILE` → profile 名）。widget 即按该 profile 查询个人账号的席位用量

## 数据链路与端点

| 提供方 | 端点 | 认证 | 失败降级 |
|---|---|---|---|
| deepseek-official | `https://api.deepseek.com/user/balance` | Bearer（`DEEPSEEK_API_KEY`） | 未配置/未授权 → 登录认证跳转 platform.deepseek.com |
| minimax-cn | `https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains`（取 `model_remains[]` 中 `model_name=general`） | Bearer（`MINIMAX_CN_API_KEY`） | 同上 → platform.minimaxi.com |
| volcengine-ark | `arkcli usage plan` + `usage.get_seat_info[_usage]`（本机 CLI，SSO 凭据） | —（SSO 体系，无 API 密钥） | 未登录 → 「登录认证」触发 `arkcli auth login volc-sso`；无 arkcli → 「未配置」 |
| stepfun | `https://api.stepfun.com/v1/accounts` | Bearer（`STEPFUN_API_KEY`） | 未配置/未授权 → 登录认证跳转 platform.stepfun.com |
| 其他自定义提供方 | — | — | 显示「不支持」占位 |

提供方识别：id/baseURL 命中 minimax（minimaxi.com / minimax.io）→ MiniMax 策略；命中 deepseek / deepseek.com → DeepSeek 余额策略；命中 stepfun / stepfun.com → StepFun 余额策略；命中 volcengine / ark / volces.com → arkcli 策略；其余 → 不支持。

## 工作原理

- **HOST 半**（`index.js`，组合插件行）：注册两条同源路由，均经 `connection.requestRejection` 信任围栏（Host/Origin + 登录 cookie），仅 DSH 同源页面可读：
  - `GET /model-usage`（可选 `?force=1`）：读 settings 提供方列表 → credentials seam 解析密钥 → 逐提供方拉取（60s 缓存）→ 结构化 JSON（每提供方 `{id, displayName, kind, status, ...}`，失败降级 `nocred / unauth / error`，fail-soft 不抛）
  - `POST /model-usage/ark-login`：spawn `arkcli auth login volc-sso`（浏览器在本机弹出，SSO 完成经 127.0.0.1 回环回调落凭据），180s 超时保护；成功后清空用量缓存
- **CLIENT 半**（`src/client.js` → `lib/client.js`，`dsh.client` 声明）：静态浏览器插件，向 `sidebar.footer.action` 槽位注入聚合行 + 详情弹窗，60s 轮询 `/model-usage`
- 无动态 Cordis runner：无 define/run/审批/steering，模型永不被唤醒

## 开发

```
dsh-model-usage-widget/
├── package.json       # dsh.bundle.patch + dsh.client(platform: web) + exports["./client"]
├── cordis.patch.yml   # 安装期注入的组合行（host apply + client 声明）
├── index.js           # HOST 半：GET /model-usage + POST /model-usage/ark-login
├── src/client.js      # CLIENT 半源码（唯一需要编辑的 UI 文件）
├── build.mjs          # node build.mjs → lib/client.js
├── lib/client.js      # 构建产物（随包分发，client-modules 运行时扫描）
├── smoke.mjs          # 离线冒烟：mock ctx 启动模拟 + 路由/数据契约断言（39 项）
└── README.md
```

改动收尾验证清单：

```bash
node build.mjs                    # 重建 lib/client.js（改动 src/client.js 后必须）
node --check lib/client.js
node smoke.mjs                    # 离线冒烟：路由注册 / 数据契约 / 缓存 / 降级 / disposer
dsh --profile web --dump-config   # exit 0 且包含本包层标记
```

本地 `link:` 安装时改完**重启 DSH** 即生效；tarball/git/npm 安装时重新打包 `dsh plugin add` 覆盖升级后再重启。

## 更新与卸载

- **更新**：`git pull` 后重启 DSH（`link:` 安装）；或重新打包后 `dsh plugin --profile web add <包>`（覆盖升级）再重启
- **卸载**：

  ```bash
  dsh plugin --profile web remove dsh-model-usage-widget
  ```

  同时移除依赖与 `dsh.profile.bundles` 中的对应层，重启即卸载

## 说明与限制

- 弹窗宽度固定 272px、一次只渲染当前选中模型的卡片；模型数量只影响 Tab 栏（换行限高滚动）与侧栏行数（每排 3 个、超出折行）
- 弹窗定位：底边贴住视口底边（测量后落位），切 Tab / 重开 / 窗口 resize 均会重新落位，不会出屏
- MiniMax 端点为未公开文档接口（来自 @linxin666/dsh-usage 同款实现，实测 2026-09-14 有效）；若日后失效该行降级为「获取失败」
- 火山方舟用量依赖本机 arkcli 与 SSO 登录态；SSO 凭据由 arkcli 自行存储，插件不经手任何凭据
- 侧边栏位置依赖 DSH 的 `sidebar.footer.action` 扩展点；DSH 大幅改版后可能需要适配