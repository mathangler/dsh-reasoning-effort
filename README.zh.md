# dsh-reasoning-effort

一个为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 编写的 **agent skill**：
让**自定义**（手写声明的）提供方路线上的每个模型，都拿到它**真实拥有**的思考等级 / reasoning effort；
唯一无法自行确定的问题，它会**问你**，而不是猜。

这里的"自定义"严格按 DSH 的定义：`llm-pi-ai.providers` 下、**路由名不是** pi-ai 目录 provider id 的那些。
这样的路线什么都不继承——pi-ai 是**按路由名**查表的、全有或全无——于是其上每个模型都退回 `reasoning: false`，
选择器里一个档位都没有。本技能从 DSH 自带的 pi-ai 目录推导出每个模型的真实档位，写成按模型的
`reasoningEfforts` 声明，并且**拒绝写入任何没有依据的东西**。

> English: [README.md](README.md)。版本变更与相对上一版的差异：[FORK-NOTES.md](FORK-NOTES.md)。

## 它保证什么

1. **全覆盖。** 自定义路由上的每个模型最终都有显式声明：要么是 `reasoningEfforts` 档位映射，要么是显式的
   `reasoningEfforts: false`。**绝不**依赖字段缺失——在这种路线上，"没写"本身就等于"不支持思考"，
   两者无法区分。
2. **依据，而不是模板。** 档位来自 DSH 自带的 pi-ai 目录、来自你带 URL 的厂商事实、或来自你记录的决定。
   没有任何东西是编的。
3. **不猜。** 判不出来的模型不会被写：运行会列出它、给出具体的推荐档位方案，并以非零退出码结束，直到你回答。
   **先搜索，再提问。**
4. **内置提供方一律不动。** 包括原生 `llm-deepseek` 命名空间、pi-ai 目录全部 40 个 provider id、
   以及任何其他 `llm-*` 命名空间。判定看**路由名**而不是看厂商：叫 `my-gemini` 的是自定义、会被写；
   叫 `google` 的就是内置、不碰。
5. **不留"默认"。** 思考模型会拿到路由级 `reasoning: high`（可配置），使选择器**去掉 `Default` 项**并钉住档位；
   另外写入 `agent-default-model.reasoningEffort: high` 作为**新建**会话的初始档位。
6. **一次跑完。** 一次 `--apply` 覆盖新增提供方、新增模型、修改模型、删除模型。**幂等且只做增量**：
   只补空缺，绝不改写已经存在的声明。
7. **三平台。** Windows / macOS / Linux；无需安装依赖——`js-yaml` 直接从你的 DSH 安装里取。

因此**干净退出（`0`）就等于"所有自定义路由上的模型都已覆盖"**。

## 安装

**这个技能属于 DSH 自己的技能根**：`$DSH_HOME/skills`，也就是
`~/.dsh/skills/dsh-reasoning-effort`；要项目级作用域就放 `<项目>/.dsh/skills/dsh-reasoning-effort`。
它是 **DSH 专用**的：它懂的是 DSH 的 `settings.yaml` schema、DSH 的 pi-ai 目录、DSH 的适配器，
对别的 agent 没有任何用处。`.agents/skills` 是多个 agent **共用**的位置，不要把它放那里。

### 方式 A —— 直接拷进 `~/.dsh/skills`（推荐）

**Windows (PowerShell)**

```powershell
$src  = 'C:\path\to\dsh-reasoning-effort'
$dest = "$env:USERPROFILE\.dsh\skills\dsh-reasoning-effort"
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Copy-Item "$src\SKILL.md","$src\README.md","$src\README.zh.md","$src\FORK-NOTES.md","$src\LICENSE","$src\data","$src\scripts" $dest -Recurse -Force
```

**macOS / Linux**

```sh
src=/path/to/dsh-reasoning-effort
dest="${DSH_HOME:-$HOME/.dsh}/skills/dsh-reasoning-effort"
mkdir -p "$dest"
cp -R "$src"/SKILL.md "$src"/README.md "$src"/README.zh.md "$src"/FORK-NOTES.md \
      "$src"/LICENSE "$src"/data "$src"/scripts "$dest"/
```

