# Smart Groups

Service de discovery, auto-génération et explication des groupes Molam Talk, avec matérialisation explicite du runtime canonique `talk_groups`.

## Rôle exact du service

`services/smart-groups` n’est pas le runtime final de membership utilisateur.  
Son rôle est de gérer :

- les trending topics FATIMA
- les groupes discovery (`smart_groups`)
- les candidats (`group_candidates`)
- l’explication (`/explain`)
- l’admin review
- l’outbox Kafka
- la **matérialisation runtime** vers `talk_groups`

Le runtime canonique utilisateur final reste :
- `talk_groups`
- `talk_group_members`
- `conversations`
- `conversation_memberships`

---

## Topologie

```text
FATIMA
  └──> services/smart-groups
         ├── group_topics
         ├── group_candidates
         ├── smart_groups
         ├── smart_groups_outbox
         ├── explain
         ├── admin review
         └── materialisation runtime
                └──> talk_groups
                └──> talk_group_members
                └──> conversations
                └──> conversation_memberships
________________________________________
Composants
API REST
Fichiers :
•	src/api/groupsRouter.ts 
•	src/api/adminRouter.ts 
Responsabilités :
•	création discovery manuelle 
•	auto-generation 
•	explain 
•	listing discovery 
•	admin accept / reject 
•	stats 
•	replay outbox 
Runtime materializer
Fichier :
•	src/lib/talkGroupRuntime.ts 
Responsabilités :
•	création ou garantie du talk_group canonique 
•	création ou garantie de la conversation runtime 
•	création ou garantie du membership owner 
•	écriture du bridge smart_groups.talk_group_id 
Workers
•	src/workers/trendIngestWorker.ts 
•	src/workers/outboxProducer.ts 
Responsabilités :
•	ingestion FATIMA 
•	création candidats 
•	auto-create 
•	publication Kafka 
•	gestion outbox transactionnelle 
________________________________________
Schéma de données
Discovery
•	group_topics 
•	group_candidates 
•	smart_groups 
•	smart_groups_outbox 
Bridge runtime
•	smart_groups.talk_group_id 
Runtime matérialisé
•	talk_groups 
•	talk_group_members 
•	conversations 
•	conversation_memberships 
________________________________________
API
Public
POST /api/v1/groups
Crée un smart_group, puis matérialise le runtime canonique talk_group.
Réponse :
•	smart_group créé 
•	talk_group_id 
•	conversation_id 
POST /api/v1/groups/auto/generate
Interroge FATIMA, crée les candidats, auto-crée les groupes au-dessus du threshold et matérialise les talk_groups.
GET /api/v1/groups/:groupId/explain
Retourne :
•	explanation 
•	score 
•	talk_group_id 
GET /api/v1/groups
Liste les groupes discovery avec leur talk_group_id quand ils ont été matérialisés.
Admin
POST /api/v1/admin/candidates/:id/accept
Crée le smart_group, marque le candidat accepté et matérialise le runtime canonique.
POST /api/v1/admin/candidates/:id/reject
Rejette un candidat.
GET /api/v1/admin/candidates
Liste des candidats.
GET /api/v1/admin/stats
Stats globales.
POST /api/v1/admin/replay
Replay outbox non traité.
________________________________________
Variables d’environnement
Base de données
•	DATABASE_URL 
Kafka
•	KAFKA_BROKERS 
•	KAFKA_TOPIC 
FATIMA
•	FATIMA_URL 
•	FATIMA_API_KEY 
Auth / Molam ID
•	MOLAM_ID_SERVICE_URL 
•	TEST_AUTH_TOKEN 
OPA
•	OPA_URL 
•	OPA_DISABLED 
•	OPA_FAIL_OPEN 
Discovery policy
•	AUTO_CREATE_THRESHOLD 
•	CANDIDATE_MIN_SCORE 
Workers
•	LOCALES 
•	REGION 
•	INTERVAL_MS 
•	POLL_INTERVAL_MS 
•	BATCH_SIZE 
System
•	SYSTEM_USER_ID 
•	LEGAL_ENTITY 
•	PORT 
•	NODE_ENV 
________________________________________
Déploiement
Le chart actif pour ce service est :
•	charts/smart-groups 
Le chart historique helm/groups n’est pas la source de vérité pour ce service et n’est plus la pipeline active.
________________________________________
Tests
•	tests/groups.int.test.ts 
Ce fichier vérifie :
•	création discovery manuelle 
•	auto-generation 
•	explain 
•	admin accept 
•	bridge smart_groups -> talk_groups 
•	conversation matérialisée 
•	owner membership runtime 
________________________________________
Résumé
•	smart-groups = discovery + intelligence + explain + admin review + bridge runtime 
•	talk_groups = runtime canonique 
•	social-graph = graphe social pur 

Le README actuel du service décrit bien FATIMA, outbox et candidats, mais ne formalise pas assez clairement que `smart-groups` n’est pas le runtime final et doit matérialiser `talk_groups`. :contentReference[oaicite:9]{index=9}
