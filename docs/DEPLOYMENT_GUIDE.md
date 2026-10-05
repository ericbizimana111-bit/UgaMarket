# UgaMarket — Go-live guide (step by step)

This is the practical, start-to-finish path to put UgaMarket on the internet.
The technical reference (every variable, every service) stays in
[`PRODUCTION_DEPLOYMENT.md`](PRODUCTION_DEPLOYMENT.md).

> **No budget yet?** Use the free setup instead:
> [Vercel + Render + Neon + Cloudinary](FREE_DEPLOYMENT.md).

**Target setup (recommended):**

```
Customers in Uganda ──HTTPS──> Cloudflare (Kampala edge, CDN, TLS, DDoS)
                                   │  Cloudflare Tunnel (no open ports)
                                   ▼
            One Linux server in Johannesburg, South Africa
            ┌──────────────────────────────────────────────┐
            │ web (nginx)  ─ shop  ugamarket.ug            │
            │              ─ admin admin.ugamarket.ug      │
            │ backend (Node API, single instance)          │
            │ postgres (database, daily backups)           │
            └──────────────────────────────────────────────┘
```

Why this shape:

- **Cloudflare has a data centre in Kampala** (EBB). Images, JavaScript and CSS
  are served from there, so phones on MTN/Airtel load the shop quickly. It also
  provides free HTTPS certificates and DDoS protection.
- **Johannesburg** is the closest place with full, mature cloud services
  (Azure *South Africa North*, Google Cloud *africa-south1*). AWS's nearest full
  region is Cape Town (`af-south-1`), which is farther away. Nairobi zones are
  announced/in preview, so check availability when you deploy.
- **One server is enough to launch.** Live notifications and chat run inside
  the API process, so the API must run as a **single instance**. A 2 vCPU / 4 GB
  machine handles a busy small marketplace comfortably; resize it later.

---

## Before you start (what you need)

| Item | Notes |
|---|---|
| A domain | e.g. `ugamarket.ug` (shop) and `admin.ugamarket.ug` (staff console) |
| Cloudflare account (free plan is fine) | add the domain and change its nameservers to Cloudflare's |
| A Linux VM, **Ubuntu 24.04**, 2 vCPU / 4 GB RAM / 40 GB disk | Johannesburg region (Azure *South Africa North* or GCP *africa-south1*) |
| Flutterwave **live** account | MTN MoMo + Airtel Money enabled; live public/secret keys |
| (Recommended) Google Cloud Translation API key | much better Luganda than the free default |

---

## Step 1 — Prepare the server

SSH into the VM, then:

```bash
# Docker Engine + Compose plugin
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER && newgrp docker

# Firewall: only SSH. (With Cloudflare Tunnel, web traffic needs NO open port.)
sudo ufw allow OpenSSH && sudo ufw enable

# Get the code
git clone <your-repo-url> ugamarket && cd ugamarket
```

## Step 2 — Create the production secrets file

```bash
cp .env.production.example .env.production
nano .env.production
```

Fill **every** value. Generate secrets with `openssl rand -hex 32`.

| Variable | What to put |
|---|---|
| `POSTGRES_PASSWORD` | a long random value (also inside `DATABASE_URL`) |
| `JWT_SECRET`, `ADMIN_JWT_SECRET` | two **different** random values (32+ chars) |
| `ADMIN_1_EMAIL` / `ADMIN_1_PASSWORD` | the owner's super-admin login |
| `ADMIN_2_EMAIL` / `ADMIN_2_PASSWORD` | a second admin |
| `CORS_ORIGIN` | `https://ugamarket.ug,https://admin.ugamarket.ug` |
| `PAYMENT_PROVIDER` / `PAYMENT_MODE` | `FLUTTERWAVE` / `LIVE` (start with `TEST` for a dry run) |
| `FLW_PUBLIC_KEY`, `FLW_SECRET_KEY` | from the Flutterwave dashboard |
| `PAYMENT_WEBHOOK_SECRET` | random value; enter the **same** value as the "secret hash" in Flutterwave |
| `FRONTEND_URL` | `https://ugamarket.ug` |
| `WAREHOUSE_LATITUDE/LONGITUDE` | your dispatch point (admins can change it later in the console) |
| `TRANSLATION_PROVIDER` | `GOOGLE` + `GOOGLE_TRANSLATE_API_KEY` (recommended) |
| `GEO_CONTACT_EMAIL` | a real email (required by the free OpenStreetMap services) |
| `CLOUDFLARE_TUNNEL_TOKEN` | from Step 6 |