### 方式 B —— clone 后再拷

```sh
git clone https://github.com/mathangler/dsh-reasoning-effort /tmp/dsh-reasoning-effort
mkdir -p "${DSH_HOME:-$HOME/.dsh}/skills/dsh-reasoning-effort"
cp -R /tmp/dsh-reasoning-effort/SKILL.md /tmp/dsh-reasoning-effort/data \
      /tmp/dsh-reasoning-effort/scripts \
      "${DSH_HOME:-$HOME/.dsh}/skills/dsh-reasoning-effort/"
```

### 方式 C —— `git` 到不了 GitHub 时

有些沙箱会掐掉 git 的传输（到 github.com 的 TCP 超时、Windows schannel 没有凭据句柄、ssh 被拒）。
内容仍可通过 GitHub API 安装，并且**逐文件重算 git blob id 校验**：

```sh
GH_TOKEN=$(gh auth token) node scripts/install-from-github.mjs "$HOME/.dsh/skills/dsh-reasoning-effort"
```

PowerShell 等价写法：

```powershell
$env:GH_TOKEN = (gh auth token)
node scripts\install-from-github.mjs "$env:USERPROFILE\.dsh\skills\dsh-reasoning-effort"
```

它从**已发布的 commit** 取 tarball，所以装出来的树可证明就是发布的那棵树，而不是本地工作目录的拷贝。
`scripts/publish-via-api.mjs` 是它的对偶：经同一个 API 推送本地 commit，并在移动分支前把远端树与本地树比对。

### 方式 D —— 用 `npx skills` 取件，但不要装在那里

