# Fonctionnalité Groups améliorée — Document de convergence

Ce document sert de base consolidée "au fil de l’eau" pour la refonte Groups.
Il reprend le plan exécutable fourni et l’organise en phases, fichiers et actions.

## Décision d’architecture à figer

- **Runtime groupe utilisateur final** = `talk_groups` + `talk_group_members` + `conversations`.
- **Discovery / intelligence** = `smart_groups`.
- **Legacy à sortir du runtime** = `groups` / `group_memberships` / `group_messages` et l’implémentation `groups` de `social-graph`.

### Justification observée dans le repo

- Le front Groups actuel consomme `getGroups` / `createGroup` / `autoGenerateGroups` / `explainGroup` via `talkApi.js`, donc le domaine smart-groups, pas talk-groups.
- `src/app.ts` monte en parallèle `groupsRouter` et `talkGroupsRouter`, ce qui expose une duplication métier.
- `src/api/talkGroupsRouter.ts` est déjà le domaine le plus proche d’un vrai groupe utilisateur (liste, détail, join/leave, `conversation_id`).
- `services/smart-groups` est conçu comme moteur FATIMA / trending / candidates / explain / outbox / admin review, donc comme couche de découverte et non comme runtime communautaire complet.

---

## Phase 0 — Gel d’architecture et arrêt de la dérive

### Fichiers à geler comme legacy source (sans réécriture)

- `migrations/032_create_groups.sql`
- `migrations/100_groups.sql`
- `migrations/105_group_roles.sql`
- `migrations/110_group_messages.sql`
- `services/groupsService.ts`
- `src/services/groupService.ts`
- `services/social-graph/src/controllers/groups.ts`

### Action

Ne plus faire de nouvelle écriture runtime vers :

- `groups`
- `group_memberships`
- `group_messages`

Ne plus considérer `services/social-graph` comme propriétaire métier des groupes.

### Raison

Ces fichiers montrent des capacités utiles, mais ne doivent plus être la base canonique du produit final.
Convergence via migrations forward-only et déplacement des écritures runtime vers `talk_groups`.

---

## Phase 1 — Schéma canonique runtime

### 1.1 Nouveau fichier

`migrations/20260407001_talk_groups_canonical.sql`

**Action**

Étendre `talk_groups` pour absorber les champs runtime dispersés.

- Garder :
  - `id`
  - `name`
  - `description`
  - `owner_id`
  - `is_public`
  - `legal_entity`
  - `member_count`
  - `created_at`
  - `updated_at`
  - `is_private`
  - `max_members`
- Ajouter :
  - `slug`
  - `locale`
  - `settings JSONB DEFAULT '{}'::jsonb`
  - `metadata JSONB DEFAULT '{}'::jsonb`
  - `topic_id UUID NULL`

**Raison**

`talk_groups` est déjà la meilleure base runtime. Les champs utiles de `groups` et `smart_groups` y sont consolidés.

### 1.2 Nouveau fichier

`migrations/20260407002_talk_group_members_canonical.sql`

**Action**

Normaliser `talk_group_members` :

- Conserver clé `(group_id, user_id)`
- Normaliser `role` :
  - `owner`
  - `admin`
  - `moderator`
  - `member`
  - `guest`
- Normaliser `status` :
  - `invited`
  - `accepted`
  - `left`
  - `banned`

**Raison**

Récupérer les rôles/statuts déjà présents ailleurs pour supporter administration, modération, transfert d’ownership.

### 1.3 Nouveau fichier

`migrations/20260407003_conversation_memberships.sql`

**Action**

Créer/valider explicitement `conversation_memberships` avec :

- `conversation_id`
- `user_id`
- `role`
- `status`
- `joined_at`
- Unicité `(conversation_id, user_id)`

**Raison**

`src/api/talkGroupsRouter.ts` y écrit déjà ; la dépendance doit être explicitement migrée.

### 1.4 Nouveau fichier

`migrations/20260407004_talk_group_capabilities.sql`

**Action**

Porter les capacités du legacy vers le runtime canonique :

- `talk_group_pins`
- `talk_group_metrics`
- `talk_group_moderation_logs`

