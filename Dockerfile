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
FROM base AS production
RUN npm ci --only=production
COPY src ./src
USER node
CMD ["node", "src/index.js"]

