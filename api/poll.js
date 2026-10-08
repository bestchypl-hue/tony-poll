// Serverless function: GET /api/poll?voter=<id> and POST /api/poll
// Votes live in one Redis hash: field = sha256(voter id), value = choice.
// The response only ever contains totals, never the voter ids.

const crypto = require("crypto");

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const KEY = "tony-poll:votes";
const CHOICES = ["yes", "yesred"];

async function redis(commands) {
  const r = await fetch(REDIS_URL.replace(/\/$/, "") + "/pipeline", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + REDIS_TOKEN,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(commands),
  });
  if (!r.ok) throw new Error("redis " + r.status);
  const out = await r.json();
  out.forEach(function (item) {
    if (item && item.error) throw new Error("redis " + item.error);
  });
  return out;
}

function hashVoter(voter) {
  return crypto.createHash("sha256").update(voter).digest("hex").slice(0, 32);
}

function validVoter(voter) {
  return typeof voter === "string" && voter.length >= 8 && voter.length <= 100;
}

// HGETALL arrives as a flat [field, value, field, value, ...] array.
function tally(flat) {
  const counts = { yes: 0, yesred: 0 };
  if (Array.isArray(flat)) {
    for (let i = 1; i < flat.length; i += 2) {
      if (CHOICES.indexOf(flat[i]) !== -1) counts[flat[i]]++;
    }
  }
  return counts;
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (!REDIS_URL || !REDIS_TOKEN) {
    return res.status(500).json({ error: "storage_not_configured" });
  }

  try {
    if (req.method === "POST") {
      let body = req.body;
      if (typeof body === "string") {
        try { body = JSON.parse(body); } catch (e) { body = {}; }
      }
      body = body || {};
      if (!validVoter(body.voter) || CHOICES.indexOf(body.choice) === -1) {
        return res.status(400).json({ error: "bad_request" });
      }
      const out = await redis([
        ["HSET", KEY, hashVoter(body.voter), body.choice],
        ["HGETALL", KEY],
      ]);
      return res.status(200).json({ counts: tally(out[1].result), mine: body.choice });
    }

    if (req.method === "GET") {
      const voter = req.query && req.query.voter;
      const commands = [["HGETALL", KEY]];
      if (validVoter(voter)) commands.push(["HGET", KEY, hashVoter(voter)]);
      const out = await redis(commands);
      const mineRaw = out[1] ? out[1].result : null;
      const mine = CHOICES.indexOf(mineRaw) !== -1 ? mineRaw : null;
      return res.status(200).json({ counts: tally(out[0].result), mine: mine });
    }

    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "method_not_allowed" });
  } catch (e) {
    return res.status(502).json({ error: "storage_error" });
  }
};
