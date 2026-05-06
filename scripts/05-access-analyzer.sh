#!/usr/bin/env bash
# Phase 5 — enable IAM Access Analyzer + server access logging.
# CloudTrail data events are skipped unless CLOUDTRAIL_NAME is set.
source "$(dirname "$0")/lib.sh"
ensure_aws_ready

log "Phase 5 — Access Analyzer + audit logging"

# --- Access Analyzer (account-level) -----------------------------------------
if accessanalyzer_exists "$ANALYZER_NAME"; then
    skip "analyzer $ANALYZER_NAME exists"
else
    aws accessanalyzer create-analyzer \
        --analyzer-name "$ANALYZER_NAME" \
        --type ACCOUNT \
        --tags Project=S3Restriction >/dev/null
    ok "analyzer created: $ANALYZER_NAME"
fi

ANALYZER_ARN=$(aws accessanalyzer list-analyzers --type ACCOUNT \
    --query "analyzers[?name=='$ANALYZER_NAME'].arn | [0]" --output text)
log "analyzer arn: $ANALYZER_ARN"

# --- Server access logging bucket --------------------------------------------
LOG_BUCKET="${BUCKET}-access-logs"
if s3_bucket_exists "$LOG_BUCKET"; then
    skip "log bucket $LOG_BUCKET exists"
else
    if [ "$AWS_REGION" = "us-east-1" ]; then
        aws s3api create-bucket --bucket "$LOG_BUCKET" --region "$AWS_REGION" >/dev/null
    else
        aws s3api create-bucket --bucket "$LOG_BUCKET" --region "$AWS_REGION" \
            --create-bucket-configuration "LocationConstraint=$AWS_REGION" >/dev/null
    fi
    ok "log bucket created: $LOG_BUCKET"

    # block public access on the log bucket too
    aws s3api put-public-access-block \
        --bucket "$LOG_BUCKET" \
        --public-access-block-configuration \
            BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
    ok "log bucket: BPA enabled"
fi

# --- Wire server access logging on the main bucket ---------------------------
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

cat > "$TMP/logging.json" <<EOF
{
  "LoggingEnabled": {
    "TargetBucket": "${LOG_BUCKET}",
    "TargetPrefix": "logs/"
  }
}
EOF

aws s3api put-bucket-logging \
    --bucket "$BUCKET" \
    --bucket-logging-status "$(aws_file_url "$TMP/logging.json")"
ok "server access logging → s3://$LOG_BUCKET/logs/"

# --- Optional: CloudTrail data events ----------------------------------------
if [ -n "${CLOUDTRAIL_NAME:-}" ]; then
    cat > "$TMP/selectors.json" <<EOF
[
  {
    "ReadWriteType": "All",
    "IncludeManagementEvents": true,
    "DataResources": [
      {
        "Type": "AWS::S3::Object",
        "Values": ["arn:aws:s3:::${BUCKET}/"]
      }
    ]
  }
]
EOF
    aws cloudtrail put-event-selectors \
        --trail-name "$CLOUDTRAIL_NAME" \
        --event-selectors "$(aws_file_url "$TMP/selectors.json")" >/dev/null
    ok "CloudTrail data events enabled on trail $CLOUDTRAIL_NAME"
else
    skip "CloudTrail data events skipped (set CLOUDTRAIL_NAME to enable)"
fi

log "current findings (S3 buckets only):"
aws accessanalyzer list-findings --analyzer-arn "$ANALYZER_ARN" \
    --filter '{"resourceType":{"eq":["AWS::S3::Bucket"]}}' \
    --query 'findings[*].[resource,status,condition]' --output table 2>/dev/null \
    || warn "no findings or analyzer still warming up (~1-2 min)"
