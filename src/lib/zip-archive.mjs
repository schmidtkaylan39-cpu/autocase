import { readFile } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";

export function parseZipEntries(zipBuffer) {
  const endOfCentralDirectorySignature = 0x06054b50;
  const centralDirectorySignature = 0x02014b50;
  const localFileHeaderSignature = 0x04034b50;
  let endOfCentralDirectoryOffset = -1;

  for (let offset = zipBuffer.length - 22; offset >= 0; offset -= 1) {
    if (zipBuffer.readUInt32LE(offset) === endOfCentralDirectorySignature) {
      endOfCentralDirectoryOffset = offset;
      break;
    }
  }

  if (endOfCentralDirectoryOffset < 0) {
    throw new Error("Invalid ZIP archive: missing end of central directory record.");
  }

  const centralDirectorySize = zipBuffer.readUInt32LE(endOfCentralDirectoryOffset + 12);
  const centralDirectoryOffset = zipBuffer.readUInt32LE(endOfCentralDirectoryOffset + 16);
  const entries = [];
  let cursor = centralDirectoryOffset;
  const end = centralDirectoryOffset + centralDirectorySize;

  while (cursor < end) {
    if (zipBuffer.readUInt32LE(cursor) !== centralDirectorySignature) {
      throw new Error("Invalid ZIP central directory entry.");
    }

    const compressionMethod = zipBuffer.readUInt16LE(cursor + 10);
    const compressedSize = zipBuffer.readUInt32LE(cursor + 20);
    const fileNameLength = zipBuffer.readUInt16LE(cursor + 28);
    const extraFieldLength = zipBuffer.readUInt16LE(cursor + 30);
    const commentLength = zipBuffer.readUInt16LE(cursor + 32);
    const localHeaderOffset = zipBuffer.readUInt32LE(cursor + 42);
    const nameStart = cursor + 46;
    const nameEnd = nameStart + fileNameLength;

    entries.push({
      name: zipBuffer.toString("utf8", nameStart, nameEnd),
      compressionMethod,
      compressedSize,
      localHeaderOffset
    });

    cursor = nameEnd + extraFieldLength + commentLength;
  }

  return entries.map((entry) => {
    if (zipBuffer.readUInt32LE(entry.localHeaderOffset) !== localFileHeaderSignature) {
      throw new Error("Invalid ZIP local file header.");
    }

    const fileNameLength = zipBuffer.readUInt16LE(entry.localHeaderOffset + 26);
    const extraFieldLength = zipBuffer.readUInt16LE(entry.localHeaderOffset + 28);
    const contentStart = entry.localHeaderOffset + 30 + fileNameLength + extraFieldLength;
    const compressedContent = zipBuffer.subarray(contentStart, contentStart + entry.compressedSize);
    let contentBuffer;

    if (entry.compressionMethod === 8) {
      contentBuffer = inflateRawSync(compressedContent);
    } else if (entry.compressionMethod === 0) {
      contentBuffer = compressedContent;
    } else {
      throw new Error(`Unsupported ZIP compression method: ${entry.compressionMethod}`);
    }

    return {
      name: entry.name,
      contentBuffer
    };
  });
}

export async function readZipEntriesFromFile(archivePath) {
  return parseZipEntries(await readFile(archivePath));
}

export async function validateZipArchiveEntryNames(archivePath) {
  const zipEntries = await readZipEntriesFromFile(archivePath);
  const invalidEntry = zipEntries.find((entry) => entry.name.includes("\\"));

  if (invalidEntry) {
    throw new Error(`ZIP archive contains backslash path separators: ${invalidEntry.name}`);
  }

  return zipEntries;
}
