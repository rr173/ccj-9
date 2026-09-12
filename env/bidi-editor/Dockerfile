# Node 零依赖服务：静态文件 + 快照/批注 JSON API（/api/snapshots、/api/annotations）
FROM node:20-alpine

WORKDIR /app
COPY server.js snapshot-core.js review-core.js app.js snapshots.js annotations.js index.html style.css ./

# 快照与批注数据持久化目录（可挂卷覆盖：-v snapdata:/app/data）
RUN mkdir -p /app/data
ENV SNAPSHOTS_FILE=/app/data/snapshots.json
ENV ANNOTATIONS_FILE=/app/data/annotations.json
ENV PORT=8080

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s \
  CMD wget -qO- http://127.0.0.1:8080/api/snapshots >/dev/null 2>&1 || exit 1

CMD ["node", "server.js"]
