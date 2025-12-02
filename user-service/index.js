const express = require('express');
const { Pool } = require('pg');
const amqp = require('amqplib');

const app = express();
app.use(express.json());

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

let channel;

// Retry logic for RabbitMQ
async function initRabbit(retries = 10, delay = 3000) {
  for (let i = 0; i < retries; i++) {
    try {
      const conn = await amqp.connect(process.env.RABBITMQ_URL);
      channel = await conn.createChannel();
      await channel.assertQueue('UserRegistered');

      // Consume messages
      channel.consume('UserRegistered', async (msg) => {
        const { user_id, username } = JSON.parse(msg.content.toString());
        await pool.query(
          'INSERT INTO user_profiles.users (id, username) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING',
          [user_id, username]
        );
        channel.ack(msg);
      });

      console.log('Connected to RabbitMQ and consuming UserRegistered queue');
      return;
    } catch (err) {
      console.log(`RabbitMQ connection failed, retrying in ${delay / 1000}s... (${i + 1}/${retries})`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw new Error('Could not connect to RabbitMQ after multiple attempts');
}

initRabbit().catch(console.error);

app.get('/users/:id/public-key', async (req, res) => {
  const { id } = req.params;
  const result = await pool.query('SELECT public_key FROM user_profiles.users WHERE id=$1', [id]);
  if (!result.rows[0]) return res.status(404).json({ error: 'User not found' });
  res.json({ public_key: result.rows[0].public_key });
});

app.listen(3001, () => console.log('User Service running on port 3001'));
