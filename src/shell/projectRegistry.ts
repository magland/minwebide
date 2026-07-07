import { createIndexedDBFileSystem, type WorkspaceFileSystem } from '../fs/fileSystem';

// The project registry of a project-based app: a small localStorage index of
// projects, each backed by its own IndexedDB database (its own workspace
// file system). Parameterized by the app id so several apps can coexist on
// one origin.

export interface ProjectInfo {
	readonly id: string;
	name: string;
	createdAt: number;
	lastOpenedAt: number;
}

export interface ProjectRegistry {
	/** Projects, most recently opened first. */
	listProjects(): ProjectInfo[];
	getProject(id: string): ProjectInfo | undefined;
	/** Picks 'untitled', 'untitled-2', ... skipping names already in use. */
	nextUntitledName(base?: string): string;
	createProject(name: string): ProjectInfo;
	renameProject(id: string, name: string): void;
	touchProject(id: string): void;
	deleteProject(id: string): Promise<void>;
	/** Copies all files of one project into a brand-new project. */
	duplicateProject(id: string): Promise<ProjectInfo | undefined>;
	openProjectFileSystem(id: string): Promise<WorkspaceFileSystem>;
	projectDbName(id: string): string;
}

/**
 * Creates the registry for `appId` (e.g. 'my-app' → localStorage key
 * `my-app.projects`, project databases `my-app-project-<id>`).
 */
export function createProjectRegistry(appId: string): ProjectRegistry {
	const registryKey = `${appId}.projects`;

	const readRegistry = (): ProjectInfo[] => {
		try {
			const raw = localStorage.getItem(registryKey);
			const parsed = raw ? JSON.parse(raw) : [];
			return Array.isArray(parsed) ? parsed : [];
		} catch {
			return [];
		}
	};

	const writeRegistry = (projects: ProjectInfo[]): void => {
		localStorage.setItem(registryKey, JSON.stringify(projects));
	};

	const projectDbName = (id: string): string => `${appId}-project-${id}`;

	const openProjectFileSystem = (id: string): Promise<WorkspaceFileSystem> =>
		createIndexedDBFileSystem({ dbName: projectDbName(id) });

	const registry: ProjectRegistry = {
		projectDbName,
		openProjectFileSystem,

		listProjects() {
			return readRegistry().sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
		},

		getProject(id) {
			return readRegistry().find(p => p.id === id);
		},

		nextUntitledName(base = 'untitled') {
			const names = new Set(readRegistry().map(p => p.name));
			if (!names.has(base)) {
				return base;
			}
			for (let i = 2; ; i++) {
				if (!names.has(`${base}-${i}`)) {
					return `${base}-${i}`;
				}
			}
		},

		createProject(name) {
			const project: ProjectInfo = {
				id: Math.random().toString(36).slice(2, 10),
				name,
				createdAt: Date.now(),
				lastOpenedAt: Date.now(),
			};
			writeRegistry([...readRegistry(), project]);
			return project;
		},

		renameProject(id, name) {
			const projects = readRegistry();
			const project = projects.find(p => p.id === id);
			if (project && name.trim()) {
				project.name = name.trim();
				writeRegistry(projects);
			}
		},

		touchProject(id) {
			const projects = readRegistry();
			const project = projects.find(p => p.id === id);
			if (project) {
				project.lastOpenedAt = Date.now();
				writeRegistry(projects);
			}
		},

		async deleteProject(id) {
			writeRegistry(readRegistry().filter(p => p.id !== id));
			await new Promise<void>((resolve) => {
				const request = indexedDB.deleteDatabase(projectDbName(id));
				request.onsuccess = request.onerror = request.onblocked = () => resolve();
			});
		},

		async duplicateProject(id) {
			const source = registry.getProject(id);
			if (!source) {
				return undefined;
			}
			const copy = registry.createProject(registry.nextUntitledName(`${source.name}-copy`));
			const sourceFs = await openProjectFileSystem(source.id);
			const targetFs = await openProjectFileSystem(copy.id);
			try {
				const copyTree = async (path: string): Promise<void> => {
					const stat = await sourceFs.fileService.resolve(sourceFs.root.with({ path }));
					for (const child of stat.children ?? []) {
						if (child.isDirectory) {
							await targetFs.fileService.createFolder(targetFs.root.with({ path: child.resource.path }));
							await copyTree(child.resource.path);
						} else {
							const content = await sourceFs.fileService.readFile(child.resource);
							await targetFs.fileService.writeFile(targetFs.root.with({ path: child.resource.path }), content.value);
						}
					}
				};
				await copyTree('/');
			} finally {
				sourceFs.dispose();
				targetFs.dispose();
			}
			return copy;
		},
	};

	return registry;
}
