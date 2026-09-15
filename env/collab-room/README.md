# 双向文本多人协作编辑房间

零运行时依赖的 Node 服务：两个浏览器页面打开同一房间即可实时协作编辑，
支持**中文 / English / العربية 混排与 emoji ZWJ 序列（👨‍👩‍👧）**——
编辑单元是「字素簇」，光标与删除都不会劈开组合字符或 emoji；RTL 文本方向
交给浏览器原生 bidi 引擎，所有逻辑偏移只按逻辑字素簇计算。

## 它解决了什么

| 需求 | 实现 |
| --- | --- |
| 两个页面创建/加入同一房间 | 首页创建房间 → 复制邀请链接；房间页通过 WebSocket 加入 |
| 编辑实时同步 | 字素簇原子 + 身份 OT 折叠；服务端文本为权威，变更广播全文/增量 |
| 成员光标同步 | 光标/选区按字素簇索引上报，其他页面叠加彩色远程光标与名字标签 |
| 冲突可操作 | 同位置并发输入、编辑撞上对方删除 → 双方文字都保留为「冲突区」，页面上一键选择保留哪侧 |
| 离线重连 | 断网可继续输入，重连后以服务器快照收敛；未确认操作按原 opId 重放 |
| 重复操作 | 每个编辑带客户端 opId，服务端按 opId 幂等应答，重复提交绝不产生重复内容 |
| 重启恢复 | 房间、文本、版本、待裁决冲突、操作历史原子落盘 `data/rooms.json`，重启后完整恢复并可继续折叠旧基线 |

## 快速开始

```bash
npm start                 # 等价于 node server.js，默认 8080
PORT=3000 npm start
node server.js 9000       # 也可用位置参数指定端口
```

打开 <http://localhost:8080>：

1. 输入房间名称 → 创建房间；
2. 在另一个标签页（或另一台设备）打开邀请链接；
3. 两边各自输入即可看到文字与光标实时同步；
4. 两边几乎同时在同一位置输入不同内容，或一边删除时另一边正在该处输入，
   右侧出现**待裁决冲突**，点「保留 A / 保留 B」即可。

数据文件可用环境变量改位置：`COLLAB_ROOMS_FILE=/srv/data/rooms.json node server.js`。

## Docker

```bash
docker build -t collab-room .
docker run -d -p 8080:8080 -v collab-data:/app/data --name collab collab-room
# 或
docker compose up -d --build
```

容器自带 `/healthz` 健康检查；数据写入命名卷 `/app/data/rooms.json`，
容器重建后房间与编辑历史仍在。

## 测试

```bash
npm test      # node --test test/：9 个纯逻辑用例 + 7 个真实 HTTP/WS 端到端用例
```

端到端测试会启动真实服务（随机端口 + 临时数据文件），用仓库内置的零依赖
WebSocket 客户端模拟多个浏览器页面，覆盖：同房间同步（阿拉伯文 + emoji）、
成员存在与远程光标、同位置冲突与 HTTP 裁决、opId 幂等、离线重连追赶、
多跳滞后折叠收敛、进程重启恢复、参数校验。纯逻辑部分含 2 万组随机双方编辑的
收敛性质测试。

## 协议与模型

### 字素簇原子

文档是原子数组 `{id, ch}`，`ch` 为一个字素簇（`Intl.Segmenter`），因此
👨‍👩‍👧 永远是一个不可分割的编辑/定位单元；`textarea` 的 UTF-16 偏移与
逻辑集群索引通过 `codeUnitToCluster / clusterToCodeUnit` 双向换算。

### 操作与折叠

- 操作 `ins{gap,text}` / `del{start,len}`，坐标全部相对某一 `rev` 的父文档；
- 新插入原子的 id 为 `opId-gap-index`，**与在哪个上下文合并无关**，所以同一次
  输入在单方世界、合并文档、重连重放里身份一致，天然去重；
- 单跳 `mergeChangeset` 做线性三方合并；硬冲突（同位置双插 / 插入撞删除游程）
  采用「双方文字相邻保留 + 冲突区」模型，任何一方应用变换 ops 后都收敛到同一文档；
- 多跳折叠（`baseRev` 落后多个版本）逐跳构造双方世界再做身份三方合并 `merge3`：
  更早提交的原子作为共同上下文只出现一次，单方删除确定生效，重复字符也不会错配；
- 广播以服务端全文为权威，客户端在其上叠加未确认编辑显示，从根上杜绝增量重放分歧。

### 冲突裁决

冲突区记录两段在当前文档中的集群区间与文本；页面选择一侧后，服务端删除另一侧、
推进 `rev` 并广播。冲突任一侧文字若已被后续编辑删除，冲突自动关闭。

### WebSocket 消息

客户端：`hello` / `commit{opId,baseRev,ops}` / `cursor{anchor,selStart,selEnd}` / `ping`；
服务端：`hello`（快照）/ `ack`（ok|duplicate|resync|error）/ `op`（广播）/
`presence`（成员存在）/ `cursor`（远程光标）。HTTP 另有
`GET/POST /api/rooms`、`GET /api/rooms/:id`、`POST /api/rooms/:id/resolve`。

## 目录

```
server.js          HTTP 静态/API + WebSocket 入口
core.js            字素簇、身份 diff、单跳/多跳合并、冲突与坐标变换（前后端共用）
rooms.js           房间状态、多跳 OT 折叠、幂等、冲突裁决、原子持久化
ws-protocol.js     零依赖 RFC6455 子集（服务端 + 测试客户端）
index.html/app-index.js   房间列表与创建
room.html/app-room.js     编辑页（乐观提交、收敛、冲突面板、远程光标）
test/              node:test 单元与端到端测试
```
