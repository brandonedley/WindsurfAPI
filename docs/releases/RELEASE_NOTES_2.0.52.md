## v2.0.52 — sub2api 端到端实测发现的别名漏洞（#109 兜底）

v2.0.51 抠掉了上游 100% 拒的 6 个 SKU 但实际拿 sub2api 真接 WindsurfAPI 跑了 42 个模型之后又发现一坨**目录在但别名不全**的：客户端按 `gpt-5.2-medium` 这种 OpenAI 习惯写法发请求 我们的 `/v1/messages` handler 找不到 直接 400 回去 sub2api 转不过来。

### 问题模型

| 客户端写法 | 上次结果 | 实际应该映射到 |
| --- | --- | --- |
| `gpt-5.2-medium` | 400 Unsupported model | `gpt-5.2`（bare 就是 medium） |
| `gpt-5-2-medium` | 400 | 同上 |
| `gpt-5.4` | 400 | `gpt-5.4-medium`（家族 bare 缺失） |
| `gpt-5.3-codex-medium` | 400 | `gpt-5.3-codex`（bare 就是 medium） |
| `gpt-5.2-codex` | 400 | `gpt-5.2-codex-medium` |

根本原因是 5.x 系命名习惯不统一：
- 5.1 / 5.5: bare + `-medium` 都有
- 5.2: 只有 bare（bare = medium）
- 5.4: 只有 tier（none/low/medium/high/xhigh）没有 bare
- 5.3-codex: 只有 bare

下游客户端（sub2api / cherry / openwebui / cursor）按 OpenAI 官方习惯发 `gpt-5.2-medium` 一律落空。这次给 5 个常见漏写法都补上 alias 不动 catalog 主体。

### 实测拓扑

```
Client → sub2api(<PROD_VPS>:8090) → WindsurfAPI(<LAB_HOST>:3888) → Cascade upstream
        [Anthropic /v1/messages]      [apikey type, base_url override]
```

sub2api 通过 `apikey` 类型账号 + `credentials.base_url` 字段把 WindsurfAPI 当 Anthropic upstream 用。通了。

### 数字

- 测试：506 → **507** (+1 / 0 失败)
- 改动：
  - `src/models.js`: 6 个 cross-tier alias（覆盖 5.2/5.4/5.3-codex/5.2-codex 的命名空缺）
  - `test/models-catalog-correctness.test.js`: 1 个 regression 钉死 cross-tier 解析

### 升级

```bash
docker compose pull && docker compose up -d
```

升完后 `gpt-5.2-medium` / `gpt-5.4` / `gpt-5.3-codex-medium` 这种习惯写法不再 400。
