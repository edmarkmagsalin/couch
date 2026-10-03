import { createReadStream } from 'node:fs';
import { createServer } from 'node:http';
import { stat } from 'node:fs/promises';
import { extname, resolve } from 'node:path';

const port = process.env.PORT || 4173;
const root = process.cwd();
const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mp4': 'video/mp4',
  '.svg': 'image/svg+xml'
};

function sendRangeError(response, size) {
  response.writeHead(416, {
    'Accept-Ranges': 'bytes',
    'Content-Range': `bytes */${size}`
  });
  response.end();
}

createServer(async (request, response) => {
  let requestedPath;

  try {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    requestedPath = decodeURIComponent(pathname === '/' ? '/preview/index.html' : pathname);
  } catch {
    response.writeHead(400);
    response.end();
    return;
  }

  const filePath = resolve(root, `.${requestedPath}`);
  if (!filePath.startsWith(`${root}/`)) {
    response.writeHead(404);
    response.end();
    return;
  }

  let fileStats;
  try {
    fileStats = await stat(filePath);
  } catch {
    response.writeHead(404);
    response.end();
    return;
  }

  if (!fileStats.isFile()) {
    response.writeHead(404);
    response.end();
    return;
  }

  const size = fileStats.size;
  const rangeHeader = request.headers.range;
  const rangeMatch = rangeHeader?.match(/^bytes=(\d*)-(\d*)$/);
  const headers = {
    'Accept-Ranges': 'bytes',
    'Content-Type': contentTypes[extname(filePath)] || 'application/octet-stream'
  };

  if (request.method === 'HEAD') {
    response.writeHead(200, { ...headers, 'Content-Length': size });
    response.end();
    return;
  }

  let start = 0;
  let end = size - 1;

  if (rangeMatch) {
    const [, rangeStart, rangeEnd] = rangeMatch;

    if (rangeStart === '') {
      const suffixLength = Number(rangeEnd);
      if (suffixLength <= 0 || size === 0) {
        sendRangeError(response, size);
        return;
      }
      start = Math.max(size - suffixLength, 0);
    } else {
      start = Number(rangeStart);
      end = rangeEnd === '' ? size - 1 : Number(rangeEnd);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) {
        sendRangeError(response, size);
        return;
      }
      end = Math.min(end, size - 1);
    }

    response.writeHead(206, {
      ...headers,
      'Content-Length': end - start + 1,
      'Content-Range': `bytes ${start}-${end}/${size}`
    });
    createReadStream(filePath, { start, end }).pipe(response);
    return;
  }

  if (rangeHeader) {
    sendRangeError(response, size);
    return;
  }

  response.writeHead(200, { ...headers, 'Content-Length': size });
  createReadStream(filePath).pipe(response);
}).listen(port, () => {
  console.log(`Preview running at port ${port}`);
  console.log(`http://localhost:${port}/#username=User1`);
  console.log(`http://localhost:${port}/#username=User2`);
});
