# External Services — WhyMeet Server

Vue d'ensemble de tous les services externes nécessaires au fonctionnement du serveur.

> Les services marqués **optionnel** se désactivent automatiquement s'ils ne sont pas configurés (dégradation gracieuse).

## Sommaire des services

| Service                                                  | Description / Intérêt                                               | Optionnel ?                                 | Détails                                  |
| -------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------- | ---------------------------------------- |
| [Secrets cryptographiques](#service-secrets)             | Signature des tokens JWT + chiffrement AES-128-GCM des tokens email | ❌ Requis                                   | `JWT_SECRET`, `CRYPT_KEY_MAIL`           |
| [PostgreSQL — Base de données](#service-postgresql)      | BDD principale (Prisma ORM, embeddings stockés en `Float[]`)        | ❌ Requis                                   | Ports `5432` / `5433` (PgBouncer)        |
| [PgBouncer — Connection pooling](#service-pgbouncer)     | Pool de connexions PostgreSQL (20 pool size, 200–300 max clients)   | ❌ Requis                                   | Port `5433`                              |
| [SSL/TLS — HTTPS](#service-ssl-tls)                      | Chiffrement HTTPS pour le serveur HTTP + WebSocket                  | ✅ Fallback HTTP                            | Certificats Let's Encrypt                |
| [Redis — Cache](#service-redis)                          | Cache 3 niveaux : profils candidats, pipeline, exclude list         | ✅ Requêtes DB directes si absent           | Port `6379`                              |
| [MinIO — Stockage objets (dev)](#service-minio)          | Stockage des photos de profil en développement (S3-compatible)      | ✅ Uploads désactivés si absent             | Ports `9000` (API) / `9001` (console)    |
| [Amazon S3 — Stockage objets (prod)](#service-amazon-s3) | Stockage des photos de profil en production (remplace MinIO)        | ✅ Uploads désactivés si aucun S3           | `@aws-sdk/client-s3`                     |
| [Firebase (FCM) — Push notifications](#service-firebase) | Envoi de push notifications (match, like, message, rappels)         | ✅ Notifs push désactivées                  | `firebase-admin`                         |
| [OpenAI — Embeddings](#service-openai)                   | Recherche sémantique de tags (`text-embedding-3-small`, 1536 dim)   | ✅ Similarité de tags désactivée            | `openai`                                 |
| [SMTP — Emails](#service-smtp)                           | Envoi d'emails de confirmation lors de la validation de device      | ✅ Lien affiché en console                  | `nodemailer`, port `587`                 |
| [Google OAuth — Sign-in](#service-google-oauth)          | Vérification des ID tokens Google pour le sign-in                   | ✅ Route `/auth/google-signin` indisponible | `google-auth-library`                    |
| [Apple Sign-In](#service-apple-signin)                   | Vérification des ID tokens Apple pour le sign-in                    | ✅ Route `/auth/apple-signin` indisponible  | `apple-signin-auth`                      |
| [Device Integrity](#service-device-integrity)            | Vérifie que l'app tourne sur un vrai appareil (anti-émulateur)      | ✅ Désactivé par défaut                     | Google Play Integrity + Apple App Attest |

---

## Services obligatoires

<a id="service-postgresql"></a>

### PostgreSQL — Base de données

|               |                                                              |
| ------------- | ------------------------------------------------------------ |
| **Rôle**      | BDD principale (Prisma ORM, embeddings stockés en `Float[]`) |
| **Port**      | `5432` (direct) / `5433` (via PgBouncer en dev)              |
| **Variables** | `DATABASE_URL`                                               |
| **Docker**    | `postgres:16-alpine` (dev) / `postgres:17-alpine` (prod)     |
| **Si absent** | Le serveur ne démarre pas (`process.exit(1)`)                |

<a id="service-secrets"></a>

### Secrets cryptographiques

| Variable         | Rôle                                             | Contrainte        |
| ---------------- | ------------------------------------------------ | ----------------- |
| `JWT_SECRET`     | Signature des tokens JWT (sessions WS + refresh) | Min 16 caractères |
| `CRYPT_KEY_MAIL` | Chiffrement AES-128-GCM des tokens email         | Min 16 caractères |

---

## Infrastructure (docker-compose)

<a id="service-pgbouncer"></a>

### PgBouncer — Connection pooling

|            |                                                |
| ---------- | ---------------------------------------------- |
| **Rôle**   | Pool de connexions PostgreSQL (mode session)   |
| **Port**   | `5433` (dev debug) / interne uniquement (prod) |
| **Config** | 20 pool size, 200–300 max clients              |
| **Docker** | `edoburu/pgbouncer:latest`                     |

<a id="service-redis"></a>

### Redis — Cache

|               |                                                                                         |
| ------------- | --------------------------------------------------------------------------------------- |
| **Rôle**      | Cache 3 niveaux : profils candidats (5 min), pipeline setup (1 min), exclude list (24h) |
| **Port**      | `6379`                                                                                  |
| **Variables** | `REDIS_URL`, `REDIS_TTL_CANDIDATE_S`, `REDIS_TTL_SETUP_S`                               |
| **Docker**    | `redis:7-alpine` (dev sans persistance) / 512 MB + LRU eviction (prod)                  |
| **Si absent** | Cache désactivé, requêtes DB directes — **optionnel**                                   |

<a id="service-minio"></a>

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

<a id="service-amazon-s3"></a>

### Amazon S3 — Stockage objets (prod)

|               |                                                                                                               |
| ------------- | ------------------------------------------------------------------------------------------------------------- |
| **Rôle**      | Stockage des photos de profil en production (remplace MinIO)                                                  |
| **Variables** | `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_REGION`, `S3_PUBLIC_URL`, `UPLOAD_MAX_SIZE` |
| **Packages**  | `@aws-sdk/client-s3`                                                                                          |
| **Si absent** | MinIO utilisé en dev, S3 en prod — **optionnel** (uploads désactivés si aucun des deux n'est configuré)       |

<a id="service-firebase"></a>

### Firebase (FCM) — Push notifications

|               |                                                                      |
| ------------- | -------------------------------------------------------------------- |
| **Rôle**      | Envoi de push notifications (match, like, message, rappels activité) |
| **Variables** | `FIREBASE_SERVICE_ACCOUNT` (JSON stringifié du service account)      |
| **Packages**  | `firebase-admin`                                                     |
| **Si absent** | Notifications push désactivées — **optionnel**                       |

<a id="service-openai"></a>

### OpenAI — Embeddings

|               |                                                                                                   |
| ------------- | ------------------------------------------------------------------------------------------------- |
| **Rôle**      | Génération d'embeddings pour la recherche sémantique de tags (`text-embedding-3-small`, 1536 dim) |
| **Variables** | `OPENAI_API_KEY`                                                                                  |
| **Packages**  | `openai`                                                                                          |
| **Si absent** | Recherche par similarité de tags désactivée — **optionnel**                                       |

<a id="service-smtp"></a>

### SMTP — Emails

|               |                                                                               |
| ------------- | ----------------------------------------------------------------------------- |
| **Rôle**      | Envoi d'emails de confirmation (validation de device)                         |
| **Variables** | `SMTP_HOST`, `SMTP_PORT` (défaut 587), `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM` |
| **Packages**  | `nodemailer`                                                                  |
| **Si absent** | Le lien de validation est affiché dans la console — **optionnel**             |

<a id="service-google-oauth"></a>

### Google OAuth — Sign-in

|               |                                                          |
| ------------- | -------------------------------------------------------- |
| **Rôle**      | Vérification des ID tokens Google pour le sign-in        |
| **Variables** | `GOOGLE_CLIENT_ID`                                       |
| **Packages**  | `google-auth-library`                                    |
| **Si absent** | Route `/auth/google-signin` indisponible — **optionnel** |

<a id="service-apple-signin"></a>

### Apple Sign-In

|               |                                                                         |
| ------------- | ----------------------------------------------------------------------- |
| **Rôle**      | Vérification des ID tokens Apple pour le sign-in                        |
| **Variables** | `APPLE_CLIENT_ID`, `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY` |
| **Packages**  | `apple-signin-auth`                                                     |
| **Si absent** | Route `/auth/apple-signin` indisponible — **optionnel**                 |

---

<a id="service-ssl-tls"></a>

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

---

<a id="service-device-integrity"></a>

## Device Integrity (optionnel)

Vérifie que l'app tourne sur un vrai appareil (pas émulateur/root/jailbreak).

| Plateforme | API                   | Variables d'env                                             |
| ---------- | --------------------- | ----------------------------------------------------------- |
| Android    | Google Play Integrity | `GOOGLE_CLOUD_PROJECT_NUMBER`, `GOOGLE_SERVICE_ACCOUNT_KEY` |
| iOS        | Apple App Attest      | `APPLE_APP_ATTEST_ENVIRONMENT`                              |

| Variable                  | Rôle                                                  |
| ------------------------- | ----------------------------------------------------- |
| `INTEGRITY_CHECK_ENABLED` | Active/désactive la vérification (`false` par défaut) |

> Guide de configuration complet : [`docs/integrity-setup.md`](./integrity-setup.md)
