// The editor binary the browser tests drive: the installed Code fork (waozixyz/code), then Microsoft VS Code.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const candidates = [path.join(os.homedir(), '.local/opt/code/codium'), '/usr/share/code/code'];
export const editor = candidates.find(file => fs.existsSync(file)) ?? candidates.at(-1);
