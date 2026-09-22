# dsh-reasoning-effort

一个为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 编写的 **agent skill**：
让**自定义**（手写声明的）提供方路线上的每个模型，都拿到它**真实拥有**的思考等级 / reasoning effort；
唯一无法自行确定的问题，它会**问你**，而不是猜。

这里的"自定义"严格按 DSH 的定义：profile 补丁里 `llm-pi-ai` 行 `config.providers` 下、**路由名不是** pi-ai 目录 provider id 的那些。
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
5. **路由级默认档一律不写，而且是刻意不写。** 路由级 `reasoning:` 会被套用到该路由的**每个**模型上，
   留着它既把选择器的默认档从"默认"钉走，又会在你下次加一个不支持该档的模型时直接弄坏整条路由。
   所以每个模型都保持网关自己的默认档——也就是选择器里的**"默认"**——这是该路由上每个模型都能接受的取值。
6. **一次跑完。** 一次 `--apply` 覆盖新增提供方、新增模型、修改模型、删除模型。**幂等且只做增量**：
   只补空缺，绝不改写已经存在的声明。
7. **三平台。** Windows / macOS / Linux；无需安装依赖——`js-yaml` 直接从你的 DSH 安装里取。

因此**干净退出（`0`）就等于"范围内的自定义路由全部覆盖"**。

### 为什么它在任何平台、任何模型下表现一致

脚本本身是确定性的，所以方差只可能来自**驱动它时的选择**。因此流程被做成闭环：单一入口，不含任何需要判断的步骤。

| 步骤 | 命令 | 闸门 |
| --- | --- | --- |
| 1 | `apply-reasoning-efforts.mjs --self-test` | 退出 `0` = 这份构建在本机与文档描述一致 |
| 2 | `apply-reasoning-efforts.mjs --apply --json` | 只读 `verdict`、`nextAction`、`commands` |
| 3 | 按 `nextAction` 执行 `commands` 里的命令 | `search-then-ask` 与 `resolve-conflicts` 必须先拿到你的答复 |
| 4 | `check-reasoning-route.mjs --json` | `problems` 必须为 `[]` |
| 5 | 原样回报 `verdict` | `verdict` 不是 `covered` 时不许说"完成" |

支撑这五步的约束：

- **未知参数一律退出 `2`**，不再被忽略。以前把 `--apply` 打错成 `--appply` 会输出一份完整、看起来正常的报告却什么都没改——这是 agent 唯一无法察觉的失败模式。
- **`--json` 就是契约**：`verdict`、`nextAction`、`commands`、`coverage`、`contract`。
- **`--route` 会把本次运行标成 `scope: partial`**，局部运行不会被误读成全覆盖。
- **两个脚本都会打印 `contract 1`**，`SKILL.md` 用它跟自己的副本比对，过期或半更新的安装不会静默分叉。
- **命令三平台只有一种写法**：正斜杠、值不加引号、不用 shell 重定向、不用 `VAR=$(...)`。

`SKILL.md` 是执行路径（约一页，不含内部机理）；机理放在 `REFERENCE.md`，只在用户问"为什么"时才读。

## 安装

本技能是 **DSH 专用**的：它懂的是 DSH 的 profile 补丁 schema（`llm-pi-ai` 行与它的 `config.providers`）、DSH 的 pi-ai 目录、DSH 的适配器，
对别的 agent 没有任何用处。所以它属于 **DSH 自己的技能根**——`.dsh` 这一个，
**不要**放到多 agent 共用的 `.agents/skills`：

| 作用域 | 目录 |
| --- | --- |
| 用户级（推荐） | `$DSH_HOME/skills/dsh-reasoning-effort`，默认即 `~/.dsh/skills/dsh-reasoning-effort` |
| 项目级 | `<项目>/.dsh/skills/dsh-reasoning-effort` |

### 用 git 安装 —— 推荐，因为更新也随之解决

直接克隆到技能位置，让技能目录**本身就是那个 checkout**：

**macOS / Linux**

```sh
git clone https://github.com/mathangler/dsh-reasoning-effort.git \
  "${DSH_HOME:-$HOME/.dsh}/skills/dsh-reasoning-effort"
```

**Windows (PowerShell)**

```powershell
git clone https://github.com/mathangler/dsh-reasoning-effort.git `
  "$env:USERPROFILE\.dsh\skills\dsh-reasoning-effort"
