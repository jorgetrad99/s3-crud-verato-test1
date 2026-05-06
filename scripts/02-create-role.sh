#!/usr/bin/env bash
# Phase 2 — create IAM role for the integration uploader.
source "$(dirname "$0")/lib.sh"
ensure_aws_ready

log "Phase 2 — create IAM role: $ROLE_NAME"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# --- trust policy: any principal in this account, with ExternalId -------------
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

# --- permission policy: write to bucket ---------------------------------------
cat > "$TMP/perms.json" <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowWriteToBucket",
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:PutObjectAcl",
        "s3:DeleteObject",
        "s3:GetObject"
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

# --- create or update role ----------------------------------------------------
if iam_role_exists "$ROLE_NAME"; then
    skip "role $ROLE_NAME already exists — updating trust policy"
    aws iam update-assume-role-policy \
        --role-name "$ROLE_NAME" \
        --policy-document "$(aws_file_url "$TMP/trust.json")" >/dev/null
    ok "trust policy updated"
else
    aws iam create-role \
        --role-name "$ROLE_NAME" \
        --assume-role-policy-document "$(aws_file_url "$TMP/trust.json")" \
        --description "Local integration to S3 uploader" >/dev/null
    ok "role created: $ROLE_NAME"
fi

# --- attach inline permission policy (idempotent put) -------------------------
aws iam put-role-policy \
    --role-name "$ROLE_NAME" \
    --policy-name S3UploadPolicy \
    --policy-document "$(aws_file_url "$TMP/perms.json")"
ok "inline policy S3UploadPolicy applied"

ROLE_ARN=$(aws iam get-role --role-name "$ROLE_NAME" --query 'Role.Arn' --output text)
log "role ready: $ROLE_ARN"
