# 双向文本编辑器（中文 ⇄ 阿拉伯文同段混排）+ 审阅快照

一个零依赖 Node 服务 + 网页编辑器，支持同一段落内中文（从左到右）与阿拉伯文（从右到左）混排，
并提供可恢复、可比较、带乐观并发控制的**审阅快照**功能。

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

快照数据默认写到 `./data/snapshots.json`（可用环境变量 `SNAPSHOTS_FILE` 覆盖）。

> 注：直接双击打开 `index.html`（file://）时快照接口不可用，双向编辑功能本身仍可使用。

## 测试

零依赖，使用 Node 内置测试运行器：

```bash
node --test test/
```

- `test/core.test.js`：校验规则、字符级逻辑位置差异（含阿拉伯文与中阿混排用例）、段落对齐
- `test/api.test.js`：真实起服务跑 CRUD、409 乐观锁、413/400 拒绝、重启持久化

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
index.html        页面结构（编辑器为 contenteditable；快照面板与弹窗容器）
style.css         编辑器样式 + 快照面板/弹窗/差异高亮（bdi 隔离、LTR 位置标签）
app.js            段落方向、编辑时间戳、纯文本粘贴、状态栏、序列化/恢复 API（window.Editor）
snapshot-core.js  纯逻辑：校验 + LCS 差异（浏览器与 Node 共用，无 DOM 依赖）
snapshots.js      快照 UI：列表/比较/恢复预览二次确认/版本冲突
server.js         零依赖服务：静态文件 + 快照 JSON API（乐观锁、原子落盘）
test/             node:test 单元与集成测试
Dockerfile        node:20-alpine，EXPOSE 8080，数据卷 /app/data
```
