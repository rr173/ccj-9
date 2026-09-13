# 双向文本编辑器（中文 ⇄ 阿拉伯文同段混排）+ 审阅快照 + 协作批注 + 审阅批次 + 审阅决策 + 定时执行队列（任务依赖与执行前审批）

一个零依赖 Node 服务 + 网页编辑器，支持同一段落内中文（从左到右）与阿拉伯文（从右到左）混排，
提供可恢复、可比较、带乐观并发控制的**审阅快照**功能，可锚定到逻辑字符范围、
支持回复与四态工作流的**协作批注**功能，把一组批注命名编组、
跟踪负责人/截止时间/实时进度/完整审阅记录的**审阅批次**功能，在批次批注上
逐条拟定保留/替换/删除方案、多人投票、三版本校验后部分执行并可撤销的**审阅决策**功能，
把达标草案发布到执行队列、锁定版本、到点由服务端自动执行、可暂停/恢复/取消/失败重试的
**决策发布与定时执行**功能，以及在执行队列上为未开始任务配置**前置任务依赖与
1~3 名审批人的执行前审批**（部分成功需确认、失败等待、取消阻断、到点未满足绝不执行、
重启恢复、全流程留痕关联快照），最后提供**执行回放**：把指定时间范围内的任务、审批、
执行尝试、逐条结果与关联快照导出为可下载的审计包（版本/依赖/审批流水/冲突原因/快照关联/
事件链哈希齐备），导入独立的只读回放空间按时间线查看与筛选；导入全量校验、同包幂等、
同标识冲突拒绝、失败留痕、重启可恢复，绝不改动线上批次与决策数据。在回放空间上还提供
**历史证据复核**：负责人针对时间线中锁定的事件或逐条执行结果添加复核意见（指定复核人、
状态、截止时间），按状态/复核人/截止时间筛选并导出独立复核清单；意见双重版本并发控制、
已关闭终态不可覆盖、引用目标必须存在，历史内容始终只读，复核全程不触碰线上暂停/审批/
执行接口。

## 双向编辑的需求与实现对照

| 需求 | 实现方式 |
|---|---|
| ←/→ 按阅读顺序移动光标，不在语言切换处乱跳 | 浏览器原生双向光标引擎（UAX #9），方向键按**视觉顺序**逐字移动 |
| 删除恰好删掉屏幕上圈住的字符 | 原生选区模型：选区即视觉范围，Delete/Backspace 只移除该范围对应的逻辑字符 |
| 新字符出现在光标的视觉位置 | 原生插入行为：浏览器维护视觉位置 ↔ 逻辑偏移的映射 |
| 折行/缩放后光标仍在同一字符旁 | 浏览器在重排（reflow）时自动保持光标对字符的附着 |

**核心设计决策**：这四条行为本质上就是浏览器 contenteditable 的原生能力。任何用 JS 自绘光标、自算选区的“重写”方案都只会引入更多边界 bug，因此编辑器基于 `contenteditable` 构建，JS 只负责段落方向管理、纯文本粘贴、状态栏与快照。

## 审阅快照功能

保存时记录**每段**的：文本、段落方向（`dir`）、最后编辑时间（`data-edited-at`）。

| 需求 | 实现方式 |
|---|---|
| 带名称保存全部段落，刷新后仍在 | `POST /api/snapshots`，服务端原子写入 `data/snapshots.json`（可用 `SNAPSHOTS_FILE` 改路径） |
| 查看快照列表、任选两个比较 | 列表 + 两个下拉框；比较结果按段落对齐、按**逻辑码点位置**标注增删 |
| RTL 不能把增删位置标反 | 差异偏移完全按内存中的 Unicode 码点顺序计算（半开区间 `[start,end)`，从 0 计），**不读屏幕布局、不做视觉反算**；渲染时每个文本片段包 `<bdi>` 隔离，位置标签强制 `dir="ltr"` |
| 恢复前必须预览被覆盖内容并二次确认 | 恢复按钮先弹三列预览（段落 / 当前编辑区 / 恢复后），勾“已逐段核对”复选框后确认按钮才可点；取消、Esc、点遮罩或 × 都**不会触碰编辑区** |
| 确认后状态栏和光标同步 | 恢复后焦点进入编辑区、光标置于首段开头，状态栏立即刷新 |
| 多人/多页面同时操作：旧页面保存或删除必须报版本冲突 | 集合有单调版本号 `rev`，所有响应带 `X-Snapshot-Rev`；`PUT`/`DELETE` 必须带 `If-Match: <rev>`，服务端要求**严格相等**，否则 `409 version_conflict` 且不写盘；前端弹冲突框并自动刷新列表 |
| 名称重复 / 为空 / 文本过大明确拒绝 | 空名称 400、超 100 字符 400；重名 409 `duplicate_name`；单段 > 5 万码点或总量 > 10 万码点返回 413；非法 JSON 400；缺 `If-Match` 428 |
| 错误请求不能让后续编辑失效 | 所有校验在写存储之前完成；写盘失败回滚；前端所有接口失败只 toast 提示，编辑区 DOM 不受任何影响 |

### HTTP API 摘要

```
GET    /api/snapshots            列表（摘要）+ 当前 rev
POST   /api/snapshots            新建（名称不能为空/重复/超长，文本有大小上限）
GET    /api/snapshots/:id        详情（含全部段落）
PUT    /api/snapshots/:id        覆盖保存（必须 If-Match: <rev>）
DELETE /api/snapshots/:id        删除（必须 If-Match: <rev>）
```

冲突响应示例：`409 {"error":"version_conflict","message":"…","currentRev":7}`。

## 协作批注功能

审阅者在编辑器中选中一段文字即可创建批注。每条批注记录：**引文（原文）、段落方向、
字符起止位置（逻辑码点，半开区间 `[start,end)`）、创建时间**、署名与正文。

