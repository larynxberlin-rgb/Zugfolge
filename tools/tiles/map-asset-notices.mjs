import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export const MAP_ASSET_NOTICE_CONTRACT_SCHEMA = "zugfolge-map-asset-notice-contract/v1";
export const MAP_ASSET_NOTICES_SCHEMA = "zugfolge-map-asset-notices/v2";

const SHA256 = /^[a-f0-9]{64}$/;
const GIT_COMMIT = /^[a-f0-9]{40}$/;
const SAFE_ID = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;
const GITHUB_REPOSITORY = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function exactKeys(value, expected, label) {
  invariant(value !== null && typeof value === "object" && !Array.isArray(value), `${label} muss ein Objekt sein.`);
  invariant(Object.keys(value).sort().join(",") === [...expected].sort().join(","), `${label} besitzt unerwartete oder fehlende Felder.`);
}

function portableRelativePath(value, label) {
  invariant(typeof value === "string" && value !== "" && !value.includes("\\") && !value.includes("\0"), `${label} ist kein portabler relativer Pfad.`);
  invariant(!isAbsolute(value) && !value.startsWith("/") && !/^[a-z]:/i.test(value), `${label} muss relativ sein.`);
  invariant(value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".."), `${label} enthaelt ein unsicheres Segment.`);
  return value;
}

function validateSource(source, label) {
  exactKeys(source, ["repository", "commit", "path"], label);
  invariant(GITHUB_REPOSITORY.test(source.repository), `${label}.repository muss ein unveraenderliches GitHub-Quellrepository benennen.`);
  invariant(GIT_COMMIT.test(source.commit), `${label}.commit ist kein voller Git-Commit.`);
  portableRelativePath(source.path, `${label}.path`);
}

function validateDerivedFrom(value, label) {
  if (value === null) return;
  exactKeys(value, ["repository", "commit", "license"], label);
  invariant(GITHUB_REPOSITORY.test(value.repository), `${label}.repository muss ein GitHub-Quellrepository benennen.`);
  invariant(GIT_COMMIT.test(value.commit), `${label}.commit ist kein voller Git-Commit.`);
  invariant(value.license === "MIT", `${label}.license muss fuer die Sprite-Ursprungsicons MIT sein.`);
}

function validateTree(tree, kind, label) {
  exactKeys(tree, ["installDirectory", "files", "bytes", "sha256"], label);
  portableRelativePath(tree.installDirectory, `${label}.installDirectory`);
  invariant(Number.isSafeInteger(tree.files) && tree.files > 0, `${label}.files ist ungueltig.`);
  invariant(Number.isSafeInteger(tree.bytes) && tree.bytes > 0 && SHA256.test(tree.sha256), `${label} besitzt keinen vollstaendigen Baumbeleg.`);
}

