import fs from 'node:fs';
import path from 'node:path';

const packageRoot = path.resolve('node_modules/@whiskeysockets/baileys');
if (!fs.existsSync(packageRoot)) {
  console.error('[H2E] Baileys não encontrado em node_modules/@whiskeysockets/baileys.');
  process.exit(1);
}

const textExtensions = new Set(['.js', '.mjs', '.cjs']);
const pending = [packageRoot];
let patchedFiles = 0;
let alreadyPatchedFiles = 0;
let matchedOriginal = 0;

while (pending.length) {
  const current = pending.pop();
  let entries;
  try { entries = fs.readdirSync(current, { withFileTypes: true }); }
  catch { continue; }

  for (const entry of entries) {
    const full = path.join(current, entry.name);
    if (entry.isDirectory()) {
      // Only scan runtime output, avoiding large test/source trees when present.
      if (entry.name !== 'node_modules' && entry.name !== '__tests__' && entry.name !== 'tests') pending.push(full);
      continue;
    }
    if (!entry.isFile() || !textExtensions.has(path.extname(entry.name))) continue;

    let source;
    try { source = fs.readFileSync(full, 'utf8'); } catch { continue; }
    if (!source.includes('buildAckStanza')) continue;

    const originalPattern = /(buildAckStanza\s*\(\s*node\s*,\s*errorCode\s*,\s*authState\.creds\.me)\.id(\s*\))/g;
    const count = (source.match(originalPattern) || []).length;
    if (count > 0) {
      const output = source.replace(originalPattern, '$1?.id$2');
      fs.writeFileSync(full, output);
      patchedFiles += 1;
      matchedOriginal += count;
      console.log(`[H2E] Corrigido ACK antes do login em ${path.relative(packageRoot, full)} (${count} ocorrência(s)).`);
    } else if (/buildAckStanza\s*\(\s*node\s*,\s*errorCode\s*,\s*authState\.creds\.me\?\.id\s*\)/.test(source)) {
      alreadyPatchedFiles += 1;
    }
  }
}

if (patchedFiles === 0 && alreadyPatchedFiles === 0) {
  console.error('[H2E] Não encontrei a chamada esperada de buildAckStanza em Baileys. A instalação foi interrompida para não publicar sem a correção pré-login. Verifique a versão da dependência.');
  process.exit(1);
}
console.log(`[H2E] Patch de pareamento pré-login concluído. Arquivos alterados: ${patchedFiles}; já corrigidos: ${alreadyPatchedFiles}; ocorrências alteradas: ${matchedOriginal}.`);
