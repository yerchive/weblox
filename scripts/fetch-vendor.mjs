/**
 * Downloads the pinned-engine vendor from Roblox's own CDN at deploy time.
 * Nothing proprietary is committed to the repo: everything under vendor/ is
 * fetched from Roblox and should be regenerated on each deployment.
 *
 *   node scripts/fetch-vendor.mjs               # engine + flags + epoxy + all content files
 *   node scripts/fetch-vendor.mjs --engine-only # skip the ~2900 content files (stream later)
 *   node scripts/fetch-vendor.mjs --verify      # only check that current vendor/ matches the CDN
 *
 * Endpoints used (all live as of verify time):
 *   https://clientsettings.roblox.com/v2/client-version/WebClientApp
 *   https://clientsettingscdn.roblox.com/v2/settings/application/<App>
 *   https://setup.rbxcdn.com/webclient/<versionUpload>-RobloxWebClient/<file>
 */

import {
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolvePath(__dirname, "..");
const VENDOR = join(ROOT, "vendor");
const ENGINE_DIR = join(VENDOR, "engine");
const FLAGS_DIR = join(VENDOR, "flags");
const EPOXY_DIR = join(VENDOR, "epoxy");

const ENGINE_FILE_NAMES = ["WasmPlayer.js", "WebClient.js", "WebClient.wasm", "audio-processor-fast.js", "WebClient.fsindex.txt"];
const CONFIG_APPS = ["WebClientApp", "WindowsWebClientApp", "MacWebClientApp", "iOSWebClientApp", "AndroidWebClientApp"];

const EPOXY_PACKAGE = "@mercuryworkshop/epoxy-transport";
const EPOXY_VERSION = "3.0.1";
const EPOXY_CDN = `https://cdn.jsdelivr.net/npm/${EPOXY_PACKAGE}@${EPOXY_VERSION}/dist/index.js`;

class HttpError extends Error {
  constructor(status, url) {
    super(`HTTP ${status} for ${url}`);
    this.status = status;
  }
}

async function fetchBuffer(url, tries = 4) {
  let lastError;
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      const res = await fetch(url);
      if (res.status === 404 || res.status === 403) throw new HttpError(res.status, url);
      if (!res.ok) throw new HttpError(res.status, url);
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      lastError = err;
      if (err instanceof HttpError && (err.status === 404 || err.status === 403)) throw err;
      await sleep(400 * 2 ** attempt);
    }
  }
  throw lastError;
}

async function fetchToFile(url, dest, tries = 4) {
  const buffer = await fetchBuffer(url, tries);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, buffer);
  return buffer.length;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Decode the prefix-compressed fsindex (byte format parsed by WasmPlayer.js). */
export function parseFsIndex(buffer) {
  const header = "rbxfsindex 1\n";
  const decoder = new TextDecoder();
  if (buffer.length < header.length + 2) throw new Error("WebClient.fsindex.txt: truncated header");
  if (buffer.subarray(0, header.length).toString("latin1") !== header) {
    throw new Error("WebClient.fsindex.txt: unsupported header");
  }

  const text = buffer.subarray(header.length);
  let cursorOfText = 0;
  let notFound = -1;
  const column = (stopByte) => {
    const idx = text.indexOf(stopByte, cursorOfText);
    if (idx === notFound) throw new Error("WebClient.fsindex.txt: truncated line");
    const chunk = text.subarray(cursorOfText, idx);
    cursorOfText = idx + 1;
    return chunk;
  };
  const number = (chunk) => {
    const parsed = Number(chunk.toString("latin1"));
    if (!Number.isInteger(parsed)) throw new Error("WebClient.fsindex.txt: malformed line");
    return parsed;
  };

  const entries = [];
  let previous = new Uint8Array(0);
  while (cursorOfText < text.length) {
    const prefixLen = number(column(0x09));
    const suffix = column(0x09);
    const size = number(column(0x0a));
    if (prefixLen > previous.length) throw new Error("WebClient.fsindex.txt: malformed line");
    const merged = new Uint8Array(prefixLen + suffix.length);
    merged.set(previous.subarray(0, prefixLen), 0);
    merged.set(suffix, prefixLen);
    previous = merged;
    entries.push({ path: decoder.decode(merged), size });
  }
  return entries;
}

