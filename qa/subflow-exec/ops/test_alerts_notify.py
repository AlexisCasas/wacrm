"""P12.2 tests for wacrm_alerts.py with a SIMULATED mail provider. No real e-mail is ever sent: the transport is a script that writes
the message to a spool directory (or fails on demand). The only production contact is the read-only monitor query in test_08b."""
import asyncio, importlib.util, json, os, re, shutil, stat, subprocess, sys, tempfile, threading, unittest
from datetime import datetime, timedelta, timezone
from email import message_from_bytes, policy

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("wacrm_alerts", os.path.join(HERE, "wacrm_alerts.py"))
wa = importlib.util.module_from_spec(spec); spec.loader.exec_module(wa)
U1, U2, U3 = ("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333")
KNOWN = "d3408025-6191-4a6d-95c4-574bfe71e0e7"
NAMES = ["A1_send_outcome_unknown", "A2_recovery_not_safe", "A3_overdue_wait_not_resumed", "A4_frames_on_ended_runs",
         "A5_stranded_run_not_recovered", "A6_run_inside_flow_that_is_not_active"]
RECIPIENTS = ["pilot.owner@example.test", "ops@example.test"]


def canned(**firing):  # firing: A1=[uuid,...]
    out = []
    for n in NAMES:
        ids = firing.get(n[:2], [])
        out.append(f"{n:<40} {len(ids)} {','.join(i[:8] for i in ids)} {','.join(ids)}")
    return "\n".join(out) + "\n"


class Base(unittest.TestCase):
    def setUp(self):
        self.t = tempfile.mkdtemp(prefix="wa-notify-")
        t = self.t
        for d in ("spool", "canned", "state"):
            os.makedirs(os.path.join(t, d))
        open(f"{t}/transport.py", "w").write(
            "#!/usr/bin/env python3\nimport os,sys,glob\nd=os.environ['SPOOL']\n"
            "if os.path.exists(d+'/FAIL'):\n    sys.stderr.write('421 provider busy\\n'); sys.exit(1)\n"
            "n=len(glob.glob(d+'/*.eml'))+1\nopen(d+f'/{n}.eml','wb').write(sys.stdin.buffer.read())\n")
        open(f"{t}/check.sh", "w").write("#!/bin/sh\necho \"$@\" > $CANNED/args\ncat $CANNED/out\n[ -f $CANNED/err ] && cat $CANNED/err >&2\nexit $(cat $CANNED/rc)\n")
        for f in ("transport.py", "check.sh"):
            os.chmod(f"{t}/{f}", 0o755)
        open(f"{t}/notify.conf", "w").write(f"RECIPIENTS={','.join(RECIPIENTS)}\nFROM=wacrm-alertas@example.test\nTRANSPORT={t}/transport.py\n")
        os.chmod(f"{t}/notify.conf", 0o600)
        open(f"{t}/known.txt", "w").write(f"# historic\n{KNOWN}\n")
        self.env = {"ALERT_DIR": f"{t}/state", "ALERT_NOTIFY_LOG": f"{t}/notify.log", "ALERT_MONITOR_STATE": f"{t}/monstate",
                    "ALERT_NOTIFY_CONF": f"{t}/notify.conf", "ALERT_CHECK_CMD": f"{t}/check.sh", "ALERT_KNOWN_FILE": f"{t}/known.txt",
                    "SPOOL": f"{t}/spool", "CANNED": f"{t}/canned", "ALERT_NOW": "2026-10-15T17:00:30Z"}
        self.saved = dict(os.environ)
        os.environ.update(self.env)
        self.check(canned(), 0)
        self.monitor_ok("2026-10-15T16:55:00Z")

    def tearDown(self):
        os.environ.clear(); os.environ.update(self.saved)
        shutil.rmtree(self.t, ignore_errors=True)

    def check(self, out, rc, err=None):
        open(f"{self.t}/canned/out", "w").write(out); open(f"{self.t}/canned/rc", "w").write(str(rc))
        if err is None:
            shutil.rmtree(f"{self.t}/canned/err", ignore_errors=True) if os.path.isdir(f"{self.t}/canned/err") else (os.path.exists(f"{self.t}/canned/err") and os.remove(f"{self.t}/canned/err"))
        else:
            open(f"{self.t}/canned/err", "w").write(err)

    def monitor_ok(self, at):
        open(self.env["ALERT_MONITOR_STATE"], "w").write(f"{int(wa.parse_iso(at).timestamp())}\nok\n0\n")

    def at(self, ts):
        os.environ["ALERT_NOW"] = ts

    def journal(self, ts, rc, out):  # what the 10-minute monitor does after each real check
        self.at(ts); wa.cmd_journal(rc, out)

    def notify(self, ts):
        self.at(ts); return wa.cmd_notify()

    def mails(self):
        return [message_from_bytes(open(f, "rb").read(), policy=policy.default) for f in sorted(
            os.path.join(self.t, "spool", x) for x in os.listdir(f"{self.t}/spool") if x.endswith(".eml"))]

    def body(self, m):
        return m.get_body().get_content()


