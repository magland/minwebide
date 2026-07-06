// Must be evaluated before 'vs/editor/editor.api': it configures the editor
// web worker for Vite bundling and asks the editor to publish the global
// `monaco` API object (which our monaco module re-exports with full typing).
import EditorWorker from 'vs/editor/common/services/editorWebWorkerMain?worker';

const g = globalThis as { MonacoEnvironment?: object };
g.MonacoEnvironment ??= {
	globalAPI: true,
	getWorker: () => new EditorWorker(),
};
