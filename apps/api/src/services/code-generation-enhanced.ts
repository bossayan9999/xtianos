import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { env } from '../lib/env';
import { prisma } from '../lib/db';
import { spawn } from 'node:child_process';

export interface GeneratedSoftware {
  repoPath: string;
  dockerfile: string;
  testsPassed: boolean;
  testResults: string;
  artifacts: Array<{ id: number; filename: string }>;
}

/**
 * Generate a complete software project with tests.
 */
export async function generateAndTestSoftware(
  prompt: string,
  language: string = 'typescript',
  testFramework: string = 'vitest',
): Promise<GeneratedSoftware> {
  const projectDir = path.join(env.workspaceDir, `gen_${Date.now()}`);
  await fsp.mkdir(projectDir, { recursive: true });

  // Step 1: Create project structure
  await createProjectStructure(projectDir, language, testFramework);

  // Step 2: Generate main source files (from mjane)
  const sourceCode = await generateSourceCode(prompt, language);
  await fsp.writeFile(path.join(projectDir, 'src/main.ts'), sourceCode);

  // Step 3: Generate tests
  const testCode = await generateTestCode(sourceCode, language, testFramework);
  await fsp.writeFile(path.join(projectDir, 'src/main.test.ts'), testCode);

  // Step 4: Create Dockerfile
  const dockerfile = generateDockerfile(language);
  await fsp.writeFile(path.join(projectDir, 'Dockerfile'), dockerfile);

  // Step 5: Run tests locally
  const testResults = await runTests(projectDir, language, testFramework);
  const testsPassed = testResults.includes('passed');

  // Step 6: Save as artifacts
  const artifacts = await saveAsArtifacts(projectDir, prompt);

  return {
    repoPath: projectDir,
    dockerfile,
    testsPassed,
    testResults,
    artifacts,
  };
}

async function createProjectStructure(
  projectDir: string,
  language: string,
  testFramework: string,
): Promise<void> {
  await fsp.mkdir(path.join(projectDir, 'src'), { recursive: true });
  await fsp.mkdir(path.join(projectDir, '.github/workflows'), { recursive: true });

  // Create package.json
  const packageJson = {
    name: `gen_${Date.now()}`,
    version: '0.1.0',
    scripts: {
      test: testFramework === 'vitest' ? 'vitest run' : 'jest',
      build: 'tsc',
    },
  };
  await fsp.writeFile(
    path.join(projectDir, 'package.json'),
    JSON.stringify(packageJson, null, 2),
  );
}

async function generateSourceCode(
  prompt: string,
  _language: string,
): Promise<string> {
  // In production, call mjane to generate code
  return `
// Generated from prompt: ${prompt}
export function main(): string {
  return 'Hello, World!';
}
  `;
}

async function generateTestCode(
  _sourceCode: string,
  _language: string,
  _testFramework: string,
): Promise<string> {
  // In production, generate comprehensive tests
  return `
import { main } from './main';
import { describe, it, expect } from 'vitest';

describe('main', () => {
  it('should return a greeting', () => {
    expect(main()).toBe('Hello, World!');
  });
});
  `;
}

function generateDockerfile(_language: string): string {
  return `
FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
CMD ["npm", "start"]
  `;
}

async function runTests(
  projectDir: string,
  _language: string,
  _testFramework: string,
): Promise<string> {
  return new Promise((resolve) => {
    const test = spawn('npm', ['test'], {
      cwd: projectDir,
      timeout: 30000,
    });
    let output = '';
    test.stdout?.on('data', (data) => { output += data.toString(); });
    test.stderr?.on('data', (data) => { output += data.toString(); });
    test.on('close', () => resolve(output));
  });
}

async function saveAsArtifacts(
  projectDir: string,
  prompt: string,
): Promise<Array<{ id: number; filename: string }>> {
  const artifacts: Array<{ id: number; filename: string }> = [];
  const files = await fsp.readdir(projectDir, { recursive: true });

  for (const file of files) {
    if (typeof file === 'string' && file.endsWith('.ts')) {
      const content = await fsp.readFile(path.join(projectDir, file), 'utf-8');
      const artifact = await prisma.artifact.create({
        data: {
          kind: 'code',
          filename: file,
          mime: 'text/typescript',
          textPreview: prompt.slice(0, 500),
        },
      });
      artifacts.push({ id: artifact.id, filename: file });
    }
  }

  return artifacts;
}
