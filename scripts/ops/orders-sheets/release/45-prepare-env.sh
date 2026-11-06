#!/usr/bin/env bash
# Adds the three Sheets variables to the server env file (read by compose at container creation). CONFIRM=yes. Secrets are read from the protected JSON and
# written ONLY to the env file (mode 600): never printed, never logged, never passed as arguments. The previous env file is saved first (mode 600).
#   ORDERS_SHEETS_EXPORT_ENABLED=true  (global switch: inert until a destination is enabled in the DB)   GOOGLE_SHEETS_SA_EMAIL   GOOGLE_SHEETS_SA_KEY_B64
. "$(dirname "$0")/lib.sh"; need_confirm; umask 077
python3 -I - "$SA_JSON" "$ENV_FILE" "$D/env.local.pre-sheets.bak" <<'PY'
import json,base64,sys,os,shutil,stat
sa,env,bak=sys.argv[1:4]
d=json.load(open(sa))
assert d.get('type')=='service_account' and d['client_email'].endswith('.iam.gserviceaccount.com') and d['private_key'].startswith('-----BEGIN PRIVATE KEY-----'), 'bad service-account json'
assert stat.S_IMODE(os.stat(env).st_mode)==0o600, 'env file must be mode 600'
want={'ORDERS_SHEETS_EXPORT_ENABLED':'true','GOOGLE_SHEETS_SA_EMAIL':d['client_email'],'GOOGLE_SHEETS_SA_KEY_B64':base64.b64encode(d['private_key'].encode()).decode()}
lines=open(env).read().split('\n'); have={l.split('=',1)[0]:l.split('=',1)[1] for l in lines if '=' in l and not l.startswith('#')}
todo=[]
for k,v in want.items():
    if k in have:
        if have[k]!=v: sys.exit(f'REFUSING: {k} already present with a different value (resolve by hand)')
    else: todo.append(k)
if not todo: print('env file already has the 3 variables (names only):',', '.join(want)); sys.exit(0)
if not os.path.exists(bak): shutil.copy2(env,bak); os.chmod(bak,0o600)
with open(env,'a') as f:
    if lines and lines[-1]!='': f.write('\n')
    f.write('# --- Google Sheets export (PR #82). Added by the release package; the key is the service account\'s private key (base64).\n')
    for k in todo: f.write(f'{k}={want[k]}\n')
print('added variables (names only):',', '.join(todo))
PY
rc=$?; [ $rc -eq 0 ] || exit $rc
chk "env file mode" "$(stat -c %a $ENV_FILE)" 600
chk "the 3 names are present exactly once" "$(grep -cE '^(ORDERS_SHEETS_EXPORT_ENABLED|GOOGLE_SHEETS_SA_EMAIL|GOOGLE_SHEETS_SA_KEY_B64)=' $ENV_FILE)" 3
chk "all other variable names unchanged" "$(diff <(grep -oE '^[A-Z_]+=' $D/env.local.pre-sheets.bak | sort) <(grep -oE '^[A-Z_]+=' $ENV_FILE | grep -vE '^(ORDERS_SHEETS_EXPORT_ENABLED|GOOGLE_SHEETS_SA_EMAIL|GOOGLE_SHEETS_SA_KEY_B64)=' | sort) >/dev/null && echo same || echo DIFF)" same
[ $fail -eq 0 ] && echo "ENV OK (values not shown)" || { echo "ENV FAIL"; exit 1; }