En reprenant les formes existantes de :

- `group_pins`
- `group_metrics`
- `group_moderation_logs`

**Raison**

Ne pas réinventer les capacités existantes ; les rattacher à `talk_groups`.

### 1.5 Nouveau fichier

`migrations/20260407005_smart_groups_bridge.sql`

**Action**

Ajouter à `smart_groups` un pont explicite vers le runtime :

- `talk_group_id UUID NULL REFERENCES talk_groups(id)`

Et indexer pour relation discovery → runtime propre.

**Raison**

`smart_groups` reste discovery mais doit pointer vers le groupe final rejoignable.

---

## Phase 2 — Runtime API canonique (main API)

### 2.1 Nouveau fichier

`src/services/talkGroupService.ts`

**Action**

Créer une couche de service canonique et sortir la logique SQL de `talkGroupsRouter.ts`.

Fonctions :

- `createGroup`
- `listDiscoverableGroups`
- `listMyGroups`
- `getGroupDetail`
- `joinGroup`
- `leaveGroup`
- `updateGroup`
- `listMembers`
- `changeMemberRole`
- `changeMemberStatus`
- `transferOwnership`
- `ensureGroupConversation`

**Raison**

Pattern déjà présent (`src/services/groupService.ts`) ; éviter SQL inline dans les routeurs.

### 2.2 Fichier à modifier

`src/api/talkGroupsRouter.ts`

**Action**

Le faire devenir le runtime public des groupes.

Routes à garder/compléter :

- `POST /api/v1/talk-groups`
- `GET /api/v1/talk-groups`
- `GET /api/v1/talk-groups/:id`
- `POST /api/v1/talk-groups/:id/join`
- `POST /api/v1/talk-groups/:id/leave`

Routes à ajouter :

- `PATCH /api/v1/talk-groups/:id`
- `GET /api/v1/talk-groups/:id/members`
- `POST /api/v1/talk-groups/:id/members/:userId/role`
- `POST /api/v1/talk-groups/:id/members/:userId/status`
- `POST /api/v1/talk-groups/:id/ownership/transfer`

**Raison**

Compléter le domaine canonique (rôles, membres, ownership) dans le même routeur.

### 2.3 Fichier à modifier

`src/app.ts`

**Action**

Conserver `talkGroupsRouter` et sortir `groupsRouter` du runtime final.

Cible :

- `talkGroupsRouter` = runtime groupe
- `groupsRouter` = discovery/suggestion uniquement, ou retiré après cutover client

### 2.4 Fichier à modifier

`src/api/groupsRouter.ts`

**Action**

Le retirer du rôle de création runtime.

Conserver uniquement discovery si maintenu dans main API :

- listing smart-groups
- auto/generate
- explain
- éventuellement admin candidate accept/reject si non externalisé

### 2.5 Fichiers à sortir du runtime

- `src/services/groupService.ts`
- `services/groupsService.ts`

**Action**

Les marquer legacy et retirer leurs écritures runtime une fois `talkGroupService.ts` en place.

---

## Phase 3 — Discovery service canonique

### 3.1 Fichier à modifier

`services/smart-groups/src/api/groupsRouter.ts`

**Action**

Recentrer sur discovery :

- garder `GET /api/v1/groups`
- garder `POST /api/v1/groups/auto/generate`
- garder `GET /api/v1/groups/:groupId/explain`
- ne plus exposer la création manuelle comme contrat client final
- lors de matérialisation : écrire `talk_groups` + renseigner `talk_group_id`

### 3.2 Fichier à modifier

`services/smart-groups/src/api/adminRouter.ts`

**Action**

Sur accept :

- créer un vrai `talk_group`
- créer le membre owner
- créer/assurer la conversation de groupe
- renseigner `smart_groups.talk_group_id`
- garder audit + outbox

### 3.3 Fichier à modifier

`services/smart-groups/src/workers/trendIngestWorker.ts`

**Action**

Quand `shouldAutoCreate(score)` est vrai :

- créer `smart_group`
- créer aussi le `talk_group` canonique
- renseigner le bridge `talk_group_id`

