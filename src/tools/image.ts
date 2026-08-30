import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { defineTool, toolError, toolOk, type Tool } from './registry.js';
import { formatBytes } from '../util/format.js';
import type { ImagePart } from '../providers/provider.js';

/** Providers reject very large inline images; refuse early with a clear message. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export const IMAGE_MEDIA_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
};

export function isImagePath(filePath: string): boolean {
  return path.extname(filePath).toLowerCase() in IMAGE_MEDIA_TYPES;
}

export interface ImageDimensions {
  width: number;
  height: number;
  format: string;
}

/**
 * Read image dimensions straight from the file header. Avoids a native image
 * dependency, which matters for a tool people install globally.
 */
export function readImageDimensions(buffer: Buffer): ImageDimensions | null {
  // PNG: 8-byte signature, then an IHDR chunk with width/height as big-endian u32.
  if (buffer.length >= 24 && buffer.readUInt32BE(0) === 0x89504e47) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20), format: 'PNG' };
  }

  // GIF: "GIF87a"/"GIF89a", then little-endian u16 width/height.
  if (buffer.length >= 10 && buffer.toString('ascii', 0, 3) === 'GIF') {
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8), format: 'GIF' };
  }

  // BMP: "BM", then little-endian i32 width/height at offset 18.
  if (buffer.length >= 26 && buffer.toString('ascii', 0, 2) === 'BM') {
    return {
      width: buffer.readInt32LE(18),
      height: Math.abs(buffer.readInt32LE(22)),
      format: 'BMP',
    };
  }

  // WEBP: RIFF container; VP8/VP8L/VP8X each store dimensions differently.
  if (
    buffer.length >= 30 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    const chunk = buffer.toString('ascii', 12, 16);
    if (chunk === 'VP8X') {
      const width = 1 + (buffer.readUIntLE(24, 3) & 0xffffff);
      const height = 1 + (buffer.readUIntLE(27, 3) & 0xffffff);
      return { width, height, format: 'WEBP' };
    }
    if (chunk === 'VP8 ') {
      return {
        width: buffer.readUInt16LE(26) & 0x3fff,
        height: buffer.readUInt16LE(28) & 0x3fff,
        format: 'WEBP',
      };
    }
    if (chunk === 'VP8L') {
      const bits = buffer.readUInt32LE(21);
      return {
        width: (bits & 0x3fff) + 1,
        height: ((bits >> 14) & 0x3fff) + 1,
        format: 'WEBP',
      };
    }
    return { width: 0, height: 0, format: 'WEBP' };
  }

  // JPEG: walk the marker segments to the SOFn frame header.
  if (buffer.length >= 4 && buffer.readUInt16BE(0) === 0xffd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset++;
        continue;
      }
      const marker = buffer[offset + 1]!;
      const isFrameHeader =
        marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isFrameHeader) {
        return {
          height: buffer.readUInt16BE(offset + 5),
          width: buffer.readUInt16BE(offset + 7),
          format: 'JPEG',
        };
      }
      offset += 2 + buffer.readUInt16BE(offset + 2);
    }
    return { width: 0, height: 0, format: 'JPEG' };
  }

  return null;
}

const imageSchema = z.object({
  path: z.string().describe('Image file to load, relative to the workspace root.'),
  question: z
    .string()
    .optional()
    .describe('Optional note about what to look for, included alongside the image.'),
});

export const readImageTool: Tool = defineTool({
  name: 'read_image',
  description:
    'Load a PNG, JPEG, WEBP, GIF or BMP image from the workspace and attach it to the conversation for a vision-capable model to look at. Fails cleanly if the selected model has no vision support.',
  parameters: imageSchema,
  permission: 'read',
  readOnly: true,
  async execute(args, context) {
    const resolved = await context.sandbox.resolveReal(args.path);
    const extension = path.extname(resolved.absolute).toLowerCase();
    const mediaType = IMAGE_MEDIA_TYPES[extension];

    if (!mediaType) {
      return toolError(
        `${resolved.relative} is not a supported image type. Supported: ${Object.keys(IMAGE_MEDIA_TYPES).join(', ')}.`,
      );
    }

    let buffer: Buffer;
    try {
      buffer = await fs.readFile(resolved.absolute);
    } catch {
      return toolError(`Image not found: ${resolved.relative}`);
    }

    const dimensions = readImageDimensions(buffer);
    const size = `${dimensions && dimensions.width ? `${dimensions.width} × ${dimensions.height}` : 'unknown size'}, ${formatBytes(buffer.length)}`;

    // Never imply the model saw an image it cannot receive.
    if (!context.visionAvailable) {
      return toolError(
        `The selected model does not support image input, so ${resolved.relative} was not analysed. Switch to a vision-capable model with /model, then try again.`,
        { kind: 'image', summary: `${resolved.relative} — ${size} (not sent: no vision support)` },
      );
    }

    if (buffer.length > MAX_IMAGE_BYTES) {
      return toolError(
        `${resolved.relative} is ${formatBytes(buffer.length)}, larger than the ${formatBytes(MAX_IMAGE_BYTES)} inline limit. Resize it and try again.`,
      );
    }

    const image: ImagePart = {
      type: 'image',
      mediaType,
      data: buffer.toString('base64'),
      name: resolved.relative,
    };

    const note = args.question ? `\nThe user asked: ${args.question}` : '';
    return toolOk(
      `Attached ${resolved.relative} (${size}). The image follows this message.${note}`,
      {
        kind: 'image',
        summary: `${resolved.relative} — ${size}`,
        lines: [resolved.relative, size],
      },
      {
        images: [image],
        metadata: {
          width: dimensions?.width,
          height: dimensions?.height,
          format: dimensions?.format ?? mediaType,
          bytes: buffer.length,
        },
      },
    );
  },
});

export const imageTools: Tool[] = [readImageTool];
