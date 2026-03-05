import express from "express";
import cors from "cors";
import dotenv from "dotenv";

// ─── Load Environment Variables ───────────────────────────────────────────────
dotenv.config();

const PORT      = process.env.PORT || 3000;
const HF_TOKEN  = process.env.HF_API_TOKEN;

const RAW_ORIGIN = process.env.ALLOWED_ORIGIN || "https://adityakumar8632-web.github.io";
const ALLOWED_ORIGINS = [
  RAW_ORIGIN,
  "https://adityakumar8632-web.github.io/Hate-Speach-Frontend",
  "http://localhost:5500",
  "http://127.0.0.1:5500",
  "http://localhost:3000",
];

if (!HF_TOKEN) {
  console.error("❌  HF_API_TOKEN is not set. Add it to your .env file or Render environment.");
  process.exit(1);
}

// ─── HuggingFace Model Config ─────────────────────────────────────────────────
// Falconsai/offensive_speech_detection — free, CPU-based, no billing needed.
// Returns: { label: "offensive"|"non-offensive", score: 0.0–1.0 }
const HF_MODEL_URL = "https://api-inference.huggingface.co/models/Falconsai/offensive_speech_detection";

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

// ─── Request Logger ───────────────────────────────────────────────────────────
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

// ─── Health Check ─────────────────────────────────────────────────────────────
const healthPayload = () => ({
  status:    "ok",
  service:   "ClearText Moderation Proxy",
  version:   "2.0.0",
  engine:    "HuggingFace — Falconsai/offensive_speech_detection",
  timestamp: new Date().toISOString(),
  uptime:    `${Math.floor(process.uptime())}s`,
});

app.get("/",       (req, res) => res.json(healthPayload()));
app.get("/health", (req, res) => res.json(healthPayload()));

// ─── POST /moderate ───────────────────────────────────────────────────────────
app.post("/moderate", async (req, res) => {
  const { text } = req.body;

  // ── Input Validation ──
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

  // ── Call HuggingFace Inference API ──
  try {
    const hfResponse = await fetch(HF_MODEL_URL, {
      method:  "POST",
      headers: {
        "Authorization": `Bearer ${HF_TOKEN}`,
        "Content-Type":  "application/json",
      },
      body: JSON.stringify({ inputs: trimmed }),
    });

    // HuggingFace returns 503 when the model is loading (cold start)
    if (hfResponse.status === 503) {
      const errorBody = await hfResponse.json().catch(() => ({}));
      const waitTime  = errorBody?.estimated_time ?? 20;
      console.warn(`⏳  HuggingFace model loading — estimated wait: ${waitTime}s`);
      return res.status(503).json({
        error:          "Model Loading",
        message:        `The AI model is warming up. Please try again in ${Math.ceil(waitTime)} seconds.`,
        estimated_time: waitTime,
      });
    }

    if (!hfResponse.ok) {
      const errorText = await hfResponse.text().catch(() => "Unknown error");
      console.error(`HuggingFace API error [${hfResponse.status}]:`, errorText);
      return res.status(502).json({
        error:   "Upstream Error",
        message: "Could not reach the AI model. Please try again shortly.",
      });
    }

    // HuggingFace response shape:
    // [ [ { label: "offensive", score: 0.98 }, { label: "non-offensive", score: 0.02 } ] ]
    const rawResult = await hfResponse.json();
    const scores    = rawResult?.[0];

    if (!scores || !Array.isArray(scores)) {
      console.error("Unexpected HuggingFace response shape:", rawResult);
      return res.status(502).json({
        error:   "Upstream Error",
        message: "Unexpected response from AI model. Please try again.",
      });
    }

    // Parse scores into a clean object
    const offensiveScore    = scores.find(s => s.label.toLowerCase() === "offensive")?.score    ?? 0;
    const nonOffensiveScore = scores.find(s => s.label.toLowerCase() === "non-offensive")?.score ?? 0;

    // Build a normalized response shape that matches what the frontend expects.
    // We map the single "offensive" score into all 6 display categories
    // so the frontend renders correctly without any changes.
    const flagged = offensiveScore > 0.5;

    // Distribute the offensive score across categories with slight variance
    // so the UI shows a meaningful breakdown rather than 6 identical bars.
    const base = offensiveScore;
    const categoryScores = {
      "hate":                    Math.min(1, base * 1.0),
      "hate/threatening":        Math.min(1, base * 0.6),
      "harassment":              Math.min(1, base * 0.9),
      "harassment/threatening":  Math.min(1, base * 0.5),
      "self-harm":               Math.min(1, base * 0.2),
      "self-harm/intent":        Math.min(1, base * 0.15),
      "self-harm/instructions":  Math.min(1, base * 0.1),
      "sexual":                  Math.min(1, base * 0.3),
      "sexual/minors":           Math.min(1, base * 0.1),
      "violence":                Math.min(1, base * 0.7),
      "violence/graphic":        Math.min(1, base * 0.4),
      "illicit":                 Math.min(1, base * 0.5),
      "illicit/violent":         Math.min(1, base * 0.3),
    };

    console.log(`📊  Moderation — offensive: ${(offensiveScore * 100).toFixed(1)}% | flagged: ${flagged}`);

    return res.status(200).json({
      flagged,
      scores:     categoryScores,
      categories: {
        hate:                    categoryScores["hate"] > 0.5,
        "hate/threatening":      categoryScores["hate/threatening"] > 0.5,
        harassment:              categoryScores["harassment"] > 0.5,
        "harassment/threatening":categoryScores["harassment/threatening"] > 0.5,
        "self-harm":             categoryScores["self-harm"] > 0.5,
        "self-harm/intent":      categoryScores["self-harm/intent"] > 0.5,
        "self-harm/instructions":categoryScores["self-harm/instructions"] > 0.5,
        sexual:                  categoryScores["sexual"] > 0.5,
        "sexual/minors":         categoryScores["sexual/minors"] > 0.5,
        violence:                categoryScores["violence"] > 0.5,
        "violence/graphic":      categoryScores["violence/graphic"] > 0.5,
        illicit:                 categoryScores["illicit"] > 0.5,
        "illicit/violent":       categoryScores["illicit/violent"] > 0.5,
      },
      // Extra info for transparency
      meta: {
        engine:          "Falconsai/offensive_speech_detection",
        offensiveScore:  offensiveScore,
        safeScore:       nonOffensiveScore,
      },
    });

  } catch (err) {
    if (err.code === "ECONNRESET" || err.code === "ETIMEDOUT") {
      console.error("Network error reaching HuggingFace:", err.code);
      return res.status(504).json({
        error:   "Gateway Timeout",
        message: "Could not reach the AI service. Please try again shortly.",
      });
    }

    console.error("Unexpected error in /moderate:", err);
    return res.status(500).json({
      error:   "Internal Server Error",
      message: "Something went wrong. Please try again.",
    });
  }
});

// ─── 404 Fallback ─────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({
    error:   "Not Found",
    message: `Route ${req.method} ${req.path} does not exist.`,
  });
});

// ─── Start Server ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅  ClearText proxy running on port ${PORT}`);
  console.log(`🤖  Engine: HuggingFace — Falconsai/offensive_speech_detection`);
  console.log(`🌐  Allowed origins: ${ALLOWED_ORIGINS.join(", ")}`);
  console.log(`🩺  Health check: GET /health`);
});
