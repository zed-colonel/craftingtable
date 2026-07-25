/**
 * Minimal multipart body builder for tests.
 *
 * Written by hand rather than pulled from a dependency so the acceptance suite
 * exercises exactly the bytes a browser would send, including the boundary and
 * part ordering that the canonical bundle digest must be immune to.
 */

export interface MultipartFilePart {
  readonly fieldName: string;
  readonly filename: string;
  readonly contentType: string;
  readonly bytes: Uint8Array;
}

export interface MultipartBody {
  readonly boundary: string;
  readonly payload: Buffer;
  readonly contentType: string;
}

export function buildMultipartBody(input: {
  readonly fields?: Readonly<Record<string, string>>;
  readonly files?: readonly MultipartFilePart[];
  readonly boundary?: string;
}): MultipartBody {
  const boundary = input.boundary ?? 'craftingtable-test-boundary';
  const chunks: Buffer[] = [];

  for (const [name, value] of Object.entries(input.fields ?? {})) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
        'utf8',
      ),
    );
  }
  for (const file of input.files ?? []) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${file.fieldName}"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`,
        'utf8',
      ),
      Buffer.from(file.bytes),
      Buffer.from('\r\n', 'utf8'),
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));

  return {
    boundary,
    payload: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}
