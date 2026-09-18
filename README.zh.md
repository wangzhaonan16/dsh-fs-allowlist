# dsh-fs-allowlist

[English](README.md) | [中文](README.zh.md)

DSH 插件：**白名单目录写入免审批**。让 write/edit 文件工具对配置的白名单目录（如 Obsidian 知识库）直接写入，不再触发「沙箱拒绝 → 升权重试 → 人工审批」；并提供 **设置 → 插件 → 目录白名单** 图形界面与 **bash 升权自动放行**。其余路径行为与现状完全一致。

## 功能总览

| 层 | 机制 | 覆盖 |
|---|---|---|
| write/edit 工具 | 包装 `ctx.fs.checkedTarget` 栅栏，白名单路径提前放行 | 知识库读写全免审批 |
| bash 命令 | `tools/pre-execute` 记录命令原文 + `approval/request` 代答：命令原文或升权理由命中白名单路径（递归判定）时自动 `allowed-once` | bash 写白名单目录免审批（命令文本优先，未命中转人工） |
| 设置页 GUI | `settings.plugins.tab` 注册「目录白名单」页签 + 服务端 HTTP 管理路由 | 可视化增删目录、开关 bash 代答 |

配置支持**热更新**：GUI 修改即时生效；手动编辑配置文件 3 秒内自动生效，均无需重启 DSH。

## 原理

### write/edit 层

DSH 的 write/edit 工具写入前都经过 `dsh-fs-sandbox` 挂载的 `ctx.fs.checkedTarget()` 栅栏（工作区外 → 抛 `FS_SANDBOX_DENIED` → 模型升权重试 → 审批弹窗）。本插件包装该栅栏方法：

- 目标路径 canonical 解析后落在白名单内 → 提前放行（返回与栅栏一致的解析结果）；
- 未命中 / `read-only` 模式 / 解析失败 → 原样委托原栅栏，行为分毫不变。

原子写、版本守卫、先读后写检查、diff 事件等文件语义全部位于栅栏之下的 `dsh-fs-local`，本插件不触碰。白名单判定与栅栏使用相同的 realpath（最深已存在祖先）语义，symlink 换向逃逸不成立。

### bash 层（审批代答）

bash 走 Seatbelt 进程沙箱，白名单无法从插件层注入 profile；取而代之的是双监听器协作：`tools/pre-execute` 先把每次 bash 调用的命令原文按 callId 记入索引表，`approval/request` 代答时按 callId 查回命令原文，与升权理由一起做白名单匹配——从文本中提取路径 token，`~` 展开 home 后与白名单根做递归包含判定（**填父目录即覆盖全部子目录**）。命令原文几乎必含目标路径，不再依赖模型在升权理由里写不写路径。未命中一律转人工（失败安全）。可在设置页随时关闭。

## 安装

```bash
dsh plugin --profile web add /path/to/dsh-fs-allowlist
```

发布到 GitHub 后也可以直接：

```bash
dsh plugin --profile web add "github:wzn16/dsh-fs-allowlist#main"
```

装入 `$DSH_HOME/profiles/web` 并自动登记，**重启 DSH Desktop** 后生效（刷浏览器不够）。本插件源码目录被 profile 以 `link:` 方式引用，改源码后重启即生效，无需重装。

## 配置

`$DSH_HOME/fs-allowlist.json`（主目录解析与官方一致：`$DSH_HOME` 优先，桌面版按平台取 userData——macOS `~/Library/Application Support/dsh-desktop/harness`、Windows `%APPDATA%\dsh-desktop\harness`、Linux `$XDG_CONFIG_HOME/dsh-desktop/harness`——再回退开源版 `~/.dsh`）：

```json
{
  "extraWritableRoots": [
    "/Users/wangzhaonan/zhaonan/ObsidianVault"
  ],
  "bashAutoApprove": true
}
```

- 推荐通过 **设置 → 插件 → 目录白名单** 调整，免手编；
- 文件缺失 / JSON 非法 / 空列表 → 白名单为空，插件等效透明（= 未安装的行为），即一键回退；
- `bashAutoApprove` 缺省视为 `true`。

## 行为矩阵

| 场景 | 行为 |
|---|---|
| write/edit 写入工作区内 | 免审批（原生行为，不变） |
| write/edit 写入白名单目录 | **免审批直写** |
| write/edit 写入其他路径 | 拒绝 → 升权 → 审批（不变） |
| read-only 模式写白名单 | 仍拒绝（尊重更严旋钮） |
| bash 写白名单目录（命令或理由命中） | **自动放行，不弹审批** |
| bash 其他升权（均未命中） | 正常弹审批 |

## 已知边界

1. bash 代答按「命令原文 + 升权理由」匹配白名单（递归路径判定 + 子串兜底），仍属启发式：极端情况下命令与理由都未出现白名单路径会多弹一次审批（失败安全）；命中即放行该次调用。
2. `checkedTarget` 属于 DSH 随包内部方法：大版本升级若重构该方法，本插件以「告警 + 透明降级」失败（等效回到现状），不会破坏会话，届时跟版适配。
3. 白名单 = 授权 agent 对该目录免审批写入，请刻意收窄范围。

## 回滚

`dsh plugin --profile web remove dsh-fs-allowlist`（或清空 `fs-allowlist.json`）+ 重启 DSH。
