#!/usr/bin/env bash
# Phase 0 — verify tools and AWS access before doing anything.
source "$(dirname "$0")/lib.sh"

log "Phase 0 — preflight"

for tool in aws python node npm; do
    if command -v "$tool" >/dev/null 2>&1; then
        ok "$tool: $($tool --version 2>&1 | head -1)"
    else
        err "$tool not found in PATH"
        exit 1
    fi
done

if ! aws sts get-caller-identity >/dev/null 2>&1; then
    err "AWS credentials not configured. Run: aws configure"
    exit 1
fi

ARN=$(caller_arn)
ok "AWS caller: $ARN"
ok "Account ID: $ACCOUNT_ID"
ok "Region:     $AWS_REGION"
ok "Bucket:     $BUCKET"
ok "Role:       $ROLE_NAME"
ok "Group:      $GROUP_NAME"

log "preflight ok"
