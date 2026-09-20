# dsh-reasoning-effort

一个为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 编写的 **agent skill**：
让**自定义**（手写声明的）提供方路线上的每个模型，都拿到它**真实拥有**的思考等级 / reasoning effort，
并诊断等级选择器通常出错的三种方式。

它之所以存在：DSH 只有在适配器为该模型报告了推理等级时，模型菜单里才会出现 **Effort（推理等级）**
面板；而手写声明的路线永远不会继承这些元数据——pi-ai 是**按路由名**查表的，而且全有或全无，
于是目录不认识的路由上的每个模型都会退回 `reasoning: false`，面板永远是空的。
本 skill 从 DSH 自带的 pi-ai 目录推导出每个模型的真实档位，写成按模型的 `reasoningEfforts` 声明，
并且**拒绝写入任何没有依据的东西**。

它保证的是**全覆盖**，而不是"尽力而为"：每条手写路由上的每个模型，最终都会得到显式声明——要么是
`reasoningEfforts` 档位映射，要么是显式的 `reasoningEfforts: false`。判不出来的模型**绝不会**被
静默留空（在这种路由上，"没写"本身就等于"不支持思考"，两者无法区分），技能会停下来把问题列出来，
并在你回答之前以非零退出码结束。

> 相对上一版的变更与理由见 [FORK-NOTES.md](FORK-NOTES.md)。English: [README.md](README.md)。

## 它做什么

| 症状 | 本 skill 的处理 |
| --- | --- |
| 模型菜单没有「推理等级」面板 | 找出所有手写声明的路线，推导每个模型的真实档位并写入 |
| 等级列出来了，但请求报 `does not support reasoning effort` | 用目录对齐声明（`--fix`）：声明的字典是权威的，未声明的等级会被钉成"不支持" |
| 档位不对——例如一个已经不能关闭思考的模型却提供了 `Off` | 档位来自证据而不是模板：强制思考的模型**根本没有 `off` 键** |
| 配置写入被拒，整条路由从选择器里消失 | `check-reasoning-route.mjs` 离线报告 compat/协议不匹配，重启之前就能抓住 |
| 等级出现了，但思考深度没变化 | `--probe`（需显式开启）记录网关是否接受该取值——文档同时写明：**被接受 ≠ 真的生效** |
| 模型既不在目录里，也没有任何文档提及 | 什么都不写。技能停下来提问，并给出**其他网关**对同名模型的描述，以及显式备选项 |
| 选择器里出现 `Default` 一项，实际含义是"提供方自己决定" | 技能写入路由级 `reasoning: high`（可配置）——这是唯一能去掉该项并钉住默认值的字段；因为有守卫，它会作用于该路由的每个模型 |

## 安装

技能根目录下的一个普通目录。无需构建，无需安装依赖——`js-yaml` 直接从你的 DSH 安装里取。

**Windows (PowerShell)**

```powershell
$src = "C:\path\to\dsh-reasoning-effort"
$dest = "$env:USERPROFILE\.dsh\skills\dsh-reasoning-effort"
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Copy-Item "$src\SKILL.md","$src\README.md","$src\README.zh.md","$src\FORK-NOTES.md","$src\LICENSE","$src\data","$src\scripts" $dest -Recurse -Force
```

**macOS / Linux**

```sh
src=/path/to/dsh-reasoning-effort
dest="${DSH_HOME:-$HOME/.dsh}/skills/dsh-reasoning-effort"
mkdir -p "$dest"
cp -R "$src"/SKILL.md "$src"/README.md "$src"/README.zh.md "$src"/FORK-NOTES.md "$src"/LICENSE "$src"/data "$src"/scripts "$dest"/
```

技能根目录是 `${DSH_HOME:-$HOME/.dsh}/skills`。新开一个会话（或重载 skills 面板）即可使用。

## 不用 agent 也能用

两个脚本都是独立的 Node ESM，Node 本来就有——DSH 就跑在它上面。

### 写入档位

```sh
node scripts/apply-reasoning-efforts.mjs                    # 干跑（默认）：只打印计划
node scripts/apply-reasoning-efforts.mjs --apply            # 备份 → 写入 → 重新校验
node scripts/apply-reasoning-efforts.mjs --route opencode-go-0
node scripts/apply-reasoning-efforts.mjs --apply --fix      # 同时对冲突声明做对齐
node scripts/apply-reasoning-efforts.mjs --apply --probe    # 允许每个模型发 1 次最小请求
node scripts/apply-reasoning-efforts.mjs --apply --strict --probe   # 只写实发已证实的模型
node scripts/apply-reasoning-efforts.mjs --restore latest   # 回滚到最新备份

# 记录一个"没人能定"的问题的答案，并在同一次调用里落盘
node scripts/apply-reasoning-efforts.mjs --decide 'my-route/my-model=low,high,max' --apply
node scripts/apply-reasoning-efforts.mjs --decide 'my-route/my-model=false'   # 它不支持思考
node scripts/apply-reasoning-efforts.mjs --decide 'my-route/my-model=skip'    # 先不动，别再问我

# 记录"查到的厂商事实"（而不是你的决定）：必须带 URL，会写进带引用的那一层
node scripts/apply-reasoning-efforts.mjs --evidence vendor --source <url> \
  --decide 'my-route/my-model=low,high,max' --apply

# 默认档位（默认 high）；skip 关闭路由级默认与 agent 默认的写入
node scripts/apply-reasoning-efforts.mjs --default-effort xhigh --apply
node scripts/apply-reasoning-efforts.mjs --default-effort skip --apply

# 用夹具一次看全三种结局（声明 / 提问 / 非推理），完全不碰真实配置
node scripts/apply-reasoning-efforts.mjs --settings scripts/fixture-settings.yaml
```

