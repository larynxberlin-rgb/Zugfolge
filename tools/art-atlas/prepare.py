"""Technische Raster-/Palettenaufbereitung; keine Motive zeichnen oder ergänzen.

Explizit vom Auftraggeber am 06.09.2026 erlaubt. Originale bleiben unverändert.
Reproduzierbar mit Python 3.11+ und Pillow 12.3.0. Die CI prüft fertige PNG-Bytes;
die Bildgenerierung ist kein Buildschritt und kein Laufzeitdienst.
"""
from pathlib import Path
from hashlib import sha256
import json
import struct
from collections import deque
from PIL import Image
import PIL

ROOT = Path(__file__).resolve().parents[2]
RELEASE = ROOT / "assets/conductor-art/v1"
SOURCES = RELEASE / "sources"
PALETTE = ["101419", "181e25", "202830", "303b46", "f5f7fa", "b5c0cc", "93a2b1", "e5233d", "7cddba", "f5bf65", "e8b894", "be8060", "805342", "382c28", "e9e1cc", "a8967a", "932b34", "4f6650", "728168", "416365", "678998", "566370", "647780", "c4b29a"]
DIRECTIONS = ["south", "west", "east", "north"]
ACTORS = {"passenger-red": "passenger-01", "passenger-teal": "passenger-02", "passenger-amber": "passenger-03", "passenger-slate": "passenger-04", "conductor": "conductor-01"}


def digest(data):
    return sha256(data).hexdigest()


def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")


def cbor(data, offset=0):
    """Beschränkter CBOR-Leser für vorhandene C2PA-Aktionsmetadaten, keine Signaturprüfung."""
    first = data[offset]
    major, extra = first >> 5, first & 31
    offset += 1
    if extra < 24:
        n = extra
    elif extra in (24, 25, 26, 27):
        width = {24: 1, 25: 2, 26: 4, 27: 8}[extra]
        n = int.from_bytes(data[offset:offset + width], "big")
        offset += width
    else:
        raise ValueError("Unbegrenztes CBOR ist im Metadatenleser nicht zugelassen")
    if major == 0:
        return n, offset
    if major == 1:
        return -1 - n, offset
    if major in (2, 3):
        raw = data[offset:offset + n]
        return (raw.hex() if major == 2 else raw.decode("utf-8")), offset + n
    if major == 4:
        result = []
        for _ in range(n):
            item, offset = cbor(data, offset)
            result.append(item)
        return result, offset
    if major == 5:
        result = {}
        for _ in range(n):
            key, offset = cbor(data, offset)
            value, offset = cbor(data, offset)
            result[key] = value
        return result, offset
    if major == 6:
        return cbor(data, offset)
    if major == 7 and extra in (20, 21, 22):
        return {20: False, 21: True, 22: None}[extra], offset
    raise ValueError("Nicht unterstützter CBOR-Metadatenwert")


def provenance(key):
    path = SOURCES / f"{key}.png"
    data = path.read_bytes()
    label = data.find(b"c2pa.actions.v2")
    marker = data.find(b"cbor", label) if label >= 0 else -1
    actions, model = None, None
    raw = b""
    if marker >= 4:
        length = int.from_bytes(data[marker - 4:marker], "big")
        raw = data[marker + 4:marker - 4 + length]
        actions, _ = cbor(raw)
        for action in actions.get("actions", []):
            if "softwareAgent" in action:
                model = action["softwareAgent"]
                break
    prompt = (SOURCES / f"{key}.prompt.txt").read_text(encoding="utf-8").strip()
    evidence = {
        "schemaVersion": "conductor-art-generation-evidence/v1",
        "source": f"sources/{key}.png", "sourceSha256": digest(data),
        "tool": "image_gen.imagegen", "prompt": prompt,
        "metadata": {"container": "PNG/caBX/JUMBF/c2pa.actions.v2", "cborSha256": digest(raw),
                     "actions": actions, "softwareAgent": model,
                     "interpretation": "Providerdeklarierte Modellangabe; keine Prüfung der C2PA-Signatur oder Aussage über interne Gewichte."},
        "technicalProcessing": {"script": "tools/art-atlas/prepare.py", "pillowVersion": PIL.__version__,
                                "operations": ["crop", "edge-connected-neutral-checkerboard-removal", "alpha-threshold-128", "nearest-neighbor-resize", "fixed-palette-no-dither", "atlas-pack"],
                                "authorization": "Auftraggeber: Ja, technisch aufbereiten (06.09.2026)."},
    }
    write_json(RELEASE / f"evidence/generation-{key}.json", evidence)
    return model


