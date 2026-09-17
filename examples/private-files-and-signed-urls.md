# Private files and signed URLs

Scenario: invoices must only be visible to the customer who is logged in to your app.

## 1. Upload as private

```bash
curl -s -X PUT "$MEDIA/v1/files?visibility=private" -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/pdf" -H "X-File-Name: invoice-42.pdf" --data-binary @invoice.pdf
```

`urls.original` now carries a signature and an expiry:

```json
{ "url": "https://media.example.com/files/9c1e…/original?exp=1758001408&sig=Vh3…", "expiresAt": "2026-09-16T04:23:28.000Z" }
```

Default lifetime: `SIGNED_URL_TTL_SEC` (900 s).

## 2. Unsigned access is refused

```bash
curl -s -o /dev/null -w '%{http_code}\n' $MEDIA/files/9c1e…/original      # 403 FORBIDDEN
```

## 3. Hand out a fresh URL when the user asks

When the customer opens the invoice page, your backend (after checking that this customer owns invoice 42) requests a URL and embeds or redirects to it:

```bash
curl -s -X POST "$MEDIA/v1/files/9c1e…/urls?ttl=120" -H "Authorization: Bearer $KEY"
```

```json
{ "urls": { "original": { "url": "https://media.example.com/files/9c1e…/original?exp=1758000628&sig=…", "expiresAt": "2026-09-16T04:10:28.000Z" } } }
```

`ttl` is in seconds, max 604800 (7 days). For images every variant gets its own signature; a signature is bound to `id + variant + exp`, so `…/thumb?sig=<original's sig>` is refused.

## 4. Caching

Private responses carry `cache-control: private, max-age=0, no-store`. Browsers and proxies will not keep them.

## Switching visibility

```bash
curl -s -X PATCH $MEDIA/v1/files/9c1e… -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d '{ "visibility": "public" }'
```

Public → private takes effect immediately for new requests; content already cached by browsers under the old public URL stays in those caches until it expires (the URL itself does not change).

## Rotating the secret

A bare `SIGNING_SECRET` change + restart invalidates every outstanding signed URL immediately —
fine if that's acceptable, but Stage 8 adds a grace period for when it isn't:

```bash
# 1. K1 is SIGNING_SECRET today.
# 2. Deploy with the new secret current and the old one previous:
SIGNING_SECRET=K2
SIGNING_SECRET_PREVIOUS=K1
# New URLs are signed with K2 only; verification still accepts K1 (never used to sign new URLs).
# 3. Wait out the longest TTL any URL signed under K1 could still have (SIGNED_URL_TTL_SEC, or the
#    longest custom `ttl` passed to POST /v1/files/:id/urls — 7 days max).
# 4. Deploy again with SIGNING_SECRET_PREVIOUS removed. K1 URLs now fail (fail closed); K2 keeps working.
```

`SIGNING_SECRET_PREVIOUS` is only meant to be set for that grace window — see README "Rotating
SIGNING_SECRET" for the full runbook.