| 需求 | 实现方式 |
|---|---|
| 编辑/换行/方向切换后批注仍指向原字符 | 锚点 = 段落号 + 逻辑码点区间 + 引文快照。每次文档变化后 `ReviewCore.reanchor` 在**码点数组**上重定位：原位校验 → 段内就近查找 → 全文查找；引文被删则标记“锚点失效”。方向切换与折行不改变文本，锚点天然不动 |
| 批注显示原文/方向/起止/时间 | 列表与详情均展示；引文包 `<bdi>` 隔离，位置标签固定 `dir="ltr"`，RTL 段落里数字不翻转 |
| 回复、四态工作流 | 详情弹窗内回复；状态可逐条或批量在 **待处理 open / 处理中 in_progress / 需复核 needs_review / 已解决 resolved** 间流转，解决时记录解决人与时间 |
| 与审阅批次关联 | 批注列表/详情显示所属批次徽标，可按批次筛选；批次归档后成员批注状态冻结（不能改状态、回复或删除） |
| 解决状态与快照关联 | 保存/覆盖快照时，服务端把当前批注集合（含四态状态、回复与所属批次 `batchInfo`）整体嵌入快照记录（`annotations` + `annotationRev`）；查看历史快照可看到当时的批注、状态与所属批次，且可从快照**恢复批注集合**（整体替换，带乐观锁） |
| 多页面同时编辑：提交/状态/批量操作必须检测版本 | 批注集合与批次集合各有独立单调版本号 `rev`，响应带 `X-Annotation-Rev` 与 `X-Batch-Rev`；**所有**变更必须 `If-Match: <rev>` 严格相等。成员状态变化**同时推进两个版本**，因此任何人改过成员状态后，旧批次页面的批量更新都会收到 `409 version_conflict`——旧页面无法覆盖别人的新状态 |
| 锚点失效/范围为空/内容为空/超限要明确提示且保留输入 | 前端先用 `review-core.js` 本地校验，失败时错误显示在弹窗内、表单内容原样保留；提交前再次校验锚点有效性；服务端用同一模块复核（空内容 400、空范围 400、引文与范围不一致 400、正文 >1000 字符 413、引文 >5000 字符 413、批注总数 >500 413、回复 >100 条/批注 413） |
| 按段落、状态和批次筛选的审阅列表 | 段落下拉（随文档段落增减实时更新）+ 四态状态筛选 + 批次筛选（含“未加入批次”）；列表项实时显示重定位后的位置或“锚点失效” |
| RTL 下批注位置与回复按逻辑顺序对应 | 位置一律逻辑码点偏移（不读屏幕布局）；回复按创建时间排序；文本一律 `<bdi>` 隔离 |

编辑器内的高亮使用 **CSS Custom Highlight API**（`::highlight(review-open/progress/needs-review/resolved)`），
不向 contenteditable DOM 注入任何节点，因此不会破坏光标、选区与撤销栈；
浏览器不支持时静默降级，列表功能不受影响。

## 审阅批次功能

把当前文档的一组批注组成一个**有名称的审阅批次**，设置负责人、截止时间和说明，
按批次逐条或批量跟踪四态进度；批次进度由成员批注状态**实时计算**，刷新页面后自动恢复。

| 需求 | 实现方式 |
|---|---|
| 命名批次 + 负责人 + 截止时间 + 说明 | `POST /api/review-batches`；名称必填（≤100 字符），负责人缺省匿名，说明 ≤2000 字符；截止时间必须是**晚于当前**的合法时间，空批次（无成员）400 拒绝 |
| 同一条批注不能同时属于两个未归档批次 | 成员归属以批次 `memberIds` 为准，批注记录冗余 `batchId/batchName`。创建批次或加入成员时服务端全局查重：重复加入返回 409 `annotation_already_in_batch` 且整次操作不改动任何成员 |
| 逐条/批量标记四态 | 逐条走 `PUT /api/annotations/:id`；批量走 `POST /api/review-batches/:id/status`，可一次对任意成员子集设置四态，返回 `changed/unchanged`。前置校验全部通过才写库：包含不存在的批注→404，包含非本批次/已归档批次成员→409，任一失败整批拒绝、不覆盖任何状态 |
| 批次进度实时计算 | `ReviewCore.batchProgress` 根据成员**当前状态**即时统计四态计数、已解决数与百分比（`resolved/total`，全部解决才算完成），列表卡片与详情都不缓存进度 |
| 刷新页面后恢复 | 批次与审阅记录原子落盘 `data/review-batches.json`（`REVIEW_BATCHES_FILE` 覆盖），重启后批次、进度、成员冻结快照与记录全部恢复 |
| 多人同时操作：旧页面批量更新必被拒绝 | 批次集合有独立单调 `rev`（响应头 `X-Batch-Rev`），批次变更必须 `If-Match` 严格相等；**成员状态变化同时推进批注 rev 与批次 rev**，所以别人在任何页面改了成员状态后，旧批次页面的批量/归档/加移成员操作一律 409，弹窗内提示并自动按最新数据重绘，表单与页面内容保留 |
| 负责人/截止/说明/状态变化写入可按时间查看的记录 | 只增不改的审阅记录（创建、改信息、成员加/移、逐条与批量状态变化、归档、快照恢复自动移出），`GET /api/review-batches/:id/logs?from=&to=` 按时间范围筛选，时间倒序返回；归档后记录仍完整可查 |
| 归档后冻结成员状态，但可查看完整历史 | `POST /api/review-batches/:id/archive` 在归档瞬间冻结成员批注快照；归档后批量/逐条改状态、回复、删除、加移成员、改批次信息全部 409（`batch_archived`/`annotation_frozen`）；详情仍返回冻结成员与完整记录 |
| 批次筛选 / 批注详情 / 快照查看与恢复显示所属批次及当时状态 | 批注列表可按批次（含“未加入批次”）筛选，列表项与详情显示批次徽标；快照保存时每条批注冗余 `batchInfo {id,name,status}`，快照批注查看显示快照时刻所属批次；从快照恢复时，缺少已归档批次冻结成员会 409 `archived_members_lost` 整体拒绝，未归档批次中已消失的成员自动移出并留记录 |
| 空批次、过期时间、已归档批次、不存在批注的明确提示 | 全部为独立错误码与中文消息（`empty_batch`/`deadline_in_past`/`batch_archived`/`annotation_not_found` 等），前端在弹窗内显示错误而不是跳转，**当前页面与表单内容保留** |

### 审阅批次 HTTP API 摘要

```
GET    /api/review-batches                 批次列表（含实时进度/是否过期）+ 当前 rev
POST   /api/review-batches                 新建批次（If-Match 必需；成员必须存在且未归属其他批次）
GET    /api/review-batches/:id             批次详情 + 成员批注实时状态（归档后为冻结快照）
PUT    /api/review-batches/:id             改名称/负责人/截止时间/说明（If-Match 必需）
POST   /api/review-batches/:id/members     加入/移出批注 {mode:"add"|"remove", annotationIds}（If-Match 必需）
POST   /api/review-batches/:id/status      批量设置成员四态（If-Match 必需；原子前置校验）
POST   /api/review-batches/:id/archive     归档：冻结成员状态与完整快照（If-Match 必需）
GET    /api/review-batches/:id/logs        审阅记录，支持 ?from=&to= 时间筛选
```

冲突响应示例：`409 {"error":"version_conflict","message":"…","currentRev":5}`。
批次数据默认写到 `./data/review-batches.json`（可用 `REVIEW_BATCHES_FILE` 覆盖）。

## 审阅决策功能

审阅者在**未归档批次**上创建决策草案，为批次中每条批注指定处理方案
（**保留 keep / 替换 replace / 删除 delete**，处理对象是被批注的原文），
不同审阅者对草案逐条**投票**（通过 approve / 驳回 reject / 弃权 abstain），
每条达到草案设定的通过人数且无驳回后，草案进入**待执行**状态；
执行前按段落生成预览，执行时同时校验三个版本，只应用未冲突条目，可部分成功并可撤销。

