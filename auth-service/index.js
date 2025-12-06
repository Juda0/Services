const PORT = process.env.PORT || 3000;
const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const amqp = require('amqplib');
const { v4: uuidv4 } = require('uuid');

const logger = require('./logger');

const app = express();
app.use(express.json());

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET || (() => {
  throw new Error("Missing required environment variable: JWT_SECRET");
})();

let channel;

// Middleware to add trace ID
app.use((req, res, next) => {
  req.traceId = uuidv4();
  next();
});

async function initRabbit() {
  while (true) {
    try {
      const conn = await amqp.connect(process.env.RABBITMQ_URL);
      conn.on("error", () => setTimeout(initRabbit, 2000));
      conn.on("close", () => setTimeout(initRabbit, 2000));

      channel = await conn.createChannel();
      await channel.assertQueue('UserRegistered');

      logger.info("Connected to RabbitMQ");
      return;
    } catch (err) {
      logger.warn("RabbitMQ connection failed. Retrying in 3s...");
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}


initRabbit().catch((err) => logger.error(err));

app.post('/auth/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    logger.info('Register attempt', { username: req.body.username, traceId: req.traceId });

    // Basic input validation
    if (!username || !password) {
      logger.warn('Register failed: missing username or password', { traceId: req.traceId, username });
      return res.status(400).json({ error: 'Missing username or password' });
    }
    const hashed = await bcrypt.hash(password, 10);
    const id = uuidv4();

    await pool.query(
      'INSERT INTO auth.users (id, username, password_hash) VALUES ($1, $2, $3)',
      [id, username, hashed]
    );

    if (channel) {
      try {
        channel.sendToQueue(
          'UserRegistered',
          Buffer.from(JSON.stringify({ user_id: id, username, traceId: req.traceId }))
        );
      } catch (pubErr) {
        logger.error('Failed to publish UserRegistered', { error: pubErr && pubErr.message ? pubErr.message : pubErr, traceId: req.traceId });
      }
    } else {
      logger.warn('RabbitMQ channel not ready, skipping message publish', { traceId: req.traceId });
    }

    res.json({ message: 'User created', user_id: id });
  } catch (err) {
    // Log the error with traceId so we can correlate the request in logs
    if (err && err.code === '23505') { // PostgreSQL unique violation
      logger.warn('Register failed: unique violation', { username: req.body && req.body.username, traceId: req.traceId });
      return res.status(400).json({ error: 'Unable to complete request' }); // generic message
    }

    logger.error('Error in /auth/register', { error: err && err.message ? err.message : err, traceId: req.traceId, stack: err && err.stack });
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/auth/login', async (req, res) => {
  try {
    logger.info('Login attempt', { username: req.body.username });
    const { username, password } = req.body;
    const result = await pool.query(
      'SELECT * FROM auth.users WHERE username=$1',
      [username]
    );

    const user = result.rows[0];
    if (!user) {
      logger.warn('Login failed: user not found', { username });
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      logger.warn('Login failed: invalid password', { username });
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { sub: user.id, username: user.username },
      JWT_SECRET,
      { expiresIn: '1h' }
    );
    logger.info('Login successful', { user_id: user.id });

    res.json({ access_token: token, token_type: 'Bearer', expires_in: 3600 });
  } catch (err) {
    logger.error('Error in /auth/login', { error: err });
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.listen(PORT, () => logger.info(`Auth Service running on port ${PORT}`));
