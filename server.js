import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";

// ─── Load Environment Variables ───────────────────────────────────────────────
dotenv.config();

const PORT         = process.env.PORT || 3000;
const OPENAI_KEY   = process.env.OPENAI_API_KEY;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*"; // e.g. https://yourname.github.io

if (!OPENAI_KEY) {
  console.error("❌  OPENAI_API_KEY is not set. Add it to your .env file or Render environment.");
  process.exit(1);
}

// ─── OpenAI Client ────────────────────────────────────────────────────────────
const openai = new OpenAI({ apiKey: OPENAI_KEY });

// ─── Express App ──────────────────────────────────────────────────────────────
const app = express();

// CORS — restrict to your GitHub Pages origin in production
app.use(cors({
  origin: ALLOWED_ORIGIN,
  methods: ["POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"],
}));

// Parse JSON bodies
app.use(express.json({ limit: "20kb" }));

// ─── Health Check ─────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "ClearText Moderation Proxy",
    version: "1.0.0",
  });
});

// ─── POST /moderate ───────────────────────────────────────────────────────────
app.post("/moderate", async (req, res) => {
  const { text } = req.body;

  // ── Input validation ──
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

  // ── Call OpenAI Moderation API ──
  try {
    const moderation = await openai.moderations.create({
      model: "omni-moderation-latest",
      input: trimmed,
    });

    const result = moderation.results[0];

    return res.status(200).json({
      flagged:    result.flagged,
      categories: result.categories,
      scores:     result.category_scores,
    });

  } catch (err) {
    // OpenAI API error
    if (err?.status) {
      console.error(`OpenAI API error [${err.status}]:`, err.message);
      return res.status(502).json({
        error: "Upstream Error",
        message: "OpenAI Moderation API returned an error. Please try again.",
      });
    }

    // Network / timeout error
    if (err.code === "ECONNRESET" || err.code === "ETIMEDOUT") {
      console.error("Network error reaching OpenAI:", err.code);
      return res.status(504).json({
        error: "Gateway Timeout",
        message: "Could not reach OpenAI. Please try again shortly.",
      });
    }

    // Unexpected error
    console.error("Unexpected error in /moderate:", err);
    return res.status(500).json({
      error: "Internal Server Error",
      message: "Something went wrong. Please try again.",
    });
  }
});

// ─── 404 Fallback ─────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: "Not Found", message: `Route ${req.method} ${req.path} does not exist.` });
});

// ─── Start Server ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅  ClearText proxy running on port ${PORT}`);
  console.log(`🌐  CORS origin: ${ALLOWED_ORIGIN}`);
});
