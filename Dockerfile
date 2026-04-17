### Stage 1 — Build server
FROM node:22-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY prisma ./prisma
RUN npx prisma generate

COPY . .
RUN npm run build

### Stage 2 — Runner
FROM node:22-alpine

WORKDIR /app

RUN addgroup -g 1002 whymeet \
 && adduser node whymeet

COPY --from=builder /app ./

USER node

CMD ["npm", "start"]
