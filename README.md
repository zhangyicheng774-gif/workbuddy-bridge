# WorkBuddy Bridge

一个跑在本机的 **OpenAI 兼容反代**:把桌面 AI 客户端(Coopanion / 任何认 `POST /v1/chat/completions` 或 `POST /v1/responses` 的程序)的模型请求,转发到 WorkBuddy 的上游通道,并把 SSE 流转回客户端认识的形状。

写它的原因很具体:桌面宠物那类「一直在说话、一直在调工具」的客户端,会把普通反代的边界情况全部放大——长上下文、几十个工具、base64 图片、被中断的回合。这个仓库除了转发本身,还包含我在真实使用中踩到并修掉的两类故障。

## 它解决什么问题

- **协议不匹配**:客户端只认 OpenAI 的两种入口,上游是 SSE 的 chat.completion.chunk。这里做双向转换(含 tools / tool_calls / reasoning_content / usage)。
- **上下文被一张图撑爆**:聊天客户端会把图片以 `data:image/...;base64,...` 塞进工具回执。一条 1900 万字符的回执 ≈ 1330 万 token,直接超过模型 1M 窗口,之后每一轮请求都 400,客户端表现为「突然被掐断、再也不说话」。
- **零工具调用的死循环**:模型只输出文字、一个工具都不调时,客户端会认为回合没结束,每 3 秒把同一条请求重发一遍。
- **模型与额度**:客户端写死的模型名可以在入口处统一改写(`WB_BRIDGE_MODEL`),便于整体切到更便宜的档位。

## 实测效果(来自本机 26 小时、1886 次请求的日志)

| 指标 | 处理前 | 处理后 |
|---|---|---|
| 单次请求输入 token(触发故障的那条链路) | 13,370,646 | **1,081** |
| 上下文超限 400(`code 11115`) | 3 次,每次故障后每轮必现 | 0 次 |
| 工具调用配对错误(`code 11148`) | 32 次 | 0 次 |
| 零工具调用导致的重发 | 35 次被兜底收束(每次约 650 条消息上下文) | 回合正常结束 |
| 模型单价(相对倍率) | 0.51 | 0.11(−78%) |

## 快速开始

```bash
# 1) 需要 Node.js 20+
node --version

# 2) 准备上游适配层
#    本仓库不附带第三方上游客户端(它有自己的许可证)。把它放到 vendor/wb/:
#      vendor/wb/index.js      ← 上游 SDK 的 ESM 入口
#      vendor/wb/package.json  ← { "type": "module" }
#    入口需导出:WorkBuddyUpstreamClient / readAtRestKey / parseWorkBuddyAuth /
#               defaultDesktopAuthCandidates / prepareChatBody / fallbackModelsFor

# 3) 起服务
node server.mjs
# → WorkBuddy 桥已启动: http://127.0.0.1:8787

# 4) 自检
curl http://127.0.0.1:8787/healthz
curl http://127.0.0.1:8787/v1/models -H "Authorization: Bearer wb-local"
```

客户端里把模型地址指向 `http://127.0.0.1:8787/v1`、API Key 填 `wb-local` 即可。

## 配置(全部环境变量)

| 变量 | 默认 | 说明 |
|---|---|---|
| `WB_BRIDGE_PORT` | `8787` | 监听端口(只绑 127.0.0.1) |
| `WB_BRIDGE_TOKEN` | `wb-local` | 本地鉴权 token,客户端用 `Authorization: Bearer ...` |
| `WB_BRIDGE_MODEL` | `deepseek-v4.1-flash` | 统一的模型覆盖;设 `auto` 关闭覆盖 |
| `WB_PROVIDER_CONFIG` | 空 | 可选:指向宿主 provider 的 `config.json`,把其中的 secret 也当作合法 token |

## 路由

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/healthz`、`/` | 健康检查 |
| GET | `/v1/models` | 上游模型目录(带倍率/上下文长度) |
| POST | `/v1/chat/completions` | 支持流式/非流式 |
| POST | `/v1/responses` | 转成 Responses 事件流(created / output_item.added / output_text.delta / function_call_arguments.delta / completed) |

## 两个修法的思路

**图片不再以文字进历史**:工具回执里的 `data:image/...` 会被抽出来,正文只留 `[图片 #n]`,图片作为紧随其后的独立消息携带;base64 超过 300 KB 的先缩到最长边 1280 / JPEG 80 再发,并按内容缓存,避免同一张图每轮重缩。纯文本回执超过 12 万字符也会截断。

**终局信号兜底**:当客户端给了工具、而模型一个都没调时,补一个 `end_turn`,让回合正常结束,而不是让客户端重发。只在"一个都没有"时补,不改写模型已有的调用——改名会让模型历史与用户看到的不一致。

## 目录

```
server.mjs        服务本体(路由 / 转换 / 护栏)
shrink-image.ps1  图片降采样(Windows PowerShell + System.Drawing)
start-bridge.cmd  Windows 一键启动
```

## 说明与边界

- 只监听 `127.0.0.1`,没有对外暴露的设计。
- 上游凭据由 `vendor/wb` 里的适配层从其宿主应用读取,**本仓库不含任何密钥**。
- 日志(`bridge.log`)会记录请求摘要与模型返回的片段,**不要提交**;`.gitignore` 已排除。
- 该项目依赖第三方上游 SDK 的运行方式,分发与使用请自行确认其许可与条款。

## License

MIT(仅覆盖本仓库自有代码)。
