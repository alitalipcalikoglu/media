# Manage files

All under `/v1/files`, scoped to the API key that uploaded: another key sees `404`.

## List

```bash
curl -s "$MEDIA/v1/files?limit=50" -H "Authorization: Bearer $KEY"
curl -s "$MEDIA/v1/files?limit=50&cursor=<nextCursor>" -H "Authorization: Bearer $KEY"
```

Newest first; soft-deleted files are not listed. `limit` 1..100, default 20.

## Get

```bash
curl -s $MEDIA/v1/files/73effd37-… -H "Authorization: Bearer $KEY"
```

## Rename / change visibility

```bash
curl -s -X PATCH $MEDIA/v1/files/73effd37-… -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{ "name": "hero-banner", "visibility": "private" }'
```

The extension is kept consistent with the real type (`hero-banner.jpg`). Empty patch → `400`.

## Delete with a safety net

```bash
curl -s -X DELETE $MEDIA/v1/files/73effd37-… -H "Authorization: Bearer $KEY"     # 204
curl -s $MEDIA/files/73effd37-…/original -o /dev/null -w '%{http_code}\n'          # 404 immediately
```

The bytes stay for `DELETE_GRACE_DAYS` (default 7). Undo within that window:

```bash
curl -s -X POST $MEDIA/v1/files/73effd37-…/restore -H "Authorization: Bearer $KEY"  # 200 {"file":{…}}
```

After the grace period the hourly maintenance removes the row and, if no other file shares the same bytes, the object and its variants from disk. Set `DELETE_GRACE_DAYS=0` for removal at the next hourly run.

## Dedupe awareness

Two uploads of identical bytes are two files with one blob (`sha256` equal). Deleting one leaves the other intact; the bytes go only when the last reference is purged.
