# Fonctionnalité Groups améliorée — Plan industriel (discovery ↔ runtime)

Ce document consolide la trajectoire canonique du repo après audit:

- **runtime final**: `talk_groups` + `talk_group_members` + `conversations` + `conversation_memberships`
- **discovery**: `smart_groups`
- **bridge obligatoire**: `smart_groups.talk_group_id`

L’objectif est d’éliminer définitivement la fracture observée entre groupes “discovery” et groupes réellement joignables au runtime.

---

## 1) Pourquoi cette suite est plus solide

### 1.1 Elle corrige la fracture centrale visible dans le repo
Le problème n’est pas théorique: des flux créent des `smart_groups` sans matérialiser automatiquement un groupe runtime rejoignable. Or le runtime réel est `talk_groups`.

### 1.2 Elle ne crée pas un 4e domaine
On reste strictement sur des objets déjà présents:

- `smart_groups`
- `talk_groups`
- `talk_group_members`
- `conversations`
- `conversation_memberships`

### 1.3 Elle reste transactionnelle
Les flux critiques doivent rester sous `BEGIN / COMMIT / ROLLBACK` via `db.getClient()` (pattern déjà en place).

### 1.4 Elle conserve les briques industrielles existantes
Aucune suppression des composants existants:

- `authorize(...)`
- `writeAudit(...)`
- `smart_groups_outbox`
- Kafka best-effort

On enrichit les payloads avec `talk_group_id` et `conversation_id` pour la traçabilité.

### 1.5 Elle respecte l’audit
La jonction cible est explicite:

- `smart-groups` = discovery
- `talk_groups` = runtime groupe final

---

## 2) Vérités garanties après cette étape

Après implémentation complète:

- un groupe créé via `services/smart-groups/src/api/groupsRouter.ts` existe aussi en `talk_groups`
- un groupe auto-généré par worker existe aussi en `talk_groups`
- un candidat accepté via `adminRouter.ts` existe aussi en `talk_groups`
- `smart_group` porte `talk_group_id`
- la conversation de groupe existe
- l’owner est membre du groupe runtime
- l’owner est membre de la conversation runtime

---

## 3) Recentrage social-graph (suppression de duplication Groups)

### 3.1 Cible
Supprimer toute création/modification locale de groupes dans `services/social-graph`; ne conserver que le graphe social pur.

### 3.2 API groups côté social-graph
Le routeur groups côté social-graph doit uniquement:

- lire l’appartenance runtime via `talk_group_members` + `talk_groups`
- calculer followers/followees à partir des membres du groupe
- ne jamais créer/modifier un groupe local social-graph

### 3.3 Données conservées côté social-graph
Conserver uniquement le domaine graphe social (ex. `social_edges`, followers/followees, etc.).

---

## 4) Refactor API runtime canonique (talk)

### 4.1 `services/molam-talk-core/src/api/talkApi.js`
Refactor en routeur fin et stable, déléguant la logique métier aux services:

- `createTalkGroup`
- `listTalkGroups`
- `getTalkGroupDetail`
- `joinTalkGroup`
- `leaveTalkGroup`

Objectif: compat front maintenue (`/api/v1/talk-groups`) + logique transactionnelle dans services.

### 4.2 Front runtime canonique
`TalkGroupsScreen` et `TalkGroupDetailScreen` doivent consommer uniquement les endpoints runtime/discovery refactorés:

- fetch/list runtime
- join/leave runtime
- détail groupe runtime
- navigation vers détail

---

## 5) Suite de tests à verrouiller

### 5.1 Backend `molam-talk-core`
Refondre la couverture pour arrêter de tester l’ancien domaine groups comme vérité runtime.

Fichiers cibles:

- `tests/api/talkGroupsRouter.test.ts` (nouveau)
- `tests/groups.int.test.ts` (refonte)
- `tests/groups.e2e.test.ts` (refonte)

Points à garantir:

- création runtime canonique
- présence membership owner
- conversation synchronisée
- join/leave cohérents

### 5.2 `services/smart-groups`
Ajouter/refondre le test d’intégration pour valider le bridge discovery → runtime:

- création manuelle: `smart_group` + `talk_group` + conversation + membership owner
- auto-génération: bridge runtime matérialisé
- accept admin: runtime matérialisé
- outbox conservée

### 5.3 Front `molam-front`
Ajouter les tests UI/API:

- `TalkGroupsScreen.test.jsx`
- `TalkGroupDetailScreen.test.jsx`
- `talkApi.groups.test.js`

Et ajouter scripts npm dédiés (`test`, `test:watch`, `test:groups`).

---

## 6) CI/CD et Helm alignés sur la topologie réelle

### 6.1 Workspace racine
Inclure `services/smart-groups` dans les workspaces racine.

### 6.2 Pipeline groups
La CI groups doit:

- arrêter d’utiliser `services/groups/**` et `helm/groups/**` comme runtime principal
- tester le runtime canonique talk-groups
- tester `services/smart-groups`
- tester `molam-front` groups
- builder/déployer le chart `charts/smart-groups`

### 6.3 Chart smart-groups
Le chart actif doit injecter les dépendances runtime réelles (pas uniquement `DATABASE_URL`):

- Kafka (`KAFKA_BROKERS`, `KAFKA_TOPIC`)
- FATIMA (`FATIMA_URL`, `FATIMA_API_KEY`)
- OPA (`OPA_URL`, `OPA_DISABLED`, `OPA_FAIL_OPEN`)
- thresholds/worker config (`AUTO_CREATE_THRESHOLD`, `CANDIDATE_MIN_SCORE`, `INTERVAL_MS`, etc.)
- identité/contexte (`SYSTEM_USER_ID`, `LEGAL_ENTITY`, `LOCALES`, `REGION`)

### 6.4 Retrait de `helm/groups` de la pipeline active
Le chart legacy `helm/groups` doit être retiré de la chaîne active CI/CD (plus de build/deploy actif lié à cet ancien runtime).

---

## 7) Résultat final attendu

Après exécution complète:

- `services/smart-groups` est un composant monorepo pleinement branché CI
- la CI valide le vrai runtime (`talk_groups`) + le bridge discovery (`smart_groups`)
- le front consomme la séparation canonique:
  - discovery: `/api/v1/groups`
  - runtime: `/api/v1/talk-groups`
- plus de duplication active de domaine groups
- plus de faux runtime maintenu “par inertie” dans CI/Helm

---

## 8) Notes d’implémentation

- migrations strictement **forward-only**
- pas de création d’un nouveau domaine produit
- transactionnalité systématique sur flux critiques
- maintien audit/outbox/autorisation
- décommission legacy uniquement après non-régression validée
