# media examples

Scenario-driven walkthroughs of every feature. Requests to `/v1/*` need `Authorization: Bearer <secret>` from `MEDIA_API_KEYS`; delivery under `/files/…` and ticket uploads under `/v1/uploads/:token` need no key. Base URL below is `http://localhost:3003`.

| Example | Shows |
|---|---|
| [Upload a file](upload.md) | Raw-body `PUT`, naming, visibility, what gets rejected |
| [Download, variants and caching](download-and-variants.md) | Public URLs, preset variants, ETag, Range, HEAD, headers |
| [Private files and signed URLs](private-files-and-signed-urls.md) | Time-limited signatures, refreshing them, switching visibility |
| [Direct browser uploads with tickets](browser-upload-tickets.md) | Backend issues a ticket, the page uploads without proxying, CORS |
| [Manage files](manage-files.md) | List, get, rename, soft delete, restore, grace period |
| [Image normalisation and limits](image-normalisation.md) | EXIF stripping, orientation, pixel bombs, dedupe |
| [Operations](operations.md) | Health, readiness, metrics, environment, PM2, Docker, backups |
| [Audit events](audit-events.md) | Which write actions are forwarded to the audit service, event shape, configuration |

Set up once:

```bash
export MEDIA=http://localhost:3003
export KEY=<your secret from MEDIA_API_KEYS>
```
