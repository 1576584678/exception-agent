# syntax=docker/dockerfile:1
# 构建阶段：安装全部依赖并编译 TS
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build

# 运行阶段：只保留生产依赖 + 编译产物 + 静态资源
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY public ./public
COPY docs ./docs
# 项目配置持久化目录（建议挂载卷）
RUN mkdir -p /app/data
EXPOSE 3000
# JWT_SECRET 必须由运行时注入（docker run -e / compose environment）
CMD ["node", "dist/index.js"]
