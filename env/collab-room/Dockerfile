# 双向文本多人协作编辑房间 —— 零运行时依赖 Node 服务
# ws 协议为内置实现（ws-protocol.js），无需 npm install 即可运行。
FROM node:20-alpine

WORKDIR /app

# 零依赖：直接拷贝源码（.dockerignore 已排除 data/node_modules）
COPY server.js core.js rooms.js ws-protocol.js ./
COPY app-index.js app-room.js ./
COPY index.html room.html style.css ./

ENV NODE_ENV=production
ENV PORT=8080
ENV COLLAB_ROOMS_FILE=/app/data/rooms.json

RUN mkdir -p /app/data

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server.js"]
