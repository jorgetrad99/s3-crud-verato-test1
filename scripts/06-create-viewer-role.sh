#!/usr/bin/env bash
# Phase 6 — create the read-only role assumed by the frontend's "viewer" users.
# Browser receives temp STS creds for this role and talks to S3 directly,
# so AWS (not Express) is what enforces read access.
source "$(dirname "$0")/lib.sh"
ensure_aws_ready
require_env VIEWER_ROLE_NAME

log "Phase 6 — create IAM role: $VIEWER_ROLE_NAME"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# --- trust policy: same broker model as the uploader role -------------------
cat > "$TMP/trust.json" <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "AWS": "arn:aws:iam::${ACCOUNT_ID}:root" },
      "Action": "sts:AssumeRole",
      "Condition": {
        "StringEquals": { "sts:ExternalId": "${EXTERNAL_ID}" }
      }
    }
  ]
}
EOF

# --- permission policy: read-only on the bucket -----------------------------
cat > "$TMP/perms.json" <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowReadBucketObjects",
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:GetObjectAttributes"
      ],
      "Resource": "arn:aws:s3:::${BUCKET}/*"
    },
    {
      "Sid": "AllowListBucket",
      "Effect": "Allow",
      "Action": [
        "s3:ListBucket",
        "s3:GetBucketLocation"
      ],
      "Resource": "arn:aws:s3:::${BUCKET}"
    }
  ]
}
EOF

# --- create or update role ---------------------------------------------------
if iam_role_exists "$VIEWER_ROLE_NAME"; then
    skip "role $VIEWER_ROLE_NAME already exists — updating trust policy"
    aws iam update-assume-role-policy \
        --role-name "$VIEWER_ROLE_NAME" \
        --policy-document "$(aws_file_url "$TMP/trust.json")" >/dev/null
    ok "trust policy updated"
else
    aws iam create-role \
        --role-name "$VIEWER_ROLE_NAME" \
        --assume-role-policy-document "$(aws_file_url "$TMP/trust.json")" \
        --description "Frontend viewer (read-only) role assumed via STS" >/dev/null
    ok "role created: $VIEWER_ROLE_NAME"
fi

aws iam put-role-policy \
    --role-name "$VIEWER_ROLE_NAME" \
    --policy-name S3ReadOnlyAccess \
    --policy-document "$(aws_file_url "$TMP/perms.json")"
ok "inline policy S3ReadOnlyAccess applied"

VIEWER_ROLE_ARN=$(aws iam get-role --role-name "$VIEWER_ROLE_NAME" --query 'Role.Arn' --output text)
log "viewer role ready: $VIEWER_ROLE_ARN"
log ""
log "Next: re-run scripts/04-bucket-policy.sh so the bucket policy includes this role"