| 需求 | 实现方式 |
|---|---|
| 只能从未归档批次创建草案 | `POST /api/review-decisions` 必须带 `batchId`；批次不存在 404、已归档 409 `batch_archived`、批次已过截止 409 `deadline_passed`；同一批次最多一个未结束草案，重复创建 409 `duplicate_decision` |
| 每条批注填写保留/替换/删除 | 创建时可带初始 `items`，之后 `PUT …/items` 逐条/批量保存；非法方案 400、替换文本为空 400 `empty_replacement`、同一条批注提交两个方案 409 `duplicate_item`；方案不属于本草案 409。方案内容变化时该条已有投票自动作废（驳回后改方案即可重新计票），改票流水保留 |
| 空草案明确提示 | 批次没有成员不能创建（`member_missing`/`empty_draft`）；提交投票时仍有条目未选方案 → 400 `empty_items` 并返回 `unfilled` 列表，当前页面内容保留 |
| 按段落生成执行前预览 | `POST …/preview` 为纯计算（不写盘、不需要版本锁）：按草案创建时的段落基线对齐当前编辑区，逐段给出“当前文本 / 执行后文本”，并对每条批注给出成功/冲突/跳过判定与原因；可勾选只执行部分条目 |
| 多人逐条投票，达到通过人数才待执行 | 投票**必须记名**（缺投票人 400 `missing_voter`），同一人改票以最后一次为准、流水留痕；任何一条有驳回或缺票，草案停留 voting；全部条目 approve 数达到门槛才自动进入 ready |
| 执行前同时校验文本、批注、批次三个版本 | 请求回传当前编辑区段落：文本指纹（dir+text 的双哈希，不含 editedAt）不同即触发段对齐（`decision-core.mapParagraphs`，复用快照 LCS 对齐）；逐条比对——段落删除 `paragraph_deleted`、段落改写 `paragraph_changed`、方向改变 `paragraph_dir_changed`、引文位置变化 `quote_mismatch`、批注 `updatedAt` 变化 `annotation_changed`、批注被删 `annotation_deleted`、批注被移出批次 `member_removed`。**只把受影响条目标为冲突**，其他条目照常执行，绝不覆盖新文字或新批注 |
| 一次执行可部分成功 | `POST …/execute` 返回每条 `success/conflict/skipped`（跳过原因含 `not_approved`/`not_selected`）及按成功条目合成的 `afterParagraphs`；成功条目的批注标记 resolved，冲突/跳过条目不触碰。有任意成功条目草案即 `executed`，无成功条目则停留 ready 可修正后重试 |
| 成功、冲突、跳过都按时间留痕 | 执行写一条总记录 + 每条一条 `execute_item_success/conflict/skipped` 记录；`GET …/logs?from=&to=` 按时间筛选、倒序返回 |
| 撤销最近一次成功执行 | `POST …/undo` 仅允许撤销全局最近一次未撤销的成功执行（否则 409 `not_latest_execution`）：回滚成功条目对应批注为待处理，执行后又被别人修改/删除的批注**不覆盖**（`changed_since_execution`），返回执行前段落供客户端确认后写回编辑区；撤销后草案回到 ready 可重新执行，同一草案不能重复执行（409 `decision_executed`） |
| 决策状态/投票/执行结果与快照关联 | 保存或覆盖快照时把全部决策草案（逐条方案、当前投票、历次执行及撤销标记）整体嵌入（`decisions` + `decisionRev`）；快照列表新增“决策”按钮，查看历史快照即可看到当时的草案状态，`GET /api/snapshots/:id` 返回完整数据 |
| 已归档批次不能创建或修改草案 | 批次归档后其草案只读：改方案/投票/执行/撤销全部 409 `batch_archived`，详情与记录仍可查看（`batchFrozen`） |
| 过期草案明确提示 | 草案沿用批次截止时间；过期后改方案、投票、执行、撤销均 409 `decision_expired`，卡片与详情标“已过期”，当前页面内容保留 |
| 多人同时修改草案，旧页面提交必须被拒绝 | 决策集合有独立单调 `rev`（响应头 `X-Decision-Rev`），所有变更必须 `If-Match` 严格相等：旧页面任何提交都收到 409 `version_conflict` 且不写盘，弹窗内保留表单内容并按最新数据重绘；缺版本号 428 |
| 错误不清空页面 | 所有校验先于写存储；写盘失败回滚 rev/状态/记录；前端所有失败只在弹窗内红字提示或 toast，编辑区 DOM 与已填方案不受影响 |

### 审阅决策 HTTP API 摘要

```
GET    /api/review-decisions?batchId=   草案列表（含逐条进度/是否过期/批次是否归档）+ 当前 rev
POST   /api/review-decisions            创建草案 {batchId, name?, threshold?, paragraphs(基线文本), items?, actor}（If-Match 必需）
GET    /api/review-decisions/:id        草案详情（逐条方案/投票/历次执行）
PUT    /api/review-decisions/:id        改名/调整通过人数（仅拟定中，If-Match 必需）
PUT    /api/review-decisions/:id/items  保存/修改方案（If-Match 必需；重复 id 整批拒绝）
POST   /api/review-decisions/:id/submit 方案完成进入投票（全部条目必须已定方案）
POST   /api/review-decisions/:id/votes  逐条投票 {annotationId, vote, voter}（If-Match 必需）
POST   /api/review-decisions/:id/preview 执行前按段预览 {paragraphs, annotationIds?}（只读，不需要锁）
POST   /api/review-decisions/:id/execute 执行 {paragraphs, annotationIds?, actor}（If-Match 必需；三版本逐条校验、可部分成功）
POST   /api/review-decisions/:id/undo   撤销最近一次成功执行（If-Match 必需；只回滚执行后未再变化的批注）
GET    /api/review-decisions/:id/logs   决策记录，支持 ?from=&to= 时间筛选
```

冲突响应示例：`409 {"error":"version_conflict","message":"…","currentRev":8}`；
逐条版本冲突在执行/预览响应的 `results` 中给出（HTTP 仍为 200），例如
`{"annotationId":"…","result":"conflict","reason":"quote_mismatch"}`。
决策数据默认写到 `./data/review-decisions.json`（`REVIEW_DECISIONS_FILE` 覆盖，执行队列任务也存于同一文件）。

## 决策发布与定时执行（执行队列）

达到执行条件（`ready`）的草案可由**负责人发布到执行队列**，指定一个**未来的生效时间**；
发布瞬间锁定当时的**文本、批注与批次版本**，到点后由**服务端自动执行**。
页面显示队列状态、计划时间与实时剩余时间，可暂停、恢复或取消尚未开始的任务。

