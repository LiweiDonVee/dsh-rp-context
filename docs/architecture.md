# 正式历史、GM 选材与冻结材料

本插件管理自己的中间 GM 和 writer 材料，不改写 DSH 已冻结主请求。它也不注册自定义 Session 事件或接管宿主压缩服务。原文来自 DSH 规范事件，表示计划和摘要缓存保存在插件目录。

## 正式叙事来源

只有成功的规范 rp_present 工具结果进入历史：同时检查 assistant 中的调用、工具事件 turn/step、sourceEventSeqs 和 rpLastStep 元数据，避免 provider 重用调用 ID 串回合。失败稿、普通主 Agent 过程文字和被替换分支不作为叙事。

原文、事实摘要和索引是同一来源的不同表示。模型可用 readHistory 读取原文，用 historyOperations 选择 full、summary、index；原始文本始终不变。未生成的摘要不能用截断片段冒充。显式模式只作用于本轮投影，其他旧记录的摘要缺失不会阻止人类查看某条原文或索引。

## 有界 GM JSON 循环

第一阶段生成缺失的旧叙事摘要，每批最多8条、输入有明确字符上限。第二阶段的 JSON 决策允许 readEntries、search、databaseOperations、readHistory、historyOperations、selectedEntries、notes、unresolved 和 commit。

关键词/向量/重排只提供初始候选。search 能重新检索整个启用数据库，readEntries 可访问原候选之外的稳定 ID。数据库变化先在工作副本校验；只读、必开、禁用由数据库执行器强制，GM 不能修改策略。人物知情和揭示语义由 GM 结合普通备注判断。

提交时检查数据库与上下文 revision、整个材料序列化字符预算和来源，再提交一次数据库批次并保存上下文计划。数据库变化与正文是独立事务；后续 writer 失败不会授权重新运行已经完成的事实工具。

输出材料包含 history、entries、guidance、unresolved、recentProse 和 chars，连同来源/条目版本引用冻结。最后一步只读取这个快照；后续数据库修改不能改变已经开始的正文输入。

## 原生接口

rpContext.prepare 接收 sessionId、真实 agent、packet、baseModel、signal；关闭时返回 null。Loop 可为 rp-context.prepare 和 rp-context.summarize 分别路由。输入、路由和实际调用都使用操作捕获值，不继承其他模型的推理强度。

浏览器动作 state/configure/read/search/represent 经过 owner 授权。Agent 工具只处理当前会话。搜索结果也按最新活跃来源过滤，回退后既有结果和迟到响应都不能显示旧分支条目。SSE 只发阶段和变更元数据。

来源和表示计划跟随回合和分支，fork 继承有效计划的因果前缀，summary cache 按规范叙事 ID 保留但不会凭缓存重新制造已经失效的历史。设置、计划和缓存使用 revision 写队列及原子文件更新。
