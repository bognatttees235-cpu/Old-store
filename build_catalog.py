#!/usr/bin/env python3
# Собирает apps.json из папок apps/ (приложения) и games/ (игры).
# Структура:  apps/Название/Версия/файл.apk + info.txt
import hashlib, json, os, subprocess
from urllib.parse import quote

SDK = {"1.6": 4, "2.0": 5, "2.0.1": 6, "2.1": 7, "2.2": 8, "2.3": 9, "2.3.3": 10, "3.0": 11,
       "3.1": 12, "3.2": 13, "4.0": 14, "4.0.3": 15, "4.1": 16, "4.2": 17, "4.3": 18, "4.4": 19}

def read_info(path):
    info = {}
    if os.path.isfile(path):
        for line in open(path, encoding="utf-8-sig"):
            for sep in ("=", ":"):
                if sep in line:
                    k, v = line.split(sep, 1)
                    info[k.strip().lower()] = v.strip()
                    break
    return info

def vkey(v):
    out = []
    for p in str(v).replace("-", ".").split("."):
        out.append(int(p) if p.isdigit() else 0)
    return out

def sdk_of(android):
    a = str(android).strip()
    if a in SDK:
        return SDK[a]
    for k in sorted(SDK, key=len, reverse=True):
        if a.startswith(k):
            return SDK[k]
    return 4

def commit_time(path):
    try:
        out = subprocess.run(["git", "log", "-1", "--format=%ct", "--", path],
                             capture_output=True, text=True).stdout.strip()
        return int(out) if out else 0
    except Exception:
        return 0

apps = []
for cat, folder in (("app", "apps"), ("game", "games")):
    if not os.path.isdir(folder):
        continue
    for name in sorted(os.listdir(folder)):
        adir = os.path.join(folder, name)
        if not os.path.isdir(adir):
            continue
        ainfo = read_info(os.path.join(adir, "info.txt"))
        icon = ""
        if ainfo.get("icon") and os.path.isfile(os.path.join(adir, ainfo["icon"])):
            icon = quote((adir + "/" + ainfo["icon"]).replace(os.sep, "/"))
        versions = []
        for vname in os.listdir(adir):
            vdir = os.path.join(adir, vname)
            if not os.path.isdir(vdir):
                continue
            info = read_info(os.path.join(vdir, "info.txt"))
            fname = info.get("file")
            if not fname:
                apks = [f for f in os.listdir(vdir) if f.lower().endswith(".apk")]
                fname = apks[0] if apks else ""
            fpath = os.path.join(vdir, fname) if fname else ""
            if not fname or not os.path.isfile(fpath):
                print("ПРОПУЩЕНО (нет APK):", vdir)
                continue
            android = info.get("android", "")
            if android not in SDK:
                print("ВНИМАНИЕ: в", vdir, "не указан или неизвестен android =", android or "(пусто)")
            data = open(fpath, "rb").read()
            versions.append({
                "version": info.get("version", vname),
                "android": android or "1.6",
                "minSdk": sdk_of(android or "1.6"),
                "file": quote(fpath.replace(os.sep, "/")),
                "size": "%.1f МБ" % (len(data) / 1048576),
                "sha256": hashlib.sha256(data).hexdigest(),
                "added": commit_time(vdir),
            })
        if not versions:
            print("ПРОПУЩЕНО (нет версий):", adir)
            continue
        versions.sort(key=lambda v: vkey(v["version"]), reverse=True)
        apps.append({
            "id": cat[0] + hashlib.md5(adir.encode("utf-8")).hexdigest()[:8],
            "name": name, "cat": cat, "desc": ainfo.get("description", ""), "icon": icon,
            "added": max(v["added"] for v in versions), "versions": versions,
        })

with open("apps.json", "w", encoding="utf-8") as f:
    json.dump({"apps": apps}, f, ensure_ascii=False, indent=1)
print("Готово: приложений и игр:", len(apps))
