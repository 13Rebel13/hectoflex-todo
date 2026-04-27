# PROJECT-ACCESS.md — hectoflex-todo

Dernière mise à jour: 2026-04-23 17:24 UTC

## 1) Objectif du projet
- Résumé: PROJECT-ACCESS.md — hectoflex-todo
- Priorité: haute
- Statut: À structurer

## 2) Localisation
- Dossier: `projects/hectoflex-todo`
- Repo Git (origin): `git@github-hectoflex-todo:13Rebel13/hectoflex-todo.git`
- URL prod/staging (détectées):
- https://fonts.googleapis.com
- https://fonts.gstatic.com
- https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap
- https://cdn.jsdelivr.net/npm/qrcode/build/qrcode.min.js
- https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js
- https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js
- https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js
- https://example.com

## 3) Accès & credentials (références)
> Ne pas mettre les secrets en clair ici. Référencer uniquement les emplacements.

### Références globales
- `private/cloudflare.json`
- `private/credentials.md`
- `private/vercel.json`
- `TOOLS.md`
- `MEMORY.md`
- `docs/PROJECT-ACCESS-INDEX.md`
- `PROJECT-ACCESS.md` (local projet)

### Références techniques projet
- Voir aussi les docs du projet listées en section 5.

## 4) Procédures clés
### Déploiement / setup (fichiers détectés)
- À compléter

### Vérification post-déploiement
- Vérifier URL publique principale du projet.
- Vérifier la fonctionnalité critique (login/API/page clé) selon le projet.
- Noter la preuve (commande/screenshot) dans `memory/YYYY-MM-DD.md`.

### Rollback
- Revenir au dernier commit stable.
- Redéployer selon la procédure ci-dessus.
- Noter l’incident dans `docs/RUNBOOK.md` si impact prod.

## 5) Fichiers de référence dans ce projet
- `PROJECT-ACCESS.md`

## 6) Règles anti-régression
- Toujours tester avant/après modification.
- Documenter tout nouvel accès/procédure ici immédiatement.
- Si une procédure est exécutée 2 fois, la formaliser ici.
- Avant de dire "pas d’accès/impossible": rechercher dans les docs projet + `private/*` + `TOOLS.md`.

## 7) Historique rapide (journal projet)
- [2026-04-23] Structuration initiale complète de la fiche accès projet.