| 需求 | 实现方式 |
|---|---|
| 只发布“达到执行条件”的草案 | `POST /api/execution-tasks` 仅接受 `ready` 草案；拟定中/投票中 409 `decision_not_ready`，已执行 409 `decision_executed`，已排期重复发布 409 `task_already_scheduled` |
| 必须指定未来生效时间 | 缺时间 400 `missing_scheduled_at`、非法时间 400 `invalid_scheduled_at`、过去时间 409 `scheduled_at_in_past`、晚于批次截止 409 `scheduled_after_deadline`；错误在弹窗内红字提示，**表单内容原样保留** |
| 发布时锁定文本/批注/批次版本 | 任务记录 `lock {paragraphs, textRev, annotationRev, batchRev, decisionRev}`；草案三版本基线推进到锁定文本，排期后草案进入 `scheduled`，改方案/投票/手动执行全部 409 `decision_scheduled` |
| 队列状态/计划时间/剩余时间 | 决策面板顶部显示活动队列，“⏰ 执行队列”可看全部任务；`GET /api/execution-tasks` 返回状态、计划时间、锁定版本与尝试记录；前端每秒刷新剩余时间，到点自动重载 |
| 暂停/恢复/取消尚未开始的任务 | `POST …/:id/pause`（记录原计划时间，暂停即不触发）、`/resume`（可给新时间；不给则原时间在未来就沿用、已过则立即执行）、`/cancel`（草案退回 `ready` 可重新发布或手动执行）；已开始/已结束任务对应操作 409（`task_not_active`/`task_not_paused`/`task_not_cancellable`） |
| 到点服务端自动执行 | 服务端按 `DECISION_SCHEDULER_INTERVAL_MS`（默认 1000ms，测试用 100ms）轮询到期任务，执行发布时锁定的文本；仍**逐条**做三版本校验，冲突条目不覆盖新内容，其余条目照常完成 |
| 部分成功 | 全部成功 `succeeded`；有成功也有冲突 `partial`；零成功 `failed`。后两者草案退回 `ready`，任务终态保留，可“失败重试”；批次归档/草案过期等到点整体不能执行时为 `blocked`（不产生执行记录） |
| 执行幂等，重启/重复触发不重复处理成功条目 | 任务累计 `successAnnotationIds`；每次尝试只执行“尚未成功”的条目，已成功条目记 `skipped/already_done`，不重复解决批注、不重复合成文本。内存锁防同进程重复触发；重启时遗留的 `running` 任务标记中断（`failed/interrupted`），需人工重试，绝不自动补跑 |
| 失败重试 | `POST …/:id/retry`：不给时间立即重试（沿用发布锁，仍冲突的条目继续冲突）；可给未来时间重排；可选传回当前段落用最新文本/批注/批次**重新锁定**后重试 |
| 全部操作留痕且可按时间筛选、与快照关联 | 发布/暂停/恢复/取消/阻断/自动执行（含逐条成功/冲突/跳过）/重试都进决策日志，带 `taskId`；`GET /api/execution-tasks/:id/logs?from=&to=` 按时间筛选；有成功条目时自动保存“执行后文本”快照，任务、执行记录与快照三方互相关联（`taskId/executionId/snapshotId`）；保存任意快照也会嵌入当时的执行队列 |
| 不能被不恰当地修改 | 已归档批次、已过期草案不能发布/重试；已排期草案只读；已开始/已完成任务不能暂停/恢复/取消；已成功任务不能重试；所有变更必须 `If-Match: <X-Decision-Rev>` 严格相等，多人用旧页面提交一律 409 `version_conflict` 且不写盘 |
| 重启恢复 | 未来时间的任务重启后继续等待；**停机期间错过**的任务在重启后自动补执行（成功条目仍幂等）；正在执行时崩溃的任务不自动补跑，标记中断后由人工重试 |

### 执行队列 HTTP API 摘要

```
GET    /api/execution-tasks[?status=]      队列列表（活动任务在前，按计划时间排序，含门控与审批进度）
POST   /api/execution-tasks                发布 {decisionId, scheduledAt, paragraphs, actor, dependencies?, approval?}（If-Match 必需）
GET    /api/execution-tasks/:id            任务详情（锁定版本/尝试记录/成功条目/门控/审批）
POST   /api/execution-tasks/:id/pause      暂停（If-Match 必需）
POST   /api/execution-tasks/:id/resume     恢复 {scheduledAt?}（If-Match 必需）
POST   /api/execution-tasks/:id/cancel     取消 {reason?}（If-Match 必需；草案退回 ready）
POST   /api/execution-tasks/:id/retry      失败重试 {scheduledAt?, paragraphs?, actor}（If-Match 必需）
POST   /api/execution-tasks/:id/config     修改前置任务/审批配置 {dependencies?, approval?, actor}（If-Match 必需）
POST   /api/execution-tasks/:id/approvals  审批 {approver, decision:"approve"|"reject"}（记名，同审批人最后一次决定为准）
POST   /api/execution-tasks/:id/approvals/:approver/withdraw  撤回本人审批决定 {}
POST   /api/execution-tasks/:id/continue   前置部分成功时负责人确认继续（If-Match 必需）
GET    /api/execution-tasks/:id/logs       队列记录，支持 ?from=&to= 时间筛选
```

任务状态：`scheduled` 等待生效 / `paused` 已暂停 / `running` 执行中（仅内存）/
`succeeded` 全部成功 / `partial` 部分成功 / `failed` 零成功 / `blocked` 到点被阻断 /
`cancelled` 已取消。任务与草案共用决策集合 rev（`X-Decision-Rev`），轮询间隔可用
`DECISION_SCHEDULER_INTERVAL_MS` 调整。

## 任务依赖与执行前审批

负责人可以为**尚未开始**（`scheduled`/`paused`）的执行任务配置**前置任务**与
**执行前审批**。只有前置任务全部成功（部分成功需负责人确认）且审批达到最少通过人数，
任务才允许在计划时间进入执行；条件不满足时到点绝不执行，条件后来满足只自动放行一次。

### 前置门控 gate（独立于任务状态）

依赖与审批不改变任务自身状态（未开始的任务仍是 `scheduled`/`paused`），其能否执行
由任务上的 `gate` 表示。队列列表、任务详情与草案详情都实时返回门控状态、等待原因
（`reason`/`blockingDependency`）与当前审批进度：

| gate 状态 | 含义 | 触发条件 |
|---|---|---|
| `ready` | 前置已满足，到点执行 | 前置全部成功且审批达标（或无前置无审批） |
| `waiting` | 等待中 | 前置尚未结束（含前置自己还在等审批/暂停），或前置 `failed` 等待其重试成功 |
| `can_continue` | 可继续 | 前置任务为 `partial`（部分成功），**需负责人显式确认继续** |
| `blocked` | 已阻断 | 前置 `cancelled`/终态 `blocked`/不存在，或阻断沿依赖链向上传递 |
| `approvals` | 等待执行前审批 | 依赖已满足，但通过人数未达门槛且无拒绝 |
| `rejected` | 审批被拒绝 | 任一指定审批人拒绝（撤回拒绝并补足通过后可继续） |

