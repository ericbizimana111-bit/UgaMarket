# UgaMarket — Free deployment (Vercel + Render + Neon + Cloudinary)

Zero-cost launch setup. Every service below has a free plan; upgrade only when
traffic grows (see "Limits & when to upgrade").

| Part | Service (free plan) | URL you will get |
|---|---|---|
| Customer shop (React) | **Vercel** | `https://ugamarket.vercel.app` |
| Admin console (React) | **Vercel** | `https://ugamarket-admin.vercel.app` |
| API (Node/Express) | **Render** web service, Frankfurt | `https://ugamarket-api.onrender.com` |
| Database (PostgreSQL) | **Neon**, Frankfurt (`aws-eu-central-1`) | — |
| Product photos | **Cloudinary** | `https://res.cloudinary.com/...` |
| Payments | Flutterwave (MTN MoMo + Airtel Money) | — |
| Keep-awake pinger | **cron-job.org** (or UptimeRobot) | — |

> **Why Neon and not Render's database?** Render's free PostgreSQL is
> **deleted 30 days after creation and has no backups**. Neon's free database
> does not expire. API (Render) and database (Neon) are both in Frankfurt, the
> closest free region to Uganda, so they talk to each other quickly.
>
> **Why Cloudinary is mandatory here:** Render's free disk is wiped on every
> restart and deploy. Photos are therefore stored on Cloudinary (served from
> its CDN as WebP/AVIF — light on mobile data). The API refuses to start on
> Render without `CLOUDINARY_URL`, so this cannot be forgotten.

Order matters: **database → photos → API → shop & admin → connect them.**

---

## 0. Push the code to GitHub

All three hosts deploy straight from GitHub and redeploy automatically on
every `git push` to `main`.

```bash
git add -A && git commit -m "Prepare free deployment" && git push origin main
```

## 1. Database — Neon

1. Sign up at **neon.com** → **Create project**.
   - Name: `ugamarket` · Postgres version: 17 · **Region: AWS Europe Central 1 (Frankfurt)**.
2. On the project dashboard click **Connect**:
   - Database: `neondb` (or create `ugamarket`).
   - **Turn "Connection pooling" OFF** (migrations need the direct connection).
   - Copy the connection string and add `&connection_limit=5` at the end:

   ```
   postgresql://neondb_owner:XXXX@ep-xxxx.eu-central-1.aws.neon.tech/neondb?sslmode=require&connection_limit=5
   ```

   This is your **`DATABASE_URL`**. Keep it private.

## 2. Photos — Cloudinary

1. Sign up at **cloudinary.com** (free, no card).
2. In the Cloudinary console open **API Keys** (under Settings) and copy the
   **API environment variable**: `cloudinary://<api_key>:<api_secret>@<cloud_name>`.
   This is your **`CLOUDINARY_URL`**.

## 3. API — Render

1. Sign up at **render.com** with GitHub.
2. **New → Blueprint** → select your UgaMarket repository. Render reads
   [`render.yaml`](../render.yaml) and creates `ugamarket-api` (free, Frankfurt).
3. It asks for the values marked secret. Fill them:

| Variable | Value |
|---|---|
| `DATABASE_URL` | from step 1 |
| `CLOUDINARY_URL` | from step 2 |
| `ADMIN_1_EMAIL` / `ADMIN_1_PASSWORD` | the **owner** (the only super admin) — password 10+ characters with letters and numbers |
| `ADMIN_2_EMAIL` / `ADMIN_2_PASSWORD` | a first regular admin (different email, same password rule) |
| `CORS_ORIGIN` | for now `https://ugamarket.vercel.app,https://ugamarket-admin.vercel.app` (fix in step 6 if Vercel gives other names) |
| `FRONTEND_URL` | `https://ugamarket.vercel.app` |
| `FLW_PUBLIC_KEY` / `FLW_SECRET_KEY` | Flutterwave dashboard → Settings → API keys (TEST keys first) |
| `GEO_CONTACT_EMAIL`, `MYMEMORY_EMAIL` | a real email address you read |

   `JWT_SECRET`, `ADMIN_JWT_SECRET` and `PAYMENT_WEBHOOK_SECRET` are generated
   for you.

4. **Apply**. Watch **Logs**. On this first start you will see:

   ```
   All migrations have been successfully applied.
   Empty database: running first-time seed...
   ✅ Product photos: 27 updated ...
   🚀 ... API running ... [production]
   ```

   The seed (admins, categories, sample products with photos, delivery
   pricing, home services) runs **only on the first start**; later restarts
   never reset what staff changed.

5. Copy the service URL (e.g. `https://ugamarket-api.onrender.com`) and check
   `https://ugamarket-api.onrender.com/api/health` shows `"status":"UP"`.

> If the API stops at start with **"Environment configuration validation
> failed"**, the log names the exact variable to fix (Render → service →
> Environment). Saving an environment change redeploys automatically.

## 4. Customer shop — Vercel

