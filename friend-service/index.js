const PORT = process.env.PORT || 3002;
const express = require('express');
const { MongoClient } = require('mongodb');
const logger = require('./logger');

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
  const friends = await db
    .collection('friends')
    .findOne({ user_id: req.params.userId });
  res.json(friends || { friends: [] });
});

app.listen(PORT, () => logger.info(`Friend Service running on port ${PORT}`));
