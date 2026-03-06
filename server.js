import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const PORT     = process.env.PORT || 3000;
const HF_TOKEN = process.env.HF_API_TOKEN;

// ─── Model: bert-base-uncased-hatexplain ──────────────────────────────────────
// Returns labels: "hatespeech", "offensive", "normal"
// More reliable on HuggingFace free tier than Falconsai
const HF_MODEL_URL = "https://router.huggingface.co/hf-inference/models/Hate-speech-CNERG/bert-base-uncased-hatexplain";

const app = express();

// ─── CORS — Allow ALL origins ─────────────────────────────────────────────────
app.use(cors());
app.options("*", cors());
app.use(express.json({ limit: "20kb" }));

// ─── Request Logger ───────────────────────────────────────────────────────────
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    const ms   = Date.now() - start;
    const icon = res.statusCode >= 500 ? "❌" : res.statusCode >= 400 ? "⚠️" : "✅";
    console.log(`${icon} ${req.method} ${req.path} → ${res.statusCode} (${ms}ms)`);
  });
  next();
});

// ─── Health ───────────────────────────────────────────────────────────────────
app.get("/",       (req, res) => res.json({ status: "ok", service: "ClearText", version: "2.0.0", uptime: `${Math.floor(process.uptime())}s` }));
app.get("/health", (req, res) => res.json({ status: "ok", service: "ClearText", version: "2.0.0", uptime: `${Math.floor(process.uptime())}s` }));

// ─── POST /moderate ───────────────────────────────────────────────────────────
app.post("/moderate", async (req, res) => {

  if (!HF_TOKEN) {
    console.error("❌ HF_API_TOKEN not set.");
    return res.status(500).json({ error: "Server Misconfigured", message: "API token not configured." });
  }

  const { text } = req.body;
  if (!text || typeof text !== "string" || text.trim().length === 0) {
    return res.status(400).json({ error: "Bad Request", message: "Please provide a non-empty 'text' field." });
  }
  const trimmed = text.trim();
  if (trimmed.length > 5000) {
    return res.status(400).json({ error: "Bad Request", message: "'text' must not exceed 5,000 characters." });
  }

  try {
    const hfRes = await fetch(HF_MODEL_URL, {
      method:  "POST",
      headers: {
        "Authorization": `Bearer ${HF_TOKEN}`,
        "Content-Type":  "application/json",
      },
      body: JSON.stringify({ inputs: trimmed }),
    });

    console.log(`🤖 HuggingFace status: ${hfRes.status}`);

    // 503 = model cold-starting
    if (hfRes.status === 503) {
      const body     = await hfRes.json().catch(() => ({}));
      const waitTime = Math.ceil(body?.estimated_time ?? 20);
      console.warn(`⏳ Model loading (~${waitTime}s)`);
      return res.status(503).json({
        error: "Model Loading",
        message: `The AI model is warming up. Please try again in ${waitTime} seconds.`,
        estimated_time: waitTime,
      });
    }

    if (!hfRes.ok) {
      const errText = await hfRes.text().catch(() => "");
      console.error(`❌ HuggingFace error [${hfRes.status}]:`, errText);
      return res.status(502).json({ error: "Upstream Error", message: "AI service returned an error. Please try again." });
    }

    const raw = await hfRes.json();
    console.log("🤖 Raw response:", JSON.stringify(raw));

    // Response shape: [ [ { label: "hatespeech", score: 0.9 }, { label: "offensive", score: 0.07 }, { label: "normal", score: 0.03 } ] ]
    const labels = Array.isArray(raw?.[0]) ? raw[0] : Array.isArray(raw) ? raw : null;

    if (!labels) {
      console.error("Unexpected shape:", raw);
      return res.status(502).json({ error: "Upstream Error", message: "Unexpected AI response. Please try again." });
    }

    // Extract scores by label name
    const hateScore      = labels.find(s => s.label.toLowerCase().includes("hate"))?.score      ?? 0;
    const offenseScore   = labels.find(s => s.label.toLowerCase().includes("offensive"))?.score  ?? 0;
    const normalScore    = labels.find(s => s.label.toLowerCase().includes("normal"))?.score     ?? 0;

    // Overall harm score = max of hate + offensive
    const harmScore = Math.max(hateScore, offenseScore);
    const flagged   = harmScore > 0.5;
    const b         = harmScore;

    console.log(`📊 hate: ${(hateScore*100).toFixed(1)}% | offensive: ${(offenseScore*100).toFixed(1)}% | normal: ${(normalScore*100).toFixed(1)}% | flagged: ${flagged}`);

    // Map to frontend category scores
    const scores = {
      "hate":                    +(Math.min(1, hateScore * 1.00)).toFixed(4),
      "hate/threatening":        +(Math.min(1, hateScore * 0.70)).toFixed(4),
      "harassment":              +(Math.min(1, offenseScore * 1.00)).toFixed(4),
      "harassment/threatening":  +(Math.min(1, offenseScore * 0.60)).toFixed(4),
      "self-harm":               +(Math.min(1, b * 0.20)).toFixed(4),
      "self-harm/intent":        +(Math.min(1, b * 0.15)).toFixed(4),
      "self-harm/instructions":  +(Math.min(1, b * 0.10)).toFixed(4),
      "sexual":                  +(Math.min(1, b * 0.30)).toFixed(4),
      "sexual/minors":           +(Math.min(1, b * 0.10)).toFixed(4),
      "violence":                +(Math.min(1, b * 0.70)).toFixed(4),
      "violence/graphic":        +(Math.min(1, b * 0.40)).toFixed(4),
      "illicit":                 +(Math.min(1, b * 0.50)).toFixed(4),
      "illicit/violent":         +(Math.min(1, b * 0.30)).toFixed(4),
    };

    return res.status(200).json({
      flagged,
      scores,
      categories: Object.fromEntries(Object.entries(scores).map(([k, v]) => [k, v > 0.5])),
    });

  } catch (err) {
    console.error("Unexpected error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Something went wrong. Please try again." });
  }
});

// ─── 404 ──────────────────────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: "Not Found", message: `${req.method} ${req.path} does not exist.` }));

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ ClearText running on port ${PORT}`);
  console.log(`🤖 Model: Hate-speech-CNERG/bert-base-uncased-hatexplain`);
  console.log(`🔑 HF Token: ${HF_TOKEN ? "SET ✓" : "NOT SET ✗"}`);
});
