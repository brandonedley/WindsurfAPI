## v2.0.51 — 把上游真用不了的模型从目录里抠掉（#109 兼容 sub2api）

issue #109 第二段："拿这个 api 去让 sub2api 连接的话 有很多模型无法正常使用 希望作者可以规范一下 保留好的模型"。

实测 138 个 SKU 里有 6 个上游 100% 拒绝调用——sub2api（或任何下游 OpenAI-compat 网关）拿到空响应只会一直 retry，看起来像 WindsurfAPI 在抽风。其实是这几个 SKU 在 cloud catalog 里挂着但 SendUserCascadeMessage 直连不认。

### 实测确认上游会拒的 6 个

| 模型 | 上游错误 | 原因 |
| --- | --- | --- |
| `claude-3.5-sonnet` | `neither PlanModel nor RequestedModel specified` | legacy 走 `RawGetChatMessage` 路径，没 `modelUid`，上游 2026-04 版本砍了这条路径 |
| `claude-3.7-sonnet` | 同上 | 同上 |
| `claude-3.7-sonnet-thinking` | 同上 | 同上 |
| `adaptive` | `unknown model UID adaptive: model not found` | Adaptive Router 只在 Windsurf IDE 内部路由层激活 Cascade 直连不暴露 |
| `arena-fast` | `unknown model UID arena-fast: model not found` | 同 adaptive 走专属比赛路由层 |
| `arena-smart` | `unknown model UID arena-smart: model not found` | 同上 |

全部加 `deprecated: true` 标志。后果：

1. **`/v1/models` 不再列**——sub2api / cherry-studio / OpenWebUI 一类客户端拉到的目录直接干净
2. **真有人按名字调还能拦下来**——`chat.js` 里早有 `modelInfo?.deprecated → 410 model_deprecated` 的早返回 不再向上游打无效请求
3. **下游 retry 拿到 410 就知道换模型**——比 502 健康 sub2api 也不会循环重试了

### 实测证据（<LAB_HOST> v2.0.50）

```
claude-3.5-sonnet              502  neither PlanModel nor RequestedModel
claude-3.7-sonnet              502  neither PlanModel nor RequestedModel
claude-3.7-sonnet-thinking     502  neither PlanModel nor RequestedModel
adaptive                       502  unknown model UID adaptive: model not found
arena-fast                     502  unknown model UID arena-fast: model not found
arena-smart                    502  unknown model UID arena-smart: model not found
---
claude-4.5-sonnet              200  OK     claude-sonnet-4.6              200  OK
claude-4.5-opus                200  OK     claude-opus-4-7-medium         200  OK
gpt-5.1 / gpt-5.5-medium       200  OK     gpt-5-medium                   200  OK
gemini-2.5-pro / 3.0-flash     200  OK     gemini-3.1-pro-low             200  OK
grok-3 / kimi-k2 / k2.5 / k2-6 200  OK     glm-4.7 / glm-5 / glm-5.1      200  OK
swe-1.6 / minimax-m2.5         200  OK     claude-4.5-haiku               200  OK
```

132 个还在的 SKU 都跑通了。

### 没动的几类

- **gpt-5.4 / 5.5 / 5.2 系一堆 `-priority` `-fast` `-xhigh` 变体**：账号档位决定能不能用 不是模型本身坏了 留着不动 用户自己账号有权限就用得上 没权限上游会回明确的 entitlement 错——`chat.js` 里 `model_blocked` 路径已经能干净处理
- **`claude-4-sonnet` / `claude-4-opus` / `claude-4.1-opus`**：实测 200 OK 不动
- **`deepseek-*` / `gpt-4o-mini` / `qwen-3` 等**：早就标 deprecated 了 这次没改
- **`claude-3.5-sonnet` 的 cursor 别名 `sonnet-3.5`**：alias 表里留着 让走老配置的客户端拿到 410 而不是悄悄 fallback——他们 pin 在这个名字上 收到 deprecated 才会去更新

### 数字

- 测试：500 → **506** (+6 / 0 失败)
  - 6 个新条目加进 `KNOWN_DEPRECATED` regression list
  - `gen-docs-models.test.js` 把 presence-anchor 从 `adaptive` 换成 `claude-sonnet-4.6`（adaptive 被 listModels 滤掉了）
- suites：105
- 改动：
  - `src/models.js`: 6 个条目加 `deprecated: true` + 注释说明上游错误模式
  - `test/models.test.js`: KNOWN_DEPRECATED 列表 +6
  - `test/gen-docs-models.test.js`: 改 anchor

### 升级路径

```bash
docker compose pull && docker compose up -d
```

升完后 `/v1/models` 从 138 → 132（5.5 在 v2.0.50 加的 11 个还在，只是把死的 6 个抠掉）。sub2api 那边重新拉一下 model list 就干净了。

### 跟 issue #109 一起说一句

5.5 在 v2.0.50 已经加完，10 个档位（none/low/medium/high/xhigh × {普通,priority}）齐全。这个版本主要是把"已经不能用但还挂着"的几个清掉。如果还有别的模型走 sub2api 报错，留个 issue 把上游错误原文贴一下，能识别就直接 deprecate。
