import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';

export async function readWorkspaceArtifact(directory: string, candidate: string, extension: '.html' | '.md'): Promise<string | null> {
    const root = path.resolve(directory), filename = path.resolve(candidate);
    if (!filename.startsWith(root + path.sep) || path.extname(filename).toLowerCase() !== extension || /\p{Cc}/u.test(filename)) return null;
    let file;
    try {
        const [realRoot, realFile, info] = await Promise.all([realpath(root), realpath(filename), lstat(filename)]);
        if (!info.isFile() || !realFile.startsWith(realRoot + path.sep)) return null;
        file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        if (!(await file.stat()).isFile()) return null;
        return await file.readFile('utf8');
    } catch (error: any) {
        if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error.code)) return null;
        throw error;
    } finally { await file?.close(); }
}
