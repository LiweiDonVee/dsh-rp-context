# 版本与能力

0.3.0 的宿主范围是 `>=0.2.1-rc.3 <0.3.0-0`，使用 Node24。0.1.0 在 rc.2 的既有验收仍是有效历史证据；本次新包不宣传尚未执行的 rc.2 支持。

| 组合 | 行为 |
| --- | --- |
| 仅 Context | 规范历史、摘要、表示、设置和作者注面板独立可用；不会接管主 Agent 历史 |
| 旧 Database 单来源服务 | 保留 databaseId/version 和裸 ID 的 legacy 适配 |
| Database 0.2 / apiVersion 2，legacy 基线 | 仅通过 materialAccess v2 使用 entryKey，冻结 binding 与 sourceKey/entryId/version 引用；事实写权限由 Database 强制 |
| 无 Last Step / 纯 legacy 故事 | Context 规范来源 parser 仍识别真实 rp_present 的正文采用链；冻结材料查看明确报告服务不可用 |
| Last Step 0.3，legacy 基线 | 优先 narratives 读取已采用正文；material 读取保存快照，并核验作者注接受 lineage |
| Database 0.3 + LastStep 0.4 + GM 0.2，新修订组合 | Context 0.3 的材料与显示使用 storyHistory 有效选择，canonical narratives/material 独立提供 note proof；该故事需要的投影缺失时明确报 EFFECTIVE_HISTORY_UNAVAILABLE |
| Story Kit 存档 | 插件级 transfer seam 提供 Context 片段；完整故事恢复还要求其他状态所有者和合法宿主日志 |

独立原生 fixture 与真实多插件组合验收分开记录。本地确定性模型验证程序、来源和请求边界，不代表付费模型叙事质量。新版原生证据见验收记录。

截至 2026-10-27，上述新组合的源码审查已通过，新增审批／两层重生实际组合 native 验收仍未完成。Database／LastStep 仍为可选依赖：有 storyHistory 时使用实际有效响应；缺方法时仅对该故事已有 canonical 版本元数据或真实 captured projection 要求新 reader，纯 legacy 日志／真实空投影允许旧读取。全局 capability 存在本身不能把旧故事升级为新依赖，授权／来源错误也不能转为空 legacy 历史。

旧 receipt 没有 `contextPreparation.historyProjection` 时仍可检查材料，并显示投影“未记录”。旧 Context 存档无需投影字段；新存档的 optional basis 由 0.3 严格验证，旧 owner 不会静默丢弃未知状态。有效投影不可用只阻止依赖选材的操作，独立 owner configure、作者注替换/清空及已验证 canonical 消费状态仍可用。
