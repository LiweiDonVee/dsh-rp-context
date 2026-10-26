# 正式历史、GM 选材与冻结材料

本插件管理自己的中间 GM 和 writer 材料，不改写 DSH 已冻结主请求。它也不注册自定义 Session 事件或接管宿主压缩服务。原文来自 DSH 规范事件，表示计划和摘要缓存保存在插件目录。

## 正式叙事来源

只有成功的规范 rp_present 工具结果进入历史：同时检查 assistant 中的调用、工具事件 turn/step、sourceEventSeqs 和 rpLastStep 元数据，避免 provider 重用调用 ID 串回合。失败稿、普通主 Agent 过程文字和被替换分支不作为叙事。优先使用可选 Last Step narratives 服务，独立 parser 采用相同 revision 语义。

选材来源与接受来源分离。LastStep 的 `narratives` 与真实 canonical parser 保留所有实际接受版本，用于作者注活动性、接受和恢复证明；材料、read/search/catalog 与面板优先读取 `storyHistory.records`。后者由 LastStep 按 Database 当前事实版本选择，同轮旧正文不会进入新准备；新事实没有对应正文时该轮没有材料正文。新功能所需投影缺失或无效时返回 `EFFECTIVE_HISTORY_UNAVAILABLE`，不回退为原始旧版本。纯 legacy 日志仍保留独立 parser 路径，owner 配置、注编辑/reset 与注读取独立于材料投影。

原始成功结果和正式采用的 content-only replacement 用 `JSON.stringify([presentationId,resultSeq])` 标识不同 revision；source 保留 assistantMessageId、callSeq、baseResultSeq、resultSeq。采用后的正文来自当前 message.content，原 metadata.text 仍仅识别原执行记录。完整替换链必须保留原调用及 shadowed result，除 content 外身份和 metadata 深等。旧 UUID-only 摘要或表示仅能用于原始结果，不能跟到采用后的正文。

原文、事实摘要和索引是同一来源的不同表示。模型可用 readHistory 读取原文，用 historyOperations 选择 full、summary、index；原始文本始终不变。未生成的摘要不能用截断片段冒充。显式模式只作用于本轮投影，其他旧记录的摘要缺失不会阻止人类查看某条原文或索引。

## 有界 GM JSON 循环

第一阶段生成缺失的旧叙事摘要，每批最多8条、输入有明确字符上限。第二阶段的 JSON 决策允许 readEntries、search、databaseOperations、readHistory、historyOperations、selectedEntries、notes、unresolved 和 commit。

关键词/向量/重排只提供初始候选。search 能重新检索整个启用数据库，readEntries 可访问原候选之外的稳定 ID。数据库变化先在工作副本校验；只读、必开、禁用由数据库执行器强制，GM 不能修改策略。人物知情和揭示语义由 GM 结合普通备注判断。

只有 rpDatabase.apiVersion===2 才取得 materialAccess，并显式设置内部 facade.version=2。v2 所有浅选择及 operation.id 使用程序生成的 entryKey；材料条目仍保留 ref，结果 database 为 `{binding,revision,entryRefs:[{sourceKey,entryId,version}]}`。旧适配保持原形。材料 executor 在 staging 和 commit 都拒绝 GM 注册事实，混合批次不能留下部分修改。

提交时检查数据库与上下文 revision、整个材料序列化字符预算和来源，再提交一次数据库批次并保存上下文计划。数据库变化与正文是独立事务；后续 writer 失败不会授权重新运行已经完成的事实工具。

输出材料包含 history、entries、guidance、unresolved、recentProse 和 chars，连同来源/条目版本引用冻结。最后一步只读取这个快照；后续数据库修改不能改变已经开始的正文输入。

## 原生接口

rpContext.prepare 接收 sessionId、真实 agent、packet、baseModel、signal；关闭时返回 null。Loop 可为 rp-context.prepare 和 rp-context.summarize 分别路由。输入、路由和实际调用都使用操作捕获值，不继承其他模型的推理强度。

