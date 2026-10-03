import { createReadStream } from 'node:fs';
import { createServer } from 'node:http';

const port = process.env.PORT || 4173;

createServer((request, response) => {
  const path = request.url === '/' ? 'preview/index.html' : request.url.slice(1);

  createReadStream(path)
    .on('error', () => {
      response.writeHead(404);
      response.end();
    })
    .on('open', () => {
      const contentTypes = {
        '.mp4': 'video/mp4',
        '.svg': 'image/svg+xml'
      };
      const contentType = contentTypes[path.slice(path.lastIndexOf('.'))];
      const headers = contentType ? { 'Content-Type': contentType } : {};
      response.writeHead(200, headers);
    })
    .pipe(response);
}).listen(port, () => {
  console.log(`Preview running at port ${port}`);
  console.log(`http://localhost:${port}/#username=User1`);
  console.log(`http://localhost:${port}/#username=User2`);
});
