"""Local → S3 uploader using STS AssumeRole.

Run:
    python -m venv .venv
    source .venv/bin/activate   # Git Bash on Windows
    pip install -r requirements.txt
    cp .env.example .env        # then edit
    python upload.py
"""
from __future__ import annotations

import mimetypes
import os
import sys
from pathlib import Path

import boto3
from botocore.exceptions import ClientError
from dotenv import load_dotenv

load_dotenv()

REGION = os.environ["AWS_REGION"]
BUCKET = os.environ["BUCKET_NAME"]
ROLE_ARN = os.environ["ROLE_ARN"]
EXTERNAL_ID = os.environ["EXTERNAL_ID"]
ASSETS = Path(os.environ.get("ASSETS_FOLDER", "./assets"))

ALLOWED_EXT = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg"}
KEY_PREFIX = "assets/"
SESSION_DURATION = 900  # 15 min


def assume_role() -> "boto3.client":
    sts = boto3.client("sts", region_name=REGION)
    response = sts.assume_role(
        RoleArn=ROLE_ARN,
        RoleSessionName="local-upload-session",
        ExternalId=EXTERNAL_ID,
        DurationSeconds=SESSION_DURATION,
    )
    creds = response["Credentials"]
    return boto3.client(
        "s3",
        region_name=REGION,
        aws_access_key_id=creds["AccessKeyId"],
        aws_secret_access_key=creds["SecretAccessKey"],
        aws_session_token=creds["SessionToken"],
    )


def upload_folder(s3, folder: Path) -> int:
    if not folder.exists():
        print(f"ERROR: folder does not exist: {folder}")
        sys.exit(1)

    files = [
        f for f in folder.iterdir()
        if f.is_file() and f.suffix.lower() in ALLOWED_EXT
    ]
    if not files:
        print(f"WARN: no valid images in {folder}")
        return 0

    print(f"Uploading {len(files)} file(s) to s3://{BUCKET}/{KEY_PREFIX}")
    success = 0
    for fp in files:
        key = f"{KEY_PREFIX}{fp.name}"
        ctype, _ = mimetypes.guess_type(str(fp))
        try:
            s3.upload_file(
                Filename=str(fp),
                Bucket=BUCKET,
                Key=key,
                ExtraArgs={"ContentType": ctype or "application/octet-stream"},
            )
            print(f"  OK   {fp.name} -> s3://{BUCKET}/{key}")
            success += 1
        except ClientError as e:
            print(f"  FAIL {fp.name}: {e}")
    print(f"\n{success}/{len(files)} uploaded")
    return success


def main() -> None:
    print("Assuming integration role...")
    try:
        s3 = assume_role()
    except ClientError as e:
        print(f"ERROR assuming role: {e}")
        sys.exit(1)
    upload_folder(s3, ASSETS)


if __name__ == "__main__":
    main()
