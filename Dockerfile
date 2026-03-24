### Stage 1 — Build @whymeet/types
FROM node:22-alpine AS types-builder

WORKDIR /build/WhyMeet-Types

COPY WhyMeet-Types/package*.json ./
RUN npm ci

COPY WhyMeet-Types/ .
RUN npm run build

### Stage 2 — Build server
FROM node:22-alpine AS builder

WORKDIR /build/WhyMeet-Server

# Place built types where the file: dependency expects them
COPY --from=types-builder /build/WhyMeet-Types/dist /build/WhyMeet-Types/dist

COPY WhyMeet-Server/package*.json ./
RUN npm ci

COPY WhyMeet-Server/prisma ./prisma
RUN npx prisma generate

COPY WhyMeet-Server/ .
RUN npm run build

### Stage 3 — Runner
FROM node:22-alpine

WORKDIR /app

RUN addgroup -g 1002 whymeet \
 && adduser node whymeet

COPY --from=builder /build/WhyMeet-Server ./

USER node

CMD ["npm", "start"]