典型网关路线的干跑输出：

| 路线 | 模型 | 现状 | 目标 | 依据 | 动作 |
| --- | --- | --- | --- | --- | --- |
| `my-gateway` | `glm-5.3-flash` | (无) | low / high / max | catalog | **新增声明** |
| `my-gateway` | `deepseek-v4-pro` | (无) | off / high / max | catalog | **新增声明** |
| `my-gateway` | `minimax-m2.5` | (无) | (无) | unknown | 不动 |

`--apply` 会依次：写带时间戳的备份 → **重新解析**编辑后的文档 → 若改到了
`llm-pi-ai.providers.*` 之外的任何路径则**拒绝写入** → 逐个模型读回比对。
编辑是行级手术式的，未触碰的行（含注释）逐字节保留，重复运行是幂等的。

退出码：`0` 全部模型都已覆盖，`1` 有待办或有问题——要写入的改动、冲突、结构问题、**仍在等你决定的模型，或路由默认档写不进去**——`2` 环境（安装 / `js-yaml` / settings 文档）读不到。

### 检查路由

```sh
node scripts/check-reasoning-route.mjs                  # 全部路由，只读
node scripts/check-reasoning-route.mjs --route my-route --json
```

逐路由报告：是手写声明还是目录路线、同一 baseURL 对应哪个目录 provider、每个模型实际生效的 `api`、
选择器会提供哪些档位及其来源、与目录的协议差异、以及每个 `compat` 字段是否有模型能接受。
**problem**（会破坏解析）与 **notice**（无证据的模型，无需修复）分开呈现。

两个脚本都接受 `--settings <path>` 与 `--dsh-root <path>`，识别 `DSH_ROOT` / `DSH_HOME`，
并可用 `DSH_NO_SUBPROCESS=1` 完全跳过 `where`/`which` 兜底。

## 证据，而不是模板

每条声明都带来源，档位集合绝不假设：

| 依据 | 含义 | 会写入吗 |
| --- | --- | --- |
| `probe` | 该模型的一次最小实发请求被接受 | 会 |
| `vendor` | 提供方自己的文档（记录在 `data/reasoning-overrides.yaml`，带 URL） | 会 |
| `user` | 你通过 `--decide` 记录的决定（`data/user-decisions.yaml`） | 会 |
| `catalog` | DSH 自带的 pi-ai 目录 | 会 |
| `unknown` | 没有任何来源 | **不会**，转而问你 |

这件事比听起来重要：`glm-5.3` 与 `glm-5.3-flash` **永远**在思考——厂商已经取消关闭思考的能力，
并对 `thinking.type: "disabled"` 直接报错，所以它们的诚实声明是 `{low, high, max}`，
**没有 `off` 键**。模板化写入会给它们加一个点了就失败的 `Off`。

## 验证

1. `node scripts/check-reasoning-route.mjs` —— 无 problem。
2. 刷新 GUI，打开 `/model` 选择器的 **Effort** 面板。（设置 → 模型的页面**故意没有**强度控件：
   强度是"按模型"的能力，而同一提供方下的模型档位并不一致。）
3. 可选：`--probe` 确认网关**接受**该取值。接受不等于生效——那要靠测 reasoning tokens。

## 范围与安全

- **内置提供方永不写入。** `llm-deepseek`（provider id `deepseek-official`）固定四档；
  路由名等于 pi-ai 目录 provider id 的路线本来就继承元数据。两者都只读呈现。
- **默认只读。** 不加 `--apply` 绝不碰 `settings.yaml`。
- **可回滚。** 每次写入前都有带时间戳的备份；`--restore latest` 一键还原。
- **不猜。** 无证据的模型原样保留。

## 已知的坑（记录在此以免重复踩）

- **`openai-completions` 发不出网关的会话头。** `compat.sendSessionAffinityHeaders` 在 DSH 里是
  `"withhold"`（只有 pi-ai 目录能设置它），所以 completions 路线什么都不发。声明思考强度改变不了这一点。
- **公开的端点表不是权威。** 某个网关把 `/responses` 文档化为只服务少数模型，实测却在该路径上连续
  服务了另一个模型 **64 次**且零错误。因此协议差异只作为提示，绝不自动动作。
- **`anthropic-messages` 把档位换算成 thinking 预算**，不是发一个 effort 字符串；该协议下声明里的
  *值*是惰性的，真正有意义的是档位集合。
- **动态 Cordis 插件写不了 settings**（realm 敏感的 `isPlainObject`）。用插件读，用文件写。
- **热重载不确定。** settings 文件确实接了 watcher，但也观测到过外部编辑未被拾取的情况。
  先刷新；把"重开一个 dsh 进程"作为兜底。若设置页面里还有未保存的改动，之后的一次 GUI 写入可能覆盖文件编辑。

## 许可

MIT —— 见 [LICENSE](LICENSE)。© 2026 mathangler。