async function main() {
  const engineOnly = process.argv.includes("--engine-only");
  const verify = process.argv.includes("--verify");

  const version = JSON.parse(
    (await fetchBuffer("https://clientsettings.roblox.com/v2/client-version/WebClientApp")).toString("utf8"),
  );
  if (!version.clientVersionUpload || !version.version) {
    throw new Error(`unexpected client-version payload: ${JSON.stringify(version)}`);
  }
  const base = `https://setup.rbxcdn.com/webclient/${version.clientVersionUpload}-RobloxWebClient`;
  console.log(`[vendor] engine ${version.version} (${version.clientVersionUpload})`);

  const previous = join(VENDOR, "version.json");
  if (existsSync(previous)) {
    const prior = JSON.parse(readFileSync(previous, "utf8"));
    if (prior.clientVersionUpload !== version.clientVersionUpload) {
      console.log("[vendor] engine changed upstream; clearing stale vendor/engine");
      rmSync(ENGINE_DIR, { recursive: true, force: true });
    }
  }

  mkdirSync(ENGINE_DIR, { recursive: true });
  mkdirSync(FLAGS_DIR, { recursive: true });
  mkdirSync(EPOXY_DIR, { recursive: true });

  let downloads = 0;
  const increment = () => {
    downloads += 1;
    if (downloads % 25 === 0) process.stdout.write(`  ${downloads} files...\n`);
  };

  for (const name of ENGINE_FILE_NAMES) {
    await fetchToFile(`${base}/${name}`, join(ENGINE_DIR, name));
    increment();
  }

  const fsindex = readFileSync(join(ENGINE_DIR, "WebClient.fsindex.txt"));
  const entries = parseFsIndex(fsindex);
  const totalBytes = entries.reduce((sum, entry) => sum + entry.size, 0);
  console.log(`[vendor] fsindex: ${entries.length} content files, ${(totalBytes / 1048576).toFixed(1)} MB`);

  if (!engineOnly) {
    const seen = new Set(entries.map((e) => e.path));
    if (seen.size !== entries.length) throw new Error("fsindex contains duplicate paths; refusing to guess layout");

    let ok = 0;
    let failed = [];
    const queue = [...entries];
    const worker = async () => {
      while (queue.length) {
        const entry = queue.shift();
        const dest = join(ENGINE_DIR, entry.path.replace(/^\//, ""));
        if (verify && existsSync(dest) && statSync(dest).size === entry.size) {
          ok += 1;
          increment();
          continue;
        }
        try {
          const fetched = `${base}${entry.path}`;
          const got = await fetchToFile(fetched, dest);
          if (got !== entry.size) throw new Error(`size mismatch for ${entry.path}: got ${got}, want ${entry.size}`);
          ok += 1;
        } catch (err) {
          failed.push(`${entry.path}: ${err.message}`);
        }
        increment();
      }
    };
    await Promise.all(Array.from({ length: 8 }, worker));
    if (failed.length) {
      const target = join(ROOT, "vendor-failures.txt");
      writeFileSync(target, failed.join("\n") + "\n");
      throw new Error(`${failed.length} content files failed; see ${target}`);
    }
    console.log(`[vendor] content files done (${ok})`);
  }

  for (const app of CONFIG_APPS) {
    const flags = await fetchBuffer(`https://clientsettingscdn.roblox.com/v2/settings/application/${app}`);
    JSON.parse(flags.toString("utf8")).applicationSettings;
    writeFileSync(join(FLAGS_DIR, `${app}.json`), flags);
  }
  console.log(`[vendor] pinned flags for ${CONFIG_APPS.join(", ")}`);

  await fetchToFile(EPOXY_CDN, join(EPOXY_DIR, "index.js"));
  console.log(`[vendor] epoxy transport ${EPOXY_PACKAGE}@${EPOXY_VERSION}`);

  writeFileSync(
    join(VENDOR, "version.json"),
    JSON.stringify(
      {
        version: version.version,
        clientVersionUpload: version.clientVersionUpload,
        base,
        pinnedAt: new Date().toISOString(),
        contentFiles: entries.length,
        contentBytes: totalBytes,
        coreFiles: ENGINE_FILE_NAMES,
        epoxy: { package: EPOXY_PACKAGE, version: EPOXY_VERSION },
      },
      null,
      2,
    ) + "\n",
  );
  console.log("[vendor] wrote vendor/version.json");
}

export { main as vendorMain };