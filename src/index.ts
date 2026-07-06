export { createIndexedDBFileSystem } from './fs/fileSystem';
export type { IndexedDBFileSystemOptions, WorkspaceFileSystem } from './fs/fileSystem';

export { loadColorTheme, applyThemeToElement, WorkbenchTheme } from './theme/themes';
export type { TokenColorRule } from './theme/themes';

export { createWorkbench, Workbench } from './workbench/workbench';
export type { WorkbenchOptions } from './workbench/workbench';

export { CustomEditorRegistry } from './workbench/customEditors';
export type {
	CustomEditorDescriptor,
	CustomEditorDocument,
	CustomEditorPane,
	CustomEditorPriority,
	CustomEditorProvider,
	CustomEditorSelector,
} from './workbench/customEditors';
export type { OpenFileOptions } from './workbench/editorArea';

export type { LogOutputChannel, OutputChannel, OutputChannelOptions } from './workbench/outputChannels';
export { RunnerRegistry } from './workbench/runners';
export type { FileRunner, RunContext } from './workbench/runners';
export type { AuxiliaryView } from './workbench/auxiliaryBar';

export { registerTextMateSupport } from './textmate/textmate';
export type { ExtensionManifest, TextMateSetupOptions, VendorExtension } from './textmate/textmate';

export { builtinThemeNames, loadBuiltinTheme, registerBuiltinLanguages } from './presets/builtin';

export * as monaco from './editor/monaco';

export { URI } from 'vs/base/common/uri';
