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
  const friends = await db
    .collection('friends')
    .findOne({ user_id: req.params.userId });
  res.json(friends || { friends: [] });
});

app.listen(3002, () => console.log('Friend Service running on port 3002'));
