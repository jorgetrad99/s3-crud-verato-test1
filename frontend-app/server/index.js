import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import multer from "multer";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { STSClient, AssumeRoleCommand } from "@aws-sdk/client-sts";
import { fromIni } from "@aws-sdk/credential-providers";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, ".env") });

const REGION = process.env.AWS_REGION;
const BUCKET = process.env.BUCKET_NAME;
const ROLE_ARN = process.env.ROLE_ARN;
const EXTERNAL_ID = process.env.EXTERNAL_ID;
const ADMIN_PROFILE = process.env.AWS_ADMIN_PROFILE || "default";
const IS_SERVERLESS = !!process.env.VERCEL;

if (!BUCKET) console.error("BUCKET_NAME missing");
if (!ROLE_ARN) console.warn("ROLE_ARN missing — uploads will fail");

const MAX_BUCKET_OBJECTS = 50;
const MAX_FILE_BYTES = 10 * 1024 * 1024;

// ---------- hardcoded users ----------
const USERS = {
  admin:  { password: "admin1234",  role: "admin"  },
  viewer: { password: "viewer1234", role: "viewer" },
};

// stateless tokens: HMAC-signed payload so any serverless instance can verify
// without shared state. TOKEN_SECRET must be a stable env var in production.
const TOKEN_SECRET =
  process.env.TOKEN_SECRET || crypto.randomBytes(32).toString("hex");
const TOKEN_TTL_SECONDS = 8 * 60 * 60;

function signToken(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto
    .createHmac("sha256", TOKEN_SECRET)
    .update(body)
    .digest("base64url");
  return `${body}.${sig}`;
}

