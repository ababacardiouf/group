# Molam Talk Core

Plateforme backend de Molam Talk pour le messaging, les conversations, le feed, le live, le social graph, les profils, le commerce social et les groupes.

## Topologie réelle du domaine Groups

Le domaine Groups est organisé autour de **deux couches complémentaires** et **une frontière de responsabilité claire** :

### 1. Runtime canonique utilisateur final
Le runtime canonique des groupes est porté par :

- `talk_groups`
- `talk_group_members`
- `conversations`
- `conversation_memberships`

Ce runtime est exposé par l’API principale via `src/api/talkGroupsRouter.ts`.

C’est la **source de vérité** pour :
- création de groupe utilisateur final
- lecture détail groupe
- join / leave
- membership owner / member
- conversation de groupe
- `member_count`

### 2. Discovery et génération intelligente
La discovery et la génération intelligente sont portées par `services/smart-groups`.

Ce service gère :
- `group_topics`
- `group_candidates`
- `smart_groups`
- `smart_groups_outbox`
- auto-génération FATIMA
- acceptation/rejet admin
- explication d’un groupe suggéré
- bridge `smart_groups -> talk_groups`

`smart-groups` ne porte **pas** le runtime final de membership utilisateur ; il matérialise le runtime canonique en `talk_groups`.

### 3. Social graph pur
`services/social-graph` ne porte pas le runtime canonique des groupes.  
Ce service est recentré sur :
- follow / unfollow
- block / unblock
- lists
- relations sociales
- audit et permissions du graphe social

Les groupes n’y sont plus une source de vérité métier indépendante.

---

## Architecture de haut niveau

