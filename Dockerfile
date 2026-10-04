FROM node:20-alpine

WORKDIR /app

# 零第三方依赖：直接复制全部源码
COPY . .

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080

EXPOSE 8080

CMD ["node", "server.js"]
