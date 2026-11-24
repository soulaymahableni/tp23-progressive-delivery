# TP23 : réponses

> Résultats obtenus sur ma VM de lab (K3s v1.36, Argo Rollouts v1.10.2, Prometheus kps du TP21) le 24/11/2026.

## Comparaison des stratégies

| Stratégie | Principe | Risque | Coût | Retour arrière |
|---|---|---|---|---|
| Rolling update (Deployment) | les Pods sont remplacés progressivement | **élevé** : la nouvelle version reçoit tout le trafic dès que ses probes passent, même si elle renvoie des erreurs | faible | lent (`rollout undo` recrée les Pods) |
| Blue/Green | deux versions complètes ; le Service bascule en une fois | moyen : 100 % du trafic bascule d'un coup, mais on a pu tester la preview | ×2 ressources pendant la bascule | **instantané** tant que l'ancienne version tourne |
| Canary | une petite part du trafic va vers la nouvelle version, puis la part augmente | **faible** : seule une fraction des utilisateurs est exposée, et l'analyse décide | faible | rapide (abort) ou **automatique** avec analyse |

## Partie 2 : Blue/Green

- Le Rollout se met en pause (`BlueGreenPause`) : `demo-preview` cible **green** (revision 2) et `demo-active` reste sur **blue** (revision 1).
- `promote` : green devient `stable,active`, et blue passe en `delay:60s`.
- `undo` **dans les 60 s** : retour instantané. Aucun nouveau Pod n'est créé, seule l'étiquette `stable,active` change de ReplicaSet.
- `undo` **après les 60 s** (premier essai) : les Pods blue avaient été supprimés et Argo les a recréés (`ContainerCreating`, `active service cutover pending`). Le retour prend alors 20 à 30 s.

**Pourquoi le retour est-il immédiat pendant 60 s ?** Avec `scaleDownDelaySeconds: 60`, l'ancien ReplicaSet reste démarré 60 s après la bascule. Revenir en arrière consiste seulement à **modifier le sélecteur du Service `demo-active`**, qui pointe à nouveau sur les Pods déjà prêts. Il n'y a aucun Pod à démarrer et aucune probe à attendre.

> Note : le plugin installé (v1.10.2) ne propose que `set image`. Le changement d'`APP_VERSION` s'est donc fait en modifiant le manifest puis `kubectl apply`, comme le permet l'énoncé.

## Partie 3 : Canary

Paliers 10 / 25 / 50 / 100 % avec 10 replicas. Observé à 25 % : `Step 3/7`, `SetWeight 25`, **`ActualWeight 27`**, avec 3 Pods canary sur 11 au total. Sans routeur de trafic, le pourcentage est **approché par le nombre de Pods**. L'âge des Pods d'un canary terminé montre les vagues : 1 Pod, puis +2, +2, +5.

**`abort` pendant une pause : que devient le trafic ?** Les Pods canary sont supprimés (`ScaledDown`) et la version stable remonte à 10 Pods. **100 % du trafic revient sur la version stable** (`ActualWeight 0`). Le Rollout passe en `✖ Degraded`. `retry` relance le canary depuis le premier palier, et `promote --full` le termine en sautant les pauses.

## Partie 4 : Analyse automatique et rollback

**AnalysisTemplate `error-rate`** : taux de réponses 5xx des **seuls Pods canary**, sur 1 minute, avec `successCondition: result[0] < 0.05`, une mesure toutes les 30 s, et `failureLimit: 1`.
- Le `ServiceMonitor` utilise `podTargetLabels: [rollouts-pod-template-hash]` : chaque métrique porte le hash de sa version, et l'analyse mesure la nouvelle version seule (`podTemplateHashValue: Latest`).
- `... or vector(0)` et `> 0` évitent un résultat NaN, donc un échec, quand aucune donnée n'existe encore.

