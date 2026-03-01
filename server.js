import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";

// ─── Load Environment Variables ───────────────────────────────────────────────
dotenv.config();

const PORT        = process.env.PORT || 3000;
const OPENAI_KEY  = process.env.OPENAI_API_KEY;

const RAW_ORIGIN  = process.env.ALLOWED_ORIGIN || "https://adityakumar8632-web.github.io";
const ALLOWED_ORIGINS = [
  RAW_ORIGIN,
  "https://adityakumar8632-web.github.io/Hate-Speach-Frontend",
  "http://localhost:5500",
  "http://127.0.0.1:5500",
  "http://localhost:3000",
];

if (!OPENAI_KEY) {
  console.error("❌  OPENAI_API_KEY is not set. Add it to your .env file or Render environment.");
  process.exit(1);
}

// ─── OpenAI Client ────────────────────────────────────────────────────────────
const openai = new OpenAI({ apiKey: OPENAI_KEY });

// ─── Express App ──────────────────────────────────────────────────────────────
const app = express();

const corsOptions = {
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    return callback(new Error(`CORS policy: Origin ${origin} not allowed.`));
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"],
  optionsSuccessStatus: 200,
};

app.options("*", cors(corsOptions));
app.use(cors(corsOptions));
app.use(express.json({ limit: "20kb" }));

// ─── Request Logger ──────────────────────────────────────────────────────────
// NEW: Logs every successful request so you can see them in Render logs
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    const ms     = Date.now() - start;
    const status = res.statusCode;
    const icon   = status >= 500 ? "❌" : status >= 400 ? "⚠️" : "✅";
    console.log(`${icon}  ${req.method} ${req.path} → ${status} (${ms}ms) [${req.get("origin") || "no-origin"}]`);
  });
  next();
});

// ─── Root / Health Check ─────────────────────────────────────────────────────
// NEW: Both GET / and GET /health return the same health payload
const healthPayload = () => ({
  status:    "ok",
  service:   "ClearText Moderation Proxy",
  version:   "1.0.1",
  timestamp: new Date().toISOString(),
  uptime:    `${Math.floor(process.uptime())}s`,
});

app.get("/",       (req, res) => res.json(healthPayload()));
app.get("/health", (req, res) => res.json(healthPayload()));

// ─── POST /moderate ───────────────────────────────────────────────────────────
app.post("/moderate", async (req, res) => {
  const { text } = req.body;

  if (!text || typeof text !== "string") {
    return res.status(400).json({
      error: "Bad Request",
      message: "Request body must include a non-empty 'text' string.",
    });
  }

  const trimmed = text.trim();

  if (trimmed.length === 0) {
    return res.status(400).json({
      error: "Bad Request",
      message: "'text' must not be blank.",
    });
  }

  if (trimmed.length > 5000) {
    return res.status(400).json({
      error: "Bad Request",
      message: "'text' must not exceed 5,000 characters.",
    });
  }

  try {
    const moderation = await openai.moderations.create({
      model: "omni-moderation-latest",
      input: trimmed,
    });

    if (!moderation.results || moderation.results.length === 0) {
      console.error("OpenAI returned empty results array:", moderation);
      return res.status(502).json({
        error: "Upstream Error",
        message: "OpenAI returned an empty moderation result. Please try again.",
      });
    }

    const result     = moderation.results[0];
    const scores     = JSON.parse(JSON.stringify(result.category_scores));
    const categories = JSON.parse(JSON.stringify(result.categories));

    return res.status(200).json({
      flagged:    result.flagged,
      scores:     scores,
      categories: categories,
    });

  } catch (err) {
    if (err?.status) {
      console.error(`OpenAI API error [${err.status}]:`, err.message);
      return res.status(502).json({
        error: "Upstream Error",
        message: "OpenAI Moderation API returned an error. Please try again.",
      });
    }

    if (err.code === "ECONNRESET" || err.code === "ETIMEDOUT") {
      console.error("Network error reaching OpenAI:", err.code);
      return res.status(504).json({
        error: "Gateway Timeout",
        message: "Could not reach OpenAI. Please try again shortly.",
      });
    }

    if (err.message && err.message.startsWith("CORS policy:")) {
      return res.status(403).json({
        error: "Forbidden",
        message: err.message,
      });
    }

    console.error("Unexpected error in /moderate:", err);
    return res.status(500).json({
      error: "Internal Server Error",
      message: "Something went wrong. Please try again.",
    });
  }
});

// ─── 404 Fallback ─────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({
    error: "Not Found",
    message: `Route ${req.method} ${req.path} does not exist.`,
  });
});

// ─── Start Server ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅  ClearText proxy running on port ${PORT}`);
  console.log(`🌐  Allowed origins: ${ALLOWED_ORIGINS.join(", ")}`);
  console.log(`🩺  Health check: GET /health`);
});
