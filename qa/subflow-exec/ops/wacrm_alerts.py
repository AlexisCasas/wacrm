#!/usr/bin/env python3
"""WACRM alert notifications by e-mail (P12.2). PREPARED, NOT INSTALLED, NOTHING IS SENT UNTIL A TRANSPORT IS CONFIGURED.

It does NOT detect anything: detection stays in alerts-p8.sql / alerts-p8.sh / alerts-p8-monitor.sh (A1-A6).
  journal  Called by the 10-minute monitor after every real check. Keeps the incident table (one entry per code + FULL run id) and an
           append-only journal of opened/resolved events, so an incident that came and went between two reviews is not lost and a
           persistent one is not hidden by the monitor's STILL_FIRING suppression.
  notify   Called by cron at 17:00 and 23:00 UTC (= 12:00 and 18:00 America/Lima). Runs the SAME check once more, adds the operational
           incidents (check failed, monitor stopped, missed review), and sends ONE consolidated mail ONLY if there is something to say.
Exit codes (notify): 0 = nothing to do / sent, 3 = send failed (nothing is marked as notified), 2 = bad configuration.
"""
import fcntl
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from email.utils import format_datetime
from zoneinfo import ZoneInfo

LIMA = ZoneInfo("America/Lima")
SLOT_HOURS = (12, 18)          # local Lima hours of the two reviews
SLOT_WINDOW_MIN = 15           # a run is a review only within the first 15 minutes of a slot
MONITOR_STALE_SECS = 30 * 60   # three missed 10-minute runs
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
HERE = os.path.dirname(os.path.abspath(__file__))

# code -> (severity, what happened, recommended action). No customer data anywhere in this table.
CATALOG = {
    "A1": ("Crítica", "Un envío de WhatsApp de un flujo quedó con resultado desconocido (send_outcome_unknown).",
           "Revisar a mano si el mensaje salió. No reenviar. Cerrar o dejar la ejecución como está según el caso."),
    "A2": ("Crítica", "La recuperación de una ejecución no era segura y se detuvo (recovery_not_safe).",
           "Revisar la ejecución indicada y su historial de eventos; no reanudar a ciegas."),
    "A3": ("Alta", "Una espera de un flujo venció hace más de 5 minutos y no fue reanudada.",
           "Revisar el cron de 1 minuto (/var/log/wacrm-flows-cron.log) y los logs de la aplicación."),
    "A4": ("Alta", "Una ejecución terminada dejó un marco de llamada a subflujo (la migración 072 debería impedirlo).",
           "Investigar el cierre de esa ejecución. No borrar el marco sin revisarlo."),
    "A5": ("Media", "Una ejecución activa lleva más de 30 minutos sin avanzar en un nodo que avanza solo.",
           "Revisar la recuperación (/api/flows/recovery/cron) y el estado de la ejecución."),
    "A6": ("Media", "Una ejecución activa está dentro de un flujo llamado que ya no está activo.",
           "Confirmar si se desactivó un flujo con ejecuciones en curso; reactivarlo o cerrar la ejecución."),
    "M1": ("Alta", "El monitor no pudo consultar la base de datos (error SQL o servicio): no se sabe si hay incidencias.",
           "Revisar /var/log/wacrm-alerts-p8.log y el estado de supabase-db."),
    "M2": ("Alta", "El monitor local dejó de ejecutarse correctamente (sin una ejecución buena en más de 30 minutos).",
           "Revisar /etc/cron.d/wacrm-alerts, el servicio cron y /var/log/wacrm-alerts-p8.log."),
    "M3": ("Media", "Una revisión de notificación anterior no se ejecutó.",
           "Revisar el servicio cron y /var/log/wacrm-alerts-notify.log."),
}


def env(name, default):
    return os.environ.get(name, default)


def paths():
    d = env("ALERT_DIR", "/var/lib/wacrm-alerts")
    return {
        "dir": d, "inc": os.path.join(d, "incidents.json"), "jour": os.path.join(d, "journal.jsonl"),
        "nst": os.path.join(d, "notify-state.json"), "lock": os.path.join(d, ".lock"),
        "log": env("ALERT_NOTIFY_LOG", "/var/log/wacrm-alerts-notify.log"),
        "monstate": env("ALERT_MONITOR_STATE", "/var/lib/wacrm-alerts-p8.state"),
    }


