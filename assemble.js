const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const sourceDir = path.join(__dirname, 'game-parts');
const names = fs.readdirSync(sourceDir).filter(n => /^index-\d+\.part$/.test(n)).sort();
if (names.length !== 19) throw new Error('Missing source asset parts');
const source = Buffer.concat(names.map(n => fs.readFileSync(path.join(sourceDir, n))));
const blobHash = b => crypto.createHash('sha1').update('blob ' + b.length + '\0').update(b).digest('hex');
if (blobHash(source) !== 'e43133a6d7b6d4397b00f0d61f92b36898d741bd') throw new Error('Source asset integrity check failed');
const updateDir = path.join(__dirname, 'deploy-parts');
const plan = JSON.parse(fs.readFileSync(path.join(updateDir, 'plan.json'), 'utf8'));
const content = Buffer.concat(plan.map(p => p.file
  ? fs.readFileSync(path.join(updateDir, p.file))
  : source.subarray(p.offset, p.offset + p.length)));
if (blobHash(content) !== '3ba8b5a08e4eaa7aedd6063554ec72a3ea88f631') throw new Error('Updated game integrity check failed');
fs.mkdirSync(path.join(__dirname, 'public'), { recursive: true });
fs.writeFileSync(path.join(__dirname, 'public/index.html'), content);
console.log('Berlin Rush assembled and verified (' + content.length + ' bytes)');
