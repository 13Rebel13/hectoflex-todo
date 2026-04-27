# Push setup (Cloudflare Worker + D1)

## 1) D1 SQL

```sql
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id TEXT PRIMARY KEY,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_id TEXT,
  user_name TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_push_user_id ON push_subscriptions(user_id);
```

## 2) Worker routes utilisées
- `POST /push/subscribe` (public app, avec auth bearer déjà utilisée)
- `POST /push/unsubscribe`
- `GET /push/subscriptions` (admin; protège avec `PUSH_ADMIN_KEY`)

## 3) Variables Worker
- `PUSH_ADMIN_KEY` (recommandé)
- D1 binding: `HF_DB` (ou `DB` / `HF_D1` / `HECTOFLEX_DB`)

## 4) Test rapide
```bash
curl -H "Authorization: Bearer <token>" \
  "https://hf-tasks-api.hectoflex.workers.dev/push/subscriptions" \
  -H "x-api-key: <PUSH_ADMIN_KEY>"
```

## 5) Envoi push serveur
Le Worker stocke les subscriptions en D1.
Pour l'envoi Web Push (chiffrement VAPID), faire l'envoi depuis n8n/Node (web-push),
en lisant `GET /push/subscriptions`.
