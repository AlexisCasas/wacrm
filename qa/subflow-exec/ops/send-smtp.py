#!/usr/bin/env python3
"""Minimal SMTP transport for wacrm_alerts.py: reads ONE RFC 822 message on stdin and sends it with smtplib.
Config: /etc/wacrm-alerts/smtp.conf (mode 0600, root) with HOST, PORT, SECURITY (starttls|ssl|none: local relay/tests only), USER, PASS. NOT INSTALLED: there is no
SMTP provider configured on this VPS yet. Errors are printed without the password; exit 0 only if the server accepted every recipient."""
import os, smtplib, ssl, sys
from email import message_from_bytes, policy

path = os.environ.get("ALERT_SMTP_CONF", "/etc/wacrm-alerts/smtp.conf")
try:
    if os.stat(path).st_mode & 0o077:
        sys.exit(f"{path} must not be readable by group/others")
    conf = dict(l.strip().split("=", 1) for l in open(path) if "=" in l and not l.lstrip().startswith("#"))
    msg = message_from_bytes(sys.stdin.buffer.read(), policy=policy.SMTP)
    rcpt = [a.strip() for a in str(msg["To"]).split(",") if a.strip()]
    host, port, sec = conf["HOST"], int(conf.get("PORT", "587")), conf.get("SECURITY", "starttls")
    ctx = ssl.create_default_context()
    s = smtplib.SMTP_SSL(host, port, context=ctx, timeout=30) if sec == "ssl" else smtplib.SMTP(host, port, timeout=30)
    with s:
        if sec == "starttls":
            s.starttls(context=ctx)
        if conf.get("USER"):
            s.login(conf["USER"], conf["PASS"])
        refused = s.send_message(msg, to_addrs=rcpt)
    if refused:
        sys.exit(f"recipients refused: {sorted(refused)}")
except SystemExit:
    raise
except Exception as e:  # never echo the config or the password
    sys.exit(f"{type(e).__name__}: {str(e)[:120]}".replace(conf.get("PASS", "\0") if 'conf' in dir() else "\0", "***"))
