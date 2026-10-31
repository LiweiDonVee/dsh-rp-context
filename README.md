# DSH RP Context

独立的主动上下文与 GM 选材插件。保留原始叙事，让模型按本轮需要选择完整正文、事实摘要或索引，并为最终写作准备数据库条目与历史材料。

**0.3.1 界面更新：** 安装 RP Studio 1.5.0 后，从 **RP ▾ → 上下文** 打开完整原生页面；会话顶部与空白页的重复入口自动收纳。未安装或卸载 Studio 时恢复独立入口，右侧原生页签始终保留。管理界面的字体和字号随宿主设置变化。

![DSH 原生工作区](docs/images/workspace.png)

## 安装与范围

Context 0.3.1 面向 DSH 0.2.1-rc.3。安装包为 `dsh-rp-context-0.3.1.tgz`，下载入口为 [Releases](https://github.com/LiweiDonVee/dsh-rp-context/releases)。退出 DSH、安装并重启：

```powershell
dsh plugin --profile desktop add ./dsh-rp-context-0.3.1.tgz
```

Web 模式改为 web。安装 RP Studio 1.5.0 时从 **RP ▾ → 上下文** 打开；单独安装时使用顶部 **上下文**，也可打开右侧 **主动上下文** 页签。插件独立构建，不需要 RP Studio 源码；正式准备流程由可选的 RP 最后一步调用。

本版窗口作用于 **中间 GM 与最终正文模型** 的独立输入。DSH 主 Agent 的会话日志与请求保持宿主原有管理，插件不篡改已冻结请求，不替换压缩后端。需要主循环全局压缩时使用经过对应版本验证的 DSH／ACP 接口。

## 默认行为

- 最近 5 轮已确认叙事保留完整正文，更早采用实际摘要；轮数可配置，不按工具消息数量计数。
- 没有摘要的旧叙事在准备阶段由独立摘要模型生成，最多每批 8 条。截断片段不会冒充摘要。
- GM 可按规范来源引用展开原文、修改摘要、折叠到索引；原文始终由 DSH 日志保留。
- 回退、被替换的分支与失败稿件不进入有效叙事。未决承诺、伏笔和提案另列，不因压缩自动变成已发生事实。
- 界面可以检查原文、调整表示、填写事实摘要、搜索当前分支，以及配置保留轮数、材料字符预算和 GM 步数。

界面里的展开原文不等于删除或重写历史。表示调整、摘要缓存、来源和分支关联分别保存，重启后重新从规范结果重建有效历史。

## 数据库与最后一步

可选 [RP Database](https://github.com/LiweiDonVee/dsh-rp-database) 提供固定版本的故事资料。当前事实／正文修订组合使用 **Database 0.3.1、LastStep 0.4.1、GM 0.2.1、Context 0.3.1**；可配 Loop 0.1.1、Studio 1.5.0 与 StoryKit 0.2.1。旧 Database 0.2／LastStep 0.3 基线与纯 legacy 故事仍按[兼容说明](docs/compatibility.md)运行，Context 也可独立安装，不把新 reader 强制施加到所有旧故事。

多来源引用按 sourceKey 与 entryId 区分，同名 ID 不合并；旧单库服务继续使用 legacy 适配。关键词／向量／重排先给候选，GM 之后可以：

1. 读取候选正文，主动搜索候选外的条目；
2. 选择、排除和排序自动条目，必开与禁用仍由程序执行；
3. 新建、修改允许的会话条目，附本次准备的临时备注；
4. 结合所需历史和叙事指导，提交冻结材料。

GM 已登记的事实条目只能由事实阶段提交，材料准备阶段不能修改。原生面板可填写一次性的下次写作作者注：准备时固定，正式接受后使用，writer 失败时留给同次重试；保存新注不会改变旧快照。作者注只指导表达，不成为事实。

legacy 路径可由 RP 最后一步 0.3 提供已采用正文与精确材料检查；新事实／正文修订使用 0.4 的有效历史。采用正文后创建新的规范 revision ID，旧摘要和表示不会误用到新正文。面板只列当前分支的正式叙事；展开冻结材料可查看当时条目及版本、历史表示、编译输入和实际模型记录。

启用事实/正文修订的 LastStep 提供 `storyHistory` 时，选材与面板只使用当前事实版本选中的正式正文；新事实尚无正文时不沿用旧事实正文。旧正文仍是 canonical 接受审计，折叠不会返还其已消费作者注。正文重生使用原冻结材料，不领取后来保存的新注。原选中来源或事实组被替代/移除后，旧自动计划与未决事项不进入新准备；普通追加会保留仍精确匹配的摘要和计划，手动表示按仍选中的来源保留。设置与下次作者注保留。缺少新功能所需历史投影时明确报告 `EFFECTIVE_HISTORY_UNAVAILABLE`，独立配置与作者注操作仍可用。

人物知情使用自由文本备注，由 GM 判断，不做 NPC ACL。数据库资料是参考数据，不能改变模型协议、人类权限或已经确定的行动结果。

[RP 最后一步](https://github.com/LiweiDonVee/dsh-rp-last-step) 在首次文风模块组装之前调用这个准备阶段，再将冻结的条目内容、版本引用、历史表示、最近正文和指导交给 writer。writer 没有数据库写工具。数据库修改是自己的事务，正文失败不意味着重新执行事实工具。0.4 的正文重生复用已冻结材料，不重新调用 Context；原生 owner 调度中的主模型请求与 writer 分别计数。

可选 Loop Studio 为 **RP 上下文与数据库选材**、**RP 历史摘要** 分别配置实际模型。无节点覆盖时继承本次调用的模型，切换路由不会带入另一模型的推理强度。

## 有界行为

默认准备循环最多 8 步，材料预算 24000 字符，可由人类调整。权限、版本冲突、未生成的必需摘要或超预算会明确阻止提交，不静默删除必开条目，不把未完成选择当成功。

关闭主动上下文后，最后一步沿用原有行为。未安装数据库时仍可只准备历史。模型故障、取消和提供方失败不擅自改选外部模型。模拟模型验收证明调用与程序边界，不证明任意真实模型的叙事判断必然正确。

## 服务、存储与开发

Agent 可使用 `rp_context_status/read/search/fold` 检查和调整当前有效叙事。可选服务 `ctx.get('rpContext').prepare({sessionId,agent,packet,baseModel,signal,presentationId?,factReceiptId?,story?})` 返回冻结材料；关闭时返回 null，调用方保持原行为。新呈现传入 presentationId 才会 claim 作者注，旧调用继续独立使用。事实回执和故事快照是单独参数，不扩展 packet 白名单。

准备结果可选 `historyProjection={schemaVersion:1,projectionKey,selectedPresentationIds,activeFactReceiptIds}` 来自该次捕获的 `storyHistory` 响应。它只证明选材/缓存依据，不授予事实或作者注接受权限。材料检查显示保存值；旧 receipt 缺字段显示“未记录”。

`state` 在有效历史缺失时返回明确 `historyError` 与真实设置、作者注和 revision，面板保留配置/注编辑；此时空 history 表示当前选材不可用。需要新投影的故事由真实 canonical 版本元数据与 Database 本故事 `factReviewProjection` 识别，单有全局 capability 不阻止纯 legacy 故事。

owner 服务 `setAuthorNote/authorNote/material` 管理作者注与快照。`presentationOutcome` 仅供插件在规范接受或失败后通知；成功消费还会核验真实叙事与 Last Step 冻结的 claim。`exportState/preflightRestore/restoreState/contentRevision` 为故事存档提供 Context 状态片段；恢复要求宿主先导入并验证原身份日志，再校验真实来源，拒绝已有会话冲突，不重造历史或携带提供方凭据。完整故事存档由 Story Kit 协调。

配置、摘要和表示计划保存在 `$DSH_HOME/app-data/rp-context/state.json`。正式原文在 DSH 会话日志；备份时同时保留两者，退出 DSH 后操作。来源引用包含规范 assistantMessageId 与工具事件序号，不用正文 hash 或可复用调用 ID 充当唯一依据。

```powershell
pnpm install --frozen-lockfile
pnpm check
pnpm package
```

需要 Node24、pnpm11.9。产物及校验文件在 artifacts。详细批准边界、接口及验收任务见 docs/implementation-plan.md。MIT 许可证。

[架构说明](docs/architecture.md) · [版本兼容](docs/compatibility.md) · [验收记录](docs/acceptance.md) · [更新记录](CHANGELOG.md)