def crop_cell(image, columns, rows, column, row):
    w, h = image.size
    rect = (round(column * w / columns), round(row * h / rows),
            round((column + 1) * w / columns), round((row + 1) * h / rows))
    return image.crop(rect), rect


def crop_actor_cell(image, columns, rows, column, row):
    """Die transparenten Zeilenlücken je Spalte statt erfundener Gleichabstände nutzen."""
    w, h = image.size
    left, right = round(column*w/columns), round((column+1)*w/columns)
    strip = clear_checkerboard(image.crop((left,0,right,h)))
    alpha = strip.getchannel("A")
    pixels = alpha.tobytes()
    counts = [sum(value >= 128 for value in pixels[y*strip.width:(y+1)*strip.width]) for y in range(h)]
    edges = [0]
    for n in range(1,rows):
        target = n*h/rows
        lo, hi = round(target-.40*h/rows), round(target+.40*h/rows)
        threshold = min(counts[lo:hi])+1
        runs, start = [], None
        for y in range(lo,hi):
            if counts[y] <= threshold and start is None:
                start = y
            elif counts[y] > threshold and start is not None:
                runs.append((start,y)); start=None
        if start is not None:
            runs.append((start,hi))
        if not runs:
            raise ValueError("Keine prüfbare Lücke zwischen Figuren")
        first,last = max(runs,key=lambda run:(run[1]-run[0],-abs((run[1]+run[0])/2-target)))
        edges.append((first+last)//2)
    edges.append(h)
    rect = (left,edges[row],right,edges[row+1])
    return image.crop(rect), rect


def clear_checkerboard(image):
    image = image.convert("RGBA")
    # Einige Generatorausgaben besitzen ein eingebranntes helles Schachbrett.
    # Nur mit dem Rand verbundene neutrale Hintergrundpixel entfernen; keine
    # Inhaltsformen malen, Löcher schließen oder Farben im Motiv ersetzen.
    px = image.load()
    corners = [px[x, y] for x, y in [(0, 0), (image.width - 1, 0), (0, image.height - 1), (image.width - 1, image.height - 1)]]
    if all(p[3] >= 250 and min(p[:3]) >= 215 and max(p[:3]) - min(p[:3]) < 14 for p in corners):
        seen = set()
        queue = deque([(x, 0) for x in range(image.width)] + [(x, image.height - 1) for x in range(image.width)]
                      + [(0, y) for y in range(image.height)] + [(image.width - 1, y) for y in range(image.height)])
        while queue:
            x, y = queue.popleft()
            if (x, y) in seen or x < 0 or y < 0 or x >= image.width or y >= image.height:
                continue
            seen.add((x, y))
            p = px[x, y]
            if min(p[:3]) < 215 or max(p[:3]) - min(p[:3]) >= 14:
                continue
            px[x, y] = (0, 0, 0, 0)
            queue.extend([(x-1, y), (x+1, y), (x, y-1), (x, y+1)])
    return image


def cutout(image):
    image = clear_checkerboard(image)
    alpha = image.getchannel("A").point(lambda value: 255 if value >= 128 else 0)
    image.putalpha(alpha)
    bounds = alpha.getbbox()
    if bounds is None:
        raise ValueError("Leeres Motiv")
    return image.crop(bounds), bounds


def quantize(image):
    palette = Image.new("P", (1, 1))
    values = [int(color[i:i + 2], 16) for color in PALETTE for i in (0, 2, 4)]
    palette.putpalette(values + values[-3:] * (256 - len(PALETTE)))
    result = image.convert("RGB").quantize(palette=palette, dither=Image.Dither.NONE).convert("RGBA")
    result.putalpha(image.getchannel("A"))
    pixels = result.load()
    for y in range(result.height):
        for x in range(result.width):
            if pixels[x, y][3] == 0:
                pixels[x, y] = (0, 0, 0, 0)
    return result


def fit(image, width, height, anchor="center", scale=None):
    scale = scale or min(width / image.width, height / image.height)
    size = (max(1, round(image.width * scale)), max(1, round(image.height * scale)))
    if size[0] > width or size[1] > height:
        raise ValueError("Motiv überschreitet Zielrahmen")
    return image.resize(size, Image.Resampling.NEAREST)


def main():
    (RELEASE / "atlases").mkdir(parents=True, exist_ok=True)
    entries = []
    files = []
    models = {}
    animations = []
    for key, appearance in ACTORS.items():
        if not (SOURCES / f"{key}.png").exists():
            continue
        models[key] = provenance(key)
        original = Image.open(SOURCES / f"{key}.png").convert("RGBA")
        frames = []
        for row in range(4):
            for col in range(5):
                cell, rect = crop_actor_cell(original, 5, 4, col, row)
                content, bounds = cutout(cell)
                frames.append((content, rect, bounds, DIRECTIONS[row], col))
        # Ein gemeinsamer Maßstab je Figur verhindert Animationen mit pumpender Größe.
        scale = min(30 / max(f[0].width for f in frames), 38 / max(f[0].height for f in frames))
        atlas = Image.new("RGBA", (320, 256))
        for index, (content, rect, bounds, direction, col) in enumerate(frames):
            resized = fit(content, 30, 38, scale=scale)
            canvas = Image.new("RGBA", (64, 64))
            canvas.alpha_composite(resized, ((64 - resized.width) // 2, 50 - resized.height))
            canvas = quantize(canvas)
            x, y = (index % 5) * 64, (index // 5) * 64
            atlas.alpha_composite(canvas, (x, y))
            state = "idle" if col == 0 else "walk"
            asset_id = f"actor.{appearance}.{direction}.{state}" + (f".{col}" if col else "")
            entries.append({"id": asset_id, "fileId": key, "rect": {"x": x, "y": y, "width": 64, "height": 64},
                            "category": "actor", "sourceKey": key, "sourceRect": rect, "contentBounds": bounds,
                            "worldWidthMm": 2000, "worldHeightMm": 2000, "pivot": {"x": 32, "y": 50}})
        for direction in DIRECTIONS:
            for state in ("idle", "walk"):
                ids = [f"actor.{appearance}.{direction}.idle"] if state == "idle" else [f"actor.{appearance}.{direction}.walk.{n}" for n in range(1, 5)]
                animations.append({"id": f"{appearance}.{direction}.{state}", "appearanceId": appearance,
                                   "role": "conductor" if appearance.startswith("conductor") else "passenger", "direction": direction, "state": state,
                                   "frames": [{"assetId": id_, "durationMs": 160 if state == "walk" else 1000} for id_ in ids]})
        output = RELEASE / f"atlases/{key}.png"
        atlas.save(output, optimize=False, compress_level=9)
        files.append({"id": key, "path": f"atlases/{key}.png", "sha256": digest(output.read_bytes()), "widthPx": atlas.width, "heightPx": atlas.height, "sourceScale": 1})

    # Einzelne Sitzrichtungen wurden im Ergebnis in anderer Reihenfolge geliefert
    # als angefragt. Diese geprüfte Zuordnung beschreibt die tatsächlichen Pixel.
    extra = []
    if (SOURCES / "seated.png").exists():
        for row, appearance in enumerate(ACTORS.values()):
            for col, direction in enumerate(["south", "west", "north", "east"]):
                asset_id = f"actor.{appearance}.{direction}.sitting"
                extra.append((asset_id, "seated", 4, 5, col, row, 64, 64, "actor"))
                animations.append({"id": f"{appearance}.{direction}.sitting", "appearanceId": appearance,
                                   "role": "conductor" if appearance.startswith("conductor") else "passenger", "direction": direction,
                                   "state": "sitting", "frames": [{"assetId": asset_id, "durationMs": 1000}]})
    interior = {"floor": (0,0), "wall": (1,0), "window": (2,0), "door-closed": (3,0), "door-open": (0,1), "seat": (1,1),
                "multipurpose": (3,1), "wc": (0,2), "cab": (1,2), "gangway": (2,2), "standing": (0,3)}
    if (SOURCES / "interior-topdown.png").exists():
        extra.extend((f"interior.{part}", "interior-topdown", 4, 4, col, row, 64, 64, "interior") for part, (col,row) in interior.items())
    extra.extend((f"vehicle.{part}", "train", 3, 1, col, 0, 96, height, "vehicle") for col, part, height in [(0,"body",640),(1,"front",192),(2,"roof",640)])
    station_sizes = {"platform": [(256,96),(320,128),(384,160)], "roof": [(256,128),(320,160),(384,192)],
                     "hall": [(192,160),(256,192),(320,256)], "stairs": [(96,96),(128,128),(192,128)], "underpass": [(192,160),(256,192),(320,256)]}
    for row, part in enumerate(station_sizes):
        for col, station in enumerate(["small", "medium", "large"]):
            width, height = station_sizes[part][col]
            extra.append((f"station.{station}.{part}", "stations", 3, 5, col, row, width, height, "station"))
    for row, part in enumerate(["vegetation", "road", "building"]):
        for col, environment in enumerate(["rural", "suburban", "urban"]):
            extra.append((f"environment.{environment}.{part}", "environment", 3, 3, col, row, 256, 128 if part == "road" else 256, "environment"))
    for col, state in enumerate(["stop", "proceed"]):
        extra.append((f"signal.{state}", "utilities", 2, 2, col, 0, 32, 96, "signal"))
    for row, kind in enumerate(["wheelchair", "bicycle", "stroller"]):
        for col, direction in enumerate(["north", "east", "south", "west"]):
            if direction in ("north","south") and (SOURCES / "accessories-north-south.png").exists():
                extra.append((f"accessory.{kind}.{direction}", "accessories-north-south", 2, 3, 0 if direction=="north" else 1, row, 64, 64, "accessory"))
            else:
                extra.append((f"accessory.{kind}.{direction}", "accessories", 4, 3, col, row, 64, 64, "accessory"))

    # Das nach Augenprüfung versionierte Quellrechteck korrigiert ungleiche
    # Spaltenbreiten des Generators, ohne ein Motiv zu verformen/neu zu zeichnen.
    station_cols, station_rows = [0,328,740,1254], [0,244,465,738,960,1254]
    sprites = []
    for asset_id, key, cols, rows, col, row, width, height, category in extra:
        if not (SOURCES / f"{key}.png").exists():
            continue
        if key not in models:
            models[key] = provenance(key)
        original = Image.open(SOURCES / f"{key}.png")
        if key == "stations":
            if original.size != (1254,1254):
                raise ValueError("Stationen brauchen eine erneute Prüfung ihrer Ausschnitte")
            rect = (station_cols[col],station_rows[row],station_cols[col+1],station_rows[row+1])
            cell = original.crop(rect)
        elif key == "environment":
            if original.size != (1536,1024):
                raise ValueError("Umgebung braucht eine erneute Prüfung ihrer Ausschnitte")
            edges = [0,320,625,1024]
            rect = (col*512,edges[row],(col+1)*512,edges[row+1])
            cell = original.crop(rect)
        elif category in ("actor", "accessory"):
            cell, rect = crop_actor_cell(original, cols, rows, col, row)
        else:
            cell, rect = crop_cell(original, cols, rows, col, row)
        content, bounds = cutout(cell)
        limit_w, limit_h = ((30,32) if category == "actor" else (32,40) if category == "accessory" else (width,height))
        resized = fit(content, limit_w, limit_h)
        canvas = Image.new("RGBA", (width,height))
        offset_y = 50 - resized.height if category == "actor" else (height-resized.height)//2
        canvas.alpha_composite(resized, ((width-resized.width)//2,offset_y))
        sprites.append((quantize(canvas), asset_id, key, rect, bounds, category))
    # Deterministisches Shelf-Packing, Reihenfolge folgt dem versionierten Katalog.
    atlas = Image.new("RGBA", (2048,2048))
    x, y, row_height = 0, 0, 0
    for sprite, asset_id, key, rect, bounds, category in sprites:
        if x + sprite.width > atlas.width:
            x, y, row_height = 0, y + row_height + 2, 0
        if y + sprite.height > atlas.height:
            raise ValueError("Statischer Atlas ist voll")
        atlas.alpha_composite(sprite, (x,y))
        entries.append({"id": asset_id, "fileId": "modules", "rect": {"x":x,"y":y,"width":sprite.width,"height":sprite.height},
                        "category":category,"sourceKey":key,"sourceRect":rect,"contentBounds":bounds,
                        "worldWidthMm":sprite.width*1000//32,"worldHeightMm":sprite.height*1000//32,
                        "pivot":{"x":sprite.width//2,"y":50 if category=="actor" else sprite.height//2}})
        x += sprite.width + 2
        row_height = max(row_height,sprite.height)
    output = RELEASE / "atlases/modules.png"
    atlas.save(output,optimize=False,compress_level=9)
    files.append({"id":"modules","path":"atlases/modules.png","sha256":digest(output.read_bytes()),"widthPx":atlas.width,"heightPx":atlas.height,"sourceScale":1})
    write_json(RELEASE / "prepared.json", {"schemaVersion": "conductor-art-prepared/v1", "palette": ["#00000000"] + [f"#{color}ff" for color in PALETTE], "files": files, "assets": entries, "animations": animations, "models": models})
    print(json.dumps({"files": len(files), "assets": len(entries), "animations": len(animations), "models": models}))


if __name__ == "__main__":
    main()
