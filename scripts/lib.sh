#!/usr/bin/env bash
# Common helpers for AWS S3 restricted-bucket scripts.
# Source this file at the top of each phase script:
#   source "$(dirname "$0")/lib.sh"

set -euo pipefail

# ---------- env loading ----------
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091
[ -f "$PROJECT_ROOT/.envrc" ] && source "$PROJECT_ROOT/.envrc"

require_env() {
    local missing=0
    for var in "$@"; do
        if [ -z "${!var:-}" ]; then
            echo "[lib] ERROR: required env var $var is not set" >&2
            missing=1
        fi
    done
    [ "$missing" -eq 0 ]
}

# ---------- logging ----------
# ---------- path conversion (Windows/Git Bash compat) ----------
# AWS CLI on Windows is a native exe; it cannot read /tmp/... MSYS paths.
# cygpath -m converts /tmp/foo -> C:/Users/.../AppData/Local/Temp/foo.
to_native_path() {
    if command -v cygpath >/dev/null 2>&1; then
        cygpath -m "$1"
    else
        printf '%s' "$1"
    fi
}

aws_file_url() {
    printf 'file://%s' "$(to_native_path "$1")"
}

log()  { printf '\033[1;34m[%s]\033[0m %s\n' "$(date +%H:%M:%S)" "$*"; }
ok()   { printf '\033[1;32m  ✓\033[0m %s\n' "$*"; }
skip() { printf '\033[1;33m  ↪\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m  !\033[0m %s\n' "$*" >&2; }
err()  { printf '\033[1;31m  ✗\033[0m %s\n' "$*" >&2; }

# ---------- idempotency checks ----------
iam_role_exists() {
    aws iam get-role --role-name "$1" >/dev/null 2>&1
}

iam_user_exists() {
    aws iam get-user --user-name "$1" >/dev/null 2>&1
}

iam_group_exists() {
    aws iam get-group --group-name "$1" >/dev/null 2>&1
}

iam_user_in_group() {
    aws iam get-group --group-name "$2" \
        --query "Users[?UserName=='$1'] | length(@)" --output text 2>/dev/null \
        | grep -qv '^0$'
}

iam_role_policy_exists() {
    aws iam get-role-policy --role-name "$1" --policy-name "$2" >/dev/null 2>&1
}

iam_group_policy_exists() {
    aws iam get-group-policy --group-name "$1" --policy-name "$2" >/dev/null 2>&1
}

s3_bucket_exists() {
    aws s3api head-bucket --bucket "$1" >/dev/null 2>&1
}

accessanalyzer_exists() {
    local name="$1"
    aws accessanalyzer list-analyzers --type ACCOUNT \
        --query "analyzers[?name=='$name'] | length(@)" --output text 2>/dev/null \
        | grep -qv '^0$'
}

# ---------- caller identity ----------
caller_arn() {
    aws sts get-caller-identity --query Arn --output text
}

# ---------- safety guards ----------
ensure_aws_ready() {
    require_env AWS_REGION ACCOUNT_ID BUCKET ROLE_NAME GROUP_NAME EXTERNAL_ID
    if ! aws sts get-caller-identity >/dev/null 2>&1; then
        err "AWS credentials not configured. Run: aws configure"
        exit 1
    fi
}
