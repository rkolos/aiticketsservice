# Base Stage
FROM node:lts-alpine AS base
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# Development Stage
FROM base AS development
RUN apk add --no-cache wget
RUN npm ci --include=dev
COPY . .
CMD ["npm", "run", "dev"]

# Production Stage
FROM node:lts-alpine AS production

# Установка системных зависимостей для сборки нативных модулей и отладки
RUN apk add --no-cache python3 make g++ curl

# Установка переменных окружения для production
ENV NODE_ENV=production

# Создание рабочей директории
WORKDIR /app

# Копирование package файлов
COPY package.json package-lock.json ./

# Установка только production зависимостей (без devDependencies)
RUN npm ci --only=production --ignore-scripts

# Копирование исходного кода
COPY src ./src

# Изменение владельца файлов на пользователя node (не root)
RUN chown -R node:node /app

# Переключение на пользователя node для безопасности
USER node

# Точка входа - прямой запуск node без npm wrapper для корректной обработки сигналов
CMD ["node", "src/index.js"]

