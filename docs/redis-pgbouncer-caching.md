# Redis & PgBouncer — Optimisations discovery pipeline

## Contexte

Le pipeline de découverte (`buildPipelineContext` + `runPipelineQuery`) était le point chaud de la base de données : chaque swipe déclenchait 3–5 requêtes SQL avec des JOINs coûteux (profile, photos, tags, \_count). Ce document décrit les trois niveaux de cache Redis ajoutés et la couche PgBouncer qui les complètent.

---

## Infrastructure ajoutée

- **Image** : `edoburu/pgbouncer:latest`

- **Mode** : `session` (compatible Prisma — pas de prepared statements cassés)
- **Pool** : `DEFAULT_POOL_SIZE=20`, `MAX_CLIENT_CONN=200` (dev) / `300` (prod)
- **Effet** : les connexions PostgreSQL sont réutilisées entre requêtes ; évite l'overhead d'établissement de connexion TLS+auth à chaque query Prisma
- **Dev** : port `5433` exposé localement pour debug psql direct
- **Prod** : IP fixe `172.16.0.11` sur le réseau Docker interne

### Redis (`redis:7-alpine`)

- **Dev** : pas de persistance (`--save '' --appendonly no`), port `6379` exposé
- **Prod** : `maxmemory 512mb`, policy `allkeys-lru` (éviction automatique sous pression mémoire), IP fixe `172.16.0.12`
- **Graceful degradation** : si Redis est indisponible au démarrage ou crash en cours de route, toutes les fonctions de cache retournent silencieusement `null` / `[]` et le code retombe sur la DB — aucun bloquant

---

## Variables d'environnement ajoutées

| Variable                | Défaut           | Description                                  |
| ----------------------- | ---------------- | -------------------------------------------- |
| `REDIS_URL`             | `""` (désactivé) | URL de connexion Redis. Vide = mode dégradé  |
| `REDIS_TTL_CANDIDATE_S` | `300`            | TTL des profils candidats en cache (5 min)   |
| `REDIS_TTL_SETUP_S`     | `60`             | TTL du PipelineSetup par utilisateur (1 min) |

---

## Les trois niveaux de cache

### Niveau 1 — Profils candidats (`candidateCache.ts`)

**Clés** : `candidate:{userId}` · **TTL** : `REDIS_TTL_CANDIDATE_S` (300 s)

**Problème résolu** : chaque appel à `runPipelineQuery` faisait un `findMany` avec 3 JOINs (`profile`, `photos`, `tags`) + `_count` sur 100 lignes. Coûteux même avec des indexes.

**Implémentation** :

```
runPipelineQuery()
  1. ID scan : findMany({ select: { id: true } })   → pas de JOIN, lecture index seule
  2. getCandidates(ids)                              → mget Redis, O(N) sans DB
  3. DB fetch uniquement pour les miss               → findMany({ where: { id: { in: missIds } } })
  4. setCandidates(freshUsers)                       → pipeline Redis SET batch
  5. Reconstruction de la liste ordonnée par ID
```

**Gain** : sur un pool de 100 candidats stable, un hit de cache complet élimine le `findMany` JOIN et le remplace par un seul `mget` Redis.

**Invalidation** :

- `invalidateCandidate(userId)` — supprime `candidate:{userId}`
- Appelé dans : `update-profile.ts`, `uploadRoutes.ts` (ajout photo, suppression photo)

---

### Niveau 2 — PipelineSetup (`pipelineSetupCache.ts`)

**Clés** : `pipeline:setup:{userId}` · **TTL** : `REDIS_TTL_SETUP_S` (60 s)

**Problème résolu** : `buildPipelineContext` faisait 2 requêtes SQL à chaque demande de découverte — `findUnique(user + profile + tags)` + `findUnique(settings)`. Ces données changent rarement.

**Implémentation** :

