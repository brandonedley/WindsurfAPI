## v2.0.69 — 一波 issue 实修：dashboard token 拆分 / thinking 长思考不杀 / partition 调试开关

把上一版欠的、计划里的、用户报但没回的几条一起 ship。每条都从生产 log / 真 probe 拿到证据再动手，不是糊弄。

### v2.0.68 上 partition + reasoning effort 真生效（先报喜）

`scripts/probes/v2068-end-to-end-probe.mjs` 直打 <LAB_HOST> 拿到的 server log：

```
Probe[3y8bnr]: model=gpt-5.5-xhigh stream=true tools=11 reasoning=xhigh
Chat[3y8bnr]: native bridge ON — model=gpt-5.5-xhigh
              mapped=[shell_command]
              unmapped=[apply_patch,update_plan,request_user_input,web_search,
                        view_image,spawn_agent,send_input,resume_agent,
                        wait_agent,close_agent]
              allowlist=run_command additional_steps=0
```

- ✅ `model=gpt-5.5-xhigh`（不是 `medium`）— mergeReasoningEffortIntoModel 把 codex 发的 `model="gpt-5.5"` + `reasoning.effort="xhigh"` 真合并了
- ✅ `native bridge ON` 真出现 — partition mode 真触发
- ✅ `mapped=[shell_command]` + `unmapped=[10 个]` — TOOL_MAP 拆分对

### #118 wnfilm — dashboard token 拆分卡上线

v2.0.68 修了 usage 计算（`prompt_tokens` 不再含 cache_write），但 dashboard UI 没拆。这版补：

- 新 `recordTokenUsage(usage)` 函数 — `chat.js` 在每次 `buildUsageBody` 后调，把 4 个 bucket 累加进 `stats.tokenTotals`
- `/dashboard/api/stats` 返回 `tokenTotals: { fresh_input, cache_read, cache_write, output, total, requests_with_usage }`
- dashboard 统计页加一张卡（占两列）：

```
┌────────────────────────────────────────┐
│ Token usage breakdown                  │
│  fresh    cache    cache    output    │
│  input    read     write              │
│  415      11.2K    683      251       │
│  3 req · total 12.5K                   │
└────────────────────────────────────────┘
```

zh-CN/en i18n 都有。一目了然 fresh 和 cache_read/write 是不是合理比例。

### #57 123cek — "思考 200 多秒之后会中断" 这条我之前漏回了

issue closed 后 123cek 留了"现在固定思考 200 多秒之后会中断"，我没看到。看 `client.js` 的 warm-stall：`sawText && lastStatus !== 1 && (Date.now() - lastGrowthAt) > 25_000`，模型如果 emit 了 text 然后 thinking 阶段静默 25s+ 就会被杀，但 Claude 4.x -thinking 系列在硬题上确实会静默 30-90s 才出下一个 token。

修法：thinking 已经 emit 过的情况下用更宽容的 `warmStallThinkingMs` 默认 120s，env `CASCADE_WARM_STALL_THINKING_MS` 可调。text-only 模式（没 thinking）保持 25s 不变。

```js
const effectiveWarmStallMs = totalThinking > 0
  ? CASCADE_TIMEOUTS.warmStallThinkingMs   // 120s 默认
  : NO_GROWTH_STALL_MS;                    // 25s 默认
```

### #115 zhqsuo — partition 下 GPT 还是 markers=none，加诊断/修路径开关

v2.0.66 的 partition 模式 `native bridge ON` 真触发了，但 GPT 仍然不调工具（v2.0.66 reply 里承认了这个 gap）。怀疑根因之一：partition 模式下 cascade 同时给 GPT 看到 native run_command **以及** 我们 inject 的 10 个 unmapped tool 的 emulation toolPreamble，模型困惑用哪条协议 → 干脆都不用 → refuse。

加 env 开关 `WINDSURFAPI_NATIVE_BRIDGE_NO_EMUL=1`：partition 模式开启后**完全压掉** unmapped emulation toolPreamble，让 GPT 只看到 cascade native 工具一份描述。两条路：

- 默认（OFF）：保持 v2.0.68 行为，partition + emulation 共存
- `=1` 开启：partition 时 emulation 完全关，unmapped 工具模型看不见

线上对比测哪条召唤率高。如果 NO_EMUL=1 让 markers != none 出现，下版翻默认。

### 改动

- `src/dashboard/stats.js` — 新增 `tokenTotals` state + `recordTokenUsage()` 函数
- `src/handlers/chat.js` — 两处调 `recordTokenUsage(usage)` + 新 `WINDSURFAPI_NATIVE_BRIDGE_NO_EMUL` 分支
- `src/dashboard/index.html` — 统计页加 token 拆分卡 (`stats-cards` innerHTML)
- `src/dashboard/i18n/zh-CN.json` + `en.json` — `card.tokens.title` / `card.tokens.subtitle.empty`
- `src/client.js` — `warmStallThinkingMs` 配 + warm-stall 逻辑改 thinking-aware
- `package.json` 2.0.68 → 2.0.69
- `test/v2069-issue-fixes.test.js` 新增 9 个 case

### 数字

- 测试：734 → **743**（+9 新 case）
- 全测 0 fail / 0 回归
- 改动：6 src 文件 + 1 新测试文件

### 升级

```bash
docker compose pull && docker compose up -d --force-recreate
```

操作员可选：

```bash
# 让 GPT 在 partition 模式下只看 cascade native run_command（实验，可能让 GPT 更愿意调工具）
WINDSURFAPI_NATIVE_BRIDGE_NO_EMUL=1

# 给深思考模型更长的耐心（默认 120s 应该够，硬题想再放可以调）
CASCADE_WARM_STALL_THINKING_MS=180000
```
