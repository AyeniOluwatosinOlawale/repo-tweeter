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
]);

const SKIP_FILENAMES = new Set([
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
  '.gitattributes', '.editorconfig',
]);

function isTextFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const base = path.basename(filePath);
  return !SKIP_EXTENSIONS.has(ext) && !SKIP_FILENAMES.has(base);
}

// Sort files so the repo reads like a story:
// README first → config/setup files → source folders in depth order
function sortFiles(files) {
  const priority = (f) => {
    const base = path.basename(f).toLowerCase();
    const dir = path.dirname(f);

    if (base === 'readme.md' && dir === '.') return 0;
    if (base === 'readme.md') return 1;
    if (['pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt',
         'package.json', 'dockerfile', 'docker-compose.yml',
         '.gitignore', 'makefile'].includes(base)) return 2;
    if (base.includes('config')) return 3;
    if (f.includes('/data/') || f.includes('/datasets/')) return 4;
    if (f.includes('/models/') || f.includes('/model/')) return 5;
    if (f.includes('/train') || f.includes('/training/')) return 6;
    if (f.includes('/utils/') || f.includes('/helpers/')) return 7;
    if (f.includes('/scripts/')) return 8;
    if (f.includes('/notebooks/') || f.includes('.ipynb')) return 9;
    return 10;
  };

  return [...files].sort((a, b) => {
    const pa = priority(a);
    const pb = priority(b);
    if (pa !== pb) return pa - pb;
    return a.localeCompare(b);
  });
}

async function fetchRepoInfo(repo) {
  const res = await fetch(`https://api.github.com/repos/${repo}`);
  if (!res.ok) return null;
  const data = await res.json();
  return {
    name: data.full_name,
    description: data.description || '',
    language: data.language || '',
  };
}

async function fetchAllFiles(repo) {
  const res = await fetch(`https://api.github.com/repos/${repo}/git/trees/HEAD?recursive=1`);
  if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
  const data = await res.json();
  const files = data.tree
    .filter(item => item.type === 'blob')
    .map(item => item.path)
    .filter(isTextFile);
  return sortFiles(files);
}

async function fetchFileContent(repo, filePath) {
  const url = `https://raw.githubusercontent.com/${repo}/HEAD/${filePath}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch file: ${res.status}`);
  const text = await res.text();
  return text.slice(0, 3000);
}

async function generateTweet({ filePath, content, index, total, recentTweets, repoInfo }) {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const isFirst = index === 0;
  const isLast = index === total - 1;
  const progress = `(${index + 1}/${total})`;

  const recentContext = recentTweets.length > 0
    ? `\n\nPrevious tweets in this series:\n${recentTweets.map((t, i) => `${i + 1}. "${t}"`).join('\n')}`
    : '';

  const systemPrompt = `You are a developer walking your Twitter followers through a GitHub repository called "${repoInfo.name}", file by file, in a way that builds understanding progressively.

The repo: ${repoInfo.description || 'a developer project'} (primary language: ${repoInfo.language || 'unknown'}).

You are writing tweet ${index + 1} of ${total} in an ongoing series. Each tweet must:
- Flow naturally from the previous ones — readers are following along
- Explain what THIS file does and why it matters in the context of the whole project
- Sound like a curious, knowledgeable developer sharing a journey, not a bot summarising
- Be specific — mention actual function names, class names, or design choices from the file
- Never repeat what was already said in previous tweets
- Max 240 characters
- No hashtags
- No emojis unless they feel very natural
${isFirst ? '- This is the FIRST tweet — introduce the repo and what readers will learn following along' : ''}
${isLast ? '- This is the LAST tweet — wrap up the journey, give a final reflection on the whole codebase' : ''}`;

  const userPrompt = `File ${progress}: ${filePath}${recentContext}\n\nFile content:\n${content}`;

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    max_tokens: 150,
    temperature: 0.85,
  });

  return completion.choices[0].message.content.trim();
}

async function sendEmail(filePath, tweet, index, total) {
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
    subject: `[${index + 1}/${total}] Tweet draft: ${filePath}`,
    text: [
      `--- TWEET DRAFT (${index + 1} of ${total}) ---`,
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

  let state = { index: 0, files: [], recentTweets: [], repoInfo: null };
  if (fs.existsSync(STATE_FILE)) {
    state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  }

  // Refresh file list on first run or after completing the repo
  if (!state.files.length || state.index >= state.files.length) {
    console.log('Fetching repo info and file list...');
    state.repoInfo = await fetchRepoInfo(TARGET_REPO);
    state.files = await fetchAllFiles(TARGET_REPO);
    state.index = 0;
    state.recentTweets = [];
    console.log(`Found ${state.files.length} files.`);
    console.log('File order:', state.files.join('\n  '));
  }

  if (!state.repoInfo) {
    state.repoInfo = await fetchRepoInfo(TARGET_REPO);
  }

  const filePath = state.files[state.index];
  const total = state.files.length;
  console.log(`\nProcessing [${state.index + 1}/${total}]: ${filePath}`);

  const content = await fetchFileContent(TARGET_REPO, filePath);
  const tweet = await generateTweet({
    filePath,
    content,
    index: state.index,
    total,
    recentTweets: (state.recentTweets || []).slice(-3),
    repoInfo: state.repoInfo,
  });

  console.log(`\nTweet (${tweet.length} chars):\n${tweet}\n`);

  await sendEmail(filePath, tweet, state.index, total);
  console.log(`Email sent to ${TO_EMAIL}`);

  // Keep last 3 tweets for context
  state.recentTweets = [...(state.recentTweets || []), tweet].slice(-3);
  state.index += 1;

  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  const next = state.files[state.index];
  console.log(`State saved. Next: ${next ?? '(series complete — will restart)'}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