function validateAssetShape(asset, { contract }, label) {
  exactKeys(asset, ["id", "rightsSourceId", "kind", "license", "copyright", "modifications", "source", "derivedFrom", "notice", "tree"], label);
  invariant(typeof asset.id === "string" && SAFE_ID.test(asset.id), `${label}.id ist ungueltig.`);
  invariant(typeof asset.rightsSourceId === "string" && SAFE_ID.test(asset.rightsSourceId), `${label}.rightsSourceId ist ungueltig.`);
  invariant(["glyph", "sprite"].includes(asset.kind), `${label}.kind ist ungueltig.`);
  invariant(asset.license === (asset.kind === "glyph" ? "OFL-1.1" : "MIT"), `${label}.license passt nicht zur Assetart.`);
  invariant(typeof asset.copyright === "string" && asset.copyright.length > 10, `${label}.copyright fehlt.`);
  invariant(typeof asset.modifications === "string" && asset.modifications.length > 10, `${label}.modifications fehlt.`);
  validateSource(asset.source, `${label}.source`);
  validateDerivedFrom(asset.derivedFrom, `${label}.derivedFrom`);
  if (asset.kind === "glyph") {
    invariant(asset.id === "noto-glyphs" && asset.rightsSourceId === "noto-glyphs" && asset.derivedFrom === null, `${label} muss die Noto-Glyphen eindeutig bezeichnen.`);
  } else {
    invariant(asset.id === "protomaps-sprites" && asset.rightsSourceId === "protomaps-sprites" && asset.derivedFrom?.repository === "https://github.com/tangrams/icons", `${label} muss die Tangrams-Ableitung eindeutig binden.`);
  }
  validateTree(asset.tree, asset.kind, `${label}.tree`);

  const noticeKeys = contract ? ["file", "url", "bytes", "sha256"] : ["url", "bytes", "sha256", "text"];
  exactKeys(asset.notice, noticeKeys, `${label}.notice`);
  invariant(typeof asset.notice.url === "string" && asset.notice.url.startsWith("https://raw.githubusercontent.com/") && asset.notice.url.includes(asset.kind === "glyph" ? asset.source.commit : asset.derivedFrom.commit), `${label}.notice.url ist nicht an den gepinnten Lizenz-Commit gebunden.`);
  invariant(Number.isSafeInteger(asset.notice.bytes) && asset.notice.bytes > 0 && SHA256.test(asset.notice.sha256), `${label}.notice besitzt keinen Byte-SHA-Beleg.`);
  if (contract) {
    portableRelativePath(asset.notice.file, `${label}.notice.file`);
  } else {
    invariant(typeof asset.notice.text === "string" && Buffer.byteLength(asset.notice.text, "utf8") === asset.notice.bytes, `${label}.notice.text weicht von der Bytebindung ab.`);
    invariant(createHash("sha256").update(asset.notice.text, "utf8").digest("hex") === asset.notice.sha256, `${label}.notice.text weicht von der SHA-256-Bindung ab.`);
    invariant(asset.notice.text.includes(asset.copyright), `${label}.notice.text enthaelt den Copyrightvermerk nicht.`);
    invariant(asset.kind === "glyph" ? asset.notice.text.includes("SIL OPEN FONT LICENSE Version 1.1") : asset.notice.text.includes("The MIT License (MIT)"), `${label}.notice.text enthaelt nicht den erwarteten Volltext.`);
  }
}

function validateAssetList(assets, options, label) {
  invariant(Array.isArray(assets) && assets.length === 2, `${label} muss genau Noto-Glyphen und Protomaps-Sprites enthalten.`);
  let previousId = "";
  for (const [index, asset] of assets.entries()) {
    validateAssetShape(asset, options, `${label}[${index}]`);
    invariant(asset.id.localeCompare(previousId, "en") > 0, `${label} muss stabil nach ID sortiert sein.`);
    previousId = asset.id;
  }
  invariant(assets[0].id === "noto-glyphs" && assets[1].id === "protomaps-sprites", `${label} besitzt nicht die beiden vorgeschriebenen Assetgruppen.`);
}

function containedNoticePath(repositoryRoot, portablePath, label) {
  const root = resolve(repositoryRoot);
  const path = resolve(root, ...portableRelativePath(portablePath, label).split("/"));
  const remainder = relative(root, path);
  invariant(remainder !== "" && remainder !== ".." && !remainder.startsWith(`..${sep}`) && !isAbsolute(remainder), `${label} verlaesst die Repositorywurzel.`);
  return path;
}

export async function loadMapAssetNotices(contract, repositoryRoot) {
  exactKeys(contract, ["schema", "assets"], "Asset-Notice-Vertrag");
  invariant(contract.schema === MAP_ASSET_NOTICE_CONTRACT_SCHEMA, "Unbekannter Asset-Notice-Vertrag.");
  validateAssetList(contract.assets, { contract: true }, "Asset-Notice-Vertrag.assets");

  const assets = [];
  for (const asset of contract.assets) {
    const noticePath = containedNoticePath(repositoryRoot, asset.notice.file, `${asset.id}.notice.file`);
    const metadata = await lstat(noticePath);
    invariant(metadata.isFile() && !metadata.isSymbolicLink(), `${asset.id}.notice.file muss eine regulaere Datei sein.`);
    const bytes = await readFile(noticePath);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    invariant(bytes.length === asset.notice.bytes && sha256 === asset.notice.sha256, `${asset.id}.notice.file weicht vom gepinnten Byte-SHA-Beleg ab.`);
    const { file: _file, ...notice } = asset.notice;
    assets.push({ ...asset, notice: { ...notice, text: bytes.toString("utf8") } });
  }
  const result = { schema: MAP_ASSET_NOTICES_SCHEMA, assets };
  validateMapAssetNotices(result);
  return result;
}