### 3.4 Fichier à modifier

`services/smart-groups/src/workers/outboxProducer.ts`

**Action**

Enrichir payload :

- `smart_group_id`
- `talk_group_id` si présent

### 3.5 Fichier à modifier

`services/smart-groups/src/lib/metrics.ts`

**Action**

Ajouter métriques de matérialisation runtime :

- total materialized
- failures
- latency materialization

### 3.6 Fichier à modifier

`services/smart-groups/package.json`

**Action**

Conserver service autonome et compléter scripts CI/intégration pour point d’entrée standardisé des tests.

---

## Phase 4 — Retrait de la duplication social-graph

### Fichiers à modifier

- `services/social-graph/src/controllers/groups.ts`
- `services/social-graph/src/server.ts`
- `services/social-graph/openapi.yaml`
- `services/social-graph/tests/groups.spec.ts`
- `services/social-graph/tests/unit/groups.unit.spec.ts`

### Action

Retirer groups de social-graph comme runtime métier :

- supprimer routes groups du serveur Fastify
- retirer handlers groups du périmètre
- mettre à jour OpenAPI
- remplacer tests Groups par tests non-régression sur follows/blocks/reports/lists

### Raison

social-graph doit rester propriétaire du graphe social ; son auth actuelle n’est pas adaptée au runtime groupe final.

---

## Phase 5 — Frontend Groups réel

### 5.1 Fichier à modifier

`molam-front/src/molam-talk/api/talkApi.js`

**Action**

Séparer explicitement discovery et runtime.

Discovery (`resolveSmartGroupsBaseUrl()`) :

- `getDiscoverGroups`
- `explainDiscoverGroup`
- `autoGenerateDiscoverGroups`

Runtime (`resolveTalkBaseUrl() + /api/v1/talk-groups`) :

- `getMyTalkGroups`
- `getPublicTalkGroups`
- `createTalkGroup`
- `getTalkGroup`
- `joinTalkGroup`
- `leaveTalkGroup`
- `updateTalkGroup`
- `getTalkGroupMembers`

### 5.2 Fichier à modifier

`molam-front/src/molam-talk/screens/TalkGroupsScreen.jsx`

**Action**

En faire la surface produit réelle :

- supprimer `demoGroups` du runtime prod
- `discover` charge smart-groups
- `mine` charge memberships talk-groups
- `create` poste talk-groups
- `Rejoindre` appelle `joinTalkGroup`
- `Voir` navigue vers `TalkGroupDetail`
- ajouter CTA `explain` sur cartes discovery
- passer recherche/filtres côté API
- brancher les libellés sur la locale
- conserver palette verte Molam + neutres

### 5.3 Nouveau fichier

`molam-front/src/molam-talk/screens/TalkGroupDetailScreen.jsx`

**Action**

Créer la vue détail :

- résumé + description
- état membership
- CTA join/leave
- compteur membres
- liste/aperçu membres
- lien conversation via `conversation_id`
- section settings/admin selon rôle
- section discovery explain si groupe matérialisé depuis smart-group

### 5.4 Fichier à modifier

`molam-front/src/molam-talk/navigation/TalkNavigator.jsx`

**Action**

Ajouter `TalkGroupDetail`.

### 5.5 Fichier à modifier

`molam-front/src/molam-talk/hooks/useTalkLocalePreferences.js`

**Action**

Le conserver comme source unique de préférence locale pour `TalkGroupsScreen` et `TalkGroupDetailScreen`.

### 5.6 Fichier à modifier

`molam-front/src/molam-talk/screens/TalkHomeScreen.jsx`

**Action**

Conserver l’entrée “Groupes” et ajouter le deep-link vers un groupe précis si nécessaire, sans changer palette/structure du Home.

---

## Notes d’exécution

- Approche strictement **forward-only migrations**.
- Éviter toute réintroduction de duplication `groups` vs `talk_groups`.
- Commencer par les migrations canoniques puis cutover API runtime, ensuite discovery bridge, puis front.
- Décommission du legacy en fin de parcours après validation de non-régression.