- Cache hit → merge avec `getExcludeIds()` live (les IDs d'exclusion ne sont jamais sérialisés ici)
- Cache miss → reconstruction depuis DB, stockage avec `excludeIds: []`
- `Set<string>` (myTagLabels) sérialisé en `string[]` pour JSON

**Note importante** : `excludeIds` est volontairement absent du JSON stocké. Le niveau 3 les gère via un Redis Set dédié pour avoir des mises à jour O(1) sans invalider le setup entier.

**Invalidation** :

- `invalidatePipelineSetup(userId)` — supprime `pipeline:setup:{userId}`
- Appelé dans : `update-profile.ts`, `update-preferences.ts`

---

### Niveau 3 — Liste d'exclusion (`excludeCache.ts`)

**Clés** : `excluded:{userId}` (Redis Set) + `excluded:seeded:{userId}` (marker, TTL 24 h)

**Problème résolu** : à chaque `buildPipelineContext`, 3 requêtes DB étaient nécessaires pour reconstruire la liste des IDs à exclure (matches envoyés + blocks bilatéraux + reports). Cette liste grossit avec le temps.

**Implémentation** :

- Premier appel → seed depuis DB (3 requêtes parallèles), stockage en Redis Set avec TTL 24 h
- Appels suivants → `SMEMBERS excluded:{userId}` uniquement, O(N) Redis
- Post-action → `SADD excluded:{userId} targetId` — mise à jour O(1), pas de re-seed

**Mise à jour incrémentale** (`addExcluded(userId, targetId)`) :

- Appelé après chaque action qui exclut un utilisateur du pipeline
- No-op si le set n'est pas encore seedé (sera peuplé au prochain `getExcludeIds`)

| Commande             | Qui exclut qui                   |
| -------------------- | -------------------------------- |
| `like.ts`            | moi → candidat                   |
| `skip.ts`            | moi → candidat                   |
| `star.ts`            | moi → candidat                   |
| `accept-request.ts`  | moi → envoyeur                   |
| `decline-request.ts` | moi → envoyeur                   |
| `block-user.ts`      | moi → bloqué **ET** bloqué → moi |
| `report-user.ts`     | moi → signalé                    |

---

## Flux complet d'une requête de découverte (après optimisation)

```
WebSocket: DISCOVERY_GET_CANDIDATES
│
├─ buildPipelineContext(userId)
│   ├─ [L2] GET pipeline:setup:{userId}       ← hit: merge excludeIds, done
│   │   └─ miss: 2× DB query (user+settings)
│   │       └─ SET pipeline:setup:{userId} EX 60
│   └─ [L3] SMEMBERS excluded:{userId}        ← ou seed depuis DB si absent
│
└─ runPipelineQuery(setup, filters)
    ├─ findMany({ select: id })                ← index scan seul, pas de JOIN
    ├─ [L1] MGET candidate:id1 candidate:id2…  ← hits Redis
    │   └─ miss: findMany({ id: { in: missIds } }) + SET batch
    └─ score + distance filter → réponse
```

---

## Résumé des fichiers modifiés / créés

### Nouveaux fichiers

| Fichier                              | Rôle                                                        |
| ------------------------------------ | ----------------------------------------------------------- |
| `src/services/redisService.ts`       | Singleton ioredis, connect/disconnect, `isRedisAvailable()` |
| `src/services/excludeCache.ts`       | Niveau 3 — Redis Set d'exclusion par utilisateur            |
| `src/services/candidateCache.ts`     | Niveau 1 — Cache des profils candidats complets             |
| `src/services/pipelineSetupCache.ts` | Niveau 2 — Cache du PipelineSetup (user + settings)         |

### Fichiers modifiés

| Fichier                                       | Modification                                                                         |
| --------------------------------------------- | ------------------------------------------------------------------------------------ |
| `src/config/env.ts`                           | Ajout `REDIS_URL`, `REDIS_TTL_CANDIDATE_S`, `REDIS_TTL_SETUP_S`                      |
| `src/index.ts`                                | `connectRedis()` au démarrage, `disconnectRedis()` à l'arrêt                         |
| `src/services/discoveryPipeline.ts`           | Intégration des 3 niveaux de cache dans `buildPipelineContext` et `runPipelineQuery` |
| `src/commands/discovery/like.ts`              | `addExcluded` post-swipe                                                             |
| `src/commands/discovery/skip.ts`              | `addExcluded` post-swipe                                                             |
| `src/commands/discovery/star.ts`              | `addExcluded` post-swipe                                                             |
| `src/commands/discovery/accept-request.ts`    | `addExcluded` post-accept                                                            |
| `src/commands/discovery/decline-request.ts`   | `addExcluded` post-decline                                                           |
| `src/commands/moderation/block-user.ts`       | `addExcluded` bidirectionnel                                                         |
| `src/commands/moderation/report-user.ts`      | `addExcluded` unilatéral                                                             |
| `src/commands/profile/update-profile.ts`      | `invalidateCandidate` + `invalidatePipelineSetup`                                    |
| `src/commands/settings/update-preferences.ts` | `invalidatePipelineSetup`                                                            |
| `src/server/uploadRoutes.ts`                  | `invalidateCandidate` sur ajout et suppression de photo                              |
| `docker-compose.dev.yml`                      | Services `whymeet-pgbouncer-dev` (`edoburu/pgbouncer`) + `whymeet-redis-dev`         |
| `docker-compose.prod.yml`                     | Services `whymeet-pgbouncer-prod` (`edoburu/pgbouncer`) + `whymeet-redis-prod`       |

---

## Déploiement prod — variables requises

Les variables suivantes doivent être présentes dans le `.env` de l'hôte pour `docker-compose.prod.yml` :

```env
POSTGRES_HOST=<ip ou hostname du PostgreSQL>
POSTGRES_PORT=5432
POSTGRESQL_USERNAME=<user>
POSTGRESQL_PASSWORD=<password>
POSTGRESQL_DATABASE=<database>
```

`REDIS_URL` est injecté automatiquement via le `docker-compose.prod.yml` (`redis://whymeet-redis-prod:6379`).