前置终态到后继门控的单跳映射：`succeeded→ready`、`partial→can_continue`、
`failed→waiting`（重试成功后自动重新评估）、`cancelled/blocked→blocked`。
门控沿依赖链传递：上游任务自身未被放行（被阻断/在等待/待确认/审批被拒）时，
其结果对后继不可用，后继相应进入阻断或等待——例如前置 A 已成功但其自身的前置被取消，
依赖 A 的任务仍被阻断。

| 需求 | 实现方式 |
|---|---|
| 为未开始任务配置前置 | 发布时可带 `dependencies:[taskId...]`；或 `POST …/:id/config` 修改。拒绝自依赖 409 `self_dependency`、不存在的任务 404 `dependency_not_found`、（含新边的）循环依赖 409 `dependency_cycle`；重复 id 去重 |
| 指定 1~3 名审批人与最少通过人数 | 发布时或 config 中给 `approval:{approvers:[...], minApprovals:n}`；审批人不能为空/超长、**不能重复**（409 `duplicate_approver`），`minApprovals` 必须在 1..审批人数之间；显式 `approval:null` 取消审批要求 |
| 修改配置按当前决策版本并发校验 | config 与发布/暂停等一样必须 `If-Match: <X-Decision-R>`，旧页面一律 409 `version_conflict` 且不写盘；**已开始/已完成任务不能再改配置**（409 `task_config_locked`） |
| 改审批配置重置审批 | 修改审批人名单或门槛后，已有审批决定全部清空（`task_approval_configured` 留痕）；仅改依赖不影响已有审批 |
| 审批通过/拒绝/撤回 | `POST …/:id/approvals`（记名；非指定审批人 403 `not_approver`；同审批人重复相同决定幂等）；拒绝由本人 `…/withdraw` 撤回，撤回后按剩余决定重新计票；终态任务不能再审批 |
| 部分成功需确认才继续 | `can_continue` 任务即使计划时间已过也不执行；负责人 `POST …/:id/continue` 确认后放行；错误状态调用 409 `gate_not_needs_continue`；确认按依赖逐个记录，重试/改配置后旧确认失效 |
| 到点不误执行、满足后只触发一次 | 调度器每轮先对账门控再选到期任务，门控非 `ready` 一律不触发（双重检查）；条件在到期后才满足时，下轮询幂等补触发一次，执行幂等保证成功条目不重复处理，审批/执行均不会重复 |
| 阻断/解除/等待/审批全部留痕 | 阻断 `task_dependency_blocked`、解除 `task_dependency_unblocked`、可继续 `task_dependency_can_continue`、确认继续 `task_dependency_continue`、配置变更 `task_dependencies_changed`/`task_approval_configured`、通过 `task_approved`、拒绝 `task_rejected`、撤回 `task_approval_withdrawn`、达标 `task_approval_met`、否决 `task_approval_rejected` 等都进任务日志，可 `?from=&to=` 按时间筛选 |
| 日志关联对应快照 | 配置审批的任务自动保存“执行前审批”文本快照，审批通过/拒绝/撤回记录关联其 `snapshotId`；依赖阻断日志关联前置任务的执行/审批快照；保存任意快照继续嵌入当时的执行队列（含门控与审批决定） |
| 重启恢复 | 门控状态、等待原因、依赖配置、审批配置、逐人审批决定与“确认继续”记录全部随决策文件持久化；重启后按当前任务图重算门控（幂等，不产生重复日志），依赖/审批状态完整恢复 |

### 批次详情中的决策关联

`GET /api/review-batches/:id` 的响应额外带 `decisionIds`（该批次关联的全部草案 id），
批次详情弹窗提供“决策草案…”入口，可在该批次上下文直接创建草案。

### 批注 HTTP API 摘要

```
GET    /api/annotations                全量列表（含回复）+ 当前 rev
POST   /api/annotations                新建批注（If-Match 必需）
PUT    /api/annotations                整体替换（从快照恢复，If-Match 必需）
POST   /api/annotations/:id/replies    追加回复（If-Match 必需；已归档批次成员 409）
PUT    /api/annotations/:id            设置四态状态 open/in_progress/needs_review/resolved（If-Match 必需）
DELETE /api/annotations/:id            删除批注（If-Match 必需；属于批次时 409，需先移出）
```

## 执行回放（审计包导出 / 导入 / 只读回放空间）

负责人可以把**指定时间范围内**的任务、审批、执行尝试、逐条结果与关联快照导出成
**可下载的审计包**，再把审计包导入到**另一份空白回放空间**中按时间线查看。
回放模块与线上批次、决策、执行队列**完全隔离**：导出只读线上数据，导入只写独立的
回放存储；回放视图里没有任何暂停 / 审批 / 执行入口，线上四集合版本（rev）不会因
导出或查看而变化。

### 审计包内容（自洽、带版本与哈希）

包顶层含 `format: "bidi-replay"`、`packageVersion` / `schemaVersion`、
`packageId`（生产者 + 时间范围 + 事件集合的确定性标识）、时间范围与 `manifest`：

| 组成 | 内容 |
|---|---|
| 版本 | 格式 / 包版本 / 结构版本，导入时拒绝高版本与格式不符的包 |
| 任务依赖 | 范围内每个任务完整锁定：状态、锁定文本（`lock.paragraphs`）、文本/批注/批次/决策四版本、`dependencyIds`、门控状态 |
| 审批流水 | `approval`（审批人与门槛）、逐人 `approvalDecisions`、审批快照关联 |
| 执行尝试 | 任务 `attempts`（自动/重试、计数、executionId）+ 结构化执行记录，含**逐条结果与冲突原因**（`quote_mismatch`/`paragraph_deleted` 等） |
| 快照关联 | 事件、任务、执行记录引用到的快照整体打包（锁定文本与关联版本）；线上已删除的快照引用自动剪枝为 `null`，包始终自洽 |
| 事件链 | 时间线事件按时间升序（**允许同毫秒、禁止倒退**），`seq` 连续、`prevEventId` 逐环相扣；链头哈希对顺序与内容敏感 |
| 哈希 | `manifest.contentHash`（规范化 JSON 的 FNV-1a 64 位摘要，浏览器可校验）+ `contentHashSha256`（Node 端强哈希）+ `chainHead` 事件链头 |

时间范围内有事件的任务**整体纳入**（保证依赖/审批/尝试上下文完整）；其前置任务即使
事件在范围外也一并纳入，避免跨任务引用缺失。

### 导入前校验（任一失败即拒绝，绝不部分写入）

`POST /api/replay/import` 在**任何写盘之前**跑完下列校验：

- 包格式 / 版本 / 顶层必填字段（`missing_field`、`invalid_format`、`unsupported_version`）
- 内容数量上限（`package_too_large`，413）：事件 ≤ 5000、任务 ≤ 500、草案 ≤ 200、
  快照 ≤ 1000、单任务尝试/审批/依赖上限、单执行记录逐条结果上限
