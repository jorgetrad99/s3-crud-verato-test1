#!/usr/bin/env bash
# Tear down everything created by the phase scripts. DESTRUCTIVE.
# Requires explicit confirmation.
source "$(dirname "$0")/lib.sh"
ensure_aws_ready

cat <<EOF
⚠️  This will delete:
   - Bucket policy on $BUCKET (and all objects under assets/)
   - Bucket $BUCKET itself (only if empty after object cleanup)
   - Access logs bucket $BUCKET-access-logs (and contents)
   - IAM users: $READER_USERS (and their access keys)
   - IAM group: $GROUP_NAME
   - IAM role:  $ROLE_NAME
   - Access Analyzer: $ANALYZER_NAME
EOF
read -r -p "Type DELETE to proceed: " CONFIRM
[ "$CONFIRM" = "DELETE" ] || { echo "aborted"; exit 1; }

log "cleanup starting"

# --- bucket contents + policy + bucket ---------------------------------------
if s3_bucket_exists "$BUCKET"; then
    aws s3 rm "s3://$BUCKET" --recursive 2>/dev/null || true
    aws s3api delete-bucket-policy --bucket "$BUCKET" 2>/dev/null || true
    aws s3api delete-bucket --bucket "$BUCKET" 2>/dev/null \
        && ok "deleted bucket $BUCKET" \
        || warn "could not delete bucket (versioning? extra objects?)"
fi

LOG_BUCKET="${BUCKET}-access-logs"
if s3_bucket_exists "$LOG_BUCKET"; then
    aws s3 rm "s3://$LOG_BUCKET" --recursive 2>/dev/null || true
    aws s3api delete-bucket --bucket "$LOG_BUCKET" 2>/dev/null \
        && ok "deleted bucket $LOG_BUCKET" \
        || warn "could not delete log bucket"
fi

# --- readers ------------------------------------------------------------------
for user in $READER_USERS; do
    if iam_user_exists "$user"; then
        aws iam remove-user-from-group --user-name "$user" --group-name "$GROUP_NAME" 2>/dev/null || true
        for key in $(aws iam list-access-keys --user-name "$user" \
                --query 'AccessKeyMetadata[*].AccessKeyId' --output text); do
            aws iam delete-access-key --user-name "$user" --access-key-id "$key" 2>/dev/null || true
        done
        aws iam delete-user --user-name "$user" 2>/dev/null \
            && ok "deleted user $user" \
            || warn "could not delete user $user"
    fi
done

# --- group --------------------------------------------------------------------
if iam_group_exists "$GROUP_NAME"; then
    aws iam delete-group-policy --group-name "$GROUP_NAME" --policy-name S3ReadOnlyAccess 2>/dev/null || true
    aws iam delete-group --group-name "$GROUP_NAME" 2>/dev/null \
        && ok "deleted group $GROUP_NAME" \
        || warn "could not delete group"
fi

# --- role ---------------------------------------------------------------------
if iam_role_exists "$ROLE_NAME"; then
    aws iam delete-role-policy --role-name "$ROLE_NAME" --policy-name S3UploadPolicy 2>/dev/null || true
    aws iam delete-role --role-name "$ROLE_NAME" 2>/dev/null \
        && ok "deleted role $ROLE_NAME" \
        || warn "could not delete role"
fi

# --- analyzer -----------------------------------------------------------------
if accessanalyzer_exists "$ANALYZER_NAME"; then
    aws accessanalyzer delete-analyzer --analyzer-name "$ANALYZER_NAME" 2>/dev/null \
        && ok "deleted analyzer $ANALYZER_NAME" \
        || warn "could not delete analyzer"
fi

log "cleanup done"
