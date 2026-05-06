#!/usr/bin/env bash
# Phase 8 — end-to-end verification.
# Requires AWS profiles 'reader-1' and 'reader-2' configured locally
# (use audit-evidence/reader-keys/reader-N-keys.json to populate them).
source "$(dirname "$0")/lib.sh"
ensure_aws_ready

PASS=0
FAIL=0

run_test() {
    local name="$1" cmd="$2" expect="$3"
    printf '  %s ... ' "$name"
    local out rc
    out=$(eval "$cmd" 2>&1) && rc=0 || rc=$?
    if [ "$expect" = "success" ] && [ $rc -eq 0 ]; then
        printf '\033[1;32mPASS\033[0m\n'; PASS=$((PASS+1))
    elif [ "$expect" = "deny" ] && grep -qiE 'AccessDenied|forbidden|403' <<<"$out"; then
        printf '\033[1;32mPASS\033[0m (denied as expected)\n'; PASS=$((PASS+1))
    elif [ "$expect" = "http_403" ] && [ "$out" = "403" ]; then
        printf '\033[1;32mPASS\033[0m (HTTP 403)\n'; PASS=$((PASS+1))
    else
        printf '\033[1;31mFAIL\033[0m\n'
        printf '    rc=%s expect=%s out:\n%s\n' "$rc" "$expect" "$out" | head -10
        FAIL=$((FAIL+1))
    fi
}

log "Phase 8 — verification suite for $BUCKET"

# 1. Reader can list (assumes ~/.aws/credentials has [reader-1])
run_test "reader-1 can list" \
    "aws s3 ls s3://$BUCKET/ --profile reader-1" \
    "success"

# 2. Reader cannot write
TMPF=$(mktemp)
echo "test" > "$TMPF"
run_test "reader-1 cannot write" \
    "aws s3 cp '$TMPF' s3://$BUCKET/forbidden.txt --profile reader-1" \
    "deny"
rm -f "$TMPF"

# 3. Plain HTTP rejected (TLS-only policy)
run_test "HTTP plain blocked" \
    "curl -s -o /dev/null -w '%{http_code}' http://$BUCKET.s3.amazonaws.com/" \
    "http_403"

# 4. Role can write (uses default profile + STS AssumeRole inline)
ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${ROLE_NAME}"
ASSUME_OUT=$(aws sts assume-role \
    --role-arn "$ROLE_ARN" \
    --role-session-name verify-session \
    --external-id "$EXTERNAL_ID" 2>/dev/null || true)
if [ -n "$ASSUME_OUT" ]; then
    AK=$(echo "$ASSUME_OUT" | python -c "import json,sys;d=json.load(sys.stdin)['Credentials'];print(d['AccessKeyId'])")
    SK=$(echo "$ASSUME_OUT" | python -c "import json,sys;d=json.load(sys.stdin)['Credentials'];print(d['SecretAccessKey'])")
    ST=$(echo "$ASSUME_OUT" | python -c "import json,sys;d=json.load(sys.stdin)['Credentials'];print(d['SessionToken'])")
    TMPF=$(mktemp)
    echo "role-test" > "$TMPF"
    run_test "role can write" \
        "AWS_ACCESS_KEY_ID='$AK' AWS_SECRET_ACCESS_KEY='$SK' AWS_SESSION_TOKEN='$ST' \
         aws s3 cp '$TMPF' s3://$BUCKET/_verify-role-write.txt && \
         AWS_ACCESS_KEY_ID='$AK' AWS_SECRET_ACCESS_KEY='$SK' AWS_SESSION_TOKEN='$ST' \
         aws s3 rm s3://$BUCKET/_verify-role-write.txt" \
        "success"
    rm -f "$TMPF"
else
    printf '  role assume-role ... \033[1;31mFAIL\033[0m (could not assume role)\n'
    FAIL=$((FAIL+1))
fi

# 5. Block Public Access state
run_test "Block Public Access ON" \
    "aws s3api get-public-access-block --bucket $BUCKET --query 'PublicAccessBlockConfiguration.BlockPublicAcls' --output text | grep -q True" \
    "success"

# 6. Bucket policy applied
run_test "bucket policy present" \
    "aws s3api get-bucket-policy --bucket $BUCKET --query Policy --output text | grep -q DenyAllNonAuthorized" \
    "success"

# 7. Access Analyzer exists
run_test "access analyzer exists" \
    "aws accessanalyzer list-analyzers --type ACCOUNT --query \"analyzers[?name=='$ANALYZER_NAME']|length(@)\" --output text | grep -qv '^0$'" \
    "success"

echo
log "result: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
