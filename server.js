require("dotenv").config();

const express = require("express");
const { MongoClient } = require("mongodb");
const crypto = require("node:crypto");
const path = require("node:path");

const app = express();
const port = process.env.PORT || 3000;
const mongoUri = process.env.MONGODB_URI;
const adminToken = process.env.ADMIN_TOKEN;

if (!mongoUri) throw new Error("MONGODB_URI is required");
if (!adminToken) throw new Error("ADMIN_TOKEN is required");

const client = new MongoClient(mongoUri);
let games;

app.use(express.json({ limit: "10kb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/health", (_req, res) => {
  res.json({ ok: Boolean(games) });
});

// Save one completed game result.
app.post("/api/results", async (req, res) => {
  try {
    const { clientId, mode, outcome } = req.body || {};

    if (
      typeof clientId !== "string" ||
      !/^[a-f0-9-]{36}$/i.test(clientId) ||
      !["ai", "local"].includes(mode) ||
      !["win", "loss", "draw"].includes(outcome)
    ) {
      return res.status(400).json({ error: "Invalid game result" });
    }

    await games.insertOne({
      clientId,
      mode,
      outcome,
      createdAt: new Date()
    });

    res.status(201).json({ saved: true });
  } catch (error) {
    console.error("Could not save result:", error.message);
    res.status(503).json({ error: "Could not save result" });
  }
});

// A player can retrieve stats for the ID stored in their own browser.
app.get("/api/stats/:clientId", async (req, res) => {
  const { clientId } = req.params;

  if (!/^[a-f0-9-]{36}$/i.test(clientId)) {
    return res.status(400).json({ error: "Invalid player ID" });
  }

  try {
    const [stats] = await games.aggregate([
      { $match: { clientId, mode: "ai" } },
      {
        $group: {
          _id: null,
          played: { $sum: 1 },
          wins: { $sum: { $cond: [{ $eq: ["$outcome", "win"] }, 1, 0] } },
          losses: { $sum: { $cond: [{ $eq: ["$outcome", "loss"] }, 1, 0] } },
          draws: { $sum: { $cond: [{ $eq: ["$outcome", "draw"] }, 1, 0] } }
        }
      },
      { $project: { _id: 0, played: 1, wins: 1, losses: 1, draws: 1 } }
    ]).toArray();

    res.json(stats || { played: 0, wins: 0, losses: 0, draws: 0 });
  } catch (error) {
    console.error("Could not load stats:", error.message);
    res.status(503).json({ error: "Could not load stats" });
  }
});

// Private owner view: send your ADMIN_TOKEN as a Bearer token.
app.get("/api/admin/stats", async (req, res) => {
  const supplied = req.get("authorization") || "";
  const expected = `Bearer ${adminToken}`;

  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const [summary] = await games.aggregate([
      {
        $group: {
          _id: { mode: "$mode", outcome: "$outcome" },
          count: { $sum: 1 }
        }
      }
    ]).toArray();

    const totals = await games.countDocuments();
    const byMode = await games.aggregate([
      {
        $group: {
          _id: { mode: "$mode", outcome: "$outcome" },
          count: { $sum: 1 }
        }
      },
      {
        $project: {
          _id: 0,
          mode: "$_id.mode",
          outcome: "$_id.outcome",
          count: 1
        }
      }
    ]).toArray();

    res.json({ totalGames: totals, results: byMode });
  } catch (error) {
    console.error("Could not load admin stats:", error.message);
    res.status(503).json({ error: "Could not load stats" });
  }
});

async function start() {
  await client.connect();
  const db = client.db(process.env.MONGODB_DB || "playroom");
  games = db.collection("game_results");
  await games.createIndex({ clientId: 1, mode: 1, createdAt: -1 });
  app.listen(port, () => console.log(`Server listening on ${port}`));
}

start().catch(error => {
  console.error("Startup failed:", error);
  process.exit(1);
});