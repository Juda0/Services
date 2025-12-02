#!/bin/bash

set -e

echo "Creating microservice project structure..."
mkdir -p microservice-app/{auth-service,user-service,friend-service}

# -----------------------------
# Auth Service
# -----------------------------
echo "Setting up Auth Service..."
cd microservice-app/auth-service
npm init -y
npm install express bcrypt jsonwebtoken pg amqplib uuid
cat > index.js << 'EOF'
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
async function initRabbit() {
  const conn = await amqp.connect(process.env.RABBITMQ_URL);
  channel = await conn.createChannel();
  await channel.assertQueue('UserRegistered');
}
initRabbit();

app.post('/auth/register', async (req, res) => {
  const { username, password } = req.body;
  const hashed = await bcrypt.hash(password, 10);
  const id = uuidv4();

  await pool.query(
    'INSERT INTO auth.users (id, username, password_hash) VALUES ($1, $2, $3)',
    [id, username, hashed]
  );

  channel.sendToQueue('UserRegistered', Buffer.from(JSON.stringify({ user_id: id, username })));

  res.json({ message: 'User created', user_id: id });
});

app.post('/auth/login', async (req, res) => {
  const { username, password } = req.body;
  const result = await pool.query('SELECT * FROM auth.users WHERE username=$1', [username]);
  const user = result.rows[0];
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

  const token = jwt.sign({ sub: user.id, username: user.username }, JWT_SECRET, { expiresIn: '1h' });
  res.json({ access_token: token, token_type: 'Bearer', expires_in: 3600 });
});

app.listen(3000, () => console.log('Auth Service running on port 3000'));
EOF
cd ../..

# -----------------------------
# User Service
# -----------------------------
echo "Setting up User Service..."
cd microservice-app/user-service
npm init -y
npm install express pg amqplib
cat > index.js << 'EOF'
const express = require('express');
const { Pool } = require('pg');
const amqp = require('amqplib');

const app = express();
app.use(express.json());

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

let channel;
async function initRabbit() {
  const conn = await amqp.connect(process.env.RABBITMQ_URL);
  channel = await conn.createChannel();
  await channel.assertQueue('UserRegistered');

  channel.consume('UserRegistered', async (msg) => {
    const { user_id, username } = JSON.parse(msg.content.toString());
    await pool.query(
      'INSERT INTO user_profiles.users (id, username) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING',
      [user_id, username]
    );
    channel.ack(msg);
  });
}
initRabbit();

app.get('/users/:id/public-key', async (req, res) => {
  const { id } = req.params;
  const result = await pool.query('SELECT public_key FROM user_profiles.users WHERE id=$1', [id]);
  if (!result.rows[0]) return res.status(404).json({ error: 'User not found' });
  res.json({ public_key: result.rows[0].public_key });
});

app.listen(3001, () => console.log('User Service running on port 3001'));
EOF
cd ../..

# -----------------------------
# Friend Service
# -----------------------------
echo "Setting up Friend Service..."
cd microservice-app/friend-service
npm init -y
npm install express mongodb
cat > index.js << 'EOF'
const express = require('express');
const { MongoClient } = require('mongodb');

const app = express();
app.use(express.json());

const client = new MongoClient(process.env.MONGO_URL);
let db;

async function init() {
  await client.connect();
  db = client.db('microservices');
}
init();

app.get('/friends/:userId', async (req, res) => {
  const friends = await db.collection('friends').findOne({ user_id: req.params.userId });
  res.json(friends || { friends: [] });
});

app.listen(3002, () => console.log('Friend Service running on port 3002'));
EOF
cd ../..

echo "Microservice structure created successfully!"
echo "Run 'docker-compose up --build' in the project root to start all services."
