# syntax=docker/dockerfile:1

# ---- 构建阶段 ----
FROM node:20-alpine AS build
WORKDIR /app

# 先拷贝依赖清单，充分利用镜像层缓存
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .
RUN npm run build

# ---- 运行阶段：nginx 托管静态产物 ----
FROM nginx:1.27-alpine
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
