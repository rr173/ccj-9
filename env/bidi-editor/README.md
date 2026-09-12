# 双向文本编辑器（中文 ⇄ 阿拉伯文同段混排）+ 审阅快照 + 协作批注

一个零依赖 Node 服务 + 网页编辑器，支持同一段落内中文（从左到右）与阿拉伯文（从右到左）混排，
提供可恢复、可比较、带乐观并发控制的**审阅快照**功能，以及可锚定到逻辑字符范围、
支持回复与解决状态流转的**协作批注**功能。

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
| 回复、标记已解决、重新打开 | 详情弹窗内完成；解决时记录解决人与时间，重开时清除 |
| 解决状态与快照关联 | 保存/覆盖快照时，服务端把当前批注集合（含状态与回复）整体嵌入快照记录（`annotations` + `annotationRev`）；查看历史快照可看到当时的批注及状态，且可从快照**恢复批注集合**（整体替换，带乐观锁） |
| 多页面同时编辑：提交/解决批注必须检测版本 | 批注集合有独立单调版本号 `rev`，响应带 `X-Annotation-Rev`；**所有**变更（新建、回复、解决、删除、恢复）必须 `If-Match: <rev>` 严格相等，否则 `409 version_conflict` 不写盘——旧页面无法覆盖别人的新批注或新状态 |
| 锚点失效/范围为空/内容为空/超限要明确提示且保留输入 | 前端先用 `review-core.js` 本地校验，失败时错误显示在弹窗内、表单内容原样保留；提交前再次校验锚点有效性；服务端用同一模块复核（空内容 400、空范围 400、引文与范围不一致 400、正文 >1000 字符 413、引文 >5000 字符 413、批注总数 >500 413、回复 >100 条/批注 413） |
| 按段落和状态筛选的审阅列表 | 段落下拉（随文档段落增减实时更新）+ 状态（未解决/已解决）筛选；列表项实时显示重定位后的位置或“锚点失效” |
| RTL 下批注位置与回复按逻辑顺序对应 | 位置一律逻辑码点偏移（不读屏幕布局）；回复按创建时间排序；文本一律 `<bdi>` 隔离 |

编辑器内的高亮使用 **CSS Custom Highlight API**（`::highlight(review-open/resolved)`），
不向 contenteditable DOM 注入任何节点，因此不会破坏光标、选区与撤销栈；
浏览器不支持时静默降级，列表功能不受影响。

### 批注 HTTP API 摘要

```
GET    /api/annotations                全量列表（含回复）+ 当前 rev
POST   /api/annotations                新建批注（If-Match 必需）
PUT    /api/annotations                整体替换（从快照恢复，If-Match 必需）
POST   /api/annotations/:id/replies    追加回复（If-Match 必需）
PUT    /api/annotations/:id            标记已解决 / 重新打开（If-Match 必需）
DELETE /api/annotations/:id            删除（If-Match 必需）
```

冲突响应示例：`409 {"error":"version_conflict","message":"…","currentRev":3}`。
批注数据默认写到 `./data/annotations.json`（可用 `ANNOTATIONS_FILE` 覆盖）。

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
批注数据默认写到 `./data/annotations.json`（`ANNOTATIONS_FILE` 覆盖）。

> 注：直接双击打开 `index.html`（file://）时快照与批注接口不可用，双向编辑功能本身仍可使用。

## 测试

零依赖，使用 Node 内置测试运行器：

```bash
node --test test/
```

- `test/core.test.js`：校验规则、字符级逻辑位置差异（含阿拉伯文与中阿混排用例）、段落对齐
- `test/api.test.js`：真实起服务跑快照 CRUD、409 乐观锁、413/400 拒绝、重启持久化
- `test/review-core.test.js`：批注校验、锚点重定位（编辑/跨段移动/方向切换/emoji/失效）、记录规范化
- `test/annotations-api.test.js`：批注 CRUD 与回复、解决/重开、双页面 409 冲突、快照嵌入批注状态、从快照恢复、重启持久化

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
review-core.js    批注纯逻辑：校验 + 锚点重定位（浏览器与 Node 共用，无 DOM 依赖）
snapshots.js      快照 UI：列表/比较/恢复预览二次确认/版本冲突
annotations.js    批注 UI：列表筛选/新建/详情回复/解决重开/冲突处理/快照批注查看与恢复
server.js         零依赖服务：静态文件 + 快照与批注 JSON API（双集合乐观锁、原子落盘）
test/             node:test 单元与集成测试
Dockerfile        node:20-alpine，EXPOSE 8080，数据卷 /app/data
```
