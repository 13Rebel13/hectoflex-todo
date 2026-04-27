# Push setup (Vercel)

## 1) SQL Supabase

```sql
create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id text null,
  user_name text null,
  endpoint text unique not null,
  p256dh text not null,
  auth text not null,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
```

## 2) Env vars (Vercel)
- SUPABASE_URL
- SUPABASE_SERVICE_ROLE_KEY
- VAPID_PUBLIC_KEY
- VAPID_PRIVATE_KEY
- VAPID_SUBJECT=mailto:info@hectoflex.ch
- PUSH_ADMIN_KEY=choose-a-secret

## 3) Test
- Open app and click 🔔 Notifications
- In backend test send:
```bash
curl -X POST https://<your-vercel-domain>/api/push/send \
  -H "Content-Type: application/json" \
  -H "x-api-key: <PUSH_ADMIN_KEY>" \
  -d '{"title":"Test HectoFlex","body":"Notification OK"}'
```