def now():
    v = os.environ.get("ALERT_NOW")
    if v:
        return datetime.fromisoformat(v.replace("Z", "+00:00")).astimezone(timezone.utc)
    return datetime.now(timezone.utc)


def iso(t):
    return t.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_iso(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def lima_text(t, fmt="%d/%m/%Y %H:%M"):
    return t.astimezone(LIMA).strftime(fmt)


def log(p, msg):
    try:
        old = os.umask(0o027)
        with open(p["log"], "a") as f:
            f.write(f"{iso(now())} {msg}\n")
        os.umask(old)
    except OSError:
        sys.stderr.write(f"log write failed: {msg}\n")


def load_json(path, default):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def save_json(path, data):
    tmp = f"{path}.tmp.{os.getpid()}"
    old = os.umask(0o077)
    with open(tmp, "w") as f:
        json.dump(data, f, indent=1, sort_keys=True)
        f.flush()
        os.fsync(f.fileno())
    os.umask(old)
    os.replace(tmp, path)


class Locked:
    def __init__(self, p):
        os.makedirs(p["dir"], mode=0o750, exist_ok=True)
        self.f = open(p["lock"], "a")

    def __enter__(self):
        fcntl.flock(self.f, fcntl.LOCK_EX)
        return self

    def __exit__(self, *a):
        fcntl.flock(self.f, fcntl.LOCK_UN)
        self.f.close()


def journal_event(p, ev):
    old = os.umask(0o077)
    with open(p["jour"], "a") as f:
        f.write(json.dumps(ev, sort_keys=True) + "\n")
    os.umask(old)


# ------------------------------------------------------------------ incident table
def parse_check(out):
    """alerts-p8.sh lines: NAME count short fullids  ->  set of incident keys, or None if the output is not the expected 6 lines."""
    keys, seen = {}, 0
    for line in out.splitlines():
        parts = line.split()
        if len(parts) < 2 or not re.match(r"^A[1-6]_", parts[0]) or not parts[1].isdigit():
            continue
        seen += 1
        code, n = parts[0][:2], int(parts[1])
        ids = [i for i in (parts[3].split(",") if len(parts) >= 4 else []) if UUID.match(i)]
        if n > 0 and not ids:
            keys[f"{code}:unknown"] = (code, "unknown")   # never silently drop a firing alert whose id is missing
        for i in ids:
            keys[f"{code}:{i}"] = (code, i)
    return keys if seen == 6 else None


def apply_state(inc, key, code, ident, active, ts, p, detail=None):
    """Open / refresh / resolve one incident. Returns True if it changed."""
    cur = inc.get(key)
    if active:
        if cur is None or cur.get("resolved_at"):
            inc[key] = {"code": code, "id": ident, "first_seen": iso(ts), "last_seen": iso(ts), "resolved_at": None,
                        "reported_resolved": False, "last_notified_at": None, "detail": detail,
                        "reopened": (cur.get("reopened", 0) + 1) if cur else 0}
            journal_event(p, {"ts": iso(ts), "event": "opened", "key": key})
            return True
        cur["last_seen"] = iso(ts)
        return False
    if cur is not None and not cur.get("resolved_at"):
        cur["resolved_at"] = iso(ts)
        cur["reported_resolved"] = False
        journal_event(p, {"ts": iso(ts), "event": "resolved", "key": key})
        return True
    return False


def record_check(inc, rc, out, ts, p):
    """rc 0/1 = the check answered (set of firing incidents); anything else = the CHECK FAILED, which is an incident, never 'zero alerts'."""
    if rc in (0, 1):
        keys = parse_check(out)
        if keys is not None:
            for key, (code, ident) in keys.items():
                apply_state(inc, key, code, ident, True, ts, p)
            for key, cur in list(inc.items()):
                if cur["code"].startswith("A") and key not in keys:
                    apply_state(inc, key, cur["code"], cur["id"], False, ts, p)
            apply_state(inc, "M1:check", "M1", "check", False, ts, p)
            return True
    detail = re.sub(r"[^\x20-\x7e]", "", (out or "").splitlines()[0] if (out or "").strip() else f"rc={rc}")[:120]
    apply_state(inc, "M1:check", "M1", "check", True, ts, p, detail)
    return False


def cmd_journal(rc, out):
    p = paths()
    with Locked(p):
        inc = load_json(p["inc"], {})
        record_check(inc, rc, out, now(), p)
        save_json(p["inc"], inc)


# ------------------------------------------------------------------ review
def known_ids():
    path = env("ALERT_KNOWN_FILE", os.path.join(HERE, "known-frames.txt"))
    try:
        with open(path) as f:
            return [l.strip() for l in f if UUID.match(l.strip())]
    except OSError:
        return []


def run_check():
    cmd = env("ALERT_CHECK_CMD", os.path.join(HERE, "alerts-p8.sh"))
    try:
        r = subprocess.run([cmd, env("ALERT_HOURS", "24")] + known_ids(), capture_output=True, text=True, timeout=60)
        return r.returncode, (r.stdout if r.returncode in (0, 1) else (r.stderr or r.stdout))
    except (OSError, subprocess.TimeoutExpired) as e:
        return 2, f"CHECK_FAILED {type(e).__name__}"


def slot_for(t, forced):
    if forced:
        return forced
    l = t.astimezone(LIMA)
    for h in SLOT_HOURS:
        if l.hour == h and l.minute < SLOT_WINDOW_MIN:
            return f"{l:%Y-%m-%d}-{h:02d}00"
    return None


def slot_start_utc(slot):
    d, hhmm = slot.rsplit("-", 1)
    return datetime.fromisoformat(f"{d}T{hhmm[:2]}:{hhmm[2:]}:00").replace(tzinfo=LIMA).astimezone(timezone.utc)


def previous_slot(slot):
    t = slot_start_utc(slot).astimezone(LIMA)
    cands = []
    for back in (0, 1):
        for h in SLOT_HOURS:
            c = (t - timedelta(days=back)).replace(hour=h, minute=0, second=0, microsecond=0)
            if c < t:
                cands.append(c)
    c = max(cands)
    return f"{c:%Y-%m-%d}-{c.hour:02d}00"


def load_config(p):
    conf = {}
    path = env("ALERT_NOTIFY_CONF", "/etc/wacrm-alerts/notify.conf")
    try:
        st = os.stat(path)
        if st.st_mode & 0o077:
            return None, f"{path} must not be readable by group/others"
        for line in open(path):
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                conf[k.strip()] = v.strip()
    except OSError:
        return None, f"cannot read {path}"
    rec = [r.strip() for r in conf.get("RECIPIENTS", "").split(",") if r.strip()]
    if not rec or not conf.get("FROM") or not conf.get("TRANSPORT"):
        return None, "RECIPIENTS, FROM and TRANSPORT are required"
    conf["recipients"] = rec
    return conf, None


def build_message(conf, slot, items, review_ts):
    active = [i for i in items if not i.get("resolved_at")]
    when = slot_start_utc(slot)
    m = EmailMessage()
    m["Subject"] = f"[WACRM] Alertas detectadas — {lima_text(when, '%d/%m/%Y')} — {lima_text(when, '%H:%M')}"
    m["From"], m["To"] = conf["FROM"], ", ".join(conf["recipients"])
    m["Date"] = format_datetime(review_ts)
    m["Message-ID"] = f"<wacrm-alerts-{slot}@wacrm.local>"
    lines = [f"Revisión: {lima_text(review_ts)} (hora de Perú)",
             f"Incidencias en este informe: {len(items)}  (activas: {len(active)}, resueltas: {len(items) - len(active)})", ""]
    order = {"Crítica": 0, "Alta": 1, "Media": 2}
    for n, i in enumerate(sorted(items, key=lambda i: (order[CATALOG[i["code"]][0]], i["first_seen"])), 1):
        sev, what, action = CATALOG[i["code"]]
        state = "ACTIVA" if not i.get("resolved_at") else f"RESUELTA ({lima_text(parse_iso(i['resolved_at']))})"
        ident = i["code"] if i["id"] in ("check", "monitor", "review") else f"{i['code']} · ejecución {i['id']}"
        lines += [f"{n}. [{sev}] {ident}", f"   Qué pasó: {what}", f"   Estado: {state}",
                  f"   Detectada aprox.: {lima_text(parse_iso(i['first_seen']))} (hora de Perú)"]
        if i.get("detail") and i["code"] == "M1":
            lines.append(f"   Detalle técnico: {i['detail']}")
        lines += [f"   Acción recomendada: {action}", ""]
    lines += ["Este informe solo se envía cuando hay incidencias. Las incidencias activas se repiten en cada revisión (12:00 y 18:00, hora de Perú)",
              "hasta resolverse. Las resueltas aparecen una sola vez."]
    m.set_content("\n".join(lines))
    return m


def cmd_notify(forced_slot=None):
    p = paths()
    with Locked(p):
        t = now()
        slot = slot_for(t, forced_slot)
        if slot is None:
            log(p, f"NOTIFY skip: {lima_text(t, '%H:%M')} Lima is not a review slot")
            return 0
        nst = load_json(p["nst"], {"reviews": {}})
        done = nst["reviews"].get(slot, {}).get("status")
        if done in ("sent", "clean"):
            log(p, f"NOTIFY skip: slot {slot} already {done}")
            return 0
        inc = load_json(p["inc"], {})
        # 1) the same check as the monitor, right now
        rc, out = run_check()
        record_check(inc, rc, out, t, p)
        # 2) the periodic monitor itself must have produced a good run recently
        try:
            last_ok = int(open(p["monstate"]).readline().strip())
            stale = t.timestamp() - last_ok > MONITOR_STALE_SECS
        except (OSError, ValueError):
            stale = True
        apply_state(inc, "M2:monitor", "M2", "monitor", stale, t, p)
        # 3) a review that did not happen
        last = nst.get("last_slot")
        if last and last != slot and last != previous_slot(slot) and nst["reviews"].get(last, {}).get("status") in ("sent", "clean"):
            if apply_state(inc, f"M3:{slot}", "M3", "review", True, t, p):
                apply_state(inc, f"M3:{slot}", "M3", "review", False, t, p)   # informational: reported once as resolved
        items = [dict(v, key=k) for k, v in inc.items() if not v.get("resolved_at") or not v.get("reported_resolved")]
        rev = nst["reviews"].setdefault(slot, {"attempts": 0})
        rev["attempts"] += 1
        rev["at"] = iso(t)
        if not items:
            rev["status"] = "clean"
            nst["last_slot"], nst["last_review_end"] = slot, iso(t)
            save_json(p["inc"], inc); save_json(p["nst"], nst)
            log(p, f"NOTIFY slot {slot}: no incidents, no mail")
            return 0
        conf, err = load_config(p)
        if conf is None:
            rev["status"] = "failed"
            save_json(p["inc"], inc); save_json(p["nst"], nst)
            log(p, f"NOTIFY_ERROR slot {slot}: configuration: {err}")
            return 2
        msg = build_message(conf, slot, items, t)
        try:
            r = subprocess.run(conf["TRANSPORT"].split(), input=msg.as_bytes(), capture_output=True, timeout=90)
            ok, why = r.returncode == 0, re.sub(r"[^\x20-\x7e]", "", r.stderr.decode("utf-8", "replace")[:160])
        except (OSError, subprocess.TimeoutExpired) as e:
            ok, why = False, type(e).__name__
        if not ok:
            rev["status"] = "failed"
            save_json(p["inc"], inc); save_json(p["nst"], nst)       # incidents stay un-notified: the next review carries them
            log(p, f"NOTIFY_ERROR slot {slot}: send failed ({why}); {len(items)} incident(s) stay pending")
            return 3
        for i in items:
            cur = inc[i["key"]]
            cur["last_notified_at"] = iso(t)
            if cur.get("resolved_at"):
                cur["reported_resolved"] = True
        # housekeeping: forget resolved+reported incidents after 7 days
        for k, v in list(inc.items()):
            if v.get("resolved_at") and v.get("reported_resolved") and t - parse_iso(v["resolved_at"]) > timedelta(days=7):
                del inc[k]
        rev["status"] = "sent"
        nst["last_slot"], nst["last_review_end"] = slot, iso(t)
        save_json(p["inc"], inc); save_json(p["nst"], nst)
        log(p, f"NOTIFY slot {slot}: mail sent, {len(items)} incident(s), codes {','.join(sorted({i['code'] for i in items}))}")
        return 0


def main(argv):
    if len(argv) >= 2 and argv[1] == "journal":
        rc = int(argv[argv.index("--rc") + 1]) if "--rc" in argv else 2
        cmd_journal(rc, sys.stdin.read())
        return 0
    if len(argv) >= 2 and argv[1] == "notify":
        return cmd_notify(argv[argv.index("--slot") + 1] if "--slot" in argv else None)
    sys.stderr.write("usage: wacrm_alerts.py journal --rc N < check-output | notify [--slot YYYY-MM-DD-HHMM]\n")
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
