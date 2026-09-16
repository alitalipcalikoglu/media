# Upload a file

Scenario: your backend stores a product photo it received from an admin.

## 1. PUT the bytes

No multipart. The body is the file; `Content-Type` is a hint only.

```bash
curl -s -X PUT "$MEDIA/v1/files?visibility=public" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: image/jpeg" \
  -H "X-File-Name: $(python3 -c 'import urllib.parse;print(urllib.parse.quote("ürün fotoğrafı.jpg"))')" \
  --data-binary @product.jpg
```

`201 Created`, `Location: /v1/files/<id>`:

```json
{ "file": {
  "id": "73effd37-6dc0-4259-950d-7609eaf6d1f3",
  "name": "ürün fotoğrafı.jpg",
  "mime": "image/jpeg",
  "size": 48213,
  "width": 1200, "height": 900,
  "sha256": "56e12953…",
  "visibility": "public",
  "createdAt": "2026-09-16T04:08:28.791Z",
  "urls": {
    "original": { "url": "https://media.example.com/files/73effd37-…/original", "expiresAt": null },
    "thumb":    { "url": "https://media.example.com/files/73effd37-…/thumb", "expiresAt": null },
    "small":    { "url": "…/small", "expiresAt": null },
    "medium":   { "url": "…/medium", "expiresAt": null },
    "large":    { "url": "…/large", "expiresAt": null }
  } } }
```

Store `file.id` in your database; build URLs from `urls` or later via `POST /v1/files/:id/urls`.

## Naming

`X-File-Name` (URL-encoded) or `?name=`. The service strips paths and control characters, caps the length and **replaces the extension** with the one matching the sniffed type: `invoice.exe` sent as a PDF becomes `invoice.pdf`. Without a name you get `file.<ext>`.

## Visibility

`?visibility=public` (stable, cacheable URLs) or `private` (default; URLs need a signature, see [private files](private-files-and-signed-urls.md)).

## What is rejected

| Status | Code | Example |
|---|---|---|
| 415 | `UNSUPPORTED_TYPE` | HTML, executables, anything not in `ALLOWED_TYPES`; type comes from magic bytes, so a renamed `.exe` is caught |
| 413 | `TOO_LARGE` | Body over `MAX_UPLOAD_BYTES` (default 25 MB). The connection is cut while streaming; nothing is kept |
| 422 | `INVALID_IMAGE` | Truncated or corrupt image, or more pixels than `MAX_IMAGE_PIXELS` |
| 400 | `EMPTY` | Zero-byte body |
| 400 | `VALIDATION_FAILED` | Unknown query parameter, bad `visibility` |

```json
{ "error": { "code": "UNSUPPORTED_TYPE", "message": "type image/svg+xml is not allowed",
  "details": { "allowed": ["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif", "application/pdf"] } } }
```

## From Node

```js
const res = await fetch(`${MEDIA}/v1/files?visibility=public`, {
  method: 'PUT',
  headers: { authorization: `Bearer ${KEY}`, 'content-type': 'image/png', 'x-file-name': encodeURIComponent(name) },
  body: fs.createReadStream(path), duplex: 'half',
});
const { file } = await res.json();
```
