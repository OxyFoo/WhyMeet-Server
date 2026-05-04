## Système de Tags (Centres d'intérêt & Skills)

### 1. Structure de données

**3 tables Prisma :**

- `Tag` — tag canonique global (`id`, `label` unique, `embedding Float[]`, `domainKey`)
- `TagAlias` — alias d'un tag canonique (ex : "JS" → "JavaScript")
- `UserTag` — tag appartenant à un profil (`userId`, `label` raw, `labelLower`, `tagId?`, `type: 'interest'|'skill'`, `source`)

**`source` possible :** `'free'` (tapé librement), `'popular'` (tag populaire), `'refine:<step>'` (wizard)

---

### 2. Sauvegarde d'un tag (`update-profile`)

1. **Sanitisation** : strip caractères invisibles, collapse whitespace, title-case, max 40 chars
2. **Résolution canonique** (`resolveCanonical`) :
    - Exact match sur `Tag.label` → renvoie `tagId`
    - Case-insensitive match sur `Tag.label` → renvoie `tagId`
    - Alias match sur `TagAlias.alias` → renvoie le `tagId` canonique
    - Normalisation match (`labelNorm`) : si même `labelNorm` qu'un canonique, lie et crée un `TagAlias` si label différent
    - Embedding match (cosine ≥ 0.85) : lie au canonique similaire et crée un `TagAlias` pour cache
    - Sinon → `tagId = null` (tag non encore canonique)
3. **`syncTags`** : supprime tous les `UserTag` existants du type, recrée avec déduplification (par `labelLower`)
4. Invalide les caches Redis (`candidateCache`, `pipelineSetupCache`)

---

### 3. Suggestions (`tag-suggest`)

Appel WS `tag-suggest { query, type }`, 3 passes en cascade :

| Étape | Méthode                                                                                                 | Seuil             |
| ----- | ------------------------------------------------------------------------------------------------------- | ----------------- |
| 1     | **Prefix exact** sur `Tag.label` (insensible à la casse)                                                | toujours          |
| 2     | **Alias match** sur `TagAlias.alias` (prefix, insensible à la casse)                                    | si < 10 résultats |
| 3     | **Recherche sémantique** via cosine similarity sur `Float[]` (OpenAI `text-embedding-3-small` 1536 dim) | si < 5 résultats  |

Retourne `TagSuggestion[]` avec `matchType: 'exact' | 'alias' | 'semantic'`.

Côté client : debounce 300 ms, filtre les tags déjà sélectionnés, affichage en dropdown positionné.

---

### 4. Tags populaires (`get-profile-popular-tags`)

- Agrège les `UserTag` par `labelLower` (tous types), trié par nombre d'utilisateurs distincts
- Résout le label d'affichage (casse d'origine du premier utilisateur)
- Caché dans Redis `profile:popular-tags` avec TTL 1h
- Utilisé comme chips de suggestion dans l'UI (picking rapide sans saisie)

---

### 5. Promotion des tags (tagPromotion.ts) — job 24h

- **Backfill des aliases** : Pour les `UserTag` déjà liés, crée un `TagAlias` si le label diffère du canonique (évite recalculs).
- **Promotion des clusters** : Quand ≥ 10 utilisateurs distincts ont le même `labelNorm` sans `tagId` :
    1. Génère un embedding du label (OpenAI)
    2. **Si similarity ≥ 0.85** avec un tag canonique existant → crée un `TagAlias` et lie les `UserTag`
    3. **Sinon** → crée un nouveau `Tag` canonique (avec embedding + `domainKey`) et lie les `UserTag`
- **Aliasing sémantique** : Pour les tags non liés isolés, utilise embedding pour les aliasser à un canonique similaire (cosine ≥ 0.85).

Le `domainKey` est résolu via tagDomain.ts : embedding du tag comparé aux embeddings des catégories (`INTEREST_CATEGORIES`), seuil cosine ≥ 0.55. Si OpenAI absent → `domainKey = null`.

---

### 6. Utilisation dans l'algo de scoring (scoring.ts)

Score `interests` = 25 pts max, calculé via `scoreInterests()` avec **3 niveaux** :

| Niveau | Match                                                                      | Poids           |
| ------ | -------------------------------------------------------------------------- | --------------- |
| 1      | **Same-type strict** (interest↔interest, skill↔skill) même `labelLower`    | ×1.0            |
| 2      | **Cross-type strict** (interest↔skill ou skill↔interest) même `labelLower` | ×0.85           |
| 3      | **Domain affinity** (même `domainKey` canonique, tags différents)          | ×0.4 (résiduel) |

Formule hybride : `0.4 × ratio + 0.6 × volume` (évite de pénaliser les profils riches en tags).

`scoreProfileQuality` ajoute aussi +2 pts si `tagCount ≥ 3` (sur 20 pts qualité).

`computeMatchScore` est utilisé dans : pipeline de découverte, recherche (`search`), et affichage d'un profil (`get-user-profile`).

---

### 7. Flux de bout en bout (résumé)

```
User tape → TagAutocompleteInput
  → debounce 300ms → WS tag-suggest
    → prefix → alias → sémantique (cosine similarity)
  ← suggestions filtrées

User valide → tag ajouté au profil (source: 'free'|'popular'|...)
  → WS update-profile → sanitize → resolveCanonical (crée TagAlias si match norm/embedding)
  → UserTag.create → invalidation cache Redis

Job 24h (tagPromotion) → backfill TagAlias pour UserTag liés
  → clusters de raw labels non liés (≥10 users) → embedding → alias ou nouveau Tag canonique
  → aliasing sémantique pour singletons non liés

Discovery pipeline → buildTagScoringData()
  → interestLabels + skillLabels (Set<labelLower>) + domainCounts
  → scoreInterests() : 3 niveaux same/cross/domain → score /25
```
