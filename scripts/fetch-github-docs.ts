#!/usr/bin/env tsx
/**
 * Fetch HustleXP documentation from GitHub
 * 
 * Usage:
 *   GITHUB_TOKEN=your_token tsx scripts/fetch-github-docs.ts [path]
 * 
 * Examples:
 *   tsx scripts/fetch-github-docs.ts                    # List all docs
 *   tsx scripts/fetch-github-docs.ts docs/README.md     # Fetch specific doc
 */

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
const GITHUB_OWNER = 'HustleXP'; // Update if different
const GITHUB_REPO = 'docs'; // Update if different
const GITHUB_API_BASE = 'https://api.github.com';

interface GitHubFile {
  name: string;
  path: string;
  type: 'file' | 'dir';
  download_url?: string;
  sha: string;
}

async function fetchGitHubAPI(endpoint: string): Promise<any> {
  const url = `${GITHUB_API_BASE}${endpoint}`;
  const headers: HeadersInit = {
    'Accept': 'application/vnd.github.v3+json',
  };

  if (GITHUB_TOKEN) {
    headers['Authorization'] = `token ${GITHUB_TOKEN}`;
  }

  const response = await fetch(url, { headers });
  
  if (!response.ok) {
    throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

async function listDocs(path: string = ''): Promise<GitHubFile[]> {
  const endpoint = `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${path}`;
  return fetchGitHubAPI(endpoint);
}

async function fetchDoc(path: string): Promise<string> {
  const file = await fetchGitHubAPI(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${path}`);
  
  if (file.encoding === 'base64') {
    return Buffer.from(file.content, 'base64').toString('utf-8');
  }
  
  // If download_url is available, fetch directly
  if (file.download_url) {
    const response = await fetch(file.download_url);
    return response.text();
  }
  
  throw new Error('Unable to decode file content');
}

async function saveDoc(path: string, content: string, outputDir: string = 'docs/github'): Promise<void> {
  const fs = await import('fs/promises');
  const pathModule = await import('path');
  
  const outputPath = pathModule.join(outputDir, path);
  const dir = pathModule.dirname(outputPath);
  
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(outputPath, content, 'utf-8');
  
  console.log(`✅ Saved: ${outputPath}`);
}

async function main() {
  const targetPath = process.argv[2];

  if (!GITHUB_TOKEN) {
    console.error('❌ Error: GITHUB_TOKEN environment variable not set');
    console.error('   Set it with: export GITHUB_TOKEN=your_token');
    process.exit(1);
  }

  try {
    if (targetPath) {
      // Fetch specific document
      console.log(`📥 Fetching: ${targetPath}`);
      const content = await fetchDoc(targetPath);
      await saveDoc(targetPath, content);
      console.log('✅ Done!');
    } else {
      // List all documents
      console.log('📚 Available documentation:');
      console.log('');
      
      const files = await listDocs();
      
      for (const file of files) {
        if (file.type === 'file' && (file.name.endsWith('.md') || file.name.endsWith('.txt'))) {
          console.log(`  📄 ${file.path}`);
        } else if (file.type === 'dir') {
          console.log(`  📁 ${file.path}/`);
        }
      }
      
      console.log('');
      console.log('💡 To fetch a specific doc:');
      console.log(`   tsx scripts/fetch-github-docs.ts <path>`);
    }
  } catch (error: any) {
    console.error('❌ Error:', error.message);
    if (error.message.includes('404')) {
      console.error('   Repository or path not found. Check GITHUB_OWNER and GITHUB_REPO in script.');
    }
    process.exit(1);
  }
}

main();