```text
Molam Front
   |
   |-- discovery groups --------------------------> services/smart-groups
   |                                                 - FATIMA trending
   |                                                 - explain
   |                                                 - admin candidates
   |                                                 - smart_groups
   |                                                 - smart_groups_outbox
   |                                                 - materialisation talk_groups
   |
   |-- runtime groups ----------------------------> API principale (src/app.ts)
   |                                                 - talkGroupsRouter
   |                                                 - talk_groups
   |                                                 - talk_group_members
   |                                                 - conversations
   |                                                 - conversation_memberships
   |
   |-- social relationships ----------------------> services/social-graph
                                                     - follow
                                                     - block
                                                     - lists
                                                     - graph reads
________________________________________
Services réellement utilisés
API principale
Port par défaut : 3100
L’API principale monte notamment :
•	src/api/talkGroupsRouter.ts → runtime canonique Groups 
•	src/api/conversationsRouter.ts 
•	src/api/messagesRouter.ts 
•	src/api/socialGraphRouter.ts 
•	src/api/notificationsRouter.ts 
•	src/api/talkPostsRouter.ts 
•	autres briques Molam Talk 
services/smart-groups
Port par défaut : 3006
Rôle :
•	discovery 
•	auto-generation 
•	candidate review 
•	explain 
•	outbox Kafka 
•	bridge vers talk_groups 
services/social-graph
Port par défaut : 3010
Rôle :
•	graphe social pur 
•	follow / unfollow 
•	followers / following 
•	block / unblock 
•	lists 
•	audit et permissions sociales 
________________________________________
Structure de projet pertinente pour Groups
molam-talk-core/
├── src/
│   ├── api/
│   │   ├── talkGroupsRouter.ts        # Runtime canonique groups
│   │   └── ...
│   ├── services/
│   │   └── talkGroupService.ts        # Service métier runtime groups
│   ├── lib/
│   │   └── db.ts
│   └── app.ts
├── migrations/
│   ├── 016_create_lists_groups.sql
│   ├── 200_conversations.sql
│   ├── 20260304001_social_graph_schema_reconcile.sql
│   ├── 20260407001_talk_groups_canonical.sql
│   ├── 20260407002_talk_group_members_canonical.sql
│   ├── 20260407003_conversation_memberships.sql
│   ├── 20260407004_talk_group_capabilities.sql
│   └── 20260407005_smart_groups_bridge.sql
├── services/
│   ├── smart-groups/
│   │   ├── src/
│   │   │   ├── api/
│   │   │   │   ├── groupsRouter.ts
│   │   │   │   └── adminRouter.ts
│   │   │   ├── workers/
│   │   │   │   ├── trendIngestWorker.ts
│   │   │   │   └── outboxProducer.ts
│   │   │   ├── lib/
│   │   │   │   ├── talkGroupRuntime.ts
│   │   │   │   ├── fatimaClient.ts
│   │   │   │   ├── kafka.ts
│   │   │   │   ├── metrics.ts
│   │   │   │   └── audit.ts
│   │   ├── tests/
│   │   │   └── groups.int.test.ts
│   │   └── README.md
│   └── social-graph/
│       └── README.md
├── tests/
│   ├── api/
│   │   └── talkGroupsRouter.test.ts
│   ├── groups.int.test.ts
│   └── groups.e2e.test.ts
├── charts/
│   └── smart-groups/
└── .github/
    └── groups-ci.yml
________________________________________
Endpoints Groups
Runtime canonique (talk_groups)
POST /api/v1/talk-groups
Créer un groupe runtime utilisateur final.
GET /api/v1/talk-groups
Lister les groupes runtime.
Supporte mine=true.
GET /api/v1/talk-groups/:id
Lire le détail d’un groupe runtime.
POST /api/v1/talk-groups/:id/join
Rejoindre un groupe runtime.
POST /api/v1/talk-groups/:id/leave
Quitter un groupe runtime.
________________________________________
Discovery (services/smart-groups)
POST /api/v1/groups
Créer un groupe discovery et matérialiser le runtime talk_groups.
POST /api/v1/groups/auto/generate
Lancer une auto-génération depuis FATIMA avec matérialisation runtime.
GET /api/v1/groups/:groupId/explain
Expliquer pourquoi un groupe discovery a été suggéré.
GET /api/v1/groups
Lister les groupes discovery avec leur bridge runtime (talk_group_id).
Admin
•	POST /api/v1/admin/candidates/:id/accept 
•	POST /api/v1/admin/candidates/:id/reject 
•	GET /api/v1/admin/candidates 
•	GET /api/v1/admin/stats 
•	POST /api/v1/admin/replay 
________________________________________
Migrations Groups
Les migrations Groups désormais pertinentes sont :
•	016_create_lists_groups.sql 
•	200_conversations.sql 
•	20260304001_social_graph_schema_reconcile.sql 
•	20260407001_talk_groups_canonical.sql 
•	20260407002_talk_group_members_canonical.sql 
•	20260407003_conversation_memberships.sql 
•	20260407004_talk_group_capabilities.sql 
•	20260407005_smart_groups_bridge.sql 
Les anciennes migrations du domaine groups / group_memberships / group_messages restent présentes pour l’historique, mais ne définissent plus le runtime principal Groups.
________________________________________
Tests
Runtime canonique
•	tests/api/talkGroupsRouter.test.ts 
•	tests/groups.int.test.ts 
•	tests/groups.e2e.test.ts 
Discovery + bridge runtime
•	services/smart-groups/tests/groups.int.test.ts 
Front Groups
Dans molam-front :
•	src/molam-talk/screens/__tests__/TalkGroupsScreen.test.jsx 
•	src/molam-talk/screens/__tests__/TalkGroupDetailScreen.test.jsx 
•	src/molam-talk/api/__tests__/talkApi.groups.test.js 
________________________________________
CI et déploiement
La CI groups-ci.yml est alignée sur la topologie réelle :
•	runtime canonique talk_groups 
•	service smart-groups 
•	front Molam Groups 
•	chart charts/smart-groups 
Le dossier helm/groups n’est plus la source de vérité pour le runtime principal Groups et ne doit plus être utilisé comme pipeline active.
________________________________________
Workspaces
Le monorepo inclut services/smart-groups dans les workspaces NPM.
Cela est obligatoire pour que :
•	build 
•	test 
•	lint 
•	type-check 
•	CI 
reflètent la vraie topologie d’exécution.
________________________________________
Démarrage rapide
Installation
npm install
npm install --workspaces
Migrations
npm run migrate
API principale
npm run start
Smart Groups
npm run dev:smart-groups
Workers Smart Groups
npm run worker:smart-groups:trends
npm run worker:smart-groups:outbox
Tests Groups
npx jest tests/api/talkGroupsRouter.test.ts --runInBand
npx jest tests/groups.int.test.ts --runInBand
npx jest tests/groups.e2e.test.ts --runInBand
npm run test -w services/smart-groups -- --runInBand
________________________________________
Résumé opérationnel
•	talk_groups = runtime canonique utilisateur final 
•	services/smart-groups = discovery + auto-generation + explain + bridge runtime 
•	services/social-graph = graphe social pur 
•	CI et charts = alignés sur talk_groups + smart-groups 

Ce remplacement est nécessaire parce que le README actuel parle surtout de profils/comptes/réplication et ne décrit pas la topologie réelle Groups qu’on a convergée ici. :contentReference[oaicite:8]{index=8}
