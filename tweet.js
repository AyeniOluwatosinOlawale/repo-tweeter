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
  const raw = await res.text();

  // For Jupyter notebooks, extract readable cell source instead of raw JSON
  if (filePath.endsWith('.ipynb')) {
    try {
      const nb = JSON.parse(raw);
      const cells = nb.cells || [];
      const text = cells.map(cell => {
        const kind = cell.cell_type === 'code' ? '# [CODE CELL]' : '# [MARKDOWN CELL]';
        const source = Array.isArray(cell.source) ? cell.source.join('') : cell.source;
        return `${kind}\n${source}`;
      }).join('\n\n');
      return text.slice(0, 12000);
    } catch (_) {}
  }

  // Return up to 20,000 chars — covers virtually all real code files fully
  return raw.slice(0, 20000);
}

// Generate a batch of tweets that fully explore one file from multiple angles
async function generateTweetsForFile({ filePath, content, fileIndex, totalFiles, recentTweets, repoInfo }) {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const isFirstFile = fileIndex === 0;
  const isLastFile = fileIndex === totalFiles - 1;

  const recentContext = recentTweets.length > 0
    ? `\nRecent tweets already posted:\n${recentTweets.map((t, i) => `${i + 1}. "${t}"`).join('\n')}`
    : '';

  const systemPrompt = `You are an experienced developer writing a Twitter series that walks followers through a GitHub repository called "${repoInfo.name}" — file by file, building a deep and complete understanding of the project.

The repo: ${repoInfo.description || 'a developer project'} (language: ${repoInfo.language || 'unknown'}).
This is file ${fileIndex + 1} of ${totalFiles} in the series.
${recentContext}

IMPORTANT: You have the FULL file content below. Read it carefully — every function, class, variable, loop, condition, and comment. Your tweets must reflect that you actually read and understood the code, not just the filename.

Your job: write exactly 20 tweets that FULLY explore this file. Go deep — line by line where interesting. Each tweet covers a DIFFERENT angle:
  1. Introduce the file — what it is, why it exists in this project
  2. The first major function or class — its signature, what it takes in, what it returns
  3. A specific algorithm or logic block — walk through what it actually does step by step
  4. How data enters this file and transforms as it moves through the code
  5. A specific variable, constant, or hyperparameter — its value and why that matters
  6. A loop, condition, or control flow that reveals important logic
  7. Something clever, elegant, or non-obvious in the implementation
  8. An edge case, error check, or guard clause the author wrote — and why it matters
  9. A second major function or class if there is one — go just as deep
  10. How the pieces inside this file work together as a system
  11. How this file connects to other files — what it imports, what calls it
  12. A design decision or architectural choice visible in the code
  13. What would break elsewhere if this file's logic changed
  14. A line or block of code worth quoting — explain exactly what it does
  15. How a beginner should approach reading this file, and what to focus on first
  16. What a senior developer would admire, question, or improve
  17. A subtle thing easy to miss on first read — but important
  18. A lesson any developer can take from studying this file
  19. How this file might evolve if the project scales or adds features
  20. Wrap up this file — what we now know — and tease what's next in the series

Rules:
- Each tweet max 240 characters
- QUOTE ACTUAL CODE from the file where possible — paste short snippets, function signatures, key lines, variable values directly into the tweet. e.g. "`loss = F.cross_entropy(logits, targets)` — one line but it's doing all the heavy lifting of training the GPT model"
- Be specific, not generic. "The forward() method masks padding tokens using `src_key_padding_mask`" beats "this file handles data"
- No hashtags. No emojis unless very natural
- No repetition across tweets
- Each tweet must make sense on its own
- Write conversationally — like a dev sharing something they genuinely found interesting while reading the code
${isFirstFile ? '- Tweet 1 is the series opener: introduce the repo and invite followers to follow along' : ''}
${isLastFile ? '- This is the last file: the final tweets should reflect on the whole codebase journey' : ''}

Return ONLY a raw JSON array of 20 strings. No markdown, no code fences, no explanation. Start with [ and end with ].
Example: ["first tweet text", "second tweet text", "third tweet text"]`;

  const userPrompt = `File: ${filePath}\n\nContent:\n${content}`;

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    max_tokens: 4000,
    temperature: 0.85,
  });

  const raw = completion.choices[0].message.content.trim();

  // Extract JSON array from anywhere in the response text
  const match = raw.match(/\[[\s\S]*\]/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]);
      if (Array.isArray(parsed)) return parsed;
    } catch (_) {}
  }

  // Fallback: try parsing the whole response as JSON
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
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
