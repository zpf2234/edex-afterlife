# eDEX Afterlife 复活记录

eDEX Afterlife 是 [GitSquared/edex-ui](https://github.com/GitSquared/edex-ui) 的非官方复活版，不代表原作者。代码沿用 GPL-3.0。

## 复活前

- 上游已归档，最后版本是 2.2.8。
- 在 Node 22 上，`src` 的 `npm install` 直接失败：`node-pty` 安装脚本报 `spawn EINVAL`。
- 存在未修复的 CVE-2023-30856：任何网页都能连接本地终端 WebSocket，执行任意命令。

## 改动

| 范围 | 改动 |
|---|---|
| 运行环境 | Electron 12 升到 45，`electron.remote` 迁移到 `@electron/remote` 2 |
| 终端 | `xterm` 4 升到 `@xterm/xterm` 6，`node-pty` 升到 1.1.0，使用预编译文件，不再需要 C++ 工具链 |
| 安全 | WebSocket 只绑定 `127.0.0.1`，校验 `file://` 来源和每次启动随机生成的令牌，修正连接数检查 |
| 依赖 | 升级 `ws`、`systeminformation`；PDF 加载关闭 `isEvalSupported`；`geolite2-redist` 升到 4 |
| Windows 体验 | PowerShell 和 cmd 在每次提示符时上报目录，文件面板能跟随 `cd`，支持中文和空格路径及多标签页 |
| 中文输入 | 用 `inputmode` 替换 `readonly`，不再吞掉输入法提交的文本；触屏设备仍可隐藏软键盘 |
| 网络面板 | 不绑定网卡探测出站连接，自动跟随系统实际路由，开启 VPN 时不再误报 OFFLINE |
| 标签页 | Windows 上显示 Shell 名称；为避免每秒启动进程，暂不显示前台子进程 |
| 兼容修复 | 内存校验、GeoIP 下载失败处理、`new-window` 事件、集群 API、终端 CSS、边框遮挡 |

## 验证

运行 `npm run test:e2e`。测试会启动真实应用，并检查：

- 界面启动，9 个系统模块加载，没有渲染进程错误。
- PowerShell 真实执行命令，模拟键盘输入可到达 Shell，第二个终端标签页可连接，剪贴板可用。
- 非 ASCII 文本可输入；文件面板在 PowerShell 和 cmd 中都能跟随中文加空格路径，并随标签页切换。
- WebGL 渲染生效。
- 错误来源、缺失或错误令牌、真令牌配错误来源都被拒绝，局域网地址无法连接。
- 在空闲终端上重复上述攻击，排除「已有连接」造成的假通过；合法令牌加 `file://` 来源能够连接。

当前结果：在 Windows 11 上，源码运行和 NSIS 安装版通过全部自动检查。

## 尚未验证

- macOS 和 Linux。
- 人工长时间使用、搜狗拼音以外的输入法、音效、全屏模式、各主题和键盘布局。

## 已知问题

- 系统面板轮询频繁。在 GitHub Actions 这类负载很高的机器上，曾观察到终端输入延迟数十秒，后续会恢复。
- Windows 目录跟踪只支持 `shellArgs` 为空时的 PowerShell 和 cmd，其他 Shell 仍显示 `TRACKING FAILED`。
- `@xterm/addon-ligatures` 0.10.0 缺少声明的入口文件，目前直接引用其 `.mjs`。
- `pdfjs-dist` 仍是 2.11.338，只通过 `isEvalSupported: false` 缓解已知漏洞。