1. Sign up at **vercel.com** with GitHub → **Add New → Project** → import the repo.
2. **Project name:** `ugamarket` (this becomes `ugamarket.vercel.app`).
3. **Root Directory:** `frontend` (framework is detected: Create React App).
4. **Environment Variables:** `REACT_APP_API_URL` = `https://ugamarket-api.onrender.com/api`
5. **Deploy.** Page refreshes on deep links (e.g. `/account/orders`) work
   thanks to [`frontend/vercel.json`](../frontend/vercel.json).

## 5. Admin console — Vercel

Same as step 4, a second project from the same repository:

- **Project name:** `ugamarket-admin` · **Root Directory:** `admin` (Vite)
- **Environment Variables:** `VITE_API_URL` = `https://ugamarket-api.onrender.com/api`
- Deploy. The admin site is marked `noindex` so search engines do not list it.

> `REACT_APP_API_URL` / `VITE_API_URL` are baked in at build time. If you
> change them later, **redeploy** the Vercel project.

## 6. Connect them

If Vercel gave different names than above, set Render → `ugamarket-api` →
Environment:

- `CORS_ORIGIN` = `https://<shop>.vercel.app,https://<admin>.vercel.app` (exact, no trailing `/`)
- `FRONTEND_URL` = `https://<shop>.vercel.app`

Open the shop, sign up as a customer, add an address and an item to the cart;
open the admin console and sign in with `ADMIN_1_EMAIL`.

## 7. Keep the API awake (free)

Render's free API **sleeps after 15 minutes without traffic** and takes about a
minute to wake — the first customer would wait, and live notifications pause.
A free pinger prevents that:

- **cron-job.org** → Create cronjob → URL `https://ugamarket-api.onrender.com/api/ping`
  → every **10 minutes**.

`/api/ping` deliberately does **not** touch the database, so Neon can still
sleep when nobody is shopping (protecting its free compute hours). One service
running all month uses ~744 of Render's 750 free hours — don't run a second
free Render service.

## 8. Payments — Flutterwave webhook

Flutterwave → Settings → **Webhooks**:

- URL: `https://ugamarket-api.onrender.com/api/payments/webhook`
- Secret hash: copy the value of `PAYMENT_WEBHOOK_SECRET` from Render → Environment.

Test with Flutterwave TEST keys first. When Flutterwave approves your business,
switch Render's `PAYMENT_MODE` to `LIVE` and paste the **live** keys.

## 9. First-day checklist (admin console)

1. **Staff accounts** — add dispatchers.
2. **Storefront content** — support phone, WhatsApp, email, address, hours.
3. **Delivery & deposit** — pin your dispatch point, set tariff and deposit.
4. **Products** — review the sample catalogue: prices, stock, photos (hide what you don't sell).
5. Place one real test order end to end, check the staff notification and chat.

## 10. Backups (Neon free keeps only ~6 hours of history)

Take a backup at least weekly from your own computer (PostgreSQL 17 client
installed):

```bash
pg_dump "<your Neon DATABASE_URL without &connection_limit=5>" -Fc -f ugamarket-YYYY-MM-DD.dump
```

Keep copies in Google Drive or similar. Photos are already safe on Cloudinary.

---

## Limits & when to upgrade

| Free limit | What you'll notice | Upgrade |
|---|---|---|
| Render free: 512 MB RAM, sleeps without pinger, may restart any time | slow first load after idle; brief live-update reconnects | Render Starter (always on) |
| Neon free: 1 GB data, 100 compute-hours/month per project | writes blocked when storage is full | Neon Launch plan |
| Cloudinary free: 25 credits/month (1 credit = 1 GB storage **or** 1 GB bandwidth **or** 1,000 transformations) | images stop updating near the limit | Cloudinary Plus |
| Free OpenStreetMap address search/routing | slower or failing address checks at high volume | paid geocoder / self-hosted |
| Free translation (MyMemory) | weak Luganda; non-English shoppers may see English | `TRANSLATION_PROVIDER=GOOGLE` + key |

## Notes

- **Email (Resend etc.)** is not wired into UgaMarket yet. Customers and staff
  already get in-app notifications, live alerts and chat; email can be added later.
- **Your own domain later** (e.g. `ugamarket.ug`): add it in each Vercel project
  (shop and admin), optionally a custom domain on Render for the API, then
  update `CORS_ORIGIN`, `FRONTEND_URL` and the two `*_API_URL` variables and
  redeploy.
- The Docker/VM setup in [`DEPLOYMENT_GUIDE.md`](DEPLOYMENT_GUIDE.md) is the
  faster, always-on option once you have a small budget.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Shop loads but every action fails / "Network connection failed" | `REACT_APP_API_URL` wrong (must end in `/api`) → fix in Vercel and **redeploy** |
| Browser console shows CORS / API returns 403 | `CORS_ORIGIN` on Render must list the exact Vercel URLs (https, no trailing `/`) |
| First request after a while takes ~1 minute | the pinger (step 7) is not running |
| API won't start: "CLOUDINARY_URL is required on Render" | set `CLOUDINARY_URL` (step 2) |
| Payments stay pending | webhook URL / secret hash (step 8) |
| Render log: "Can't reach database server" | `DATABASE_URL` must be Neon's **direct** string with `sslmode=require` |
