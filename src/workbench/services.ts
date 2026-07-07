import { getClientArea, IDimension } from 'vs/base/browser/dom';
import { Dialog } from 'vs/base/browser/ui/dialog/dialog';
import { Event } from 'vs/base/common/event';
import { Disposable } from 'vs/base/common/lifecycle';
import { StandaloneServices } from 'vs/editor/standalone/browser/standaloneServices';
import { IMenuService } from 'vs/platform/actions/common/actions';
import { IContextKeyService } from 'vs/platform/contextkey/common/contextkey';
import { ContextMenuService } from 'vs/platform/contextview/browser/contextMenuService';
import { IContextMenuService, IContextViewService } from 'vs/platform/contextview/browser/contextView';
import { ContextViewService } from 'vs/platform/contextview/browser/contextViewService';
import { IKeybindingService } from 'vs/platform/keybinding/common/keybinding';
import { ILayoutOffsetInfo, ILayoutService } from 'vs/platform/layout/browser/layoutService';
import { INotificationService } from 'vs/platform/notification/common/notification';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import {
	defaultButtonStyles,
	defaultCheckboxStyles,
	defaultDialogStyles,
	defaultInputBoxStyles,
} from 'vs/platform/theme/browser/defaultStyles';

/**
 * A layout service pinned to the workbench root element. VS Code's overlay
 * widgets (context views, menus) position themselves inside this container,
 * which also carries the --vscode-* theme variables they read.
 */
class WorkbenchLayoutService implements ILayoutService {
	declare readonly _serviceBrand: undefined;

	readonly onDidLayoutMainContainer = Event.None;
	readonly onDidLayoutActiveContainer = Event.None;
	readonly onDidLayoutContainer = Event.None;
	readonly onDidChangeActiveContainer = Event.None;
	readonly onDidAddContainer = Event.None;

	readonly mainContainerOffset: ILayoutOffsetInfo = { top: 0, quickPickTop: 0 };
	readonly activeContainerOffset: ILayoutOffsetInfo = { top: 0, quickPickTop: 0 };

	constructor(readonly mainContainer: HTMLElement) { }

	get activeContainer(): HTMLElement {
		return this.mainContainer;
	}

	get containers(): Iterable<HTMLElement> {
		return [this.mainContainer];
	}

	get mainContainerDimension(): IDimension {
		return getClientArea(this.mainContainer);
	}

	get activeContainerDimension(): IDimension {
		return getClientArea(this.mainContainer);
	}

	getContainer(): HTMLElement {
		return this.mainContainer;
	}

	whenContainerStylesLoaded(): Promise<void> | undefined {
		return undefined;
	}

	focus(): void {
		this.mainContainer.focus();
	}
}

export interface ConfirmDialogOptions {
	readonly message: string;
	readonly detail?: string;
	readonly primaryButton: string;
	readonly type?: 'none' | 'info' | 'error' | 'question' | 'warning';
}

/**
 * The VS Code platform services the workbench chrome uses (the editor has its
 * own, editor-scoped instances via Monaco's StandaloneServices).
 */
export class WorkbenchServices extends Disposable {
	readonly contextViewService: IContextViewService;
	readonly contextMenuService: IContextMenuService;

	constructor(private readonly container: HTMLElement) {
		super();

		const layoutService = new WorkbenchLayoutService(container);
		const contextViewService = this._register(new ContextViewService(layoutService));
		this.contextViewService = contextViewService;
		const contextMenuService = this._register(new ContextMenuService(
			StandaloneServices.get(ITelemetryService),
			StandaloneServices.get(INotificationService),
			contextViewService,
			StandaloneServices.get(IKeybindingService),
			StandaloneServices.get(IMenuService),
			StandaloneServices.get(IContextKeyService),
		));
		contextMenuService.configure({ blockMouse: false });
		this.contextMenuService = contextMenuService;
	}

	/** Shows a modal confirmation using VS Code's own Dialog widget. */
	async confirm(options: ConfirmDialogOptions): Promise<boolean> {
		const dialog = new Dialog(this.container, options.message, [options.primaryButton, 'Cancel'], {
			detail: options.detail,
			type: options.type ?? 'warning',
			cancelId: 1,
			buttonStyles: defaultButtonStyles,
			checkboxStyles: defaultCheckboxStyles,
			inputBoxStyles: defaultInputBoxStyles,
			dialogStyles: defaultDialogStyles,
		});
		try {
			const result = await dialog.show();
			return result.button === 0;
		} finally {
			dialog.dispose();
		}
	}

	/** Shows a modal error message using VS Code's own Dialog widget. */
	async error(message: string, detail?: string): Promise<void> {
		const dialog = new Dialog(this.container, message, ['OK'], {
			detail,
			type: 'error',
			buttonStyles: defaultButtonStyles,
			checkboxStyles: defaultCheckboxStyles,
			inputBoxStyles: defaultInputBoxStyles,
			dialogStyles: defaultDialogStyles,
		});
		try {
			await dialog.show();
		} finally {
			dialog.dispose();
		}
	}
}