浏览器动作 state/configure/read/search/represent 经过 owner 授权。Agent 工具只处理当前会话。搜索结果也按最新活跃来源过滤，回退后既有结果和迟到响应都不能显示旧分支条目。SSE 只发阶段和变更元数据。

来源和表示计划跟随回合和分支，fork 继承有效计划的因果前缀，summary cache 按规范叙事 ID 保留但不会凭缓存重新制造已经失效的历史。设置、计划和缓存使用 revision 写队列及原子文件更新。

fork 只把复制的父 ref 与真实 child canonical prefix 逐字段核对后，将其 sessionId 重映射为 child；其他字段不变，也不全局忽略 sessionId。旧计划保留 prior basis 供因果回退，当前投影与首次 child prepare 则使用 LastStep 实际 child key，并保存新的 child basis。未验证或已被替代的来源不重映射。

有效历史下，plan 保存可选 `historyProjection` 与 `historyRefs`，以 `ownerRepresentationIds` 标记手动表示；摘要缓存用 `summaryProjectionKeys` 与 `summaryRefs` 保存 exact narrative ID 的投影及真实来源依据。原选中 ref/事实组被替代或移除时自动表示与未决 carry 不进入请求，重新从当前选中正文和当前 packet 准备。普通追加保留计划；精确仍选中的 ref 可复用实际摘要，手动表示也按 exact ref 保留。已有 owner 设置与 pending note 保留。投影 key 是缓存依据，不是事实或 canonical 接受权限。

无 `storyHistory` 时，Context 检查真实 canonical 版本元数据与可用的本故事 Database `factReviewProjection`；active/pending captured group 即使没有正文也要求有效 reader。全局 capability 本身不要求 reader，空 projection 与纯 legacy 日志可保留原路径。`state` 只在 `EFFECTIVE_HISTORY_UNAVAILABLE` 时提供 `historyError`、空材料历史与真实设置/注/revision，面板明确不可用并保留 owner 控件；授权、损坏及其他来源错误仍透传。

已存在 owner reader 抛出的未知异常（包括无 code 的 SyntaxError/TypeError）原样透传，不改写成缺依赖或转回 raw parser。canonical reader 只有明确报告 `EFFECTIVE_HISTORY_UNAVAILABLE` 时可使用独立 parser；缺方法仍按本故事能力决定 legacy 路径。

## 作者注与材料检查

带 presentationId 的准备在第一个摘要/GM 调用前，从同一 store 队列捕获 revision 与一次性作者注。note 文本作为独立 authorNote 指导输入，并以明确标签加入最终 guidance；顶层只返回 `{id,version,claimId}`。作者注不是事实条目。Context 自己失败即释放；Last Step 组装未冻结失败也释放，完整 writer 输入冻结后失败保留原 claim 供 retry。

接受消费必须同时证明活动 canonical finishing presentation，以及 Last Step material 中匹配的冻结 note ID、version、claimId。后来的 owner 编辑不会被旧 retry 消费。claim 与 accepted source anchors 按活动分支投影；回退恢复同一最新 owner 版本为 pending。fork 只将投影后 pending 文本复制为子故事的新独立 note ID，不复制父 claim lineage。

原生面板 owner material 动作只代理 Last Step 的保存快照。候选池只显示当时记录的有界元数据，旧 receipt 缺字段显示未记录；不从当前数据库补造，不展示虚构思考。历史、条目、版本、compiled 模块、模型和 chars 都读冻结值，SSE 不发送正文。

prepare 的可选 `historyProjection={schemaVersion:1,projectionKey,selectedPresentationIds,activeFactReceiptIds}` 在读取有效响应时捕获，列表去重并保留 owner 顺序，不在模型完成后按最新 current 重建。材料检查直接显示此冻结值；旧 receipt 没有该字段时明确“未记录”。折叠或替代正文不改变 canonical note proof；真实因果移除原接受结果仍按原回退规则投影 pending。

## Context 存档片段

