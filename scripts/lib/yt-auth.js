'use strict';
// yt-auth.js — OAuth2 для youtube-upload.js.

const fs = require('fs');
const readline = require('readline');
const { OAuth2Client } = require('google-auth-library');

const SECRET_PATH = process.env.YOUTUBE_CLIENT_SECRET_PATH || 'auth/client_secret.json';
const TOKEN_PATH  = 'auth/token.json';
const SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube',
];

async function getAuth() {
  if (!fs.existsSync(SECRET_PATH)) {
    throw new Error(`client_secret.json not found at ${SECRET_PATH}. Download from Google Cloud Console.`);
  }
  const creds = JSON.parse(fs.readFileSync(SECRET_PATH, 'utf8'));
  const { client_id, client_secret, redirect_uris } = creds.installed || creds.web;
  const oauth2 = new OAuth2Client(client_id, client_secret, redirect_uris[0]);

  if (fs.existsSync(TOKEN_PATH)) {
    const saved = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
    oauth2.setCredentials(saved);
    try {
      const { credentials } = await oauth2.refreshAccessToken();
      oauth2.setCredentials(credentials);
      fs.writeFileSync(TOKEN_PATH, JSON.stringify(credentials), 'utf8');
      return oauth2;
    } catch {
      console.log('Refresh token expired, re-authorizing...');
      fs.unlinkSync(TOKEN_PATH);
    }
  }

  const url = oauth2.generateAuthUrl({ access_type: 'offline', scope: SCOPES });
  console.log('\n=== YouTube Authorization ===');
  console.log('Open in browser:\n' + url);
  console.log('\nPaste the authorization code:');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const code = await new Promise(r => rl.question('> ', a => { rl.close(); r(a.trim()); }));
  const { tokens } = await oauth2.getToken(code);
  oauth2.setCredentials(tokens);
  fs.mkdirSync('auth', { recursive: true });
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens), 'utf8');
  console.log('Token saved to auth/token.json');
  return oauth2;
}

module.exports = { getAuth, SCOPES };
