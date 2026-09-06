import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflowPath = path.join(rootDir, '.github/workflows/test.yml');
const sonarPropertiesPath = path.join(rootDir, 'sonar-project.properties');
const readmePath = path.join(rootDir, 'README.md');

async function readText(relativePath) {
  return readFile(relativePath, 'utf8');
}

function hasLineMatching(lines, pattern) {
  return lines.some((line) => pattern.test(line));
}

function indexOfLineMatching(lines, pattern) {
  return lines.findIndex((line) => pattern.test(line));
}

test('scan job is optional, gated, and fail-closed', async () => {
  const [workflow, sonarProperties, readme] = await Promise.all([
    readText(workflowPath),
    readText(sonarPropertiesPath),
    readText(readmePath),
  ]);

  const workflowLines = workflow.split(/\r?\n/);
  const scanJobIndex = indexOfLineMatching(workflowLines, /^\s{2}scan:\s*$/);
  assert.ok(scanJobIndex >= 0, 'scan job must exist');

  assert.match(
    workflow,
    /vars\.SONAR_ENABLED\s*==\s*['"]true['"]/,
    'scan job must require vars.SONAR_ENABLED == "true"',
  );

  assert.match(
    workflow,
    /github\.event\.pull_request\.head\.repo\.full_name\s*==\s*github\.repository/,
    'scan job must protect same-repository events',
  );

  const preflightIndex = indexOfLineMatching(workflowLines, /^\s*- name:\s*Sonar preflight\s*$/);
  assert.ok(preflightIndex >= 0, 'enabled scan must have a Sonar preflight step');
  assert.ok(preflightIndex > scanJobIndex, 'Sonar preflight must live inside the scan job');

  const preflightWindow = workflowLines.slice(preflightIndex, preflightIndex + 30).join('\n');
  assert.match(
    preflightWindow,
    /SONAR_TOKEN/,
    'preflight must check SONAR_TOKEN',
  );
  assert.match(
    preflightWindow,
    /SONAR_PROJECT_KEY/,
    'preflight must check SONAR_PROJECT_KEY',
  );
  assert.match(
    preflightWindow,
    /SONAR_ORGANIZATION/,
    'preflight must check SONAR_ORGANIZATION',
  );
  assert.ok(
    !hasLineMatching(preflightWindow.split(/\r?\n/), /echo .*SONAR_|printenv|set -x/i),
    'preflight must not print secret values',
  );

  assert.match(
    workflow,
    /args:.*vars\.SONAR_PROJECT_KEY.*vars\.SONAR_ORGANIZATION/s,
    'scan args must use fork repository variables for project identity',
  );
});

test('workflow name does not present Sonar as a core success condition', async () => {
  const workflow = await readText(workflowPath);

  assert.match(
    workflow.split(/\r?\n/)[0],
    /^name:\s*(?!.*Sonar).*$/i,
    'workflow name must not present Sonar as a core success condition',
  );
});

test('checked-in Sonar identity stays fork-owned', async () => {
  const [sonarProperties, readme] = await Promise.all([
    readText(sonarPropertiesPath),
    readText(readmePath),
  ]);

  assert.ok(
    !sonarProperties.includes('sonar.projectKey=liketrek_TREK'),
    'sonar-project.properties must not hard-code liketrek_TREK',
  );
  assert.ok(
    !sonarProperties.includes('sonar.organization=liketrek'),
    'sonar-project.properties must not hard-code sonar.organization=liketrek',
  );
  assert.ok(
    !readme.includes('liketrek_TREK'),
    'fork README must not hard-code liketrek_TREK',
  );
  assert.ok(
    !readme.includes('sonar.organization=liketrek'),
    'fork README must not hard-code sonar.organization=liketrek',
  );
});
