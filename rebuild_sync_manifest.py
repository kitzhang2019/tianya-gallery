#!/usr/bin/env python3
"""Rebuild the gallery sync manifest from the job notebooks + station data.

Reads each job notebook's cell-4 PROMPT assignment (ast parse), the PNG
dimensions/bytes from ~/workspace/muse-jobs/<jobid>/result.png, and takes
created_at/seed from the station dashboard (2026-11-11 getdashboard).
Writes ~/workspace/showcase-cloady/sync_manifest.json
"""
import ast, json, os, struct

HOME = os.path.expanduser("~")
# (station image id, job id, notebook, model display, created_at UTC ISO, seed)
JOBS = [
    (1, 1, "moss_job_1.ipynb", "MOSS-Image", "2026-11-10T04:05:30.818Z", 42),
    (2, 2, "qwen_job_2.ipynb", "Qwen Image 2.1 Turbo", "2026-11-10T06:50:59.096Z", 1475154256),
    (3, 3, "moss_job_3.ipynb", "MOSS-Image", "2026-11-10T07:24:32.891Z", 1616252135),
    (4, 7, "moss_job_7.ipynb", "MOSS-Image", "2026-11-10T12:42:20.947Z", 1737919153),
    (5, 6, "krea2_job_6.ipynb", "Krea2 Turbo", "2026-11-10T13:38:37.746Z", 297058132),
    (6, 8, "moss_job_8.ipynb", "MOSS-Image", "2026-11-10T22:34:38.395Z", 391052898),
    (7, 9, "moss_job_9.ipynb", "MOSS-Image", "2026-11-11T01:57:51.103Z", 1554973580),
    (9, 12, "moss_job_12.ipynb", "MOSS-Image", "2026-11-11T06:22:26.823Z", 1408293606),
]

def png_size(path):
    with open(path, "rb") as f:
        head = f.read(33)
    assert head[:8] == b"\x89PNG\r\n\x1a\n", path
    w, h = struct.unpack(">II", head[16:24])
    return w, h

def notebook_prompt(path):
    nb = json.load(open(path))
    for cell in nb["cells"]:
        src = "".join(cell.get("source", []))
        if "PROMPT" in src and "=" in src:
            tree = ast.parse(src)
            for node in ast.walk(tree):
                if isinstance(node, ast.Assign):
                    for t in node.targets:
                        if isinstance(t, ast.Name) and t.id == "PROMPT":
                            return ast.literal_eval(node.value)
    raise ValueError("PROMPT not found in " + path)

items = []
for img_id, job_id, nb_name, model, created_at, seed in JOBS:
    fpath = os.path.join(HOME, "workspace", "muse-jobs", str(job_id), "result.png")
    w, h = png_size(fpath)
    prompt = notebook_prompt(os.path.join(HOME, "workspace", nb_name))
    items.append({
        "station_image_id": img_id,
        "job_id": job_id,
        "file": fpath,
        "model": model,
        "created_at": created_at,
        "seed": seed,
        "width": w,
        "height": h,
        "prompt": prompt,
        "bytes": os.path.getsize(fpath),
    })
    print(f"img{img_id} job{job_id} {model} {w}x{h} {os.path.getsize(fpath)}B seed={seed} prompt_head={prompt[:24]!r}")

out = os.path.join(HOME, "workspace", "showcase-cloady", "sync_manifest.json")
json.dump(items, open(out, "w"), ensure_ascii=False, indent=2)
print("wrote", out, "items:", len(items))
