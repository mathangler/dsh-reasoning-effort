# dsh-reasoning-effort

一个为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 编写的 **agent skill**：
让某个模型路由在对话框的模型菜单里出现可选的**思考等级 / reasoning effort**，并诊断它通常出错的三种方式。

它之所以存在：DSH 只有在适配器**为该模型报告了推理等级**时，菜单里才会出现「推理等级」子菜单；而对一条手写的
provider 路由来说，这绝不会自己发生。本 skill 给出了解释症状的那条规则、配置 schema、决定"等级只是被列出"
还是"真的发了出去"的**协议选择**，以及一个可以在动线上会话之前先跑的校验脚本。

## 它解决什么

| 症状 | skill 给出的答案 |
| --- | --- |
| 模型菜单没有「推理等级」子菜单 | 路由名不是 pi-ai 目录里的 provider，于是 `reasoning` 解析为 `false`——模型元数据是**按路由名**查表的，而且全有或全无 |
| 加一个新模型后，其它模型的上下文长度/能力一起丢了 | 同一个原因：一条路由名不可能既是目录 provider、又承载目录还不认识的模型 |
| 等级列出来了，但请求报 `does not support reasoning effort` | `reasoningEfforts` 会把未声明的等级一律钉成"不支持"，声明的集合是权威的 |
| 配置写入被拒，整条路由从选择器里消失 | 路由级 `compat` 字段没有任何模型能接受（通常因为 `api` 解析成了空） |
| 等级出现了，但 reasoning tokens 不动 | 该协议没把推理参数发出去——Responses 路由会忽略 `thinkingFormat` |

## 最该记住的一条规则

**pi-ai 的模型元数据是按路由名本身查表的，而且全有或全无。** 路由键若不等于 pi-ai 内置 provider id，就会拿到一张
空目录表，于是该路由上**每一个**模型同时退回手写值：显示名、`contextWindow`（退到路由默认值）、
`reasoning: false`、`thinkingLevelMap`、`compat`。这一条规则就能解释大多数"我的能力去哪了"。

## 那个陷阱

`compat: { thinkingFormat: deepseek }` 看起来像是"让思考生效"的开关，因此很容易把路由改成
`api: openai-completions` 去用它。但在 OpenCode Go / Zen 网关上，这同时会**丢掉会话头**
（`session_id` 只有 `openai-responses` 实现会原生发送；`openai-completions` 把它锁在
`compat.sendSessionAffinityHeaders` 后面，而 DSH 把它标为 `"withhold"`，无法从 settings 打开）。
下一轮请求就会以 `400 MissingSessionID` 失败——一个与思考等级毫无关系、却作为改动的副作用出现的故障。

两种协议都接受同一份 `reasoningEfforts` 声明，所以通常**不必拿会话头去换等级**。先按会话头这一列决定协议，
再在该协议内表达思考强度。

## 安装

skill 就是技能根目录下的一个目录，无需构建。

**Windows (PowerShell)**

```powershell
git clone https://github.com/mathangler/dsh-reasoning-effort "$env:TEMP\dsh-reasoning-effort"
$dest = "$env:USERPROFILE\.dsh\skills\dsh-reasoning-effort"
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Copy-Item "$env:TEMP\dsh-reasoning-effort\SKILL.md","$env:TEMP\dsh-reasoning-effort\scripts" $dest -Recurse -Force
```

**macOS / Linux**

```sh
git clone https://github.com/mathangler/dsh-reasoning-effort /tmp/dsh-reasoning-effort
mkdir -p "${DSH_HOME:-$HOME/.dsh}/skills/dsh-reasoning-effort"
cp -R /tmp/dsh-reasoning-effort/SKILL.md /tmp/dsh-reasoning-effort/scripts \
      "${DSH_HOME:-$HOME/.dsh}/skills/dsh-reasoning-effort/"
```

技能根目录是 `${DSH_HOME:-$HOME/.dsh}/skills`，`DSH_HOME` 可覆盖。新开一个会话（或重载 skills 面板）即可使用。

## 不用 agent 也能用

`scripts/check-reasoning-route.mjs` 是独立校验脚本，**不需要 DSH 进程**。它读取你的 settings 文档、你
dsh 安装所固定的 pi-ai 目录、以及 `dsh-llm-pi-ai` 的 compat gates，然后逐模型报告：路由是否继承目录元数据、
**实际生效的协议**、会提供哪些等级、以及每个 `compat` 字段在这条路由上是否有模型能接受。

```sh
node scripts/check-reasoning-route.mjs                      # 全部路由
node scripts/check-reasoning-route.mjs --route my-route     # 指定路由
node scripts/check-reasoning-route.mjs --settings /path/to/settings.yaml
```

无结构性问题时退出码为 `0`，有则为 `1`，找不到 dsh 安装为 `2`（此时用 `--dsh-root` 指定）。
它复现的正是那条"严格写入校验"——也就是让配置错误的路由从模型选择器里消失的那一条，因此可以在**重启之前**就抓住错误。

`scripts/live-probe.md` 里有一份可直接粘贴的动态 Cordis Host 插件，用来报告**正在运行的**适配器对外声明的等级、
以及 `resolveCallConfig` 实际接受哪些等级（用来抓"列出了却被拒绝"这个状态），并给出被拒路由的错误原文。

## 三步验证

1. **配置能解析** — 跑 `check-reasoning-route.mjs`。
2. **等级是被接受，而不只是被列出** — 用 live probe。
3. **线路上真的生效** — 用高档位发一次真实请求，确认 reasoning tokens 上升。只有这一步能证明网关接受 DSH 发的参数，
   光看配置推断不出来。

## 两个各值一小时的坑

- **动态 Cordis 插件写不了 settings。** `dsh-settings` 只接受原型**就是** Host bundle
  `Object.prototype` 的对象，而动态插件跑在独立 realm 里，它造出的任何对象都过不了（`must be a plain object`）。
  结论：用插件读，用文件写。
- **从外部编辑 `settings.yaml` 不会热重载运行中的进程。** 实测该文件监视器不触发。配置变更需要**新的 `dsh` 进程**。
  推论：不要因为运行中的进程还显示旧值就断定配置写错了。

## 相关

- `opencode-go-session-header` — OpenCode Go / Zen 的 `400 MissingSessionID` 修复。**改路由协议之前**先读它，两者相互作用。

## 许可

MIT — 见 [LICENSE](LICENSE)。
