# Image normalisation and limits

With `STRIP_IMAGE_METADATA=true` (default) every JPEG, PNG, WebP, GIF and AVIF is decoded and re-encoded on upload.

## What changes

Upload a phone photo (EXIF orientation 6, GPS tags):

```bash
curl -s -X PUT "$MEDIA/v1/files?visibility=public" -H "Authorization: Bearer $KEY" --data-binary @phone.jpg | jq '.file | {width, height, size}'
# { "width": 900, "height": 1200, "size": 4032 }
```

- **Orientation applied**: the stored image is upright; `width`/`height` are the displayed ones, no viewer needs to read EXIF.
- **Metadata removed**: EXIF (camera, GPS), XMP, comments. ICC colour profile is kept.
- **Clean encoder output**: a file that was both a valid JPEG and a valid HTML/ZIP (polyglot) is just a JPEG afterwards.
- `sha256` and `size` refer to the stored bytes, not the uploaded ones.

Formats: JPEG → JPEG (mozjpeg, quality 92), PNG → PNG (lossless), WebP → WebP (quality 92), GIF → GIF (animation kept), AVIF → AVIF. PDFs are stored as received.

Set `STRIP_IMAGE_METADATA=false` to keep originals byte-for-byte (variants still strip metadata).

## Limits

| Setting | Default | Failure |
|---|---|---|
| `MAX_UPLOAD_BYTES` | 25 MB | `413 TOO_LARGE`, connection closed while streaming |
| `MAX_IMAGE_PIXELS` | 50 000 000 (e.g. 7071×7071) | `422 INVALID_IMAGE` "image exceeds the pixel limit", checked before decoding |

A 200 KB PNG that decodes to 20 000×20 000 pixels (a decompression bomb) is refused without allocating the pixels.

## Variants

Generated from the stored original with the same pixel limit; always WebP at `VARIANT_QUALITY` (default 82), metadata-free, `withoutEnlargement`. `fit` per preset: `cover` (crop, attention-based positioning), `inside` (fit within, default for width-only presets), `contain` (letterbox).

## Verifying yourself

```bash
curl -s $MEDIA/files/<id>/original -o stored.jpg
exiftool stored.jpg | grep -iE 'gps|orientation'     # nothing
```
