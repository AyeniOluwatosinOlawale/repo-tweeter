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
  if (!res.ok) return { name: repo, description: '', language: '' };
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
  return sortFiles(
    data.tree
      .filter(item => item.type === 'blob')
      .map(item => item.path)
      .filter(isTextFile)
  );
}

async function fetchFileContent(repo, filePath) {
  const url = `https://raw.githubusercontent.com/${repo}/HEAD/${filePath}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch file: ${res.status}`);
  return (await res.text()).slice(0, 4000);
}

// Generate a batch of tweets that fully explore one file from multiple angles
async function generateTweetsForFile({ filePath, content, fileIndex, totalFiles, recentTweets, repoInfo }) {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const isFirstFile = fileIndex === 0;
  const isLastFile = fileIndex === totalFiles - 1;

  const recentContext = recentTweets.length > 0
    ? `\nRecent tweets already posted:\n${recentTweets.map((t, i) => `${i + 1}. "${t}"`).join('\n')}`
    : '';

  const systemPrompt = `You are a developer writing a Twitter series that walks followers through a GitHub repository called "${repoInfo.name}" — file by file, building a complete understanding of the project.

The repo: ${repoInfo.description || 'a developer project'} (language: ${repoInfo.language || 'unknown'}).
This is file ${fileIndex + 1} of ${totalFiles} in the series.
${recentContext}

Your job: write exactly 20 tweets that FULLY explore this one file before we move on.
Each tweet must cover a DIFFERENT angle. Use this structure as a guide (adapt freely):
  1. What this file is and its role in the project
  2. The core class or function — what it does and how
  3. A specific implementation detail, algorithm, or pattern worth highlighting
  4. A deeper look at the logic — how data flows or transforms inside this file
  5. Something interesting, surprising, or clever in the code
  6. An edge case, guard clause, or error handling choice the author made
  7. How this file connects to or depends on other parts of the project
  8. A design trade-off or architectural decision visible in this code
  9. A lesson or insight a developer could learn from studying this file
  10. The naming conventions or code style choices and what they signal
  11. Any constants, hyperparameters, or magic numbers and why they matter
  12. What would break if this file were removed or changed
  13. The simplest thing this file does — and why that simplicity is intentional
  14. The most complex thing this file does — broken down simply
  15. How a beginner should read and understand this file
  16. What a senior dev would notice or appreciate about this file
  17. A question this file raises — something left to the reader to think about
  18. How this file might evolve as the project grows
  19. One thing the author could have done differently — and the trade-off
  20. A wrap-up of this file + teaser for what's coming next in the series

Rules:
- Each tweet max 240 characters
- Sound like a real developer narrating a journey — curious, specific, human
- No hashtags. No emojis unless very natural.
- Do NOT repeat points across tweets
- Each tweet must stand alone and make sense on its own
- Reference actual function names, class names, variable names from the code
${isFirstFile ? '- The FIRST tweet of the whole series: introduce the repo and invite followers to follow along' : ''}
${isLastFile ? '- This is the LAST file: the final tweets should reflect on the whole repo journey' : ''}

Return ONLY a valid JSON array of strings, no explanation, no markdown. Example:
["tweet one text here", "tweet two text here", "tweet three text here"]`;

  const userPrompt = `File: ${filePath}\n\nContent:\n${content}`;

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    max_tokens: 4000,
    temperature: 0.85,
    response_format: { type: 'json_object' },
  });

  let raw = completion.choices[0].message.content.trim();

  // GPT sometimes wraps the array in an object like {"tweets": [...]}
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    // find the first array value in the object
    const arr = Object.values(parsed).find(v => Array.isArray(v));
    if (arr) return arr;
  } catch (_) {}

  throw new Error(`Could not parse tweet batch: ${raw}`);
}

