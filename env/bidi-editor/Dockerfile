# Node 零依赖服务：静态文件 + 快照/批注/审阅批次/决策执行队列/执行回放/角色委派/申请分组/申请模板 JSON API
FROM node:20-alpine

WORKDIR /app
COPY server.js snapshot-core.js review-core.js decision-core.js replay-core.js replay-review-core.js replay-session-core.js replay-archive-core.js replay-reconcile-core.js permission-core.js permission-request-core.js permission-request-group-core.js permission-template-core.js app.js snapshots.js annotations.js batches.js decisions.js replay.js replay-archive.js replay-reconcile.js permissions.js index.html style.css ./

# 快照、批注、审阅批次、审阅决策、执行回放/归档/对账与角色委派数据持久化目录（可挂卷覆盖：-v bidi-editor-data:/app/data）
RUN mkdir -p /app/data
ENV SNAPSHOTS_FILE=/app/data/snapshots.json
ENV ANNOTATIONS_FILE=/app/data/annotations.json
ENV REVIEW_BATCHES_FILE=/app/data/review-batches.json
ENV REVIEW_DECISIONS_FILE=/app/data/review-decisions.json
ENV REPLAY_SPACES_FILE=/app/data/replay-spaces.json
ENV REPLAY_ARCHIVES_FILE=/app/data/replay-archives.json
ENV REPLAY_RECONCILE_FILE=/app/data/replay-reconcile.json
ENV PERMISSIONS_FILE=/app/data/permissions.json
ENV PORT=8080

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s \
  CMD wget -qO- http://127.0.0.1:8080/api/snapshots >/dev/null 2>&1 || exit 1

CMD ["node", "server.js"]