export function validateMapAssetNotices(value) {
  exactKeys(value, ["schema", "assets"], "Oeffentliche Asset-Notices");
  invariant(value.schema === MAP_ASSET_NOTICES_SCHEMA, "Unbekannte oeffentliche Asset-Notices.");
  validateAssetList(value.assets, { contract: false }, "Oeffentliche Asset-Notices.assets");
  return value;
}

export function buildMapAssetTreeProof(kind, installDirectory, descriptors) {
  invariant(["glyph", "sprite"].includes(kind), "Assetbaumart ist ungueltig.");
  portableRelativePath(installDirectory, "Assetbaum.installDirectory");
  invariant(Array.isArray(descriptors), "Assetdeskriptoren muessen eine Liste sein.");
  const prefix = `${installDirectory}/`;
  const rows = descriptors
    .filter((descriptor) => descriptor?.kind === kind && typeof descriptor.installPath === "string" && descriptor.installPath.startsWith(prefix))
    .map((descriptor) => {
      const path = descriptor.installPath.slice(prefix.length);
      portableRelativePath(path, `${kind}.installPath`);
      const bytes = descriptor.bytes ?? descriptor.expectedBytes;
      const sha256 = descriptor.sha256 ?? descriptor.expectedSha256;
      invariant(Number.isSafeInteger(bytes) && bytes > 0 && SHA256.test(sha256), `${descriptor.id ?? path} besitzt keinen Asset-Byte-SHA-Beleg.`);
      return { path, bytes, sha256 };
    })
    .sort((left, right) => left.path.localeCompare(right.path, "en"));
  invariant(rows.length > 0, `${kind}-Assetbaum ist leer.`);
  invariant(new Set(rows.map(({ path }) => path.toLowerCase())).size === rows.length, `${kind}-Assetbaum enthaelt doppelte oder kollidierende Pfade.`);
  const canonical = rows.map(({ path, bytes, sha256 }) => `${path}\0${bytes}\0${sha256}`).join("\n") + "\n";
  return {
    installDirectory,
    files: rows.length,
    bytes: rows.reduce((sum, row) => sum + row.bytes, 0),
    sha256: createHash("sha256").update(canonical, "utf8").digest("hex"),
  };
}

export function sameMapAssetTreeProof(left, right) {
  validateTree(left, undefined, "Linker Assetbaumbeleg");
  validateTree(right, undefined, "Rechter Assetbaumbeleg");
  return left.installDirectory === right.installDirectory
    && left.files === right.files
    && left.bytes === right.bytes
    && left.sha256 === right.sha256;
}

export function validateMapAssetNoticeBindings(value, descriptors) {
  const notices = validateMapAssetNotices(value);
  const assetDescriptors = descriptors.filter(({ kind }) => ["glyph", "sprite"].includes(kind));
  let covered = 0;
  for (const asset of notices.assets) {
    const observed = buildMapAssetTreeProof(asset.kind, asset.tree.installDirectory, assetDescriptors);
    invariant(sameMapAssetTreeProof(observed, asset.tree), `${asset.id} weicht vom lizenzierten und gepinnten Assetbaum ab.`);
    covered += observed.files;
  }
  invariant(covered === assetDescriptors.length, "Glyphen- oder Sprite-Dateien liegen ausserhalb der lizenzierten Assetbaeume.");
  return notices;
}
