import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";

const directory = fileURLToPath(new URL("../public/", import.meta.url));
const mark = readFileSync(directory + "/brand-mark.svg", "utf8");
// Derive the decorative outline and every OS icon from the same master path.
const shape = mark.match(/<path fill="url\(#link\)" d="([^"]+)"/)?.[1];
if (!shape)
  throw new Error("The brand master must contain the link silhouette");
writeFileSync(
  directory + "/brand-outline.svg",
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="8 18 114 88"><path d="${shape}" fill="none" stroke="#becbea" stroke-width=".22"/></svg>`,
);
const content = mark.replace(/<svg[^>]+>/, "").replace(/<\/svg>\s*$/, "");
const icon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 144 144"><rect x="2" y="2" width="140" height="140" rx="32" fill="#101e36"/><g transform="translate(8 12)">${content}</g></svg>`;
function png(size) {
  return new Resvg(icon, { fitTo: { mode: "width", value: size } })
    .render()
    .asPng();
}
const sizes = [16, 24, 32, 48, 64, 128, 256];
const images = sizes.map(png);
const header = Buffer.alloc(6 + sizes.length * 16);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(sizes.length, 4);
let offset = header.length;
for (let i = 0; i < sizes.length; i++) {
  const index = 6 + i * 16;
  header[index] = header[index + 1] = sizes[i] === 256 ? 0 : sizes[i];
  header.writeUInt16LE(1, index + 4);
  header.writeUInt16LE(32, index + 6);
  header.writeUInt32LE(images[i].length, index + 8);
  header.writeUInt32LE(offset, index + 12);
  offset += images[i].length;
}
writeFileSync(directory + "/icon.ico", Buffer.concat([header, ...images]));
writeFileSync(directory + "/icon.png", png(256));
writeFileSync(directory + "/tray.png", png(32));