```

无需构建、无需安装依赖：两个脚本都是纯 Node ESM，`js-yaml` 从你的 DSH 安装里解析。
技能根里多一个 `.git` 目录无害——DSH 找的是 `SKILL.md`，其余当作资源文件读取。

项目级作用域：在项目根目录执行同样的命令，目标写 `.dsh/skills/dsh-reasoning-effort`。

### 从本地副本安装

不想在技能根里留一个 checkout 就用这种方式。

**macOS / Linux**

```sh
src=/path/to/dsh-reasoning-effort
dest="${DSH_HOME:-$HOME/.dsh}/skills/dsh-reasoning-effort"
mkdir -p "$dest"
cp -R "$src"/SKILL.md "$src"/README.md "$src"/README.zh.md "$src"/FORK-NOTES.md \
      "$src"/LICENSE "$src"/data "$src"/scripts "$dest"/
```

**Windows (PowerShell)**

```powershell
$src  = 'C:\path\to\dsh-reasoning-effort'
$dest = "$env:USERPROFILE\.dsh\skills\dsh-reasoning-effort"
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Copy-Item "$src\SKILL.md","$src\README.md","$src\README.zh.md","$src\FORK-NOTES.md","$src\LICENSE","$src\data","$src\scripts" $dest -Recurse -Force
```

### `git` 到不了 GitHub 时

有些沙箱会掐掉 git 的传输——到 github.com 的 TCP 超时、Windows schannel 没有凭据句柄、ssh 被拒。
这时用**能走通的通道**取安装器（这里是经 `gh` 走 GitHub API），由它**逐文件重算 git blob id** 后写入：

**macOS / Linux**

```sh
gh api -H 'Accept: application/vnd.github.raw' \
  repos/mathangler/dsh-reasoning-effort/contents/scripts/install-from-github.mjs \
  > /tmp/install-from-github.mjs
GH_TOKEN=$(gh auth token) node /tmp/install-from-github.mjs \
  "$HOME/.dsh/skills/dsh-reasoning-effort"
```

**Windows (PowerShell)**

```powershell
gh api -H 'Accept: application/vnd.github.raw' `
  repos/mathangler/dsh-reasoning-effort/contents/scripts/install-from-github.mjs |
  Set-Content -Path "$env:TEMP\install-from-github.mjs" -Encoding utf8
$env:GH_TOKEN = (gh auth token)
node "$env:TEMP\install-from-github.mjs" "$env:USERPROFILE\.dsh\skills\dsh-reasoning-effort"
```

它会解析**已发布 commit** 的 tree、下载 blob、逐个重算 blob id，任何对不上就拒绝写入——
所以装出来的一定是发布的那棵树，而不是某台机器的工作目录。`scripts/publish-via-api.mjs` 是它的对偶（用于推送）。

### 更新

| 当初的安装方式 | 更新方式 |
| --- | --- |
| git clone | `git -C "${DSH_HOME:-$HOME/.dsh}/skills/dsh-reasoning-effort" pull --ff-only` |
| 本地副本 | 重新执行拷贝，或用 API 安装器（它会整体替换该目录） |

Windows：

```powershell
git -C "$env:USERPROFILE\.dsh\skills\dsh-reasoning-effort" pull --ff-only
```

**第一次 pull 之前请读这条。** `data/reasoning-overrides.yaml` 与 `data/user-decisions.yaml`
是**你自己的输入层**——你引用的厂商事实、你用 `--decide` 给出的答案。若你改过它们，pull 可能冲突。
要么把这些改动放在你自己的分支上，要么把条目放在 checkout 之外的文件里。脚本自身从不写这两个文件。

更新后重新核对并重新应用：

```sh
node scripts/check-reasoning-route.mjs
node scripts/apply-reasoning-efforts.mjs --apply
```

### 卸载

**macOS / Linux**

```sh
rm -rf "${DSH_HOME:-$HOME/.dsh}/skills/dsh-reasoning-effort"
```

**Windows (PowerShell)**

```powershell
Remove-Item -Recurse -Force "$env:USERPROFILE\.dsh\skills\dsh-reasoning-effort"
```

项目级安装同理，删除 `<项目>/.dsh/skills/dsh-reasoning-effort` 即可。

**卸载技能不会撤销它做过的改动。** `reasoningEfforts` 声明、以及对路由级 `reasoning:` 的移除都会留在
profile 补丁里——它们是普通的配置，不是技能在运行时注入的东西。请在删除目录**之前**先跑
`--restore latest`（见下方「回滚」），或者手工删掉那些声明。

### DSH 从哪里读技能

供参照，免得被优先级意外到。**rank 越小越优先**；技能按 `name` 识别，同名副本只有 rank 更低的那份生效。