class T(Base):
    def test_01_zero_alerts_zero_mail(self):
        self.assertEqual(self.notify("2026-10-15T17:00:30Z"), 0)
        self.assertEqual(self.mails(), [])
        self.assertIn("no incidents, no mail", open(f"{self.t}/notify.log").read())
        self.assertEqual(json.load(open(f"{self.t}/state/notify-state.json"))["reviews"]["2026-10-15-1200"]["status"], "clean")

    def test_02_single_A1_one_mail_both_recipients(self):
        self.check(canned(A1=[U1]), 1)
        self.assertEqual(self.notify("2026-10-15T17:00:30Z"), 0)
        ms = self.mails(); self.assertEqual(len(ms), 1)
        self.assertEqual([a.strip() for a in ms[0]["To"].split(",")], RECIPIENTS)
        self.assertEqual(ms[0]["Subject"], "[WACRM] Alertas detectadas — 15/10/2026 — 12:00")
        b = self.body(ms[0])
        for needle in ("Incidencias en este informe: 1", "[Crítica]", f"A1 · ejecución {U1}", "Estado: ACTIVA", "Acción recomendada", "Detectada aprox."):
            self.assertIn(needle, b)

    def test_03_several_alerts_one_consolidated_mail(self):
        self.check(canned(A1=[U1], A3=[U2, U3], A6=[U1]), 1)
        self.notify("2026-10-15T17:00:30Z")
        ms = self.mails(); self.assertEqual(len(ms), 1)
        b = self.body(ms[0]); self.assertIn("Incidencias en este informe: 4", b)
        for c in ("A1 ·", "A3 ·", "A6 ·"):
            self.assertIn(c, b)
        self.assertLess(b.index("[Crítica]"), b.index("[Alta]"))

    def test_04_persistent_alert_comes_back_next_review_even_if_monitor_suppresses_it(self):
        self.check(canned(A3=[U1]), 1)
        self.journal("2026-10-15T16:50:00Z", 1, canned(A3=[U1]))
        self.notify("2026-10-15T17:00:30Z")
        for ts in ("2026-10-15T17:10:00Z", "2026-10-15T20:00:00Z", "2026-10-15T22:50:00Z"):   # monitor keeps seeing it (log says STILL_FIRING)
            self.journal(ts, 1, canned(A3=[U1]))
        self.monitor_ok("2026-10-15T22:55:00Z")
        self.notify("2026-10-15T23:00:30Z")
        ms = self.mails(); self.assertEqual(len(ms), 2)
        self.assertEqual(ms[1]["Subject"], "[WACRM] Alertas detectadas — 15/10/2026 — 18:00")
        self.assertIn("Estado: ACTIVA", self.body(ms[1]))
        self.assertIn("15/10/2026 11:50", self.body(ms[1]))  # first_seen kept: 16:50Z = 11:50 Lima, not reset

    def test_05_resolved_inside_period_is_reported_once_as_resolved(self):
        self.journal("2026-10-15T13:00:00Z", 1, canned(A5=[U2]))      # opens (08:00 Lima)
        self.journal("2026-10-15T15:00:00Z", 0, canned())             # resolves
        self.notify("2026-10-15T17:00:30Z")                           # the review sees ZERO active, still reports it
        ms = self.mails(); self.assertEqual(len(ms), 1)
        b = self.body(ms[0]); self.assertIn("RESUELTA", b); self.assertIn("08:00", b); self.assertNotIn("Estado: ACTIVA", b)
        self.monitor_ok("2026-10-15T22:55:00Z"); self.notify("2026-10-15T23:00:30Z")
        self.assertEqual(len(self.mails()), 1)                        # not repeated

    def test_06_known_historic_frame_makes_no_mail(self):
        # the check command receives the known id as an argument and (like the real SQL) excuses it in A4 only
        self.check(canned(A4=[KNOWN]), 1); open(f"{self.t}/check.sh", "w").write(
            "#!/bin/sh\necho \"$@\" > $CANNED/args\ncase \"$*\" in *d3408025-6191-4a6d-95c4-574bfe71e0e7*) cat $CANNED/zero;; *) cat $CANNED/out;; esac\nexit 0\n")
        open(f"{self.t}/canned/zero", "w").write(canned())
        self.notify("2026-10-15T17:00:30Z"); self.assertEqual(self.mails(), [])
        args = open(f"{self.t}/canned/args").read().split(); self.assertEqual(args, ["24", KNOWN])   # exactly one id, nothing else excused

    def test_07_new_residual_frame_does_mail(self):
        open(f"{self.t}/check.sh", "w").write(
            "#!/bin/sh\necho \"$@\" > $CANNED/args\ncat $CANNED/out\nexit 1\n")
        self.check(canned(A4=[U3]), 1)
        self.notify("2026-10-15T17:00:30Z")
        ms = self.mails(); self.assertEqual(len(ms), 1); self.assertIn(f"A4 · ejecución {U3}", self.body(ms[0]))
        self.assertNotIn(KNOWN, self.body(ms[0]))

    def test_08a_check_failure_is_an_incident_not_zero_alerts(self):
        self.check("", 2, err="CHECK_FAILED psql_rc=3 ERROR:  division by zero\n")
        self.notify("2026-10-15T17:00:30Z")
        ms = self.mails(); self.assertEqual(len(ms), 1)
        b = self.body(ms[0]); self.assertIn("no se sabe si hay incidencias", b); self.assertIn("division by zero", b)

    def test_08b_real_monitor_script_with_a_failing_sql_file(self):
        if subprocess.run(["docker", "inspect", "supabase-db"], capture_output=True).returncode != 0:
            self.skipTest("no database container here")
        bad = f"{self.t}/bad.sql"; open(bad, "w").write("select 1/0;\n")       # read-only session; production data untouched
        os.environ.update({"ALERT_CHECK_CMD": os.path.join(HERE, "alerts-p8.sh"), "ALERT_SQL_FILE": bad})
        self.notify("2026-10-15T17:00:30Z")
        ms = self.mails(); self.assertEqual(len(ms), 1); self.assertIn("no se sabe si hay incidencias", self.body(ms[0]))

    def test_09_monitor_stopped_is_an_incident(self):
        self.monitor_ok("2026-10-15T14:00:00Z")                      # last good run 3 h before the review
        self.notify("2026-10-15T17:00:30Z")
        ms = self.mails(); self.assertEqual(len(ms), 1); self.assertIn("dejó de ejecutarse", self.body(ms[0]))
        os.remove(self.env["ALERT_MONITOR_STATE"]); shutil.rmtree(f"{self.t}/state"); os.makedirs(f"{self.t}/state"); shutil.rmtree(f"{self.t}/spool"); os.makedirs(f"{self.t}/spool")
        self.notify("2026-10-15T17:00:30Z"); self.assertEqual(len(self.mails()), 1)      # no state file at all = also an incident

    def test_10_provider_failure_loses_nothing(self):
        self.check(canned(A1=[U1]), 1); open(f"{self.t}/spool/FAIL", "w").close()
        self.assertEqual(self.notify("2026-10-15T17:00:30Z"), 3)
        self.assertEqual(self.mails(), [])
        inc = json.load(open(f"{self.t}/state/incidents.json")); self.assertIsNone(inc[f"A1:{U1}"]["last_notified_at"])
        self.assertIn("NOTIFY_ERROR", open(f"{self.t}/notify.log").read())
        self.assertEqual(json.load(open(f"{self.t}/state/notify-state.json"))["reviews"]["2026-10-15-1200"]["status"], "failed")
        self.journal("2026-10-15T20:00:00Z", 0, canned())             # it resolves before the next review
        os.remove(f"{self.t}/spool/FAIL"); self.check(canned(), 0); self.monitor_ok("2026-10-15T22:55:00Z")
        self.assertEqual(self.notify("2026-10-15T23:00:30Z"), 0)
        ms = self.mails(); self.assertEqual(len(ms), 1)
        self.assertIn(U1, self.body(ms[0])); self.assertIn("RESUELTA", self.body(ms[0]))

    def test_11_same_slot_twice_sends_once(self):
        self.check(canned(A1=[U1]), 1)
        self.notify("2026-10-15T17:00:30Z"); self.notify("2026-10-15T17:05:00Z"); self.notify("2026-10-15T17:14:59Z")
        self.assertEqual(len(self.mails()), 1)
        self.assertIn("already sent", open(f"{self.t}/notify.log").read())

    def test_12_peru_hours(self):
        d = datetime(2026, 1, 1, tzinfo=timezone.utc)
        for k in range(366):                                          # Peru has no daylight saving: every day of the year
            day = d + timedelta(days=k)
            s1 = wa.slot_for(day.replace(hour=17, minute=0, second=10), None); s2 = wa.slot_for(day.replace(hour=23, minute=0, second=10), None)
            self.assertTrue(s1.endswith("-1200") and s2.endswith("-1800"), (day, s1, s2))
            for h, m in ((16, 59), (17, 15), (17, 30), (12, 0), (18, 0), (22, 59), (23, 15), (5, 0)):
                self.assertIsNone(wa.slot_for(day.replace(hour=h, minute=m), None), (day, h, m))
        self.check(canned(A1=[U1]), 1)
        self.notify("2026-10-15T23:00:05Z"); self.assertEqual(self.mails()[0]["Subject"], "[WACRM] Alertas detectadas — 15/10/2026 — 18:00")
        cron = open(os.path.join(HERE, "cron.d-wacrm-alerts-notify.example")).read()
        self.assertEqual(re.findall(r"^(\d+ \d+) \* \* \* root", cron, re.M), ["0 17", "0 23"])

    def test_12b_runs_outside_the_slots_do_nothing(self):
        self.check(canned(A1=[U1]), 1)
        for ts in ("2026-10-15T09:00:00Z", "2026-10-15T17:40:00Z", "2026-10-15T23:30:00Z"):
            self.assertEqual(self.notify(ts), 0)
        self.assertEqual(self.mails(), [])

    def test_13_no_sensitive_data(self):
        self.check(canned(A1=[U1], A2=[U2], A3=[U3], A4=[U1], A5=[U2], A6=[U3]), 1)
        self.notify("2026-10-15T17:00:30Z")
        b = re.sub(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", "<run-id>", self.body(self.mails()[0]))
        for bad in (r"\+?\d{9,}", r"(?i)token", r"(?i)secret", r"eyJ", r"(?i)password", r"@c\.us|@s\.whatsapp"):
            self.assertIsNone(re.search(bad, b), bad)
        self.assertLess(len(b), 6000)

    def test_14_world_readable_config_is_refused(self):
        os.chmod(f"{self.t}/notify.conf", 0o644); self.check(canned(A1=[U1]), 1)
        self.assertEqual(self.notify("2026-10-15T17:00:30Z"), 2); self.assertEqual(self.mails(), [])

    def test_15_missed_review_is_reported(self):
        self.notify("2026-10-15T17:00:30Z")                           # clean
        self.notify("2026-10-16T17:00:30Z")                           # the 18:00 of the 15th and nothing in between never ran
        ms = self.mails(); self.assertEqual(len(ms), 1); self.assertIn("revisión de notificación anterior no se ejecutó", self.body(ms[0]))

    def test_16_garbled_check_output_is_a_failure(self):
        self.check("only one line\n", 0)
        self.notify("2026-10-15T17:00:30Z"); self.assertEqual(len(self.mails()), 1)

    def test_17_a_failed_check_never_resolves_open_incidents(self):
        self.journal("2026-10-15T16:00:00Z", 1, canned(A3=[U1]))
        self.journal("2026-10-15T16:10:00Z", 2, "CHECK_FAILED psql_rc=1 down")
        inc = json.load(open(f"{self.t}/state/incidents.json")); self.assertIsNone(inc[f"A3:{U1}"]["resolved_at"]); self.assertIsNone(inc["M1:check"]["resolved_at"])
        self.journal("2026-10-15T16:20:00Z", 0, canned())
        inc = json.load(open(f"{self.t}/state/incidents.json")); self.assertTrue(inc[f"A3:{U1}"]["resolved_at"]); self.assertTrue(inc["M1:check"]["resolved_at"])

    def test_18_incident_identity_uses_full_run_id(self):
        self.journal("2026-10-15T16:00:00Z", 1, canned(A3=[U1, "11111111-1111-4111-8111-111111111112"]))
        self.assertEqual(sorted(json.load(open(f"{self.t}/state/incidents.json"))), [f"A3:{U1}", "A3:11111111-1111-4111-8111-111111111112"])   # same 8-char prefix, two incidents


class FakeSmtp:
    def __init__(self, reject=False):
        self.msgs, self.reject, self.ready = [], reject, threading.Event()
        self.thread = threading.Thread(target=self._run, daemon=True); self.thread.start(); self.ready.wait(5)

    def _run(self):
        async def handle(r, w):
            w.write(b"220 fake\r\n"); rcpts, data = [], None
            while True:
                line = (await r.readline()).decode().strip()
                if not line: break
                c = line.upper()
                if c.startswith("EHLO") or c.startswith("HELO"): w.write(b"250 ok\r\n")
                elif c.startswith("MAIL"): w.write(b"250 ok\r\n")
                elif c.startswith("RCPT"):
                    if self.reject: w.write(b"550 no\r\n")
                    else: rcpts.append(line); w.write(b"250 ok\r\n")
                elif c == "DATA":
                    w.write(b"354 go\r\n"); buf = b""
                    while not buf.endswith(b"\r\n.\r\n"): buf += await r.readline()
                    self.msgs.append((rcpts, buf)); w.write(b"250 queued\r\n")
                elif c == "QUIT": w.write(b"221 bye\r\n"); break
                else: w.write(b"250 ok\r\n")
                await w.drain()
            await w.drain(); w.close()
        async def main():
            srv = await asyncio.start_server(handle, "127.0.0.1", 0); self.port = srv.sockets[0].getsockname()[1]; self.ready.set()
            async with srv: await srv.serve_forever()
        asyncio.run(main())


class SmtpTransport(unittest.TestCase):
    def run_sender(self, srv):
        d = tempfile.mkdtemp(); conf = f"{d}/smtp.conf"
        open(conf, "w").write(f"HOST=127.0.0.1\nPORT={srv.port}\nSECURITY=none\nUSER=\nPASS=\n"); os.chmod(conf, 0o600)
        msg = f"From: a@example.test\r\nTo: {', '.join(RECIPIENTS)}\r\nSubject: test\r\n\r\nhola\r\n".encode()
        r = subprocess.run([sys.executable, os.path.join(HERE, "send-smtp.py")], input=msg, capture_output=True, env={**os.environ, "ALERT_SMTP_CONF": conf})
        shutil.rmtree(d); return r

    def test_19_smtp_sender_delivers_to_both_recipients(self):
        s = FakeSmtp(); r = self.run_sender(s)
        self.assertEqual(r.returncode, 0, r.stderr); self.assertEqual(len(s.msgs), 1); self.assertEqual(len(s.msgs[0][0]), 2)

    def test_20_smtp_sender_fails_when_recipients_are_refused(self):
        r = self.run_sender(FakeSmtp(reject=True)); self.assertNotEqual(r.returncode, 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
