#!/usr/bin/env bash
# Phase 3 — create IAM group + reader users with read-only S3 access.
source "$(dirname "$0")/lib.sh"
ensure_aws_ready

log "Phase 3 — create reader group ($GROUP_NAME) + users ($READER_USERS)"

KEYS_DIR="$PROJECT_ROOT/audit-evidence/reader-keys"
mkdir -p "$KEYS_DIR"
chmod 700 "$KEYS_DIR" 2>/dev/null || true

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# --- group --------------------------------------------------------------------
if iam_group_exists "$GROUP_NAME"; then
    skip "group $GROUP_NAME exists"
else
    aws iam create-group --group-name "$GROUP_NAME" >/dev/null
    ok "group created: $GROUP_NAME"
fi

# --- group inline policy ------------------------------------------------------
cat > "$TMP/reader-policy.json" <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:ListBucket",
        "s3:GetBucketLocation"
      ],
      "Resource": [
        "arn:aws:s3:::${BUCKET}",
        "arn:aws:s3:::${BUCKET}/*"
      ]
    }
  ]
}
EOF
aws iam put-group-policy \
    --group-name "$GROUP_NAME" \
    --policy-name S3ReadOnlyAccess \
    --policy-document "$(aws_file_url "$TMP/reader-policy.json")"
ok "group policy S3ReadOnlyAccess applied"

# --- users --------------------------------------------------------------------
for user in $READER_USERS; do
    if iam_user_exists "$user"; then
        skip "user $user exists"
    else
        aws iam create-user --user-name "$user" >/dev/null
        ok "user created: $user"
    fi

    if iam_user_in_group "$user" "$GROUP_NAME"; then
        skip "$user already in group $GROUP_NAME"
    else
        aws iam add-user-to-group --user-name "$user" --group-name "$GROUP_NAME"
        ok "$user added to $GROUP_NAME"
    fi

    KEY_FILE="$KEYS_DIR/${user}-keys.json"
    if [ -f "$KEY_FILE" ]; then
        skip "access key file already exists: $KEY_FILE"
    else
        EXISTING_KEYS=$(aws iam list-access-keys --user-name "$user" \
            --query 'AccessKeyMetadata[*].AccessKeyId' --output text)
        if [ -n "$EXISTING_KEYS" ]; then
            warn "$user already has access keys in AWS but no local file — skipping creation."
            warn "  to rotate: aws iam delete-access-key --user-name $user --access-key-id <id>"
        else
            aws iam create-access-key --user-name "$user" > "$KEY_FILE"
            chmod 600 "$KEY_FILE" 2>/dev/null || true
            ok "access key generated → $KEY_FILE  (chmod 600)"
        fi
    fi
done

log "readers ready"
aws iam get-group --group-name "$GROUP_NAME" \
    --query 'Users[*].[UserName,Arn]' --output table
