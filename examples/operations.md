# Operations

## Probes

```bash
curl -s $MEDIA/health   # {"status":"ok"}
curl -s $MEDIA/ready    # {"status":"ok"} when SQLite answers and the data directory is writable; 503 otherwise (cached 30 s)
```

## Metrics

```bash
curl -s $MEDIA/metrics -H "Authorization: Bearer $KEY"
```

```
media_files 12873
media_blobs 12411
media_stored_bytes 9184373122
media_uploads_total 41
media_downloads_total 90211
media_downloaded_bytes_total 11223344556
media_process_uptime_seconds 86400
```

`media_files - media_blobs` is how many uploads were deduplicated.

## Environment

Required: `MEDIA_API_KEYS`, `PUBLIC_BASE_URL`, `SIGNING_SECRET`. Full list: [.env.example](../.env.example).

- `PUBLIC_BASE_URL` must be the origin browsers use (gateway or CDN hostname); it is embedded in every returned URL.
- `CORS_ORIGINS` lists the pages allowed to upload with tickets or fetch cross-origin.
- One `MEDIA_API_KEYS` entry per caller.

## Disk layout

```
DATA_DIR/
  tmp/                   in-flight uploads (wiped on start)
  objects/ab/cd/<sha256> originals
  variants/<sha256>/     thumb.webp, medium.webp, …
```

Variants can be deleted at any time; they are regenerated on demand. Objects must not be touched by hand.

## Process manager

```bash
pm2 start ecosystem.config.cjs
pm2 reload media
```

`max_memory_restart` is 600 MB because large images are decoded in memory; `kill_timeout` 65 s lets uploads and downloads finish.

## Docker

```bash
docker build -t atc-media .
docker run -d -p 3003:3003 -v media-data:/data --env-file .env atc-media
```

`/data` holds both `media.db` and the files; back it up as a unit.

## Backups

```bash
sqlite3 data/media.db ".backup 'media-$(date +%F).db'"
rsync -a data/files/objects/ backup-host:/backups/media/objects/
```

Objects are immutable, so incremental sync is cheap. Variants need no backup.

## Putting a CDN in front

Public URLs are immutable-cacheable for a year; point a CDN at `/files/` and set `PUBLIC_BASE_URL` to the CDN hostname. Private (signed) URLs are `no-store` and pass through.
