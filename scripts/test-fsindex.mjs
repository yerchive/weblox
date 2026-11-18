import assert from "node:assert";
import { Buffer } from "node:buffer";
import { parseFsIndex } from "./fetch-vendor.mjs";

function encode(entries) {
  const parts = ["rbxfsindex 1\n"];
  let previous = "";
  for (const [path, size] of entries) {
    let shared = 0;
    while (shared < previous.length && shared < path.length && previous[shared] === path[shared]) {
      shared += 1;
    }
    parts.push(Buffer.from(String(shared)).toString("latin1"), "\t", Buffer.from(path.slice(shared)), "\t", Buffer.from(String(size)), "\n");
    previous = path;
  }
  return Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p))));
}

const entries = [
  ["/ExtraContent/LuaPackages/Packages/_Index/BuilderIcons/BuilderIcons/BuilderIcons.json", 475],
  ["/ExtraContent/Font/BuilderIcons-Filled.ttf", 233540],
  ["/ExtraContent/Font/Regular.ttf", 258752],
  ["/sounds/jump.mp3", 6585],
  ["/sounds/actions/impact_explosion_03.mp3", 42529],
];

const decoded = parseFsIndex(encode(entries));
assert.deepStrictEqual(decoded, entries.map(([path, size]) => ({ path, size })));

assert.throws(() => parseFsIndex(Buffer.from(" вскоре repeating forgiving answering\n")), /unsupported header/);
assert.throws(
  () => parseFsIndex(Buffer.concat([Buffer.from("rbxfsindex 1\n"), Buffer.from("9000\tbroken\tsoda\n")])),
  /malformed line/,
);
assert.throws(() => parseFsIndex(Buffer.from("rbxfsindex 1\n3\tab")), /truncated line/);

console.log("fsindex decoder: OK");