- 事件 id 重复（`duplicate_event`）、必填字段缺失（`invalid_event`）
- 内容哈希不匹配（`hash_mismatch`）、事件链头不匹配（`chain_hash_mismatch`）、
  `prevEventId` 断链（`broken_event_chain`）、事件时间倒退（`event_time_regression`）
- 跨任务引用不存在：依赖任务（`cross_reference_missing`）、事件引用的任务/快照/执行记录
- 审批配置、逐条结果等枚举与门槛合法性

失败会在 `GET /api/replay/failures` 中**保留失败原因**（时间、包标识、错误码、明细），
空间列表数量不变；合法但 `packageId + producerId` 已被**不同内容**占用时返回
409 `replay_conflict` 并指出已有空间，绝不覆盖锁定历史。

**幂等**：同一审计包（内容哈希与链头一致）导入任意次结果相同——返回同一空间与
200 `idempotent: true`，不新建副本。

### 回放视图（只读锁定历史）

- 时间线按任务分组，事件分为 **等待 wait / 审批 approval / 配置 config / 执行 execute /
  重试 retry / 取消 cancel** 六类（发布、门控等待/阻断/可继续、暂停恢复、审批通过/拒绝/
  撤回/达标、自动执行与逐条成功/冲突/跳过、重试、依赖配置、取消），组内严格按事件链顺序；
- 支持**按任务或事件类型（含具体动作、批注、时间子范围）筛选**；筛选条件可
  `PUT …/view`（`If-Match: 空间 rev`）保存，随空间持久化，**服务重启后自动恢复**；
- 冲突原因汇总 `GET …/conflicts`；包内快照只能只读查看；回放路径下
  `pause`/`resume`/`cancel`/`retry`/`approvals`/`continue` 等动作一律 404，
  无法触发线上暂停、审批或执行。

### 重启恢复

回放空间（锁定内容）、空间 rev、**已保存筛选条件**、导入时的**校验结果**（哈希/链头/
事件数）与失败记录都原子落盘到 `./data/replay-spaces.json`（`REPLAY_SPACES_FILE` 覆盖，
独立于线上四个数据文件）；重启后全部恢复，重复导入仍幂等。

### 执行回放 HTTP API 摘要

```
GET    /api/replay/preview[?from=&to=]          导出前只读预览：命中任务数/事件数
POST   /api/replay/export[?download=1]          构建审计包（{from,to,name?,actor}）；download=1 给附件下载头
POST   /api/replay/import                       校验并导入审计包（全量校验通过才写盘；同包幂等/同标识冲突 409）
GET    /api/replay/failures                     导入失败记录（保留失败原因与明细）
GET    /api/replay/spaces                       回放空间列表（摘要 + X-Replay-Rev）
GET    /api/replay/spaces/:id                   空间详情（锁定内容 + 校验结果 + 已保存筛选）
DELETE /api/replay/spaces/:id                   删除回放副本（不影响线上数据）
GET    /api/replay/spaces/:id/timeline[?taskId=&category=&action=&annotationId=&from=&to=]
                                                按时间线返回（不带筛选参数时回退到已保存筛选）
PUT    /api/replay/spaces/:id/view              保存筛选条件（If-Match: 空间 rev）
GET    /api/replay/spaces/:id/conflicts         逐条冲突原因汇总
GET    /api/replay/spaces/:id/tasks/:taskId     包内锁定的单个任务（只读）
GET    /api/replay/spaces/:id/snapshots/:sid    包内锁定的单个快照（只读）
```

回放集合使用独立版本号，响应头为 `X-Replay-Rev`；导入请求体上限单独放宽为 32MB
（`REPLAY_BODY_LIMIT_BYTES` 覆盖），因为包内包含锁定文本。

## 历史证据复核（回放空间内）

负责人可以针对回放时间线中的**锁定事件**或执行记录中的**逐条结果**添加复核意见，
指定复核人、状态与截止时间。复核数据挂在**回放空间**上（`reviews` + 状态变化记录），
不属于审计包、不参与内容哈希，也绝不会反向写入线上四集合；锁定历史 `content` 对复核
流程始终只读。

### 引用与数据模型

每条意见必须引用空间内一个锁定目标，写入时服务端对锁定内容**重新解析**，目标不存在
一律 `404 review_target_not_found` 拒绝：

| 引用类型 | target | 锚定方式 |
|---|---|---|
| 时间线事件 | `{kind:"event", eventId}` | 事件链中的事件 id |
| 逐条执行结果 | `{kind:"result", executionId, annotationId, paraIndex?}` | 执行记录 id + 批注 id（paraIndex 可选精化） |

意见字段：`status`（open 待复核 / in_review 复核中 / confirmed 已确认 / returned 已退回 /
closed 已关闭）、`reviewer`、`dueAt`（必填且须晚于当前）、`content`、版本 `version`、
创建/修改/关闭人与时间。另有只增不改的状态变化记录（create/update/reassign/close，
含 from/to），可按时间范围查询、时间倒序返回。

### 并发与终态保护（双重乐观锁）

- **空间级**：所有复核写操作必须 `If-Match: <空间 rev>`（响应头 `X-Replay-Rev` /
  响应体 `spaceRev`），与筛选条件保存共用空间 rev——任何页面改过意见或筛选后，
  旧页面提交一律 `409 version_conflict`，缺版本号 `428`。
- **意见级**：修改/关闭/转派还必须带 `X-Review-Version: <意见 version>`；
  旧版本提交返回 `409 review_version_conflict`（带 `currentVersion/currentStatus`），
  缺版本号 `428`。
- **已关闭即终态**：closed 意见拒绝修改、转派与再次关闭（`409 review_closed`），
  即使携带最新空间 rev 与最新意见版本也不允许——旧页面无法覆盖关闭结论。
- 关闭后可在同一目标上**重新提出**新意见；同一目标存在**未关闭**意见时重复新增返回
  `409 duplicate_review`（带 `existingReviewId`），整次操作不写入。
- 写操作先校验、再改内存、最后原子落盘，落盘失败整体回滚（空间 rev/意见/记录不留半截）。

### 筛选与展示

- 复核意见列表 `GET …/reviews` 支持 `status` / `reviewer`（精确）/
  `dueFrom` / `dueTo`（截止时间区间）/ `targetKind` 筛选，未关闭在前、按截止时间升序，
  带逾期标记；筛选条件可随 `PUT …/view` 保存（`rvStatus/rvReviewer/rvDueFrom/rvDueTo/
  rvTargetKind`），重启恢复；列表不带参数时回退到已保存筛选。
- 时间线与冲突汇总在响应中按当前复核筛选挂**轻量标记**（`ev.reviews` /
  `summary.items[].reviews`，仅 id/版本/状态/复核人/截止时间）。result 意见锚到同任务、
  同批注的 `*_item_*` 事件；标记通过事件浅拷贝挂载，**不就地修改锁定事件对象**。
- 冲突汇总另附筛选后的结果类意见 `summary.resultReviews`。

### 复核清单导出（独立文档，纯只读）

