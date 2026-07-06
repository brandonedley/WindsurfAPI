# 贡献指南 / Contributing

感谢想贡献代码 / Thanks for wanting to contribute.

## 简体中文

### 开始之前

- 想加功能请先开 issue 讨论 免得撸完 PR 方向不对被打回
- 想修 bug 直接提 PR 就行 小改不用先开 issue
- 想改 README / docs 直接 PR
- 不清楚项目结构 看 [README](README.md) 的 "它到底在干嘛" 章节 和 `src/` 下每个文件顶部的注释

### 代码风格

- 项目是 **零 npm 依赖** 纯 `node:*` 内置模块 PR 里不要 `npm install` 新包
- 用 ES Modules (`import/export`) 和 async/await
- 缩进 2 空格 单引号 带分号
- 新文件放 `src/` 对应目录 命名和现有保持一致
- LS 协议相关改动（`windsurf.js` / `proto.js` / `grpc.js`）改字段号时 在 PR 描述里注明来源（参考 proto 文件 / 反编译发现等）
- Dashboard UI 不要用 `alert()` / `confirm()` / `prompt()` 用 `App.confirm()` / `App.prompt()`

### Commit & PR

- commit 格式 `type(scope): 简短说明`，scope 可选但推荐（写受影响的模块）。例：
  - `fix(auth,server): account-pool safety — bounded lockout map, id-based refcount`
  - `feat(devin-connect): tool_call nativization stage-0 — fix double-send, def-gate outer=10`
- type 只用：`feat` / `fix` / `refactor` / `perf` / `docs` / `test` / `chore` / `ci` / `revert`
- subject 全小写英文、祈使句、无句号；多个改动点用 `—`(em dash)接补充、`+` 连列
- 复杂改动写 body（bullet 列表）：每条 `文件: 改了什么（为什么/追溯标记）`，追溯标记如审计 ID(`PNG-1`)、审查缺口(`R2`/`O1`)、issue(`#192`)
- **调试日志不单独成 commit**（不要 `debug:` 类型）；调试代码在合并前清掉或并进功能 commit
- 一个 commit / 一个 PR 解决一件事，多件事按主题拆开
- **绝不在 commit message 里加任何 AI / 助手署名尾注**（`Co-Authored-By: Claude`、`Generated with…` 等一律不写）
- 标题写清楚改了啥，body 写为什么改，而不是怎么改（diff 自己会说）

### 测试

项目暂无自动测试 手动验证即可 最好在 PR 描述里贴上：

- 跑了什么 curl 命令
- dashboard 哪个面板点了
- 复测了哪些模型（gpt-4o-mini 这类免费模型最方便）

### CI

GitHub Actions 跑 `node --check` 做语法校验 过了就可以 review。

---

## English

### Before you start

- Got a feature idea? Open an issue first so we can discuss direction.
- Fixing a bug? Just send the PR.
- README / docs changes? Just send the PR.
- Unclear about project structure? See [README](README.md) "What it does" section and the header comments in each `src/` file.

### Code style

- **Zero npm dependencies** — pure `node:*` builtins only. No `npm install` in PRs.
- ES Modules (`import/export`), async/await.
- 2-space indent, single quotes, semicolons.
- Put new files under `src/` in the matching directory. Follow existing naming.
- LS protocol changes (`windsurf.js` / `proto.js` / `grpc.js`): note the source of any new field numbers in the PR description.
- Dashboard UI: use `App.confirm()` / `App.prompt()` instead of native `alert()` / `confirm()` / `prompt()`.

### Commits & PRs

- Format: `type(scope): short description`. Scope optional but encouraged (the modules touched). e.g.
  - `fix(auth,server): account-pool safety — bounded lockout map, id-based refcount`
  - `feat(devin-connect): tool_call nativization stage-0 — fix double-send, def-gate outer=10`
- Types (only): `feat` / `fix` / `refactor` / `perf` / `docs` / `test` / `chore` / `ci` / `revert`.
- Subject: lowercase, imperative, no trailing period; join extra clauses with `—` (em dash), list items with `+`.
- Non-trivial changes get a body (bullet list): each line `file: what changed (why / trace tag)`, where a trace tag is an audit ID (`PNG-1`), review gap (`R2`/`O1`), or issue (`#192`).
- **Debug logging is never its own commit** (no `debug:` type); strip debug code before merge or fold it into the feature commit.
- One commit / one PR per concern. Split unrelated changes.
- **Never add any AI / assistant attribution trailer** to a commit message (`Co-Authored-By: Claude`, `Generated with…`, etc.).
- Title = what changed. Body = why (the diff speaks for how).
- Enable the commit template locally: `git config commit.template .gitmessage`

### Testing

No automated test suite yet. Manual verification is fine. In the PR description, include:

- What curl commands you ran
- Which dashboard panels you clicked through
- Which models you tested (free ones like `gpt-4o-mini` are easiest)

### CI

GitHub Actions runs `node --check` for syntax. Green CI is enough to ship to review.
