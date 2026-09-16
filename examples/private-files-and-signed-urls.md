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

`SIGNING_SECRET` change + restart invalidates every outstanding signed URL. Clients call `POST /v1/files/:id/urls` again; nothing else is affected.
