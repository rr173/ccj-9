# 双向文本编辑器（中文 ⇄ 阿拉伯文同段混排）+ 审阅快照 + 协作批注 + 审阅批次

一个零依赖 Node 服务 + 网页编辑器，支持同一段落内中文（从左到右）与阿拉伯文（从右到左）混排，
提供可恢复、可比较、带乐观并发控制的**审阅快照**功能，可锚定到逻辑字符范围、
支持回复与四态工作流的**协作批注**功能，以及把一组批注命名编组、
跟踪负责人/截止时间/实时进度/完整审阅记录的**审阅批次**功能。

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

### 批注 HTTP API 摘要

```
GET    /api/annotations                全量列表（含回复）+ 当前 rev
POST   /api/annotations                新建批注（If-Match 必需）
PUT    /api/annotations                整体替换（从快照恢复，If-Match 必需）
POST   /api/annotations/:id/replies    追加回复（If-Match 必需；已归档批次成员 409）
PUT    /api/annotations/:id            设置四态状态 open/in_progress/needs_review/resolved（If-Match 必需）
DELETE /api/annotations/:id            删除批注（If-Match 必需；属于批次时 409，需先移出）
```

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
审阅批次与记录默认写到 `./data/review-batches.json`（`REVIEW_BATCHES_FILE` 覆盖）。

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
snapshots.js      快照 UI：列表/比较/恢复预览二次确认/版本冲突
annotations.js    批注 UI：列表筛选（段落/四态/批次）/新建/详情回复/四态状态/冲突处理/快照批注查看与恢复
batches.js        审阅批次 UI：新建（命名/负责人/截止/说明/勾选批注）、列表与实时进度、详情批量操作、加/移成员、归档、按时间查看审阅记录
server.js         零依赖服务：静态文件 + 快照、批注与审阅批次 JSON API（三集合乐观锁、原子落盘）
test/             node:test 单元与集成测试
Dockerfile        node:20-alpine，EXPOSE 8080，数据卷 /app/data
```