`POST …/reviews/export[?download=1]` 生成格式为 `bidi-replay-review-checklist` 的
独立 JSON：含空间锚点（packageId/内容哈希/链头/事件数/时间范围）、筛选条件、每条意见
（状态中文标签、逾期标记、关闭信息）、**引用目标在锁定内容中的快照**（事件字段或逐条
结果与冲突原因）以及按时间排序的完整状态变化记录。导出是纯计算：**不写盘、不推进任何
rev**；筛选参数非法返回 400，导出失败不会改变任何意见或回放空间。

### 重启恢复

意见、意见版本、状态变化记录、已保存复核筛选都随 `data/replay-spaces.json` 原子落盘
（`REPLAY_SPACES_FILE` 覆盖）；旧数据文件缺复核字段时启动自动补齐为空数组，锁定内容
哈希不受影响。重启后关闭终态保护、版本号与筛选回退全部继续生效。

### 隔离性

复核路径只有空间内的 reviews 子资源，没有 `pause`/`resume`/`cancel`/`retry`/
`approvals`/`continue` 等入口（回放路径下这些动作一律 404），服务端处理函数只读写
`replayStore`，线上决策/执行队列 rev 不随任何复核操作或清单导出变化。删除回放空间时
其意见与记录一并删除，线上数据不受影响。

### 历史证据复核 HTTP API 摘要

```
GET    /api/replay/spaces/:id/reviews                 意见列表（?status=&reviewer=&dueFrom=&dueTo=&targetKind=，不带参数回退已保存筛选）
POST   /api/replay/spaces/:id/reviews                 新增 {target, reviewer, content, dueAt, status?, actor}（If-Match: 空间 rev）
GET    /api/replay/spaces/:id/reviews/:rid            意见详情（含引用目标快照）
PUT    /api/replay/spaces/:id/reviews/:rid            修改内容/状态/截止 {content?, status?, dueAt?, actor}（If-Match + X-Review-Version）
POST   /api/replay/spaces/:id/reviews/:rid/close      关闭 {reason?, actor}（终态，双重版本检查）
POST   /api/replay/spaces/:id/reviews/:rid/reassign   转派 {reviewer, actor}（双重版本检查，已关闭拒绝）
GET    /api/replay/spaces/:id/reviews/:rid/logs       状态变化记录（?from=&to=，时间倒序）
GET    /api/replay/spaces/:id/reviews/reviewers       全部复核人名单（筛选下拉用）
POST   /api/replay/spaces/:id/reviews/export[?download=1]  独立复核清单（纯只读，不写盘不推 rev）
```

时间线与冲突汇总接口新增复核筛选查询参数：`rvStatus` / `rvReviewer` /
`rvDueFrom` / `rvDueTo` / `rvTargetKind`（显式参数优先，否则回退已保存筛选）。

错误码：`review_target_not_found`(404)、`duplicate_review`(409)、`review_not_found`(404)、
`review_version_conflict`(409)、`review_closed`(409)、`missing_target`/`missing_reviewer`/
`missing_content`/`missing_due`/`invalid_target`/`invalid_status`/`invalid_due`/
`due_in_past`/`empty_patch`(400)、`review_too_large`(413)。

### 差异位置为什么不会被 RTL 标反

- 差异算法（LCS）在 `snapshot-core.js` 中以**码点数组**为输入，偏移即数组下标，
  与文字最终在屏幕上从左画还是从右画毫无关系；
- emoji/代理对按 1 个逻辑字符计数（`Array.from` 切码点）；
- 前端渲染把差异行容器固定为 LTR，让片段按逻辑顺序排列，
  每个片段内部再交给 `<bdi>` 隔离渲染，位置标签（如 `[新 11–16]`）恒为 LTR 等宽数字。

## 其他编辑器功能

- 每段独立方向：`自动 / 从左到右 / 从右到左`（工具栏按钮或 `Ctrl/⌘+Shift+A/L/R`）；`自动` 按该段首个强方向字符判定基准方向
- 状态栏实时显示：段落编号与 `dir`、解析后的基准方向、光标**逻辑偏移**、选区长度
- 一键插入中文/阿拉伯文示例；粘贴自动降级为纯文本
- 空段落可落光标；回车新段落继承上一段方向

## 本地运行

```bash
node server.js          # http://localhost:8080
```

快照数据默认写到 `./data/snapshots.json`（`SNAPSHOTS_FILE` 覆盖），
批注数据默认写到 `./data/annotations.json`（`ANNOTATIONS_FILE` 覆盖），
审阅批次与记录默认写到 `./data/review-batches.json`（`REVIEW_BATCHES_FILE` 覆盖），
审阅决策与执行队列数据默认写到 `./data/review-decisions.json`（`REVIEW_DECISIONS_FILE` 覆盖，
定时任务与草案同文件）；**执行回放空间与导入失败记录**默认写到
`./data/replay-spaces.json`（`REPLAY_SPACES_FILE` 覆盖，与线上四集合完全隔离），
导入请求体上限可用 `REPLAY_BODY_LIMIT_BYTES` 调整（默认 32MB）；
定时轮询间隔用 `DECISION_SCHEDULER_INTERVAL_MS` 调整（默认 1000 毫秒）。

> 注：直接双击打开 `index.html`（file://）时快照与批注接口不可用，双向编辑功能本身仍可使用。

## 测试

零依赖，使用 Node 内置测试运行器：

```bash
node --test test/
```