function verifyToken(token) {
  if (!token || typeof token !== "string") return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = crypto
    .createHmac("sha256", TOKEN_SECRET)
    .update(body)
    .digest("base64url");
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

// ---------- AWS clients ----------
// reader client uses reader-1 creds from .env (proves the read policy)
const readerClient = new S3Client({
  region: REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

// upload client: assumes the integration role on demand. In serverless
// (Vercel) we use ADMIN_AWS_* env credentials; locally we fall back to
// the named profile in ~/.aws/credentials. Cached until expiry.
function adminCredentials() {
  if (process.env.ADMIN_AWS_ACCESS_KEY_ID && process.env.ADMIN_AWS_SECRET_ACCESS_KEY) {
    return {
      accessKeyId: process.env.ADMIN_AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.ADMIN_AWS_SECRET_ACCESS_KEY,
    };
  }
  return fromIni({ profile: ADMIN_PROFILE });
}

let uploadClientCache = null;
async function getUploadClient() {
  const now = Date.now();
  if (uploadClientCache && uploadClientCache.expiresAt - now > 60_000) {
    return uploadClientCache.client;
  }
  const sts = new STSClient({
    region: REGION,
    credentials: adminCredentials(),
  });
  const { Credentials } = await sts.send(
    new AssumeRoleCommand({
      RoleArn: ROLE_ARN,
      RoleSessionName: "frontend-upload",
      ExternalId: EXTERNAL_ID,
      DurationSeconds: 900,
    })
  );
  const client = new S3Client({
    region: REGION,
    credentials: {
      accessKeyId: Credentials.AccessKeyId,
      secretAccessKey: Credentials.SecretAccessKey,
      sessionToken: Credentials.SessionToken,
    },
  });
  uploadClientCache = { client, expiresAt: new Date(Credentials.Expiration).getTime() };
  return client;
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

app.post("/api/login", (req, res) => {
  const { username, password } = req.body || {};
  const u = USERS[username];
  if (!u || u.password !== password) {
    return res.status(401).json({ error: "Invalid credentials" });
  }
  const now = Math.floor(Date.now() / 1000);
  const token = signToken({
    username,
    role: u.role,
    iat: now,
    exp: now + TOKEN_TTL_SECONDS,
  });
  res.json({ token, user: username, role: u.role });
});

app.post("/api/logout", auth, (_req, res) => {
  // stateless tokens — client just drops it locally
  res.json({ ok: true });
});

app.get("/api/me", auth, (req, res) => res.json(req.user));

async function listAssets() {
  const list = await readerClient.send(
    new ListObjectsV2Command({ Bucket: BUCKET, Prefix: "assets/" })
  );
  return (list.Contents || []).filter((o) => o.Size > 0);
}

app.get("/api/images", auth, async (_req, res) => {
  try {
    const items = await listAssets();
    const images = items.map((obj) => ({
      key: obj.Key,
      name: obj.Key.replace("assets/", ""),
      size: obj.Size,
      lastModified: obj.LastModified,
    }));
    res.json({
      count: images.length,
      limit: MAX_BUCKET_OBJECTS,
      full: images.length >= MAX_BUCKET_OBJECTS,
      images,
    });
  } catch (err) {
    console.error("[images]", err);
    res.status(500).json({ error: err.message });
  }
});

// Auth-proxied download: returns the bytes only to logged-in users.
// No public/presigned URLs ever leave the server.
app.get("/api/asset/:filename", auth, async (req, res) => {
  const { filename } = req.params;
  if (!filename || filename.includes("/") || filename.includes("..")) {
    return res.status(400).json({ error: "invalid filename" });
  }
  const key = `assets/${filename}`;
  try {
    const obj = await readerClient.send(
      new GetObjectCommand({ Bucket: BUCKET, Key: key })
    );
    if (obj.ContentType) res.setHeader("Content-Type", obj.ContentType);
    if (obj.ContentLength != null) res.setHeader("Content-Length", obj.ContentLength);
    res.setHeader("Cache-Control", "private, no-store");
    obj.Body.pipe(res);
  } catch (err) {
    if (err.name === "NoSuchKey" || err.$metadata?.httpStatusCode === 404) {
      return res.status(404).json({ error: "not found" });
    }
    console.error("[asset]", err);
    res.status(500).json({ error: err.message });
  }
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES, files: MAX_BUCKET_OBJECTS },
});

app.post(
  "/api/upload",
  auth,
  requireAdmin,
  upload.array("files", MAX_BUCKET_OBJECTS),
  async (req, res) => {
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: "no files" });

    let currentCount;
    try {
      currentCount = (await listAssets()).length;
    } catch (err) {
      console.error("[upload/count]", err);
      return res.status(500).json({ error: `cannot read bucket: ${err.message}` });
    }

    if (currentCount >= MAX_BUCKET_OBJECTS) {
      return res.status(409).json({
        error: `bucket lleno (${currentCount}/${MAX_BUCKET_OBJECTS}). Elimina recursos antes de subir más.`,
        currentCount,
        limit: MAX_BUCKET_OBJECTS,
      });
    }
    if (currentCount + files.length > MAX_BUCKET_OBJECTS) {
      const allowed = MAX_BUCKET_OBJECTS - currentCount;
      return res.status(409).json({
        error: `solo caben ${allowed} archivo(s) más antes de llegar al límite de ${MAX_BUCKET_OBJECTS}. Estás intentando subir ${files.length}.`,
        currentCount,
        limit: MAX_BUCKET_OBJECTS,
      });
    }

    let s3;
    try {
      s3 = await getUploadClient();
    } catch (err) {
      console.error("[assume-role]", err);
      return res.status(500).json({ error: `AssumeRole failed: ${err.message}` });
    }

    const results = await Promise.all(
      files.map(async (f) => {
        const safeName = f.originalname.replaceAll(/[^A-Za-z0-9._-]/g, "_");
        const key = `assets/${safeName}`;
        try {
          await s3.send(new PutObjectCommand({
            Bucket: BUCKET,
            Key: key,
            Body: f.buffer,
            ContentType: f.mimetype || "application/octet-stream",
          }));
          return { name: f.originalname, ok: true, key };
        } catch (e) {
          return { name: f.originalname, ok: false, error: e.message };
        }
      })
    );
    const uploaded = results.filter((r) => r.ok).length;
    res.json({ uploaded, total: files.length, results });
  }
);

app.post("/api/delete", auth, requireAdmin, async (req, res) => {
  const { key } = req.body || {};
  if (!key || typeof key !== "string" || !key.startsWith("assets/") || key.includes("..")) {
    return res.status(400).json({ error: "invalid key" });
  }
  try {
    const s3 = await getUploadClient();
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
    res.json({ ok: true, key });
  } catch (err) {
    console.error("[delete]", err);
    res.status(500).json({ error: err.message });
  }
});

if (!IS_SERVERLESS) {
  const PORT = process.env.PORT || 3001;
  app.listen(PORT, () => {
    console.log(`backend listening on http://localhost:${PORT}`);
    console.log(`  bucket: ${BUCKET}`);
    console.log(`  region: ${REGION}`);
    console.log(`  admin uploader role: ${ROLE_ARN}`);
    console.log(`  admin profile: ${ADMIN_PROFILE}`);
  });
}

export default app;
