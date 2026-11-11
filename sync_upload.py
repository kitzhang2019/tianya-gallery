#!/usr/bin/env python3
"""Upload the 8 unsynced station images to the Cloady gallery.

Reads ~/workspace/showcase-cloady/sync_manifest.json.
SHOWCASE_KEY comes from the environment (never written to disk).
POSTs multipart to https://tianya-gallery-bizen7j8-workspace-krgsbt.cloady.io/upload.php
fields: key/image/prompt/model/seed/width/height/created_at
"""
import json, mimetypes, os, sys, urllib.request, uuid

MANIFEST = os.path.join(os.path.expanduser("~"), "workspace", "showcase-cloady", "sync_manifest.json")
URL = "https://tianya-gallery-bizen7j8-workspace-krgsbt.cloady.io/upload.php"

def multipart(fields, files):
    boundary = uuid.uuid4().hex
    body = b""
    for name, value in fields.items():
        body += f"--{boundary}\r\n".encode()
        body += f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode()
        body += str(value).encode() + b"\r\n"
    for name, path in files.items():
        ctype = mimetypes.guess_type(path)[0] or "application/octet-stream"
        body += f"--{boundary}\r\n".encode()
        body += f'Content-Disposition: form-data; name="{name}"; filename="{os.path.basename(path)}"\r\n'.encode()
        body += f"Content-Type: {ctype}\r\n\r\n".encode()
        body += open(path, "rb").read() + b"\r\n"
    body += f"--{boundary}--\r\n".encode()
    return body, boundary

def main():
    key = os.environ.get("SHOWCASE_KEY")
    if not key:
        print("SHOWCASE_KEY not set", file=sys.stderr)
        return 1
    items = json.load(open(MANIFEST))
    ok = 0
    for it in items:
        fields = {
            "key": key,
            "prompt": it["prompt"],
            "model": it["model"],
            "seed": it["seed"],
            "width": it["width"],
            "height": it["height"],
            "created_at": it["created_at"],
        }
        body, boundary = multipart(fields, {"image": it["file"]})
        req = urllib.request.Request(URL, data=body, method="POST")
        req.add_header("Content-Type", f"multipart/form-data; boundary={boundary}")
        req.add_header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36")
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                resp = r.read().decode()
                status = r.status
        except urllib.error.HTTPError as e:
            resp = e.read().decode()
            status = e.code
        print(f"img{it['station_image_id']} job{it['job_id']}: HTTP {status} {resp[:160]}")
        if status == 200 and '"ok":true' in resp.replace(" ", ""):
            ok += 1
    print(f"done: {ok}/{len(items)} ok")
    return 0 if ok == len(items) else 1

if __name__ == "__main__":
    sys.exit(main())
