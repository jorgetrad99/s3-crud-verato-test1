#!/usr/bin/env bash
# Inject reader-1's access keys into frontend-app/server/.env without
# echoing them to the terminal.
source "$(dirname "$0")/lib.sh"

KEYS_FILE="$PROJECT_ROOT/audit-evidence/reader-keys/reader-1-keys.json"
ENV_FILE="$PROJECT_ROOT/frontend-app/server/.env"

[ -f "$KEYS_FILE" ] || { err "missing $KEYS_FILE — run scripts/03-create-readers.sh"; exit 1; }
[ -f "$ENV_FILE" ]  || { err "missing $ENV_FILE";  exit 1; }

python - "$KEYS_FILE" "$ENV_FILE" <<'PY'
import json, re, sys, pathlib
keys_path, env_path = sys.argv[1], sys.argv[2]
data = json.loads(pathlib.Path(keys_path).read_text())["AccessKey"]
ak, sk = data["AccessKeyId"], data["SecretAccessKey"]
text = pathlib.Path(env_path).read_text()
text = re.sub(r'^AWS_ACCESS_KEY_ID=.*$',     f'AWS_ACCESS_KEY_ID={ak}',     text, flags=re.M)
text = re.sub(r'^AWS_SECRET_ACCESS_KEY=.*$', f'AWS_SECRET_ACCESS_KEY={sk}', text, flags=re.M)
pathlib.Path(env_path).write_text(text)
print(f"OK reader-1 keys injected into {env_path}")
PY

chmod 600 "$ENV_FILE" 2>/dev/null || true
