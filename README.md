# WorkBuddy Bridge

一个跑在本机的 **OpenAI 兼容反代**:把桌面 AI 客户端(桌面宠物、聊天面板、任何认 `POST /v1/chat/completions` 或 `POST /v1/responses` 的程序)接到**任意 OpenAI 兼容上游**(DeepSeek / OpenAI / Ollama / vLLM / LM Studio …),或接到 WorkBuddy 桌面通道(可选适配器)。

除了协议转换,它还处理了这类"一直在说话、一直在调工具"的客户端最容易踩的两个坑:base64 图片撑爆上下文、模型不调工具导致的回合死循环。

## 快速开始(任何 OpenAI 兼容上游)

```bash
git clone https://github.com/zhangyicheng774-gif/workbuddy-bridge.git
cd workbuddy-bridge

export WB_UPSTREAM_BASE_URL=https://api.deepseek.com/v1
export WB_UPSTREAM_API_KEY=sk-你的key
export WB_BRIDGE_TOKEN=wb-local        # 本地鉴权用的 token,客户端里填同一个
node server.mjs
# → bridge up on http://127.0.0.1:8787  upstream=openai
```

自检:

```bash
curl http://127.0.0.1:8787/healthz
curl http://127.0.0.1:8787/v1/models -H "Authorization: Bearer wb-local"
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer wb-local" -H "content-type: application/json" \
  -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"ping"}]}'
```

客户端里把模型地址指向 `http://127.0.0.1:8787/v1`、API Key 填 `WB_BRIDGE_TOKEN` 即可。

本地模型(Ollama)同理:`WB_UPSTREAM_BASE_URL=http://127.0.0.1:11434/v1`、`WB_UPSTREAM_API_KEY=` 留空。

## 可选的 WorkBuddy 上游

仓库**不包含**任何第三方 SDK。如果要把上游换成 WorkBuddy 桌面通道,把它的适配层放到:

```
vendor/wb/index.js       ← 上游 SDK 的 ESM 入口
vendor/wb/package.json   ← { "type": "module" }
```

入口需要导出这些名字(桥只调用它们):

```
WorkBuddyUpstreamClient   readAtRestKey        parseWorkBuddyAuth
defaultDesktopAuthCandidates   prepareChatBody   fallbackModelsFor
```

然后 `WB_UPSTREAM=workbuddy node server.mjs`。桥会自动从该桌面应用读凭据、必要时刷新 token。
没有 `vendor/wb` 时,桥仍然可以正常工作——只要给 `WB_UPSTREAM_BASE_URL` 走通用上游。

## 配置

| 变量 | 默认 | 说明 |
|---|---|---|
| `WB_UPSTREAM` | `auto` | `openai` / `workbuddy` / `auto`(有 `WB_UPSTREAM_BASE_URL` 就走 openai,否则有 `vendor/wb` 就走 workbuddy) |
| `WB_UPSTREAM_BASE_URL` | 空 | OpenAI 兼容上游的 `/v1` 地址 |
| `WB_UPSTREAM_API_KEY` | 空 | 上游 key(本地模型可留空) |
| `WB_BRIDGE_HOST` | `127.0.0.1` | 监听地址 |
| `WB_BRIDGE_PORT` | `8787` | 监听端口 |
| `WB_BRIDGE_TOKEN` | `wb-local` | 本地鉴权 token(客户端 `Authorization: Bearer …`;不带 header 的请求也放行,方便本机调试) |
| `WB_BRIDGE_MODEL` | 空 | 统一改写请求里的 model;留空或 `auto` 表示不覆盖 |
| `WB_PROVIDER_CONFIG` | 空 | 可选:宿主 provider 的 `config.json` 路径,把它里面的 secret 也当合法 token |

`.env.example` 里有模板;桥本身不读 `.env`,由启动脚本或进程管理器注入。

## 路由

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/healthz`、`/` | 健康检查(含当前上游类型) |
| GET | `/v1/models` | 上游模型目录;上游不提供时回退成配置里的单个模型 |
| GET | `/profiles` | 模型目录 + 一次看图自检(向每个模型问一张 1×1 色块图) |
| POST | `/v1/chat/completions` | 流式 / 非流式 |
| POST | `/v1/responses` | Responses API:转成 `response.created` / `output_item.added` / `output_text.delta` / `function_call_arguments.delta` / `response.completed` 事件流 |

`/v1` 前缀可重复、可省略。

## 两个护栏

**图片不再以文字进历史**。工具回执里的 `data:image/...;base64,...` 会被抽出来:回执正文只留 `[图片 #1]`,图片作为紧随其后的一条独立 user 消息携带;base64 超过 300 KB 的先缩到最长边 1280 / JPEG 80 再发,并按内容缓存,避免同一张图每轮重缩。纯文本回执超过 12 万字符会截断。

**终局信号兜底**。客户端给了工具、而模型一个都没调时(常见于模型只输出文字),补一个 `end_turn` 让回合正常结束;只在"一个都没有"时补,不改写模型已有的调用。

## 实测(一次真实部署的日志:26 小时、1886 次请求)

| 指标 | 处理前 | 处理后 |
|---|---|---|
| 单次请求输入 token(触发故障的那条链路) | 13,370,646 | **1,081** |
| 上下文超限 400(`code 11115`) | 3 次,且故障后每轮必现 | **0** |
| 工具调用配对错误(`code 11148`) | 32 次 | **0** |
| 零工具调用回合 | 35 次靠客户端重发 | 由 `end_turn` 收束 |
| 模型单价(相对倍率) | 0.51 | 0.11(−78%) |

## 测试

```bash
npm test          # 或 node test/e2e.mjs
```

测试会起一个**本地假上游**(不联网、不花钱),覆盖 14 项:健康检查、模型目录、非流式内容、模型覆盖、Responses 事件流、图片从工具回执中抽出、工具回执占位符、零工具调用兜底、鉴权。

## 目录

```
server.mjs        服务本体:路由 / 协议转换 / 两个护栏 / 上游适配
shrink-image.ps1  图片降采样(Windows PowerShell + System.Drawing;非 Windows 会跳过压缩)
test/e2e.mjs      端到端测试(假上游)
start-bridge.cmd  Windows 启动脚本
start-bridge.sh   macOS / Linux 启动脚本
.env.example      环境变量模板
```

## 说明与边界

- 默认只监听 `127.0.0.1`;没有对外暴露的设计。
- 图片降采样依赖 Windows PowerShell;其它平台遇到大图会退化为"省略并留占位",不会崩。
- `bridge.log` 会记录请求摘要与模型返回片段,**不要提交**(`.gitignore` 已排除)。
- 使用第三方上游时,请自行确认其许可与服务条款。

## License

MIT(仅覆盖本仓库自有代码)。
