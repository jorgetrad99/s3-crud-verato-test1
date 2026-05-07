import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { S3Client, GetBucketPolicyCommand, GetPublicAccessBlockCommand, GetBucketCorsCommand } from "@aws-sdk/client-s3";
import { STSClient, AssumeRoleCommand } from "@aws-sdk/client-sts";
import { IAMClient, GetGroupCommand, GetRoleCommand } from "@aws-sdk/client-iam";
import { fromIni } from "@aws-sdk/credential-providers";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, ".env") });

const REGION = process.env.AWS_REGION;
const BUCKET = process.env.BUCKET_NAME;
const UPLOADER_ROLE_ARN = process.env.ROLE_ARN;
const VIEWER_ROLE_ARN = process.env.VIEWER_ROLE_ARN;
const EXTERNAL_ID = process.env.EXTERNAL_ID;
const ADMIN_PROFILE = process.env.AWS_ADMIN_PROFILE || "default";
const READERS_GROUP = process.env.READERS_GROUP_NAME || "s3-readers";
const IS_SERVERLESS = !!process.env.VERCEL;

if (!BUCKET) console.error("BUCKET_NAME missing");
if (!UPLOADER_ROLE_ARN) console.warn("ROLE_ARN (uploader) missing — admin login will fail");
if (!VIEWER_ROLE_ARN) console.warn("VIEWER_ROLE_ARN missing — viewer login will fail");

const STS_DURATION_SECONDS = 3600;          // 1h temp creds for browser
const TOKEN_TTL_SECONDS = 8 * 60 * 60;       // 8h app session

// ---------- hardcoded users ----------
const USERS = {
  admin:  { password: "admin1234",  role: "admin"  },
  viewer: { password: "viewer1234", role: "viewer" },
};

const ROLE_ARN_FOR = {
  admin:  () => UPLOADER_ROLE_ARN,
  viewer: () => VIEWER_ROLE_ARN,
};

// ---------- HMAC tokens (stateless, serverless-friendly) ----------
const TOKEN_SECRET =
  process.env.TOKEN_SECRET || crypto.randomBytes(32).toString("hex");

function signToken(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", TOKEN_SECRET).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function verifyToken(token) {
  if (!token || typeof token !== "string") return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = crypto.createHmac("sha256", TOKEN_SECRET).update(body).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString());
  } catch {
    return null;
  }
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

// ---------- broker (server-side AWS identity) ----------
// All sts:AssumeRole calls go through this principal. It NEVER touches S3
// directly — its only job is to mint scoped temp credentials that the
// browser uses against S3. AWS (bucket policy + role permissions) is the
// real enforcer of who can read/write.
function brokerCredentials() {
  if (process.env.ADMIN_AWS_ACCESS_KEY_ID && process.env.ADMIN_AWS_SECRET_ACCESS_KEY) {
    return {
      accessKeyId: process.env.ADMIN_AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.ADMIN_AWS_SECRET_ACCESS_KEY,
    };
  }
  return fromIni({ profile: ADMIN_PROFILE });
}

const stsClient = new STSClient({ region: REGION, credentials: brokerCredentials() });
const iamClient = new IAMClient({ region: REGION, credentials: brokerCredentials() });
const adminS3Client = new S3Client({ region: REGION, credentials: brokerCredentials() });

async function assumeRoleFor(appUser, requestId) {
  const arn = ROLE_ARN_FOR[appUser.role]?.();
  if (!arn) throw new Error(`no role configured for app role ${appUser.role}`);
  const sessionName = `frontend-${appUser.role}-${appUser.username}-${requestId}`.slice(0, 64);
  const { Credentials } = await stsClient.send(
    new AssumeRoleCommand({
      RoleArn: arn,
      RoleSessionName: sessionName,
      ExternalId: EXTERNAL_ID,
      DurationSeconds: STS_DURATION_SECONDS,
    })
  );
  return Credentials;
}

// ---------- middlewares ----------
const auth = (req, res, next) => {
  const token = (req.headers.authorization || "").replace("Bearer ", "");
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: "Unauthorized" });
  req.user = { username: payload.username, role: payload.role };
  next();
};

const requireAdmin = (req, res, next) => {
  if (req.user.role !== "admin") {
    return res.status(403).json({ error: "Forbidden — admin role required" });
  }
  next();
};

// ---------- app ----------
const app = express();
app.use(cors());
app.use(express.json());

if (!IS_SERVERLESS) {
  app.use(express.static(path.join(__dirname, "..", "client")));
}

// --- login: authenticate + AssumeRole + return temp AWS creds ---------------
app.post("/api/login", async (req, res) => {
  const { username, password } = req.body || {};
  const u = USERS[username];
  if (!u || u.password !== password) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  let creds;
  try {
    const requestId = crypto.randomBytes(4).toString("hex");
    creds = await assumeRoleFor({ username, role: u.role }, requestId);
  } catch (err) {
    console.error("[login/assume-role]", err);
    return res.status(500).json({ error: `AssumeRole failed: ${err.message}` });
  }

  const now = Math.floor(Date.now() / 1000);
  const appToken = signToken({
    username,
    role: u.role,
    iat: now,
    exp: now + TOKEN_TTL_SECONDS,
  });

  res.json({
    appToken,
    user: username,
    role: u.role,
    aws: {
      region: REGION,
      bucket: BUCKET,
      credentials: {
        accessKeyId: creds.AccessKeyId,
        secretAccessKey: creds.SecretAccessKey,
        sessionToken: creds.SessionToken,
        expiration: creds.Expiration,
      },
    },
  });
});