[`skills`](https://github.com/vercel-labs/skills) 是生态里的技能 CLI，把本技能的**文件**取到机器上最省事。
但它**装不进 `.dsh`**：它认识 75+ 个 agent，却**没有 `dsh` 这个目标**，只会往某个 agent 目录里写；
对落点为 `.agents/skills/` 的那一组来说，那是**共用根**——不是 DSH 专用技能该待的地方。
所以把它当"取件"步骤，取完再挪到正确位置：

```bash
npx skills add mathangler/dsh-reasoning-effort --list      # 只发现、不安装
npx skills add mathangler/dsh-reasoning-effort -g -a cline -y --copy
```

```powershell
# 然后挪进 DSH 自己的根，并且不要两处都留
Move-Item "$env:USERPROFILE\.agents\skills\dsh-reasoning-effort" `
          "$env:USERPROFILE\.dsh\skills\dsh-reasoning-effort"
```

- `-a cline` 指同组任意一个落点为 `.agents/skills/` 的 agent（`cline`、`dexto`、
  `kimi-code-cli`、`loaf`、`sarvam-code`、`warp`、`zed`），彼此等价。
- `-g` 装到 `~/.agents/skills/`，不加则装到当前项目的 `./.agents/skills/`。
- `--copy` 让它成为真实目录而不是符号链接。
- 两份都留不会报错，但会误导：按下面的优先级，`.dsh` 那份胜出，`.agents` 那份**静默失效**。

技能相关的其他操作：

```bash
npx skills ls -g                                  # 已安装了什么
npx skills update -g                              # 拉到最新版
npx skills remove -g -a cline dsh-reasoning-effort -y
npx skills find reasoning                         # 搜索生态里的技能
npx skills init my-skill                          # 生成一个新技能骨架
npx skills use mathangler/dsh-reasoning-effort --skill dsh-reasoning-effort --agent claude-code
```

环境变量：`DISABLE_TELEMETRY=1` / `DO_NOT_TRACK=1` 关闭该 CLI 的遥测；`GITHUB_TOKEN` / `GH_TOKEN`
只在私有源或触发 API 限流时才需要。

### DSH 从哪里读技能

| 根目录 | rank | 说明 |
| --- | --- | --- |
| `<项目>/.dsh/skills` | 100 | 项目级，DSH 专用 —— **项目级作用域就用这个** |
| `<项目>/.agents/skills` | 200 | 项目级，多个 agent 共用 |
| 自定义目录 | 300 | 由宿主配置 |
| `$DSH_HOME/skills` | 400 | 用户级，DSH 专用（默认 `~/.dsh/skills`）—— **推荐的家** |
| `$DSH_AGENTS_HOME/skills` | 500 | 用户级，多个 agent 共用（默认 `~/.agents/skills`） |
| DSH 随附 | 600 | 与 harness 一同发布 |

**rank 越小越优先**；技能按 `name` 识别，同名副本只有 rank 更低的那份生效——这就是为什么 `.dsh` 那份会
遮蔽 `.agents` 那份。`DSH_HOME` 与 `DSH_AGENTS_HOME` 可整体移动这两个用户根。

## 使用

在输入框里敲 `/`，选择 **`dsh-reasoning-effort`**。本技能刻意设了
`disable-model-invocation: true`——模型不会自行触发它（`/` 菜单里会标成 *user only*）——
对一个会改你配置文件的东西来说，这是正确的默认。你也可以直接点名让 agent 用它。

然后全部工作就是一条命令：

```sh
node scripts/apply-reasoning-efforts.mjs --apply
```

它会扫描每条自定义路由、补齐缺失声明、写入路由默认档，**写前备份**、**写后逐路径校验**并报告。
跑完只可能剩两种情形，且都不会静默：

| 剩余项 | 原因 | 运行行为 |
| --- | --- | --- |
| 模型报 `needs-decision` | 目录与文档都没有依据 | 列出推荐档位方案，退出码 `1`；先搜索，再问 |
| 声明与证据冲突 | 你手工配的 | 报告冲突，退出码 `1`；`--fix` 才对齐 |

## 配置

### 它会往 `settings.yaml` 写什么

```yaml
llm-pi-ai:
  providers:
    my-gateway:                       # 自定义路由：路由名不是目录 provider id
      baseURL: https://…
      api: openai-completions
      reasoning: high                 # → defaultEffort：去掉选择器里的 "Default" 项
      models:
        - id: glm-5.3
          reasoningEfforts:           # 该模型真实拥有的档位——没有 `off`，因为它永远在思考
            low: low
            high: high
            max: max
        - id: a-model-that-does-not-reason
          reasoningEfforts: false     # 显式声明，绝不靠"缺失"表达
agent-default-model:
  reasoningEffort: high               # 新建会话的初始档位
```

内置路由与 `llm-deepseek` 命名空间只做只读呈现，永不写入。

### 两个数据层

| 文件 | 内容 | 依据等级 |
| --- | --- | --- |
| `data/reasoning-overrides.yaml` | 带引用的厂商事实 | `vendor`，必须带 `source` URL |
| `data/user-decisions.yaml` | 你给出的、其他途径无法确定的答案 | `user` |

两者都是**输入**而非生成状态：可以手改，也可以让 `--decide` 写。

```sh
# 查到的厂商事实——必须带引用，会落进带引用的那一层
node scripts/apply-reasoning-efforts.mjs --evidence vendor --source <url> \
  --decide 'my-gateway/my-model=low,high,max' --apply

# 你对"工具拒绝猜"的问题给出的答案
node scripts/apply-reasoning-efforts.mjs --decide 'my-gateway/my-model=off,low,high,max' --apply
node scripts/apply-reasoning-efforts.mjs --decide 'my-gateway/my-model=false'   # 它不支持思考
node scripts/apply-reasoning-efforts.mjs --decide 'my-gateway/my-model=skip'    # 先不动，别再问我
```

### 参数

| 参数 | 作用 |
| --- | --- |
| *（无）* | 干跑：只打印计划，什么都不改 |
| `--apply` | 落盘（备份 → 编辑 → 重解析 → 越界检查 → 回读校验 → 写入） |
| `--route <名称>` | 限定路由（可重复） |
| `--fix` | 同时对与证据冲突的声明做对齐 |
| `--default-effort <档位\|skip>` | 钉为默认的档位（默认 `high`；`skip` 关闭这类写入） |
| `--probe` | 允许每个模型发**一次**最小请求来记录"网关接受"（**会产生费用**） |
| `--strict` | 只写证据为实发探测的模型 |
| `--fix-routes` | 迁移"目录协议与所在路线不一致"的模型 —— **必须显式给 `--route`**，因为网关不总按目录分流，这个操作有可能弄坏一条当前可用的路线 |
| `--restore latest\|<文件>` | 把 settings 文档回滚到某个备份 |
| `--report <路径>` / `--json` | 落盘 markdown 报告 / 输出机器可读结果 |
| `--settings <路径>` / `--dsh-root <路径>` | 指向别的文档 / 安装 |

退出码：`0` 全部覆盖，`1` 有待办或有问题，`2` 环境读不到。

### 环境变量

| 变量 | 含义 |
| --- | --- |
| `DSH_HOME` | DSH 主目录（默认 `~/.dsh`）——`settings.yaml` 与原生技能根都在这里 |
| `DSH_AGENTS_HOME` | 共用的用户技能根（默认 `~/.agents`） |
| `DSH_ROOT` | 含 `node_modules` 的 DSH 安装；`--dsh-root` 优先 |
| `DSH_NO_SUBPROCESS=1` | 安装发现时跳过 `where`/`which` 兜底 |

## 验证

1. **配置可解析** —— `node scripts/check-reasoning-route.mjs` 无 problem。
2. **选择器给对了档位** —— 刷新 GUI，打开 `/model` 选择器的 **Effort** 面板：`Default` 项消失、
   预选 `High`、每个模型显示自己的真实档位（强制思考的模型没有 `Off`）。
3. **线路上真的兑现** —— `--probe` 记录网关是否接受该取值。注意它的边界：**被接受不等于思考深度真的变了**。

想在**不碰真实配置**的前提下看全所有结局（声明 / 提问 / 非推理，以及内置边界）：

```sh
node scripts/apply-reasoning-efforts.mjs --settings scripts/fixture-settings.yaml
node scripts/apply-reasoning-efforts.mjs --settings scripts/fixture-builtin-settings.yaml
```

## 回滚

`--restore latest` 还原最新的 `settings.yaml.bak*`，并把当前状态另存为
`settings.yaml.bak-before-restore-<时间戳>`。只想撤销单个模型，删掉它的 `reasoningEfforts`
（或设成 `false`）即可——档位消失、行为还原，不影响该路由上的其他模型。

## 已知的坑

- **`openai-completions` 发不出网关的会话头。** `compat.sendSessionAffinityHeaders` 在 DSH 里是
  `"withhold"`（只有 pi-ai 目录能设置它），所以 completions 路线什么都不发。声明思考强度改变不了这一点。
- **公开的端点表不是权威。** 某网关把 `/responses` 文档化为只服务少数模型，实测却在该路径上连续服务了
  另一个模型 **64 次**且零错误。协议差异只作为提示，绝不自动动作。
- **路由默认是"路由级"的。** 配置 schema 没有按模型的默认档，因此该路由上不支持所钉档位的模型会保留
  `Default` 项，且路由默认套到它身上时请求会失败。所以技能只在**全路由模型都声明了该档**时才写入默认，
  否则把该路由报成"未写"。
- **`anthropic-messages` 把档位换算成 thinking 预算**，不是发 effort 字符串；该协议下声明里的*值*是惰性的，
  真正有意义的是档位集合。
- **动态 Cordis 插件写不了 settings**（realm 敏感的 `isPlainObject`）。用插件读，用文件写。
- **热重载不确定。** settings 提供方确实接了 watcher，但也观测到过外部编辑未被拾取。先刷新；
  把"重开一个 dsh 进程"作为兜底。若设置页面里还有未保存的改动，之后的一次 GUI 写入可能覆盖文件编辑。

## 许可

MIT —— 见 [LICENSE](LICENSE)。© 2026 mathangler。
