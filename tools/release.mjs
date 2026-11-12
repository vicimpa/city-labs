// Release notes and installer integrity files used by the publishing workflow.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export function releaseNotes(markdown, version) {
  const heading = markdown.split('\n').find((line) => line.startsWith(`## [${version}]`));
  if (!heading) throw new Error(`No changelog entry for ${version}`);
  const content = markdown.slice(markdown.indexOf(heading) + heading.length).split(/^## /m)[0].trim();
  if (!content) throw new Error(`Empty changelog entry for ${version}`);
  return content + '\n';
}

export function verifyInstallers(files) {
  if (files.filter((name) => name.endsWith('.dmg')).length < 2) throw new Error('Both macOS installers are required');
  if (!files.some((name) => name.endsWith('.exe'))) throw new Error('Windows installer is required');
  if (!files.some((name) => name.endsWith('.AppImage'))) throw new Error('Linux AppImage is required');
}

export async function writeChecksums(directory) {
  const files = fs.readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name !== 'SHA256SUMS').map((entry) => entry.name).sort();
  verifyInstallers(files);
  const lines = [];
  for (const name of files) {
    if (/[\r\n\\]/.test(name)) throw new Error('Unsupported installer filename');
    const hash = createHash('sha256');
    for await (const chunk of fs.createReadStream(path.join(directory, name))) hash.update(chunk);
    lines.push(`${hash.digest('hex')}  ${name}`);
  }
  const output = path.join(directory, 'SHA256SUMS');
  fs.writeFileSync(output, lines.join('\n') + '\n');
  return output;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [command, directory] = process.argv.slice(2);
  if (command === 'notes') {
    const { version } = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    process.stdout.write(releaseNotes(fs.readFileSync('CHANGELOG.md', 'utf8'), version));
  } else if (command === 'checksums' && directory) console.log(await writeChecksums(directory));
  else throw new Error('Usage: node tools/release.mjs notes | checksums <installer-directory>');
}
