const PORT = process.env.PORT || 3001;
const express = require('express');
const { Pool } = require('pg');
const amqp = require('amqplib');
const jwt = require('jsonwebtoken');

const logger = require('./logger');

const app = express();
app.use(express.json());

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET;

let channel;

function authenticate(req, res, next) {
  const header = req.headers['authorization'];

  if (!header || !header.startsWith('Bearer ')) {
    logger.warn('Unauthorized access attempt - missing or invalid header');
    return res
      .status(401)
      .json({ error: 'Missing or invalid Authorization header' });
  }

  const access_token = header.split(' ')[1];

  try {
    const payload = jwt.verify(access_token, JWT_SECRET);
    req.user = payload;
    logger.info('JWT validated', { user_id: payload.sub });
    next();
  } catch (err) {
    logger.warn('JWT validation failed', { reason: err.message });
    return res.status(403).json({ error: 'Invalid or expired token' });
  }
}

async function initRabbit(retries = 10, delay = 3000) {
  for (let i = 0; i < retries; i++) {
    try {
      const conn = await amqp.connect(process.env.RABBITMQ_URL);
      channel = await conn.createChannel();
      await channel.assertQueue('UserRegistered');

      // Consume UserRegistered events (Sent from auth-service)
      channel.consume('UserRegistered', async (msg) => {
        try {
          const { user_id, username } = JSON.parse(msg.content.toString());

          logger.info('Received UserRegistered event', { user_id, username });

          await pool.query(
            `INSERT INTO user_profiles.users (id, username)
             VALUES ($1, $2)
             ON CONFLICT (id) DO NOTHING`,
            [user_id, username]
          );

          channel.ack(msg);
          logger.info('UserRegistered event processed', { user_id });
        } catch (err) {
          logger.error('Error processing UserRegistered event', {
            error: err.message,
          });
          // Do not ack message if failed, so it can be retried
        }
      });

      logger.info('Connected to RabbitMQ and consuming UserRegistered queue');
      return;
    } catch (err) {
      logger.warn('RabbitMQ connection failed, retrying...', {
        attempt: i + 1,
        error: err.message,
      });
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  logger.error('Could not connect to RabbitMQ after multiple attempts');
  throw new Error('RabbitMQ connection failed');
}

initRabbit().catch((err) => logger.error('Rabbit init error', { error: err }));

app.get('/users/:id/public-key', authenticate, async (req, res) => {
  const { id } = req.params;

  logger.info('Public key request', {
    requester_id: req.user.sub,
    target_user: id,
  });

  try {
    const result = await pool.query(
      'SELECT public_key FROM user_profiles.users WHERE id=$1',
      [id]
    );

    if (!result.rows[0]) {
      logger.warn('Public key request failed - user not found', {
        user_id: id,
      });
      return res.status(404).json({ error: 'User not found' });
    }

    logger.info('Public key request successful', { user_id: id });
    res.json({ public_key: result.rows[0].public_key });
  } catch (err) {
    logger.error('Database error fetching public key', { error: err.message });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.listen(PORT, () => logger.info(`User Service running on port ${PORT}`));