- `test/core.test.js`：校验规则、字符级逻辑位置差异（含阿拉伯文与中阿混排用例）、段落对齐
- `test/api.test.js`：真实起服务跑快照 CRUD、409 乐观锁、413/400 拒绝、重启持久化
- `test/review-core.test.js`：批注校验、锚点重定位（编辑/跨段移动/方向切换/emoji/失效）、记录规范化、批次校验与实时进度
- `test/annotations-api.test.js`：批注 CRUD 与回复、四态流转、双页面 409 冲突、快照嵌入批注状态、从快照恢复、重启持久化
- `test/review-batches-api.test.js`：批次创建校验、成员互斥、逐条/批量状态、旧页面批量更新 409、加/移成员、审阅记录按时间筛选、归档冻结、快照嵌入批次、恢复对账、重启持久化
- `test/decision-core.test.js`：决策草案校验、记名投票与门槛流转、改方案清票、三版本逐条冲突（文本/批注/批次）、按段预览、同段多条从后向前应用、部分成功、撤销基线、快照摘要
- `test/decisions-api.test.js`：创建校验（归档/过期/重复草案/空方案/缺投票人）、方案填写与提交、两人投票流转、预览不写盘、三版本逐条冲突的部分成功执行、成功批注转已解决、旧决策版本 409、同草案不可重复执行、撤销（执行后变化不覆盖、全局最近一次顺序）、快照嵌入决策、归档冻结、按时间记录、重启持久化
- `test/execution-tasks-api.test.js`：发布校验（缺/过去/非法时间、非待执行、重复发布、晚于截止、版本冲突）、发布锁定版本、暂停/恢复/取消、到点自动执行与自动快照、逐条冲突的部分成功、失败重试幂等（成功条目不重复处理）、重锁重试成功、重启后未来任务等待与错过任务补执行、队列记录按时间筛选、快照嵌入执行队列
- `test/task-gate-core.test.js`：审批配置与审批统计校验（1~3 人/不重复/门槛/撤回/拒绝即否决）、依赖图校验（自依赖/循环/不存在）、门控映射与依赖链传递（成功/部分/失败/取消/阻断/活动前置）、部分成功确认后放行、重启后门控摘要恢复
- `test/task-dependencies-api.test.js`：发布/配置时的依赖与审批校验、到点前置未满足绝不执行、前置成功后只触发一次、取消联动阻断与日志、配置版本并发校验与终态锁定、审批通过/拒绝/撤回/幂等/非审批人 403、失败→等待与部分成功→确认继续、重启恢复依赖与审批状态
- `test/replay-core.test.js`：审计包构建（版本/任务依赖/审批流水/执行尝试/逐条结果/快照关联/事件链）、确定性包标识（重复导出幂等基础）、导入前校验（缺字段/格式/版本/重复事件/哈希篡改/断链/时间倒退/跨任务引用/超限/缺失快照剪枝）、时间线按任务与类型筛选、冲突原因汇总
- `test/replay-review-core.test.js`：复核引用目标解析（锁定事件/逐条结果存在性）、新建/修改/转派/关闭校验、重复意见判定（未关闭才算）、截止时间与状态枚举、按状态/复核人/截止区间/引用类型筛选、时间线/冲突项标记挂载（result 意见锚同任务同批注的 *_item_* 事件）、复核清单（空间锚点/目标快照/记录排序/逾期标记/筛选/不改变输入）
- `test/replay-api.test.js`：真实起服务走完线上任务后导出（预览/下载头/空范围/只读不推线上 rev）、导入成功、同包重复导入幂等、同标识不同包 409 冲突、各类坏包拒绝且不部分写入、失败原因保留、时间线筛选、筛选条件保存（428/409）、回放空间无任何线上动作接口、重启后空间/筛选/校验结果恢复、删除不影响线上、大包 413
- `test/replay-review-api.test.js`：真实起服务走完线上任务后导入回放空间，覆盖新增（事件/结果引用、缺字段/过去截止/非法状态拒绝、404 引用不存在、409 重复未关闭意见、关闭后可重提）、双重版本并发（缺 If-Match 428 / 409 空间版本 / 缺 X-Review-Version 428 / 409 意见版本）、已关闭不可修改/转派/重复关闭、修改/转派/关闭推进版本并留痕、状态记录按时间倒序、按状态/复核人/截止区间筛选、时间线与冲突汇总挂标记、清单导出（只读不推空间/线上 rev、下载头、非法参数 400 不改变空间）、复核筛选随空间持久化、重启后意见/版本/记录/筛选恢复且终态保护仍生效、复核路径无线上动作接口、删除空间级联移除意见

## Docker 部署

```bash
docker build -t bidi-editor .
docker run -d -p 8080:8080 -v bidi-editor-data:/app/data bidi-editor
# 打开 http://localhost:8080
```

或使用 compose（已内置命名卷持久化快照）：

```bash
docker compose up -d
```

## 文件结构

```
index.html        页面结构（编辑器为 contenteditable；审阅面板、快照面板与弹窗容器）
style.css         编辑器样式 + 审阅/快照面板/弹窗/差异高亮（bdi 隔离、LTR 位置标签、批注高亮）
app.js            段落方向、编辑时间戳、纯文本粘贴、状态栏、序列化/恢复、码点锚点 API（window.Editor）
snapshot-core.js  快照纯逻辑：校验 + LCS 差异（浏览器与 Node 共用，无 DOM 依赖）
review-core.js    批注/审阅批次纯逻辑：校验 + 锚点重定位 + 批次载荷校验与实时进度（浏览器与 Node 共用，无 DOM 依赖）
decision-core.js  审阅决策纯逻辑：方案/投票校验、逐条投票统计、文本指纹与段落对齐、三版本逐条冲突判定、执行合成与按段预览、执行队列门控（任务依赖图校验/依赖链传递/执行前审批统计）、快照摘要（依赖 snapshot-core）
snapshots.js      快照 UI：列表/比较/恢复预览二次确认/版本冲突
annotations.js    批注 UI：列表筛选（段落/四态/批次）/新建/详情回复/四态状态/冲突处理/快照批注查看与恢复
batches.js        审阅批次 UI：新建（命名/负责人/截止/说明/勾选批注）、列表与实时进度、详情批量操作、加/移成员、归档、按时间查看审阅记录
decisions.js      审阅决策 UI：从批次创建草案、逐条填写保留/替换/删除、记名投票、按段执行前预览、部分成功执行结果、撤销最近一次执行、发布到执行队列（计划时间/剩余时间/暂停/恢复/取消/失败重试）、前置任务与执行前审批（等待原因/审批进度/确认继续）、按时间记录、快照决策与队列查看
replay-core.js    执行回放纯逻辑（浏览器与 Node 共用）：审计包构建（版本/任务依赖/审批流水/执行尝试/逐条结果/冲突原因/快照关联/事件链）、规范化 JSON 内容哈希（FNV-1a 64 位）+ Node 端 SHA-256、导入前全量校验（缺字段/重复事件/哈希/跨任务引用/时间倒退/断链/数量上限）、同包幂等与同标识冲突判定、时间线筛选与冲突汇总
replay-review-core.js 历史证据复核纯逻辑（浏览器与 Node 共用）：锁定事件/逐条结果引用解析与存在性校验、新建/修改/转派/关闭输入校验、同目标重复意见判定、按状态/复核人/截止时间/引用类型筛选、时间线与冲突项标记挂载（浅拷贝不碰锁定对象）、独立复核清单构建
replay.js         执行回放 UI：按时间范围导出并下载审计包、本地选文件导入（校验失败保留原因）、回放空间列表、只读时间线（按任务/事件类型筛选并可记住筛选）、锁定快照查看；历史证据复核（事件/冲突结果上添加意见、复核筛选与已保存筛选、修改/转派/关闭带版本冲突处理、状态变化记录、复核清单下载）；无任何暂停/审批/执行入口
server.js         零依赖服务：静态文件 + 快照、批注、审阅批次、审阅决策、执行队列（依赖/审批门控）JSON API（四集合乐观锁、原子落盘、定时执行调度器与门控对账）+ 执行回放（审计包只读导出、全量校验后导入独立回放空间、失败记录、筛选条件与校验结果持久化）+ 历史证据复核（空间 rev 与意见 version 双重乐观锁、引用存在性校验、终态保护、状态记录、清单纯只读导出、随回放空间原子持久化）
test/             node:test 单元与集成测试
Dockerfile        node:20-alpine，EXPOSE 8080，数据卷 /app/data
```
