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
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

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

// in-memory tokens (demo only)
const TOKENS = new Map();
const newToken = () => crypto.randomBytes(24).toString("hex");

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
  const user = TOKENS.get(token);
  if (!user) return res.status(401).json({ error: "Unauthorized" });
  req.user = user;
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
  const token = newToken();
  TOKENS.set(token, { username, role: u.role });
  res.json({ token, user: username, role: u.role });
});

app.post("/api/logout", auth, (req, res) => {
  const token = (req.headers.authorization || "").replace("Bearer ", "");
  TOKENS.delete(token);
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
    const images = await Promise.all(
      items.map(async (obj) => ({
        key: obj.Key,
        name: obj.Key.replace("assets/", ""),
        size: obj.Size,
        lastModified: obj.LastModified,
        url: await getSignedUrl(
          readerClient,
          new GetObjectCommand({ Bucket: BUCKET, Key: obj.Key }),
          { expiresIn: 300 }
        ),
      }))
    );
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