// --- credentials refresh (avoid forcing re-login every hour) ----------------
app.post("/api/refresh-creds", auth, async (req, res) => {
  try {
    const requestId = crypto.randomBytes(4).toString("hex");
    const creds = await assumeRoleFor(req.user, requestId);
    res.json({
      credentials: {
        accessKeyId: creds.AccessKeyId,
        secretAccessKey: creds.SecretAccessKey,
        sessionToken: creds.SessionToken,
        expiration: creds.Expiration,
      },
    });
  } catch (err) {
    console.error("[refresh-creds]", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/logout", auth, (_req, res) => res.json({ ok: true }));
app.get("/api/me", auth, (req, res) => res.json(req.user));

// --- admin-only: who and what currently has access to the bucket -----------
app.get("/api/access-list", auth, requireAdmin, async (_req, res) => {
  try {
    const policyResult = await adminS3Client.send(
      new GetBucketPolicyCommand({ Bucket: BUCKET })
    );
    const policy = JSON.parse(policyResult.Policy);

    // pull principals from each statement
    function principalsFrom(stmt) {
      const cond = stmt.Condition || {};
      const arnList =
        cond.ArnNotLike?.["aws:PrincipalArn"] ||
        cond.ArnLike?.["aws:PrincipalArn"] || [];
      return Array.isArray(arnList) ? arnList : [arnList];
    }

    const denyAll = policy.Statement.find((s) =>
      s.Sid === "DenyDataReadExceptApprovedRoles" || s.Sid === "DenyAllNonAuthorized"
    );
    const denyWrite = policy.Statement.find((s) =>
      s.Sid === "DenyDataWriteExceptUploader" || s.Sid === "DenyWriteForReaders"
    );
    const tlsStmt = policy.Statement.find((s) => s.Sid === "EnforceTLS");

    const readableArns = principalsFrom(denyAll || {});
    const writableArns = principalsFrom(denyWrite || {});

    const PURPOSE_HINTS = {
      [process.env.ROLE_NAME || "integration-uploader-role"]:
        "Admin uploader (assumed via STS by app admin login)",
      [process.env.VIEWER_ROLE_NAME || "frontend-viewer-role"]:
        "App viewer (assumed via STS by app viewer login)",
    };

    function classify(arn) {
      if (arn.endsWith(":root")) {
        return { arn, kind: "root", name: "Account root", purpose: "Account-level fallback" };
      }
      const m = /:(role|user)\/(.+)$/.exec(arn);
      if (!m) return { arn, kind: "unknown", name: arn };
      const [, kind, name] = m;
      let purpose = PURPOSE_HINTS[name];
      if (!purpose) {
        if (name.startsWith("reader-")) purpose = "IAM viewer (direct CLI/SDK access)";
        else if (kind === "user") purpose = "Operator/maintainer (CLI)";
        else purpose = "Custom";
      }
      return { arn, kind, name, purpose };
    }

    const principals = readableArns.map(classify);
    // bucket policy structure: readableArns can do anything except write,
    // unless they're also in writableArns (which are the write-allowed ones).
    for (const p of principals) {
      p.canRead = true;
      p.canWrite = writableArns.includes(p.arn);
    }

    // members of s3-readers group (legacy IAM users)
    let groupMembers = [];
    try {
      const g = await iamClient.send(new GetGroupCommand({ GroupName: READERS_GROUP }));
      groupMembers = (g.Users || []).map((u) => ({ name: u.UserName, arn: u.Arn }));
    } catch (err) {
      console.warn("[access-list/group]", err.message);
    }

    // role descriptions
    const roleNames = principals.filter((p) => p.kind === "role").map((p) => p.name);
    const roleDetails = {};
    for (const rn of roleNames) {
      try {
        const r = await iamClient.send(new GetRoleCommand({ RoleName: rn }));
        roleDetails[rn] = {
          description: r.Role.Description || "",
          createDate: r.Role.CreateDate,
        };
      } catch { /* role may not exist yet */ }
    }

    // public access block
    let bpa = null;
    try {
      const r = await adminS3Client.send(
        new GetPublicAccessBlockCommand({ Bucket: BUCKET })
      );
      bpa = r.PublicAccessBlockConfiguration;
    } catch { /* unset */ }

    // CORS
    let cors = null;
    try {
      const r = await adminS3Client.send(new GetBucketCorsCommand({ Bucket: BUCKET }));
      cors = r.CORSRules;
    } catch { /* unset */ }

    res.json({
      bucket: BUCKET,
      principals,
      readersGroup: { name: READERS_GROUP, members: groupMembers },
      roleDetails,
      publicAccessBlock: bpa,
      tlsEnforced: !!tlsStmt,
      cors,
    });
  } catch (err) {
    console.error("[access-list]", err);
    res.status(500).json({ error: err.message });
  }
});

if (!IS_SERVERLESS) {
  const PORT = process.env.PORT || 3001;
  app.listen(PORT, () => {
    console.log(`backend listening on http://localhost:${PORT}`);
    console.log(`  bucket:           ${BUCKET}`);
    console.log(`  region:           ${REGION}`);
    console.log(`  uploader role:    ${UPLOADER_ROLE_ARN}`);
    console.log(`  viewer role:      ${VIEWER_ROLE_ARN}`);
    console.log(`  broker profile:   ${ADMIN_PROFILE}`);
  });
}

export default app;
