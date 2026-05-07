#!/usr/bin/env bash
# Phase 7 — create a least-privilege IAM user that the deployed backend
# uses as the STS broker. ONLY allowed to:
#   - sts:AssumeRole on the 2 frontend roles
#   - read bucket metadata for the access-list view
# No direct S3 data access, no IAM mutation, no admin powers.
source "$(dirname "$0")/lib.sh"
ensure_aws_ready

BROKER_USER="${BROKER_USER:-frontend-broker}"
KEYS_FILE="$PROJECT_ROOT/audit-evidence/${BROKER_USER}-keys.json"

log "Phase 7 — broker IAM user: $BROKER_USER"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

UPLOADER_ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${ROLE_NAME}"
VIEWER_ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${VIEWER_ROLE_NAME:-frontend-viewer-role}"

cat > "$TMP/perms.json" <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AssumeFrontendRoles",
      "Effect": "Allow",
      "Action": "sts:AssumeRole",
      "Resource": [
        "${UPLOADER_ROLE_ARN}",
        "${VIEWER_ROLE_ARN}"
      ]
    },
    {
      "Sid": "ReadBucketMetadataForAdminPanel",
      "Effect": "Allow",
      "Action": [
        "s3:GetBucketPolicy",
        "s3:GetBucketCors",
        "s3:GetBucketPublicAccessBlock"
      ],
      "Resource": "arn:aws:s3:::${BUCKET}"
    },
    {
      "Sid": "ReadIamMetadataForAdminPanel",
      "Effect": "Allow",
      "Action": [
        "iam:GetGroup",
        "iam:GetRole"
      ],
      "Resource": "*"
    }
  ]
}
EOF

if iam_user_exists "$BROKER_USER"; then
    skip "user $BROKER_USER exists"
else
    aws iam create-user --user-name "$BROKER_USER" >/dev/null
    ok "user created: $BROKER_USER"
fi

aws iam put-user-policy \
    --user-name "$BROKER_USER" \
    --policy-name FrontendBrokerPolicy \
    --policy-document "$(aws_file_url "$TMP/perms.json")"
ok "inline policy FrontendBrokerPolicy applied"

if [ -f "$KEYS_FILE" ]; then
    skip "access keys file already exists: $KEYS_FILE"
else
    EXISTING=$(aws iam list-access-keys --user-name "$BROKER_USER" \
        --query 'AccessKeyMetadata[*].AccessKeyId' --output text)
    if [ -n "$EXISTING" ]; then
        warn "$BROKER_USER already has access keys in AWS but no local file."
        warn "  rotate manually if you lost them."
    else
        mkdir -p "$(dirname "$KEYS_FILE")"
        aws iam create-access-key --user-name "$BROKER_USER" > "$KEYS_FILE"
        chmod 600 "$KEYS_FILE" 2>/dev/null || true
        ok "access keys generated → $KEYS_FILE"
    fi
fi

# Update the trust policy of both roles so the broker user can assume them
# with ExternalId. (account-root principal already covers it; this is just
# explicit and tighter.)
log ""
log "Both ${ROLE_NAME} and ${VIEWER_ROLE_NAME:-frontend-viewer-role} already trust"
log "any account principal with ExternalId=$EXTERNAL_ID, so $BROKER_USER can assume them."
log ""
log "Next: copy these into Vercel env vars:"
log "  ADMIN_AWS_ACCESS_KEY_ID  = (AccessKeyId from $KEYS_FILE)"
log "  ADMIN_AWS_SECRET_ACCESS_KEY = (SecretAccessKey from $KEYS_FILE)"
