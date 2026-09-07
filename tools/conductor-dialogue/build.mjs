import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

/** Übersetzt ausschließlich die offline geschriebenen Szenen in den Rust-DTO. */
export function compileDialogueSource(source) {
  const families = [];
  let family;
  let profile;
  for (const line of source.split(/\r?\n/).filter((line) => line.trim())) {
    if (line.startsWith('@')) {
      const [familyId, presentation, tone, cooperation] = line.slice(1).split('|');
      if (!familyId || !presentation || !tone || !cooperation) throw new Error('Ungültige Familienzeile.');
      family = { familyId, weightBasisPoints: 833, trees: [] };
      profile = { presentation, tone, cooperation };
      families.push(family);
      continue;
    }
    if (!family) throw new Error('Szene ohne Situationsfamilie.');
    const fields = line.split('|');
    if (fields.length !== 5 || fields.some((field) => !field.trim())) throw new Error('Ungültige Szenenzeile.');
    const [scenario, opening, detail, response, closing] = fields;
    const option = (optionId, text, condition, timeCostMs, nextNodeId, intent = null) =>
      ({ optionId, text, condition, timeCostMs, nextNodeId, intent });
    const close = () => option('close', 'Kontrolle beenden', 'always', 1000, 'closing', 'close_without_action');
    const actions = () => [
      option('regular', 'Reguläre Forderung prüfen', 'regular_claim_allowed', 4000, 'closing', 'request_regular_claim'),
      option('provisional', 'Vorläufige Forderung prüfen', 'provisional_claim_allowed', 4000, 'closing', 'request_provisional_claim'),
      option('police', 'Polizei anfordern', 'police_allowed', 3000, 'closing', 'request_police'), close(),
    ];
    // Längere Reaktionszeit ist ein Darstellungsprofil, kein Fahrkartenindiz.
    const replyTime = profile.presentation === 'intoxication' ? 6000 : 3500;
    family.trees.push({ treeId: `${family.familyId}-${String(family.trees.length + 1).padStart(2, '0')}`,
      scenario, weightBasisPoints: 769, ...profile, entryNodeId: 'opening', nodes: [
        { nodeId: 'opening', passengerText: opening, options: [
          option('ask', 'Was ist passiert?', 'always', replyTime, 'detail'),
          option('check', 'Fahrkarte prüfen', 'document_unchecked', 2500, 'detail', 'request_document_check'),
          option('explain', 'Nächste Schritte erklären', 'always', replyTime, 'response'), ...actions(),
        ] },
        { nodeId: 'detail', passengerText: detail, options: [
          option('explain', 'Nächste Schritte erklären', 'always', replyTime, 'response'),
          option('check', 'Fahrkarte prüfen', 'document_unchecked', 2500, 'response', 'request_document_check'), ...actions(),
        ] },
        { nodeId: 'response', passengerText: response, options: actions() },
        { nodeId: 'closing', passengerText: closing, options: [] },
      ] });
  }
  if (families.length !== 12 || families.some((entry) => entry.trees.length !== 13)) throw new Error('Der Autorenkorpus muss zwölf Familien mit je 13 Szenen enthalten.');
  families.at(-1).weightBasisPoints = 837;
  for (const entry of families) entry.trees.at(-1).weightBasisPoints = 772;
  return { schemaVersion: 'conductor-dialogue-release/v1', releaseId: 'dialogue-de-2026-v1', locale: 'de-DE', families };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = fileURLToPath(new URL('../../assets/conductor-dialogue/v1/', import.meta.url));
  const source = await readFile(resolve(directory, 'scenes.txt'), 'utf8');
  await writeFile(resolve(directory, 'release.json'), JSON.stringify(compileDialogueSource(source)), 'utf8');
  process.stdout.write('Dialogkandidat aus 156 geschriebenen Szenen erstellt.\n');
}
