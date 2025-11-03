import express from "express";
import dotenv from "dotenv";
import cookieParser from "cookie-parser";
import { Low } from "lowdb";
import { JSONFile } from "lowdb/node";
import SftpClient from "ssh2-sftp-client";
import path from "path";
import fs from "fs";
import cron from "node-cron";
import { fileURLToPath } from "url";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(express.static(__dirname));

// --- ENV VARIABLES ---
const {
  SFTP_HOST,
  SFTP_PORT,
  SFTP_USER,
  SFTP_PASS,
  ACCESS_PIN,
} = process.env;

// --- LOWDB SETUP ---
const dbFile = path.join(__dirname, "db.json");
const adapter = new JSONFile(dbFile);
const db = new Low(adapter, { favorites: {}, renames: {} }); // ✅ default data

// make sure db file exists
await db.read();
db.data ||= { favorites: {}, renames: {} };
await db.write();

// --- SFTP CONNECT ---
function sftpConnect() {
  const sftp = new SftpClient();
  return sftp.connect({
    host: SFTP_HOST,
    port: SFTP_PORT,
    username: SFTP_USER,
    password: SFTP_PASS,
  });
}

// --- PIN Middleware ---
app.use((req, res, next) => {
  const pinCookie = req.cookies?.access_pin;
  if (req.path === "/verify-pin" || pinCookie === ACCESS_PIN) return next();
  return res.sendFile(path.join(__dirname, "index.html"));
});

// --- Verify PIN ---
app.post("/verify-pin", (req, res) => {
  const { pin } = req.body;
  if (pin === ACCESS_PIN) {
    res.cookie("access_pin", pin, { maxAge: 86400000 }); // 1 day
    return res.json({ success: true });
  }
  res.status(403).json({ success: false, message: "Invalid PIN" });
});

// --- AUTO CLEANUP (Recycle older than 30 days) ---
cron.schedule("0 3 * * *", async () => {
  const sftp = await sftpConnect();
  const recyclePath = "/web/RecycleBin";
  try {
    const files = await sftp.list(recyclePath);
    const now = Date.now();
    for (const f of files) {
      const age = (now - new Date(f.modifyTime).getTime()) / (1000 * 60 * 60 * 24);
      if (age > 30) {
        await sftp.delete(`${recyclePath}/${f.name}`);
        console.log(`🧹 Deleted old file: ${f.name}`);
      }
    }
  } catch (err) {
    console.error("Recycle cleanup error:", err);
  } finally {
    sftp.end();
  }
});

// --- START SERVER ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running at http://localhost:${PORT}`));
