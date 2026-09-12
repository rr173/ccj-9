# Node 零依赖服务：静态文件 + 快照/批注/审阅批次 JSON API
FROM node:20-alpine

WORKDIR /app
COPY server.js snapshot-core.js review-core.js decision-core.js app.js snapshots.js annotations.js batches.js decisions.js index.html style.css ./

# 快照、批注、审阅批次与审阅决策数据持久化目录（可挂卷覆盖：-v bidi-editor-data:/app/data）
RUN mkdir -p /app/data
ENV SNAPSHOTS_FILE=/app/data/snapshots.json
ENV ANNOTATIONS_FILE=/app/data/annotations.json
ENV REVIEW_BATCHES_FILE=/app/data/review-batches.json
ENV REVIEW_DECISIONS_FILE=/app/data/review-decisions.json
ENV PORT=8080

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s \
  CMD wget -qO- http://127.0.0.1:8080/api/snapshots >/dev/null 2>&1 || exit 1

CMD ["node", "server.js"]
