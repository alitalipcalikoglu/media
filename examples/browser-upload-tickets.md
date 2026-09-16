# Direct browser uploads with tickets

Scenario: a user picks an avatar. You do not want 5 MB of image to travel through your backend.

## 1. Backend requests a ticket

```bash
curl -s -X POST $MEDIA/v1/uploads -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{ "visibility": "public", "maxBytes": 5000000, "allowedTypes": ["image/jpeg", "image/png", "image/webp"], "name": "avatar" }'
```

```json
{ "token": "q8Fz…43 chars", "uploadUrl": "https://media.example.com/v1/uploads/q8Fz…", "method": "PUT",
  "expiresAt": "2026-09-16T04:23:28.000Z", "maxBytes": 5000000, "allowedTypes": ["image/jpeg", "image/png", "image/webp"] }
```

Constraints can only be tighter than the service configuration (`400 INVALID_ARGUMENT` otherwise). Tickets expire after `UPLOAD_TICKET_TTL_SEC` (900 s) and work once.

Return `uploadUrl` to the page.

## 2. Page uploads straight to media

```js
const res = await fetch(uploadUrl, {
  method: 'PUT',
  body: file,                                      // a File from <input type="file">
  headers: { 'X-File-Name': encodeURIComponent(file.name) },
});
if (res.status === 201) {
  const { file: stored } = await res.json();
  await fetch('/api/profile/avatar', { method: 'POST', body: JSON.stringify({ fileId: stored.id }) });
}
```

The page origin must be listed in `CORS_ORIGINS`; the service answers the preflight and adds `Access-Control-Allow-Origin` to the response.

## 3. Backend trusts the result

The page sends `stored.id` to your backend, which verifies ownership by fetching it:

```bash
curl -s $MEDIA/v1/files/<id> -H "Authorization: Bearer $KEY"
```

The file belongs to the API key that created the ticket, so another tenant's key gets `404`.

## Failure handling

| Status | Meaning | What the page should do |
|---|---|---|
| 415 / 413 / 422 | Type, size or image problem | Show the message; **the ticket is released**, the same URL can be retried with a different file |
| 401 `INVALID_TICKET` | Used, expired or unknown | Ask the backend for a new ticket |

Only a successful `201` consumes the ticket.

## Why this is safe

- The ticket is the credential: no API key reaches the browser.
- Type is decided by the bytes, size is enforced while streaming, images are re-encoded.
- The ticket fixes visibility and ownership; the page cannot change them.