| 根目录 | rank | 说明 |
| --- | --- | --- |
| `<项目>/.dsh/skills` | 100 | 项目级，DSH 专用 —— 本技能的项目级位置 |
| `<项目>/.agents/skills` | 200 | 项目级，多 agent 共用 |
| 自定义目录 | 300 | 由宿主配置 |
| `$DSH_HOME/skills` | 400 | 用户级，DSH 专用 —— 本技能推荐的安装位置 |
| `$DSH_AGENTS_HOME/skills` | 500 | 用户级，多 agent 共用 |
| DSH 随附 | 600 | 与 harness 一同发布 |

`DSH_HOME` 与 `DSH_AGENTS_HOME` 可整体移动这两个用户根。

## 使用

在输入框里敲 `/`，选择 **`dsh-reasoning-effort`**。本技能刻意设了
`disable-model-invocation: true`——模型不会自行触发它（`/` 菜单里会标成 *user only*）——
对一个会改你配置文件的东西来说，这是正确的默认。你也可以直接点名让 agent 用它。

然后全部工作就是一条命令——但先过闸门：

```sh
node scripts/apply-reasoning-efforts.mjs --self-test   # 退出 0 = 本机与文档一致
node scripts/apply-reasoning-efforts.mjs --apply       # 全部工作
```

它会扫描每条自定义路由、补齐缺失声明、**移除**它发现的路由级默认档，**写前备份**、**写后逐路径校验**并报告。
跑完只可能剩两种情形，且都不会静默：

| 剩余项 | 原因 | 运行行为 |
| --- | --- | --- |
| 模型报 `needs-decision` | 目录与文档都没有依据 | 列出推荐档位方案，退出码 `1`；先搜索，再问 |
| 声明与证据冲突 | 你手工配的 | 报告冲突，退出码 `1`；`--fix` 才对齐 |

## 配置

### 它写进哪个文件、写成什么

目标文档是 **profile 补丁**：`$DSH_HOME/profiles/<profile>/cordis.patch.yml`——DSH 0.1.7 之后设置就放在这里
（旧的 `settings.yaml` 只在启动时被导入一次然后改名，之后再也不会被读取）。技能自己会找到这份补丁；
机器上有多个 profile 时用 `--settings <路径>` 指定。

```yaml
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      my-gateway:                     # 自定义路由：路由名不是目录 provider id
        baseURL: https://…
        api: openai-completions
        # 这里永远不写 `reasoning:`：它作用于整条路由，只要有一个模型没有该档
        # （包括非推理模型），它的每个请求都会以 UNSUPPORTED_REASONING_EFFORT 失败。
        # 选择器里的"默认"项才是预期状态。
        models:
          - id: glm-5.3
            reasoningEfforts:         # 该模型真实拥有的档位——没有 `off`，因为它永远在思考
              low: low
              high: high
              max: max
          - id: a-model-that-does-not-reason
            reasoningEfforts: false   # 显式声明，绝不靠"缺失"表达
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    reasoningEffort: high             # 选择器给"新建会话"用的字段：由 GUI 写；只有默认模型
                                      # 吃不下这个档位时，本技能才会把它移除
```

只有 `llm-pi-ai` 行的 `config.providers` 和上面那一个 `agent-default-model` 字段会被改动，
其余每一行都逐字节原样保留。目录内置路由（provider key 就是目录 id）与 `llm-deepseek` 行只做只读呈现，永不写入。

### 关于默认档的两条规则（都是踩过坑才定下的）

- **路由级 `reasoning:` 会被套用到该路由的每一个模型**，而 DSH 对不支持该档的模型直接抛
  `UNSUPPORTED_REASONING_EFFORT`——**包括完全没有档位声明的模型和非推理模型**。所以写入器**从不写**这个字段，
  发现就移除，不管当下有没有模型反对它：即使它"现在安全"，也会把选择器的默认档从"默认"钉走，
  并为下一个加进来的模型重新埋上同一个坑。没有路由默认档时，选择器显示的就是**"默认"**——这正是预期状态。
  只要还有自定义路由带着这个字段，本次运行就不可能判定为 `covered`。
- **从不主动写入 `agent-default-model.reasoningEffort`。** 它是选择器自己的字段——**新建**会话的初始档位，
  你每次选模型或选档位它都会被重写——所以写入器不会去清掉你做过的选择。只有当它能**证明**默认模型不支持该档
  （那会让每个新建会话的第一条请求都失败）时，才移除这个值。

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
| `--probe` | 允许每个模型发**一次**最小请求来记录"网关接受"（**会产生费用**） |
| `--strict` | 只写证据为实发探测的模型 |
| `--fix-routes` | 迁移"目录协议与所在路线不一致"的模型 —— **必须显式给 `--route`**，因为网关不总按目录分流，这个操作有可能弄坏一条当前可用的路线 |
| `--restore latest\|<文件>` | 把 settings 文档回滚到备份 |
| `--timestamped-backup` | 改为生成带时间戳的多份备份，而不是覆盖那一个 |
| `--report <路径>` / `--json` | 落盘 markdown 报告 / 输出机器可读结果（`verdict`、`nextAction`、`commands`、`coverage`、`contract`） |
| `--self-test` | 用两个夹具驱动写入器并断言契约；应当先跑的闸门 |
| *（任何未识别参数）* | 在读取任何文件之前就退出 `2`，绝不静默忽略 |
| `--settings <路径>` / `--dsh-root <路径>` | 指向别的文档 / 安装 |