async function sendEmail(filePath, tweet, tweetNum, totalTweetsInFile, fileIndex, totalFiles) {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: TO_EMAIL, pass: process.env.GMAIL_APP_PASSWORD },
  });

  const fileUrl = `https://github.com/${TARGET_REPO}/blob/HEAD/${filePath}`;

  await transporter.sendMail({
    from: TO_EMAIL,
    to: TO_EMAIL,
    subject: `[File ${fileIndex + 1}/${totalFiles} · Tweet ${tweetNum}/${totalTweetsInFile}] ${path.basename(filePath)}`,
    text: [
      `--- TWEET DRAFT ---`,
      `File ${fileIndex + 1}/${totalFiles}: ${filePath}`,
      `Tweet ${tweetNum} of ${totalTweetsInFile} for this file`,
      '',
      tweet,
      '',
      `Characters: ${tweet.length}/240`,
      '',
      '--- FILE LINK ---',
      fileUrl,
    ].join('\n'),
  });
}

async function main() {
  if (!TARGET_REPO) throw new Error('TARGET_REPO env var is required');
  if (!TO_EMAIL) throw new Error('TO_EMAIL env var is required');

  let state = {
    fileIndex: 0,
    files: [],
    pendingTweets: [],   // tweets queued for current file, not yet sent
    sentTweetsInFile: 0, // how many tweets sent for current file
    recentTweets: [],    // last 3 sent tweets across all files
    repoInfo: null,
  };

  if (fs.existsSync(STATE_FILE)) {
    const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    // migrate old state shape if needed
    state = {
      fileIndex: saved.fileIndex ?? saved.index ?? 0,
      files: saved.files || [],
      pendingTweets: saved.pendingTweets || [],
      sentTweetsInFile: saved.sentTweetsInFile || 0,
      recentTweets: saved.recentTweets || [],
      repoInfo: saved.repoInfo || null,
    };
  }

  // Bootstrap: fetch files if empty or all done
  if (!state.files.length || state.fileIndex >= state.files.length) {
    console.log('Fetching repo info and file list...');
    state.repoInfo = await fetchRepoInfo(TARGET_REPO);
    state.files = await fetchAllFiles(TARGET_REPO);
    state.fileIndex = 0;
    state.pendingTweets = [];
    state.sentTweetsInFile = 0;
    state.recentTweets = [];
    console.log(`Found ${state.files.length} files:`);
    state.files.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
  }

  if (!state.repoInfo) {
    state.repoInfo = await fetchRepoInfo(TARGET_REPO);
  }

  const filePath = state.files[state.fileIndex];
  const totalFiles = state.files.length;

  // Generate tweet batch for this file if the queue is empty
  if (!state.pendingTweets.length) {
    console.log(`\nGenerating tweet batch for: ${filePath}`);
    const content = await fetchFileContent(TARGET_REPO, filePath);
    const tweets = await generateTweetsForFile({
      filePath,
      content,
      fileIndex: state.fileIndex,
      totalFiles,
      recentTweets: state.recentTweets.slice(-3),
      repoInfo: state.repoInfo,
    });
    state.pendingTweets = tweets;
    state.sentTweetsInFile = 0;
    console.log(`Generated ${tweets.length} tweets for this file.`);
  }

  // Send the next queued tweet
  const tweet = state.pendingTweets.shift();
  state.sentTweetsInFile += 1;
  const tweetNum = state.sentTweetsInFile;
  const totalTweetsInFile = state.sentTweetsInFile + state.pendingTweets.length;

  console.log(`\nSending tweet ${tweetNum}/${totalTweetsInFile} for ${filePath}:`);
  console.log(`"${tweet}" (${tweet.length} chars)`);

  await sendEmail(filePath, tweet, tweetNum, totalTweetsInFile, state.fileIndex, totalFiles);
  console.log(`Email sent to ${TO_EMAIL}`);

  // Track recent tweets for continuity
  state.recentTweets = [...state.recentTweets, tweet].slice(-3);

  // Move to next file when this one is exhausted
  if (state.pendingTweets.length === 0) {
    console.log(`\nFile exhausted. Moving to next file.`);
    state.fileIndex += 1;
    state.sentTweetsInFile = 0;
  }

  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

  const nextFile = state.files[state.fileIndex];
  if (nextFile && state.pendingTweets.length === 0) {
    console.log(`Next run will start on: ${nextFile}`);
  } else if (state.pendingTweets.length > 0) {
    console.log(`${state.pendingTweets.length} more tweets queued for ${filePath}`);
  } else {
    console.log('All files complete — will restart from beginning next run.');
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
