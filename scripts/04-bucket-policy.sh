#!/usr/bin/env bash
# Phase 4 — harden the bucket: BPA, ownership, deny-by-default policy.
source "$(dirname "$0")/lib.sh"
ensure_aws_ready

log "Phase 4 — bucket hardening for $BUCKET"

# --- ensure bucket exists -----------------------------------------------------
if s3_bucket_exists "$BUCKET"; then
    skip "bucket $BUCKET exists"
else
    if [ "$AWS_REGION" = "us-east-1" ]; then
        aws s3api create-bucket --bucket "$BUCKET" --region "$AWS_REGION" >/dev/null
    else
        aws s3api create-bucket --bucket "$BUCKET" --region "$AWS_REGION" \
            --create-bucket-configuration "LocationConstraint=$AWS_REGION" >/dev/null
    fi
    ok "bucket created: $BUCKET"
fi

# --- block public access ------------------------------------------------------
aws s3api put-public-access-block \
    --bucket "$BUCKET" \
    --public-access-block-configuration \
        BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
ok "block public access: ALL ON"

# --- object ownership: ACLs disabled ------------------------------------------
aws s3api put-bucket-ownership-controls \
    --bucket "$BUCKET" \
    --ownership-controls 'Rules=[{ObjectOwnership=BucketOwnerEnforced}]'
ok "object ownership: BucketOwnerEnforced"

# --- compute exception ARNs ---------------------------------------------------
CURRENT_ARN=$(caller_arn)
log "current caller will be added to allow-list: $CURRENT_ARN"

ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${ROLE_NAME}"
ROOT_ARN="arn:aws:iam::${ACCOUNT_ID}:root"

# Build the JSON arrays of allowed principals
ALLOW_PRINCIPALS=""
for u in $READER_USERS; do
    ALLOW_PRINCIPALS+=",\"arn:aws:iam::${ACCOUNT_ID}:user/${u}\""
done

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

cat > "$TMP/bucket-policy.json" <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "DenyAllNonAuthorized",
      "Effect": "Deny",
      "Principal": "*",
      "Action": "s3:*",
      "Resource": [
        "arn:aws:s3:::${BUCKET}",
        "arn:aws:s3:::${BUCKET}/*"
      ],
      "Condition": {
        "ArnNotLike": {
          "aws:PrincipalArn": [
            "${ROLE_ARN}",
            "${ROOT_ARN}",
            "${CURRENT_ARN}"${ALLOW_PRINCIPALS}
          ]
        }
      }
    },
    {
      "Sid": "DenyWriteForReaders",
      "Effect": "Deny",
      "Principal": "*",
      "Action": [
        "s3:PutObject",
        "s3:DeleteObject",
        "s3:PutObjectAcl"
      ],
      "Resource": "arn:aws:s3:::${BUCKET}/*",
      "Condition": {
        "ArnNotLike": {
          "aws:PrincipalArn": [
            "${ROLE_ARN}",
            "${ROOT_ARN}",
            "${CURRENT_ARN}"
          ]
        }
      }
    },
    {
      "Sid": "EnforceTLS",
      "Effect": "Deny",
      "Principal": "*",
      "Action": "s3:*",
      "Resource": [
        "arn:aws:s3:::${BUCKET}",
        "arn:aws:s3:::${BUCKET}/*"
      ],
      "Condition": {
        "Bool": { "aws:SecureTransport": "false" }
      }
    }
  ]
}
EOF

# Validate JSON before applying
python -m json.tool "$TMP/bucket-policy.json" > /dev/null
ok "bucket policy JSON is valid"

cp "$TMP/bucket-policy.json" "$PROJECT_ROOT/audit-evidence/bucket-policy-applied.json" 2>/dev/null || true

aws s3api put-bucket-policy \
    --bucket "$BUCKET" \
    --policy "$(aws_file_url "$TMP/bucket-policy.json")"
ok "bucket policy applied"

log "verifying"
aws s3api get-bucket-policy --bucket "$BUCKET" --query Policy --output text \
    | python -m json.tool | head -5
