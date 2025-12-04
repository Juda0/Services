const express = require("express");
const { Pool } = require("pg");
const amqp = require("amqplib");
const jwt = require("jsonwebtoken");

const app = express();
app.use(express.json());

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET;

let channel;

// ---------------------------
// JWT AUTH MIDDLEWARE
// ---------------------------
function authenticate(req, res, next) {
  // Authorization header key is not capital sensitive but in the VALUE of the header "Bearer... *JWTHERE*"
  // The Bearer part is case sensitive!
  const header = req.headers["authorization"];
  if (!header || !header.startsWith("Bearer ")) {
    return res
      .status(401)
      .json({ error: "Missing or invalid Authorization header" });
  }

  const access_token = header.split(" ")[1];

  try {
    const payload = jwt.verify(access_token, JWT_SECRET);
    req.user = payload; // attach token payload to the request
    next();
  } catch (err) {
    return res.status(403).json({ error: "Invalid or expired token" });
  }
}

// RABBITMQ INITIALIZATION
async function initRabbit(retries = 10, delay = 3000) {
  for (let i = 0; i < retries; i++) {
    try {
      const conn = await amqp.connect(process.env.RABBITMQ_URL);
      channel = await conn.createChannel();
      await channel.assertQueue("UserRegistered");

      // Consume UserRegistered events
      channel.consume("UserRegistered", async (msg) => {
        const { user_id, username } = JSON.parse(msg.content.toString());
        await pool.query(
          `INSERT INTO user_profiles.users (id, username)
           VALUES ($1, $2)
           ON CONFLICT (id) DO NOTHING`,
          [user_id, username],
        );
        channel.ack(msg);
      });

      console.log("Connected to RabbitMQ and consuming UserRegistered queue");
      return;
    } catch (err) {
      console.log(
        `RabbitMQ connection failed, retrying in ${delay / 1000}s... (${i + 1}/${retries})`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error("Could not connect to RabbitMQ after multiple attempts");
}

initRabbit().catch(console.error);

// ---------------------------
// PROTECTED ROUTES
// ---------------------------

// Get a user's public key (requires JWT)
app.get("/users/:id/public-key", authenticate, async (req, res) => {
  const { id } = req.params;

  const result = await pool.query(
    "SELECT public_key FROM user_profiles.users WHERE id=$1",
    [id],
  );

  if (!result.rows[0]) {
    return res.status(404).json({ error: "User not found" });
  }

  res.json({ public_key: result.rows[0].public_key });
});

app.listen(3001, () => console.log("User Service running on port 3001"));
