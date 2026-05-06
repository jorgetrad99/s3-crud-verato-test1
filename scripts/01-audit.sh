#!/usr/bin/env bash
# Phase 1 — snapshot current bucket access state.
source "$(dirname "$0")/lib.sh"
ensure_aws_ready

OUT="$PROJECT_ROOT/audit-evidence"
mkdir -p "$OUT"

log "Phase 1 — audit (output: $OUT)"

if ! s3_bucket_exists "$BUCKET"; then
    warn "Bucket $BUCKET does not exist yet — most snapshots will be empty."
    warn "Run scripts/04-bucket-policy.sh first to create it, then re-run audit."
fi

# 1. Bucket Policy
if aws s3api get-bucket-policy --bucket "$BUCKET" --query Policy --output text 2>/dev/null \
        | python -m json.tool > "$OUT/bucket-policy-before.json" 2>/dev/null; then
    ok "bucket-policy-before.json"
else
    echo '"no policy"' > "$OUT/bucket-policy-before.json"
    skip "no bucket policy yet"
fi

# 2. ACL
aws s3api get-bucket-acl --bucket "$BUCKET" > "$OUT/bucket-acl-before.json" 2>/dev/null \
    && ok "bucket-acl-before.json" \
    || skip "ACL unavailable"

# 3. Block Public Access
aws s3api get-public-access-block --bucket "$BUCKET" \
        > "$OUT/public-access-block-before.json" 2>/dev/null \
    && ok "public-access-block-before.json" \
    || echo "{}" > "$OUT/public-access-block-before.json"

# 4. Object Ownership
aws s3api get-bucket-ownership-controls --bucket "$BUCKET" \
        > "$OUT/ownership-before.json" 2>/dev/null \
    && ok "ownership-before.json" \
    || skip "ownership controls unavailable"

# 5. Versioning + logging
aws s3api get-bucket-versioning --bucket "$BUCKET" > "$OUT/versioning-before.json" 2>/dev/null \
    && ok "versioning-before.json" || skip "versioning unavailable"
aws s3api get-bucket-logging --bucket "$BUCKET" > "$OUT/logging-before.json" 2>/dev/null \
    && ok "logging-before.json" || skip "logging unavailable"

# 6-7. IAM users + roles
aws iam list-users --query 'Users[*].[UserName,Arn,CreateDate]' --output table \
    > "$OUT/iam-users.txt"
ok "iam-users.txt"

aws iam list-roles --query 'Roles[*].[RoleName,Arn]' --output table \
    > "$OUT/iam-roles.txt"
ok "iam-roles.txt"

# 8. Per-user attached policies
: > "$OUT/user-policies.txt"
for user in $(aws iam list-users --query 'Users[*].UserName' --output text); do
    {
        echo "=== $user ==="
        aws iam list-attached-user-policies --user-name "$user" 2>/dev/null
        aws iam list-user-policies --user-name "$user" 2>/dev/null
        echo
    } >> "$OUT/user-policies.txt"
done
ok "user-policies.txt"

# 9. Access Analyzer findings (if any analyzer exists)
ANALYZER_ARN=$(aws accessanalyzer list-analyzers --type ACCOUNT \
    --query "analyzers[0].arn" --output text 2>/dev/null || true)
if [ -n "$ANALYZER_ARN" ] && [ "$ANALYZER_ARN" != "None" ]; then
    aws accessanalyzer list-findings --analyzer-arn "$ANALYZER_ARN" \
        --filter '{"resourceType":{"eq":["AWS::S3::Bucket"]}}' \
        > "$OUT/analyzer-findings-before.json" 2>/dev/null \
        && ok "analyzer-findings-before.json"
fi

log "audit complete — files in $OUT"
ls -la "$OUT"