plugin-only `exportState/preflightRestore/restoreState/contentRevision` 使用 schemaVersion 1 DTO，仅包含请求的 sessions 及其 settings/baseline/plans/summaries/authorNote/authorNoteVersion/noteClaims。StoryKit 唯一持有 aggregate Agent maintenance scope，Context.exportState 不重取宿主维护锁。Context 自己在前后检查公共 idle 状态、Agent/Session 身份，通过授权 owner reader 读取实际日志，保留自身原子 store snapshot，并检查 canonical events 和 contentRevision 稳定；真实生成或变化返回 EXPORT_CHANGED。单独调用是经检查的 owner-local snapshot，不承诺跨 owner 原子性。prefix 外缓存不会导出；restore 的原有 idle/proof helper 保持。

0.3 的 plan 可带上述投影 basis/来源/手动标记，session 可带 `summaryProjectionKeys`/`summaryRefs`；这些都是显式校验的 optional 字段，旧存档缺字段仍可读。basis 只约束缓存，不增加公开 owner mutation 或成为事实存储。有效选择不能制造 consumed note：恢复仍只核验真实 canonical finishing result 与已恢复 LastStep material 的冻结 claim。

preflight 仅检查结构、依赖与冲突。Story Kit 先导入并冷验证 exact-ID Session，再调用 restoreState。恢复通过 owner reader 核验实际 assistant anchors、全部原始/采用 revision 和 note 来源，之后按 expectedRevision 一次原子写入。restoreId 同 payload 幂等，不同 payload 或已有非本次恢复状态拒绝。插件 DTO 不生成已接受历史，不复制提供方凭据，不提供独立事件映射。

preflight 对已存在的 Session 比较经过同一严格 schema 验证及既有默认值正规化后的完整 row；相等时支持，真实字段变化仍冲突，不只比较当前公开投影，也不忽略内部 note proof 字段。owner 全局 revision 与对象键顺序不属于 row 内容。此只读检查不授予覆写权：新 restoreId 仍拒绝已有 row；同 job replay 只返回已记结果，不重新导入或覆盖恢复后的 owner 编辑。

冷 child 导出先按父子顺序完成与普通读取相同的惰性继承，再捕获 Context row；保留有效因果 plan 前缀，不把父后续 plan 展平。恢复 consumed 作者注还要求完整 canonical log 中真正成功的 finishing rp_present，以及已恢复 Last Step material 中相同的 note id/version/claimId，并且能无歧义地推导唯一 finishing ID。缺依赖返回 RESTORE_REQUIREMENT_MISSING，伪造、歧义 lineage 或不匹配快照返回 RESTORE_PAYLOAD_INVALID，均在原子写之前停止；普通接受缺失/歧义证据返回 PRESENTATION_NOT_ACCEPTED。合法旧消费可留作审计；当前状态及下一次 capture 还检查实际活动呈现，单独保留 assistant anchor 或存在其他不匹配的成功 receipt，都不会让已回退结果继续消费作者注。同 restoreId 改 payload 或 Session 集合返回 RESTORE_ID_CONFLICT。

严格接受或恢复验证后，内部 noteClaim 保存派生的 outcomePresentationId；普通读取使用本地 canonical parser 检查该结果是否仍有效，不重复依赖可选 Last Step material。卸载插件本身不会撤销既有消费或重新投递注。旧记录没有这个关联且有多个候选、暂时无法取证时，仅保留原账面状态为内部未复核；不挑选任意 finisher，不误置 pending，也不锁 owner。证明服务恢复后重验并缓存唯一 ID；结果确实撤除时仍按 R5 回 pending。此兼容不用于新接受或新恢复的证明。

owner 新注、空白 reset 与 settings 配置分别进行会话授权、自己的 DTO/revision 检查，不经旧消费证明。restoreState 则先检查最小可序列化 envelope，再在同一 store 串行 gate 内检查 journal identity 和规范化 Session 集合，之后才做完整 schema/revision、实际 logs/LS 依赖、语义证明和合并。completed 同 payload 重放不重新读依赖；不同 payload/Session 集合先返回 RESTORE_ID_CONFLICT。expectedRevision 不参与 payload 身份。