退出码：`0` **范围内**的每条自定义路由都已覆盖（用 `--route` 时范围就是那条路由，工具会标 `scope: partial`），`1` 有待办或有问题，`2` 环境或调用方式不可用。

### 环境变量

| 变量 | 含义 |
| --- | --- |
| `DSH_HOME` | DSH 主目录（默认 `~/.dsh`）——`profiles/`（各 profile 补丁）与原生技能根都在这里 |
| `DSH_AGENTS_HOME` | 共用的用户技能根（默认 `~/.agents`） |
| `DSH_ROOT` | 含 `node_modules` 的 DSH 安装；`--dsh-root` 优先 |
| `DSH_NO_SUBPROCESS=1` | 安装发现时跳过 `where`/`which` 兜底 |

## 验证

1. **配置可解析** —— `node scripts/check-reasoning-route.mjs` 无 problem。
2. **选择器给对了档位** —— 刷新 GUI，打开 `/model` 选择器的 **Effort** 面板：推理模型列出的正好是报告里给它的档位，
   且预选 **"默认"**；声明为 `false` 的模型完全没有 Effort 面板。
3. **线路上真的兑现** —— `--probe` 记录网关是否接受该取值。注意它的边界：**被接受不等于思考深度真的变了**。

想在**不碰真实配置**的前提下看全所有结局（声明 / 提问 / 非推理、内置边界，以及两种路由默认档）：

```sh
node scripts/apply-reasoning-efforts.mjs --settings scripts/fixture-settings.yaml
node scripts/apply-reasoning-efforts.mjs --settings scripts/fixture-builtin-settings.yaml
node scripts/apply-reasoning-efforts.mjs --settings scripts/fixture-breaking-default.yaml
node scripts/apply-reasoning-efforts.mjs --settings scripts/fixture-pinned-default.yaml
```

## 回滚

只保留**一个**备份文件（每份文档一个）：`cordis.patch.yml.bak-reasoning-efforts`，就放在补丁旁边，每次写入都覆盖它，
内容始终是**上一次操作前**的状态。它是"一步撤销"，不是归档。`--restore latest` 会还原它，并把被替换掉的状态写回**同一个文件**——
所以连续 restore 两次就是在这两个状态之间来回切换。只想撤销单个模型，删掉它的 `reasoningEfforts`
（或设成 `false`）即可——档位消失、行为还原，不影响该路由上的其他模型。
想要带时间戳的多份备份，加 `--timestamped-backup`。

## 已知的坑

- **`openai-completions` 发不出网关的会话头。** `compat.sendSessionAffinityHeaders` 在 DSH 里是
  `"withhold"`（只有 pi-ai 目录能设置它），所以 completions 路线什么都不发。声明思考强度改变不了这一点。
- **公开的端点表不是权威。** 某网关把 `/responses` 文档化为只服务少数模型，实测却在该路径上连续服务了
  另一个模型 **64 次**且零错误。协议差异只作为提示，绝不自动动作。
- **路由默认是"路由级"的。** 配置 schema 没有按模型的默认档，所以这个字段会落到该路由的每个模型上：
  只要有一个模型没有该档（非推理模型也算），它的每个请求都会以 `UNSUPPORTED_REASONING_EFFORT` 失败，
  而且所有模型的选择器都不会再有"默认"项。因此写入器从不写它、发现就移除。
  如果你**就是想**钉一个默认档，手工写上去，并接受"下次从 GUI 加一个模型就可能弄坏这条路由"；
  技能下一次运行会报告并移除它。
- **`anthropic-messages` 把档位换算成 thinking 预算**，不是发 effort 字符串；该协议下声明里的*值*是惰性的，
  真正有意义的是档位集合。
- **动态 Cordis 插件写不了 settings**（realm 敏感的 `isPlainObject`）。用插件读，用文件写。
- **热重载不确定。** settings 提供方确实接了 watcher，但也观测到过外部编辑未被拾取。先刷新；
  把"重开一个 dsh 进程"作为兜底。若设置页面里还有未保存的改动，之后的一次 GUI 写入可能覆盖文件编辑。

## 许可

MIT —— 见 [LICENSE](LICENSE)。© 2026 mathangler。
