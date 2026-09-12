# 纯静态站点，用 nginx 伺服；无需构建步骤
FROM nginx:1.27-alpine

# 站点文件
COPY index.html style.css app.js /usr/share/nginx/html/

# 容器内监听 80；时区/字符集默认即可（页面自带 charset=utf-8）
EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s \
  CMD wget -qO- http://127.0.0.1/ >/dev/null 2>&1 || exit 1
