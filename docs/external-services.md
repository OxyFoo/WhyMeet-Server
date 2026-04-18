# External Services — WhyMeet Server

Vue d'ensemble de tous les services externes nécessaires au fonctionnement du serveur.

> Les services marqués **optionnel** se désactivent automatiquement s'ils ne sont pas configurés (dégradation gracieuse).

---

## Services obligatoires

### PostgreSQL — Base de données

|               |                                                            |
| ------------- | ---------------------------------------------------------- |
| **Rôle**      | BDD principale (Prisma ORM + pgvector pour les embeddings) |
| **Port**      | `5432` (direct) / `5433` (via PgBouncer en dev)            |
| **Variables** | `DATABASE_URL`                                             |
| **Docker**    | `postgres:16-alpine` (dev) / `postgres:17-alpine` (prod)   |
| **Si absent** | Le serveur ne démarre pas (`process.exit(1)`)              |

### Secrets cryptographiques

| Variable         | Rôle                                             | Contrainte        |
| ---------------- | ------------------------------------------------ | ----------------- |
| `JWT_SECRET`     | Signature des tokens JWT (sessions WS + refresh) | Min 16 caractères |
| `CRYPT_KEY_MAIL` | Chiffrement AES-128-GCM des tokens email         | Min 16 caractères |

---

## Infrastructure (docker-compose)

### PgBouncer — Connection pooling

|            |                                                |
| ---------- | ---------------------------------------------- |
| **Rôle**   | Pool de connexions PostgreSQL (mode session)   |
| **Port**   | `5433` (dev debug) / interne uniquement (prod) |
| **Config** | 20 pool size, 200–300 max clients              |
| **Docker** | `edoburu/pgbouncer:latest`                     |

### Redis — Cache

|               |                                                                                         |
| ------------- | --------------------------------------------------------------------------------------- |
| **Rôle**      | Cache 3 niveaux : profils candidats (5 min), pipeline setup (1 min), exclude list (24h) |
| **Port**      | `6379`                                                                                  |
| **Variables** | `REDIS_URL`, `REDIS_TTL_CANDIDATE_S`, `REDIS_TTL_SETUP_S`                               |
| **Docker**    | `redis:7-alpine` (dev sans persistance) / 512 MB + LRU eviction (prod)                  |
| **Si absent** | Cache désactivé, requêtes DB directes — **optionnel**                                   |

### MinIO — Stockage objets (S3-compatible)

|               |                                                                                                               |
| ------------- | ------------------------------------------------------------------------------------------------------------- |
| **Rôle**      | Stockage des photos de profil (WebP, 800×800, max 5 MB)                                                       |
| **Port**      | `9000` (API S3) / `9001` (console admin)                                                                      |
| **Variables** | `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_REGION`, `S3_PUBLIC_URL`, `UPLOAD_MAX_SIZE` |
| **Docker**    | `minio/minio:latest`                                                                                          |
| **Si absent** | Upload de photos désactivé — **optionnel**                                                                    |

---

## Services cloud

### Amazon S3 — Stockage objets (prod)

|               |                                                                                                               |
| ------------- | ------------------------------------------------------------------------------------------------------------- |
| **Rôle**      | Stockage des photos de profil en production (remplace MinIO)                                                  |
| **Variables** | `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_REGION`, `S3_PUBLIC_URL`, `UPLOAD_MAX_SIZE` |
| **Packages**  | `@aws-sdk/client-s3`                                                                                          |
| **Si absent** | MinIO utilisé en dev, S3 en prod — **optionnel** (uploads désactivés si aucun des deux n'est configuré)       |

### Firebase (FCM) — Push notifications

|               |                                                                      |
| ------------- | -------------------------------------------------------------------- |
| **Rôle**      | Envoi de push notifications (match, like, message, rappels activité) |
| **Variables** | `FIREBASE_SERVICE_ACCOUNT` (JSON stringifié du service account)      |
| **Packages**  | `firebase-admin`                                                     |
| **Si absent** | Notifications push désactivées — **optionnel**                       |

### OpenAI — Embeddings

|               |                                                                                                   |
| ------------- | ------------------------------------------------------------------------------------------------- |
| **Rôle**      | Génération d'embeddings pour la recherche sémantique de tags (`text-embedding-3-small`, 1536 dim) |
| **Variables** | `OPENAI_API_KEY`                                                                                  |
| **Packages**  | `openai`                                                                                          |
| **Si absent** | Recherche par similarité de tags désactivée — **optionnel**                                       |

### SMTP — Emails

|               |                                                                               |
| ------------- | ----------------------------------------------------------------------------- |
| **Rôle**      | Envoi d'emails de confirmation (validation de device)                         |
| **Variables** | `SMTP_HOST`, `SMTP_PORT` (défaut 587), `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM` |
| **Packages**  | `nodemailer`                                                                  |
| **Si absent** | Le lien de validation est affiché dans la console — **optionnel**             |

### Google OAuth — Sign-in

|               |                                                          |
| ------------- | -------------------------------------------------------- |
| **Rôle**      | Vérification des ID tokens Google pour le sign-in        |
| **Variables** | `GOOGLE_CLIENT_ID`                                       |
| **Packages**  | `google-auth-library`                                    |
| **Si absent** | Route `/auth/google-signin` indisponible — **optionnel** |

### Apple Sign-In

|               |                                                                         |
| ------------- | ----------------------------------------------------------------------- |
| **Rôle**      | Vérification des ID tokens Apple pour le sign-in                        |
| **Variables** | `APPLE_CLIENT_ID`, `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY` |
| **Packages**  | `apple-signin-auth`                                                     |
| **Si absent** | Route `/auth/apple-signin` indisponible — **optionnel**                 |

---

## SSL/TLS — HTTPS

|               |                                                            |
| ------------- | ---------------------------------------------------------- |
| **Rôle**      | Chiffrement HTTPS pour le serveur HTTP + WebSocket         |
| **Variables** | `SSL_PRIVATE_KEY_PATH`, `SSL_CERTIFICATE_PATH`             |
| **Prod**      | Certificats montés depuis `/etc/letsencrypt/live/whymeet/` |
| **Si absent** | Fallback sur HTTP — **optionnel**                          |

---

## Résumé des ports (dev)

| Service          | Port   |
| ---------------- | ------ |
| WebSocket Server | `4600` |
| PostgreSQL       | `5432` |
| PgBouncer        | `5433` |
| Redis            | `6379` |
| MinIO (S3 API)   | `9000` |
| MinIO (Console)  | `9001` |

---

## Checklist setup minimal (dev)

```bash
# 1. Lancer l'infra
docker-compose -f docker-compose.dev.yml up -d

# 2. Configurer le .env (minimum requis)
DATABASE_URL=postgresql://user:pass@localhost:5432/whymeet
JWT_SECRET=changeme-min-16-chars
CRYPT_KEY_MAIL=changeme-min-16-chars

# 3. Appliquer le schéma Prisma
npx prisma db push

# 4. Lancer le serveur
npm run dev
```

Tous les autres services (Redis, S3, SMTP, Firebase, OpenAI, Google, Apple) sont optionnels et se désactivent automatiquement.
