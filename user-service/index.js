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

async function initRabbit() {
  while (true) {
    try {
      logger.info('Attempting to connect to RabbitMQ...');

      const conn = await amqp.connect(process.env.RABBITMQ_URL);

      conn.on('error', (err) => {
        logger.error('RabbitMQ connection error', { error: err.message });
      });

      conn.on('close', () => {
        logger.warn('RabbitMQ connection closed. Reconnecting in 2s...');
        setTimeout(initRabbit, 2000);
      });

      channel = await conn.createChannel();
      await channel.assertQueue('UserRegistered');

      logger.info('RabbitMQ connected. Setting up consumer...');

      channel.consume('UserRegistered', async (msg) => {
        if (!msg) return;

        try {
          const { user_id, username, traceId } = JSON.parse(
            msg.content.toString()
          );

          logger.info('Received UserRegistered event', {
            user_id,
            username,
            traceId,
          });

          await pool.query(
            `INSERT INTO user_profiles.users (id, username)
             VALUES ($1, $2)
             ON CONFLICT (id) DO NOTHING`,
            [user_id, username]
          );

          channel.ack(msg);
          logger.info('UserRegistered event processed', { user_id, traceId });
        } catch (err) {
          logger.error('Failed to process UserRegistered', {
            error: err.message,
            traceId: traceId,
          });
          // Do not ack → message will retry automatically
        }
      });

      logger.info('UserRegistered consumer is active');

      return; // Successful connection → exit loop
    } catch (err) {
      logger.warn('RabbitMQ connection failed, retrying...', {
        error: err.message,
      });

      // Delay then try again — forever
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
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
