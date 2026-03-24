# WhyMeet Server

Backend WebSocket server for the WhyMeet app, using Prisma with PostgreSQL.

## Prerequisites

- Node.js >= 22
- Docker & Docker Compose (for database)

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Copy environment template
cp .env.template .env

# 3. Start database (Docker)
docker compose -f docker-compose.dev.yml up -d whymeet-db-dev

# 4. Generate Prisma client & run migrations
npx prisma generate
npx prisma migrate dev

# 5. Build & run
npm run dev
```

## Scripts

| Script | Description |
|--------|-------------|
| `npm start` | Start the compiled server |
| `npm run build` | Compile TypeScript |
| `npm run dev` | Build + Start |
| `npm run lint` | ESLint check |
| `npm run typecheck` | TypeScript check |
| `npm test` | Run tests |
| `npm run db:generate` | Generate Prisma client |
| `npm run db:migrate` | Run Prisma migrations |
| `npm run db:push` | Push schema to DB |
| `npm run db:studio` | Open Prisma Studio |

## Docker

```bash
# Development (app + database)
docker compose -f docker-compose.dev.yml up --build

# Production (app only, external DB)
docker compose -f docker-compose.prod.yml up --build
```

## Structure

```
src/
├── index.ts              # Entry point
├── config/env.ts          # Environment config (Zod validated)
├── server/                # WebSocket server core
├── commands/              # Command handlers per domain
├── services/              # Database, logger
└── utils/                 # Helpers
prisma/
└── schema.prisma          # Database schema
```
