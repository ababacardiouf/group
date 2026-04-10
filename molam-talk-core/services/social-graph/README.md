# Social Graph

Service de graphe social pur de Molam Talk.

## Rôle exact du service

`services/social-graph` est recentré sur les relations sociales, et non sur le runtime canonique des groupes.

Le service gère :
- follow
- unfollow
- block
- unblock
- lists
- followers / following
- audit et permissions sociales

Le runtime canonique des groupes n’est pas ici.  
Il est porté par :
- `talk_groups`
- `talk_group_members`
- `conversations`
- `conversation_memberships`

La discovery des groupes est portée par :
- `services/smart-groups`

---

## Responsabilités

### Graphe social
- suivre / ne plus suivre
- bloquer / débloquer
- listes d’utilisateurs
- lectures agrégées followers / following

### Ce qui n’est pas ici
- création runtime des groupes
- join / leave runtime des groupes
- source de vérité des memberships groups
- discovery FATIMA
- bridge `smart_groups -> talk_groups`

---

## Position dans l’architecture

```text
Molam Front
  ├── runtime groups ----------> API principale / talk_groups
  ├── discovery --------------> services/smart-groups
  └── social graph -----------> services/social-graph
                                   - follow
                                   - block
                                   - lists
                                   - graph reads
________________________________________
API
Le service expose uniquement des endpoints de graphe social.
Les endpoints groups historiques ou dupliqués ne doivent plus être traités comme runtime canonique.
________________________________________
Schéma
Le service est propriétaire des structures de graphe social, et non des tables runtime Groups.
________________________________________
Tests
Les tests de ce service doivent couvrir :
•	follow / unfollow 
•	block / unblock 
•	lists 
•	reads followers / following 
Ils ne doivent plus faire de services/social-graph une vérité métier concurrente pour les groupes.
________________________________________
Résumé
•	services/social-graph = graphe social pur 
•	talk_groups = runtime canonique groups 
•	services/smart-groups = discovery + explain + bridge runtime 

Le README actuel de `social-graph` va déjà dans cette direction, mais il est trop incomplet et ne mentionne pas explicitement la nouvelle frontière avec `talk_groups` et `smart-groups`. :contentReference[oaicite:10]{index=10}
