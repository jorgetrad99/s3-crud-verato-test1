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

# --- compute principal ARNs ---------------------------------------------------
ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${ROLE_NAME}"
VIEWER_ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${VIEWER_ROLE_NAME:-frontend-viewer-role}"

log "data access (read/write) allowed only via:"
log "   - ${ROLE_ARN}            (uploader)"
log "   - ${VIEWER_ROLE_ARN}     (viewer)"
log "all other identities — admin-cli, root, reader-1/2 — DENIED on object data."
log "(management ops like PutBucketPolicy/GetBucketPolicy stay open for the operator's IAM perms.)"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# Object-data actions (read/list). Anything else (GetBucketPolicy,
# PutBucketPolicy, GetPublicAccessBlock, etc.) is NOT denied here, so
# admin-cli can still manage the bucket via its IAM perms.
cat > "$TMP/bucket-policy.json" <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "DenyDataReadExceptApprovedRoles",
      "Effect": "Deny",
      "Principal": "*",
      "Action": [
        "s3:GetObject",
        "s3:GetObjectAttributes",
        "s3:GetObjectAcl",
        "s3:GetObjectVersion",
        "s3:GetObjectVersionAcl",
        "s3:ListBucket",
        "s3:ListBucketVersions"
      ],
      "Resource": [
        "arn:aws:s3:::${BUCKET}",
        "arn:aws:s3:::${BUCKET}/*"
      ],
      "Condition": {
        "ArnNotLike": {
          "aws:PrincipalArn": [
            "${ROLE_ARN}",
            "${VIEWER_ROLE_ARN}"
          ]
        }
      }
    },
    {
      "Sid": "DenyDataWriteExceptUploader",
      "Effect": "Deny",
      "Principal": "*",
      "Action": [
        "s3:PutObject",
        "s3:DeleteObject",
        "s3:DeleteObjectVersion",
        "s3:PutObjectAcl"
      ],
      "Resource": "arn:aws:s3:::${BUCKET}/*",
      "Condition": {
        "ArnNotLike": {
          "aws:PrincipalArn": "${ROLE_ARN}"
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

# --- bucket CORS (so the browser can call S3 directly with STS creds) -------
ORIGINS_JSON=""
for o in $(echo "${FRONTEND_ORIGINS:-http://localhost:3001}" | tr ',' ' '); do
    ORIGINS_JSON+=",\"$o\""
done
ORIGINS_JSON="[${ORIGINS_JSON:1}]"

cat > "$TMP/cors.json" <<EOF
{
  "CORSRules": [
    {
      "AllowedHeaders": ["*"],
      "AllowedMethods": ["GET", "PUT", "DELETE", "HEAD"],
      "AllowedOrigins": ${ORIGINS_JSON},
      "ExposeHeaders": ["ETag", "x-amz-request-id", "x-amz-id-2"],
      "MaxAgeSeconds": 3000
    }
  ]
}
EOF

python -m json.tool "$TMP/cors.json" > /dev/null
ok "CORS JSON valid; allowed origins: $FRONTEND_ORIGINS"

aws s3api put-bucket-cors \
    --bucket "$BUCKET" \
    --cors-configuration "$(aws_file_url "$TMP/cors.json")"
ok "bucket CORS applied"
