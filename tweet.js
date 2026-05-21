const fs = require('fs');
const path = require('path');
const { OpenAI } = require('openai');
const nodemailer = require('nodemailer');

const TARGET_REPO = process.env.TARGET_REPO;
const TO_EMAIL = process.env.TO_EMAIL;
const STATE_FILE = path.join(__dirname, 'state.json');

const SKIP_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico',
  '.woff', '.woff2', '.ttf', '.eot',
  '.mp3', '.mp4', '.wav', '.ogg',
  '.pdf', '.zip', '.tar', '.gz', '.7z',
  '.exe', '.bin', '.dll', '.so', '.dylib',
  '.lock', '.DS_Store',
]);

const SKIP_FILENAMES = new Set([
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
  '.gitignore', '.gitattributes', '.editorconfig',
]);

function isTextFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const base = path.basename(filePath);
  return !SKIP_EXTENSIONS.has(ext) && !SKIP_FILENAMES.has(base);
}

async function fetchAllFiles(repo) {
  const res = await fetch(`https://api.github.com/repos/${repo}/git/trees/HEAD?recursive=1`);
  if (!res.ok) throw new Error(`GitHub API error: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.tree
    .filter(item => item.type === 'blob')
    .map(item => item.path)
    .filter(isTextFile);
}

async function fetchFileContent(repo, filePath) {
  const url = `https://raw.githubusercontent.com/${repo}/HEAD/${filePath}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch file: ${res.status}`);
  const text = await res.text();
  return text.slice(0, 3000);
}

async function generateTweet(filePath, content) {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'system',
        content:
          'You write engaging, insightful tweets about source code files for a developer audience. ' +
          'Be specific about what the code actually does — mention function names, patterns, or techniques when interesting. ' +
          'Write in a conversational tone. Max 240 characters. No hashtags.',
      },
      {
        role: 'user',
        content: `File: ${filePath}\n\n${content}`,
      },
    ],
    max_tokens: 120,
  });
  return completion.choices[0].message.content.trim();
}

async function sendEmail(filePath, tweet) {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: TO_EMAIL,
      pass: process.env.GMAIL_APP_PASSWORD,
    },
  });

  const fileUrl = `https://github.com/${TARGET_REPO}/blob/HEAD/${filePath}`;

  await transporter.sendMail({
    from: TO_EMAIL,
    to: TO_EMAIL,
    subject: `Tweet draft: ${filePath}`,
    text: [
      '--- TWEET DRAFT ---',
      '',
      tweet,
      '',
      `Characters: ${tweet.length}/240`,
      '',
      '--- FILE ---',
      fileUrl,
    ].join('\n'),
  });
}

async function main() {
  if (!TARGET_REPO) throw new Error('TARGET_REPO env var is required');
  if (!TO_EMAIL) throw new Error('TO_EMAIL env var is required');

  let state = { index: 0, files: [] };
  if (fs.existsSync(STATE_FILE)) {
    state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  }

  if (!state.files.length || state.index >= state.files.length) {
    console.log('Fetching file list from GitHub...');
    state.files = await fetchAllFiles(TARGET_REPO);
    state.index = 0;
    console.log(`Found ${state.files.length} text files.`);
  }

  const filePath = state.files[state.index];
  console.log(`Processing file ${state.index + 1}/${state.files.length}: ${filePath}`);

  const content = await fetchFileContent(TARGET_REPO, filePath);
  const tweet = await generateTweet(filePath, content);

  console.log(`\nTweet (${tweet.length} chars):\n${tweet}\n`);

  await sendEmail(filePath, tweet);
  console.log(`Email sent to ${TO_EMAIL}`);

  state.index += 1;
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  console.log(`State saved. Next file: ${state.files[state.index] ?? '(will loop)'}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
