require('dotenv').config({ override: true });
const { TwitterApi } = require('twitter-api-v2');
const path = require('path');

const client = new TwitterApi({
  appKey: process.env.X_CONSUMER_KEY,
  appSecret: process.env.X_CONSUMER_SECRET,
  accessToken: process.env.X_ACCESS_TOKEN,
  accessSecret: process.env.X_ACCESS_TOKEN_SECRET,
});

const TWEET_TEXT = `Every day something insane happens on #Twitch.
Most people miss it.
I put the best moments of Twitch in one place. Daily.
Follow so you don't miss it!`;

const REPLY_TEXT = `Subscribe to watch new episodes every day 📺 https://www.youtube.com/@MyDailyDoseOfStream`;

const LOGO_PATH = path.resolve(__dirname, '../assets/ddos_full_logo.png');

async function run() {
  console.log('Uploading media...');
  const mediaId = await client.v1.uploadMedia(LOGO_PATH, { mimeType: 'image/png' });
  console.log('Media uploaded:', mediaId);

  console.log('Posting tweet...');
  const tweet = await client.v2.tweet({
    text: TWEET_TEXT,
    media: { media_ids: [mediaId] },
  });
  console.log('Tweet posted:', tweet.data.id);

  console.log('Posting reply with YouTube link...');
  const reply = await client.v2.reply(REPLY_TEXT, tweet.data.id);
  console.log('Reply posted:', reply.data.id);

  console.log('\nDone!');
  console.log(`Tweet URL: https://x.com/i/web/status/${tweet.data.id}`);
}

run().catch(err => {
  console.error('Error:', err?.data ?? err);
  process.exit(1);
});
