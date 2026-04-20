# Device Integrity Setup Guide

Ce guide explique comment configurer Google Play Integrity (Android) et Apple App Attest (iOS) pour WhyMeet.

---

## Vue d'ensemble

Lorsque `INTEGRITY_CHECK_ENABLED=true`, le serveur :

1. Génère un **challenge** unique (nonce) par device
2. Le client obtient un **attestation token** via l'API native (Play Integrity / App Attest)
3. Le serveur vérifie le token et marque le device comme vérifié (`integrityVerifiedAt`)
4. La vérification est valide 24h, puis redemandée automatiquement
5. Sans vérification, `POST /auth/refresh-ws-token` retourne `403 integrity_required`

---

## Android — Google Play Integrity

### 1. Google Cloud Console

1. Aller sur [console.cloud.google.com](https://console.cloud.google.com)
2. Sélectionner ou créer un projet
3. **APIs & Services → Enable APIs** → activer **Play Integrity API**
4. **APIs & Services → Credentials → Create credentials → Service account**
    - Nom : `whymeet-integrity`
    - Rôle : aucun rôle nécessaire (l'API est activée au niveau projet)
5. Créer une clé JSON pour ce service account
6. Noter le **Project Number** (dans les paramètres du projet)

### 2. Google Play Console

1. Aller sur [play.google.com/console](https://play.google.com/console)
2. Sélectionner l'app `com.oxyfoo.whymeet`
3. **Release → App signing** → noter le SHA-256 du certificat de signature
4. **Release → App integrity** → onglet **Play Integrity API**
5. Lier le projet Google Cloud créé à l'étape 1

### 3. Variables d'env serveur

```bash
INTEGRITY_CHECK_ENABLED=true
GOOGLE_CLOUD_PROJECT_NUMBER=123456789012
GOOGLE_SERVICE_ACCOUNT_KEY='{"type":"service_account","project_id":"...","private_key":"..."}'
```

> `GOOGLE_SERVICE_ACCOUNT_KEY` est le contenu JSON du fichier de clé, sur une seule ligne (échapper les retours à la ligne ou utiliser single quotes).

### 4. Côté client Android

Le package `react-native-google-play-integrity` gère l'intégration nativement (autolinked). La version Play Integrity est forcée à `1.6.0` via `ext.playIntegrityVersion` dans `android/build.gradle`.

Aucune configuration supplémentaire côté client n'est nécessaire.

---

## iOS — Apple App Attest

### 1. Apple Developer Portal

1. Aller sur [developer.apple.com](https://developer.apple.com)
2. **Certificates, Identifiers & Profiles → Identifiers**
3. Sélectionner l'App ID `com.oxyfoo.whymeet`
4. Activer **App Attest** dans les capabilities
5. Noter le **Team ID** (visible en haut à droite du portail)

### 2. Xcode

1. Ouvrir `WhyMeet.xcworkspace`
2. **Signing & Capabilities → + Capability → App Attest**
3. L'environnement est `production` par défaut ; pour les tests, utiliser `development`

### 3. Variables d'env serveur

```bash
APPLE_APP_ATTEST_ENVIRONMENT=production  # ou "development" pour les tests
```

### 4. Côté client iOS

Le package `react-native-app-attest` gère l'intégration nativement (autolinked via CocoaPods).

> **Note :** App Attest n'est pas disponible sur le simulateur iOS. En mode développement, l'appel échouera, ce qui est normal.

### 5. Configuration du Team ID serveur

Dans `src/services/integrityService.ts`, remplacer `TEAMID` par votre vrai Team ID Apple :

```typescript
const appId = 'ABCDE12345.com.oxyfoo.whymeet';
```

---

## Migration Prisma

Le champ `integrityVerifiedAt` a été ajouté au modèle `Device`. Appliquer la migration :

```bash
npx prisma db push
# ou pour créer une migration versionnée :
npx prisma migrate dev --name add-integrity-verified-at
```

---

## Test de la vérification

### En développement (désactivé)

Par défaut `INTEGRITY_CHECK_ENABLED=false` → le flow d'intégrité est complètement bypassé. Les endpoints `/auth/integrity-challenge` et `/auth/integrity-verify` retournent directement des réponses "not required" / "verified".

### En staging/production

1. Mettre `INTEGRITY_CHECK_ENABLED=true`
2. Configurer les variables Google/Apple
3. L'app demandera automatiquement l'attestation au boot
4. Si la vérification échoue, l'utilisateur verra l'écran "Device Not Supported"
5. Vérifier les logs serveur : `[Auth] Integrity verified: device=xxx platform=android|ios`

---

## Troubleshooting

| Problème                       | Cause probable                 | Solution                                                     |
| ------------------------------ | ------------------------------ | ------------------------------------------------------------ |
| `INTEGRITY_ERROR` côté Android | Play Integrity API pas activée | Activer dans Google Cloud Console                            |
| `UNSUPPORTED` côté iOS         | Simulateur ou iOS < 14         | Tester sur un vrai device                                    |
| `integrity_required` en boucle | Service account key invalide   | Vérifier le JSON et les permissions                          |
| Nonce mismatch                 | Challenge expiré (> 60s)       | Le challenge est valide 1 minute, vérifier la latence réseau |
