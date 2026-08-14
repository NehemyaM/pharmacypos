# Deploying PharmacyPOS

Two moving parts: a **front-end** (static files) and a **back-end** (Node +
SQLite, needs a disk that survives restarts).

The back-end already serves the front-end, so the simplest deployment is *one*
process on one machine. Splitting them across Firebase Hosting and a server is
also supported — that is what `VITE_API_URL` and `PHARMACY_ALLOWED_ORIGINS` are
for.

---

## Where the back-end can go

It needs **persistent disk**. That single requirement rules several things out.

| Host | Disk | Notes |
|---|---|---|
| **Compute Engine** `e2-small`, asia-south1 | ✅ | Same Google project as Firebase. Mumbai region keeps latency low from Hyderabad. **Recommended.** |
| **Fly.io** (`bom` region) | ✅ volumes | Simplest of the lot; Mumbai region available |
| **Railway / Render** | ✅ volumes / disks | Easy, git-push deploys |
| Any VPS (Hetzner, DigitalOcean, Linode) | ✅ | Cheapest, most control |
| **Cloud Run** | ❌ | No persistent disk. Needs Postgres first — SQLite over GCS FUSE corrupts |
| **Firebase Functions** | ❌ | Same problem, plus execution time limits |
| **Firebase Hosting alone** | ❌ | Static files only; cannot run a server |

Rough cost for one shop: **₹600–1,200/month**, plus ₹0 for Firebase Hosting on
the free Spark tier.

> **Do not put SQLite on a network or object-storage mount.** Its file locking
> does not work correctly over NFS/GCS FUSE and the database will corrupt. Local
> disk or a real block volume only.

---

## Option A — one machine (recommended to start)

Front-end and API from a single Node process. Nothing to keep in sync, one
domain, no CORS.

```bash
# On a fresh Ubuntu 22.04+ server, as root:
sudo bash deploy/setup-server.sh pharmacy.yourdomain.com
```

That script installs Node 22 and Caddy, clones the repo, builds, creates a
service user, generates a JWT secret, installs the systemd service and the
nightly backup timer, and configures automatic HTTPS.

**DNS at GoDaddy** — one record:

| Type | Name | Value | TTL |
|---|---|---|---|
| A | `pharmacy` | your server's public IPv4 | 600 |

Caddy issues the TLS certificate automatically once that record resolves.

Then:

```bash
# Optional demo data — skip on a real shop
sudo -u pharmacy bash -c 'cd /opt/pharmacypos && npm run seed'

sudo systemctl status pharmacypos       # is it running
sudo journalctl -u pharmacypos -f       # logs
sudo systemctl list-timers pharmacypos-backup   # next backup
```

Open `https://pharmacy.yourdomain.com` and sign in.
**Change all three demo passwords immediately.**

---

## Option B — Firebase Hosting + your own back-end

Front-end on Firebase's CDN, API on the server from Option A. Slightly faster
page loads and a free CDN; the cost is one more moving part and CORS to keep
right.

### 1. Back-end

Same as Option A, but give it its own hostname — `api.yourdomain.com` — and tell
it which site may call it:

```bash
sudo bash deploy/setup-server.sh api.yourdomain.com

# Then edit /etc/pharmacypos.env so it lists your Hosting origins:
#   PHARMACY_ALLOWED_ORIGINS=https://yourdomain.com,https://YOUR-PROJECT.web.app
sudo systemctl restart pharmacypos
```

Anything not on that list gets a **403 with an explanatory message**, not a
silent failure — check the API logs if the UI cannot reach it.

### 2. Front-end

```bash
# once
npm install -g firebase-tools
firebase login                       # your own browser; no key is shared
# put your project id in .firebaserc, replacing the placeholder

# every deploy
VITE_API_URL=https://api.yourdomain.com npm run build
firebase deploy --only hosting
```

`VITE_API_URL` is **baked into the bundle at build time**. Change the API
hostname and you must rebuild — a stale bundle keeps calling the old host.

### 3. DNS at GoDaddy

| Type | Name | Value | Purpose |
|---|---|---|---|
| A | `api` | server's public IPv4 | back-end |
| A / TXT | `@` | *values Firebase shows you* | Hosting custom domain |

Add the custom domain in Firebase Console → Hosting → Add custom domain, and it
will print the exact records.

---

## Option C — Docker

The `Dockerfile` builds a slim runtime image and works on Fly.io, Railway,
Render, or plain Docker.

```bash
docker build -t pharmacypos .
docker run -d --name pharmacypos \
  -p 4000:4000 \
  -v pharmacy-data:/data \
  -e PHARMACY_JWT_SECRET="$(openssl rand -hex 48)" \
  -e PHARMACY_ALLOWED_ORIGINS=https://yourdomain.com \
  pharmacypos
```

**The `-v pharmacy-data:/data` is not optional.** Without it the database lives
inside the container and the shop's entire history disappears on the next
restart.

---

## Environment variables

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `4000` | Port to listen on |
| `HOST` | `0.0.0.0` | Bind address — set `127.0.0.1` when behind Caddy/nginx |
| `PHARMACY_DB` | `data/pharmacy.sqlite` | Database file |
| `PHARMACY_BACKUP_DIR` | `<db dir>/backups` | Where backups are written |
| `PHARMACY_BACKUP_KEEP` | `30` | Automatic backups retained |
| `PHARMACY_JWT_SECRET` | generated beside the DB | **Set this in production** |
| `PHARMACY_ALLOWED_ORIGINS` | *(unset = allow all)* | Comma-separated origins permitted to call the API |
| `VITE_API_URL` | *(empty = same origin)* | Build-time: absolute API origin for the front-end |

---

## Updating

```bash
sudo bash /opt/pharmacypos/deploy/update.sh
```

Takes a labelled backup, pulls `main`, rebuilds, restarts — and **rolls back
automatically** if the new build does not answer its health check. A broken
deploy must not leave the counter unable to bill.

For Option B, redeploy the front-end too:

```bash
VITE_API_URL=https://api.yourdomain.com npm run build
firebase deploy --only hosting
```

---

## Before real billing

1. **Change the three demo passwords** and delete accounts you do not need.
2. Enter the shop's real GSTIN, both drug licence numbers, FSSAI number and the
   pharmacist's registration in **Settings**.
3. Confirm the backup timer has run: `systemctl list-timers pharmacypos-backup`,
   then `npm run backup:list`.
4. **Copy a backup off the server** — Settings → Backup → Download. A backup on
   the same machine as the database is not a backup.
5. Restrict SSH to your own IP, and make sure the firewall exposes only 22, 80
   and 443. The API on 4000 should not be reachable from the internet directly;
   Caddy proxies it.
6. Remember the shop stops billing if its internet drops. Consider keeping a
   local copy on the counter PC as a fallback.

---

## Health check

```bash
curl https://api.yourdomain.com/api/health
# {"ok":true,"db":"/var/lib/pharmacypos/pharmacy.sqlite","time":"..."}
```

Point any uptime monitor at that URL.
