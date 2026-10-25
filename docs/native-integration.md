# 真实基础插件联用

`scripts/integration-smoke.mjs` 将明确指定的 Database、Context、LastStep tgz 安装到新建的临时 DSH home，经当前官方 rc.3 原生宿主和 SDK 运行。不会导入兄弟仓源码、写生产 profile 或调用付费模型。

```powershell
node scripts/integration-smoke.mjs `
  --database-tgz ./downloads/dsh-rp-database-0.2.0.tgz `
  --last-step-tgz ./downloads/dsh-rp-last-step-0.3.0.tgz `
  --context-tgz ./artifacts/dsh-rp-context-0.2.0.tgz
```

也可设置 DSH_DATABASE_TGZ、DSH_LAST_STEP_TGZ、DSH_CONTEXT_TGZ 后运行 `pnpm smoke:integration`。可选 DSH_BIN、PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH 指定本机启动器/现有 Chromium；`--evidence-dir` 指定证据目录，默认 `.runtime/integration-evidence`。每次记录真实包路径和 SHA256，不根据相邻源码猜测版本。

这组测试使用真实 Database materialAccess、Context.prepare、LastStep 原生 rp_present、模块编译、writer、canonical 接受、owner material/narratives。唯一额外主回合工具明确标识为 synthetic working-entry update，不是生产 GM；场景文本、模型和 HTTP embedding/rerank 返回均为合成、确定性数据。实际 native 工具与服务执行没有被替换。

覆盖多来源同裸 ID、required union、禁用正文不进入检索/模型、受保护事实混合批次拒绝、候选外检索、BOM/CRLF 原件保留；编译前失败释放作者注、编译后失败保留 claim、真实 rewriteOf 只重做 writer 阶段、替换 owner 注不被旧 retry 消费、重复 retry 拒绝。记录 main 调度与独立阶段次数，不能把额外的 main dispatch 说成零调用。

Context 窗口只影响自己的材料与 writer；测试核对较早正文已摘要，但仍保留在真实主模型输入。实际 Session prefix fork 检查 Database/Context 的因果状态、LastStep canonical narratives 读取；owner 材料面板读取真正冻结的条目/版本、模块和模型。实际进程退出/重启后，对照 canonical event 前缀并检查没有历史模型/工具重放。

此基础检查点没有运行生产 GM 回执路线，也没有用 fixture helper 代替生产稿件采用。生产 adoptDispatch、自动 LastStep composition 继承和完整 saved-story restore 等最终 seam，等待相应已验收包再补。它不是完整 GM/StoryKit/Studio 联用或真实模型叙事质量验收。

![真实 LastStep 冻结模块与模型记录](images/integration-material.png)
![旧 retry 后保留的新作者注](images/integration-note.png)

## Export lock 窄回归

`node scripts/export-lock-smoke.mjs --context-tgz ./artifacts/dsh-rp-context-0.2.0.tgz`（或 `pnpm smoke:export-lock`）只安装 Context，在独立 rc.3 home 验证 standalone 与真实外层 Agent.runMaintenance 下调用同一 export 的组合，以及实际 generating 时拒绝。没有 writer/restore 场景；唯一模型调用用于受控 busy guard。默认证据在 `.runtime/export-lock-evidence`，记录受测包 SHA256。

这是公开 SDK 锁组合的定点回归。七包 SavedStory 必须由协调者带入批准后的 Context 包重验；不以省略 Context 或新建 alreadyLocked 字段代替。

## 恢复后同 payload 的冷态 preflight

```powershell
node scripts/restore-preflight-smoke.mjs `
  --context-tgz ./artifacts/dsh-rp-context-0.2.0.tgz `
  --last-step-tgz ./downloads/dsh-rp-last-step-0.3.0.tgz `
  --snapshot ./downloads/main-snapshot.json
```

该脚本显式接收真实包和已导出的 Snapshot，记录三者 SHA256；在独立 rc.3 home 中只安装 Context/LastStep。它以公开 Session persistence create/append/flush/close 和 query 冷验证原始 exact-ID 日志，先真实 LS.restoreState，再 Context.restoreState。检查同 payload 的 warm/cold preflight、真实冻结 note proof、后续 owner 改注冲突及同 job replay 无覆写。不会恢复 GM/StoryKit 或 resume/activate Agent，不会请求模型。默认证据在 `.runtime/restore-preflight-evidence`，`--evidence-dir` 可覆盖；这项 owner seam 回归不替代协调者的七包恢复验收。