The API **refuses to start** if a value is missing, weak, a placeholder, or
unsafe (e.g. the mock payment provider) and prints which one, so mistakes are
caught before customers see them.

```bash
chmod 600 .env.production     # only you can read it
```

## Step 3 — Build the images

```bash
docker compose --env-file .env.production -f docker-compose.production.yml build
```

## Step 4 — Create the database and load the catalogue

```bash
# 1. Database tables (safe, forward-only; run on EVERY release)
docker compose --env-file .env.production -f docker-compose.production.yml \
  --profile tools run --rm migrate

# 2. First launch only: admin accounts, categories, delivery pricing,
#    home-services catalogue and the sample products with photos
docker compose --env-file .env.production -f docker-compose.production.yml \
  run --rm backend node seeds/seed.js
```

The sample products are real listings with photos; edit, restock or hide them
from **Products** in the admin console. The seed never overwrites photos an
admin has uploaded.

## Step 5 — Start UgaMarket

```bash
docker compose --env-file .env.production -f docker-compose.production.yml up -d
docker compose --env-file .env.production -f docker-compose.production.yml ps   # all "healthy"
```

## Step 6 — Put it on the internet with Cloudflare Tunnel

1. Cloudflare dashboard → **Zero Trust → Networks → Tunnels → Create a tunnel**
   (type *Cloudflared*). Copy the **token** into `.env.production` as
   `CLOUDFLARE_TUNNEL_TOKEN`.
2. In the tunnel, add two **Public hostnames**:

   | Hostname | Service |
   |---|---|
   | `ugamarket.ug` | `http://web:80` |
   | `admin.ugamarket.ug` | `http://web:8080` |

3. Start the tunnel:

   ```bash
   docker compose --env-file .env.production -f docker-compose.production.yml \
     --profile tunnel up -d
   ```

4. Cloudflare settings for the domain:
   - **SSL/TLS → Edge Certificates → Always Use HTTPS: On**
   - **Speed**: leave Brotli on.
   - Optional but recommended: **Zero Trust → Access → Applications**: protect
     `admin.ugamarket.ug` so only staff emails can even open the login page.

Open `https://ugamarket.ug` and `https://admin.ugamarket.ug`. Done.

## Step 7 — First-day checklist (in the admin console)

1. Sign in as `ADMIN_1_EMAIL` → **Staff accounts**: add your dispatchers.
2. **Storefront content**: support phone, WhatsApp, email, address, hours.
3. **Delivery & deposit**: pin the dispatch point, set the delivery tariff and
   deposit rule.
4. **Categories / Products**: review names, prices, stock and photos.
5. Place a real **test order** on your own phone with a small MoMo deposit,
   confirm the staff notification arrives, chat works, then cancel/refund it.

## Step 8 — Backups (do not skip)

Daily database dump + the uploaded photos volume, kept off the server:

```bash
# /etc/cron.daily/ugamarket-backup  (chmod +x)
#!/bin/sh
cd /home/<user>/ugamarket
docker compose --env-file .env.production -f docker-compose.production.yml exec -T postgres \
  sh -c 'pg_dump -U "$POSTGRES_USER" -Fc "$POSTGRES_DB"' > /var/backups/ugamarket-$(date +%F).dump
docker run --rm -v ugamarket-production_uploads:/u -v /var/backups:/b alpine \
  tar czf /b/ugamarket-uploads-$(date +%F).tgz -C /u .
find /var/backups -name 'ugamarket-*' -mtime +14 -delete
```

Copy `/var/backups` to off-site storage (e.g. a cloud storage bucket) and
**test a restore** once before launch.

## Releasing an update later

```bash
git pull
docker compose --env-file .env.production -f docker-compose.production.yml build
docker compose --env-file .env.production -f docker-compose.production.yml --profile tools run --rm migrate
docker compose --env-file .env.production -f docker-compose.production.yml --profile tunnel up -d
```

## When something looks wrong

| Symptom | Check |
|---|---|
| A container is not `healthy` | `docker compose ... logs backend --tail 100` |
| API exits at start with "Environment configuration validation failed" | fix the named variable in `.env.production` |
| Payments stay "pending" | Flutterwave webhook URL = `https://ugamarket.ug/api/payments/webhook`, secret hash = `PAYMENT_WEBHOOK_SECRET` |
| Address search / map distance slow or failing | free OpenStreetMap services are rate-limited; for high volume self-host Nominatim/OSRM or use a paid geocoder |
| Too many "Too many requests" | raise `RATE_LIMIT_API_MAX` (default 600 per account / 15 min) |
