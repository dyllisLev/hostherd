import stripAnsi from 'strip-ansi';

// Format the joined display window, so escape sequences split across fetched
// chunks are interpreted together. Stored bytes and their cursors stay intact.
export function outputText(raw: string): string {
  const plain = stripAnsi(raw).replace(/\r\n/g, '\n').replace(/\u0007/g, '');
  // Shell prompt redraws and progress updates replace the current line.
  return plain.split('\n').map(line => line.slice(line.lastIndexOf('\r') + 1)).join('\n');
}
