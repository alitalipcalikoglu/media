# Download, variants and caching

Public files are fetched straight from the service (or through the gateway/CDN) with no credentials.

## Original

```bash
curl -sI $MEDIA/files/73effd37-…/original
```

```
HTTP/1.1 200 OK
content-type: image/jpeg
content-length: 48213
etag: "56e12953450bdf743c234ab2efe95ea7-original"
accept-ranges: bytes
cache-control: public, max-age=31536000, immutable
content-disposition: inline; filename="urun fotografi.jpg"; filename*=UTF-8''%C3%BCr%C3%BCn%20fotoğrafı.jpg
x-content-type-options: nosniff
content-security-policy: default-src 'none'; sandbox
```

Objects are content-addressed and never change, hence the one-year immutable cache. Renaming or re-uploading produces a new id/URL.

## Variants

Presets come from `VARIANTS` (default `thumb:200x200:cover,small:400,medium:800,large:1600`). Served as WebP, generated on first request, cached on disk, never upscaled.

```bash
curl -s $MEDIA/files/73effd37-…/thumb -o thumb.webp     # 200×200, cropped to cover
curl -s $MEDIA/files/73effd37-…/medium -o medium.webp   # 800 px wide, aspect kept
```

`content-disposition` names them `<stem>-<variant>.webp`. Unknown variant → `404 UNKNOWN_VARIANT`; variant of a PDF → `400 NOT_AN_IMAGE`. Only configured presets exist, so clients cannot make the server encode arbitrary sizes.

Responsive images:

```html
<img src="…/medium" srcset="…/small 400w, …/medium 800w, …/large 1600w" sizes="(max-width: 600px) 100vw, 800px" alt="">
```

## Conditional requests

```bash
curl -s -o /dev/null -w '%{http_code}\n' -H 'If-None-Match: "56e12953450bdf743c234ab2efe95ea7-original"' $MEDIA/files/73effd37-…/original
# 304
```

## Range requests

```bash
curl -s -H 'Range: bytes=0-1023' $MEDIA/files/73effd37-…/original -o first-kb.bin -w '%{http_code}\n'   # 206
curl -s -H 'Range: bytes=-500' … -w '%{http_code}\n'        # 206, last 500 bytes
curl -s -H 'Range: bytes=999999999-' … -w '%{http_code}\n'  # 416, Content-Range: bytes */48213
```

Single ranges only; multi-range requests get the whole body with `200`. `HEAD` returns the same headers with the real `Content-Length`.

## Non-image files

PDFs and other documents are delivered as downloads:

```
content-type: application/pdf
content-disposition: attachment; filename="report.pdf"; filename*=UTF-8''report.pdf
content-security-policy: default-src 'none'; sandbox
x-frame-options: DENY
```

A hostile PDF cannot run scripts in your origin or be framed.
