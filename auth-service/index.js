const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const amqp = require('amqplib');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json());

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET;

let channel;

// Retry logic for RabbitMQ
async function initRabbit(retries = 10, delay = 3000) {
  for (let i = 0; i < retries; i++) {
    try {
      const conn = await amqp.connect(process.env.RABBITMQ_URL);
      channel = await conn.createChannel();
      await channel.assertQueue('UserRegistered');
      console.log('Connected to RabbitMQ');
      return;
    } catch {
      console.log(
        `RabbitMQ connection failed, retrying in ${delay / 1000}s... (${i + 1}/${retries})`
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error('Could not connect to RabbitMQ after multiple attempts');
}

initRabbit().catch(console.error);

app.post('/auth/register', async (req, res) => {
  const { username, password } = req.body;
  const hashed = await bcrypt.hash(password, 10);
  const id = uuidv4();

  await pool.query(
    'INSERT INTO auth.users (id, username, password_hash) VALUES ($1, $2, $3)',
    [id, username, hashed]
  );

  if (channel) {
    channel.sendToQueue(
      'UserRegistered',
      Buffer.from(JSON.stringify({ user_id: id, username }))
    );
  } else {
    console.log('RabbitMQ channel not ready, skipping message publish');
  }

  res.json({ message: 'User created', user_id: id });
});

app.post('/auth/login', async (req, res) => {
  const { username, password } = req.body;
  const result = await pool.query(
    'SELECT * FROM auth.users WHERE username=$1',
    [username]
  );
  const user = result.rows[0];
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

  const token = jwt.sign(
    { sub: user.id, username: user.username },
    JWT_SECRET,
    { expiresIn: '1h' }
  );
  res.json({ access_token: token, token_type: 'Bearer', expires_in: 3600 });
});

app.listen(3000, () => console.log('Auth Service running on port 3000'));
