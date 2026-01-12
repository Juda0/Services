const PORT = process.env.PORT || 3000;
const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const amqp = require('amqplib');
const { v4: uuidv4 } = require('uuid');
const logger = require('./logger');
const fs = require('fs');
const { BloomFilter } = require('bloom-filters');

const MIN_PASSWORD_LENGTH = 15;
const MAX_PASSWORD_LENGTH = 64;

let bf;

// Initialize blacklist Bloom Filter
function initBlacklist() {
  const data = fs.readFileSync('./blacklist.txt', 'utf-8');
  const passwords = data
    .split('\n')
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);

  bf = BloomFilter.create(passwords.length, 0.01);
  passwords.forEach((p) => bf.add(p));
  logger.info(
    `Loaded blacklist with ${passwords.length} entries into Bloom Filter`
  );
}

// Check if password is breached or blacklisted
function breachedOrBlacklisted(password) {
  return bf && bf.has(password.toLowerCase());
}

initBlacklist();

const app = express();
app.use(express.json());

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET =
  process.env.JWT_SECRET ||
  (() => {
    throw new Error('Missing required environment variable: JWT_SECRET');
  })();

let channel;

// Middleware: add trace ID to each request
app.use((req, res, next) => {
  req.traceId = uuidv4();
  next();
});

// Initialize RabbitMQ connection
async function initRabbit() {
  while (true) {
    try {
      const rabbitUrl = `amqp://${process.env.RABBITMQ_USER}:${process.env.RABBITMQ_PASSWORD}@${process.env.RABBITMQ_HOST}:${process.env.RABBITMQ_PORT}`;
      const conn = await amqp.connect(rabbitUrl);

      conn.on('error', () => setTimeout(initRabbit, 2000));
      conn.on('close', () => setTimeout(initRabbit, 2000));

      channel = await conn.createConfirmChannel();
      await channel.assertQueue('UserRegistered', { durable: true });
      logger.info(`Connected to RabbitMQ at ${rabbitUrl}`);
      return;
    } catch (err) {
      logger.warn(`RabbitMQ connection to url: ${rabbitUrl} failed. Retrying in 3s...`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}


initRabbit().catch((err) => logger.error(err));

// ---------------- Register Route ----------------
app.post('/auth/register', async (req, res) => {
  const traceId = req.traceId;
  const username = req.body.username?.toLowerCase();
  const password = req.body.password;

  logger.info('Register attempt', { traceId });

  const inputValidationErrors = {};

  // Username validation
  if (!username || !/^[a-zA-Z0-9]{4,30}$/.test(username)) {
    inputValidationErrors.username =
      'Username must be 4-30 alphanumeric characters';
  }

  // Password validation
  if (!password) {
    inputValidationErrors.password = 'Password is required';
  } else {
    if (
      password.length < MIN_PASSWORD_LENGTH ||
      password.length > MAX_PASSWORD_LENGTH
    ) {
      inputValidationErrors.password = `Password must be between ${MIN_PASSWORD_LENGTH} and ${MAX_PASSWORD_LENGTH} characters`;
    } else if (breachedOrBlacklisted(password)) {
      inputValidationErrors.password =
        'This password is not allowed due to known compromise';
    }
  }

  if (Object.keys(inputValidationErrors).length > 0) {
    logger.warn('Register failed: invalid input', {
      traceId,
      errors: inputValidationErrors,
    });
    return res
      .status(400)
      .json({ error: 'Invalid input', details: inputValidationErrors });
  }

  try {
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
          Buffer.from(JSON.stringify({ user_id: id, username, traceId })),
          { persistent: true },
          (err, ok) => {
            if (err) {
              logger.error('RabbitMQ message NOT acknowledged', {
                error: err.message || err,
                traceId,
              });
            } else {
              logger.info('RabbitMQ message acknowledged', { traceId });
            }
          }
        );
      } catch (pubErr) {
        logger.error('Failed to publish UserRegistered', {
          error: pubErr.message || pubErr,
          traceId,
        });
      }
    } else {
      logger.warn('RabbitMQ channel not ready, skipping message publish', {
        traceId,
      });
    }

    res.json({ message: 'User created', user_id: id });
  } catch (err) {
    if (err.code === '23505') {
      // PostgreSQL unique violation
      logger.warn('Register failed: unique violation', { username, traceId });
      return res.status(400).json({ error: 'Unable to complete request' });
    }

    logger.error('Error in /auth/register', {
      error: err.message || err,
      traceId,
      stack: err.stack,
    });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------- Login Route ----------------
app.post('/auth/login', async (req, res) => {
  const traceId = req.traceId;
  const username = req.body.username?.toLowerCase();
  const password = req.body.password;

  logger.info('Login attempt', { traceId });

  try {
    const result = await pool.query(
      'SELECT * FROM auth.users WHERE username=$1',
      [username]
    );
    const user = result.rows[0];

    if (!user) {
      logger.warn('Login failed: user not found', { traceId });
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      logger.warn('Login failed: invalid password', { traceId });
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { sub: user.id, username: user.username },
      JWT_SECRET,
      { expiresIn: '1h' }
    );

    logger.info('Login successful', { traceId });
    return res.json({
      access_token: token,
      token_type: 'Bearer',
      expires_in: 3600,
    });
  } catch (err) {
    logger.error('Error in /auth/login', {
      error: err.message || err,
      traceId,
      stack: err.stack,
    });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.listen(PORT, () => logger.info(`Auth Service running on port ${PORT}`));