**Requête testée dans Prometheus avant usage** sur la version stable `75b647f986` : **0,0084**, soit 0,84 % d'erreurs, inférieur à 0,05. Sans données (hash inexistant), le résultat est 0 grâce à `or vector(0)`.

**Version défaillante** (`APP_VERSION=v3`, `ERROR_RATE=0.5`) :
- AnalysisRun `demo-8474ff8d97-5` → **Failed** : `Metric "error-rate" assessed Failed due to failed (2) > failureLimit (1)`. Mesures : **0,556** à 19:56:48Z puis **0,456** à 19:57:18Z (Failed / Failed) ;
- **rollback automatique** : la revision 5 (v3) passe en `ScaledDown`, la revision 4 reste `stable` avec 10 Pods, et le Rollout est **Degraded** ;
- Grafana : la courbe d'erreurs de `8474ff8d97` monte vers **55 %** et ne dure qu'**environ 1 minute** ;
- **requêtes affectées** : `sum(increase(...{rollouts_pod_template_hash="8474ff8d97", status_code=~"5.."}[30m]))` donne **environ 25 requêtes en erreur**.

**Avec un Deployment classique** : les probes de v3 passent, donc le rolling update va jusqu'au bout. **100 % du trafic** est servi par v3, soit environ **50 % d'erreurs pour tous les utilisateurs**. Avec environ 10 requêtes par seconde, cela fait environ **300 erreurs par minute**, jusqu'à ce qu'un humain détecte le problème et lance `kubectl rollout undo`. Ici, le canary et l'analyse ont limité l'exposition à environ 10 % du trafic pendant environ 1 minute, **sans intervention humaine**.

## Partie 5 : Feature Flags (OpenFeature + flagd)

> Le port 3001 étant déjà utilisé par mon portfolio (TP1), l'application est exposée sur **3011**.

| Configuration de `flags.json` | alice | bob, charlie | Reason |
|---|---|---|---|
| `defaultVariant: off`, sans règle | off | off | STATIC |
| `defaultVariant: on` | on | on | STATIC |
| `targeting` : `if targetingKey == "alice"` | **on** | **off** | TARGETING_MATCH |
| `fractional [on 20, off 80]` | ~20 % des utilisateurs en `on` | | TARGETING_MATCH |

- **Aucun redémarrage** : flagd surveille le fichier et recharge les flags, et l'application voit le changement en quelques secondes.
- **`fractional` est stable** : `user7` obtient `off` à chaque requête. flagd calcule un hash de `flagKey + targetingKey`, donc un utilisateur reste toujours dans le même groupe. Il n'y a pas d'expérience qui clignote, et l'A/B test reste cohérent.

**Déploiement ou release ?**
- **Déploiement** (technique, Argo Rollouts) : mettre le **nouveau code** en production, en toute sécurité (canary, analyse, rollback).
- **Release** (fonctionnelle, Feature Flags) : décider **qui voit la fonctionnalité, et quand**. Le code est déjà déployé, mais désactivé.

On peut donc déployer souvent, même du code inachevé caché derrière un flag (*trunk-based development*), et activer la fonctionnalité plus tard, progressivement, ou la couper en une seconde sans redéployer (*kill switch*).

**Quelle dette technique les flags créent-ils, et comment l'éviter ?** Chaque flag ajoute un `if` dans le code, donc **deux chemins à maintenir et à tester**. Les flags oubliés s'accumulent : code mort, combinaisons impossibles à tester, risque d'activer par erreur un vieux code. Pour l'éviter :
- donner à chaque flag un **propriétaire et une date d'expiration** ;
- **supprimer le flag et l'ancien code** dès que la fonctionnalité est à 100 % (ticket créé en même temps que le flag) ;
- distinguer les flags **temporaires** (release, expérience) des flags **permanents** (kill switch, permissions) ;
- **lister et surveiller** les flags (revue régulière, alerte sur les flags plus vieux que N semaines) ;
- **versionner les flags dans Git** (ConfigMap en GitOps, défi du TP19) pour garder l'historique et la revue.
