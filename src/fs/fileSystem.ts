import { VSBuffer } from 'vs/base/common/buffer';
import { IndexedDB } from 'vs/base/browser/indexedDB';
import { dirname } from 'vs/base/common/resources';
import { URI } from 'vs/base/common/uri';
import { IndexedDBFileSystemProvider } from 'vs/platform/files/browser/indexedDBFileSystemProvider';
import { FileService } from 'vs/platform/files/common/fileService';
import { NullLogService } from 'vs/platform/log/common/log';

export interface IndexedDBFileSystemOptions {
	/** URI scheme for workspace files. Default: 'minwebide'. */
	readonly scheme?: string;
	/** IndexedDB database name. Default: 'minwebide-workspace'. */
	readonly dbName?: string;
}

export interface WorkspaceFileSystem {
	/** VS Code's own FileService, backed by IndexedDB. */
	readonly fileService: FileService;
	readonly scheme: string;
	/** IndexedDB database name backing this workspace. */
	readonly dbName: string;
	/** Root folder of the workspace. */
	readonly root: URI;
	/** Write the given path → contents map, skipping files that already exist. */
	seed(files: Record<string, string | Uint8Array>): Promise<void>;
	/** Write (create or overwrite) a single file, creating parent folders. */
	writeFile(path: string, contents: string | Uint8Array): Promise<void>;
	/** Delete a file if it exists. */
	deleteFile(path: string): Promise<void>;
	dispose(): void;
}

/**
 * Creates a browser file system persisted in IndexedDB, using VS Code's own
 * IndexedDBFileSystemProvider (the one behind vscode.dev) registered on VS
 * Code's own FileService.
 */
export async function createIndexedDBFileSystem(options: IndexedDBFileSystemOptions = {}): Promise<WorkspaceFileSystem> {
	const scheme = options.scheme ?? 'minwebide';
	const dbName = options.dbName ?? 'minwebide-workspace';
	const store = 'workspace-files';

	const indexedDB = await IndexedDB.create(dbName, 1, [store]);
	const fileService = new FileService(new NullLogService());
	const provider = new IndexedDBFileSystemProvider(scheme, indexedDB, store, true);
	fileService.registerProvider(scheme, provider);

	const root = URI.from({ scheme, authority: '', path: '/' });

	return {
		fileService,
		scheme,
		dbName,
		root,
		async seed(files: Record<string, string | Uint8Array>): Promise<void> {
			for (const [path, contents] of Object.entries(files)) {
				const resource = root.with({ path: path.startsWith('/') ? path : `/${path}` });
				if (await fileService.exists(resource)) {
					continue;
				}
				await fileService.createFolder(dirname(resource));
				const buffer = typeof contents === 'string' ? VSBuffer.fromString(contents) : VSBuffer.wrap(contents);
				await fileService.writeFile(resource, buffer);
			}
		},
		async writeFile(path: string, contents: string | Uint8Array): Promise<void> {
			const resource = root.with({ path: path.startsWith('/') ? path : `/${path}` });
			await fileService.createFolder(dirname(resource));
			const buffer = typeof contents === 'string' ? VSBuffer.fromString(contents) : VSBuffer.wrap(contents);
			await fileService.writeFile(resource, buffer);
		},
		async deleteFile(path: string): Promise<void> {
			const resource = root.with({ path: path.startsWith('/') ? path : `/${path}` });
			if (await fileService.exists(resource)) {
				await fileService.del(resource, { recursive: true });
			}
		},
		dispose(): void {
			provider.dispose();
			fileService.dispose();
			indexedDB.close();
		},
	};
}
