const PORT = process.env.PORT || 3000;
const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const amqp = require('amqplib');
const { v4: uuidv4 } = require('uuid');

const logger = require("./logger");

const app = express();
app.use(express.json());

app.use((req, res, next) => {
  req.trace_id = uuidv4(); // unique for each request
  next();
});

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET;

let channel;

async function initRabbit(retries = 10, delay = 3000) {
  for (let i = 0; i < retries; i++) {
    try {
      const conn = await amqp.connect(process.env.RABBITMQ_URL);
      channel = await conn.createChannel();
      await channel.assertQueue('UserRegistered');
      logger.info('Connected to RabbitMQ');
      return;
    } catch {
      logger.warn(`RabbitMQ connection failed, retrying in ${delay / 1000}s... (${i + 1}/${retries})`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  logger.error("Could not connect to RabbitMQ after multiple attempts");
  throw new Error('Could not connect to RabbitMQ');
}

initRabbit().catch(err => logger.error(err));

app.post('/auth/register', async (req, res) => {
  try {
    logger.info("Register attempt", { username: req.body.username });
    const { username, password } = req.body;
    const hashed = await bcrypt.hash(password, 10);
    const id = uuidv4();

    await pool.query(
      'INSERT INTO auth.users (id, username, password_hash) VALUES ($1, $2, $3)',
      [id, username, hashed]
    );

    if (channel) {
      channel.sendToQueue('UserRegistered', Buffer.from(JSON.stringify({ user_id: id, username })));
    } else {
      logger.warn('RabbitMQ channel not ready, skipping message publish');
    }

    res.json({ message: 'User created', user_id: id });
  } catch (err) {
    logger.error('Error in /auth/register', { error: err });
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/auth/login', async (req, res) => {
  try {
    logger.info("Login attempt", { username: req.body.username });
    const { username, password } = req.body;
    const result = await pool.query(
      'SELECT * FROM auth.users WHERE username=$1',
      [username]
    );

    const user = result.rows[0];
    if (!user) {
      logger.warn("Login failed: user not found", { username });
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      logger.warn("Login failed: invalid password", { username });
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign({ sub: user.id, username: user.username }, JWT_SECRET, { expiresIn: '1h' });
    logger.info("Login successful", { user_id: user.id });

    res.json({ access_token: token, token_type: 'Bearer', expires_in: 3600 });
  } catch (err) {
    logger.error('Error in /auth/login', { error: err });
    res.status(500).json({ error: 'Internal server error' });
  }
});


app.listen(PORT, () => logger.info(`Auth Service running on port ${PORT}`));